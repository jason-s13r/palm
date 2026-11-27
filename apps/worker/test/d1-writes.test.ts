import { describe, expect, it } from "vitest";
import { db } from "./helpers.ts";

async function remotePost(domain: string, createdAt: number, extra: { reblogOf?: number } = {}) {
  const account = await db
    .prepare("INSERT INTO accounts (domain, username, role, created_at, ap_id, inbox) VALUES (?, 'u', 'user', 1, ?, ?) ON CONFLICT DO NOTHING RETURNING id")
    .bind(domain, `https://${domain}/u/u`, `https://${domain}/inbox`)
    .first<{ id: number }>();
  const accountId = account?.id ?? (await db.prepare("SELECT id FROM accounts WHERE ap_id = ?").bind(`https://${domain}/u/u`).first<{ id: number }>())!.id;
  const post = await db
    .prepare("INSERT INTO posts (account_id, content_source, content_html, visibility, created_at, ap_id, reblog_of) VALUES (?, 'x', '<p>x</p>', 'public', ?, ?, ?) RETURNING id")
    .bind(accountId, createdAt, `https://${domain}/p/${crypto.randomUUID()}`, extra.reblogOf ?? null)
    .first<{ id: number }>();
  return post!.id;
}

describe("D1 writes on hot paths", () => {
  it("records a runner's contact at most every five minutes", async () => {
    const { migrate, registerRunner, runnerByToken } = await import("@palm/db");
    await migrate(db);
    const { id, runnerToken } = await registerRunner(db, { name: "poller", description: null });
    const contact = async () => (await db.prepare("SELECT last_contact FROM runners WHERE id = ?").bind(id).first<{ last_contact: number | null }>())!.last_contact;

    const first = await runnerByToken(db, runnerToken);
    expect(first?.id).toBe(id);
    expect(await contact()).not.toBeNull();

    const recent = Math.floor(Date.now() / 1000) - 60;
    await db.prepare("UPDATE runners SET last_contact = ? WHERE id = ?").bind(recent, id).run();
    expect((await runnerByToken(db, runnerToken))?.lastContact).toBe(recent);
    expect(await contact()).toBe(recent);

    const stale = Math.floor(Date.now() / 1000) - 600;
    await db.prepare("UPDATE runners SET last_contact = ? WHERE id = ?").bind(stale, id).run();
    await runnerByToken(db, runnerToken);
    expect(await contact()).toBeGreaterThan(stale);

    expect(await runnerByToken(db, "ptrt-wrong")).toBeNull();
  });

  it("keeps remote votes in step when the same vote arrives again", async () => {
    const { migrate, remoteVote } = await import("@palm/db");
    await migrate(db);
    const post = await remotePost("votes.example", 1_000);
    const actor = "https://elsewhere.example/u/v";
    const score = async () => (await db.prepare("SELECT score FROM remote_votes WHERE post_id = ? AND actor = ?").bind(post, actor).first<{ score: number }>())?.score;
    await remoteVote(db, post, actor, 1);
    await remoteVote(db, post, actor, 1);
    expect(await score()).toBe(1);
    await remoteVote(db, post, actor, -1);
    expect(await score()).toBe(-1);
    await remoteVote(db, post, actor, 0);
    expect(await score()).toBeUndefined();
  });

  it("prunes old remote boosts and keeps recent ones", async () => {
    const { migrate, prune } = await import("@palm/db");
    await migrate(db);
    const original = await remotePost("boosted.example", Math.floor(Date.now() / 1000));
    const oldBoost = await remotePost("booster.example", 1_000, { reblogOf: original });
    const newBoost = await remotePost("booster.example", Math.floor(Date.now() / 1000), { reblogOf: original });
    await prune(db);
    const left = await db.prepare("SELECT id FROM posts WHERE id IN (?, ?)").bind(oldBoost, newBoost).all<{ id: number }>();
    expect(left.results.map((r) => r.id)).toEqual([newBoost]);
  });
});
