import { markdownToHtml, urls, type RequestContext } from "@palm/core";
import {
  accountByHandle,
  accountById,
  accountsByIds,
  addMentions,
  follow,
  followState,
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
  listStatusComments,
  listStatusPosts,
  listThreadComments,
  hasLocalSubscribers,
  listThreadPosts,
  mediaById,
  postByIdAny,
  restorePost,
  subscribe,
  subscription,
  statusRootOf,
  subscriptions,
  threadSort,
  unbookmark,
  unfollow,
  unsubscribe,
  vote,
  type Account,
  type Community,
  type ThreadComment,
  type ThreadPost,
  type ThreadSort,
  hiddenFor,
  isHidden,
  cardsFor,
  postMarks,
  setPostMarks,
  isCommunityBanned,
  moderatorIds,
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
import {
  accountIdOfCommunity,
  followStates,
  hasPersonCommunity,
  isPersonCommunityId,
  personCommunity,
  personCommunityStats,
  statusTitle,
} from "./people-communities.ts";
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
  // No community by that name: a person's statuses, as their person community.
  const person = await personNamed(c, local, host);
  if (person) return personCommunity(person);
  if (host === c.env.domain.domain) return null;
  const found = await c.env.activities.resolve(`!${local}@${host}`);
  return found?.kind === "community" ? communityById(db, found.id) : null;
}

/** A person who can have a person community, fetched the first time a remote one is asked for. */
async function personNamed(c: C, username: string, host: string): Promise<Account | null> {
  const db = c.env.bindings.DB;
  let account = await accountByHandle(db, username, host);
  if (!account && host !== c.env.domain.domain) {
    const found = await c.env.activities.resolve(`@${username}@${host}`);
    account = found?.kind === "account" ? await accountById(db, found.id) : null;
  }
  return account && hasPersonCommunity(account) ? account : null;
}

async function personCommunityById(c: C, id: number): Promise<Community | null> {
  const account = await accountById(c.env.bindings.DB, accountIdOfCommunity(id));
  return account && hasPersonCommunity(account) ? personCommunity(account) : null;
}

/** A community this domain can show: its own, or a remote one palm knows. */
const visible = (c: C, community: Community | null) =>
  community && (community.apId !== null || community.domain === c.env.domain.domain) ? community : null;

export async function communityFor(c: C, id: number | undefined, name: string | undefined): Promise<Community | null | undefined> {
  if (id !== undefined) {
    if (isPersonCommunityId(id)) return personCommunityById(c, id);
    return visible(c, await communityById(c.env.bindings.DB, id));
  }
  if (name) return communityNamed(c, name);
  return undefined;
}

/** Lemmy's listing types: Local is this domain's communities; All and Subscribed take in remote ones. */
const scopeOf = (type: string | undefined) => (type === "Local" ? ("local" as const) : ("all" as const));

/**
 * What a post or comment view needs to know about where it sits. A status,
 * or a reply under one, sits in a person community: `ownerId` is the
 * person whose statuses those are.
 */
interface Placed {
  accountId: number;
  communityId: number | null;
  ownerId?: number | undefined;
}

/** Looks up the people, communities and subscriptions a set of views needs, once each. */
async function contextFor(c: C, items: Placed[]) {
  const db = c.env.bindings.DB;
  const viewer = c.get("auth")?.account ?? null;
  const [byId, communities, subscribed, following] = await Promise.all([
    accountsByIds(db, items.flatMap((i) => [i.accountId, i.ownerId ?? i.accountId])),
    communitiesByIds(db, items.map((i) => i.communityId ?? 0)),
    viewer ? subscriptions(db, viewer.id) : Promise.resolve([]),
    followStates(db, viewer?.id ?? null),
  ]);
  const states = new Map(subscribed.map((s) => [s.id, s.pending]));
  return (item: Placed): ThreadContext | null => {
    const creator = byId.get(item.accountId);
    if (!creator) return null;
    if (item.communityId === null) {
      const owner = byId.get(item.ownerId ?? item.accountId);
      if (!owner) return null;
      const state = following.get(owner.id);
      return { creator, community: personCommunity(owner), subscribed: state === "accepted", pending: state === "pending" };
    }
    const community = communities.get(item.communityId);
    if (!community) return null;
    const pending = states.get(community.id);
    return { creator, community, subscribed: pending === false, pending: pending === true };
  };
}

