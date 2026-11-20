import { escapeHtml, hashtagsIn, htmlToText, mentionsIn, previewLink, textToHtml, urls, type RequestContext } from "@palm/core";
import {
  claimIdempotencyKey,
  idempotentPost,
  settleIdempotencyKey,
  cancelScheduled,
  pollChoices,
  pollsFor,
  postByUri,
  postVersions,
  rescheduleStatus,
  savePoll,
  scheduledStatuses,
  scheduleStatus,
  setQuote,
  votePoll,
  type Poll,
  type ScheduledStatus,
  filtersOf,
  matchFilters,
  pinnedIds,
  pinnedPosts,
  pinPost,
  unpinPost,
  directMessages,
  markMessagesRead,
  type DirectMessage,
  cardsFor,
  type LinkCard,
  hiddenFor,
  isHidden,
  NOTHING_HIDDEN,
  accountByHandle,
  accountById,
  accountForLogin,
  accountsByIds,
  addMentions,
  addTags,
  postsTagged,
  tagsFor,
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
  postIdsByApIds,
  accountCounts,
  followState,
  authorizeQuote,
  effectiveQuotePolicy,
  isQuotePolicy,
  setPostQuotePolicy,
  setQuoteState,
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
import { clientOf } from "./client.ts";
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
  return (await accountStatsMany(ctx, [a])).get(a.id)!;
}

/**
 * Counts for the accounts on a page of statuses, in one query. Other
 * servers' people are kept for a few minutes, so a busy timeline doesn't
 * count them on every page; people here are counted fresh, so your own
 * counts change as soon as you post or follow.
 */
const STATS_TTL_MS = 3 * 60 * 1000;
const statsCache = new WeakMap<D1Database, Map<number, { stats: AccountStats; at: number }>>();

