import { escapeHtml, mentionsIn, textToHtml, urls, type RequestContext } from "@palm/core";
import {
  accountByHandle,
  accountById,
  accountForLogin,
  accountsByIds,
  addMentions,
  attachMedia,
  boost,
  bookmark,
  countFollowers,
  countFollowing,
  countPosts,
  createPost,
  currentVote,
  deletePost,
  describeMedia,
  editPost,
  homeTimeline,
  interactions,
  lastPostAt,
  mediaById,
  mediaForPosts,
  mentionedIds,
  postById,
  postsByAccount,
  postsByIds,
  postsMarkedBy,
  publicTimeline,
  repliesTo,
  storeMedia,
  unboost,
  unbookmark,
  vote,
  type Account,
  type Media,
  type OAuthApp,
  type Page,
  type Post,
  type Visibility,
} from "@palm/db";
import { Hono, type Context } from "hono";
import { account, iso, type AccountStats } from "./views.ts";

type Env = { Bindings: RequestContext; Variables: { account: Account | null; app: OAuthApp | null } };
type C = Context<Env>;

const fail = (c: C, error: string, status: 401 | 403 | 404 | 422 = 422) => c.json({ error }, status);

export const MAX_CHARACTERS = 5000;
export const MAX_ATTACHMENTS = 4;
const VISIBILITIES: Visibility[] = ["public", "unlisted", "private", "direct"];

export { textToHtml };

/** A post's ActivityPub ID: its own if remote, else /objects/{id} on its author's domain. */
const postUriOf = (post: Pick<Post, "apId" | "id">, author: Pick<Account, "domain"> | null, ctx: RequestContext) =>
  post.apId ?? urls.object(author?.domain ?? ctx.domain.domain, String(post.id));

/**
 * A post's HTML as a status. A Lemmy post leads with its title and link, as
 * Mastodon shows a Lemmy post that federates in.
 */
export function statusHtml(post: Post, linkIsAttached = false): string {
  if (!post.title) return post.contentHtml;
  // An image post's link is its picture, which shows as an attachment.
  const link = post.linkUrl && !linkIsAttached
    ? `<p><a href="${escapeHtml(post.linkUrl)}" rel="nofollow noopener" target="_blank">${escapeHtml(post.linkUrl)}</a></p>`
    : "";
  return `<p><strong>${escapeHtml(post.title)}</strong></p>${link}${post.contentHtml}`;
}

/**
 * Whether `viewer` may see `post`: public and unlisted posts, anyone;
 * followers-only, the author and accepted followers; direct, the author and
 * those it mentions.
 */
async function canSee(db: D1Database, post: Post, viewer: Account | null): Promise<boolean> {
  if (post.visibility === "public" || post.visibility === "unlisted") return true;
  if (!viewer) return false;
  if (viewer.id === post.accountId) return true;
  if ((await mentionedIds(db, [post.id])).get(post.id)?.includes(viewer.id)) return true;
  if (post.visibility === "direct") return false;
  const follows = await db
    .prepare("SELECT 1 AS x FROM account_follows WHERE account_id = ? AND target_id = ? AND state = 'accepted'")
    .bind(viewer.id, post.accountId)
    .first();
  return follows !== null;
}

/** Profile counts for an account: palm's own for local ones, the remote server's (as last fetched) for remote ones. */
export async function accountStats(ctx: RequestContext, a: Account): Promise<AccountStats> {
  const db = ctx.bindings.DB;
  if (a.apId) {
    return {
      statuses: a.remoteCounts.statuses ?? (await countPosts(db, a.id)),
      followers: a.remoteCounts.followers ?? 0,
      following: a.remoteCounts.following ?? 0,
      lastStatusAt: await lastPostAt(db, a.id),
    };
  }
  const [statuses, followers, following, lastStatusAt] = await Promise.all([
    countPosts(db, a.id),
    countFollowers(db, a.id),
    countFollowing(db, a.id),
    lastPostAt(db, a.id),
  ]);
  return { statuses, followers, following, lastStatusAt };
}

/** A Mastodon MediaAttachment for an uploaded image. */
export function mediaAttachment(ctx: RequestContext, m: Media, domain = ctx.domain.domain) {
  const url = urls.media(domain, m.file);
  const video = m.contentType.startsWith("video/");
  return {
    id: m.id,
    type: video ? "video" : "image",
    url,
    // Without a still to show, apps play the video itself as its preview.
    preview_url: video ? null : url,
    remote_url: null,
    preview_remote_url: null,
    text_url: null,
    meta: {},
    description: m.description,
    blurhash: null,
  };
}

