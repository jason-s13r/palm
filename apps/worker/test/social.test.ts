import { describe, expect, it } from "vitest";
import { createAccount, createCommunity, db, giveKeys, json, MASTODON, mastodonToken, worker } from "./helpers.ts";

const DOMAIN = "https://palm.test";
const AP = { headers: { accept: "application/activity+json" } };

async function until<T>(check: () => Promise<T | null | undefined | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function mastodonUser(username: string) {
  const id = await createAccount(username, "pw");
  await giveKeys(id);
  const auth = { authorization: `Bearer ${await mastodonToken(id)}` };
  const call = (method: string, path: string, body?: unknown) =>
    worker.fetch(`${MASTODON}${path}`, {
      method,
      headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { id, auth, get: (p: string) => call("GET", p), post: (p: string, b: unknown = {}) => call("POST", p, b) };
}

type Status = { id: string; content: string; favourites_count: number; favourited: boolean; bookmarked: boolean; reblogged: boolean; mentions: { acct: string }[] };

describe("Following, favourites and notifications", () => {
  it("follows a local account, fills the home timeline, and notifies", async () => {
    const ann = await mastodonUser("ann");
    const ben = await mastodonUser("ben");
    const benPost = await (await ben.post("/api/v1/statuses", { status: "from ben" })).json<Status>();

    const rel = await (await ann.post(`/api/v1/accounts/${ben.id}/follow`)).json<{ following: boolean }>();
    expect(rel.following).toBe(true);
    const [mine] = await (await ann.get(`/api/v1/accounts/relationships?id[]=${ben.id}`)).json<{ following: boolean }[]>();
    expect(mine?.following).toBe(true);

    const home = await (await ann.get("/api/v1/timelines/home")).json<Status[]>();
    expect(home.map((s) => s.id)).toContain(benPost.id);

    const fav = await (await ann.post(`/api/v1/statuses/${benPost.id}/favourite`)).json<Status>();
    expect(fav).toMatchObject({ favourited: true, favourites_count: 1 });
    const marked = await (await ann.post(`/api/v1/statuses/${benPost.id}/bookmark`)).json<Status>();
    expect(marked.bookmarked).toBe(true);
    expect((await (await ann.get("/api/v1/bookmarks")).json<Status[]>()).map((s) => s.id)).toEqual([benPost.id]);
    expect((await (await ann.get("/api/v1/favourites")).json<Status[]>()).map((s) => s.id)).toEqual([benPost.id]);

    const types = await until(async () => {
      const list = await (await ben.get("/api/v1/notifications")).json<{ type: string; account: { acct: string } }[]>();
      const kinds = list.map((n) => n.type).sort();
      return kinds.includes("favourite") && kinds.includes("follow") ? kinds : null;
    });
    expect(types).toEqual(["favourite", "follow"]);
    const grouped = await (await ben.get("/api/v2/notifications")).json<{ notification_groups: { type: string }[] }>();
    expect(grouped.notification_groups).toHaveLength(2);
    expect((await (await ben.get("/api/v1/notifications/unread_count")).json<{ count: number }>()).count).toBe(2);

    const unfollowed = await (await ann.post(`/api/v1/accounts/${ben.id}/unfollow`)).json<{ following: boolean }>();
    expect(unfollowed.following).toBe(false);
  });

  it("shows boosts by people you follow in your home timeline", async () => {
    const lia = await mastodonUser("lia");
    const max = await mastodonUser("max");
    const ned = await mastodonUser("nedd");
    const original = await (await ned.post("/api/v1/statuses", { status: "worth sharing" })).json<Status>();
    await lia.post(`/api/v1/accounts/${max.id}/follow`);
    const boosted = await (await max.post(`/api/v1/statuses/${original.id}/reblog`)).json<Status>();
    expect(boosted.reblogged).toBe(true);
    const home = await (await lia.get("/api/v1/timelines/home")).json<{ id: string; account: { acct: string }; reblog: Status | null }[]>();
    const entry = home.find((s) => s.reblog?.id === original.id);
    expect(entry?.account.acct).toBe("max");
    expect(entry?.id).not.toBe(original.id);
    await max.post(`/api/v1/statuses/${original.id}/unreblog`);
    const after = await (await lia.get("/api/v1/timelines/home")).json<{ reblog: Status | null }[]>();
    expect(after.some((s) => s.reblog?.id === original.id)).toBe(false);
  });

  it("links and notifies mentions, and shows direct messages only to those in them", async () => {
    const cal = await mastodonUser("cal");
    const dot = await mastodonUser("dot");
    const eve = await mastodonUser("eve");
    const dm = await (await cal.post("/api/v1/statuses", { status: "hi @dot", visibility: "direct" })).json<Status>();
    expect(dm.mentions.map((m) => m.acct)).toEqual(["dot"]);
    expect(dm.content).toContain('class="u-url mention"');
    expect((await dot.get(`/api/v1/statuses/${dm.id}`)).status).toBe(200);
    expect((await eve.get(`/api/v1/statuses/${dm.id}`)).status).toBe(404);
    const note = await until(async () => {
      const list = await (await dot.get("/api/v1/notifications")).json<{ type: string; status?: { id: string } }[]>();
      return list.find((n) => n.type === "mention");
    });
    expect(note.status?.id).toBe(dm.id);
  });

  it("edits a profile", async () => {
    const fay = await mastodonUser("fay");
    const res = await worker.fetch(`${MASTODON}/api/v1/accounts/update_credentials`, {
      method: "PATCH",
      headers: { ...fay.auth, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Fay F.", note: "Hello there" }),
    });
    expect(await res.json()).toMatchObject({ display_name: "Fay F.", note: "<p>Hello there</p>" });
  });

  it("finds local people by name in search", async () => {
    const gus = await mastodonUser("gus");
    const found = await (await gus.get("/api/v2/search?q=gu")).json<{ accounts: { acct: string }[] }>();
    expect(found.accounts.map((a) => a.acct)).toContain("gus");
  });
});

describe("Communities on the network", () => {
  it("serves a community as a Group, found by WebFinger", async () => {
    await createCommunity("netgroup", "Net group");
    const finger = await worker.fetch(`${DOMAIN}/.well-known/webfinger?resource=acct:netgroup@palm.test`);
    expect(finger.status).toBe(200);
    const links = (await finger.json<{ links: { rel: string; href: string }[] }>()).links;
    expect(links.find((l) => l.rel === "self")?.href).toBe("https://palm.test/c/netgroup");

    const group = await (await worker.fetch(`${DOMAIN}/c/netgroup`, AP)).json<Record<string, unknown>>();
    expect(group).toMatchObject({
      type: "Group",
      id: "https://palm.test/c/netgroup",
      preferredUsername: "netgroup",
      name: "Net group",
      inbox: "https://palm.test/c/netgroup/inbox",
      outbox: "https://palm.test/c/netgroup/outbox",
      followers: "https://palm.test/c/netgroup/followers",
    });
    // People still come first: WebFinger for a person isn't shadowed.
    await createAccount("hal", "pw");
    const person = await worker.fetch(`${DOMAIN}/.well-known/webfinger?resource=acct:hal@palm.test`);
    expect((await person.json<{ links: { rel: string; href: string }[] }>()).links.find((l) => l.rel === "self")?.href).toBe("https://palm.test/users/hal");
  });

  it("serves a Lemmy post as a Page addressed to its community, and lists it in the outbox", async () => {
    const communityId = await createCommunity("pages");
    const ida = await createAccount("ida", "pw-pw-pw");
    await giveKeys(ida);
    const { jwt } = await (await worker.fetch(`${DOMAIN}/api/v3/user/login`, json({ username_or_email: "ida", password: "pw-pw-pw" }))).json<{ jwt: string }>();
    const created = await (
      await worker.fetch(`${DOMAIN}/api/v3/post`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify({ community_id: communityId, name: "A title", body: "Some **markdown**", url: "https://example.com/" }),
      })
    ).json<{ post_view: { post: { ap_id: string } } }>();
    const page = await (await worker.fetch(created.post_view.post.ap_id, AP)).json<Record<string, unknown>>();
    expect(page).toMatchObject({
      type: "Page",
      name: "A title",
      audience: "https://palm.test/c/pages",
      to: ["https://palm.test/c/pages", "as:Public"],
      source: { content: "Some **markdown**", mediaType: "text/markdown" },
      attachment: { type: "Link", href: "https://example.com/" },
    });
    const outbox = await (await worker.fetch(`${DOMAIN}/c/pages/outbox`, AP)).json<{ orderedItems: { type: string; object: { type: string } }[] }>();
    expect(outbox.orderedItems[0]).toMatchObject({ type: "Announce", object: { type: "Create" } });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM communities").first<{ n: number }>())!.n).toBeGreaterThan(0);
  });
});

describe("Lemmy inbox", () => {
  it("shows replies to your comments in the inbox and counts them unread", async () => {
    const communityId = await createCommunity("inboxes");
    const login = async (name: string) => {
      const id = await createAccount(name, "pw-pw-pw");
      await giveKeys(id);
      const { jwt } = await (await worker.fetch(`${DOMAIN}/api/v3/user/login`, json({ username_or_email: name, password: "pw-pw-pw" }))).json<{ jwt: string }>();
      return (method: string, path: string, body?: unknown) =>
        worker.fetch(`${DOMAIN}/api/v3${path}`, {
          method,
          headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    };
    const jo = await login("jo");
    const kai = await login("kai");
    const post = await (await jo("POST", "/post", { community_id: communityId, name: "Thread" })).json<{ post_view: { post: { id: number } } }>();
    const top = await (await jo("POST", "/comment", { post_id: post.post_view.post.id, content: "my comment" })).json<{ comment_view: { comment: { id: number } } }>();
    await kai("POST", "/comment", { post_id: post.post_view.post.id, parent_id: top.comment_view.comment.id, content: "a reply to jo" });

    const counts = await until(async () => {
      const c = await (await jo("GET", "/user/unread_count")).json<{ replies: number }>();
      return c.replies > 0 ? c : null;
    });
    expect(counts.replies).toBe(1);
    const inbox = await (await jo("GET", "/user/replies?unread_only=true")).json<{ replies: { comment: { content: string }; comment_reply: { id: number } }[] }>();
    expect(inbox.replies.map((r) => r.comment.content)).toEqual(["a reply to jo"]);
    await jo("POST", "/comment/mark_as_read", { comment_reply_id: inbox.replies[0]!.comment_reply.id, read: true });
    expect((await (await jo("GET", "/user/unread_count")).json<{ replies: number }>()).replies).toBe(0);
  });
});
