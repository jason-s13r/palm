import { toPost, type Post, type PostRow } from "./posts.ts";
import { voteCount } from "./threads.ts";

/**
 * Discovery for Pixelfed's apps: trending pictures, hashtags and popular
 * people, worked out from what palm holds, and mutual follows.
 */

const now = () => Math.floor(Date.now() / 1000);

/** Has pictures or video: a local post's media, or a remote post's attachments. */
const HAS_MEDIA = "((p.attachments IS NOT NULL AND p.attachments != '[]') OR EXISTS (SELECT 1 FROM media m WHERE m.post_id = p.id))";

/** Public posts with pictures or video from the last `days`, most liked first. */
export async function trendingMediaPosts(db: D1Database, scope: { domain: string; localOnly: boolean; days: number }, limit = 30): Promise<Post[]> {
  const { results } = await db
    .prepare(
      `SELECT p.* FROM posts p JOIN accounts a ON a.id = p.account_id
       WHERE p.deleted_at IS NULL AND p.visibility = 'public' AND p.root_id IS NULL AND p.parent_id IS NULL
         AND p.reblog_of IS NULL AND p.created_at > ? AND ${HAS_MEDIA} AND a.banned_at IS NULL
         AND ${scope.localOnly ? "a.ap_id IS NULL AND a.domain = ?" : "(a.ap_id IS NOT NULL OR a.domain = ?)"}
       ORDER BY ${voteCount(1)} DESC, p.id DESC
       LIMIT ?`,
    )
    .bind(now() - scope.days * 86_400, scope.domain, limit)
    .all<PostRow>();
  return results.map(toPost);
}

/** Hashtags on public posts from the last `days`, most used first. */
export async function trendingTags(db: D1Database, days: number, limit = 20): Promise<{ tag: string; total: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT t.tag, COUNT(*) AS total FROM post_tags t JOIN posts p ON p.id = t.post_id
       WHERE p.deleted_at IS NULL AND p.visibility = 'public' AND p.created_at > ?
       GROUP BY t.tag ORDER BY total DESC LIMIT ?`,
    )
    .bind(now() - days * 86_400, limit)
    .all<{ tag: string; total: number }>();
  return results;
}

/** This domain's people with the most followers, leaving out `exceptId`. */
export async function popularLocalAccountIds(db: D1Database, domain: string, exceptId: number, limit = 30): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id FROM accounts a
       WHERE a.ap_id IS NULL AND a.domain = ? AND a.deleted_at IS NULL AND a.banned_at IS NULL AND a.id != ?
       ORDER BY (SELECT COUNT(*) FROM followers f WHERE f.account_id = a.id)
              + (SELECT COUNT(*) FROM account_follows g WHERE g.target_id = a.id) DESC, a.id
       LIMIT ?`,
    )
    .bind(domain, exceptId, limit)
    .all<{ id: number }>();
  return results.map((r) => r.id);
}

/**
 * People `accountId` follows who also follow `targetId`, from the follows palm
 * knows: its own, and other servers' followers of local accounts.
 */
export async function mutualFollowIds(db: D1Database, accountId: number, targetId: number, limit = 24): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT f.target_id AS id FROM account_follows f
       WHERE f.account_id = ?1 AND f.state = 'accepted' AND f.target_id != ?2 AND (
         EXISTS (SELECT 1 FROM account_follows g WHERE g.account_id = f.target_id AND g.target_id = ?2 AND g.state = 'accepted')
         OR EXISTS (SELECT 1 FROM followers r JOIN accounts a ON a.ap_id = r.actor_id WHERE r.account_id = ?2 AND a.id = f.target_id)
       )
       LIMIT ?3`,
    )
    .bind(accountId, targetId, limit)
    .all<{ id: number }>();
  return results.map((r) => r.id);
}

/** The latest liker of each post, with how many liked it, for "Liked by X and others". */
export async function latestLikers(
  db: D1Database,
  postIds: number[],
): Promise<Map<number, { accountId: number; total: number }>> {
  const out = new Map<number, { accountId: number; total: number }>();
  const unique = [...new Set(postIds)].slice(0, 100);
  if (!unique.length) return out;
  const { results } = await db
    .prepare(
      `SELECT v.post_id, v.account_id, COUNT(*) OVER (PARTITION BY v.post_id) AS total,
              ROW_NUMBER() OVER (PARTITION BY v.post_id ORDER BY v.created_at DESC) AS n
       FROM votes v WHERE v.score = 1 AND v.post_id IN (${unique.map(() => "?").join(", ")})`,
    )
    .bind(...unique)
    .all<{ post_id: number; account_id: number; total: number; n: number }>();
  for (const r of results) if (r.n === 1) out.set(r.post_id, { accountId: r.account_id, total: r.total });
  return out;
}