export async function accountStatsMany(ctx: RequestContext, accounts: Account[]): Promise<Map<number, AccountStats>> {
  const db = ctx.bindings.DB;
  let cache = statsCache.get(db);
  if (!cache) statsCache.set(db, (cache = new Map()));
  const now = Date.now();
  const out = new Map<number, AccountStats>();
  const missing: Account[] = [];
  for (const a of accounts) {
    const hit = cache.get(a.id);
    if (hit && now - hit.at < STATS_TTL_MS) out.set(a.id, hit.stats);
    else missing.push(a);
  }
  const counts = await accountCounts(db, [...new Set(missing.map((a) => a.id))]);
  for (const a of missing) {
    const c = counts.get(a.id) ?? { statuses: 0, followers: 0, following: 0, lastStatusAt: null };
    // A remote person's own counts are better than what palm has seen of them.
    const stats = a.apId
      ? { statuses: a.remoteCounts.statuses ?? c.statuses, followers: a.remoteCounts.followers ?? 0, following: a.remoteCounts.following ?? 0, lastStatusAt: c.lastStatusAt }
      : c;
    if (a.apId) cache.set(a.id, { stats, at: now });
    out.set(a.id, stats);
  }
  return out;
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

/** A remote post's attachment, through palm's media cache. */
function remoteAttachment(ctx: RequestContext, postId: number, index: number, a: Post["attachments"][number]) {
  const kind = a.mediaType?.split("/")[0];
  const type = kind === "video" ? "video" : kind === "audio" ? "audio" : kind === "image" || !a.mediaType ? "image" : "unknown";
  const url = urls.proxy(ctx.domain.domain, a.url);
  return {
    id: `${postId}${String(index).padStart(2, "0")}`,
    type,
    url,
    preview_url: type === "image" ? url : null,
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
  // People, servers and communities the viewer blocked or muted drop out,
  // boosts of them included; the viewer's own posts always show.
  const [hidden, filters, boosted] = await Promise.all([
    hiddenFor(db, viewer?.id),
    viewer ? filtersOf(db, viewer.id) : Promise.resolve([]),
    postsByIds(db, rows.map((r) => r.reblogOf).filter((id): id is number => id !== null)),
  ]);
  if (hidden !== NOTHING_HIDDEN) {
    const originals = boosted;
    const [authors, originalAuthors] = await Promise.all([
      accountsByIds(db, rows.map((r) => r.accountId)),
      accountsByIds(db, [...originals.values()].map((p) => p.accountId)),
    ]);
    rows = rows.filter((r) => {
      if (r.accountId === viewer!.id) return true;
      if (isHidden(hidden, authors.get(r.accountId), r.communityId)) return false;
      const original = r.reblogOf !== null ? originals.get(r.reblogOf) : undefined;
      return !original || original.accountId === viewer!.id || !isHidden(hidden, originalAuthors.get(original.accountId), original.communityId);
    });
  }
  // Boosts are rows that point at the post they boost: show the post inside.
  // Boosted and plain posts are rendered together, in one set of lookups.
  const toRender = new Map<number, Post>();
  for (const p of boosted.values()) toRender.set(p.id, p);
  for (const r of rows) if (r.reblogOf === null) toRender.set(r.id, r);
  const [rendered, boosters] = await Promise.all([
    renderStatuses(ctx, [...toRender.values()], viewer),
    accountsByIds(db, rows.filter((r) => r.reblogOf !== null).map((r) => r.accountId)),
  ]);
  const innerById = new Map(rendered.map((s) => [s.id, s]));
  const plainById = innerById;
  const shown = rows.flatMap((row) => {
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
  if (!filters.length) return shown;
  // Keyword filters: "hide" drops the status, "warn" marks it for the app to fold.
  return shown.flatMap((status) => {
    const inner = (status.reblog ?? status) as { content: string; spoiler_text: string; account: { id: string } };
    if (inner.account.id === String(viewer!.id)) return [status];
    const matched = matchFilters(filters, `${inner.spoiler_text} ${htmlToText(inner.content)}`);
    if (matched.some((m) => m.filter.action === "hide")) return [];
    if (!matched.length) return [status];
    return [
      {
        ...status,
        filtered: matched.map((m) => ({
          filter: {
            id: String(m.filter.id),
            title: m.filter.title,
            context: m.filter.context,
            expires_at: m.filter.expiresAt ? new Date(m.filter.expiresAt * 1000).toISOString() : null,
            filter_action: m.filter.action,
          },
          keyword_matches: m.matches,
          status_matches: [],
        })),
      },
    ];
  });
}

/** Statuses for posts (not boosts). */
async function renderStatuses(ctx: RequestContext, posts: Post[], viewer: Account | null, nested = false) {
  const db = ctx.bindings.DB;
  const parentIds = posts.map((p) => p.parentId).filter((id): id is number => id !== null);
  const ids = posts.map((p) => p.id);
  const links = new Map(posts.map((p) => [p.id, previewLink(p)]));
  const authorIds = [...new Set(posts.map((p) => p.accountId))];
  // Everything that depends only on the posts, in one round.
  const [media, mentioned, counts, parents, tags, pins, polls, choices, cards, followed, quotedPosts] = await Promise.all([
    mediaForPosts(db, ids),
    mentionedIds(db, ids),
    interactions(db, ids, viewer?.id ?? null),
    postsByIds(db, parentIds),
    tagsFor(db, ids),
    pinnedIds(db, ids),
    pollsFor(db, ids),
    pollChoices(db, viewer?.id, ids),
    cardsFor(db, [...links.values()].filter((l): l is string => l !== null)),
    followedAmong(db, viewer, authorIds),
    nested ? Promise.resolve(new Map<string, Post>()) : quotedPostsFor(ctx, posts),
  ]);
  const people = await accountsByIds(db, [
    ...authorIds,
    ...[...mentioned.values()].flat(),
    ...[...parents.values()].map((p) => p.accountId),
  ]);
  // Quoted posts palm holds, shown inside the quote (one level deep).
  const quotedRender: Promise<{ id: string }[]> = quotedPosts.size
    ? (renderStatuses(ctx, [...quotedPosts.values()], viewer, true) as Promise<unknown> as Promise<{ id: string }[]>)
    : Promise.resolve([]);
  const [statsFor, quotedStatuses]: [Map<number, AccountStats>, { id: string }[]] = await Promise.all([
    accountStatsMany(ctx, authorIds.flatMap((id) => people.get(id) ?? [])),
    quotedRender,
  ]);
  const quotedById = new Map<string, unknown>(quotedStatuses.map((s) => [s.id, s]));

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
        pinned: pins.has(post.id),
        content: statusHtml(
          post,
          !!post.linkUrl &&
            ((media.get(post.id) ?? []).some((m) => post.linkUrl!.endsWith(`/${m.file}`)) ||
              post.attachments.some((a) => a.url === post.linkUrl)),
        ),
        filtered: [],
        reblog: null as unknown,
        application: post.apId === null && post.clientApp ? { name: post.clientApp, website: null } : null,
        account: authorView,
        media_attachments: [
          ...(media.get(post.id) ?? []).map((m) => mediaAttachment(ctx, m, author.domain)),
          ...post.attachments.map((a, i) => remoteAttachment(ctx, post.id, i, a)),
        ],
        mentions: (mentioned.get(post.id) ?? []).flatMap((id) => {
          const m = people.get(id);
          if (!m) return [];
          const view = account(ctx, m);
          return [{ id: view.id, username: view.username, acct: view.acct, url: view.url }];
        }),
        tags: (tags.get(post.id) ?? []).map((t) => ({ name: t, url: urls.tag(ctx.domain.domain, t) })),
        emojis: [],
        card: cardView(ctx, cards.get(links.get(post.id) ?? "")),
        poll: polls.has(post.id) ? pollView(polls.get(post.id)!, choices.get(post.id), viewer) : null,
        quote: post.quoteOf
          ? { state: post.quoteState ?? "accepted", quoted_status: quotedById.get(String(quotedPosts.get(post.quoteOf)?.id ?? "")) ?? null }
          : null,
        quote_approval: quoteApproval(post, author, viewer, followed.has(author.id)),
      },
    ];
  });
}

