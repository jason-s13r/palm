import { escapeHtml, textToHtml, urls, type RequestContext } from "@palm/core";
import {
  accountById,
  countFollowers,
  countPosts,
  createPost,
  deletePost,
  lastPostAt,
  attachMedia,
  describeMedia,
  localPublicPosts,
  mediaById,
  mediaForPosts,
  storeMedia,
  postById,
  postsByAccount,
  repliesTo,
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
const VISIBILITIES: Visibility[] = ["public", "unlisted", "private", "direct"];

/** The ActivityPub ID of a local post. */
export const postUri = (ctx: RequestContext, id: number) => urls.object(ctx.domain.domain, String(id));

/** A local post's ID from its ActivityPub ID, or null for anything else. */
function localPostId(ctx: RequestContext, uri: string | null): number | null {
  const prefix = urls.object(ctx.domain.domain, "");
  if (!uri?.startsWith(prefix)) return null;
  const id = uri.slice(prefix.length);
  return /^\d+$/.test(id) ? Number(id) : null;
}

export { textToHtml };

/**
 * A post's HTML as a status. A Lemmy post leads with its title and link, as
 * Mastodon shows a Lemmy post that federates in.
 */
export function statusHtml(post: Post): string {
  if (!post.title) return post.contentHtml;
  const link = post.linkUrl
    ? `<p><a href="${escapeHtml(post.linkUrl)}" rel="nofollow noopener" target="_blank">${escapeHtml(post.linkUrl)}</a></p>`
    : "";
  return `<p><strong>${escapeHtml(post.title)}</strong></p>${link}${post.contentHtml}`;
}

/** Whether `viewer` may see `post`. Followers-only needs the follow graph; for now only the author. */
function canSee(post: Post, viewer: Account | null): boolean {
  if (post.visibility === "public" || post.visibility === "unlisted") return true;
  return viewer?.id === post.accountId;
}

async function stats(ctx: RequestContext, a: Account): Promise<AccountStats> {
  const db = ctx.bindings.DB;
  const [statuses, followers, lastStatusAt] = await Promise.all([
    countPosts(db, a.id),
    countFollowers(db, a.id),
    lastPostAt(db, a.id),
  ]);
  return { statuses, followers, lastStatusAt };
}

/** Profile counts for an account, for the account endpoints. */
export const accountStats = stats;

/** A Mastodon MediaAttachment for an uploaded image. */
export function mediaAttachment(ctx: RequestContext, m: Media) {
  const url = urls.media(ctx.domain.domain, m.file);
  return {
    id: m.id,
    type: "image",
    url,
    preview_url: url,
    remote_url: null,
    preview_remote_url: null,
    text_url: null,
    meta: {},
    description: m.description,
    blurhash: null,
  };
}

/** Mastodon Status entities for posts, with their authors and reply targets looked up once each. */
async function statuses(ctx: RequestContext, posts: Post[]) {
  const db = ctx.bindings.DB;
  const media = await mediaForPosts(db, posts.map((p) => p.id));
  const authors = new Map<number, Promise<ReturnType<typeof account> | null>>();
  const authorOf = (id: number) => {
    let found = authors.get(id);
    if (!found) {
      found = accountById(db, id).then(async (a) => (a ? account(ctx, a, await stats(ctx, a)) : null));
      authors.set(id, found);
    }
    return found;
  };

  return Promise.all(
    posts.map(async (post) => {
      const author = await authorOf(post.accountId);
      const parentId = localPostId(ctx, post.inReplyTo);
      const parent = parentId === null ? null : await postById(db, parentId);
      const uri = postUri(ctx, post.id);
      return {
        id: String(post.id),
        created_at: iso(post.createdAt),
        in_reply_to_id: parent ? String(parent.id) : null,
        in_reply_to_account_id: parent ? String(parent.accountId) : null,
        sensitive: post.sensitive,
        spoiler_text: post.spoilerText,
        visibility: post.visibility,
        language: post.language,
        uri,
        url: author ? `${author.url}/${post.id}` : uri,
        replies_count: 0,
        reblogs_count: 0,
        favourites_count: 0,
        quotes_count: 0,
        edited_at: null,
        favourited: false,
        reblogged: false,
        muted: false,
        bookmarked: false,
        pinned: false,
        content: statusHtml(post),
        filtered: [],
        reblog: null,
        application: null,
        account: author,
        media_attachments: (media.get(post.id) ?? []).map((m) => mediaAttachment(ctx, m)),
        mentions: [],
        tags: [],
        emojis: [],
        card: null,
        poll: null,
      };
    }),
  );
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

/** Posts newest first, whichever way the page was asked for. */
const newestFirst = (posts: Post[]) => posts.sort((a, b) => b.id - a.id);

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

export const MAX_ATTACHMENTS = 4;

export const statusRoutes = new Hono<Env>();

statusRoutes.post("/api/v1/statuses", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const params = await body(c);
  const source = text(params.status).trim();

  const mediaIds = list(params.media_ids);
  if (params.poll) return fail(c, "Polls aren't available on this server yet");
  if (params.scheduled_at) return fail(c, "Scheduled posts aren't available on this server yet");
  if (mediaIds.length > MAX_ATTACHMENTS) return fail(c, `Validation failed: You can attach up to ${MAX_ATTACHMENTS} images`);
  for (const id of mediaIds) {
    const media = await mediaById(c.env.bindings.DB, id);
    if (!media || media.accountId !== me.id || media.postId !== null) return fail(c, "Validation failed: Media not found");
  }
  if (!source && !mediaIds.length) return fail(c, "Validation failed: Text can't be blank");
  if ([...source].length > MAX_CHARACTERS) {
    return fail(c, `Validation failed: Text character limit of ${MAX_CHARACTERS} exceeded`);
  }

  const visibility = (text(params.visibility) || "public") as Visibility;
  if (!VISIBILITIES.includes(visibility)) return fail(c, "Validation failed: Visibility is not included in the list");
  // Direct messages need mentions, which palm doesn't parse yet.
  if (visibility === "direct") return fail(c, "Direct messages aren't available on this server yet");

  let inReplyTo: string | null = null;
  const replyId = text(params.in_reply_to_id);
  if (replyId) {
    const parent = /^\d+$/.test(replyId) ? await postById(c.env.bindings.DB, Number(replyId)) : null;
    if (!parent || !canSee(parent, me)) return fail(c, "Record not found", 404);
    inReplyTo = postUri(c.env, parent.id);
  }

  const post = await createPost(c.env.bindings.DB, {
    accountId: me.id,
    contentSource: source,
    contentHtml: textToHtml(source),
    spoilerText: text(params.spoiler_text).trim(),
    sensitive: truthy(params.sensitive) || text(params.spoiler_text).trim() !== "",
    visibility,
    language: text(params.language) || null,
    inReplyTo,
  });
  await attachMedia(c.env.bindings.DB, post.id, me.id, mediaIds);
  c.env.activities.postCreated(post);
  const [status] = await statuses(c.env, [post]);
  return c.json(status);
});

/** A post the signed-in account (or anyone, if it's public) may see, or null. */
async function visiblePost(c: C): Promise<Post | null> {
  const id = c.req.param("id") ?? "";
  if (!/^\d+$/.test(id)) return null;
  const post = await postById(c.env.bindings.DB, Number(id));
  if (!post || !canSee(post, c.get("account"))) return null;
  const author = await accountById(c.env.bindings.DB, post.accountId);
  return author?.domain === c.env.domain.domain ? post : null;
}

statusRoutes.get("/api/v1/statuses/:id", async (c) => {
  const post = await visiblePost(c);
  if (!post) return fail(c, "Record not found", 404);
  const [status] = await statuses(c.env, [post]);
  return c.json(status);
});

statusRoutes.get("/api/v1/statuses/:id/source", async (c) => {
  const post = await visiblePost(c);
  if (!post) return fail(c, "Record not found", 404);
  return c.json({ id: String(post.id), text: post.contentSource, spoiler_text: post.spoilerText });
});

statusRoutes.delete("/api/v1/statuses/:id", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const post = await visiblePost(c);
  if (!post || post.accountId !== me.id) return fail(c, "Record not found", 404);
  const [status] = await statuses(c.env, [post]);
  await deletePost(c.env.bindings.DB, post.id);
  c.env.activities.postDeleted(post);
  // Mastodon answers with the deleted status and its source, for "delete and redraft".
  return c.json({ ...status, text: post.contentSource });
});