/** A status as a Lemmy post: a title from its text, and its first picture as the link. */
function asLemmyPost<T extends ThreadPost>(p: T): T {
  if (p.communityId !== null) return p;
  const picture = p.attachments.find((a) => a.mediaType?.startsWith("image/") || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(a.url));
  return { ...p, title: statusTitle(p), linkUrl: p.linkUrl ?? picture?.url ?? null };
}

export async function postViews(c: C, posts: ThreadPost[]) {
  const viewer = c.get("auth")?.account ?? null;
  const shown = posts.map(asLemmyPost);
  const [ctxOf, hidden, cards, marks] = await Promise.all([
    contextFor(c, posts),
    hiddenFor(c.env.bindings.DB, viewer?.id),
    cardsFor(c.env.bindings.DB, shown.flatMap((p) => (p.linkUrl ? [p.linkUrl] : []))),
    postMarks(c.env.bindings.DB, viewer?.id, posts.map((p) => p.id)),
  ]);
  return shown.flatMap((p) => {
    const t = ctxOf(p);
    // Blocked people, communities and instances drop out; your own posts stay.
    if (!t || (p.accountId !== viewer?.id && isHidden(hidden, t.creator, t.community.id))) return [];
    const view = postView(c.env, p, t);
    view.read = marks.read.has(p.id);
    view.hidden = marks.hidden.has(p.id);
    // A link's preview: its title, description and picture.
    const card = p.linkUrl ? cards.get(p.linkUrl) : undefined;
    if (card) {
      if (card.title) view.post.embed_title = card.title;
      if (card.description) view.post.embed_description = card.description;
      if (card.image && !view.post.thumbnail_url) view.post.thumbnail_url = urls.proxy(c.env.domain.domain, card.image);
    }
    return [view];
  });
}

export async function commentViews(c: C, comments: ThreadComment[]) {
  const ids = [...new Set(comments.map((x) => x.rootId ?? 0))];
  const viewerId = c.get("auth")?.account.id ?? null;
  const [threads, statuses] = await Promise.all([
    listThreadPosts(c.env.bindings.DB, { domain: c.env.domain.domain, scope: "all", ids, sort: "new", viewerId, limit: 1000, offset: 0 }),
    listStatusPosts(c.env.bindings.DB, { ids, sort: "new", viewerId, limit: 1000, offset: 0 }),
  ]);
  const rootById = new Map([...threads, ...statuses].map((r) => [r.id, asLemmyPost(r)]));
  const ctxOf = await contextFor(
    c,
    comments.map((x) => ({ accountId: x.accountId, communityId: x.communityId, ownerId: rootById.get(x.rootId ?? 0)?.accountId })),
  );
  const hidden = await hiddenFor(c.env.bindings.DB, viewerId);
  return comments.flatMap((x) => {
    const root = rootById.get(x.rootId ?? 0);
    const t = ctxOf({ accountId: x.accountId, communityId: x.communityId, ownerId: root?.accountId });
    if (!t || !root) return [];
    // A blocked person's comment stays in place, so replies keep their thread, but its text goes.
    if (x.accountId !== viewerId && isHidden(hidden, t.creator)) return [commentView(c.env, { ...x, contentSource: "", contentHtml: "" }, root, t)];
    return [commentView(c.env, x, root, t)];
  });
}

