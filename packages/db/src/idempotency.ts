const now = () => Math.floor(Date.now() / 1000);

/** How long a key stands for the post it made: an hour, as in Mastodon. */
const KEY_SECONDS = 60 * 60;

/**
 * Mastodon apps send an `Idempotency-Key` with each new status, and send the
 * same one again when they retry after a timeout. The first request claims
 * the key; a retry finds the post the first one made (or, while it's still
 * being made, nothing yet).
 */
export type Claim = { claimed: true } | { claimed: false; postId: number | null };

export async function claimIdempotencyKey(db: D1Database, accountId: number, key: string): Promise<Claim> {
  const at = now();
  const [, inserted] = await db.batch([
    db.prepare("DELETE FROM idempotency_keys WHERE account_id = ? AND created_at <= ?").bind(accountId, at - KEY_SECONDS),
    db.prepare("INSERT INTO idempotency_keys (account_id, key, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").bind(accountId, key, at),
  ]);
  if (inserted!.meta.changes) return { claimed: true };
  return { claimed: false, postId: await idempotentPost(db, accountId, key) };
}

export async function idempotentPost(db: D1Database, accountId: number, key: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT post_id FROM idempotency_keys WHERE account_id = ? AND key = ?")
    .bind(accountId, key)
    .first<{ post_id: number | null }>();
  return row?.post_id ?? null;
}

/** Ties a claimed key to the post it made, or with none, lets the key go (the request failed). */
export async function settleIdempotencyKey(db: D1Database, accountId: number, key: string, postId: number | null): Promise<void> {
  if (postId === null) await db.prepare("DELETE FROM idempotency_keys WHERE account_id = ? AND key = ?").bind(accountId, key).run();
  else await db.prepare("UPDATE idempotency_keys SET post_id = ? WHERE account_id = ? AND key = ?").bind(postId, accountId, key).run();
}
