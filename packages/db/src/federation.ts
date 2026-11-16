const now = () => Math.floor(Date.now() / 1000);

// --- actor keys ------------------------------------------------------------

export type KeyAlgorithm = "RSASSA-PKCS1-v1_5" | "Ed25519";

export interface StoredKeyPair {
  algorithm: KeyAlgorithm;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}

/**
 * An account's signing keys: RSA for HTTP Signatures (what Lemmy and Mastodon
 * check) and Ed25519 for object integrity proofs. The CLI generates them,
 * because key generation is too slow for the free plan's CPU limit.
 */
export async function actorKeys(db: D1Database, accountId: number): Promise<StoredKeyPair[]> {
  const { results } = await db
    .prepare("SELECT algorithm, public_jwk, private_jwk FROM actor_keys WHERE account_id = ? ORDER BY algorithm DESC")
    .bind(accountId)
    .all<{ algorithm: KeyAlgorithm; public_jwk: string; private_jwk: string }>();
  return results.map((r) => ({
    algorithm: r.algorithm,
    publicJwk: JSON.parse(r.public_jwk) as JsonWebKey,
    privateJwk: JSON.parse(r.private_jwk) as JsonWebKey,
  }));
}

// --- followers -------------------------------------------------------------

export interface Follower {
  actorId: string;
  inbox: string;
  sharedInbox: string | null;
}

export async function addFollower(
  db: D1Database,
  accountId: number,
  follower: Follower & { followId: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO followers (account_id, actor_id, inbox, shared_inbox, follow_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, actor_id) DO UPDATE SET inbox = excluded.inbox, shared_inbox = excluded.shared_inbox, follow_id = excluded.follow_id`,
    )
    .bind(accountId, follower.actorId, follower.inbox, follower.sharedInbox, follower.followId, now())
    .run();
}

export async function removeFollower(db: D1Database, accountId: number, actorId: string): Promise<void> {
  await db.prepare("DELETE FROM followers WHERE account_id = ? AND actor_id = ?").bind(accountId, actorId).run();
}

export async function followers(db: D1Database, accountId: number): Promise<Follower[]> {
  const { results } = await db
    .prepare("SELECT actor_id, inbox, shared_inbox FROM followers WHERE account_id = ? ORDER BY created_at")
    .bind(accountId)
    .all<{ actor_id: string; inbox: string; shared_inbox: string | null }>();
  return results.map((r) => ({ actorId: r.actor_id, inbox: r.inbox, sharedInbox: r.shared_inbox }));
}

export async function countFollowers(db: D1Database, accountId: number): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM followers WHERE account_id = ?").bind(accountId).first<{ n: number }>();
  return row?.n ?? 0;
}

// --- fedify's key-value store ------------------------------------------------

/** Keys are Fedify's string arrays, joined with a separator they can't contain. */
const SEP = "\u001f";

export async function kvGet(db: D1Database, key: readonly string[]): Promise<unknown> {
  const row = await db
    .prepare("SELECT value, expires_at FROM fedify_kv WHERE key = ?")
    .bind(key.join(SEP))
    .first<{ value: string; expires_at: number | null }>();
  if (!row) return undefined;
  if (row.expires_at !== null && row.expires_at <= now()) return undefined;
  return JSON.parse(row.value);
}

export async function kvSet(db: D1Database, key: readonly string[], value: unknown, ttlSeconds: number | null): Promise<void> {
  await db
    .prepare(
      "INSERT INTO fedify_kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
    )
    .bind(key.join(SEP), JSON.stringify(value), ttlSeconds === null ? null : now() + Math.ceil(ttlSeconds))
    .run();
}

export async function kvDelete(db: D1Database, key: readonly string[]): Promise<void> {
  await db.prepare("DELETE FROM fedify_kv WHERE key = ?").bind(key.join(SEP)).run();
}

export async function kvList(db: D1Database, prefix: readonly string[]): Promise<{ key: string[]; value: unknown }[]> {
  const start = prefix.length ? prefix.join(SEP) + SEP : "";
  const { results } = await db
    .prepare("SELECT key, value FROM fedify_kv WHERE key >= ? AND key < ? AND (expires_at IS NULL OR expires_at > ?)")
    .bind(start, start + "￿", now())
    .all<{ key: string; value: string }>();
  return results.map((r) => ({ key: r.key.split(SEP), value: JSON.parse(r.value) as unknown }));
}

/** Deletes expired cache entries; run from the scheduled handler. */
export async function kvPurgeExpired(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM fedify_kv WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(now()).run();
}