/** The public or unlisted posts palm holds that these posts quote, by the quoted post's ID, in two queries. */
async function quotedPostsFor(ctx: RequestContext, posts: Post[]): Promise<Map<string, Post>> {
  const db = ctx.bindings.DB;
  const uris = [...new Set(posts.flatMap((p) => (p.quoteOf ? [p.quoteOf] : [])))];
  if (!uris.length) return new Map();
  const byApId = await postIdsByApIds(db, uris);
  // Posts here have no ap_id: their ID is in their URL.
  const idOf = (uri: string) => {
    const found = byApId.get(uri);
    if (found !== undefined) return found;
    const url = new URL(uri);
    const local = url.host === ctx.domain.domain ? /^\/objects\/(\d+)$/.exec(url.pathname) : null;
    return local ? Number(local[1]) : undefined;
  };
  const idByUri = new Map(uris.flatMap((u) => { const id = idOf(u); return id === undefined ? [] : [[u, id] as const]; }));
  const found = await postsByIds(db, [...idByUri.values()]);
  const out = new Map<string, Post>();
  for (const [uri, id] of idByUri) {
    const post = found.get(id);
    if (post && (post.visibility === "public" || post.visibility === "unlisted")) out.set(uri, post);
  }
  return out;
}

/** Which of `authorIds` the viewer follows. */
async function followedAmong(db: D1Database, viewer: Account | null, authorIds: number[]): Promise<Set<number>> {
  if (!viewer || !authorIds.length) return new Set();
  const { results } = await db
    .prepare(`SELECT target_id FROM account_follows WHERE account_id = ? AND state = 'accepted' AND target_id IN (${authorIds.map(() => "?").join(", ")})`)
    .bind(viewer.id, ...authorIds)
    .all<{ target_id: number }>();
  return new Set(results.map((r) => r.target_id));
}

/**
 * Mastodon 4.5's quote_approval: who may quote a status, and whether the
 * viewer may. A remote post that says nothing about quotes is "unknown".
 */
