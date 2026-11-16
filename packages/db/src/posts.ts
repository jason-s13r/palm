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
  /** The community a Lemmy post or comment belongs to. */
  communityId: number | null;
  /** A Lemmy post's title; null for comments and plain statuses. */
  title: string | null;
  /** A Lemmy link post's link. */
  linkUrl: string | null;
  /** For a comment, the Lemmy post it's on. */
  rootId: number | null;
  /** For a comment, the local post or comment it answers. */
  parentId: number | null;
  /** For a comment, Lemmy's path: "0", then each comment ID down to this one. */
  path: string | null;
  createdAt: number;
  updatedAt: number | null;
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
  community_id: number | null;
  title: string | null;
  link_url: string | null;
  root_id: number | null;
  parent_id: number | null;
  path: string | null;
  created_at: number;
  updated_at: number | null;
}

export const toPost = (r: PostRow): Post => ({
  id: r.id,
  accountId: r.account_id,
  contentSource: r.content_source,
  contentHtml: r.content_html,
  spoilerText: r.spoiler_text,
  sensitive: r.sensitive === 1,
  visibility: r.visibility,
  language: r.language,
  inReplyTo: r.in_reply_to,
  communityId: r.community_id ?? null,
  title: r.title ?? null,
  linkUrl: r.link_url ?? null,
  rootId: r.root_id ?? null,
  parentId: r.parent_id ?? null,
  path: r.path ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at ?? null,
});

export type { PostRow };

/** What a new post needs; the thread fields default to a plain status. */
export type NewPost = Omit<Post, "id" | "createdAt" | "updatedAt" | "communityId" | "title" | "linkUrl" | "rootId" | "parentId" | "path"> &
  Partial<Pick<Post, "communityId" | "title" | "linkUrl" | "rootId" | "parentId">>;

export async function createPost(db: D1Database, post: NewPost): Promise<Post> {
  const row = await db
    .prepare(
      `INSERT INTO posts (account_id, content_source, content_html, spoiler_text, sensitive, visibility, language, in_reply_to,
                          community_id, title, link_url, root_id, parent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
      post.communityId ?? null,
      post.title ?? null,
      post.linkUrl ?? null,
      post.rootId ?? null,
      post.parentId ?? null,
      now(),
    )
    .first<PostRow>();
  if (!row) throw new Error("Post was not created.");
  if (row.root_id === null) return toPost(row);
  // A comment's path is its parent's path (or "0" under the post) plus its own ID.
  const parent = row.parent_id !== null && row.parent_id !== row.root_id ? await postById(db, row.parent_id) : null;
  const path = `${parent?.path ?? "0"}.${row.id}`;
  await db.prepare("UPDATE posts SET path = ? WHERE id = ?").bind(path, row.id).run();
  return toPost({ ...row, path });
}

/** Changes a post's text (and a Lemmy post's title and link). */
export async function editPost(
  db: D1Database,
  id: number,
  edit: { contentSource: string; contentHtml: string; title?: string | null; linkUrl?: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE posts SET content_source = ?, content_html = ?, title = COALESCE(?, title), link_url = COALESCE(?, link_url), updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(edit.contentSource, edit.contentHtml, edit.title ?? null, edit.linkUrl ?? null, now(), id)
    .run();
}

/** A post, deleted or not, for Lemmy, which shows deleted comments in place. */
export async function postByIdAny(db: D1Database, id: number): Promise<(Post & { deleted: boolean }) | null> {
  const row = await db.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<PostRow & { deleted_at: number | null }>();
  return row ? { ...toPost(row), deleted: row.deleted_at !== null } : null;
}

export async function postById(db: D1Database, id: number): Promise<Post | null> {
  const row = await db.prepare("SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL").bind(id).first<PostRow>();
  return row ? toPost(row) : null;
}

/** Soft-deletes a post, so its ID is never reused and can still answer as Tombstone. */
export async function deletePost(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE posts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").bind(now(), id).run();
}

/** Undoes a delete, as Lemmy's "restore" does. */
export async function restorePost(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE posts SET deleted_at = NULL WHERE id = ?").bind(id).run();
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
