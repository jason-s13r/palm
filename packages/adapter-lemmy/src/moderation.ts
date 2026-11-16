import type { RequestContext } from "@palm/core";
import {
  accountById,
  accountsByIds,
  communitiesByIds,
  communityById,
  countOpenReports,
  createLocalCommunity,
  createReport,
  deletePost,
  isModerator,
  listModLog,
  listReports,
  logMod,
  moderatedCommunityIds,
  moderatorIds,
  postByIdAny,
  reportById,
  resolveReport,
  restorePost,
  setCommunityBan,
  setModerator,
  setPostFlag,
  updateCommunity,
  type Account,
  type Post,
  type Report,
  type ThreadComment,
  type ThreadPost,
} from "@palm/db";
import { Hono, type Context } from "hono";
import {
  commentViews,
  communityStats,
  moderatorViews,
  postViews,
  threadComment,
  threadPost,
  postResponse,
} from "./threads.ts";
import { comment, community as communityObject, communityView, person, personView, post as postObject } from "./views.ts";

/**
 * Moderating communities from Lemmy apps: creating and editing them, their
 * moderators, pinning and locking posts, removing posts and comments,
 * banning people from a community, reports, and the mod log. Admins can do
 * all of it anywhere; a community's moderators in that community.
 */

interface Auth {
  account: Account;
  sessionId: string;
}
type Env = { Bindings: RequestContext; Variables: { auth: Auth | null } };
type C = Context<Env>;

const fail = (c: C, error: string, status: 400 | 401 | 403 | 404 = 400) => c.json({ error }, status);
const body = async (c: C) => (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const num = (value: unknown) => (typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : -1);
const NAME = /^[a-z0-9_]{1,20}$/;

/** Whether this person may moderate the community: its moderator, or an admin. */
async function canModerate(c: C, me: Account, communityId: number | null): Promise<boolean> {
  if (me.role === "admin") return true;
  if (communityId === null) return false;
  return isModerator(c.env.bindings.DB, communityId, me.id);
}

/** The communities whose reports this person sees; null for all of them. */
async function reportScope(c: C, me: Account): Promise<number[] | null> {
  return me.role === "admin" ? null : moderatedCommunityIds(c.env.bindings.DB, me.id);
}

const asThreadPost = (p: Post): ThreadPost => ({ ...p, upvotes: 0, downvotes: 0, myVote: 0, saved: false, comments: 0, activeAt: p.createdAt });
const asThreadComment = (p: Post): ThreadComment => ({ ...p, upvotes: 0, downvotes: 0, myVote: 0, saved: false, deleted: false, childCount: 0 });

export const moderationRoutes = new Hono<Env>();

// --- communities ----------------------------------------------------------------

moderationRoutes.post("/api/v3/community", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const name = String(params.name ?? "").trim().toLowerCase();
  if (!NAME.test(name)) return fail(c, "invalid_name");
  const title = String(params.title ?? name).trim().slice(0, 100) || name;
  const created = await createLocalCommunity(
    c.env.bindings.DB,
    {
      domain: c.env.domain.domain,
      name,
      title,
      description: typeof params.description === "string" ? params.description : null,
      nsfw: params.nsfw === true,
      iconUrl: typeof params.icon === "string" ? params.icon : null,
      bannerUrl: typeof params.banner === "string" ? params.banner : null,
    },
    auth.account.id,
  );
  if (created === "taken") return fail(c, "community_already_exists");
  // Signing keys come from the admin's CLI (pnpm palm keys stock): making them here costs too much CPU.
  if (created === "no_keys") return fail(c, "couldnt_create_community");
  return c.json({ community_view: communityView(c.env, await communityStats(c, created)), discussion_languages: [] });
});

