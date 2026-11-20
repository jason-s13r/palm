import { describe, expect, it } from "vitest";
import { createAccount, db, giveKeys, worker } from "./helpers.ts";

// What the Pixelfed app (pixelfed-rn) sends, on the bare domain it signs in to.
const SITE = "https://palm.test";
const REDIRECT = "pixelfed://login";

const multipart = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return { method: "POST", body };
};

/** The app's sign-in: nodeinfo preflight, app, browser sign-in, token, verify_credentials. */
async function signIn(username: string, password: string) {
  const app = await (
    await worker.fetch(`${SITE}/api/v1/apps`, multipart({ client_name: "Pixelfed for iOS", redirect_uris: REDIRECT, scopes: "read write follow push", website: "https://github.com/pixelfed/pixelfed-rn" }))
  ).json<{ client_id: string; client_secret: string }>();
  const page = new URLSearchParams({ response_type: "code", client_id: app.client_id, redirect_uri: REDIRECT, scope: "read write follow push", username, password });
  const redirect = await worker.fetch(`${SITE}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: page.toString(),
    redirect: "manual",
  });
  expect(redirect.status).toBe(302);
  const code = new URL(redirect.headers.get("location")!).searchParams.get("code")!;
  const token = await (
    await worker.fetch(
      `${SITE}/oauth/token`,
      multipart({ client_id: app.client_id, client_secret: app.client_secret, redirect_uri: REDIRECT, grant_type: "authorization_code", code, scope: "read write follow push admin:read admin:write" }),
    )
  ).json<{ access_token: string }>();
  expect(token.access_token).toBeTruthy();
  const auth = { authorization: `Bearer ${token.access_token}`, accept: "application/json" };
  const call = (method: string, path: string, body?: unknown) =>
    worker.fetch(`${SITE}/${path}`, {
      method,
      headers: { ...auth, "content-type": "application/json", "x-pixelfed-app": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const get = async <T = Record<string, unknown>>(path: string) => {
    const res = await call("GET", path);
    expect(res.status, path).toBe(200);
    return res.json<T>();
  };
  return { token: token.access_token, auth, call, get };
}

async function pngUpload(token: string) {
  // A 1×1 PNG.
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (ch) => ch.charCodeAt(0));
  const body = new FormData();
  body.set("file", new File([png], "photo.png", { type: "image/png" }));
  body.set("description", "a dot");
  const res = await worker.fetch(`${SITE}/api/v2/media`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body });
  expect(res.status).toBeLessThan(300);
  return res.json<{ id: string }>();
}

describe("Pixelfed apps", () => {
  it("tells Pixelfed apps it's Pixelfed, and everyone else it's Lemmy", async () => {
    const pixelfed = await (await worker.fetch(`${SITE}/api/nodeinfo/2.0.json`)).json<{ software: { name: string; version: string } }>();
    expect(pixelfed.software.name).toBe("pixelfed");
    // The App Store app needs 0.14.4 or later, read from the leading x.y.z.
    const [major, minor, patch] = pixelfed.software.version.match(/^(\d+)\.(\d+)\.(\d+)/)!.slice(1).map(Number);
    expect(major! * 1e6 + minor! * 1e3 + patch!).toBeGreaterThanOrEqual(14_004);

    const wellKnown = await (await worker.fetch(`${SITE}/.well-known/nodeinfo`, { headers: { accept: "application/json" } })).json<{ links: { href: string }[] }>();
    const nodeinfo = await (await worker.fetch(wellKnown.links[0]!.href, { headers: { accept: "application/json" } })).json<{ software: { name: string } }>();
    expect(nodeinfo.software.name).toBe("lemmy");
  });

  it("serves the terms, privacy and help pages the app links to", async () => {
    const page = (path: string) => worker.fetch(`${SITE}${path}`, { headers: { accept: "text/html" }, redirect: "manual" });
    for (const path of ["/site/terms", "/e/terms", "/site/privacy", "/e/privacy", "/site/help"]) {
      expect((await page(path)).status, path).toBe(200);
    }
  });

  it("signs in and shows a profile grid, a post and its comments", async () => {
    const meId = await createAccount("pf_jo", "pw-pw-pw");
    await giveKeys(meId);
    const { token, get, call } = await signIn("pf_jo", "pw-pw-pw");

    const me = await get<{ id: string; local: boolean; note_text: string; is_admin: boolean; settings: object }>("api/v1/accounts/verify_credentials?_pe=1");
    expect(me).toMatchObject({ id: String(meId), local: true, is_admin: false });
    expect(me.settings).toBeTruthy();

    // The camera screen: instance limits and compose settings.
    const instance = await get<{ configuration: { statuses: { max_characters: number; max_media_attachments: number } } }>("api/v1/instance");
    expect(instance.configuration.statuses.max_characters).toBeGreaterThan(0);
    const compose = await get<{ max_media_attachments: number; default_scope: string }>("api/v1.1/compose/settings");
    expect(compose).toMatchObject({ default_scope: "public" });
    expect((await get<{ account: { max_bio_length: number } }>("api/v2/config")).account.max_bio_length).toBeGreaterThan(0);

    // Post two photos as an album, and a single photo.
    const a = await pngUpload(token);
    const b = await pngUpload(token);
    const album = await call("POST", "api/v1/statuses", { status: "an album #sunset", media_ids: [a.id, b.id], visibility: "public", sensitive: false });
    expect(album.status).toBe(200);
    const albumStatus = await album.json<{ id: string; pf_type: string }>();
    expect(albumStatus.pf_type).toBe("photo:album");
    const c = await pngUpload(token);
    const single = await (await call("POST", "api/v1/statuses", { status: "one", media_ids: [c.id], visibility: "public", sensitive: false })).json<{ id: string }>();

    // The profile: looked up by username, then its posts filtered by pf_type.
    const profile = await get<{ id: string; local: boolean }>("api/v1.1/accounts/username/pf_jo?_pe=1");
    expect(profile).toMatchObject({ id: String(meId), local: true });
    expect(await get("api/v1.1/accounts/username/nobody_here?_pe=1")).toEqual([]);
    const grid = await get<{ id: string; pf_type: string; reply_count: number }[]>(`api/v1/accounts/${meId}/statuses?_pe=1&limit=24`);
    expect(grid.map((s) => s.pf_type).sort()).toEqual(["photo", "photo:album"]);
    expect(grid[0]!.reply_count).toBe(0);

    // Someone likes and comments; the post shows who liked it.
    const fanId = await createAccount("pf_fan", "pw-pw-pw");
    await giveKeys(fanId);
    const fan = await signIn("pf_fan", "pw-pw-pw");
    expect((await fan.call("POST", `api/v1/statuses/${single.id}/favourite?_pe=1`)).status).toBe(200);
    await fan.call("POST", "api/v1/statuses", { status: "lovely", in_reply_to_id: single.id, visibility: "public" });
    const post = await get<{ liked_by: { username: string; total_count: number } | null; reply_count: number; pf_type: string }>(`api/v1/statuses/${single.id}?_pe=1`);
    expect(post.liked_by).toMatchObject({ username: "pf_fan", total_count: 1 });
    expect(post).toMatchObject({ reply_count: 1, pf_type: "photo" });
    const replies = await get<{ descendants: { pf_type: string; content: string }[] }>(`api/v1/statuses/${single.id}/context?_pe=1&max_id=undefined`);
    expect(replies.descendants.map((d) => d.pf_type)).toEqual(["text"]);

    // The hashtag screen asks with a trailing slash.
    expect((await get<{ name: string }>("api/v1/tags/sunset/?_pe=1")).name).toBe("sunset");
    expect(await get("api/v1/tags/sunset/related")).toEqual([]);
    const tagged = await get<{ id: string }[]>("api/v1/timelines/tag/sunset?_pe=1&max_id=undefined");
    expect(tagged.map((s) => s.id)).toEqual([albumStatus.id]);

    // Discover: trending pictures, hashtags and people.
    const trending = await get<{ id: string }[]>("api/v1.1/discover/posts/trending?range=daily");
    expect(trending[0]!.id).toBe(single.id);
    expect((await get<{ hashtag: string }[]>("api/v1.1/discover/posts/hashtags")).map((t) => t.hashtag)).toContain("sunset");
    const popular = await fan.get<{ id: string }[]>("api/v1.1/discover/accounts/popular");
    expect(popular.map((p) => p.id)).toContain(String(meId));
    expect(Array.isArray(await get("api/v1.1/discover/posts/network/trending"))).toBe(true);
  });

  it("answers the home screen's extras: stories, collections, settings, push", async () => {
    const id = await createAccount("pf_home", "pw-pw-pw");
    await giveKeys(id);
    const { get, call } = await signIn("pf_home", "pw-pw-pw");
    expect(await get("api/v1.2/stories/carousel")).toEqual({ nodes: [] });
    expect(await get("api/v1.1/collections/self?page=1")).toEqual([]);
    expect(await get("api/v1.1/nag/state")).toEqual({ active: false });
    expect((await get<{ common: { timelines: object } }>("api/pixelfed/v1/app/settings")).common.timelines).toBeTruthy();
    expect((await call("GET", "api/v1.1/push/state")).status).toBe(404);
    const home = await call("GET", "api/v1/timelines/home?_pe=1&limit=20");
    expect(home.status).toBe(200);
  });

  it("edits the profile from the query string, and removes the avatar", async () => {
    const id = await createAccount("pf_edit", "pw-pw-pw");
    await giveKeys(id);
    const { call } = await signIn("pf_edit", "pw-pw-pw");
    const edited = await call("PATCH", `api/v1/accounts/update_credentials?${new URLSearchParams({ display_name: "Jo E", note: "hello there" })}`);
    expect(await edited.json()).toMatchObject({ display_name: "Jo E", note_text: "hello there" });
    await db.prepare("UPDATE accounts SET avatar_url = 'https://palm.test/pictrs/image/x.png' WHERE id = ?").bind(id).run();
    const cleared = await (await call("DELETE", "api/v1.1/accounts/avatar")).json<{ avatar: string }>();
    expect(cleared.avatar).not.toContain("x.png");
  });

  it("chats through direct messages, and reports", async () => {
    const amyId = await createAccount("pf_amy", "pw-pw-pw");
    const benId = await createAccount("pf_ben", "pw-pw-pw");
    await giveKeys(amyId);
    await giveKeys(benId);
    const amy = await signIn("pf_amy", "pw-pw-pw");
    const ben = await signIn("pf_ben", "pw-pw-pw");
    // Mutual follows are who the app offers to message.
    await amy.call("POST", `api/v1/accounts/${benId}/follow`);
    await ben.call("POST", `api/v1/accounts/${amyId}/follow`);
    expect((await amy.get<{ id: string }[]>("api/v1.1/direct/compose/mutuals")).map((a) => a.id)).toEqual([String(benId)]);

    const sent = await amy.call("POST", "api/v1.1/direct/thread/send", { to_id: String(benId), message: "hi ben", type: "text" });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ isAuthor: true, text: "hi ben", type: "text" });

    const thread = await ben.get<{ username: string; messages: { id: string; text: string; isAuthor: boolean }[] }>(`api/v1.1/direct/thread?pid=${amyId}`);
    expect(thread.username).toBe("pf_amy");
    expect(thread.messages).toMatchObject([{ text: "hi ben", isAuthor: false }]);
    // The chat list is Mastodon's conversations.
    expect((await ben.get<unknown[]>("api/v1/conversations")).length).toBe(1);

    const report = await ben.call("POST", "api/v1.1/report", { object_id: thread.messages[0]!.id, object_type: "post", report_type: "spam" });
    expect(report.status).toBe(200);
    const row = await db.prepare("SELECT reason FROM reports WHERE reporter_id = ?").bind(benId).first<{ reason: string }>();
    expect(row?.reason).toBe("spam");

    expect((await amy.call("DELETE", `api/v1.1/direct/thread/message?id=${thread.messages[0]!.id}`)).status).toBe(200);
    expect((await ben.get<{ messages: unknown[] }>(`api/v1.1/direct/thread?pid=${amyId}`)).messages).toEqual([]);
  });

  it("leaves Mastodon apps' responses as they were", async () => {
    const id = await createAccount("pf_masto", "pw-pw-pw");
    const app = await (
      await worker.fetch(`${SITE}/api/v1/apps`, multipart({ client_name: "Ivory", redirect_uris: "ivory://oauth", scopes: "read write follow" }))
    ).json<{ client_id: string }>();
    expect(app.client_id).toBeTruthy();
    const { mastodonToken } = await import("./helpers.ts");
    const me = await (await worker.fetch(`${SITE}/api/v1/accounts/verify_credentials`, { headers: { authorization: `Bearer ${await mastodonToken(id)}` } })).json<Record<string, unknown>>();
    expect(me.note_text).toBeUndefined();
    expect(me.local).toBeUndefined();
  });
});
