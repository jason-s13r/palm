import { textToHtml, urls, type RequestContext } from "@palm/core";
import {
  accountById,
  accountsByIds,
  attachMedia,
  bookmark,
  communitiesByIds,
  communityById,
  communityByName,
  createPost,
  currentVote,
  deletePost,
  editPost,
  listCommunities,
  listThreadComments,
  hasLocalSubscribers,
  listThreadPosts,
  mediaById,
  postByIdAny,
  restorePost,
  subscribe,
  subscription,
  subscriptions,
  threadSort,
  unbookmark,
  unsubscribe,
  vote,
  type Account,
  type Community,
  type ThreadComment,
  type ThreadPost,
} from "@palm/db";
import { Hono, type Context } from "hono";
import type {
  CommentResponse,
  CommunityResponse,
  GetCommentsResponse,
  GetCommunityResponse,
  GetPostResponse,
  GetPostsResponse,
  ListCommunitiesResponse,
  PostResponse,
  SuccessResponse,
} from "lemmy-js-client";
import { commentView, communityView, personView, postView, type ThreadContext } from "./views.ts";

/**
 * Communities, posts, comments and votes: Lemmy's side of palm's posts. A
 * Lemmy post is a post with a title in a community; a comment is a post with
 * a root (the Lemmy post) and a path. Mastodon apps see both as statuses.
 */

interface Auth {
  account: Account;
  sessionId: string;
}

type Env = { Bindings: RequestContext; Variables: { auth: Auth | null } };
type C = Context<Env>;

const fail = (c: C, error: string, status: 400 | 401 | 404 = 400) => c.json({ error }, status);

export const MAX_TITLE = 200;
export const MAX_BODY = 50_000;

/** A JSON body, or nothing. */
const body = async (c: C) => (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>;

const int = (value: unknown): number | undefined => {
  const n = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) ? n : undefined;
};
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const bool = (value: unknown) => value === true || value === "true";

/** Lemmy's page and limit, or the cursor palm hands out as next_page ("o20" is offset 20). */
function paging(c: C, defaultLimit: number, maxLimit: number) {
  const limit = Math.min(Math.max(int(c.req.query("limit")) ?? defaultLimit, 1), maxLimit);
  const cursor = c.req.query("page_cursor");
  const fromCursor = cursor && /^o\d+$/.test(cursor) ? Number(cursor.slice(1)) : undefined;
  const page = Math.max(int(c.req.query("page")) ?? 1, 1);
  return { limit, offset: fromCursor ?? (page - 1) * limit };
}

/**
 * A community by name: "sandbox", "!sandbox", "sandbox@this.domain", or a
 * remote one, "rust@lemmy.ml", which palm fetches the first time it's asked.
 */
async function communityNamed(c: C, name: string): Promise<Community | null> {
  const [local, rawHost] = name.replace(/^!/, "").split("@");
  if (!local) return null;
  const host = rawHost?.toLowerCase() ?? c.env.domain.domain;
  const db = c.env.bindings.DB;
  const known = await communityByName(db, host, local);
  if (known && (known.apId !== null || host === c.env.domain.domain)) return known;
  if (host === c.env.domain.domain) return null;
  const found = await c.env.activities.resolve(`!${local}@${host}`);
  return found?.kind === "community" ? communityById(db, found.id) : null;
}

/** A community this domain can show: its own, or a remote one palm knows. */
const visible = (c: C, community: Community | null) =>
  community && (community.apId !== null || community.domain === c.env.domain.domain) ? community : null;

async function communityFor(c: C, id: number | undefined, name: string | undefined): Promise<Community | null | undefined> {
  if (id !== undefined) return visible(c, await communityById(c.env.bindings.DB, id));
  if (name) return communityNamed(c, name);
  return undefined;
}

/** Lemmy's listing types: Local is this domain's communities; All and Subscribed take in remote ones. */
const scopeOf = (type: string | undefined) => (type === "Local" ? ("local" as const) : ("all" as const));