moderationRoutes.put("/api/v3/community", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const community = await communityById(c.env.bindings.DB, num(params.community_id));
  if (!community || community.apId) return fail(c, "couldnt_find_community", 404);
  if (!(await canModerate(c, auth.account, community.id))) return fail(c, "not_a_moderator", 403);
  await updateCommunity(c.env.bindings.DB, community.id, {
    title: typeof params.title === "string" && params.title.trim() ? params.title.trim().slice(0, 100) : undefined,
    description: typeof params.description === "string" ? params.description : undefined,
    nsfw: typeof params.nsfw === "boolean" ? params.nsfw : undefined,
    iconUrl: typeof params.icon === "string" ? params.icon || null : undefined,
    bannerUrl: typeof params.banner === "string" ? params.banner || null : undefined,
  });
  const updated = (await communityById(c.env.bindings.DB, community.id))!;
  return c.json({ community_view: communityView(c.env, await communityStats(c, updated)), discussion_languages: [] });
});

moderationRoutes.post("/api/v3/community/mod", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const db = c.env.bindings.DB;
  const community = await communityById(db, num(params.community_id));
  const target = await accountById(db, num(params.person_id));
  if (!community || community.apId || !target || target.apId) return fail(c, "couldnt_find_community", 404);
  if (!(await canModerate(c, auth.account, community.id))) return fail(c, "not_a_moderator", 403);
  const added = params.added !== false;
  // A community keeps at least one moderator.
  if (!added && (await moderatorIds(db, community.id)).length <= 1) return fail(c, "cannot_leave_mod");
  await setModerator(db, community.id, target.id, added);
  await logMod(db, { kind: "add_mod", modId: auth.account.id, accountId: target.id, communityId: community.id, value: added });
  return c.json({ moderators: await moderatorViews(c, community) });
});

moderationRoutes.post("/api/v3/community/ban_user", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const db = c.env.bindings.DB;
  const community = await communityById(db, num(params.community_id));
  const target = await accountById(db, num(params.person_id));
  if (!community || !target) return fail(c, "couldnt_find_community", 404);
  if (!(await canModerate(c, auth.account, community.id))) return fail(c, "not_a_moderator", 403);
  const banned = params.ban !== false;
  const reason = typeof params.reason === "string" ? params.reason : null;
  const expires = typeof params.expires === "number" ? params.expires : null;
  await setCommunityBan(db, community.id, target.id, banned, { reason, expiresAt: expires });
  if (banned && params.remove_data === true) {
    await db
      .prepare("UPDATE posts SET deleted_at = ? WHERE account_id = ? AND community_id = ? AND deleted_at IS NULL")
      .bind(Math.floor(Date.now() / 1000), target.id, community.id)
      .run();
  }
  await logMod(db, { kind: "ban_from_community", modId: auth.account.id, accountId: target.id, communityId: community.id, reason, value: banned });
  return c.json({ person_view: personView(c.env, target), banned });
});

// --- posts and comments -----------------------------------------------------------

moderationRoutes.post("/api/v3/post/feature", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const post = await threadPost(c, num(params.post_id));
  if (!post) return fail(c, "couldnt_find_post", 404);
  const local = params.feature_type === "Local";
  // Pinning to the front page is the admin's; to a community, its moderators'.
  if (local ? auth.account.role !== "admin" : !(await canModerate(c, auth.account, post.communityId))) return fail(c, "not_a_moderator", 403);
  const featured = params.featured !== false;
  await setPostFlag(c.env.bindings.DB, post.id, local ? "featured_local" : "featured_community", featured);
  await logMod(c.env.bindings.DB, { kind: "feature_post", modId: auth.account.id, postId: post.id, communityId: post.communityId, value: featured, reason: local ? "local" : null });
  return postResponse(c, post.id);
});

moderationRoutes.post("/api/v3/post/lock", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const post = await threadPost(c, num(params.post_id));
  if (!post) return fail(c, "couldnt_find_post", 404);
  if (!(await canModerate(c, auth.account, post.communityId))) return fail(c, "not_a_moderator", 403);
  const locked = params.locked !== false;
  await setPostFlag(c.env.bindings.DB, post.id, "locked", locked);
  await logMod(c.env.bindings.DB, { kind: "lock_post", modId: auth.account.id, postId: post.id, communityId: post.communityId, value: locked });
  return postResponse(c, post.id);
});

