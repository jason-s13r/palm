import { toPost, type Post, type PostRow } from "./posts.ts";

const now = () => Math.floor(Date.now() / 1000);

/** Votes and counts that go with a Lemmy post or comment. */
export interface Tally {
  upvotes: number;
  downvotes: number;
  /** The viewer's vote: 1, -1 or 0. */
  myVote: number;
  /** Whether the viewer saved (bookmarked) it. */
  saved: boolean;
}

export interface ThreadPost extends Post, Tally {
  comments: number;
  /** When the post or its newest comment was written. */
  activeAt: number;
}

export interface ThreadComment extends Post, Tally {
  deleted: boolean;
  /** Comments below this one. */
  childCount: number;
}

type TallyRow = { upvotes: number; downvotes: number; my_vote: number | null; saved: number };

const TALLY = `
  (SELECT COUNT(*) FROM votes v WHERE v.post_id = p.id AND v.score = 1) AS upvotes,
  (SELECT COUNT(*) FROM votes v WHERE v.post_id = p.id AND v.score = -1) AS downvotes,
  (SELECT score FROM votes v WHERE v.post_id = p.id AND v.account_id = ?1) AS my_vote,
  EXISTS (SELECT 1 FROM bookmarks k WHERE k.post_id = p.id AND k.account_id = ?1) AS saved`;

const tally = (r: TallyRow): Tally => ({ upvotes: r.upvotes, downvotes: r.downvotes, myVote: r.my_vote ?? 0, saved: r.saved === 1 });

/** Lemmy's sorts, reduced to what palm can order by. */
export type ThreadSort = "new" | "old" | "top" | "active" | "comments";

export function threadSort(sort: string | undefined): ThreadSort {
  if (!sort) return "active";
  if (sort === "New") return "new";
  if (sort === "Old") return "old";
  if (sort.startsWith("Top") || sort === "Controversial") return "top";
  if (sort === "MostComments") return "comments";
  return "active";
}

/** "local" is this domain's communities; "all" adds the remote ones palm knows. */
export type Scope = "local" | "all";

const scopeSql = (scope: Scope | undefined) =>
  scope === "local" ? "c.domain = ?2 AND c.ap_id IS NULL" : "(c.ap_id IS NOT NULL OR c.domain = ?2)";

export interface PostListing {
  domain: string;
  scope?: Scope | undefined;
  communityId?: number | undefined;
  /** Only posts in communities this account subscribes to. */
  subscribedBy?: number | undefined;
  creatorId?: number | undefined;
  ids?: number[] | undefined;
  /** Only posts this account saved. */
  savedBy?: number | undefined;
  /** Only posts this account voted on: 1 upvoted, -1 downvoted. */
  votedBy?: { accountId: number; score: number } | undefined;
  /** Title or body contains this. */
  query?: string | undefined;
  sort: ThreadSort;
  viewerId: number | null;
  limit: number;
  offset: number;
}