/** Looks up the people, communities and subscriptions a set of views needs, once each. */
async function contextFor(c: C, items: { accountId: number; communityId: number | null }[]) {
  const db = c.env.bindings.DB;
  const viewer = c.get("auth")?.account ?? null;
  const [byId, communities, subscribed] = await Promise.all([
    accountsByIds(db, items.map((i) => i.accountId)),
    communitiesByIds(db, items.map((i) => i.communityId ?? 0)),
    viewer ? subscriptions(db, viewer.id) : Promise.resolve([]),
  ]);
  const states = new Map(subscribed.map((s) => [s.id, s.pending]));
  return (item: { accountId: number; communityId: number | null }): ThreadContext | null => {
    const creator = byId.get(item.accountId);
    const community = communities.get(item.communityId ?? 0);
    if (!creator || !community) return null;
    const pending = states.get(community.id);
    return { creator, community, subscribed: pending === false, pending: pending === true };
  };
}

async function postViews(c: C, posts: ThreadPost[]) {
  const ctxOf = await contextFor(c, posts);
  return posts.flatMap((p) => {
    const t = ctxOf(p);
    return t ? [postView(c.env, p, t)] : [];
  });
}

async function commentViews(c: C, comments: ThreadComment[]) {
  const roots = await listThreadPosts(c.env.bindings.DB, {
    domain: c.env.domain.domain,
    scope: "all",
    ids: [...new Set(comments.map((x) => x.rootId ?? 0))],
    sort: "new",
    viewerId: c.get("auth")?.account.id ?? null,
    limit: 1000,
    offset: 0,
  });
  const rootById = new Map(roots.map((r) => [r.id, r]));
  const ctxOf = await contextFor(c, comments);
  return comments.flatMap((x) => {
    const t = ctxOf(x);
    const root = rootById.get(x.rootId ?? 0);
    return t && root ? [commentView(c.env, x, root, t)] : [];
  });
}

/** One Lemmy post as the viewer sees it, or null. */
async function threadPost(c: C, id: number): Promise<ThreadPost | null> {
  const [found] = await listThreadPosts(c.env.bindings.DB, {
    domain: c.env.domain.domain,
    scope: "all",
    ids: [id],
    sort: "new",
    viewerId: c.get("auth")?.account.id ?? null,
    limit: 1,
    offset: 0,
  });
  return found ?? null;
}

async function threadComment(c: C, id: number): Promise<ThreadComment | null> {
  const [found] = await listThreadComments(c.env.bindings.DB, {
    domain: c.env.domain.domain,
    scope: "all",
    ids: [id],
    sort: "new",
    viewerId: c.get("auth")?.account.id ?? null,
    limit: 1,
    offset: 0,
  });
  return found ?? null;
}

async function postResponse(c: C, id: number) {
  const found = await threadPost(c, id);
  const [view] = found ? await postViews(c, [found]) : [];
  return view ? c.json({ post_view: view } satisfies PostResponse) : fail(c, "couldnt_find_post", 404);
}

async function commentResponse(c: C, id: number) {
  const found = await threadComment(c, id);
  const [view] = found ? await commentViews(c, [found]) : [];
  return view ? c.json({ comment_view: view, recipient_ids: [] } satisfies CommentResponse) : fail(c, "couldnt_find_comment", 404);
}

async function communityStats(c: C, community: Community) {
  const viewer = c.get("auth")?.account.id ?? null;
  const [found] = await listCommunities(c.env.bindings.DB, {
    domain: c.env.domain.domain,
    scope: "all",
    ids: [community.id],
    viewerId: viewer,
    limit: 1,
    offset: 0,
  });
  return found ?? { ...community, subscribers: 0, posts: 0, comments: 0, subscribed: false, pending: false };
}