statusRoutes.get("/api/v1/statuses/:id/context", async (c) => {
  const post = await visiblePost(c);
  if (!post) return fail(c, "Record not found", 404);
  const viewer = c.get("account");
  const db = c.env.bindings.DB;

  const ancestors: Post[] = [];
  let parentId = localPostId(c.env, post.inReplyTo);
  while (parentId !== null && ancestors.length < 40) {
    const parent = await postById(db, parentId);
    if (!parent || !canSee(parent, viewer)) break;
    ancestors.unshift(parent);
    parentId = localPostId(c.env, parent.inReplyTo);
  }

  // Breadth-first through local replies, oldest first at each level.
  const descendants: Post[] = [];
  const queue = [post];
  while (queue.length && descendants.length < 60) {
    const next = queue.shift()!;
    for (const reply of await repliesTo(db, postUri(c.env, next.id))) {
      if (!canSee(reply, viewer)) continue;
      descendants.push(reply);
      queue.push(reply);
    }
  }

  return c.json({ ancestors: await statuses(c.env, ancestors), descendants: await statuses(c.env, descendants) });
});

statusRoutes.get("/api/v1/statuses/:id/favourited_by", (c) => c.json([]));
statusRoutes.get("/api/v1/statuses/:id/reblogged_by", (c) => c.json([]));