/** A remote post's attachment, served from where it lives. */
function remoteAttachment(postId: number, index: number, a: Post["attachments"][number]) {
  const kind = a.mediaType?.split("/")[0];
  const type = kind === "video" ? "video" : kind === "audio" ? "audio" : kind === "image" || !a.mediaType ? "image" : "unknown";
  return {
    id: `${postId}${String(index).padStart(2, "0")}`,
    type,
    url: a.url,
    preview_url: type === "image" ? a.url : null,
    remote_url: a.url,
    preview_remote_url: null,
    text_url: null,
    meta: {},
    description: a.description,
    blurhash: null,
  };
}

/**
 * Mastodon Status entities for posts. Authors, parents, media, mentions and
 * counts are each looked up once for the whole list.
 */
export async function statuses(ctx: RequestContext, rows: Post[], viewer: Account | null) {
  const db = ctx.bindings.DB;
  // Boosts are rows that point at the post they boost: show the post inside.
  const boosted = await postsByIds(db, rows.map((r) => r.reblogOf).filter((id): id is number => id !== null));
  const inner = await renderStatuses(ctx, [...boosted.values()], viewer);
  const innerById = new Map(inner.map((s) => [s.id, s]));
  const plain = await renderStatuses(ctx, rows.filter((r) => r.reblogOf === null), viewer);
  const plainById = new Map(plain.map((s) => [s.id, s]));
  const boosters = await accountsByIds(db, rows.filter((r) => r.reblogOf !== null).map((r) => r.accountId));
  return rows.flatMap((row) => {
    if (row.reblogOf === null) return plainById.has(String(row.id)) ? [plainById.get(String(row.id))!] : [];
    const original = innerById.get(String(row.reblogOf));
    const booster = boosters.get(row.accountId);
    if (!original || !booster) return [];
    return [
      {
        ...original,
        id: String(row.id),
        created_at: iso(row.createdAt),
        uri: `${original.uri}#boosts/${row.id}`,
        url: original.url,
        content: "",
        account: account(ctx, booster),
        media_attachments: [],
        mentions: [],
        reblog: original,
        in_reply_to_id: null,
        in_reply_to_account_id: null,
        replies_count: 0,
        reblogs_count: 0,
        favourites_count: 0,
        favourited: false,
        bookmarked: false,
        reblogged: original.reblogged,
      },
    ];
  });
}

/** Statuses for posts (not boosts). */
async function renderStatuses(ctx: RequestContext, posts: Post[], viewer: Account | null) {
  const db = ctx.bindings.DB;
  const parentIds = posts.map((p) => p.parentId).filter((id): id is number => id !== null);
  const [media, mentioned, counts, parents] = await Promise.all([
    mediaForPosts(db, posts.map((p) => p.id)),
    mentionedIds(db, posts.map((p) => p.id)),
    interactions(db, posts.map((p) => p.id), viewer?.id ?? null),
    postsByIds(db, parentIds),
  ]);
  const people = await accountsByIds(db, [
    ...posts.map((p) => p.accountId),
    ...[...mentioned.values()].flat(),
    ...[...parents.values()].map((p) => p.accountId),
  ]);
  const statsFor = new Map<number, AccountStats>();
  for (const id of new Set(posts.map((p) => p.accountId))) {
    const a = people.get(id);
    if (a) statsFor.set(id, await accountStats(ctx, a));
  }

  return posts.flatMap((post) => {
    const author = people.get(post.accountId);
    if (!author) return [];
    const authorView = account(ctx, author, statsFor.get(author.id));
    const parent = post.parentId ? parents.get(post.parentId) : undefined;
    const n = counts.get(post.id);
    const uri = postUriOf(post, author, ctx);
    return [
      {
        id: String(post.id),
        created_at: iso(post.createdAt),
        in_reply_to_id: parent ? String(parent.id) : null,
        in_reply_to_account_id: parent ? String(parent.accountId) : null,
        sensitive: post.sensitive,
        spoiler_text: post.spoilerText,
        visibility: post.visibility,
        language: post.language,
        uri,
        url: post.apId ? (post.url ?? post.apId) : `${authorView.url}/${post.id}`,
        replies_count: n?.replies ?? 0,
        reblogs_count: n?.boosts ?? 0,
        favourites_count: n?.favourites ?? 0,
        quotes_count: 0,
        edited_at: post.updatedAt ? iso(post.updatedAt) : null,
        favourited: n?.favourited ?? false,
        reblogged: n?.boosted ?? false,
        muted: false,
        bookmarked: n?.bookmarked ?? false,
        pinned: false,
        content: statusHtml(
          post,
          !!post.linkUrl &&
            ((media.get(post.id) ?? []).some((m) => post.linkUrl!.endsWith(`/${m.file}`)) ||
              post.attachments.some((a) => a.url === post.linkUrl)),
        ),
        filtered: [],
        reblog: null as unknown,
        application: null,
        account: authorView,
        media_attachments: [
          ...(media.get(post.id) ?? []).map((m) => mediaAttachment(ctx, m, author.domain)),
          ...post.attachments.map((a, i) => remoteAttachment(post.id, i, a)),
        ],
        mentions: (mentioned.get(post.id) ?? []).flatMap((id) => {
          const m = people.get(id);
          if (!m) return [];
          const view = account(ctx, m);
          return [{ id: view.id, username: view.username, acct: view.acct, url: view.url }];
        }),
        tags: [],
        emojis: [],
        card: null,
        poll: null,
      },
    ];
  });
}

