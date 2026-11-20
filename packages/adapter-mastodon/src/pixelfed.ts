import { nodeinfoVersion, type RequestContext } from "@palm/core";
import {
  accountById,
  accountByHandle,
  accountsByIds,
  countAccounts,
  directMessages,
  latestLikers,
  mutualFollowIds,
  popularLocalAccountIds,
  postByIdAny,
  trendingMediaPosts,
  trendingTags,
  updateProfile,
  type Account,
  type OAuthApp,
} from "@palm/db";
import { Hono, type Context } from "hono";
import { isPixelfed } from "./client.ts";
import { accountStats, accountStatsMany, MAX_ATTACHMENTS, MAX_CHARACTERS, statuses } from "./statuses.ts";
import { account, credentialAccount } from "./views.ts";

/**
 * Pixelfed's apps. Pixelfed's API is Mastodon's with extras: a few fields on
 * accounts and statuses (asked for with `_pe=1`), and its own endpoints under
 * /api/v1.1, /api/v1.2 and /api/pixelfed. The official app checks
 * /api/nodeinfo/2.0.json (Pixelfed's own path) for "pixelfed" before signing
 * in; everything else keeps seeing palm as Lemmy there.
 */

type Env = { Bindings: RequestContext; Variables: { account: Account | null; app: OAuthApp | null } };
type C = Context<Env>;

/**
 * The Pixelfed version palm answers as. The App Store app (1.8, Nov 2026)
 * needs 0.14.4 or later; this is pixelfed.social's version at the time.
 */
export const PIXELFED_COMPAT_VERSION = "0.15.2";

/** Max bio length, as Pixelfed's config reports it. */
const MAX_BIO = 500;

export { isPixelfed };

const fail = (c: C, error: string, status: 400 | 401 | 403 | 404 | 422 = 422) => c.json({ error }, status);

const stripHtml = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isAccount = (v: Json) => typeof v.acct === "string" && typeof v.username === "string" && "followers_count" in v;
const isStatus = (v: Json) => Array.isArray(v.media_attachments) && isObject(v.account) && "replies_count" in v;

/** Pixelfed's post types, which its apps use to lay out the profile grid. */
function pfType(status: Json): string {
  const media = (status.media_attachments as Json[]).map((m) => String(m.type));
  if (!media.length) return "text";
  const videos = media.filter((t) => t === "video" || t === "gifv").length;
  if (media.length === 1) return videos ? "video" : "photo";
  if (!videos) return "photo:album";
  return videos === media.length ? "video:album" : "photo:video:album";
}

/** Adds Pixelfed's fields to every account and status in a response, wherever they sit. */
function enrich(value: unknown, likers: Map<string, Json>, depth = 0): void {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) enrich(item, likers, depth + 1);
    return;
  }
  if (!isObject(value)) return;
  if (isAccount(value)) {
    value.local = !String(value.acct).includes("@");
    const source = isObject(value.source) ? value.source : null;
    value.note_text = typeof source?.note === "string" ? source.note : stripHtml(String(value.note ?? ""));
    // palm's admins moderate from Lemmy apps; Pixelfed's admin screens would find nothing here.
    value.is_admin = false;
    value.last_fetched_at = null;
    value.header_bg = null;
    value.pronouns ??= [];
    value.website ??= "";
    if (source) {
      value.settings ??= {
        crawlable: false,
        disable_embeds: false,
        high_contrast_mode: false,
        indexable: false,
        is_suggestable: false,
        media_descriptions: false,
        public_dm: false,
        reduce_motion: false,
        show_atom: false,
        show_profile_follower_count: true,
        show_profile_following_count: true,
        video_autoplay: false,
      };
    }
  }
  if (isStatus(value)) {
    value.pf_type = pfType(value);
    value.reply_count = value.replies_count;
    value.local = !String((value.account as Json).acct).includes("@");
    value.liked_by = likers.get(String(value.id)) ?? null;
    value.comments_disabled = false;
    value.place = null;
    value.liked_at ??= null;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (key !== "source" && key !== "settings" && (isObject(inner) || Array.isArray(inner))) enrich(inner, likers, depth + 1);
  }
}

