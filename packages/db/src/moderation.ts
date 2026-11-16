import { toAccount, type Account, type AccountRow } from "./accounts.ts";
import type { KeyAlgorithm } from "./federation.ts";

const now = () => Math.floor(Date.now() / 1000);

// --- bans ----------------------------------------------------------------------

export async function setBanned(db: D1Database, accountId: number, banned: boolean): Promise<void> {
  await db.prepare("UPDATE accounts SET banned_at = ? WHERE id = ?").bind(banned ? now() : null, accountId).run();
}

export async function isBanned(db: D1Database, accountId: number): Promise<boolean> {
  const row = await db.prepare("SELECT banned_at FROM accounts WHERE id = ?").bind(accountId).first<{ banned_at: number | null }>();
  return row?.banned_at != null;
}

export async function bannedAccounts(db: D1Database): Promise<Account[]> {
  const { results } = await db.prepare("SELECT * FROM accounts WHERE banned_at IS NOT NULL ORDER BY banned_at DESC LIMIT 200").all<AccountRow>();
  return results.map(toAccount);
}

/** Deletes everything an account posted, for a ban that removes its content. */
export async function deletePostsBy(db: D1Database, accountId: number): Promise<void> {
  await db.prepare("UPDATE posts SET deleted_at = ? WHERE account_id = ? AND deleted_at IS NULL").bind(now(), accountId).run();
}

// --- blocked servers -------------------------------------------------------------

export async function blockedDomains(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT domain FROM blocked_domains ORDER BY domain").all<{ domain: string }>();
  return results.map((r) => r.domain);
}

/**
 * Whether a host is blocked: the domain itself, or any parent domain of it
 * (blocking example.com blocks lemmy.example.com too).
 */
export async function isBlockedHost(db: D1Database, host: string): Promise<boolean> {
  const parts = host.toLowerCase().split(".");
  const candidates = parts.map((_, i) => parts.slice(i).join(".")).filter((d) => d.includes("."));
  if (!candidates.length) return false;
  const row = await db
    .prepare(`SELECT 1 AS x FROM blocked_domains WHERE domain IN (${candidates.map(() => "?").join(", ")}) LIMIT 1`)
    .bind(...candidates)
    .first();
  return row !== null;
}

/**
 * Replaces the block list. Newly blocked servers' posts are deleted here;
 * their accounts stay, so nothing pointing at them breaks.
 */
export async function setBlockedDomains(db: D1Database, domains: string[]): Promise<void> {
  const wanted = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))];
  const current = new Set(await blockedDomains(db));
  const statements = [db.prepare(`DELETE FROM blocked_domains WHERE domain NOT IN (${wanted.map(() => "?").join(", ") || "''"})`).bind(...wanted)];
  for (const domain of wanted) {
    if (current.has(domain)) continue;
    statements.push(db.prepare("INSERT INTO blocked_domains (domain, created_at) VALUES (?, ?)").bind(domain, now()));
    statements.push(
      db
        .prepare(
          "UPDATE posts SET deleted_at = ? WHERE deleted_at IS NULL AND account_id IN (SELECT id FROM accounts WHERE ap_id IS NOT NULL AND (domain = ? OR domain LIKE ?))",
        )
        .bind(now(), domain, `%.${domain}`),
    );
  }
  await db.batch(statements);
}

/** Servers palm has met, for Lemmy's federated instances list. */
export async function knownDomains(db: D1Database, limit = 500): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT DISTINCT domain FROM accounts WHERE ap_id IS NOT NULL UNION SELECT DISTINCT domain FROM communities WHERE ap_id IS NOT NULL LIMIT ?")
    .bind(limit)
    .all<{ domain: string }>();
  return results.map((r) => r.domain).sort();
}

// --- invites ---------------------------------------------------------------------

/** A key pair made ahead, by the CLI, for whoever uses the invite. */
export interface InviteKeyPair {
  algorithm: KeyAlgorithm;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}

/** An unused invite for a domain, or null. */
export async function openInvite(db: D1Database, domain: string, code: string): Promise<{ code: string; keyPairs: InviteKeyPair[] } | null> {
  const row = await db
    .prepare("SELECT code, key_pairs FROM invites WHERE code = ? AND domain = ? AND used_by IS NULL")
    .bind(code.trim(), domain)
    .first<{ code: string; key_pairs: string }>();
  return row ? { code: row.code, keyPairs: JSON.parse(row.key_pairs) as InviteKeyPair[] } : null;
}

/**
 * Signs someone up with an invite: creates the account, gives it the invite's
 * keys, and marks the invite used, all at once. Returns the new account, or
 * null if the invite was used meanwhile or the name is taken.
 */