/** Records a vote and tells the post's community (or author) about it. */
async function castVote(c: C, postId: number, accountId: number, score: number): Promise<void> {
  const db = c.env.bindings.DB;
  const previous = await currentVote(db, postId, accountId);
  if (previous === score) return;
  await vote(db, postId, accountId, score);
  c.env.activities.enqueue({ kind: "voted", postId, accountId, score, previous });
}

export const threadRoutes = new Hono<Env>();

// --- communities -----------------------------------------------------------

threadRoutes.get("/api/v3/community", async (c) => {
  const community = await communityFor(c, int(c.req.query("id")), c.req.query("name"));
  if (!community) return fail(c, "couldnt_find_community", 404);
  const body: GetCommunityResponse = {
    community_view: communityView(c.env, await communityStats(c, community)),
    moderators: [],
    discussion_languages: [],
  };
  return c.json(body);
});

threadRoutes.get("/api/v3/community/list", async (c) => {
  const viewer = c.get("auth")?.account ?? null;
  const { limit, offset } = paging(c, 20, 50);
  const type = c.req.query("type_");
  if (type === "Subscribed" && !viewer) return c.json({ communities: [] } satisfies ListCommunitiesResponse);
  const found = await listCommunities(c.env.bindings.DB, {
    domain: c.env.domain.domain,
    scope: scopeOf(type),
    subscribedBy: type === "Subscribed" ? viewer?.id : undefined,
    viewerId: viewer?.id ?? null,
    limit,
    offset,
  });
  return c.json({ communities: found.map((x) => communityView(c.env, x)) } satisfies ListCommunitiesResponse);
});

threadRoutes.post("/api/v3/community/follow", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const community = await communityFor(c, int(params.community_id), undefined);
  if (!community) return fail(c, "couldnt_find_community", 404);
  const db = c.env.bindings.DB;
  const existing = await subscription(db, community.id, auth.account.id);
  if (params.follow === false) {
    await unsubscribe(db, community.id, auth.account.id);
    if (community.apId && existing?.followApId) {
      c.env.activities.enqueue({ kind: "subscribed", accountId: auth.account.id, communityId: community.id, followApId: existing.followApId, undo: true });
    }
  } else if (!existing) {
    if (community.apId) {
      // A remote community: ask it, and show "Pending" until it accepts.
      const followApId = `${urls.user(auth.account.domain, auth.account.username)}#follows/c${community.id}-${Date.now()}`;
      const first = !(await hasLocalSubscribers(db, community.id));
      await subscribe(db, community.id, auth.account.id, { followApId });
      c.env.activities.enqueue({ kind: "subscribed", accountId: auth.account.id, communityId: community.id, followApId, undo: false });
      // The first subscriber here gets the community's recent posts to start with.
      if (first) c.env.activities.enqueue({ kind: "backfill", communityId: community.id });
    } else {
      await subscribe(db, community.id, auth.account.id);
    }
  }
  return c.json({ community_view: communityView(c.env, await communityStats(c, community)), discussion_languages: [] } satisfies CommunityResponse);
});

// --- posts -----------------------------------------------------------------

threadRoutes.get("/api/v3/post/list", async (c) => {
  const viewer = c.get("auth")?.account ?? null;
  const { limit, offset } = paging(c, 20, 50);
  const community = await communityFor(c, int(c.req.query("community_id")), c.req.query("community_name"));
  if (community === null) return fail(c, "couldnt_find_community", 404);
  const type = c.req.query("type_");
  const mine = bool(c.req.query("saved_only")) || bool(c.req.query("liked_only")) || bool(c.req.query("disliked_only"));
  if ((mine || (!community && type === "Subscribed")) && !viewer) return c.json({ posts: [] } satisfies GetPostsResponse);
  const posts = await listThreadPosts(c.env.bindings.DB, {
    domain: c.env.domain.domain,
    scope: community ? "all" : scopeOf(type),
    communityId: community?.id,
    savedBy: bool(c.req.query("saved_only")) ? viewer?.id : undefined,
    votedBy:
      viewer && (bool(c.req.query("liked_only")) || bool(c.req.query("disliked_only")))
        ? { accountId: viewer.id, score: bool(c.req.query("liked_only")) ? 1 : -1 }
        : undefined,
    subscribedBy: !community && !mine && type === "Subscribed" ? viewer?.id : undefined,
    sort: threadSort(c.req.query("sort")),
    viewerId: viewer?.id ?? null,
    limit,
    offset,
  });
  const response: GetPostsResponse = { posts: await postViews(c, posts) };
  if (posts.length === limit) response.next_page = `o${offset + limit}`;
  return c.json(response);
});

