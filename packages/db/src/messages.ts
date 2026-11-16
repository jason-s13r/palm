import { toPost, type Post, type PostRow } from "./posts.ts";

/**
 * Private messages: direct posts between people. Lemmy apps list them as
 * private messages and Mastodon apps as conversations; they're the same
 * rows, so a message sent from one shows in the other.
 */
export interface DirectMessage {
  post: Post;
  /** Everyone it's addressed to (its mentions). */
  recipientIds: number[];
  /** Whether the viewer has read it (their own messages always are). */
  read: boolean;
}

export async function directMessages(
  db: D1Database,
  accountId: number,
  options: { unreadOnly?: boolean | undefined; withAccountId?: number | undefined; limit: number; offset?: number | undefined; maxId?: number | undefined },
): Promise<DirectMessage[]> {
  const conditions = [
    "p.visibility = 'direct'",
    "p.deleted_at IS NULL",
    "(p.account_id = ?1 OR EXISTS (SELECT 1 FROM mentions m WHERE m.post_id = p.id AND m.account_id = ?1))",
  ];
  const params: (number | string)[] = [accountId];
  if (options.withAccountId !== undefined) {
    params.push(options.withAccountId);
    const n = params.length;
    conditions.push(`(p.account_id = ?${n} OR EXISTS (SELECT 1 FROM mentions m WHERE m.post_id = p.id AND m.account_id = ?${n}))`);
  }
  if (options.maxId !== undefined) {
    params.push(options.maxId);
    conditions.push(`p.id < ?${params.length}`);
  }
  if (options.unreadOnly) {
    conditions.push("EXISTS (SELECT 1 FROM notifications n WHERE n.account_id = ?1 AND n.post_id = p.id AND n.read = 0)");
  }
  params.push(options.limit, options.offset ?? 0);
  const { results } = await db
    .prepare(
      `SELECT p.*,
         (SELECT GROUP_CONCAT(m.account_id) FROM mentions m WHERE m.post_id = p.id) AS recipient_ids,
         NOT EXISTS (SELECT 1 FROM notifications n WHERE n.account_id = ?1 AND n.post_id = p.id AND n.read = 0) AS is_read
       FROM posts p WHERE ${conditions.join(" AND ")}
       ORDER BY p.id DESC LIMIT ?${params.length - 1} OFFSET ?${params.length}`,
    )
    .bind(...params)
    .all<PostRow & { recipient_ids: string | null; is_read: number }>();
  return results.map((r) => ({
    post: toPost(r),
    recipientIds: (r.recipient_ids ?? "").split(",").filter(Boolean).map(Number),
    read: r.account_id === accountId || r.is_read === 1,
  }));
}

/** Marks messages read (or unread again) for one reader. */
export async function markMessagesRead(db: D1Database, accountId: number, postIds: number[], read = true): Promise<void> {
  if (!postIds.length) return;
  await db
    .prepare(`UPDATE notifications SET read = ? WHERE account_id = ? AND post_id IN (${postIds.map(() => "?").join(", ")})`)
    .bind(read ? 1 : 0, accountId, ...postIds)
    .run();
}

export async function countUnreadMessages(db: D1Database, accountId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT n.post_id) AS n FROM notifications n JOIN posts p ON p.id = n.post_id
       WHERE n.account_id = ? AND n.read = 0 AND p.visibility = 'direct' AND p.deleted_at IS NULL`,
    )
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
