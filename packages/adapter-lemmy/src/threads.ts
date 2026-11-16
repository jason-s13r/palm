import { textToHtml, type RequestContext } from "@palm/core";
import {
  accountById,
  communitiesByIds,
  communityById,
  communityByName,
  createPost,
  deletePost,
  editPost,
  listCommunities,
  listThreadComments,
  listThreadPosts,
  postByIdAny,
  restorePost,
  subscribe,
  subscriptions,
  threadSort,
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
import { commentView, communityView, postView, type ThreadContext } from "./views.ts";

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

/** A community named "sandbox", "!sandbox" or "sandbox@this.domain"; others aren't here. */
async function communityNamed(c: C, name: string): Promise<Community | null> {
  const [local, host] = name.replace(/^!/, "").split("@");
  if (!local || (host && host.toLowerCase() !== c.env.domain.domain)) return null;
  return communityByName(c.env.bindings.DB, c.env.domain.domain, local);
}

async function communityFor(c: C, id: number | undefined, name: string | undefined): Promise<Community | null | undefined> {
  if (id !== undefined) {
    const found = await communityById(c.env.bindings.DB, id);
    return found?.domain === c.env.domain.domain ? found : null;
  }
  if (name) return communityNamed(c, name);
  return undefined;
}

/** Looks up the people, communities and subscriptions a set of views needs, once each. */
async function contextFor(c: C, items: { accountId: number; communityId: number | null }[]) {
  const db = c.env.bindings.DB;
  const viewer = c.get("auth")?.account ?? null;
  const accountIds = [...new Set(items.map((i) => i.accountId))];
  const [accounts, communities, subscribed] = await Promise.all([
    Promise.all(accountIds.map((id) => accountById(db, id))),
    communitiesByIds(db, items.map((i) => i.communityId ?? 0)),
    viewer ? subscriptions(db, viewer.id) : Promise.resolve([]),
  ]);
  const byId = new Map(accounts.filter((a): a is Account => a !== null).map((a) => [a.id, a]));
  const subscribedIds = new Set(subscribed.map((s) => s.id));
  return (item: { accountId: number; communityId: number | null }): ThreadContext | null => {
    const creator = byId.get(item.accountId);
    const community = communities.get(item.communityId ?? 0);
    return creator && community ? { creator, community, subscribed: subscribedIds.has(community.id) } : null;
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
    ids: [community.id],
    viewerId: viewer,
    limit: 1,
    offset: 0,
  });
  return found ?? { ...community, subscribers: 0, posts: 0, comments: 0, subscribed: false };
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
  if (params.follow === false) await unsubscribe(db, community.id, auth.account.id);
  else await subscribe(db, community.id, auth.account.id);
  return c.json({ community_view: communityView(c.env, await communityStats(c, community)), discussion_languages: [] } satisfies CommunityResponse);
});

// --- posts -----------------------------------------------------------------

