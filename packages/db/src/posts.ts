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
  /** Set for remote posts: their ActivityPub ID. A local post's is urls.object. */
  apId: string | null;
  /** A remote post's web page. */
  url: string | null;
  /** A remote post's attachments, as they were sent. Local posts use the media table. */
  attachments: RemoteAttachment[];
  /**
   * Set when this row is a boost: the post it boosts. Boosts are rows of
   * their own, as Mastodon keeps them, so they sort and page with posts.
   */
  reblogOf: number | null;
}

/** A remote post's image or other file, kept as a link to where it lives. */
export interface RemoteAttachment {
  url: string;
  mediaType: string | null;
  description: string | null;
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
  ap_id: string | null;
  url: string | null;
  attachments: string | null;
  reblog_of?: number | null;
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
  apId: r.ap_id ?? null,
  url: r.url ?? null,
  attachments: r.attachments ? (JSON.parse(r.attachments) as RemoteAttachment[]) : [],
  reblogOf: r.reblog_of ?? null,
});

export type { PostRow };

/** What a new post needs; the thread fields default to a plain status. */
export type NewPost = Omit<
  Post,
  "id" | "createdAt" | "updatedAt" | "communityId" | "title" | "linkUrl" | "rootId" | "parentId" | "path" | "apId" | "url" | "attachments" | "reblogOf"
> &
  Partial<Pick<Post, "communityId" | "title" | "linkUrl" | "rootId" | "parentId" | "apId" | "url" | "createdAt" | "updatedAt" | "attachments">>;

export async function createPost(db: D1Database, post: NewPost): Promise<Post> {
  const row = await db
    .prepare(
      `INSERT INTO posts (account_id, content_source, content_html, spoiler_text, sensitive, visibility, language, in_reply_to,
                          community_id, title, link_url, root_id, parent_id, created_at, ap_id, url, updated_at, attachments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
      post.createdAt ?? now(),
      post.apId ?? null,
      post.url ?? null,
      post.updatedAt ?? null,
      post.attachments?.length ? JSON.stringify(post.attachments) : null,
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

export async function postByApId(db: D1Database, apId: string): Promise<Post | null> {
  const row = await db.prepare("SELECT * FROM posts WHERE ap_id = ? AND deleted_at IS NULL").bind(apId).first<PostRow>();
  return row ? toPost(row) : null;
}

/** Any post, local or remote, by its ActivityPub ID (local ones by their /objects/ URL). */
export async function postByUri(db: D1Database, uri: string, localDomains: string[]): Promise<Post | null> {
  for (const domain of localDomains) {
    const prefix = `https://${domain}/objects/`;
    if (uri.startsWith(prefix)) {
      const id = uri.slice(prefix.length);
      return /^\d+$/.test(id) ? postById(db, Number(id)) : null;
    }
  }
  return postByApId(db, uri);
}

