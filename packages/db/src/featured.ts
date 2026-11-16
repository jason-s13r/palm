import { toPost, type Post, type PostRow } from "./posts.ts";

const now = () => Math.floor(Date.now() / 1000);

/** Mastodon lets a person pin up to five posts to their profile. */
export const MAX_PINS = 5;

export async function pinPost(db: D1Database, accountId: number, postId: number): Promise<boolean> {
  const count = await db.prepare("SELECT COUNT(*) AS n FROM pinned_posts WHERE account_id = ?").bind(accountId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PINS) return false;
  await db.prepare("INSERT OR IGNORE INTO pinned_posts (account_id, post_id, created_at) VALUES (?, ?, ?)").bind(accountId, postId, now()).run();
  return true;
}

export async function unpinPost(db: D1Database, accountId: number, postId: number): Promise<void> {
  await db.prepare("DELETE FROM pinned_posts WHERE account_id = ? AND post_id = ?").bind(accountId, postId).run();
}

export async function pinnedPosts(db: D1Database, accountId: number): Promise<Post[]> {
  const { results } = await db
    .prepare(
      `SELECT p.* FROM pinned_posts k JOIN posts p ON p.id = k.post_id
       WHERE k.account_id = ? AND p.deleted_at IS NULL ORDER BY k.created_at DESC`,
    )
    .bind(accountId)
    .all<PostRow>();
  return results.map(toPost);
}

export async function pinnedIds(db: D1Database, postIds: number[]): Promise<Set<number>> {
  const unique = [...new Set(postIds)];
  if (!unique.length) return new Set();
  const { results } = await db
    .prepare(`SELECT post_id FROM pinned_posts WHERE post_id IN (${unique.map(() => "?").join(", ")})`)
    .bind(...unique)
    .all<{ post_id: number }>();
  return new Set(results.map((r) => r.post_id));
}

export interface FeaturedTag {
  id: number;
  tag: string;
  statuses: number;
  lastStatusAt: number | null;
}

export async function featuredTags(db: D1Database, accountId: number): Promise<FeaturedTag[]> {
  const { results } = await db
    .prepare(
      `SELECT f.id, f.tag,
         (SELECT COUNT(*) FROM post_tags t JOIN posts p ON p.id = t.post_id WHERE t.tag = f.tag AND p.account_id = f.account_id AND p.deleted_at IS NULL) AS statuses,
         (SELECT MAX(p.created_at) FROM post_tags t JOIN posts p ON p.id = t.post_id WHERE t.tag = f.tag AND p.account_id = f.account_id AND p.deleted_at IS NULL) AS last_at
       FROM featured_tags f WHERE f.account_id = ? ORDER BY f.created_at`,
    )
    .bind(accountId)
    .all<{ id: number; tag: string; statuses: number; last_at: number | null }>();
  return results.map((r) => ({ id: r.id, tag: r.tag, statuses: r.statuses, lastStatusAt: r.last_at }));
}

export async function featureTag(db: D1Database, accountId: number, tag: string): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO featured_tags (account_id, tag, created_at) VALUES (?, ?, ?)").bind(accountId, tag.replace(/^#/, "").toLowerCase(), now()).run();
}

export async function unfeatureTag(db: D1Database, accountId: number, id: number): Promise<void> {
  await db.prepare("DELETE FROM featured_tags WHERE account_id = ? AND id = ?").bind(accountId, id).run();
}

/** The hashtags someone uses most, as suggestions to feature. */
export async function usedTags(db: D1Database, accountId: number, limit = 10): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT t.tag FROM post_tags t JOIN posts p ON p.id = t.post_id WHERE p.account_id = ? AND p.deleted_at IS NULL
       GROUP BY t.tag ORDER BY COUNT(*) DESC LIMIT ?`,
    )
    .bind(accountId, limit)
    .all<{ tag: string }>();
  return results.map((r) => r.tag);
}
