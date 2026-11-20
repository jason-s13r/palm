/**
 * An account's end of life: moving to another server, and deletion. A moved
 * or deleted account keeps its row, because its ActivityPub ID stays taken
 * and other servers' copies point at it.
 */

const now = () => Math.floor(Date.now() / 1000);

/** The other IDs an account says are also it (Mastodon's aliases). */
export async function setAlsoKnownAs(db: D1Database, accountId: number, ids: string[]): Promise<void> {
  await db
    .prepare("UPDATE accounts SET also_known_as = ?, profile_version = profile_version + 1 WHERE id = ?")
    .bind(ids.length ? JSON.stringify([...new Set(ids)]) : null, accountId)
    .run();
}

/**
 * Marks an account as moved. For a local account the Move goes out on the
 * next cron run (`pendingMoves`), so the CLI can set it too.
 */
export async function setMovedTo(db: D1Database, accountId: number, target: string | null): Promise<void> {
  await db.prepare("UPDATE accounts SET moved_to = ?, move_sent_at = NULL, profile_version = profile_version + 1 WHERE id = ?").bind(target, accountId).run();
}

/** Local accounts whose Move hasn't been sent yet. */
export async function pendingMoves(db: D1Database): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT id FROM accounts WHERE ap_id IS NULL AND moved_to IS NOT NULL AND move_sent_at IS NULL AND deleted_at IS NULL LIMIT 20")
    .all<{ id: number }>();
  return results.map((r) => r.id);
}

/** Deleted local accounts whose followers haven't been told yet. */
export async function pendingDeletes(db: D1Database): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT DISTINCT a.id FROM accounts a JOIN followers f ON f.account_id = a.id WHERE a.ap_id IS NULL AND a.deleted_at IS NOT NULL LIMIT 20")
    .all<{ id: number }>();
  return results.map((r) => r.id);
}

/** An account's domain, for running its federation work on the right context. */
export async function domainOf(db: D1Database, accountId: number): Promise<string | null> {
  return (await db.prepare("SELECT domain FROM accounts WHERE id = ?").bind(accountId).first<{ domain: string }>())?.domain ?? null;
}

export async function markMoveSent(db: D1Database, accountId: number): Promise<void> {
  await db.prepare("UPDATE accounts SET move_sent_at = ? WHERE id = ?").bind(now(), accountId).run();
}