// Removing a post or comment: it's deleted here, and other servers hear if it was local.
for (const [path, field, kind] of [
  ["/api/v3/post/remove", "post_id", "remove_post"],
  ["/api/v3/comment/remove", "comment_id", "remove_comment"],
] as const) {
  moderationRoutes.post(path, async (c) => {
    const auth = c.get("auth");
    if (!auth) return fail(c, "not_logged_in", 401);
    const params = await body(c);
    const db = c.env.bindings.DB;
    const post = await postByIdAny(db, num(params[field]));
    if (!post) return fail(c, field === "post_id" ? "couldnt_find_post" : "couldnt_find_comment", 404);
    if (!(await canModerate(c, auth.account, post.communityId))) return fail(c, "not_a_moderator", 403);
    const removed = params.removed !== false;
    if (!removed) await restorePost(db, post.id);
    else {
      await deletePost(db, post.id);
      if (!post.apId) c.env.activities.enqueue({ kind: "post_deleted", postId: post.id });
    }
    const reason = typeof params.reason === "string" ? params.reason : null;
    await logMod(db, { kind, modId: auth.account.id, postId: post.id, communityId: post.communityId, reason, value: removed });
    return c.json({ success: true });
  });
}

// --- reports ---------------------------------------------------------------------

async function reportViews(c: C, reports: Report[], comments: boolean) {
  const db = c.env.bindings.DB;
  const people = await accountsByIds(db, reports.flatMap((r) => [r.reporterId, ...(r.resolverId ? [r.resolverId] : [])]));
  const ids = reports.map((r) => r.postId ?? 0);
  if (comments) {
    const found = (await Promise.all(ids.map((id) => threadComment(c, id)))).filter((x): x is ThreadComment => x !== null);
    const views = new Map((await commentViews(c, found)).map((v) => [v.comment.id, v]));
    return reports.flatMap((r) => {
      const view = views.get(r.postId ?? 0);
      const reporter = people.get(r.reporterId);
      if (!view || !reporter) return [];
      const resolver = r.resolverId ? people.get(r.resolverId) : undefined;
      return [
        {
          ...view,
          comment_report: {
            id: r.id,
            creator_id: r.reporterId,
            comment_id: view.comment.id,
            original_comment_text: view.comment.content,
            reason: r.reason,
            resolved: r.resolved,
            ...(r.resolverId ? { resolver_id: r.resolverId } : {}),
            published: iso(r.createdAt),
            ...(r.updatedAt ? { updated: iso(r.updatedAt) } : {}),
          },
          creator: person(c.env, reporter),
          comment_creator: view.creator,
          ...(resolver ? { resolver: person(c.env, resolver) } : {}),
        },
      ];
    });
  }
  const found = (await Promise.all(ids.map((id) => threadPost(c, id)))).filter((x): x is ThreadPost => x !== null);
  const views = new Map((await postViews(c, found)).map((v) => [v.post.id, v]));
  return reports.flatMap((r) => {
    const view = views.get(r.postId ?? 0);
    const reporter = people.get(r.reporterId);
    if (!view || !reporter) return [];
    const resolver = r.resolverId ? people.get(r.resolverId) : undefined;
    return [
      {
        ...view,
        post_report: {
          id: r.id,
          creator_id: r.reporterId,
          post_id: view.post.id,
          original_post_name: view.post.name,
          ...(view.post.url ? { original_post_url: view.post.url } : {}),
          ...(view.post.body ? { original_post_body: view.post.body } : {}),
          reason: r.reason,
          resolved: r.resolved,
          ...(r.resolverId ? { resolver_id: r.resolverId } : {}),
          published: iso(r.createdAt),
          ...(r.updatedAt ? { updated: iso(r.updatedAt) } : {}),
        },
        creator: person(c.env, reporter),
        post_creator: view.creator,
        ...(resolver ? { resolver: person(c.env, resolver) } : {}),
      },
    ];
  });
}