threadRoutes.get("/api/v3/post/list", async (c) => {
  const viewer = c.get("auth")?.account ?? null;
  const { limit, offset } = paging(c, 20, 50);
  const community = await communityFor(c, int(c.req.query("community_id")), c.req.query("community_name"));
  if (community === null) return fail(c, "couldnt_find_community", 404);
  // Saved, liked and hidden posts aren't kept yet.
  if (bool(c.req.query("saved_only")) || bool(c.req.query("liked_only")) || bool(c.req.query("disliked_only"))) {
    return c.json({ posts: [] } satisfies GetPostsResponse);
  }
  const type = c.req.query("type_");
  if (!community && type === "Subscribed" && !viewer) return c.json({ posts: [] } satisfies GetPostsResponse);
  const posts = await listThreadPosts(c.env.bindings.DB, {
    domain: c.env.domain.domain,
    communityId: community?.id,
    subscribedBy: !community && type === "Subscribed" ? viewer?.id : undefined,
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
  c.env.activities.postCreated(created);
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
  c.env.activities.postDeleted(found);
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
  await vote(c.env.bindings.DB, found.id, auth.account.id, Math.sign(int(params.score) ?? 0));
  return postResponse(c, found.id);
});

// Read marks, saves and hides aren't kept yet; apps get the post back as if they were.
for (const path of ["/api/v3/post/save", "/api/v3/post/hide"]) {
  threadRoutes.on(["POST", "PUT"], path, async (c) => {
    const params = await body(c);
    const id = int(params.post_id) ?? (Array.isArray(params.post_ids) ? int(params.post_ids[0]) : undefined);
    return id === undefined ? c.json({ success: true } satisfies SuccessResponse) : postResponse(c, id);
  });
}
threadRoutes.post("/api/v3/post/mark_as_read", (c) => c.json({ success: true } satisfies SuccessResponse));

// --- comments --------------------------------------------------------------

threadRoutes.get("/api/v3/comment/list", async (c) => {
  const viewer = c.get("auth")?.account ?? null;
  const maxDepth = int(c.req.query("max_depth"));
  // A tree with a depth limit comes back whole, as Lemmy does; flat lists page.
  const { limit, offset } = maxDepth !== undefined ? { limit: 500, offset: 0 } : paging(c, 20, 50);
  if (bool(c.req.query("saved_only")) || bool(c.req.query("liked_only")) || bool(c.req.query("disliked_only"))) {
    return c.json({ comments: [] } satisfies GetCommentsResponse);
  }
  const community = await communityFor(c, int(c.req.query("community_id")), c.req.query("community_name"));
  if (community === null) return fail(c, "couldnt_find_community", 404);
  const comments = await listThreadComments(c.env.bindings.DB, {
    domain: c.env.domain.domain,
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
  let inReplyTo = onPost.id;
  if (parentId !== undefined) {
    const parent = await threadComment(c, parentId);
    if (!parent || parent.rootId !== onPost.id) return fail(c, "couldnt_find_comment", 404);
    inReplyTo = parent.id;
  }
  const db = c.env.bindings.DB;
  const created = await createPost(db, {
    accountId: auth.account.id,
    contentSource: text,
    contentHtml: textToHtml(text),
    spoilerText: "",
    sensitive: false,
    visibility: "public",
    language: null,
    inReplyTo: `https://${c.env.domain.domain}/objects/${inReplyTo}`,
    communityId: onPost.communityId,
    rootId: onPost.id,
    parentId: inReplyTo,
  });
  await vote(db, created.id, auth.account.id, 1);
  c.env.activities.postCreated(created);
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
    c.env.activities.postDeleted(found);
  }
  return commentResponse(c, found.id);
});

threadRoutes.post("/api/v3/comment/like", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const found = await threadComment(c, int(params.comment_id) ?? -1);
  if (!found || found.deleted) return fail(c, "couldnt_find_comment", 404);
  await vote(c.env.bindings.DB, found.id, auth.account.id, Math.sign(int(params.score) ?? 0));
  return commentResponse(c, found.id);
});

threadRoutes.put("/api/v3/comment/save", async (c) => commentResponse(c, int((await body(c)).comment_id) ?? -1));
threadRoutes.post("/api/v3/comment/mark_as_read", (c) => c.json({ success: true } satisfies SuccessResponse));

/** A person's Lemmy posts and comments, newest first, for their profile. */
export async function personThreads(c: C, accountId: number) {
  const { limit, offset } = paging(c, 20, 50);
  const db = c.env.bindings.DB;
  const viewerId = c.get("auth")?.account.id ?? null;
  const [posts, comments] = await Promise.all([
    listThreadPosts(db, { domain: c.env.domain.domain, creatorId: accountId, sort: "new", viewerId, limit, offset }),
    listThreadComments(db, { domain: c.env.domain.domain, creatorId: accountId, sort: "new", viewerId, limit, offset }),
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
      ? listCommunities(db, { domain: c.env.domain.domain, query, viewerId, limit, offset })
      : Promise.resolve([]),
    type === "All" || type === "Posts"
      ? listThreadPosts(db, { domain: c.env.domain.domain, query, sort: "new", viewerId, limit, offset })
      : Promise.resolve([]),
  ]);
  return { communities: communities.map((x) => communityView(c.env, x)), posts: await postViews(c, posts) };
}
