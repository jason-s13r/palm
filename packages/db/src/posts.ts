const now = () => Math.floor(Date.now() / 1000);

export type Visibility = "public" | "unlisted" | "private" | "direct";

/** A post written on this server. Its ActivityPub ID is urls.object(domain, String(id)). */
export interface Post {
  id: number;
  accountId: number;
  contentSource: string;
  contentHtml: string;
  spoilerText: string;
  sensitive: boolean;
  visibility: Visibility;
  language: string | null;
  inReplyTo: string | null;
  createdAt: number;
}

interface PostRow {
  id: number;
  account_id: number;
  content_source: string;
  content_html: string;
  spoiler_text: string;
  sensitive: number;
  visibility: Visibility;
  language: string | null;
  in_reply_to: string | null;
  created_at: number;
}

const toPost = (r: PostRow): Post => ({
  id: r.id,
  accountId: r.account_id,
  contentSource: r.content_source,
  contentHtml: r.content_html,
  spoilerText: r.spoiler_text,
  sensitive: r.sensitive === 1,
  visibility: r.visibility,
  language: r.language,
  inReplyTo: r.in_reply_to,
  createdAt: r.created_at,
});

export async function createPost(
  db: D1Database,
  post: Omit<Post, "id" | "createdAt">,
): Promise<Post> {
  const row = await db
    .prepare(
      `INSERT INTO posts (account_id, content_source, content_html, spoiler_text, sensitive, visibility, language, in_reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(
      post.accountId,
      post.contentSource,
      post.contentHtml,
      post.spoilerText,
      post.sensitive ? 1 : 0,
      post.visibility,
      post.language,
      post.inReplyTo,
      now(),
    )
    .first<PostRow>();
  if (!row) throw new Error("Post was not created.");
  return toPost(row);
}

export async function postById(db: D1Database, id: number): Promise<Post | null> {
  const row = await db.prepare("SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL").bind(id).first<PostRow>();
  return row ? toPost(row) : null;
}

/** Soft-deletes a post, so its ID is never reused and can still answer as Tombstone. */
export async function deletePost(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE posts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").bind(now(), id).run();
}

export interface Page {
  /** Return posts with IDs below this one (older). */
  maxId?: number | undefined;
  /** Return posts with IDs above this one (newer). */
  minId?: number | undefined;
  limit: number;
}

function pageClause(page: Page): { sql: string; params: number[] } {
  const parts: string[] = [];
  const params: number[] = [];
  if (page.maxId !== undefined) {
    parts.push("id < ?");
    params.push(page.maxId);
  }
  if (page.minId !== undefined) {
    parts.push("id > ?");
    params.push(page.minId);
  }
  return { sql: parts.map((p) => ` AND ${p}`).join(""), params };
}

/** An account's posts, newest first. `visibilities` limits what a viewer may see. */
export async function postsByAccount(
  db: D1Database,
  accountId: number,
  visibilities: Visibility[],
  page: Page,
): Promise<Post[]> {
  const { sql, params } = pageClause(page);
  const { results } = await db
    .prepare(
      `SELECT * FROM posts WHERE account_id = ? AND deleted_at IS NULL AND visibility IN (${visibilities.map(() => "?").join(", ")})${sql}
       ORDER BY id DESC LIMIT ?`,
    )
    .bind(accountId, ...visibilities, ...params, page.limit)
    .all<PostRow>();
  return results.map(toPost);
}

/** Public posts from every local account on a domain, newest first. */
export async function localPublicPosts(db: D1Database, domain: string, page: Page): Promise<Post[]> {
  const { sql, params } = pageClause(page);
  const { results } = await db
    .prepare(
      `SELECT p.* FROM posts p JOIN accounts a ON a.id = p.account_id
       WHERE a.domain = ? AND p.deleted_at IS NULL AND p.visibility = 'public'${sql.replaceAll("id ", "p.id ")}
       ORDER BY p.id DESC LIMIT ?`,
    )
    .bind(domain, ...params, page.limit)
    .all<PostRow>();
  return results.map(toPost);
}

export async function countPosts(db: D1Database, accountId: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND deleted_at IS NULL AND visibility IN ('public', 'unlisted')")
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function lastPostAt(db: D1Database, accountId: number): Promise<number | null> {
  const row = await db
    .prepare("SELECT MAX(created_at) AS t FROM posts WHERE account_id = ? AND deleted_at IS NULL")
    .bind(accountId)
    .first<{ t: number | null }>();
  return row?.t ?? null;
}

/** Public and unlisted posts on a domain, for nodeinfo. */
export async function countLocalPosts(db: D1Database, domain: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM posts p JOIN accounts a ON a.id = p.account_id WHERE a.domain = ? AND p.deleted_at IS NULL AND p.visibility IN ('public', 'unlisted')",
    )
    .bind(domain)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Local replies to a post, by its ActivityPub ID, oldest first. */
export async function repliesTo(db: D1Database, apId: string, limit = 60): Promise<Post[]> {
  const { results } = await db
    .prepare("SELECT * FROM posts WHERE in_reply_to = ? AND deleted_at IS NULL ORDER BY id LIMIT ?")
    .bind(apId, limit)
    .all<PostRow>();
  return results.map(toPost);
}
