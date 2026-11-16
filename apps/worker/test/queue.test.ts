import { describe, expect, it } from "vitest";
import { createAccount, db, giveKeys, json, MASTODON, mastodonToken, worker } from "./helpers.ts";

async function until<T>(check: () => Promise<T | null>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("Queue", () => {
  it("runs a post's follow-up work as a queue job: a reply notifies its parent's author", async () => {
    const authorId = await createAccount("qa", "pw");
    const replierId = await createAccount("qb", "pw");
    await giveKeys(replierId);
    const post = async (id: number, body: Record<string, unknown>) => {
      const req = json(body);
      const token = await mastodonToken(id);
      return (await worker.fetch(`${MASTODON}/api/v1/statuses`, { ...req, headers: { ...req.headers, authorization: `Bearer ${token}` } })).json<{ id: string }>();
    };
    const parent = await post(authorId, { status: "first" });
    const reply = await post(replierId, { status: "a reply", in_reply_to_id: parent.id });

    const row = await until(() =>
      db.prepare("SELECT kind, from_account_id, post_id FROM notifications WHERE account_id = ?").bind(authorId).first<{ kind: string; from_account_id: number; post_id: number }>(),
    );
    expect(row).toEqual({ kind: "reply", from_account_id: replierId, post_id: Number(reply.id) });
  });
});