for (const [kind, field, comments] of [
  ["post", "post_id", false],
  ["comment", "comment_id", true],
] as const) {
  moderationRoutes.post(`/api/v3/${kind}/report`, async (c) => {
    const auth = c.get("auth");
    if (!auth) return fail(c, "not_logged_in", 401);
    const params = await body(c);
    const reason = String(params.reason ?? "").trim();
    if (!reason) return fail(c, "report_reason_required");
    const target = comments ? await threadComment(c, num(params[field])) : await threadPost(c, num(params[field]));
    if (!target) return fail(c, comments ? "couldnt_find_comment" : "couldnt_find_post", 404);
    const report = await createReport(c.env.bindings.DB, { reporterId: auth.account.id, postId: target.id, accountId: target.accountId, reason });
    // Someone else's server hears about reports on its content.
    if (target.apId) c.env.activities.enqueue({ kind: "reported", reportId: report.id });
    const [view] = await reportViews(c, [report], comments);
    return c.json(comments ? { comment_report_view: view } : { post_report_view: view });
  });

  moderationRoutes.get(`/api/v3/${kind}/report/list`, async (c) => {
    const auth = c.get("auth");
    if (!auth) return fail(c, "not_logged_in", 401);
    const scope = await reportScope(c, auth.account);
    const only = Number(c.req.query("community_id")) || undefined;
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 50);
    const page = Math.max(Number(c.req.query("page")) || 1, 1);
    const reports = await listReports(c.env.bindings.DB, {
      comments,
      communityIds: only ? (scope === null || scope.includes(only) ? [only] : []) : scope,
      unresolvedOnly: c.req.query("unresolved_only") === "true",
      limit,
      offset: (page - 1) * limit,
    });
    const views = await reportViews(c, reports, comments);
    return c.json(comments ? { comment_reports: views } : { post_reports: views });
  });

  moderationRoutes.put(`/api/v3/${kind}/report/resolve`, async (c) => {
    const auth = c.get("auth");
    if (!auth) return fail(c, "not_logged_in", 401);
    const params = await body(c);
    const db = c.env.bindings.DB;
    const report = await reportById(db, num(params.report_id));
    const target = report?.postId ? await postByIdAny(db, report.postId) : null;
    if (!report || !target) return fail(c, "couldnt_find_report", 404);
    if (!(await canModerate(c, auth.account, target.communityId))) return fail(c, "not_a_moderator", 403);
    await resolveReport(db, report.id, auth.account.id, params.resolved !== false);
    const [view] = await reportViews(c, [(await reportById(db, report.id))!], comments);
    return c.json(comments ? { comment_report_view: view } : { post_report_view: view });
  });
}

moderationRoutes.get("/api/v3/user/report_count", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const counts = await countOpenReports(c.env.bindings.DB, await reportScope(c, auth.account));
  return c.json({ comment_reports: counts.comments, post_reports: counts.posts, private_message_reports: 0 });
});

// --- the mod log --------------------------------------------------------------------