/** Mastodon's paging parameters. since_id and min_id both mean "newer than"; palm treats them alike. */
function page(c: C): Page {
  const num = (name: string) => {
    const value = c.req.query(name);
    return value && /^\d+$/.test(value) ? Number(value) : undefined;
  };
  const limit = Math.min(Math.max(num("limit") ?? 20, 1), 40);
  return { maxId: num("max_id"), minId: num("min_id") ?? num("since_id"), limit };
}

/** Sets Mastodon's Link header, so apps can load older and newer pages. */
function linkHeader(c: C, posts: Post[]): void {
  const first = posts[0];
  const last = posts.at(-1);
  if (!first || !last) return;
  const url = new URL(c.req.url);
  url.searchParams.delete("max_id");
  url.searchParams.delete("min_id");
  url.searchParams.delete("since_id");
  const older = new URL(url);
  older.searchParams.set("max_id", String(last.id));
  const newer = new URL(url);
  newer.searchParams.set("min_id", String(first.id));
  c.header("Link", `<${older.href}>; rel="next", <${newer.href}>; rel="prev"`);
}

/** A list of statuses, newest first, with paging links. */
async function statusList(c: C, posts: Post[]) {
  const sorted = posts.sort((a, b) => b.id - a.id);
  linkHeader(c, sorted);
  return c.json(await statuses(c.env, sorted, c.get("account")));
}

/** Request parameters from a JSON or form body; lists (media_ids[]) come back as arrays. */
async function body(c: C): Promise<Record<string, unknown>> {
  const type = c.req.header("content-type") ?? "";
  try {
    if (type.includes("application/json")) return await c.req.json<Record<string, unknown>>();
    if (type.includes("form")) {
      const form = await c.req.parseBody({ all: true });
      return Object.fromEntries(Object.entries(form).map(([k, v]) => [k.replace(/\[\]$/, ""), v]));
    }
  } catch {
    // An unreadable body reads as no parameters.
  }
  return {};
}

const truthy = (value: unknown) => value === true || value === "true" || value === "1";
const text = (value: unknown) => (typeof value === "string" ? value : "");
/** A list parameter, sent as a JSON array or repeated form fields (one field arrives as a string). */
const list = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value]).map(String);

/**
 * The people a status mentions, found by handle: local ones by name, remote
 * ones from what palm knows or by asking their server. Returns them with the
 * map textToHtml uses to link each mention.
 */
async function resolveMentions(c: C, source: string): Promise<{ accounts: Account[]; links: Map<string, string> }> {
  const db = c.env.bindings.DB;
  const accounts: Account[] = [];
  const links = new Map<string, string>();
  for (const handle of mentionsIn(source).slice(0, 10)) {
    const [name, rawHost] = handle.split("@");
    const host = rawHost ?? c.env.domain.domain;
    let found: Account | null = null;
    if (host === c.env.domain.domain) found = (await accountForLogin(db, host, name!))?.account ?? null;
    else {
      found = await accountByHandle(db, name!, host);
      if (!found) {
        const resolved = await c.env.activities.resolve(`@${name}@${host}`);
        if (resolved?.kind === "account") found = await accountById(db, resolved.id);
      }
    }
    if (!found) continue;
    accounts.push(found);
    links.set(handle, account(c.env, found).url);
  }
  return { accounts, links };
}