threadRoutes.get("/api/v3/post", async (c) => {
  let id = int(c.req.query("id"));
  const commentId = int(c.req.query("comment_id"));
  if (id === undefined && commentId !== undefined) id = (await threadComment(c, commentId))?.rootId ?? undefined;
  const found = id === undefined ? null : await threadPost(c, id);
  const [view] = found ? await postViews(c, [found]) : [];
  if (!view) return fail(c, "couldnt_find_post", 404);
  const community = await communityById(c.env.bindings.DB, view.community.id);
  const body: GetPostResponse = {
    post_view: view,
    community_view: communityView(c.env, await communityStats(c, community!)),
    moderators: [],
    cross_posts: [],
  };
  return c.json(body);
});

threadRoutes.post("/api/v3/post", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const community = await communityFor(c, int(params.community_id), undefined);
  if (!community) return fail(c, "couldnt_find_community", 404);
  const title = str(params.name)?.trim() ?? "";
  if (!title || title.length > MAX_TITLE) return fail(c, "invalid_post_title");
  const text = str(params.body)?.trim() ?? "";
  if (text.length > MAX_BODY) return fail(c, "invalid_body_field");
  const link = str(params.url)?.trim() || null;
  if (link && !/^https?:\/\/\S+$/.test(link)) return fail(c, "invalid_url");
  const db = c.env.bindings.DB;
  const created = await createPost(db, {
    accountId: auth.account.id,
    contentSource: text,
    contentHtml: textToHtml(text),
    spoilerText: "",
    sensitive: bool(params.nsfw),
    visibility: "public",
    language: null,
    inReplyTo: null,
    communityId: community.id,
    title,
    linkUrl: link,
  });
  // Lemmy counts your own post as upvoted.
  await vote(db, created.id, auth.account.id, 1);
  // An image uploaded for this post becomes its attachment, so Mastodon apps
  // and other servers show the picture rather than a bare link.
  const uploaded = link?.startsWith(urls.media(c.env.domain.domain, "")) ? await mediaById(db, link.slice(urls.media(c.env.domain.domain, "").length)) : null;
  if (uploaded && uploaded.accountId === auth.account.id) await attachMedia(db, created.id, auth.account.id, [uploaded.id]);
  c.env.activities.enqueue({ kind: "post_created", postId: created.id });
  return postResponse(c, created.id);
});

threadRoutes.put("/api/v3/post", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const found = await threadPost(c, int(params.post_id) ?? -1);
  if (!found || found.accountId !== auth.account.id) return fail(c, "no_post_edit_allowed");
  const title = str(params.name)?.trim();
  if (title !== undefined && (!title || title.length > MAX_TITLE)) return fail(c, "invalid_post_title");
  const text = str(params.body) ?? found.contentSource;
  const link = str(params.url)?.trim();
  if (link && !/^https?:\/\/\S+$/.test(link)) return fail(c, "invalid_url");
  await editPost(c.env.bindings.DB, found.id, { contentSource: text, contentHtml: textToHtml(text), title: title ?? null, linkUrl: link || null });
  c.env.activities.enqueue({ kind: "post_updated", postId: found.id });
  return postResponse(c, found.id);
});