moderationRoutes.get("/api/v3/modlog", async (c) => {
  const db = c.env.bindings.DB;
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 50);
  const page = Math.max(Number(c.req.query("page")) || 1, 1);
  const entries = await listModLog(db, { communityId: Number(c.req.query("community_id")) || undefined, limit, offset: (page - 1) * limit });
  const [people, communities, posts] = await Promise.all([
    accountsByIds(db, entries.flatMap((e) => [e.modId, ...(e.accountId ? [e.accountId] : [])])),
    communitiesByIds(db, entries.map((e) => e.communityId ?? 0)),
    Promise.all([...new Set(entries.map((e) => e.postId).filter((id): id is number => id !== null))].map((id) => postByIdAny(db, id))),
  ]);
  const postById = new Map(posts.filter((p): p is Post & { deleted: boolean } => p !== null).map((p) => [p.id, p]));
  const authors = await accountsByIds(db, [...postById.values()].map((p) => p.accountId));
  const out = {
    removed_posts: [] as unknown[],
    locked_posts: [] as unknown[],
    featured_posts: [] as unknown[],
    removed_comments: [] as unknown[],
    removed_communities: [],
    banned_from_community: [] as unknown[],
    banned: [] as unknown[],
    added_to_community: [] as unknown[],
    transferred_to_community: [],
    added: [],
    admin_purged_persons: [],
    admin_purged_communities: [],
    admin_purged_posts: [],
    admin_purged_comments: [],
    hidden_communities: [],
  };
  for (const e of entries) {
    const moderator = people.get(e.modId);
    const community = e.communityId ? communities.get(e.communityId) : undefined;
    const target = e.accountId ? people.get(e.accountId) : undefined;
    const post = e.postId ? postById.get(e.postId) : undefined;
    const when_ = iso(e.createdAt);
    const mod = moderator ? { moderator: person(c.env, moderator) } : {};
    const communityView = community ? communityObject(c.env, community) : undefined;
    const postView = post ? postObject(c.env, asThreadPost(post), authors.get(post.accountId)) : undefined;
    switch (e.kind) {
      case "remove_post":
        if (postView && communityView) out.removed_posts.push({ mod_remove_post: { id: e.id, mod_person_id: e.modId, post_id: e.postId, ...(e.reason ? { reason: e.reason } : {}), removed: e.value, when_ }, ...mod, post: postView, community: communityView });
        break;
      case "lock_post":
        if (postView && communityView) out.locked_posts.push({ mod_lock_post: { id: e.id, mod_person_id: e.modId, post_id: e.postId, locked: e.value, when_ }, ...mod, post: postView, community: communityView });
        break;
      case "feature_post":
        if (postView && communityView) out.featured_posts.push({ mod_feature_post: { id: e.id, mod_person_id: e.modId, post_id: e.postId, featured: e.value, when_, is_featured_community: e.reason !== "local" }, ...mod, post: postView, community: communityView });
        break;
      case "remove_comment": {
        const author = post ? authors.get(post.accountId) : undefined;
        const root = post?.rootId ? await postByIdAny(db, post.rootId) : null;
        if (post && author && root && communityView) {
          out.removed_comments.push({
            mod_remove_comment: { id: e.id, mod_person_id: e.modId, comment_id: e.postId, ...(e.reason ? { reason: e.reason } : {}), removed: e.value, when_ },
            ...mod,
            comment: comment(c.env, asThreadComment(post), author),
            commenter: person(c.env, author),
            post: postObject(c.env, asThreadPost(root)),
            community: communityView,
          });
        }
        break;
      }
      case "ban_from_community":
        if (target && communityView) out.banned_from_community.push({ mod_ban_from_community: { id: e.id, mod_person_id: e.modId, other_person_id: target.id, community_id: e.communityId, ...(e.reason ? { reason: e.reason } : {}), banned: e.value, when_ }, ...mod, community: communityView, banned_person: person(c.env, target) });
        break;
      case "ban":
        if (target) out.banned.push({ mod_ban: { id: e.id, mod_person_id: e.modId, other_person_id: target.id, ...(e.reason ? { reason: e.reason } : {}), banned: e.value, when_ }, ...mod, banned_person: person(c.env, target) });
        break;
      case "add_mod":
        if (target && communityView) out.added_to_community.push({ mod_add_community: { id: e.id, mod_person_id: e.modId, other_person_id: target.id, community_id: e.communityId, removed: !e.value, when_ }, ...mod, community: communityView, modded_person: person(c.env, target) });
        break;
    }
  }
  return c.json(out);
});