/** Status IDs in a response, for finding who liked each. */
function statusIds(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  if (Array.isArray(value)) for (const item of value) statusIds(item, out, depth + 1);
  else if (isObject(value)) {
    if (isStatus(value) && Number(value.favourites_count) > 0 && /^\d+$/.test(String(value.id))) out.push(String(value.id));
    for (const inner of Object.values(value)) if (isObject(inner) || Array.isArray(inner)) statusIds(inner, out, depth + 1);
  }
  return out;
}

/** "Liked by X and others": the latest liker of each status, for the whole page at once. */
async function likedBy(c: C, ids: string[]): Promise<Map<string, Json>> {
  const out = new Map<string, Json>();
  const likers = await latestLikers(c.env.bindings.DB, ids.map(Number));
  const people = await accountsByIds(c.env.bindings.DB, [...likers.values()].map((l) => l.accountId));
  for (const [postId, liker] of likers) {
    const who = people.get(liker.accountId);
    if (!who) continue;
    const view = account(c.env, who);
    out.set(String(postId), { id: view.id, username: view.acct, url: view.url, others: liker.total > 1, total_count: liker.total, total_count_pretty: liker.total });
  }
  return out;
}

/** Middleware: Pixelfed's extra fields on JSON responses to Pixelfed apps. */
export async function pixelfedExtras(c: C, next: () => Promise<void>): Promise<void> {
  await next();
  if (c.req.header("x-palm-internal") || !isPixelfed(c)) return;
  const res = c.res;
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) return;
  const body: unknown = await res.clone().json().catch(() => undefined);
  if (body === undefined) return;
  enrich(body, await likedBy(c, statusIds(body)));
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  c.res = new Response(JSON.stringify(body), { status: res.status, headers });
}

/** Runs another of palm's Mastodon endpoints as the same person. */
async function internal(c: C, method: string, path: string, body?: unknown): Promise<Response> {
  const { handleMastodon } = await import("./index.ts");
  const headers = new Headers({ "x-palm-internal": "1", "content-type": "application/json" });
  const auth = c.req.header("authorization");
  if (auth) headers.set("authorization", auth);
  return handleMastodon(new Request(`https://${c.env.host}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), c.env);
}

/** Accounts as Mastodon shows them, with their counts. */
async function accountViews(c: C, accounts: Account[]) {
  const stats = await accountStatsMany(c.env, accounts);
  return accounts.map((a) => account(c.env, a, stats.get(a.id)));
}

async function accountsInOrder(c: C, ids: number[]): Promise<Account[]> {
  const found = await accountsByIds(c.env.bindings.DB, ids);
  return ids.flatMap((id) => {
    const a = found.get(id);
    return a && !a.banned && !a.deleted ? [a] : [];
  });
}

export const pixelfedRoutes = new Hono<Env>();

// --- signing in -------------------------------------------------------------

pixelfedRoutes.get("/api/nodeinfo/2.0.json", async (c) =>
  c.json({
    version: "2.0",
    software: { name: "pixelfed", version: `${PIXELFED_COMPAT_VERSION}+palm.${nodeinfoVersion(c.env.version).split("+palm.")[1] ?? c.env.version}` },
    protocols: ["activitypub"],
    services: { inbound: [], outbound: [] },
    openRegistrations: false,
    usage: { users: { total: await countAccounts(c.env.bindings.DB, c.env.domain.domain) }, localPosts: 0 },
    metadata: { nodeName: c.env.config.instance.name },
  }),
);

// Pixelfed takes its profile changes as POST too (avatars come this way).
pixelfedRoutes.post("/api/v1/accounts/update_credentials", async (c) => {
  const { handleMastodon } = await import("./index.ts");
  const url = new URL(c.req.url);
  return handleMastodon(new Request(url, { method: "PATCH", headers: c.req.raw.headers, body: c.req.raw.body }), c.env);
});

// --- settings ---------------------------------------------------------------

pixelfedRoutes.get("/api/v2/config", (c) =>
  c.json({
    open_registration: false,
    uploader: {
      max_photo_size: 10_240,
      max_caption_length: MAX_CHARACTERS,
      max_altext_length: 1500,
      album_limit: MAX_ATTACHMENTS,
      image_quality: 80,
      max_collection_length: 0,
      optimize_image: false,
      optimize_video: false,
      media_types: "image/jpeg,image/png,image/gif,image/webp,video/mp4",
      mime_types: ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4"],
      enforce_account_limit: false,
    },
    activitypub: { enabled: true, remote_follow: true },
    ab: { lc: false, rlc: false, dc: false, hls: false },
    site: { name: c.env.config.instance.name, domain: c.env.domain.domain, url: `https://${c.env.domain.domain}`, description: "" },
    account: { max_avatar_size: 10_240, max_bio_length: MAX_BIO, max_name_length: 30, min_password_length: 8, max_account_size: 0 },
    username: { remote: { formats: ["@"], format: "@", custom: null } },
    features: {
      timelines: { local: true, network: true },
      mobile_apis: true,
      stories: false,
      video: true,
      import: { instagram: false, mastodon: false, pixelfed: false },
      label: { covid: { enabled: false, org: "", url: "" } },
      hls: { enabled: false },
      groups: false,
    },
  }),
);