function quoteApproval(post: Post, author: Account, viewer: Account | null, follows: boolean) {
  if (post.apId && post.quotePolicy === null) return { automatic: [], manual: [], current_user: "unknown" };
  const policy = effectiveQuotePolicy(post, author.quotePolicy);
  const allowed = viewer !== null && (viewer.id === author.id || policy === "public" || (policy === "followers" && follows));
  return {
    automatic: policy === "nobody" ? [] : [policy],
    manual: [],
    current_user: viewer === null ? "unknown" : allowed ? "automatic" : "denied",
  };
}

/** Mastodon's PreviewCard for a link palm has a preview of. */
function cardView(ctx: RequestContext, card: LinkCard | undefined) {
  if (!card) return null;
  return {
    url: card.url,
    title: card.title ?? card.url,
    description: card.description ?? "",
    type: "link",
    author_name: "",
    author_url: "",
    provider_name: card.provider ?? "",
    provider_url: "",
    html: "",
    width: card.image ? 400 : 0,
    height: card.image ? 210 : 0,
    image: card.image ? urls.proxy(ctx.domain.domain, card.image) : null,
    image_description: "",
    embed_url: "",
    blurhash: null,
    language: null,
    published_at: null,
    authors: [],
  };
}

/** Mastodon's paging parameters. since_id and min_id both mean "newer than"; palm treats them alike. */
export function page(c: C): Page {
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
export async function statusList(c: C, posts: Post[]) {
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

/** Where a hashtag links: its page on this domain. */
const tagLink = (c: C) => (tag: string) => urls.tag(c.env.domain.domain, tag);

/** Mastodon's Tag entity. */
export const tagView = (ctx: RequestContext, tag: string) => ({ name: tag, url: urls.tag(ctx.domain.domain, tag), history: [], following: false });

export const statusRoutes = new Hono<Env>();

statusRoutes.post("/api/v1/statuses", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  // A moved account posts from its new home, as on Mastodon. Scheduled posts
  // come through here too, so they stop as well.
  if (me.movedTo) return fail(c, `This account has moved to ${me.movedTo}`, 403);
  const db = c.env.bindings.DB;
  const params = await body(c);
  const source = text(params.status).trim();

  const mediaIds = list(params.media_ids);
  const poll = pollParams(params);
  if (poll === "invalid") return fail(c, "Validation failed: A poll needs 2 to 4 options and an expiry");
  if (poll && mediaIds.length) return fail(c, "Validation failed: Polls can't have media");
  // A post for later: kept as it was asked for, and published by the cron.
  const scheduledAt = text(params.scheduled_at) ? Date.parse(text(params.scheduled_at)) : NaN;
  if (Number.isFinite(scheduledAt)) {
    if (scheduledAt < Date.now() + 5 * 60 * 1000) return fail(c, "Validation failed: Scheduled time must be at least 5 minutes in the future");
    const app = c.get("app");
    if (!app) return fail(c, "The access token is invalid", 401);
    const { scheduled_at: _, ...rest } = params;
    const scheduled = await scheduleStatus(db, { accountId: me.id, appId: app.id, scheduledAt: Math.floor(scheduledAt / 1000), params: rest });
    return c.json(scheduledView(scheduled));
  }
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

  // A retry of a post already made (or being made) gets that post back.
  const key = (c.req.header("idempotency-key") ?? "").trim().slice(0, 128);
  if (key) {
    const claim = await claimIdempotencyKey(db, me.id, key);
    if (!claim.claimed) {
      const madeId = claim.postId ?? (await waitForIdempotentPost(db, me.id, key));
      const made = madeId ? await postById(db, madeId) : null;
      if (!made) return c.json({ error: "This status is still being posted" }, 409);
      const [status] = await statuses(c.env, [made], me);
      return c.json(status);
    }
  }

  const post = await createPost(db, {
    accountId: me.id,
    ...clientOf(c),
    contentSource: source,
    contentHtml: textToHtml(source, mentions.links, tagLink(c)),
    spoilerText: text(params.spoiler_text).trim(),
    sensitive: truthy(params.sensitive) || text(params.spoiler_text).trim() !== "",
    visibility,
    language: text(params.language) || null,
    inReplyTo: parent ? postUriOf(parent, parentAuthor, c.env) : null,
    parentId: parent?.id ?? null,
    // A reply in a Lemmy thread from a Mastodon app becomes a comment there.
    ...(parent?.communityId ? { communityId: parent.communityId, rootId: parent.rootId ?? parent.id } : {}),
  }).catch(async (error: unknown) => {
    if (key) await settleIdempotencyKey(db, me.id, key, null);
    throw error;
  });
  if (key) await settleIdempotencyKey(db, me.id, key, post.id);
  await attachMedia(db, post.id, me.id, mediaIds);
  await addMentions(db, post.id, mentions.accounts.map((a) => a.id));
  await addTags(db, post.id, hashtagsIn(source));
  if (poll) {
    await savePoll(db, {
      postId: post.id,
      options: poll.options.map((title) => ({ title, votes: 0 })),
      multiple: poll.multiple,
      expiresAt: Math.floor(Date.now() / 1000) + poll.expiresIn,
      votersCount: 0,
    });
  }
  // Who may quote this one (Mastodon 4.5), when it isn't the account's default.
  const policy = text(params.quote_approval_policy);
  if (isQuotePolicy(policy)) await setPostQuotePolicy(db, post.id, policy);
  // A quote: the quoted post's ActivityPub ID, which other servers resolve.
  // A post here is approved (or not) at once; another server's is asked when
  // the post goes out (post_created).
  const quotedId = text(params.quoted_status_id);
  if (quotedId && /^\d+$/.test(quotedId)) {
    const quoted = await postById(db, Number(quotedId));
    if (quoted && (quoted.visibility === "public" || quoted.visibility === "unlisted") && (await canSee(db, quoted, me))) {
      const quotedAuthor = await accountById(db, quoted.accountId);
      const quotedUri = postUriOf(quoted, quotedAuthor, c.env);
      await setQuote(db, post.id, quotedUri);
      if (quotedAuthor && !quoted.apId) {
        const rule = effectiveQuotePolicy(quoted, quotedAuthor.quotePolicy);
        const allowed =
          me.id === quotedAuthor.id || rule === "public" || (rule === "followers" && (await followState(db, me.id, quotedAuthor.id))?.state === "accepted");
        if (allowed) {
          const approval = await authorizeQuote(db, quoted.id, postUriOf(post, me, c.env), urls.user(me.domain, me.username));
          await setQuoteState(db, post.id, "accepted", `${urls.user(quotedAuthor.domain, quotedAuthor.username)}/quotes/${approval}`);
        } else {
          await setQuoteState(db, post.id, "rejected");
        }
      } else {
        await setQuoteState(db, post.id, "pending");
      }
    }
  }
  c.env.activities.enqueue({ kind: "post_created", postId: post.id });
  const [status] = await statuses(c.env, [(await postById(db, post.id)) ?? post], me);
  return c.json(status);
});

/** A retry that arrives while the first request is still posting waits a few seconds for its post. */
async function waitForIdempotentPost(db: D1Database, accountId: number, key: string): Promise<number | null> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const id = await idempotentPost(db, accountId, key);
    if (id !== null) return id;
  }
  return null;
}