/** One Lemmy post as the viewer sees it, or null. */
export async function threadPost(c: C, id: number): Promise<ThreadPost | null> {
  const [found] = await listThreadPosts(c.env.bindings.DB, {
    domain: c.env.domain.domain,
    scope: "all",
    ids: [id],
    sort: "new",
    viewerId: c.get("auth")?.account.id ?? null,
    limit: 1,
    offset: 0,
  });
  if (found) return found;
  // Or a status, in its author's person community.
  const [status] = await listStatusPosts(c.env.bindings.DB, { ids: [id], sort: "new", viewerId: c.get("auth")?.account.id ?? null, limit: 1, offset: 0 });
  return status ?? null;
}

export async function threadComment(c: C, id: number): Promise<ThreadComment | null> {
  const viewerId = c.get("auth")?.account.id ?? null;
  const [found] = await listThreadComments(c.env.bindings.DB, {
    domain: c.env.domain.domain,
    scope: "all",
    ids: [id],
    sort: "new",
    viewerId,
    limit: 1,
    offset: 0,
  });
  if (found) return found;
  // Or a reply under a status.
  const root = await statusRootOf(c.env.bindings.DB, id);
  if (root === null) return null;
  const replies = await listStatusComments(c.env.bindings.DB, root, { viewerId, sort: "new" });
  return replies.find((r) => r.id === id) ?? null;
}

export async function postResponse(c: C, id: number) {
  const found = await threadPost(c, id);
  const [view] = found ? await postViews(c, [found]) : [];
  return view ? c.json({ post_view: view } satisfies PostResponse) : fail(c, "couldnt_find_post", 404);
}

export async function commentResponse(c: C, id: number) {
  const found = await threadComment(c, id);
  const [view] = found ? await commentViews(c, [found]) : [];
  return view ? c.json({ comment_view: view, recipient_ids: [] } satisfies CommentResponse) : fail(c, "couldnt_find_comment", 404);
}

/** A community's moderators, as Lemmy lists them. */
export async function moderatorViews(c: C, community: Community) {
  if (isPersonCommunityId(community.id) || community.apId) return [];
  const people = await accountsByIds(c.env.bindings.DB, await moderatorIds(c.env.bindings.DB, community.id));
  const view = communityView(c.env, { ...community, subscribers: 0, posts: 0, comments: 0, subscribed: false, pending: false }).community;
  return [...people.values()].map((p) => ({ community: view, moderator: personView(c.env, p).person }));
}

/** The same link posted in other communities, as Lemmy lists cross-posts. */
async function crossPosts(c: C, post: ThreadPost): Promise<ThreadPost[]> {
  const { results } = await c.env.bindings.DB.prepare(
    "SELECT id FROM posts WHERE link_url = ? AND id != ? AND root_id IS NULL AND community_id IS NOT NULL AND deleted_at IS NULL ORDER BY id DESC LIMIT 10",
  )
    .bind(post.linkUrl, post.id)
    .all<{ id: number }>();
  if (!results.length) return [];
  return listThreadPosts(c.env.bindings.DB, {
    domain: c.env.domain.domain,
    scope: "all",
    ids: results.map((r) => r.id),
    sort: "new",
    viewerId: c.get("auth")?.account.id ?? null,
    limit: 10,
    offset: 0,
  });
}

export async function communityStats(c: C, community: Community) {
  const viewer = c.get("auth")?.account.id ?? null;
  if (isPersonCommunityId(community.id)) {
    const owner = await accountById(c.env.bindings.DB, accountIdOfCommunity(community.id));
    if (owner) return personCommunityStats(c.env, owner, viewer);
  }
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
    moderators: await moderatorViews(c, community),
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
  const views = found.map((x) => communityView(c.env, x));
  // Subscribed takes in the people followed, as person communities, on the first page.
  if (type === "Subscribed" && viewer && offset === 0) views.push(...(await followedPeopleCommunities(c, viewer.id)));
  return c.json({ communities: views } satisfies ListCommunitiesResponse);
});

/** Person communities for the people an account follows, or has asked to. */
export async function followedPeople(c: C, accountId: number): Promise<Community[]> {
  const db = c.env.bindings.DB;
  const states = await followStates(db, accountId);
  const people = await accountsByIds(db, [...states.keys()]);
  return [...people.values()].filter(hasPersonCommunity).map(personCommunity);
}