// What the App Store app (1.8) reads before signing in: its version needs 0.14.4.
pixelfedRoutes.get("/api/v2.1/config", (c) =>
  c.json({
    version: PIXELFED_COMPAT_VERSION,
    oauth: true,
    signup: { curated: false, mobile_registration: false },
    features: {
      stories: false,
      video: true,
      timelines: { local: true, network: true },
      collections: { api_version: "1.2", add_others_posts: false },
      content_credentials: { enabled: false, signing: false, ai_labels: false },
    },
    limits: {
      account: { max_avatar_size: 10_240, max_bio_length: MAX_BIO, max_name_length: 30, min_password_length: 8 },
      collections: { max_collection_length: 0, max_collections_per_post: 0 },
      direct_messages: {
        max_characters: MAX_CHARACTERS,
        max_media_attachments: MAX_ATTACHMENTS,
        group_chats: { enabled: false, max_participants: 0 },
      },
      media: {
        image_size_limit: 10_240 * 1024,
        max_album_limit: MAX_ATTACHMENTS,
        max_alt_text_length: 1500,
        supported_mime_types: ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4"],
        video_size_limit: 40 * 1024 * 1024,
      },
      statuses: { max_characters: MAX_CHARACTERS },
    },
  }),
);

// Boosts in the home feed: palm shows them, as Mastodon does, and keeps no setting.
for (const method of ["get", "post"] as const) {
  pixelfedRoutes[method]("/api/v2.1/account/timeline/settings", (c) => {
    if (!c.get("account")) return fail(c, "The access token is invalid", 401);
    return c.json({ reblogs_enabled: true, photo_reblogs_only: false });
  });
}

pixelfedRoutes.get("/api/v1.1/compose/settings", (c) =>
  c.json({
    allowed_media_types: ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4"],
    max_caption_length: MAX_CHARACTERS,
    default_license: 1,
    media_descriptions: false,
    max_file_size: 10_240,
    max_media_attachments: MAX_ATTACHMENTS,
    max_altext_length: 1500,
    default_scope: c.get("account")?.locked ? "private" : "public",
  }),
);

/** Pixelfed's app settings. palm doesn't keep them: the app gets its defaults back. */
const APP_SETTINGS = {
  timelines: { show_public: false, show_network: false, hide_likes_shares: false },
  media: { hide_public_behind_cw: true, always_show_cw: false, show_alt_text: false },
  appearance: { links_use_in_app_browser: true, theme: "system" },
};
for (const method of ["get", "post"] as const) {
  pixelfedRoutes[method]("/api/pixelfed/v1/app/settings", (c) => {
    const me = c.get("account");
    if (!me) return fail(c, "The access token is invalid", 401);
    return c.json({ id: String(me.id), username: me.username, updated_at: null, common: APP_SETTINGS });
  });
}

pixelfedRoutes.get("/api/v1.1/nag/state", (c) => c.json({ active: false }));

// Pixelfed's push goes through pixelfed.org's gateway, which palm can't use;
// Pixelfed servers without it answer the same. Mastodon's web push still works.
pixelfedRoutes.on(["GET", "POST"], "/api/v1.1/push/:action{state|compare|update|disable}", (c) =>
  fail(c, "Push notifications are not supported on this server.", 404),
);

// --- accounts ---------------------------------------------------------------