/** Poll parameters, from JSON (poll.options) or a form (poll[options][]). */
function pollParams(params: Record<string, unknown>): { options: string[]; expiresIn: number; multiple: boolean } | "invalid" | null {
  const nested = (typeof params.poll === "object" && params.poll !== null ? params.poll : {}) as Record<string, unknown>;
  const options = list(nested.options ?? params["poll[options]"]).map((o) => o.trim()).filter(Boolean);
  if (!options.length && !params.poll) return null;
  const expiresIn = Number(nested.expires_in ?? params["poll[expires_in]"]);
  if (options.length < 2 || options.length > 4 || !(expiresIn >= 300 && expiresIn <= 30 * 24 * 3600)) return "invalid";
  return { options: options.map((o) => o.slice(0, 50)), expiresIn, multiple: truthy(nested.multiple ?? params["poll[multiple]"]) };
}

const scheduledView = (s: ScheduledStatus) => ({
  id: String(s.id),
  scheduled_at: new Date(s.scheduledAt * 1000).toISOString(),
  params: {
    text: text(s.params.status),
    poll: s.params.poll ?? null,
    media_ids: list(s.params.media_ids),
    sensitive: truthy(s.params.sensitive),
    spoiler_text: text(s.params.spoiler_text) || null,
    visibility: text(s.params.visibility) || "public",
    scheduled_at: null,
    in_reply_to_id: text(s.params.in_reply_to_id) || null,
    language: text(s.params.language) || null,
    application_id: s.appId,
    idempotency: null,
    with_rate_limit: false,
  },
  media_attachments: [],
});