async function followedPeopleCommunities(c: C, accountId: number) {
  const communities = await followedPeople(c, accountId);
  return Promise.all(communities.map(async (x) => communityView(c.env, await communityStats(c, x))));
}

threadRoutes.post("/api/v3/community/follow", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const community = await communityFor(c, int(params.community_id), undefined);
  if (!community) return fail(c, "couldnt_find_community", 404);
  const db = c.env.bindings.DB;
  if (isPersonCommunityId(community.id)) {
    await followPerson(c, auth.account, accountIdOfCommunity(community.id), params.follow !== false);
    return c.json({ community_view: communityView(c.env, await communityStats(c, community)), discussion_languages: [] } satisfies CommunityResponse);
  }
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

/** Subscribing to a person community: following the person, as Mastodon apps do. */
async function followPerson(c: C, me: Account, targetId: number, on: boolean): Promise<void> {
  const db = c.env.bindings.DB;
  const target = await accountById(db, targetId);
  if (!target || target.id === me.id) return;
  const existing = await followState(db, me.id, target.id);
  if (on && !existing) {
    const followApId = `${urls.user(me.domain, me.username)}#follows/${target.id}-${Date.now()}`;
    await follow(db, me.id, target.id, target.apId ? { followApId } : undefined);
    c.env.activities.enqueue({ kind: "followed", accountId: me.id, targetId: target.id, followApId, undo: false });
  } else if (!on && existing) {
    await unfollow(db, me.id, target.id);
    if (target.apId && existing.followApId) {
      c.env.activities.enqueue({ kind: "followed", accountId: me.id, targetId: target.id, followApId: existing.followApId, undo: true });
    }
  }
}

// --- posts -----------------------------------------------------------------

threadRoutes.get("/api/v3/post/list", async (c) => {
  const viewer = c.get("auth")?.account ?? null;
  const { limit, offset } = paging(c, 20, 50);
  const community = await communityFor(c, int(c.req.query("community_id")), c.req.query("community_name"));
  if (community === null) return fail(c, "couldnt_find_community", 404);
  const type = c.req.query("type_");
  const mine = bool(c.req.query("saved_only")) || bool(c.req.query("liked_only")) || bool(c.req.query("disliked_only"));
  if ((mine || (!community && type === "Subscribed")) && !viewer) return c.json({ posts: [] } satisfies GetPostsResponse);
  const sort = threadSort(c.req.query("sort"));
  if (community && isPersonCommunityId(community.id)) {
    const posts = await listStatusPosts(c.env.bindings.DB, {
      authorIds: [accountIdOfCommunity(community.id)],
      sort,
      viewerId: viewer?.id ?? null,
      limit,
      offset,
    });
    const response: GetPostsResponse = { posts: await postViews(c, posts) };
    if (posts.length === limit) response.next_page = `o${offset + limit}`;
    return c.json(response);
  }
  const withStatuses = !community && !mine && type === "Subscribed" && viewer;
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
    sort,
    viewerId: viewer?.id ?? null,
    // Merged with followed people's statuses below, so both lists start at the top.
    limit: withStatuses ? offset + limit : limit,
    offset: withStatuses ? 0 : offset,
  });
  let page = posts;
  if (withStatuses) {
    const statuses = await listStatusPosts(c.env.bindings.DB, { followedBy: viewer.id, sort, viewerId: viewer.id, limit: offset + limit, offset: 0 });
    page = mergeSorted(posts, statuses, sort).slice(offset, offset + limit);
  }
  // Read posts drop out when asked (show_read=false); hidden ones unless asked for.
  const showRead = c.req.query("show_read") !== "false";
  const showHidden = bool(c.req.query("show_hidden"));
  const views = (await postViews(c, page)).filter((v) => (showRead || !v.read) && (showHidden || !v.hidden));
  const response: GetPostsResponse = { posts: views };
  if (page.length === limit) response.next_page = `o${offset + limit}`;
  return c.json(response);
});