pixelfedRoutes.get("/api/v1.1/accounts/username/:username", async (c) => {
  if (!c.get("account")) return fail(c, "The access token is invalid", 401);
  const name = decodeURIComponent(c.req.param("username")).replace(/^@/, "");
  const [username, host] = name.split("@");
  const db = c.env.bindings.DB;
  const found = username ? await accountByHandle(db, username, host ?? c.env.domain.domain) : null;
  if (!found || found.banned || found.deleted) return c.json([]);
  return c.json(account(c.env, found, await accountStats(c.env, found)));
});

pixelfedRoutes.get("/api/v1.1/accounts/mutuals/:id{[0-9]+}", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  return c.json(await accountViews(c, await accountsInOrder(c, await mutualFollowIds(c.env.bindings.DB, me.id, Number(c.req.param("id"))))));
});

pixelfedRoutes.delete("/api/v1.1/accounts/avatar", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const db = c.env.bindings.DB;
  await updateProfile(db, me.id, { avatarUrl: null });
  c.env.activities.enqueue({ kind: "profile_updated", accountId: me.id });
  const updated = (await accountById(db, me.id))!;
  return c.json(credentialAccount(c.env, updated, await accountStats(c.env, updated)));
});

pixelfedRoutes.post("/api/v1.1/report", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const params = await c.req.json<Json>().catch((): Json => ({}));
  const objectId = Number(params.object_id);
  const comment = [String(params.report_type ?? "other"), typeof params.message === "string" ? params.message : ""].filter(Boolean).join(": ");
  let body: Json | null = null;
  if (params.object_type === "user") body = { account_id: String(objectId), comment };
  else if (params.object_type === "post" || params.object_type === "direct_message") {
    const post = await postByIdAny(c.env.bindings.DB, objectId);
    if (post) body = { account_id: String(post.accountId), status_ids: [String(post.id)], comment };
  }
  if (!body) return c.json({ error: "Invalid object id", error_code: "ERROR_INVALID_OBJECT_ID" }, 400);
  const res = await internal(c, "POST", "/api/v1/reports", body);
  return res.ok ? c.json({ msg: "Successfully sent report", code: 200 }) : res;
});

// --- discover -----------------------------------------------------------------

const trending = (c: C, days: number, localOnly: boolean) =>
  trendingMediaPosts(c.env.bindings.DB, { domain: c.env.domain.domain, localOnly, days });

pixelfedRoutes.get("/api/v1.1/discover/posts/trending", async (c) => {
  const range = c.req.query("range");
  const days = range === "daily" ? 1 : range === "monthly" ? 31 : 365;
  return c.json(await statuses(c.env, await trending(c, days, true), c.get("account")));
});

pixelfedRoutes.get("/api/v1.1/discover/posts/network/trending", async (c) =>
  c.json(await statuses(c.env, await trending(c, 7, false), c.get("account"))),
);

pixelfedRoutes.get("/api/v1.1/discover/posts/hashtags", async (c) =>
  c.json(
    (await trendingTags(c.env.bindings.DB, 7)).map((r, i) => ({
      id: i + 1,
      total: r.total,
      name: `#${r.tag}`,
      hashtag: r.tag,
      url: `https://${c.env.domain.domain}/tags/${encodeURIComponent(r.tag)}`,
    })),
  ),
);

for (const path of ["/api/v1.1/discover/accounts/popular", "/api/v1.2/discover/accounts/popular"]) {
  pixelfedRoutes.get(path, async (c) => {
    const ids = await popularLocalAccountIds(c.env.bindings.DB, c.env.domain.domain, c.get("account")?.id ?? 0);
    return c.json(await accountViews(c, await accountsInOrder(c, ids)));
  });
}

pixelfedRoutes.get("/api/v1/tags/:tag{[^/]+}/related", (c) => c.json([]));
// The app asks for a tag with a trailing slash.
pixelfedRoutes.get("/api/v1/tags/:tag{[^/]+}/", (c) => internal(c, "GET", `/api/v1/tags/${c.req.param("tag")}`));

// --- stories and collections: palm has neither ---------------------------------

