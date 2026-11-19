import { describe, expect, it } from "vitest";
import { createAccount, createCommunity, db, giveKeys, json, MASTODON, mastodonToken, worker } from "./helpers.ts";

const SITE = "https://palm.test";

async function until<T>(check: () => Promise<T | null>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const cron = () =>
  (worker as unknown as { scheduled(o: { cron: string; scheduledTime: number }): Promise<unknown> }).scheduled({
    cron: "*/10 * * * *",
    // Away from 03:00 UTC, so the prune doesn't run.
    scheduledTime: Date.UTC(2026, 0, 1, 12, 0),
  });

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

describe("Migration", () => {
  it("sends imported follows from the cron, a few at a time", async () => {
    const me = await createAccount("imp_me", "pw");
    await giveKeys(me);
    const person = await createAccount("imp_person", "pw");
    const community = await createCommunity("imp_c");
    const insert = db.prepare("INSERT INTO follow_imports (account_id, target, via, created_at) VALUES (?, ?, ?, 0)");
    await db.batch([
      insert.bind(me, "imp_person@palm.test", "mastodon"),
      insert.bind(me, "https://palm.test/c/imp_c", "lemmy"),
      insert.bind(me, "imp_ghost@palm.test", "mastodon"),
    ]);

    await cron();
    const followed = await until(() =>
      db.prepare("SELECT mastodon, lemmy FROM account_follows WHERE account_id = ? AND target_id = ?").bind(me, person).first<{ mastodon: number; lemmy: number }>(),
    );
    expect(followed).toEqual({ mastodon: 1, lemmy: 0 });
    await until(() => db.prepare("SELECT 1 AS x FROM community_subscriptions WHERE community_id = ? AND account_id = ?").bind(community, me).first());
    // Followed or not found, each import is done with.
    await until(async () => ((await db.prepare("SELECT COUNT(*) AS n FROM follow_imports WHERE account_id = ?").bind(me).first<{ n: number }>())!.n === 0 ? true : null));
  });

  it("leaves a Lemmy import's follows past the lookup limit to the cron", async () => {
    const amy = await lemmyAs("imp_amy");
    const followed_communities = Array.from({ length: 42 }, (_, i) => `https://palm.test/c/imp_missing_${i}`);
    expect((await amy.lemmy("POST", "/user/import_settings", { followed_communities })).status).toBe(200);
    const { results } = await db.prepare("SELECT target, via FROM follow_imports WHERE account_id = ? ORDER BY id").bind(amy.id).all<{ target: string; via: string }>();
    expect(results).toEqual([
      { target: "https://palm.test/c/imp_missing_40", via: "lemmy" },
      { target: "https://palm.test/c/imp_missing_41", via: "lemmy" },
    ]);
  });

  it("stops a moved account posting", async () => {
    const mover = await lemmyAs("imp_mover");
    await db.prepare("UPDATE accounts SET moved_to = ? WHERE id = ?").bind("https://new.example/users/mover", mover.id).run();
    const req = json({ status: "still here?" });
    const status = await worker.fetch(`${MASTODON}/api/v1/statuses`, { ...req, headers: { ...req.headers, authorization: `Bearer ${await mastodonToken(mover.id)}` } });
    expect(status.status).toBe(403);

    const community = await createCommunity("imp_moved_c");
    const post = await mover.lemmy("POST", "/post", { community_id: community, name: "hello" });
    expect(await post.json()).toEqual({ error: "user_moved" });
  });
});