threadRoutes.post("/api/v3/post/delete", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const found = await postByIdAny(c.env.bindings.DB, int(params.post_id) ?? -1);
  if (!found || found.accountId !== auth.account.id || found.communityId === null || found.rootId !== null) {
    return fail(c, "no_post_edit_allowed");
  }
  if (params.deleted === false) {
    await restorePost(c.env.bindings.DB, found.id);
    return postResponse(c, found.id);
  }
  const before = await threadPost(c, found.id);
  const [view] = before ? await postViews(c, [before]) : [];
  await deletePost(c.env.bindings.DB, found.id);
  c.env.activities.enqueue({ kind: "post_deleted", postId: found.id });
  if (!view) return fail(c, "couldnt_find_post", 404);
  view.post.deleted = true;
  return c.json({ post_view: view } satisfies PostResponse);
});

threadRoutes.post("/api/v3/post/like", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const found = await threadPost(c, int(params.post_id) ?? -1);
  if (!found) return fail(c, "couldnt_find_post", 404);
  await castVote(c, found.id, auth.account.id, Math.sign(int(params.score) ?? 0));
  return postResponse(c, found.id);
});

// Saving is a bookmark, shared with Mastodon apps.
threadRoutes.put("/api/v3/post/save", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const found = await threadPost(c, int(params.post_id) ?? -1);
  if (!found) return fail(c, "couldnt_find_post", 404);
  if (params.save === false) await unbookmark(c.env.bindings.DB, found.id, auth.account.id);
  else await bookmark(c.env.bindings.DB, found.id, auth.account.id);
  return postResponse(c, found.id);
});

// Hiding posts isn't kept yet.
threadRoutes.post("/api/v3/post/hide", (c) => c.json({ success: true } satisfies SuccessResponse));
threadRoutes.post("/api/v3/post/mark_as_read", (c) => c.json({ success: true } satisfies SuccessResponse));

// --- comments --------------------------------------------------------------

threadRoutes.get("/api/v3/comment/list", async (c) => {
  const viewer = c.get("auth")?.account ?? null;
  const maxDepth = int(c.req.query("max_depth"));
  // A tree with a depth limit comes back whole, as Lemmy does; flat lists page.
  const { limit, offset } = maxDepth !== undefined ? { limit: 500, offset: 0 } : paging(c, 20, 50);
  if (bool(c.req.query("liked_only")) || bool(c.req.query("disliked_only"))) return c.json({ comments: [] } satisfies GetCommentsResponse);
  const savedOnly = bool(c.req.query("saved_only"));
  if (savedOnly && !viewer) return c.json({ comments: [] } satisfies GetCommentsResponse);
  const community = await communityFor(c, int(c.req.query("community_id")), c.req.query("community_name"));
  if (community === null) return fail(c, "couldnt_find_community", 404);
  const comments = await listThreadComments(c.env.bindings.DB, {
    domain: c.env.domain.domain,
    scope: scopeOf(c.req.query("type_")),
    savedBy: savedOnly ? viewer?.id : undefined,
    postId: int(c.req.query("post_id")),
    parentId: int(c.req.query("parent_id")),
    communityId: community?.id,
    maxDepth,
    sort: threadSort(c.req.query("sort") === "Hot" ? "Top" : c.req.query("sort")),
    viewerId: viewer?.id ?? null,
    limit,
    offset,
  });
  return c.json({ comments: await commentViews(c, comments) } satisfies GetCommentsResponse);
});

threadRoutes.get("/api/v3/comment", async (c) => commentResponse(c, int(c.req.query("id")) ?? -1));