for (const path of ["/api/v1.1/stories/carousel", "/api/v1.2/stories/carousel"]) pixelfedRoutes.get(path, (c) => c.json({ nodes: [] }));
pixelfedRoutes.get("/api/v1.2/stories/mention-autocomplete", (c) => c.json([]));
pixelfedRoutes.get("/api/v1.2/stories/viewers", (c) => c.json([]));
pixelfedRoutes.post("/api/v1.1/stories/seen", (c) => c.json({ code: 200 }));
pixelfedRoutes.on(["POST"], ["/api/v1.1/stories/*", "/api/v1.2/stories/*"], (c) => fail(c, "Stories aren't available on this server.", 422));
for (const path of ["/api/v1.1/collections/self", "/api/v1.2/collections/self", "/api/v1.1/collections/accounts/:id"]) {
  pixelfedRoutes.get(path, (c) => c.json([]));
}

// --- direct messages: palm's are direct posts, as Mastodon's are ----------------

pixelfedRoutes.get("/api/v1.1/direct/compose/mutuals", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  return c.json(await accountViews(c, await accountsInOrder(c, await mutualFollowIds(c.env.bindings.DB, me.id, me.id, 40))));
});

/** A message as Pixelfed's chat screen shows it. */
function messageView(status: Json, me: Account) {
  const media = (status.media_attachments as Json[]).map((m) => ({ id: String(m.id), url: String(m.url), type: String(m.type) }));
  const author = status.account as Json;
  // Messages start with the mention that addresses them; the chat shows the rest.
  const text = stripHtml(String(status.content ?? "")).replace(/^(@[\w.-]+(@[\w.-]+)?\s*)+/, "");
  return {
    id: String(status.id),
    hidden: false,
    isAuthor: author.id === String(me.id),
    type: media.length ? (media[0]!.type === "video" ? "video" : "photo") : "text",
    text,
    media: media[0]?.url ?? null,
    carousel: media,
    created_at: status.created_at,
    timeAgo: "",
    seen: true,
    reportId: String(status.id),
    meta: null,
  };
}

pixelfedRoutes.get("/api/v1.1/direct/thread", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const db = c.env.bindings.DB;
  const other = await accountById(db, Number(c.req.query("pid")));
  if (!other || other.deleted) return fail(c, "Record not found", 404);
  const maxId = Number(c.req.query("max_id")) || undefined;
  const minId = Number(c.req.query("min_id")) || undefined;
  let found = await directMessages(db, me.id, { withAccountId: other.id, limit: minId ? 40 : 8, maxId });
  // Only the two of them: a group message with others in it belongs elsewhere.
  found = found.filter((m) => [m.post.accountId, ...m.recipientIds].every((id) => id === me.id || id === other.id));
  if (minId) found = found.filter((m) => m.post.id > minId).slice(-8);
  const rendered = await statuses(c.env, found.map((m) => m.post), me);
  const view = account(c.env, other);
  return c.json({
    id: String(other.id),
    name: view.display_name,
    username: view.acct,
    avatar: view.avatar,
    url: view.url,
    muted: false,
    isLocal: other.apId === null,
    domain: other.apId ? other.domain : null,
    created_at: view.created_at,
    updated_at: view.created_at,
    timeAgo: "",
    lastMessage: "",
    messages: (rendered as unknown as Json[]).map((s) => messageView(s, me)),
    conversation_id: null,
  });
});

pixelfedRoutes.post("/api/v1.1/direct/thread/send", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const params = await c.req.json<Json>().catch((): Json => ({}));
  const to = await accountById(c.env.bindings.DB, Number(params.to_id));
  const message = typeof params.message === "string" ? params.message.trim() : "";
  if (!to || to.deleted || to.id === me.id || !message) return fail(c, "Invalid recipient or message", 422);
  const handle = to.apId ? `@${to.username}@${to.domain}` : `@${to.username}`;
  const res = await internal(c, "POST", "/api/v1/statuses", { status: `${handle} ${message}`, visibility: "direct" });
  if (!res.ok) return res;
  return c.json(messageView(await res.json<Json>(), me));
});

pixelfedRoutes.delete("/api/v1.1/direct/thread/message", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const id = c.req.query("id");
  if (!id || !/^\d+$/.test(id)) return fail(c, "Record not found", 404);
  const res = await internal(c, "DELETE", `/api/v1/statuses/${id}`);
  return res.ok ? c.json([Number(id)]) : res;
});

pixelfedRoutes.post("/api/v1.1/direct/thread/read", (c) => c.json({ code: 200 }));