export const statusRoutes = new Hono<Env>();

statusRoutes.post("/api/v1/statuses", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const db = c.env.bindings.DB;
  const params = await body(c);
  const source = text(params.status).trim();

  const mediaIds = list(params.media_ids);
  if (params.poll) return fail(c, "Polls aren't available on this server yet");
  if (params.scheduled_at) return fail(c, "Scheduled posts aren't available on this server yet");
  if (mediaIds.length > MAX_ATTACHMENTS) return fail(c, `Validation failed: You can attach up to ${MAX_ATTACHMENTS} images`);
  for (const id of mediaIds) {
    const media = await mediaById(db, id);
    if (!media || media.accountId !== me.id || media.postId !== null) return fail(c, "Validation failed: Media not found");
  }
  if (!source && !mediaIds.length) return fail(c, "Validation failed: Text can't be blank");
  if ([...source].length > MAX_CHARACTERS) {
    return fail(c, `Validation failed: Text character limit of ${MAX_CHARACTERS} exceeded`);
  }

  const visibility = (text(params.visibility) || "public") as Visibility;
  if (!VISIBILITIES.includes(visibility)) return fail(c, "Validation failed: Visibility is not included in the list");

  let parent: Post | null = null;
  const replyId = text(params.in_reply_to_id);
  if (replyId) {
    parent = /^\d+$/.test(replyId) ? await postById(db, Number(replyId)) : null;
    if (!parent || !(await canSee(db, parent, me))) return fail(c, "Record not found", 404);
  }
  const parentAuthor = parent ? await accountById(db, parent.accountId) : null;

  const mentions = await resolveMentions(c, source);
  if (visibility === "direct" && !mentions.accounts.length) {
    return fail(c, "Validation failed: Direct messages need someone to mention");
  }

  const post = await createPost(db, {
    accountId: me.id,
    contentSource: source,
    contentHtml: textToHtml(source, mentions.links),
    spoilerText: text(params.spoiler_text).trim(),
    sensitive: truthy(params.sensitive) || text(params.spoiler_text).trim() !== "",
    visibility,
    language: text(params.language) || null,
    inReplyTo: parent ? postUriOf(parent, parentAuthor, c.env) : null,
    parentId: parent?.id ?? null,
    // A reply in a Lemmy thread from a Mastodon app becomes a comment there.
    ...(parent?.communityId ? { communityId: parent.communityId, rootId: parent.rootId ?? parent.id } : {}),
  });
  await attachMedia(db, post.id, me.id, mediaIds);
  await addMentions(db, post.id, mentions.accounts.map((a) => a.id));
  c.env.activities.enqueue({ kind: "post_created", postId: post.id });
  const [status] = await statuses(c.env, [post], me);
  return c.json(status);
});

/** A post the signed-in account (or anyone, if it's public) may see, or null. */
async function visiblePost(c: C): Promise<Post | null> {
  const id = c.req.param("id") ?? "";
  if (!/^\d+$/.test(id)) return null;
  const post = await postById(c.env.bindings.DB, Number(id));
  if (!post || !(await canSee(c.env.bindings.DB, post, c.get("account")))) return null;
  return post;
}

/** A status response, re-read so counts and flags are current. */
async function statusResponse(c: C, id: number) {
  const post = await postById(c.env.bindings.DB, id);
  if (!post) return fail(c, "Record not found", 404);
  const [status] = await statuses(c.env, [post], c.get("account"));
  return c.json(status);
}

statusRoutes.get("/api/v1/statuses/:id", async (c) => {
  const post = await visiblePost(c);
  return post ? statusResponse(c, post.id) : fail(c, "Record not found", 404);
});

statusRoutes.get("/api/v1/statuses/:id/source", async (c) => {
  const post = await visiblePost(c);
  if (!post) return fail(c, "Record not found", 404);
  return c.json({ id: String(post.id), text: post.contentSource, spoiler_text: post.spoilerText });
});

statusRoutes.put("/api/v1/statuses/:id", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const post = await visiblePost(c);
  if (!post || post.accountId !== me.id) return fail(c, "Record not found", 404);
  const source = text((await body(c)).status).trim();
  if (!source || [...source].length > MAX_CHARACTERS) return fail(c, "Validation failed: Text can't be blank");
  const mentions = await resolveMentions(c, source);
  await editPost(c.env.bindings.DB, post.id, { contentSource: source, contentHtml: textToHtml(source, mentions.links) });
  await addMentions(c.env.bindings.DB, post.id, mentions.accounts.map((a) => a.id));
  c.env.activities.enqueue({ kind: "post_updated", postId: post.id });
  return statusResponse(c, post.id);
});

