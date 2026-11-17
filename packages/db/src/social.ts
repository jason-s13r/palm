const now = () => Math.floor(Date.now() / 1000);

// --- following people --------------------------------------------------------

export type FollowState = "pending" | "accepted";

/** Follows another account. A remote one stays pending until it accepts `followApId`. */
export async function follow(
  db: D1Database,
  accountId: number,
  targetId: number,
  pending?: { followApId: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO account_follows (account_id, target_id, state, follow_ap_id, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account_id, target_id) DO NOTHING`,
    )
    .bind(accountId, targetId, pending ? "pending" : "accepted", pending?.followApId ?? null, now())
    .run();
}

export async function unfollow(db: D1Database, accountId: number, targetId: number): Promise<void> {
  await db.prepare("DELETE FROM account_follows WHERE account_id = ? AND target_id = ?").bind(accountId, targetId).run();
}

export async function followState(
  db: D1Database,
  accountId: number,
  targetId: number,
): Promise<{ state: FollowState; followApId: string | null } | null> {
  const row = await db
    .prepare("SELECT state, follow_ap_id FROM account_follows WHERE account_id = ? AND target_id = ?")
    .bind(accountId, targetId)
    .first<{ state: FollowState; follow_ap_id: string | null }>();
  return row ? { state: row.state, followApId: row.follow_ap_id } : null;
}

/** The follow a Follow ID belongs to, for matching an Accept or Reject. */
export async function followByApId(db: D1Database, followApId: string): Promise<{ accountId: number; targetId: number } | null> {
  const row = await db
    .prepare("SELECT account_id, target_id FROM account_follows WHERE follow_ap_id = ?")
    .bind(followApId)
    .first<{ account_id: number; target_id: number }>();
  return row ? { accountId: row.account_id, targetId: row.target_id } : null;
}

export async function acceptFollow(db: D1Database, accountId: number, targetId: number): Promise<void> {
  await db.prepare("UPDATE account_follows SET state = 'accepted' WHERE account_id = ? AND target_id = ?").bind(accountId, targetId).run();
}

/** Accounts this one follows (accepted), newest first. */
export async function followingIds(db: D1Database, accountId: number, limit = 80, offset = 0): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT target_id FROM account_follows WHERE account_id = ? AND state = 'accepted' ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .bind(accountId, limit, offset)
    .all<{ target_id: number }>();
  return results.map((r) => r.target_id);
}

/** Local accounts following this one, newest first (remote followers live in `followers`). */
export async function localFollowerIds(db: D1Database, targetId: number, limit = 80, offset = 0): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT account_id FROM account_follows WHERE target_id = ? AND state = 'accepted' ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .bind(targetId, limit, offset)
    .all<{ account_id: number }>();
  return results.map((r) => r.account_id);
}

export async function countFollowing(db: D1Database, accountId: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM account_follows WHERE account_id = ? AND state = 'accepted'")
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Whether any local account follows this one: if none, palm needn't keep its posts. */
export async function hasLocalFollowers(db: D1Database, targetId: number): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM account_follows WHERE target_id = ? LIMIT 1").bind(targetId).first();
  return row !== null;
}

/** A viewer's relationships to some accounts, for Mastodon's relationship entities. */
export async function relationships(
  db: D1Database,
  viewerId: number,
  ids: number[],
): Promise<Map<number, { following: FollowState | null; followedBy: boolean }>> {
  const out = new Map<number, { following: FollowState | null; followedBy: boolean }>();
  if (!ids.length) return out;
  const marks = ids.map(() => "?").join(", ");
  const [mine, theirs] = await Promise.all([
    db.prepare(`SELECT target_id, state FROM account_follows WHERE account_id = ? AND target_id IN (${marks})`).bind(viewerId, ...ids).all<{ target_id: number; state: FollowState }>(),
    db.prepare(`SELECT account_id FROM account_follows WHERE target_id = ? AND state = 'accepted' AND account_id IN (${marks})`).bind(viewerId, ...ids).all<{ account_id: number }>(),
  ]);
  for (const id of ids) out.set(id, { following: null, followedBy: false });
  for (const r of mine.results) out.get(r.target_id)!.following = r.state;
  for (const r of theirs.results) out.get(r.account_id)!.followedBy = true;
  return out;
}

// --- boosts and bookmarks ----------------------------------------------------

/**
 * Records a boost: in `boosts`, for counts, and as a row in `posts` that
 * points at the boosted post, so it shows in the booster's timeline and
 * their followers' home timelines.
 */
export async function boost(db: D1Database, postId: number, accountId: number, apId: string | null): Promise<void> {
  const added = await db
    .prepare("INSERT INTO boosts (post_id, account_id, ap_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(postId, accountId, apId, now())
    .run();
  if (!added.meta.changes) return;
  await db
    .prepare(
      `INSERT INTO posts (account_id, content_source, content_html, visibility, created_at, reblog_of)
       VALUES (?, '', '', 'public', ?, ?)`,
    )
    .bind(accountId, now(), postId)
    .run();
}

async function removeBoostRow(db: D1Database, postId: number, accountId: number): Promise<void> {
  await db.prepare("DELETE FROM posts WHERE reblog_of = ? AND account_id = ?").bind(postId, accountId).run();
}

export async function unboost(db: D1Database, postId: number, accountId: number): Promise<void> {
  await db.prepare("DELETE FROM boosts WHERE post_id = ? AND account_id = ?").bind(postId, accountId).run();
  await removeBoostRow(db, postId, accountId);
}

export async function unboostByApId(db: D1Database, apId: string, accountId: number): Promise<void> {
  const row = await db.prepare("SELECT post_id FROM boosts WHERE ap_id = ? AND account_id = ?").bind(apId, accountId).first<{ post_id: number }>();
  if (row) await unboost(db, row.post_id, accountId);
}

export async function bookmark(db: D1Database, postId: number, accountId: number): Promise<void> {
  await db
    .prepare("INSERT INTO bookmarks (post_id, account_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(postId, accountId, now())
    .run();
}

export async function unbookmark(db: D1Database, postId: number, accountId: number): Promise<void> {
  await db.prepare("DELETE FROM bookmarks WHERE post_id = ? AND account_id = ?").bind(postId, accountId).run();
}

/** Per post: favourites, boosts and replies, and whether the viewer favourited, boosted or bookmarked it. */
export interface Interactions {
  favourites: number;
  boosts: number;
  replies: number;
  favourited: boolean;
  boosted: boolean;
  bookmarked: boolean;
}

export async function interactions(db: D1Database, postIds: number[], viewerId: number | null): Promise<Map<number, Interactions>> {
  const out = new Map<number, Interactions>();
  const unique = [...new Set(postIds)];
  if (!unique.length) return out;
  const { results } = await db
    .prepare(
      `SELECT p.id,
         (SELECT COUNT(*) FROM votes v WHERE v.post_id = p.id AND v.score = 1) AS favourites,
         (SELECT COUNT(*) FROM boosts b WHERE b.post_id = p.id) AS boosts,
         (SELECT COUNT(*) FROM posts r WHERE r.parent_id = p.id AND r.deleted_at IS NULL AND r.reblog_of IS NULL) AS replies,
         EXISTS (SELECT 1 FROM votes v WHERE v.post_id = p.id AND v.account_id = ?1 AND v.score = 1) AS favourited,
         EXISTS (SELECT 1 FROM boosts b WHERE b.post_id = p.id AND b.account_id = ?1) AS boosted,
         EXISTS (SELECT 1 FROM bookmarks k WHERE k.post_id = p.id AND k.account_id = ?1) AS bookmarked
       FROM posts p WHERE p.id IN (${unique.map((_, i) => `?${i + 2}`).join(", ")})`,
    )
    .bind(viewerId ?? -1, ...unique)
    .all<{ id: number; favourites: number; boosts: number; replies: number; favourited: number; boosted: number; bookmarked: number }>();
  for (const r of results) {
    out.set(r.id, {
      favourites: r.favourites,
      boosts: r.boosts,
      replies: r.replies,
      favourited: r.favourited === 1,
      boosted: r.boosted === 1,
      bookmarked: r.bookmarked === 1,
    });
  }
  return out;
}

// --- mentions and notifications ----------------------------------------------

export async function addMentions(db: D1Database, postId: number, accountIds: number[]): Promise<void> {
  if (!accountIds.length) return;
  await db.batch(
    [...new Set(accountIds)].map((id) =>
      db.prepare("INSERT INTO mentions (post_id, account_id) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(postId, id),
    ),
  );
}

export async function mentionedIds(db: D1Database, postIds: number[]): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  const unique = [...new Set(postIds)];
  if (!unique.length) return out;
  const { results } = await db
    .prepare(`SELECT post_id, account_id FROM mentions WHERE post_id IN (${unique.map(() => "?").join(", ")})`)
    .bind(...unique)
    .all<{ post_id: number; account_id: number }>();
  for (const r of results) out.set(r.post_id, [...(out.get(r.post_id) ?? []), r.account_id]);
  return out;
}

export type NotificationKind = "mention" | "reply" | "follow" | "follow_request" | "favourite" | "reblog";

export interface Notification {
  id: number;
  accountId: number;
  kind: NotificationKind;
  fromAccountId: number;
  postId: number | null;
  read: boolean;
  createdAt: number;
}

type NotificationHook = (db: D1Database, n: Notification) => Promise<void>;
let notificationHook: NotificationHook | null = null;

/** Runs after each new notification (push notifications use it). */
export function onNotification(hook: NotificationHook): void {
  notificationHook = hook;
}

/** Notifies a local account, unless it's about its own doing. */
export async function notify(
  db: D1Database,
  n: { accountId: number; kind: NotificationKind; fromAccountId: number; postId?: number | null },
): Promise<void> {
  if (n.accountId === n.fromAccountId) return;
  const created = await insertNotification(db, n);
  if (created && notificationHook) await notificationHook(db, created).catch((error: unknown) => console.warn(JSON.stringify({ palm: "push_failed", error: String(error) })));
}

async function insertNotification(
  db: D1Database,
  n: { accountId: number; kind: NotificationKind; fromAccountId: number; postId?: number | null },
): Promise<Notification | null> {
  const at = now();
  // Nothing from someone the recipient blocked, or muted with notifications.
  const result = await db
    .prepare(
      `INSERT INTO notifications (account_id, kind, from_account_id, post_id, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (
         SELECT 1 FROM account_blocks b WHERE b.account_id = ?1 AND b.target_id = ?3
           AND (b.kind = 'block' OR b.hide_notifications = 1) AND (b.expires_at IS NULL OR b.expires_at > ?5))
       AND NOT EXISTS (
         SELECT 1 FROM user_domain_blocks d JOIN accounts a ON a.id = ?3 WHERE d.account_id = ?1 AND d.domain = a.domain)`,
    )
    .bind(n.accountId, n.kind, n.fromAccountId, n.postId ?? null, at)
    .run();
  const id = result.meta.last_row_id;
  if (!result.meta.changes || !id) return null;
  return { id, accountId: n.accountId, kind: n.kind, fromAccountId: n.fromAccountId, postId: n.postId ?? null, read: false, createdAt: at };
}

export async function listNotifications(
  db: D1Database,
  accountId: number,
  options: {
    kinds?: NotificationKind[] | undefined;
    unreadOnly?: boolean | undefined;
    maxId?: number | undefined;
    minId?: number | undefined;
    limit: number;
    offset?: number | undefined;
  },
): Promise<Notification[]> {
  const where = ["account_id = ?"];
  const params: (string | number)[] = [accountId];
  if (options.kinds?.length) {
    where.push(`kind IN (${options.kinds.map(() => "?").join(", ")})`);
    params.push(...options.kinds);
  }
  if (options.unreadOnly) where.push("read = 0");
  if (options.maxId !== undefined) {
    where.push("id < ?");
    params.push(options.maxId);
  }
  if (options.minId !== undefined) {
    where.push("id > ?");
    params.push(options.minId);
  }
  const { results } = await db
    .prepare(`SELECT * FROM notifications WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...params, options.limit, options.offset ?? 0)
    .all<{ id: number; account_id: number; kind: NotificationKind; from_account_id: number; post_id: number | null; read: number; created_at: number }>();
  return results.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    kind: r.kind,
    fromAccountId: r.from_account_id,
    postId: r.post_id,
    read: r.read === 1,
    createdAt: r.created_at,
  }));
}

export async function countUnreadNotifications(db: D1Database, accountId: number, kinds?: NotificationKind[]): Promise<number> {
  const filter = kinds?.length ? ` AND kind IN (${kinds.map(() => "?").join(", ")})` : "";
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE account_id = ? AND read = 0${filter}`)
    .bind(accountId, ...(kinds ?? []))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Marks notifications read: all of them, or only these IDs. */
export async function markNotificationsRead(db: D1Database, accountId: number, ids?: number[]): Promise<void> {
  if (ids && !ids.length) return;
  const filter = ids ? ` AND id IN (${ids.map(() => "?").join(", ")})` : "";
  await db.prepare(`UPDATE notifications SET read = 1 WHERE account_id = ?${filter}`).bind(accountId, ...(ids ?? [])).run();
}

export async function dismissNotifications(db: D1Database, accountId: number, id?: number): Promise<void> {
  if (id === undefined) await db.prepare("DELETE FROM notifications WHERE account_id = ?").bind(accountId).run();
  else await db.prepare("DELETE FROM notifications WHERE account_id = ? AND id = ?").bind(accountId, id).run();
}