/** Replaces a remote post's content after an Update. */
export async function updateRemotePost(
  db: D1Database,
  id: number,
  edit: { contentHtml: string; contentSource: string; title: string | null; spoilerText: string; sensitive: boolean; linkUrl: string | null },
): Promise<void> {
  await db
    .prepare(
      "UPDATE posts SET content_html = ?, content_source = ?, title = ?, spoiler_text = ?, sensitive = ?, link_url = ?, updated_at = ? WHERE id = ?",
    )
    .bind(edit.contentHtml, edit.contentSource, edit.title, edit.spoilerText, edit.sensitive ? 1 : 0, edit.linkUrl, now(), id)
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

/** The paging clause with numbered parameters from ?start, for queries that use ?1. */
function pageSql(page: Page, start: number): string {
  const parts: string[] = [];
  if (page.maxId !== undefined) parts.push(`AND p.id < ?${start + parts.length}`);
  if (page.minId !== undefined) parts.push(`AND p.id > ?${start + parts.length}`);
  return parts.join(" ");
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
       WHERE a.domain = ? AND p.deleted_at IS NULL AND p.visibility = 'public' AND p.reblog_of IS NULL${sql.replaceAll("id ", "p.id ")}
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

/**
 * The home timeline: the account's own posts and those of everyone it
 * follows, newest first. Followers-only posts show to followers; direct posts
 * only where the account is the author or is mentioned. Lemmy comments stay in
 * their threads.
 */
export async function homeTimeline(db: D1Database, accountId: number, page: Page): Promise<Post[]> {
  const { params } = pageClause(page);
  const { results } = await db
    .prepare(
      `SELECT p.* FROM posts p
       WHERE p.deleted_at IS NULL AND p.root_id IS NULL
         AND (p.account_id = ?1
              OR (p.visibility IN ('public', 'unlisted', 'private')
                  AND p.account_id IN (SELECT target_id FROM account_follows WHERE account_id = ?1 AND state = 'accepted'))
              OR EXISTS (SELECT 1 FROM mentions m WHERE m.post_id = p.id AND m.account_id = ?1))
         ${pageSql(page, 2)}
       ORDER BY p.id DESC LIMIT ?${2 + params.length}`,
    )
    .bind(accountId, ...params, page.limit)
    .all<PostRow>();
  return results.map(toPost);
}

/** Public posts palm knows, newest first: this domain's only, or everything it has. */
export async function publicTimeline(db: D1Database, scope: { local: boolean; domain: string }, page: Page): Promise<Post[]> {
  const { sql, params } = pageClause(page);
  const { results } = await db
    .prepare(
      `SELECT p.* FROM posts p JOIN accounts a ON a.id = p.account_id
       WHERE p.deleted_at IS NULL AND p.visibility = 'public' AND p.root_id IS NULL AND p.reblog_of IS NULL
         AND ${scope.local ? "a.ap_id IS NULL AND a.domain = ?" : "(a.ap_id IS NOT NULL OR a.domain = ?)"}
         ${sql.replaceAll("id ", "p.id ")}
       ORDER BY p.id DESC LIMIT ?`,
    )
    .bind(scope.domain, ...params, page.limit)
    .all<PostRow>();
  return results.map(toPost);
}

/** Posts an account bookmarked or favourited, newest first. */
export async function postsMarkedBy(db: D1Database, accountId: number, mark: "bookmarks" | "favourites", page: Page): Promise<Post[]> {
  const { sql, params } = pageClause(page);
  const marked =
    mark === "bookmarks"
      ? "EXISTS (SELECT 1 FROM bookmarks k WHERE k.post_id = p.id AND k.account_id = ?)"
      : "EXISTS (SELECT 1 FROM votes v WHERE v.post_id = p.id AND v.account_id = ? AND v.score = 1)";
  const { results } = await db
    .prepare(`SELECT p.* FROM posts p WHERE p.deleted_at IS NULL AND ${marked}${sql.replaceAll("id ", "p.id ")} ORDER BY p.id DESC LIMIT ?`)
    .bind(accountId, ...params, page.limit)
    .all<PostRow>();
  return results.map(toPost);
}

/** Posts by ID, in no particular order; deleted ones left out. */
export async function postsByIds(db: D1Database, ids: number[]): Promise<Map<number, Post>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const { results } = await db
    .prepare(`SELECT * FROM posts WHERE deleted_at IS NULL AND id IN (${unique.map(() => "?").join(", ")})`)
    .bind(...unique)
    .all<PostRow>();
  return new Map(results.map((r) => [r.id, toPost(r)]));
}

/** Hashtags, lowercased and without the #, are how palm finds posts by tag. */
export async function addTags(db: D1Database, postId: number, tags: string[]): Promise<void> {
  const unique = [...new Set(tags.map((t) => t.replace(/^#/, "").toLowerCase()).filter(Boolean))].slice(0, 20);
  if (!unique.length) return;
  await db.batch(unique.map((tag) => db.prepare("INSERT INTO post_tags (post_id, tag) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(postId, tag)));
}

export async function tagsFor(db: D1Database, postIds: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const unique = [...new Set(postIds)];
  if (!unique.length) return out;
  const { results } = await db
    .prepare(`SELECT post_id, tag FROM post_tags WHERE post_id IN (${unique.map(() => "?").join(", ")})`)
    .bind(...unique)
    .all<{ post_id: number; tag: string }>();
  for (const r of results) out.set(r.post_id, [...(out.get(r.post_id) ?? []), r.tag]);
  return out;
}

/** Public posts with a hashtag, newest first. */
export async function postsTagged(db: D1Database, tag: string, page: Page): Promise<Post[]> {
  const { sql, params } = pageClause(page);
  const { results } = await db
    .prepare(
      `SELECT p.* FROM posts p JOIN post_tags t ON t.post_id = p.id
       WHERE t.tag = ? AND p.deleted_at IS NULL AND p.visibility = 'public'${sql.replaceAll("id ", "p.id ")}
       ORDER BY p.id DESC LIMIT ?`,
    )
    .bind(tag.replace(/^#/, "").toLowerCase(), ...params, page.limit)
    .all<PostRow>();
  return results.map(toPost);
}

/** Hashtags palm has seen that start with this, most used first, for search. */
export async function searchTags(db: D1Database, prefix: string, limit = 10): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT tag FROM post_tags WHERE tag LIKE ? GROUP BY tag ORDER BY COUNT(*) DESC LIMIT ?")
    .bind(`${prefix.replace(/^#/, "").toLowerCase()}%`, limit)
    .all<{ tag: string }>();
  return results.map((r) => r.tag);
}

/**
 * Claims a remote thread for refreshing: true if nobody has refreshed it in
 * the last `ttlSeconds`, and marks it refreshed now.
 */
export async function claimThreadRefresh(db: D1Database, postId: number, ttlSeconds: number): Promise<boolean> {
  const result = await db
    .prepare("UPDATE posts SET thread_fetched_at = ? WHERE id = ? AND (thread_fetched_at IS NULL OR thread_fetched_at < ?)")
    .bind(now(), postId, now() - ttlSeconds)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
