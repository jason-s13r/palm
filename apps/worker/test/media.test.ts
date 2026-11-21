import { describe, expect, it } from "vitest";
import { createAccount, createCommunity, json, MASTODON, mastodonToken, worker } from "./helpers.ts";

const DOMAIN = "https://palm.test";
// A 1x1 PNG.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (ch) => ch.charCodeAt(0));

const imageForm = (field: string, extra: Record<string, string> = {}) => {
  const form = new FormData();
  form.append(field, new File([PNG], "dot.png", { type: "image/png" }));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
};

describe("Media", () => {
  it("shows a status's picture as its image in Lemmy apps, and the status on the poster's Lemmy profile", async () => {
    const id = await createAccount("snapper", "pw-pw-pw");
    const auth = { authorization: `Bearer ${await mastodonToken(id)}` };
    const media = await (await worker.fetch(`${MASTODON}/api/v2/media`, { method: "POST", headers: auth, body: imageForm("file") })).json<{ id: string; url: string }>();
    const status = await (
      await worker.fetch(`${MASTODON}/api/v1/statuses`, { ...json({ status: "dog.", media_ids: [media.id] }), headers: { ...auth, "content-type": "application/json" } })
    ).json<{ id: string }>();

    type View = { post: { id: number; url?: string; thumbnail_url?: string } };
    const one = await (await worker.fetch(`${DOMAIN}/api/v3/post?id=${status.id}`)).json<{ post_view: View }>();
    expect(one.post_view.post).toMatchObject({ url: media.url, thumbnail_url: media.url });

    const profile = await (await worker.fetch(`${DOMAIN}/api/v3/user?username=snapper`)).json<{ posts: View[]; person_view: { counts: { post_count: number } } }>();
    expect(profile.posts.map((p) => p.post.id)).toContain(Number(status.id));
    expect(profile.person_view.counts.post_count).toBe(1);
  });

  it("uploads an image from a Mastodon app, attaches it, serves it and federates it", async () => {
    const id = await createAccount("yan", "pw");
    const auth = { authorization: `Bearer ${await mastodonToken(id)}` };

    const uploaded = await worker.fetch(`${MASTODON}/api/v2/media`, { method: "POST", headers: auth, body: imageForm("file", { description: "a dot" }) });
    expect(uploaded.status).toBe(200);
    const media = await uploaded.json<{ id: string; type: string; url: string; description: string }>();
    expect(media).toMatchObject({ type: "image", description: "a dot" });
    expect(media.url).toMatch(/^https:\/\/palm\.test\/pictrs\/image\/[0-9a-f]+\.png$/);

    const served = await worker.fetch(media.url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);

    const req = json({ status: "", media_ids: [media.id] });
    const status = await (await worker.fetch(`${MASTODON}/api/v1/statuses`, { ...req, headers: { ...req.headers, ...auth } })).json<{ uri: string; media_attachments: { id: string }[] }>();
    expect(status.media_attachments.map((m) => m.id)).toEqual([media.id]);

    const note = await (await worker.fetch(status.uri, { headers: { accept: "application/activity+json" } })).json<{ attachment: { type: string; url: string; name: string }[] }>();
    expect(note.attachment).toMatchObject([{ type: "Document", url: media.url, name: "a dot" }]);

    // Attached once is attached for good.
    const again = await worker.fetch(`${MASTODON}/api/v1/statuses`, { ...req, headers: { ...req.headers, ...auth } });
    expect(again.status).toBe(422);
  });

  it("uploads through Lemmy's pict-rs endpoint and deletes with the token", async () => {
    await createAccount("zed", "pw-pw-pw");
    const { jwt } = await (await worker.fetch(`${DOMAIN}/api/v3/user/login`, json({ username_or_email: "zed", password: "pw-pw-pw" }))).json<{ jwt: string }>();
    const res = await worker.fetch(`${DOMAIN}/pictrs/image`, { method: "POST", headers: { cookie: `jwt=${jwt}` }, body: imageForm("images[]") });
    expect(res.status).toBe(200);
    const body = await res.json<{ msg: string; files: { file: string; delete_token: string }[] }>();
    expect(body.msg).toBe("ok");
    const [file] = body.files;

    const communityId = await createCommunity("pics");
    const url = `${DOMAIN}/pictrs/image/${file!.file}`;
    const post = await (
      await worker.fetch(`${DOMAIN}/api/v3/post`, { ...json({ community_id: communityId, name: "A picture", url }), headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" } })
    ).json<{ post_view: { post: { url: string; thumbnail_url: string } } }>();
    expect(post.post_view.post).toMatchObject({ url, thumbnail_url: url });

    // Served from cache after the first fetch, until it's deleted.
    await (await worker.fetch(url)).arrayBuffer();
    await new Promise((r) => setTimeout(r, 50));
    const again = await worker.fetch(url);
    expect(again.headers.get("x-palm-cache")).toBe("hit");
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(PNG);

    expect((await worker.fetch(`${DOMAIN}/pictrs/image/delete/wrong/${file!.file}`)).status).toBe(404);
    expect((await worker.fetch(`${DOMAIN}/pictrs/image/delete/${file!.delete_token}/${file!.file}`)).status).toBe(204);
    expect((await worker.fetch(url)).status).toBe(404);
  });

  it("takes video, and serves it in ranges for players", async () => {
    const id = await createAccount("vid", "pw");
    const form = new FormData();
    const bytes = new Uint8Array(1000).map((_, i) => i % 256);
    form.append("file", new File([bytes], "clip.mp4", { type: "video/mp4" }));
    const media = await (await worker.fetch(`${MASTODON}/api/v2/media`, { method: "POST", headers: { authorization: `Bearer ${await mastodonToken(id)}` }, body: form })).json<{ type: string; url: string }>();
    expect(media.type).toBe("video");
    expect(media.url).toMatch(/\.mp4$/);
    const part = await worker.fetch(media.url, { headers: { range: "bytes=10-19" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/1000");
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it("refuses uploads without a login or of other types", async () => {
    expect((await worker.fetch(`${DOMAIN}/pictrs/image`, { method: "POST", body: imageForm("images[]") })).status).toBe(401);
    const id = await createAccount("abe", "pw");
    const form = new FormData();
    form.append("file", new File(["hello"], "note.txt", { type: "text/plain" }));
    const res = await worker.fetch(`${MASTODON}/api/v2/media`, { method: "POST", headers: { authorization: `Bearer ${await mastodonToken(id)}` }, body: form });
    expect(res.status).toBe(422);
  });
});
