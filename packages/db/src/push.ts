/** Web Push subscriptions, one per access token, as Mastodon keeps them. */
export interface PushSubscription {
  tokenHash: string;
  accountId: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  alerts: Record<string, boolean>;
  policy: string;
  /** RFC 8291 (aes128gcm) rather than Mastodon's older aesgcm. */
  standard: boolean;
  /** Mastodon puts the subscribing token in each push, which apps match to an account. */
  accessToken: string;
}

type Row = { token_hash: string; account_id: number; endpoint: string; p256dh: string; auth: string; alerts: string; policy: string; standard: number; access_token: string };
const toSubscription = (r: Row): PushSubscription => ({
  tokenHash: r.token_hash,
  accountId: r.account_id,
  endpoint: r.endpoint,
  p256dh: r.p256dh,
  auth: r.auth,
  alerts: JSON.parse(r.alerts) as Record<string, boolean>,
  policy: r.policy,
  standard: r.standard === 1,
  accessToken: r.access_token,
});

export async function savePushSubscription(db: D1Database, s: PushSubscription): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO push_subscriptions (token_hash, account_id, endpoint, p256dh, auth, alerts, policy, standard, access_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(s.tokenHash, s.accountId, s.endpoint, s.p256dh, s.auth, JSON.stringify(s.alerts), s.policy, s.standard ? 1 : 0, s.accessToken, Math.floor(Date.now() / 1000))
    .run();
}

export async function pushSubscription(db: D1Database, tokenHash: string): Promise<PushSubscription | null> {
  const row = await db.prepare("SELECT * FROM push_subscriptions WHERE token_hash = ?").bind(tokenHash).first<Row>();
  return row ? toSubscription(row) : null;
}

export async function pushSubscriptionsFor(db: D1Database, accountId: number): Promise<PushSubscription[]> {
  const { results } = await db.prepare("SELECT * FROM push_subscriptions WHERE account_id = ?").bind(accountId).all<Row>();
  return results.map(toSubscription);
}

export async function deletePushSubscription(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare("DELETE FROM push_subscriptions WHERE token_hash = ?").bind(tokenHash).run();
}

/** An instance-wide value in palm_meta, made once by `create` if missing. */
export async function metaValue(db: D1Database, key: string, create: () => Promise<string>): Promise<string> {
  const found = await db.prepare("SELECT value FROM palm_meta WHERE key = ?").bind(key).first<{ value: string }>();
  if (found) return found.value;
  await db.prepare("INSERT OR IGNORE INTO palm_meta (key, value) VALUES (?, ?)").bind(key, await create()).run();
  return (await db.prepare("SELECT value FROM palm_meta WHERE key = ?").bind(key).first<{ value: string }>())!.value;
}