threadRoutes.post("/api/v3/comment", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const text = str(params.content)?.trim() ?? "";
  if (!text || text.length > MAX_BODY) return fail(c, "invalid_body_field");
  const onPost = await threadPost(c, int(params.post_id) ?? -1);
  if (!onPost) return fail(c, "couldnt_find_post", 404);
  const parentId = int(params.parent_id);
  let inReplyTo: { id: number; apId: string | null; accountId: number } = onPost;
  if (parentId !== undefined) {
    const parent = await threadComment(c, parentId);
    if (!parent || parent.rootId !== onPost.id) return fail(c, "couldnt_find_comment", 404);
    inReplyTo = parent;
  }
  const db = c.env.bindings.DB;
  const parentAuthor = await accountById(db, inReplyTo.accountId);
  const created = await createPost(db, {
    accountId: auth.account.id,
    contentSource: text,
    contentHtml: textToHtml(text),
    spoilerText: "",
    sensitive: false,
    visibility: "public",
    language: null,
    inReplyTo: inReplyTo.apId ?? urls.object(parentAuthor?.domain ?? c.env.domain.domain, String(inReplyTo.id)),
    communityId: onPost.communityId,
    rootId: onPost.id,
    parentId: inReplyTo.id,
  });
  await vote(db, created.id, auth.account.id, 1);
  c.env.activities.enqueue({ kind: "post_created", postId: created.id });
  return commentResponse(c, created.id);
});

threadRoutes.put("/api/v3/comment", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const found = await threadComment(c, int(params.comment_id) ?? -1);
  if (!found || found.deleted || found.accountId !== auth.account.id) return fail(c, "no_comment_edit_allowed");
  const text = str(params.content)?.trim() ?? "";
  if (!text || text.length > MAX_BODY) return fail(c, "invalid_body_field");
  await editPost(c.env.bindings.DB, found.id, { contentSource: text, contentHtml: textToHtml(text) });
  c.env.activities.enqueue({ kind: "post_updated", postId: found.id });
  return commentResponse(c, found.id);
});

threadRoutes.post("/api/v3/comment/delete", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const found = await postByIdAny(c.env.bindings.DB, int(params.comment_id) ?? -1);
  if (!found || found.accountId !== auth.account.id || found.rootId === null) return fail(c, "no_comment_edit_allowed");
  if (params.deleted === false) await restorePost(c.env.bindings.DB, found.id);
  else {
    await deletePost(c.env.bindings.DB, found.id);
    c.env.activities.enqueue({ kind: "post_deleted", postId: found.id });
  }
  return commentResponse(c, found.id);
});

threadRoutes.post("/api/v3/comment/like", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const found = await threadComment(c, int(params.comment_id) ?? -1);
  if (!found || found.deleted) return fail(c, "couldnt_find_comment", 404);
  await castVote(c, found.id, auth.account.id, Math.sign(int(params.score) ?? 0));
  return commentResponse(c, found.id);
});

threadRoutes.put("/api/v3/comment/save", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const found = await threadComment(c, int(params.comment_id) ?? -1);
  if (!found) return fail(c, "couldnt_find_comment", 404);
  if (params.save === false) await unbookmark(c.env.bindings.DB, found.id, auth.account.id);
  else await bookmark(c.env.bindings.DB, found.id, auth.account.id);
  return commentResponse(c, found.id);
});

/** A person's Lemmy posts and comments, newest first, for their profile. */
export async function personThreads(c: C, accountId: number) {
  const { limit, offset } = paging(c, 20, 50);
  const db = c.env.bindings.DB;
  const viewerId = c.get("auth")?.account.id ?? null;
  const [posts, comments] = await Promise.all([
    listThreadPosts(db, { domain: c.env.domain.domain, scope: "all", creatorId: accountId, sort: "new", viewerId, limit, offset }),
    listThreadComments(db, { domain: c.env.domain.domain, scope: "all", creatorId: accountId, sort: "new", viewerId, limit, offset }),
  ]);
  return { posts: await postViews(c, posts), comments: await commentViews(c, comments) };
}