/** Lemmy posts (a title, in a community), with their counts. */
export async function listThreadPosts(db: D1Database, listing: PostListing): Promise<ThreadPost[]> {
  const where = ["p.root_id IS NULL", "p.community_id IS NOT NULL", "p.deleted_at IS NULL", scopeSql(listing.scope)];
  const params: (string | number)[] = [];
  // ?1 is the viewer and ?2 the domain; the filters number from ?3.
  const bind = (sql: string, ...values: (string | number)[]) => {
    let next = 3 + params.length;
    params.push(...values);
    where.push(sql.replace(/\?/g, () => `?${next++}`));
  };
  if (listing.communityId !== undefined) bind("p.community_id = ?", listing.communityId);
  if (listing.subscribedBy !== undefined) {
    bind("EXISTS (SELECT 1 FROM community_subscriptions s WHERE s.community_id = p.community_id AND s.account_id = ?)", listing.subscribedBy);
  }
  if (listing.creatorId !== undefined) bind("p.account_id = ?", listing.creatorId);
  if (listing.savedBy !== undefined) bind("EXISTS (SELECT 1 FROM bookmarks k WHERE k.post_id = p.id AND k.account_id = ?)", listing.savedBy);
  if (listing.votedBy) bind("EXISTS (SELECT 1 FROM votes v WHERE v.post_id = p.id AND v.account_id = ? AND v.score = ?)", listing.votedBy.accountId, listing.votedBy.score);
  if (listing.query) bind("(p.title LIKE ? OR p.content_source LIKE ?)", `%${listing.query}%`, `%${listing.query}%`);
  if (listing.ids) {
    if (!listing.ids.length) return [];
    bind(`p.id IN (${listing.ids.map(() => "?").join(", ")})`, ...listing.ids);
  }
  const order = {
    new: "p.id DESC",
    old: "p.id ASC",
    top: "(upvotes - downvotes) DESC, p.id DESC",
    comments: "comment_count DESC, p.id DESC",
    active: "active_at DESC, p.id DESC",
  }[listing.sort];
  const limitAt = 3 + params.length;
  const { results } = await db
    .prepare(
      `SELECT p.*, ${TALLY},
         (SELECT COUNT(*) FROM posts x WHERE x.root_id = p.id AND x.deleted_at IS NULL) AS comment_count,
         COALESCE((SELECT MAX(x.created_at) FROM posts x WHERE x.root_id = p.id AND x.deleted_at IS NULL), p.created_at) AS active_at
       FROM posts p JOIN communities c ON c.id = p.community_id
       WHERE ${where.join(" AND ")}
       ORDER BY ${order} LIMIT ?${limitAt} OFFSET ?${limitAt + 1}`,
    )
    .bind(listing.viewerId ?? -1, listing.domain, ...params, listing.limit, listing.offset)
    .all<PostRow & TallyRow & { comment_count: number; active_at: number }>();
  return results.map((r) => ({ ...toPost(r), ...tally(r), comments: r.comment_count, activeAt: r.active_at }));
}

export interface CommentListing {
  domain: string;
  scope?: Scope | undefined;
  postId?: number | undefined;
  /** Only comments below this one. */
  parentId?: number | undefined;
  communityId?: number | undefined;
  creatorId?: number | undefined;
  ids?: number[] | undefined;
  /** Only comments this account saved. */
  savedBy?: number | undefined;
  /** How many levels below the post (or the parent) to include. */
  maxDepth?: number | undefined;
  sort: ThreadSort;
  viewerId: number | null;
  limit: number;
  offset: number;
}

/**
 * Lemmy comments, deleted ones included (Lemmy shows them in place so the
 * thread keeps its shape), with their counts.
 */