/** Local accounts following an account, which a Move asks to follow its new one. */
export async function localFollowersOf(db: D1Database, targetId: number): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT f.account_id AS id FROM account_follows f JOIN accounts a ON a.id = f.account_id
       WHERE f.target_id = ? AND a.ap_id IS NULL AND a.deleted_at IS NULL`,
    )
    .bind(targetId)
    .all<{ id: number }>();
  return results.map((r) => r.id);
}

/**
 * Deletes a local account: it can't sign in, its sessions and tokens go, and
 * with `content` its posts go too. Its keys stay, so the Delete that tells
 * other servers can still be signed once queued.
 */
export async function deleteLocalAccount(db: D1Database, accountId: number, content: boolean): Promise<void> {
  const t = now();
  await db.batch([
    db.prepare("UPDATE accounts SET deleted_at = ?, banned_at = COALESCE(banned_at, ?), profile_version = profile_version + 1, password_hash = NULL, display_name = NULL, bio = NULL, avatar_url = NULL, header_url = NULL WHERE id = ?").bind(t, t, accountId),
    db.prepare("DELETE FROM sessions WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM oauth_tokens WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM oauth_codes WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM push_subscriptions WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM account_follows WHERE account_id = ? OR target_id = ?").bind(accountId, accountId),
    db.prepare("DELETE FROM community_subscriptions WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM notifications WHERE account_id = ?").bind(accountId),
    ...(content ? [db.prepare("UPDATE posts SET deleted_at = ? WHERE account_id = ? AND deleted_at IS NULL").bind(t, accountId)] : []),
  ]);
}

/** A remote account deleted itself: its posts, and the follows either way, go. */
export async function forgetRemoteAccount(db: D1Database, accountId: number, apId: string): Promise<void> {
  const t = now();
  await db.batch([
    db.prepare("UPDATE accounts SET deleted_at = ? WHERE id = ?").bind(t, accountId),
    db.prepare("UPDATE posts SET deleted_at = ? WHERE account_id = ? AND deleted_at IS NULL").bind(t, accountId),
    db.prepare("DELETE FROM account_follows WHERE account_id = ? OR target_id = ?").bind(accountId, accountId),
    db.prepare("DELETE FROM followers WHERE actor_id = ?").bind(apId),
    db.prepare("DELETE FROM community_followers WHERE actor_id = ?").bind(apId),
  ]);
}

/** Forgets a local account's remote followers, once they've been told it's gone. */
export async function clearFollowers(db: D1Database, accountId: number): Promise<void> {
  await db.prepare("DELETE FROM followers WHERE account_id = ?").bind(accountId).run();
}

/** What an account follows, blocks and saves, by ActivityPub ID, for Lemmy's settings export. */
export interface AccountExport {
  communities: string[];
  people: string[];
  blockedCommunities: string[];
  blockedPeople: string[];
  blockedDomains: string[];
  saved: { id: string; comment: boolean }[];
}

export async function exportAccount(db: D1Database, accountId: number): Promise<AccountExport> {
  const apIdOf = (kind: "c" | "u") =>
    kind === "c"
      ? "COALESCE(c.ap_id, 'https://' || c.domain || '/c/' || lower(c.name))"
      : "COALESCE(a.ap_id, 'https://' || a.domain || '/users/' || lower(a.username))";
  const ids = async (sql: string) => (await db.prepare(sql).bind(accountId).all<{ id: string }>()).results.map((r) => r.id);
  const [communities, people, blockedCommunities, blockedPeople, blockedDomains, saved] = await Promise.all([
    ids(`SELECT ${apIdOf("c")} AS id FROM community_subscriptions s JOIN communities c ON c.id = s.community_id WHERE s.account_id = ?`),
    ids(`SELECT ${apIdOf("u")} AS id FROM account_follows f JOIN accounts a ON a.id = f.target_id WHERE f.account_id = ? AND f.lemmy = 1`),
    ids(`SELECT ${apIdOf("c")} AS id FROM community_blocks b JOIN communities c ON c.id = b.community_id WHERE b.account_id = ?`),
    ids(`SELECT ${apIdOf("u")} AS id FROM account_blocks b JOIN accounts a ON a.id = b.target_id WHERE b.account_id = ? AND b.kind = 'block'`),
    ids("SELECT domain AS id FROM user_domain_blocks WHERE account_id = ?"),
    db
      .prepare(
        `SELECT COALESCE(p.ap_id, 'https://' || a.domain || CASE
           WHEN p.lemmy_path = 0 THEN '/objects/'
           WHEN p.root_id IS NOT NULL OR p.parent_id IS NOT NULL OR p.in_reply_to IS NOT NULL THEN '/comment/'
           ELSE '/post/' END || p.id) AS id, p.parent_id IS NOT NULL AS comment
         FROM bookmarks b JOIN posts p ON p.id = b.post_id JOIN accounts a ON a.id = p.account_id WHERE b.account_id = ?`,
      )
      .bind(accountId)
      .all<{ id: string; comment: number }>()
      .then((r) => r.results.map((x) => ({ id: x.id, comment: x.comment === 1 }))),
  ]);
  return { communities, people, blockedCommunities, blockedPeople, blockedDomains, saved };
}

/** A follow brought from another server, waiting to be sent. */
export interface FollowImport {
  id: number;
  accountId: number;
  /** A handle (`name@host`, `!name@host`) or an ActivityPub ID. */
  target: string;
  /** The app the follow shows in. */
  via: "mastodon" | "lemmy";
}

/** Adds follows to bring over; ones already waiting are kept as they are. */
export async function queueFollowImports(db: D1Database, accountId: number, items: { target: string; via: "mastodon" | "lemmy" }[]): Promise<void> {
  if (!items.length) return;
  const at = now();
  const insert = db.prepare("INSERT OR IGNORE INTO follow_imports (account_id, target, via, created_at) VALUES (?, ?, ?, ?)");
  await db.batch(items.map((i) => insert.bind(accountId, i.target, i.via, at)));
}

/** How long a claimed import waits before it's tried again, in case its job was lost. */
const IMPORT_RETRY_SECONDS = 60 * 60;

/**
 * Claims the next follow imports to send, oldest first. A claim that hasn't
 * finished within the hour is claimed again.
 */
export async function claimFollowImports(db: D1Database, limit: number): Promise<{ id: number; accountId: number }[]> {
  const at = now();
  const { results } = await db
    .prepare(
      `UPDATE follow_imports SET queued_at = ?
       WHERE id IN (SELECT id FROM follow_imports WHERE queued_at IS NULL OR queued_at < ? ORDER BY id LIMIT ?)
       RETURNING id, account_id`,
    )
    .bind(at, at - IMPORT_RETRY_SECONDS, limit)
    .all<{ id: number; account_id: number }>();
  return results.map((r) => ({ id: r.id, accountId: r.account_id })).sort((a, b) => a.id - b.id);
}

export async function followImportById(db: D1Database, id: number): Promise<FollowImport | null> {
  const row = await db
    .prepare("SELECT id, account_id, target, via FROM follow_imports WHERE id = ?")
    .bind(id)
    .first<{ id: number; account_id: number; target: string; via: string }>();
  return row ? { id: row.id, accountId: row.account_id, target: row.target, via: row.via === "lemmy" ? "lemmy" : "mastodon" } : null;
}

/** Done with an import, whether it was followed or couldn't be found. */
export async function finishFollowImport(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM follow_imports WHERE id = ?").bind(id).run();
}