statusRoutes.get("/api/v1/statuses/:id/history", (c) => c.json([]));

statusRoutes.delete("/api/v1/statuses/:id", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const post = await visiblePost(c);
  if (!post || post.accountId !== me.id) return fail(c, "Record not found", 404);
  const [status] = await statuses(c.env, [post], me);
  await deletePost(c.env.bindings.DB, post.id);
  c.env.activities.enqueue({ kind: "post_deleted", postId: post.id });
  // Mastodon answers with the deleted status and its source, for "delete and redraft".
  return c.json({ ...status, text: post.contentSource });
});

statusRoutes.get("/api/v1/statuses/:id/context", async (c) => {
  const post = await visiblePost(c);
  if (!post) return fail(c, "Record not found", 404);
  const viewer = c.get("account");
  const db = c.env.bindings.DB;

  const ancestors: Post[] = [];
  let parentId = post.parentId;
  while (parentId !== null && ancestors.length < 40) {
    const parent = await postById(db, parentId);
    if (!parent || !(await canSee(db, parent, viewer))) break;
    ancestors.unshift(parent);
    parentId = parent.parentId;
  }

  // Breadth-first through replies, oldest first at each level.
  const descendants: Post[] = [];
  const queue = [post];
  while (queue.length && descendants.length < 60) {
    const next = queue.shift()!;
    const author = await accountById(db, next.accountId);
    for (const reply of await repliesTo(db, postUriOf(next, author, c.env))) {
      if (!(await canSee(db, reply, viewer))) continue;
      descendants.push(reply);
      queue.push(reply);
    }
  }

  return c.json({ ancestors: await statuses(c.env, ancestors, viewer), descendants: await statuses(c.env, descendants, viewer) });
});

// --- favourites, boosts and bookmarks ---------------------------------------------

/** Runs `act` on a status the signed-in account can see, then answers with the status. */
function onStatus(act: (c: C, me: Account, post: Post) => Promise<void>) {
  return async (c: C) => {
    const me = c.get("account");
    if (!me) return fail(c, "The access token is invalid", 401);
    const post = await visiblePost(c);
    if (!post) return fail(c, "Record not found", 404);
    await act(c, me, post);
    return statusResponse(c, post.id);
  };
}

/** A favourite is an upvote, shared with Lemmy apps. */
async function setVote(c: C, me: Account, post: Post, score: number) {
  const db = c.env.bindings.DB;
  const previous = await currentVote(db, post.id, me.id);
  if (previous === score) return;
  await vote(db, post.id, me.id, score);
  c.env.activities.enqueue({ kind: "voted", postId: post.id, accountId: me.id, score, previous });
}

statusRoutes.post("/api/v1/statuses/:id/favourite", onStatus((c, me, post) => setVote(c, me, post, 1)));
statusRoutes.post("/api/v1/statuses/:id/unfavourite", onStatus((c, me, post) => setVote(c, me, post, 0)));

statusRoutes.post(
  "/api/v1/statuses/:id/reblog",
  onStatus(async (c, me, post) => {
    if (post.visibility !== "public" && post.visibility !== "unlisted") return;
    await boost(c.env.bindings.DB, post.id, me.id, null);
    c.env.activities.enqueue({ kind: "boosted", postId: post.id, accountId: me.id, undo: false });
  }),
);
statusRoutes.post(
  "/api/v1/statuses/:id/unreblog",
  onStatus(async (c, me, post) => {
    await unboost(c.env.bindings.DB, post.id, me.id);
    c.env.activities.enqueue({ kind: "boosted", postId: post.id, accountId: me.id, undo: true });
  }),
);

statusRoutes.post("/api/v1/statuses/:id/bookmark", onStatus((c, me, post) => bookmark(c.env.bindings.DB, post.id, me.id)));
statusRoutes.post("/api/v1/statuses/:id/unbookmark", onStatus((c, me, post) => unbookmark(c.env.bindings.DB, post.id, me.id)));