statusRoutes.get("/api/v1/scheduled_statuses", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  return c.json((await scheduledStatuses(c.env.bindings.DB, me.id)).map(scheduledView));
});

statusRoutes.get("/api/v1/scheduled_statuses/:id{[0-9]+}", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const found = (await scheduledStatuses(c.env.bindings.DB, me.id)).find((s) => s.id === Number(c.req.param("id")));
  return found ? c.json(scheduledView(found)) : fail(c, "Record not found", 404);
});

statusRoutes.put("/api/v1/scheduled_statuses/:id{[0-9]+}", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const at = Date.parse(text((await body(c)).scheduled_at));
  if (!Number.isFinite(at) || at < Date.now() + 5 * 60 * 1000) return fail(c, "Validation failed: Scheduled time must be at least 5 minutes in the future");
  await rescheduleStatus(c.env.bindings.DB, me.id, Number(c.req.param("id")), Math.floor(at / 1000));
  const found = (await scheduledStatuses(c.env.bindings.DB, me.id)).find((s) => s.id === Number(c.req.param("id")));
  return found ? c.json(scheduledView(found)) : fail(c, "Record not found", 404);
});

statusRoutes.delete("/api/v1/scheduled_statuses/:id{[0-9]+}", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  await cancelScheduled(c.env.bindings.DB, me.id, Number(c.req.param("id")));
  return c.json({});
});

// --- polls ---------------------------------------------------------------------

function pollView(poll: Poll, own: number[] | undefined, viewer: Account | null) {
  const expired = poll.expiresAt !== null && poll.expiresAt * 1000 <= Date.now();
  return {
    id: String(poll.postId),
    expires_at: poll.expiresAt ? new Date(poll.expiresAt * 1000).toISOString() : null,
    expired,
    multiple: poll.multiple,
    votes_count: poll.options.reduce((sum, o) => sum + o.votes, 0),
    voters_count: poll.votersCount,
    options: poll.options.map((o) => ({ title: o.title, votes_count: o.votes })),
    emojis: [],
    ...(viewer ? { voted: (own?.length ?? 0) > 0, own_votes: own ?? [] } : {}),
  };
}

statusRoutes.get("/api/v1/polls/:id{[0-9]+}", async (c) => {
  const post = await postById(c.env.bindings.DB, Number(c.req.param("id")));
  if (!post || !(await canSee(c.env.bindings.DB, post, c.get("account")))) return fail(c, "Record not found", 404);
  const poll = (await pollsFor(c.env.bindings.DB, [post.id])).get(post.id);
  if (!poll) return fail(c, "Record not found", 404);
  const me = c.get("account");
  const own = (await pollChoices(c.env.bindings.DB, me?.id, [post.id])).get(post.id);
  return c.json(pollView(poll, own, me));
});