statusRoutes.get("/api/v1/accounts/:id/statuses", async (c) => {
  const id = c.req.param("id");
  const author = /^\d+$/.test(id) ? await accountById(c.env.bindings.DB, Number(id)) : null;
  if (!author || author.domain !== c.env.domain.domain) return fail(c, "Record not found", 404);
  // Pinned posts and media filters have nothing to show yet.
  if (truthy(c.req.query("pinned")) || truthy(c.req.query("only_media"))) return c.json([]);
  const visibilities: Visibility[] =
    c.get("account")?.id === author.id ? ["public", "unlisted", "private", "direct"] : ["public", "unlisted"];
  let posts = newestFirst(await postsByAccount(c.env.bindings.DB, author.id, visibilities, page(c)));
  if (truthy(c.req.query("exclude_replies"))) posts = posts.filter((p) => !p.inReplyTo);
  linkHeader(c, posts);
  return c.json(await statuses(c.env, posts));
});

// Home is the signed-in account's own posts until following others brings theirs in.
statusRoutes.get("/api/v1/timelines/home", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const posts = newestFirst(
    await postsByAccount(c.env.bindings.DB, me.id, ["public", "unlisted", "private", "direct"], page(c)),
  );
  linkHeader(c, posts);
  return c.json(await statuses(c.env, posts));
});

// palm only has its own posts, so the federated timeline is the local one.
statusRoutes.get("/api/v1/timelines/public", async (c) => {
  if (truthy(c.req.query("only_media")) || truthy(c.req.query("remote"))) return c.json([]);
  const posts = newestFirst(await localPublicPosts(c.env.bindings.DB, c.env.domain.domain, page(c)));
  linkHeader(c, posts);
  return c.json(await statuses(c.env, posts));
});

// --- media -------------------------------------------------------------------

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
  if (stored === "too_large") return fail(c, "Validation failed: File file size must be less than 10 MB");
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
