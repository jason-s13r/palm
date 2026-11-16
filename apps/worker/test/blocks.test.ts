import { describe, expect, it } from "vitest";
import { createAccount, createCommunity, db, json, MASTODON, mastodonToken, worker } from "./helpers.ts";

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

type Status = { id: string; account: { id: string } };

describe("Blocks and mutes", () => {
  it("blocks and mutes people from Mastodon apps, and it holds in Lemmy apps", async () => {
    const amy = await both("amy");
    const bob = await both("bob");
    const cat = await both("cat");
    await bob.masto("POST", `/api/v1/accounts/${amy.id}/follow`);
    const bobPost = await (await bob.masto("POST", "/api/v1/statuses", { status: "from bob" })).json<Status>();
    await cat.masto("POST", "/api/v1/statuses", { status: "from cat" });

    const rel = await (await amy.masto("POST", `/api/v1/accounts/${bob.id}/block`)).json<{ blocking: boolean }>();
    expect(rel.blocking).toBe(true);
    await amy.masto("POST", `/api/v1/accounts/${cat.id}/mute`, { notifications: true });

    const local = await (await amy.masto("GET", "/api/v1/timelines/public?local=true")).json<Status[]>();
    const authors = local.map((s) => s.account.id);
    expect(authors).not.toContain(String(bob.id));
    expect(authors).not.toContain(String(cat.id));
    expect((await (await amy.masto("GET", "/api/v1/blocks")).json<{ id: string }[]>()).map((a) => a.id)).toEqual([String(bob.id)]);
    expect((await (await amy.masto("GET", "/api/v1/mutes")).json<{ id: string }[]>()).map((a) => a.id)).toEqual([String(cat.id)]);

    // The block ended bob's follow of amy, and his mentions don't notify her.
    const followers = await db.prepare("SELECT COUNT(*) AS n FROM account_follows WHERE account_id = ? AND target_id = ?").bind(bob.id, amy.id).first<{ n: number }>();
    expect(followers?.n).toBe(0);
    await bob.masto("POST", "/api/v1/statuses", { status: "@amy hello" });
    await new Promise((r) => setTimeout(r, 500));
    const notes = await (await amy.masto("GET", "/api/v1/notifications")).json<{ account: { id: string } }[]>();
    expect(notes.map((n) => n.account.id)).not.toContain(String(bob.id));

    // Lemmy apps see the same block.
    const site = await (await amy.lemmy("GET", "/site")).json<{ my_user: { person_blocks: { target: { id: number } }[] } }>();
    expect(site.my_user.person_blocks.map((b) => b.target.id)).toEqual([bob.id]);
    await amy.masto("POST", `/api/v1/accounts/${bob.id}/unblock`);
    const after = await (await amy.masto("GET", `/api/v1/statuses/${bobPost.id}`)).json<Status>();
    expect(after.id).toBe(bobPost.id);
  });

  it("blocks communities and servers from Lemmy apps", async () => {
    const communityId = await createCommunity("noisy", "Noisy");
    const dee = await both("dee");
    const poster = await both("poster2");
    await poster.lemmy("POST", "/post", { community_id: communityId, name: "a noisy post" });
    const before = await (await dee.lemmy("GET", "/post/list?type_=All&sort=New")).json<{ posts: { post: { name: string } }[] }>();
    expect(before.posts.map((p) => p.post.name)).toContain("a noisy post");
    expect((await dee.lemmy("POST", "/community/block", { community_id: communityId, block: true })).status).toBe(200);
    const hidden = await (await dee.lemmy("GET", "/post/list?type_=All&sort=New")).json<{ posts: { post: { name: string } }[] }>();
    expect(hidden.posts.map((p) => p.post.name)).not.toContain("a noisy post");
    const site = await (await dee.lemmy("GET", "/site")).json<{ my_user: { community_blocks: { community: { id: number } }[] } }>();
    expect(site.my_user.community_blocks.map((b) => b.community.id)).toEqual([communityId]);

    // A whole server, from Mastodon apps.
    expect((await dee.masto("POST", "/api/v1/domain_blocks", { domain: "spam.example" })).status).toBe(200);
    expect(await (await dee.masto("GET", "/api/v1/domain_blocks")).json()).toEqual(["spam.example"]);
  });
});