// Who favourited or boosted a status: palm keeps the votes and boosts, so it can say.
for (const [path, query] of [
  ["favourited_by", "SELECT account_id FROM votes WHERE post_id = ? AND score = 1"],
  ["reblogged_by", "SELECT account_id FROM boosts WHERE post_id = ?"],
] as const) {
  statusRoutes.get(`/api/v1/statuses/:id/${path}`, async (c) => {
    const post = await visiblePost(c);
    if (!post) return fail(c, "Record not found", 404);
    const { results } = await c.env.bindings.DB.prepare(`${query} LIMIT 80`).bind(post.id).all<{ account_id: number }>();
    const found = await accountsByIds(c.env.bindings.DB, results.map((r) => r.account_id));
    return c.json([...found.values()].map((a) => account(c.env, a)));
  });
}

statusRoutes.get("/api/v1/bookmarks", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  return statusList(c, await postsMarkedBy(c.env.bindings.DB, me.id, "bookmarks", page(c)));
});

statusRoutes.get("/api/v1/favourites", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  return statusList(c, await postsMarkedBy(c.env.bindings.DB, me.id, "favourites", page(c)));
});

// --- timelines ---------------------------------------------------------------------

statusRoutes.get("/api/v1/accounts/:id/statuses", async (c) => {
  const id = c.req.param("id");
  const db = c.env.bindings.DB;
  const author = /^\d+$/.test(id) ? await accountById(db, Number(id)) : null;
  if (!author || (author.apId === null && author.domain !== c.env.domain.domain)) return fail(c, "Record not found", 404);
  // Pinned posts and media filters have nothing to show yet.
  if (truthy(c.req.query("pinned")) || truthy(c.req.query("only_media"))) return c.json([]);
  const me = c.get("account");
  // A remote person's profile, opened from here: fetch their recent posts the first time.
  if (author.apId && !c.req.query("max_id")) await c.env.activities.backfillProfile(author.id);
  const visibilities: Visibility[] = me?.id === author.id ? ["public", "unlisted", "private", "direct"] : ["public", "unlisted"];
  let posts = await postsByAccount(db, author.id, visibilities, page(c));
  if (truthy(c.req.query("exclude_replies"))) posts = posts.filter((p) => !p.inReplyTo);
  return statusList(c, posts);
});

// Home: the signed-in account's posts, and those of the people it follows.
statusRoutes.get("/api/v1/timelines/home", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  return statusList(c, await homeTimeline(c.env.bindings.DB, me.id, page(c)));
});

// Local is this domain's public posts; federated adds every public post palm has met.
statusRoutes.get("/api/v1/timelines/public", async (c) => {
  if (truthy(c.req.query("only_media"))) return c.json([]);
  const db = c.env.bindings.DB;
  const posts = await publicTimeline(db, { local: truthy(c.req.query("local")), domain: c.env.domain.domain }, page(c));
  if (!truthy(c.req.query("remote"))) return statusList(c, posts);
  const people = await accountsByIds(db, posts.map((p) => p.accountId));
  return statusList(c, posts.filter((p) => people.get(p.accountId)?.apId !== null));
});

// --- media -------------------------------------------------------------------------

async function upload(c: C) {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return fail(c, "Validation failed: File can't be blank");
  const description = form?.get("description");
  const stored = await storeMedia(
    c.env.bindings.DB,
    c.env.bindings.MEDIA,
    me.id,
    file,
    typeof description === "string" && description.trim() ? description.trim() : null,
  );
  if (stored === "no_storage") return fail(c, "Uploads aren't available on this server");
  if (stored === "unsupported_type") return fail(c, "Validation failed: File content type is invalid");
  if (stored === "too_large") return fail(c, "Validation failed: File file size must be less than 10 MB (40 MB for video)");
  return c.json(mediaAttachment(c.env, stored));
}

statusRoutes.post("/api/v1/media", upload);
statusRoutes.post("/api/v2/media", upload);

async function ownMedia(c: C): Promise<Media | null> {
  const me = c.get("account");
  const media = me ? await mediaById(c.env.bindings.DB, c.req.param("id") ?? "") : null;
  return media && media.accountId === me?.id ? media : null;
}

statusRoutes.get("/api/v1/media/:id", async (c) => {
  const media = await ownMedia(c);
  return media ? c.json(mediaAttachment(c.env, media)) : fail(c, "Record not found", 404);
});

statusRoutes.put("/api/v1/media/:id", async (c) => {
  const media = await ownMedia(c);
  if (!media) return fail(c, "Record not found", 404);
  const description = text((await body(c)).description).trim() || null;
  await describeMedia(c.env.bindings.DB, media.id, description);
  return c.json(mediaAttachment(c.env, { ...media, description }));
});