statusRoutes.post("/api/v1/polls/:id{[0-9]+}/votes", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const db = c.env.bindings.DB;
  const post = await postById(db, Number(c.req.param("id")));
  if (!post || !(await canSee(db, post, me))) return fail(c, "Record not found", 404);
  const choices = list((await body(c)).choices).map(Number);
  // A remote poll is counted by its server, which palm tells; a local one here.
  if (!(await votePoll(db, post.id, me.id, choices, post.apId === null))) return fail(c, "Validation failed: You have already voted on this poll, or it has ended");
  if (post.apId) c.env.activities.enqueue({ kind: "poll_voted", postId: post.id, accountId: me.id });
  const poll = (await pollsFor(db, [post.id])).get(post.id)!;
  const own = (await pollChoices(db, me.id, [post.id])).get(post.id);
  return c.json(pollView(poll, own, me));
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
  await editPost(c.env.bindings.DB, post.id, { contentSource: source, contentHtml: textToHtml(source, mentions.links, tagLink(c)) });
  await addMentions(c.env.bindings.DB, post.id, mentions.accounts.map((a) => a.id));
  await addTags(c.env.bindings.DB, post.id, hashtagsIn(source));
  c.env.activities.enqueue({ kind: "post_updated", postId: post.id });
  return statusResponse(c, post.id);
});

statusRoutes.get("/api/v1/statuses/:id/history", async (c) => {
  const post = await visiblePost(c);
  if (!post) return fail(c, "Record not found", 404);
  const [current] = await statuses(c.env, [post], c.get("account"));
  if (!current) return fail(c, "Record not found", 404);
  const versions = await postVersions(c.env.bindings.DB, post.id);
  const entry = (v: { contentHtml: string; spoilerText: string; sensitive: boolean; createdAt: number }) => ({
    content: v.contentHtml,
    spoiler_text: v.spoilerText,
    sensitive: v.sensitive,
    created_at: iso(v.createdAt),
    account: current.account,
    poll: null,
    media_attachments: current.media_attachments,
    emojis: [],
  });
  return c.json([
    ...versions.map(entry),
    { ...entry({ contentHtml: current.content as string, spoilerText: post.spoilerText, sensitive: post.sensitive, createdAt: post.updatedAt ?? post.createdAt }) },
  ]);
});

// Who may quote a status (Mastodon 4.5). Other servers hear of the change
// through an Update; approvals already given stand.
statusRoutes.put("/api/v1/statuses/:id/interaction_policy", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const post = await visiblePost(c);
  if (!post || post.accountId !== me.id) return fail(c, "Record not found", 404);
  const policy = text((await body(c)).quote_approval_policy);
  if (!isQuotePolicy(policy)) return fail(c, "Validation failed: Quote approval policy is not included in the list", 422);
  await setPostQuotePolicy(c.env.bindings.DB, post.id, policy);
  c.env.activities.enqueue({ kind: "post_updated", postId: post.id });
  return statusResponse(c, post.id);
});

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
  // A remote thread: bring in replies it had before anyone here followed along.
  if (post.apId && post.parentId === null) await c.env.activities.backfillThread(post.id);

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
  const me = c.get("account");
  // Pinned posts: the five on the profile, not paged.
  if (truthy(c.req.query("pinned"))) {
    if (c.req.query("max_id")) return c.json([]);
    const pins = (await pinnedPosts(db, author.id)).filter((p) => me?.id === author.id || p.visibility === "public" || p.visibility === "unlisted");
    return c.json(await statuses(c.env, pins, me));
  }
  // A remote person's profile, opened from here: fetch their recent posts the first time.
  if (author.apId && !c.req.query("max_id")) await c.env.activities.backfillProfile(author.id);
  const visibilities: Visibility[] = me?.id === author.id ? ["public", "unlisted", "private", "direct"] : ["public", "unlisted"];
  let posts = await postsByAccount(db, author.id, visibilities, page(c));
  if (truthy(c.req.query("exclude_replies"))) posts = posts.filter((p) => !p.inReplyTo);
  if (truthy(c.req.query("exclude_reblogs"))) posts = posts.filter((p) => p.reblogOf === null);
  if (truthy(c.req.query("only_media"))) {
    const media = await mediaForPosts(db, posts.map((p) => p.id));
    posts = posts.filter((p) => p.attachments.length > 0 || (media.get(p.id)?.length ?? 0) > 0);
  }
  return statusList(c, posts);
});

// Home: the signed-in account's posts, and those of the people it follows.
statusRoutes.get("/api/v1/timelines/home", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  return statusList(c, await homeTimeline(c.env.bindings.DB, me.id, page(c)));
});

