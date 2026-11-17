import { describe, expect, it } from "vitest";
import { createAccount, createCommunity, db, giveKeys, json, MASTODON, mastodonToken, worker } from "./helpers.ts";

const SITE = "https://palm.test";
const AP = { accept: "application/activity+json" };

async function lemmyAs(username: string) {
  const id = await createAccount(username, "pw-pw-pw");
  await giveKeys(id);
  const { jwt } = await (await worker.fetch(`${SITE}/api/v3/user/login`, json({ username_or_email: username, password: "pw-pw-pw" }))).json<{ jwt: string }>();
  const lemmy = (method: string, path: string, body?: unknown) =>
    worker.fetch(`${SITE}/api/v3${path}`, {
      method,
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { id, lemmy };
}

describe("Account lifecycle", () => {
  it("exports and imports Lemmy settings", async () => {
    const community = await createCommunity("lifecycle_c");
    const amy = await lemmyAs("lc_amy");
    const bob = await lemmyAs("lc_bob");
    await amy.lemmy("POST", "/community/follow", { community_id: community, follow: true });
    const exported = await (await amy.lemmy("GET", "/user/export_settings")).json<{ followed_communities: string[] }>();
    expect(exported.followed_communities).toContain("https://palm.test/c/lifecycle_c");

    expect((await bob.lemmy("POST", "/user/import_settings", exported)).status).toBe(200);
    const row = await db.prepare("SELECT 1 FROM community_subscriptions WHERE community_id = ? AND account_id = ?").bind(community, bob.id).first();
    expect(row).not.toBeNull();
  });

  it("advertises aliases and a move on the actor", async () => {
    const { id } = await lemmyAs("lc_mover");
    await db
      .prepare("UPDATE accounts SET also_known_as = ?, moved_to = ? WHERE id = ?")
      .bind(JSON.stringify(["https://old.example/users/mover"]), "https://new.example/users/mover", id)
      .run();
    const actor = await (await worker.fetch(`${SITE}/users/lc_mover`, { headers: AP })).json<{ alsoKnownAs: unknown; movedTo: string }>();
    expect(actor.movedTo).toBe("https://new.example/users/mover");
    expect([actor.alsoKnownAs].flat()).toContain("https://old.example/users/mover");

    // Mastodon apps show where it went.
    await lemmyAs("lc_newhome");
    await db.prepare("UPDATE accounts SET moved_to = ? WHERE id = ?").bind("https://palm.test/users/lc_newhome", id).run();
    const viewer = await createAccount("lc_viewer", "pw");
    const view = await (
      await worker.fetch(`${MASTODON}/api/v1/accounts/${id}`, { headers: { authorization: `Bearer ${await mastodonToken(viewer)}` } })
    ).json<{ moved?: { acct: string } }>();
    expect(view.moved?.acct).toBe("lc_newhome");
  });

  it("deletes an account from a Lemmy app", async () => {
    const cat = await lemmyAs("lc_cat");
    expect((await cat.lemmy("POST", "/user/delete_account", { password: "wrong", delete_content: true })).status).toBe(400);
    expect((await cat.lemmy("POST", "/user/delete_account", { password: "pw-pw-pw", delete_content: true })).status).toBe(200);

    expect((await worker.fetch(`${SITE}/users/lc_cat`, { headers: AP })).status).toBe(410);
    const login = await worker.fetch(`${SITE}/api/v3/user/login`, json({ username_or_email: "lc_cat", password: "pw-pw-pw" }));
    expect(login.status).toBe(400);
    expect((await cat.lemmy("GET", "/site")).status).toBe(200);
    const me = await (await cat.lemmy("GET", "/site")).json<{ my_user?: unknown }>();
    expect(me.my_user).toBeUndefined();
  });
});