export async function redeemInvite(
  db: D1Database,
  invite: { code: string; keyPairs: InviteKeyPair[] },
  account: { domain: string; username: string; passwordHash: string },
): Promise<Account | null> {
  const at = now();
  const taken = await db
    .prepare("SELECT 1 AS x FROM accounts WHERE domain = ? AND username = ? UNION SELECT 1 FROM communities WHERE domain = ? AND name = ? AND ap_id IS NULL")
    .bind(account.domain, account.username, account.domain, account.username)
    .first();
  if (taken) return null;
  const claim = await db
    .prepare("UPDATE invites SET used_at = ? WHERE code = ? AND used_by IS NULL AND used_at IS NULL")
    .bind(at, invite.code)
    .run();
  if (!claim.meta.changes) return null;
  const row = await db
    .prepare("INSERT INTO accounts (domain, username, password_hash, role, created_at) VALUES (?, ?, ?, 'user', ?) RETURNING *")
    .bind(account.domain, account.username, account.passwordHash, at)
    .first<AccountRow>();
  const created = toAccount(row!);
  await db.batch([
    db.prepare("UPDATE invites SET used_by = ? WHERE code = ?").bind(created.id, invite.code),
    ...invite.keyPairs.map((k) =>
      db
        .prepare("INSERT OR REPLACE INTO actor_keys (account_id, algorithm, public_jwk, private_jwk, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(created.id, k.algorithm, JSON.stringify(k.publicJwk), JSON.stringify(k.privateJwk), at),
    ),
  ]);
  return created;
}

// --- pruning ---------------------------------------------------------------------

/**
 * Keeps the database inside D1's free 500 MB: deletes remote posts older than
 * `days` that nobody here touched (no local vote, bookmark, boost, mention or
 * reply), old read notifications, and Fedify's expired cache. Runs from the
 * Worker's daily cron, a batch at a time. Returns how many posts went.
 */
export async function prune(db: D1Database, days = 30, batch = 300): Promise<number> {
  const cutoff = now() - days * 24 * 60 * 60;
  // Old boosts by people elsewhere go first: they only point at posts.
  await db
    .prepare(
      "DELETE FROM posts WHERE reblog_of IS NOT NULL AND created_at < ? AND account_id IN (SELECT id FROM accounts WHERE ap_id IS NOT NULL)",
    )
    .bind(cutoff)
    .run();
  const { results } = await db
    .prepare(
      `SELECT p.id FROM posts p JOIN accounts a ON a.id = p.account_id
       WHERE a.ap_id IS NOT NULL AND p.created_at < ?
         AND NOT EXISTS (SELECT 1 FROM votes v JOIN accounts va ON va.id = v.account_id WHERE v.post_id = p.id AND va.ap_id IS NULL)
         AND NOT EXISTS (SELECT 1 FROM bookmarks k WHERE k.post_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM boosts b JOIN accounts ba ON ba.id = b.account_id WHERE b.post_id = p.id AND ba.ap_id IS NULL)
         AND NOT EXISTS (SELECT 1 FROM mentions m JOIN accounts ma ON ma.id = m.account_id WHERE m.post_id = p.id AND ma.ap_id IS NULL)
         AND NOT EXISTS (SELECT 1 FROM posts c WHERE c.parent_id = p.id OR c.root_id = p.id OR c.reblog_of = p.id)
         AND NOT EXISTS (SELECT 1 FROM media d WHERE d.post_id = p.id)
       LIMIT ?`,
    )
    .bind(cutoff, batch)
    .all<{ id: number }>();
  const ids = results.map((r) => r.id);
  if (ids.length) {
    const marks = ids.map(() => "?").join(", ");
    await db.batch([
      db.prepare(`DELETE FROM votes WHERE post_id IN (${marks})`).bind(...ids),
      db.prepare(`DELETE FROM boosts WHERE post_id IN (${marks})`).bind(...ids),
      db.prepare(`DELETE FROM bookmarks WHERE post_id IN (${marks})`).bind(...ids),
      db.prepare(`DELETE FROM mentions WHERE post_id IN (${marks})`).bind(...ids),
      db.prepare(`DELETE FROM post_tags WHERE post_id IN (${marks})`).bind(...ids),
      db.prepare(`DELETE FROM notifications WHERE post_id IN (${marks})`).bind(...ids),
      db.prepare(`DELETE FROM posts WHERE id IN (${marks})`).bind(...ids),
    ]);
  }
  await db.batch([
    db.prepare("DELETE FROM notifications WHERE read = 1 AND created_at < ?").bind(now() - 90 * 24 * 60 * 60),
    db.prepare("DELETE FROM fedify_kv WHERE expires_at IS NOT NULL AND expires_at < ?").bind(now()),
    // Link previews are fetched again if a link turns up after a month.
    db.prepare("DELETE FROM link_cards WHERE fetched_at < ?").bind(now() - 30 * 24 * 60 * 60),
  ]);
  return ids.length;
}