/** Two lists in the same sort, merged as one would have been sorted. */
function mergeSorted(a: ThreadPost[], b: ThreadPost[], sort: ThreadSort): ThreadPost[] {
  const score = (p: ThreadPost) => p.upvotes - p.downvotes;
  const compare = {
    new: (x: ThreadPost, y: ThreadPost) => y.id - x.id,
    old: (x: ThreadPost, y: ThreadPost) => x.id - y.id,
    top: (x: ThreadPost, y: ThreadPost) => score(y) - score(x) || y.id - x.id,
    controversial: (x: ThreadPost, y: ThreadPost) => Math.min(y.upvotes, y.downvotes) - Math.min(x.upvotes, x.downvotes) || y.id - x.id,
    comments: (x: ThreadPost, y: ThreadPost) => y.comments - x.comments || y.id - x.id,
    active: (x: ThreadPost, y: ThreadPost) => y.activeAt - x.activeAt || y.id - x.id,
  }[sort];
  return [...a, ...b].sort(compare);
}

threadRoutes.get("/api/v3/post", async (c) => {
  let id = int(c.req.query("id"));
  const commentId = int(c.req.query("comment_id"));
  if (id === undefined && commentId !== undefined) id = (await threadComment(c, commentId))?.rootId ?? undefined;
  const found = id === undefined ? null : await threadPost(c, id);
  const [view] = found ? await postViews(c, [found]) : [];
  if (!view) return fail(c, "couldnt_find_post", 404);
  const community = await communityFor(c, view.community.id, undefined);
  const body: GetPostResponse = {
    post_view: view,
    community_view: communityView(c.env, await communityStats(c, community!)),
    moderators: community ? await moderatorViews(c, community) : [],
    cross_posts: found?.linkUrl ? (await postViews(c, await crossPosts(c, found))).filter((v) => v.post.id !== found.id) : [],
  };
  return c.json(body);
});

