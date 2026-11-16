import { describe, expect, it } from "vitest";
import { createAccount, createCommunity, json, MASTODON, mastodonToken, worker } from "./helpers.ts";

const SITE = "https://palm.test";

async function both(username: string) {
  const id = await createAccount(username, "pw-pw-pw");
  const auth = { authorization: `Bearer ${await mastodonToken(id)}` };
  const masto = (method: string, path: string, body?: unknown) =>
    worker.fetch(`${MASTODON}${path}`, {
      method,
      headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const { jwt } = await (await worker.fetch(`${SITE}/api/v3/user/login`, json({ username_or_email: username, password: "pw-pw-pw" }))).json<{ jwt: string }>();
  const lemmy = (method: string, path: string, body?: unknown) =>
    worker.fetch(`${SITE}/api/v3${path}`, {
      method,
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { id, masto, lemmy };
}

type Status = { id: string; content: string; filtered?: { keyword_matches: string[] }[] };

describe("Lists, followed hashtags, filters, read and hidden", () => {
  it("builds list timelines, follows hashtags and filters keywords", async () => {
    const me = await both("curator");
    const writer = await both("writer");
    const post = await (await writer.masto("POST", "/api/v1/statuses", { status: "spoilers ahead #tea" })).json<Status>();

    const list = await (await me.masto("POST", "/api/v1/lists", { title: "Friends" })).json<{ id: string }>();
    await me.masto("POST", `/api/v1/lists/${list.id}/accounts`, { account_ids: [String(writer.id)] });
    const timeline = await (await me.masto("GET", `/api/v1/timelines/list/${list.id}`)).json<Status[]>();
    expect(timeline.map((s) => s.id)).toEqual([post.id]);
    expect((await (await me.masto("GET", `/api/v1/accounts/${writer.id}/lists`)).json<{ title: string }[]>()).map((l) => l.title)).toEqual(["Friends"]);

    // Following #tea brings it home without following its author.
    expect((await (await me.masto("GET", "/api/v1/timelines/home")).json<Status[]>()).map((s) => s.id)).not.toContain(post.id);
    expect((await (await me.masto("POST", "/api/v1/tags/tea/follow")).json<{ following: boolean }>()).following).toBe(true);
    expect((await (await me.masto("GET", "/api/v1/timelines/home")).json<Status[]>()).map((s) => s.id)).toContain(post.id);

    // A warning filter marks it; a hiding one removes it.
    const filter = await (
      await me.masto("POST", "/api/v2/filters", { title: "No spoilers", context: ["home"], filter_action: "warn", keywords_attributes: [{ keyword: "spoilers" }] })
    ).json<{ id: string }>();
    const warned = (await (await me.masto("GET", "/api/v1/timelines/home")).json<Status[]>()).find((s) => s.id === post.id);
    expect(warned?.filtered?.[0]?.keyword_matches).toEqual(["spoilers"]);
    await me.masto("PUT", `/api/v2/filters/${filter.id}`, { filter_action: "hide" });
    expect((await (await me.masto("GET", "/api/v1/timelines/home")).json<Status[]>()).map((s) => s.id)).not.toContain(post.id);
  });

  it("keeps Lemmy's read and hidden posts, and puts status replies in the inbox", async () => {
    const me = await both("reader2");
    const other = await both("poster3");
    const communityId = await createCommunity("readme", "Read me");
    const created = await (await other.lemmy("POST", "/post", { community_id: communityId, name: "read me" })).json<{ post_view: { post: { id: number } } }>();
    const id = created.post_view.post.id;
    await me.lemmy("POST", "/post/mark_as_read", { post_ids: [id], read: true });
    const listed = await (await me.lemmy("GET", `/post/list?community_id=${communityId}`)).json<{ posts: { read: boolean }[] }>();
    expect(listed.posts[0]?.read).toBe(true);
    expect((await (await me.lemmy("GET", `/post/list?community_id=${communityId}&show_read=false`)).json<{ posts: unknown[] }>()).posts).toHaveLength(0);
    await me.lemmy("POST", "/post/hide", { post_ids: [id], hide: true });
    expect((await (await me.lemmy("GET", `/post/list?community_id=${communityId}`)).json<{ posts: unknown[] }>()).posts).toHaveLength(0);

    // A reply to my status shows in Voyager's inbox.
    const status = await (await me.masto("POST", "/api/v1/statuses", { status: "a status" })).json<Status>();
    await other.masto("POST", "/api/v1/statuses", { status: "@reader2 a reply", in_reply_to_id: status.id });
    const deadline = Date.now() + 5000;
    let replies: unknown[] = [];
    while (Date.now() < deadline) {
      const got = await (await me.lemmy("GET", "/user/mention")).json<{ mentions: unknown[] }>();
      const r = await (await me.lemmy("GET", "/user/replies")).json<{ replies: unknown[] }>();
      replies = [...got.mentions, ...r.replies];
      if (replies.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(replies.length).toBeGreaterThan(0);
  });
});