/** Search: communities and posts on this domain whose names or text match. */
export async function searchThreads(c: C, query: string, type: string) {
  const db = c.env.bindings.DB;
  const viewerId = c.get("auth")?.account.id ?? null;
  const { limit, offset } = paging(c, 20, 50);
  const [communities, posts] = await Promise.all([
    type === "All" || type === "Communities"
      ? listCommunities(db, { domain: c.env.domain.domain, scope: "all", query, viewerId, limit, offset })
      : Promise.resolve([]),
    type === "All" || type === "Posts"
      ? listThreadPosts(db, { domain: c.env.domain.domain, scope: "all", query, sort: "new", viewerId, limit, offset })
      : Promise.resolve([]),
  ]);
  return { communities: communities.map((x) => communityView(c.env, x)), posts: await postViews(c, posts) };
}

/**
 * Lemmy's resolve_object: a remote community, person, post or comment by
 * handle or URL, fetched if palm hasn't seen it. Voyager uses it for search
 * and links.
 */
export async function resolveObject(c: C, query: string) {
  const found = await c.env.activities.resolve(query);
  if (!found) return null;
  const db = c.env.bindings.DB;
  if (found.kind === "community") {
    const community = await communityById(db, found.id);
    return community ? { community: communityView(c.env, await communityStats(c, community)) } : null;
  }
  if (found.kind === "account") {
    const account = await accountById(db, found.id);
    return account ? { person: personView(c.env, account) } : null;
  }
  const post = await threadPost(c, found.id);
  if (post) return { post: (await postViews(c, [post]))[0] };
  const comment = await threadComment(c, found.id);
  if (comment) return { comment: (await commentViews(c, [comment]))[0] };
  return null;
}

/** Lemmy's unread counts: replies and mentions on Lemmy comments, from notifications. */
export async function lemmyInboxCounts(db: D1Database, accountId: number): Promise<{ replies: number; mentions: number }> {
  const row = await db
    .prepare(
      `SELECT
         SUM(n.kind = 'reply') AS replies,
         SUM(n.kind = 'mention') AS mentions
       FROM notifications n JOIN posts p ON p.id = n.post_id
       WHERE n.account_id = ? AND n.read = 0 AND p.root_id IS NOT NULL AND p.deleted_at IS NULL`,
    )
    .bind(accountId)
    .first<{ replies: number | null; mentions: number | null }>();
  return { replies: row?.replies ?? 0, mentions: row?.mentions ?? 0 };
}

/**
 * The signed-in account's Lemmy inbox: comments replying to it, or mentioning
 * it, as CommentReplyView or PersonMentionView. The notification's ID is the
 * reply's or mention's ID, which apps send back to mark it read.
 */
export async function inboxItems(c: C, recipient: Account, kind: "reply" | "mention") {
  const db = c.env.bindings.DB;
  const { limit, offset } = paging(c, 20, 50);
  const unreadOnly = bool(c.req.query("unread_only"));
  const { results } = await db
    .prepare(
      `SELECT n.id, n.post_id, n.read, n.created_at FROM notifications n JOIN posts p ON p.id = n.post_id
       WHERE n.account_id = ? AND n.kind = ? AND p.root_id IS NOT NULL AND p.deleted_at IS NULL${unreadOnly ? " AND n.read = 0" : ""}
       ORDER BY n.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(recipient.id, kind, limit, offset)
    .all<{ id: number; post_id: number; read: number; created_at: number }>();
  if (!results.length) return [];
  const comments = await listThreadComments(db, {
    domain: c.env.domain.domain,
    scope: "all",
    ids: results.map((r) => r.post_id),
    sort: "new",
    viewerId: recipient.id,
    limit: results.length,
    offset: 0,
  });
  const views = new Map((await commentViews(c, comments)).map((v) => [v.comment.id, v]));
  const me = personView(c.env, recipient).person;
  return results.flatMap((r) => {
    const view = views.get(r.post_id);
    if (!view) return [];
    const item = { id: r.id, recipient_id: recipient.id, comment_id: r.post_id, read: r.read === 1, published: new Date(r.created_at * 1000).toISOString() };
    return [{ ...view, recipient: me, ...(kind === "reply" ? { comment_reply: item } : { person_mention: item }) }];
  });
}