threadRoutes.post("/api/v3/post", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const community = await communityFor(c, int(params.community_id), undefined);
  if (!community) return fail(c, "couldnt_find_community", 404);
  // A person community holds that person's own statuses.
  if (isPersonCommunityId(community.id)) return fail(c, "only_mods_can_post_in_community");
  if (await isCommunityBanned(c.env.bindings.DB, community.id, auth.account.id)) return fail(c, "banned_from_community");
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
    contentHtml: markdownToHtml(text),
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
  await editPost(c.env.bindings.DB, found.id, { contentSource: text, contentHtml: markdownToHtml(text), title: title ?? null, linkUrl: link || null });
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
// Read and hidden posts, per person.
for (const [path, mark, flag] of [
  ["/api/v3/post/hide", "hidden", "hide"],
  ["/api/v3/post/mark_as_read", "read", "read"],
] as const) {
  threadRoutes.post(path, async (c) => {
    const auth = c.get("auth");
    if (!auth) return fail(c, "not_logged_in", 401);
    const params = await body(c);
    const ids = [...(Array.isArray(params.post_ids) ? params.post_ids : []), params.post_id].map((x) => int(x)).filter((x): x is number => x !== undefined);
    await setPostMarks(c.env.bindings.DB, auth.account.id, ids.slice(0, 100), mark, params[flag] !== false);
    return c.json({ success: true } satisfies SuccessResponse);
  });
}

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
  // Opening a remote post: bring in comments it had before anyone here followed along.
  const postId = int(c.req.query("post_id"));
  if (postId !== undefined && !c.req.query("page_cursor") && (int(c.req.query("page")) ?? 1) === 1) {
    const root = await postByIdAny(c.env.bindings.DB, postId);
    if (root?.apId) await c.env.activities.backfillThread(root.id);
  }
  const sort = threadSort(c.req.query("sort") === "Hot" ? "Top" : c.req.query("sort"));
  // Under a status, the replies, threaded by what they reply to.
  if (postId !== undefined) {
    const root = await postByIdAny(c.env.bindings.DB, postId);
    if (root && root.communityId === null && root.rootId === null) {
      const replies = await listStatusComments(c.env.bindings.DB, root.id, {
        viewerId: viewer?.id ?? null,
        maxDepth,
        parentId: int(c.req.query("parent_id")),
        sort,
      });
      return c.json({ comments: await commentViews(c, replies.slice(offset, offset + limit)) } satisfies GetCommentsResponse);
    }
  }
  const comments = await listThreadComments(c.env.bindings.DB, {
    domain: c.env.domain.domain,
    scope: scopeOf(c.req.query("type_")),
    savedBy: savedOnly ? viewer?.id : undefined,
    postId: int(c.req.query("post_id")),
    parentId: int(c.req.query("parent_id")),
    communityId: community?.id,
    maxDepth,
    sort,
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
  if (onPost.locked) return fail(c, "locked");
  if (onPost.communityId !== null && (await isCommunityBanned(c.env.bindings.DB, onPost.communityId, auth.account.id))) return fail(c, "banned_from_community");
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
    contentHtml: markdownToHtml(text),
    spoilerText: "",
    sensitive: false,
    visibility: "public",
    language: null,
    inReplyTo: inReplyTo.apId ?? urls.object(parentAuthor?.domain ?? c.env.domain.domain, String(inReplyTo.id)),
    communityId: onPost.communityId,
    // A reply to a status stays a status reply, so Mastodon apps see it as one.
    ...(onPost.communityId !== null ? { rootId: onPost.id } : {}),
    parentId: inReplyTo.id,
  });
  await vote(db, created.id, auth.account.id, 1);
  // Mastodon notifies a reply's target only when it's mentioned.
  if (onPost.communityId === null && parentAuthor && parentAuthor.id !== auth.account.id) await addMentions(db, created.id, [parentAuthor.id]);
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
  await editPost(c.env.bindings.DB, found.id, { contentSource: text, contentHtml: markdownToHtml(text) });
  c.env.activities.enqueue({ kind: "post_updated", postId: found.id });
  return commentResponse(c, found.id);
});

threadRoutes.post("/api/v3/comment/delete", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const found = await postByIdAny(c.env.bindings.DB, int(params.comment_id) ?? -1);
  const isComment = found && (found.rootId !== null || (await statusRootOf(c.env.bindings.DB, found.id)) !== null);
  if (!found || found.accountId !== auth.account.id || !isComment) return fail(c, "no_comment_edit_allowed");
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
       WHERE n.account_id = ? AND n.read = 0 AND (p.root_id IS NOT NULL OR (p.parent_id IS NOT NULL AND p.community_id IS NULL AND p.visibility IN ('public', 'unlisted'))) AND p.deleted_at IS NULL`,
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
       WHERE n.account_id = ? AND n.kind = ? AND (p.root_id IS NOT NULL OR (p.parent_id IS NOT NULL AND p.community_id IS NULL AND p.visibility IN ('public', 'unlisted'))) AND p.deleted_at IS NULL${unreadOnly ? " AND n.read = 0" : ""}
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
  // Replies under statuses aren't Lemmy comments in the table; find them in their threads.
  const found = new Set(comments.map((x) => x.id));
  for (const r of results) {
    if (found.has(r.post_id)) continue;
    const reply = await threadComment(c, r.post_id);
    if (reply) comments.push(reply);
  }
  const views = new Map((await commentViews(c, comments)).map((v) => [v.comment.id, v]));
  const me = personView(c.env, recipient).person;
  return results.flatMap((r) => {
    const view = views.get(r.post_id);
    if (!view) return [];
    const item = { id: r.id, recipient_id: recipient.id, comment_id: r.post_id, read: r.read === 1, published: new Date(r.created_at * 1000).toISOString() };
    return [{ ...view, recipient: me, ...(kind === "reply" ? { comment_reply: item } : { person_mention: item }) }];
  });
}