statusRoutes.get("/api/v1/timelines/tag/:tag", async (c) => statusList(c, await postsTagged(c.env.bindings.DB, c.req.param("tag"), page(c))));

statusRoutes.get("/api/v1/tags/:tag", (c) => c.json(tagView(c.env, c.req.param("tag").toLowerCase())));

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

// --- conversations: direct messages, grouped by who's in them ---------------

/** A viewer's direct messages, grouped by the people in them, newest first. */
async function conversations(c: C, me: Account) {
  const messages = await directMessages(c.env.bindings.DB, me.id, { limit: 200 });
  const groups = new Map<string, DirectMessage[]>();
  for (const m of messages) {
    const others = [...new Set([m.post.accountId, ...m.recipientIds])].filter((id) => id !== me.id).sort((a, b) => a - b);
    const key = others.join(",");
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  // A conversation's ID is its first message's: stable as long as that message is.
  return [...groups.entries()].map(([key, list]) => ({
    id: Math.min(...list.map((m) => m.post.id)),
    others: key ? key.split(",").map(Number) : [],
    messages: list,
  }));
}

statusRoutes.get("/api/v1/conversations", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 40);
  const maxId = Number(c.req.query("max_id")) || Infinity;
  const all = (await conversations(c, me)).filter((g) => g.messages[0]!.post.id < maxId).slice(0, limit);
  const people = await accountsByIds(c.env.bindings.DB, all.flatMap((g) => g.others));
  const latest = await statuses(c.env, all.map((g) => g.messages[0]!.post), me);
  const byId = new Map(latest.map((s) => [s.id, s]));
  return c.json(
    all.flatMap((g) => {
      const last = byId.get(String(g.messages[0]!.post.id));
      if (!last) return [];
      return [
        {
          id: String(g.id),
          unread: g.messages.some((m) => !m.read),
          accounts: g.others.flatMap((id) => (people.has(id) ? [account(c.env, people.get(id)!)] : [])),
          last_status: last,
        },
      ];
    }),
  );
});

statusRoutes.post("/api/v1/conversations/:id{[0-9]+}/read", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const group = (await conversations(c, me)).find((g) => g.id === Number(c.req.param("id")));
  if (!group) return fail(c, "Record not found", 404);
  await markMessagesRead(c.env.bindings.DB, me.id, group.messages.map((m) => m.post.id));
  const people = await accountsByIds(c.env.bindings.DB, group.others);
  const [last] = await statuses(c.env, [group.messages[0]!.post], me);
  return c.json({ id: String(group.id), unread: false, accounts: group.others.flatMap((id) => (people.has(id) ? [account(c.env, people.get(id)!)] : [])), last_status: last ?? null });
});

// Removing a conversation only hides it in Mastodon; palm marks it read.
statusRoutes.delete("/api/v1/conversations/:id{[0-9]+}", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const group = (await conversations(c, me)).find((g) => g.id === Number(c.req.param("id")));
  if (group) await markMessagesRead(c.env.bindings.DB, me.id, group.messages.map((m) => m.post.id));
  return c.json({});
});

// --- pinning: up to five of your own public posts on your profile ----------

for (const [action, on] of [["pin", true], ["unpin", false]] as const) {
  statusRoutes.post(`/api/v1/statuses/:id{[0-9]+}/${action}`, async (c) => {
    const me = c.get("account");
    if (!me) return fail(c, "The access token is invalid", 401);
    const post = await visiblePost(c);
    if (!post || post.accountId !== me.id) return fail(c, "Record not found", 404);
    if (on) {
      if (post.visibility === "direct" || post.reblogOf !== null) return fail(c, "Validation failed: Only your own public posts can be pinned", 422);
      if (!(await pinPost(c.env.bindings.DB, me.id, post.id))) return fail(c, "Validation failed: You have already pinned the maximum number of posts", 422);
    } else {
      await unpinPost(c.env.bindings.DB, me.id, post.id);
    }
    return statusResponse(c, post.id);
  });
}