export async function listThreadComments(db: D1Database, listing: CommentListing): Promise<ThreadComment[]> {
  const where = ["p.root_id IS NOT NULL", scopeSql(listing.scope)];
  const params: (string | number)[] = [];
  // ?1 is the viewer and ?2 the domain; the filters number from ?3.
  const bind = (sql: string, ...values: (string | number)[]) => {
    let next = 3 + params.length;
    params.push(...values);
    where.push(sql.replace(/\?/g, () => `?${next++}`));
  };
  // Depth is the number of dots in the path: "0.5" is a top-level comment.
  const depth = "(LENGTH(p.path) - LENGTH(REPLACE(p.path, '.', '')))";
  if (listing.postId !== undefined) bind("p.root_id = ?", listing.postId);
  if (listing.communityId !== undefined) bind("p.community_id = ?", listing.communityId);
  if (listing.creatorId !== undefined) bind("p.account_id = ? AND p.deleted_at IS NULL", listing.creatorId);
  if (listing.savedBy !== undefined) bind("EXISTS (SELECT 1 FROM bookmarks k WHERE k.post_id = p.id AND k.account_id = ?)", listing.savedBy);
  if (listing.parentId !== undefined) {
    const parent = await db.prepare("SELECT path FROM posts WHERE id = ?").bind(listing.parentId).first<{ path: string | null }>();
    if (!parent?.path) return [];
    bind("p.path LIKE ?", `${parent.path}.%`);
    if (listing.maxDepth !== undefined) {
      bind(`${depth} <= ?`, parent.path.split(".").length - 1 + listing.maxDepth);
    }
  } else if (listing.maxDepth !== undefined) {
    bind(`${depth} <= ?`, listing.maxDepth);
  }
  if (listing.ids) {
    if (!listing.ids.length) return [];
    bind(`p.id IN (${listing.ids.map(() => "?").join(", ")})`, ...listing.ids);
  }
  const order = {
    new: "p.id DESC",
    old: "p.id ASC",
    top: "(upvotes - downvotes) DESC, p.id",
    comments: "child_count DESC, p.id",
    active: "(upvotes - downvotes) DESC, p.id",
  }[listing.sort];
  const limitAt = 3 + params.length;
  const { results } = await db
    .prepare(
      `SELECT p.*, ${TALLY},
         (SELECT COUNT(*) FROM posts x WHERE x.root_id = p.root_id AND x.path LIKE p.path || '.%' AND x.deleted_at IS NULL) AS child_count
       FROM posts p JOIN communities c ON c.id = p.community_id
       WHERE ${where.join(" AND ")}
       ORDER BY ${order} LIMIT ?${limitAt} OFFSET ?${limitAt + 1}`,
    )
    .bind(listing.viewerId ?? -1, listing.domain, ...params, listing.limit, listing.offset)
    .all<PostRow & TallyRow & { child_count: number; deleted_at: number | null }>();
  return results.map((r) => {
    const deleted = r.deleted_at !== null;
    const post = toPost(r);
    // Lemmy blanks deleted comments' text.
    if (deleted) {
      post.contentSource = "";
      post.contentHtml = "";
    }
    return { ...post, ...tally(r), deleted, childCount: r.child_count };
  });
}

/** An account's current vote on a post: 1, -1 or 0. */
export async function currentVote(db: D1Database, postId: number, accountId: number): Promise<number> {
  const row = await db.prepare("SELECT score FROM votes WHERE post_id = ? AND account_id = ?").bind(postId, accountId).first<{ score: number }>();
  return row?.score ?? 0;
}

/** Sets an account's vote on a post or comment: 1, -1, or 0 to take it back. */
export async function vote(db: D1Database, postId: number, accountId: number, score: number): Promise<void> {
  if (score === 0) {
    await db.prepare("DELETE FROM votes WHERE post_id = ? AND account_id = ?").bind(postId, accountId).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO votes (post_id, account_id, score, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (post_id, account_id) DO UPDATE SET score = excluded.score`,
    )
    .bind(postId, accountId, score > 0 ? 1 : -1, now())
    .run();
}

/** Lemmy counts for a person's profile. */
export async function threadCounts(db: D1Database, accountId: number): Promise<{ posts: number; comments: number }> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM posts WHERE account_id = ?1 AND community_id IS NOT NULL AND root_id IS NULL AND deleted_at IS NULL) AS posts,
         (SELECT COUNT(*) FROM posts WHERE account_id = ?1 AND root_id IS NOT NULL AND deleted_at IS NULL) AS comments`,
    )
    .bind(accountId)
    .first<{ posts: number; comments: number }>();
  return { posts: row?.posts ?? 0, comments: row?.comments ?? 0 };
}

/** Site-wide Lemmy counts for a domain. */
export async function siteCounts(db: D1Database, domain: string): Promise<{ posts: number; comments: number; communities: number }> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM posts p JOIN communities c ON c.id = p.community_id WHERE c.domain = ?1 AND c.ap_id IS NULL AND p.root_id IS NULL AND p.deleted_at IS NULL) AS posts,
         (SELECT COUNT(*) FROM posts p JOIN communities c ON c.id = p.community_id WHERE c.domain = ?1 AND c.ap_id IS NULL AND p.root_id IS NOT NULL AND p.deleted_at IS NULL) AS comments,
         (SELECT COUNT(*) FROM communities WHERE domain = ?1 AND ap_id IS NULL) AS communities`,
    )
    .bind(domain)
    .first<{ posts: number; comments: number; communities: number }>();
  return { posts: row?.posts ?? 0, comments: row?.comments ?? 0, communities: row?.communities ?? 0 };
}
