import { signRequest } from "@fedify/fedify/sig";
import { Mention, Note } from "@fedify/fedify/vocab";
import { urls, type FederationTask, type RequestContext } from "@palm/core";
import {
  accountByApId,
  accountById,
  blockedDomains,
  createStory,
  endStory,
  followers,
  hasLocalFollowers,
  isLive,
  knownSoftware,
  MEDIA_TYPES,
  recordStoryView,
  rememberSoftware,
  storyByApId,
  storyById,
  type Account,
  type Story,
} from "@palm/db";
import { actorUri, followersUri } from "./objects.ts";
import { ensureAccount, storeRemotePost } from "./remote.ts";
import { contextsFor, logProblem, personKeys } from "./shared.ts";

/**
 * Pixelfed's stories over ActivityPub. Pixelfed doesn't put a story in an
 * activity: it sends its followers' servers an `Add` naming a bearcap (a URL
 * and a token), and they fetch the story with the token, within its day.
 *
 * - `Add {type: Story, object: "bear:?t=…&u=…"}`: a new story.
 * - `Delete {type: Story}`: taken down early (expiry needs no message).
 * - `View {type: Story, object: <story>}`: someone saw it.
 * - `Story:Reply` / `Story:Reaction`: an answer, kept as a direct message.
 *
 * Pixelfed only sends these to servers whose nodeinfo says "pixelfed", so
 * palm answers Pixelfed's nodeinfo fetches as Pixelfed (see the worker), and
 * sends its own only to servers that show stories: Pixelfed, and other palms.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const idOf = (v: unknown): string | null => (typeof v === "string" ? v : isObject(v) && typeof v.id === "string" ? v.id : null);
const typeOf = (v: unknown): string | null => {
  if (!isObject(v)) return null;
  const type = Array.isArray(v.type) ? v.type[0] : v.type;
  return typeof type === "string" ? type : null;
};
const hostOf = (url: string | null): string | null => {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

const AS_CONTEXT = "https://www.w3.org/ns/activitystreams";

// --- bearcaps -----------------------------------------------------------------

export const bearcap = (url: string, token: string) => `bear:?t=${token}&u=${url}`;

/** A bearcap's URL and token. Pixelfed writes them unescaped, so they're split by hand. */
export function decodeBearcap(value: string): { url: string; token: string } | null {
  if (!value.startsWith("bear:?")) return null;
  let url: string | null = null;
  let token: string | null = null;
  for (const part of value.slice(6).split("&")) {
    if (part.startsWith("t=")) token = part.slice(2);
    else if (part.startsWith("u=")) url = part.slice(2);
  }
  if (!url || !token || !url.startsWith("https://")) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }
  return { url, token };
}

// --- a local story as ActivityPub ---------------------------------------------

export const storyUri = (story: Story, author: Pick<Account, "domain" | "username" | "apId">) =>
  story.apId ?? urls.story(author.domain, author.username, story.id);

/** A local story's upload, as it's served: `/pictrs/image/{id}.{ext}`. */
const uploadUrl = (story: Story, author: Pick<Account, "domain">) =>
  urls.media(author.domain, `${story.mediaId}.${MEDIA_TYPES[story.contentType] ?? "bin"}`);


/** A local story, as Pixelfed fetches it. */
export function storyObject(story: Story, author: Account): Json {
  return {
    "@context": AS_CONTEXT,
    id: storyUri(story, author),
    type: "Story",
    to: [followersUri(author).href],
    cc: [],
    attributedTo: actorUri(author).href,
    published: new Date(story.createdAt * 1000).toISOString(),
    expiresAt: new Date(story.expiresAt * 1000).toISOString(),
    duration: story.duration,
    can_reply: story.canReply,
    can_react: story.canReact,
    attachment: {
      type: story.type === "video" ? "Video" : "Image",
      url: uploadUrl(story, author),
      mediaType: story.contentType,
    },
  };
}

const STORY_PATH = /^\/stories\/([^/]+)\/(\d+)$/;

/**
 * GET /stories/{name}/{id}: the story for a server holding its bearcap token.
 * Anything else (a browser, a missing or wrong token) gets null, and falls
 * through to the web pages.
 */
export async function serveStory(request: Request, ctx: RequestContext): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const match = STORY_PATH.exec(new URL(request.url).pathname);
  if (!match) return null;
  const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();
  if (!token) return null;
  const db = ctx.bindings.DB;
  const story = await storyById(db, Number(match[2]));
  if (!story || story.apId || !story.token || !isLive(story) || !timingSafeEqual(story.token, token)) return notFound();
  const author = await accountById(db, story.accountId);
  if (!author || author.apId || author.username.toLowerCase() !== decodeURIComponent(match[1]!).toLowerCase()) return notFound();
  return new Response(JSON.stringify(storyObject(story, author)), {
    headers: { "content-type": "application/activity+json; charset=utf-8", "cache-control": "private, no-store" },
  });
}

const notFound = () => new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- which servers show stories -----------------------------------------------

/**
 * Whether a server shows stories: Pixelfed, or another palm. Read from its
 * nodeinfo and kept a week (server_software).
 */
export async function showsStories(db: D1Database, host: string): Promise<boolean> {
  let known = await knownSoftware(db, host);
  if (!known) {
    known = await fetchSoftware(host);
    await rememberSoftware(db, host, known.software, known.version);
  }
  return known.software === "pixelfed" || (known.version ?? "").includes("+palm.");
}

async function fetchSoftware(host: string): Promise<{ software: string | null; version: string | null }> {
  const none = { software: null, version: null };
  const get = async (url: string) => {
    const res = await fetch(url, { headers: { accept: "application/json" }, redirect: "follow", signal: AbortSignal.timeout(5000) }).catch(() => null);
    return res?.ok ? ((await res.json().catch(() => null)) as Json | null) : null;
  };
  const wellKnown = await get(`https://${host}/.well-known/nodeinfo`);
  const links = Array.isArray(wellKnown?.links) ? (wellKnown.links as Json[]) : [];
  const href = links.map((l) => (typeof l.href === "string" ? l.href : null)).find((h) => hostOf(h) === host.toLowerCase());
  if (!href) return none;
  const info = await get(href);
  const software = isObject(info?.software) ? info.software : null;
  if (!software) return none;
  return {
    software: typeof software.name === "string" ? software.name.toLowerCase() : null,
    version: typeof software.version === "string" ? software.version : null,
  };
}

// --- sending ------------------------------------------------------------------

/** Signs an activity as a local person and posts it to one inbox. */
async function deliver(ctx: RequestContext, from: Account, inbox: string, activity: Json): Promise<void> {
  const { people } = await contextsFor(ctx);
  const key = (await personKeys(people, from))[0];
  if (!key) return;
  const body = JSON.stringify(activity);
  const request = await signRequest(
    new Request(inbox, {
      method: "POST",
      headers: { "content-type": "application/activity+json", accept: "application/activity+json" },
      body,
    }),
    key.privateKey,
    key.keyId,
    { spec: "draft-cavage-http-signatures-12", body: new TextEncoder().encode(body).buffer as ArrayBuffer },
  );
  const res = await fetch(request).catch((error: unknown) => {
    logProblem("story_delivery_failed", { inbox, error: String(error) });
    return null;
  });
  if (res && !res.ok) logProblem("story_delivery_refused", { inbox, status: res.status });
  await res?.body?.cancel().catch(() => undefined);
}

/** The inboxes of a local person's followers on servers that show stories, one per server. */
async function storyAudience(ctx: RequestContext, author: Account): Promise<string[]> {
  const db = ctx.bindings.DB;
  const blocked = await blockedDomains(db);
  const byHost = new Map<string, string>();
  for (const f of await followers(db, author.id)) {
    const inbox = f.sharedInbox ?? f.inbox;
    const host = hostOf(inbox);
    if (!host || byHost.has(host) || ctx.config.domains.some((d) => d.domain === host)) continue;
    if (blocked.some((d) => host === d || host.endsWith(`.${d}`))) continue;
    byHost.set(host, inbox);
  }
  const out: string[] = [];
  for (const [host, inbox] of byHost) if (await showsStories(db, host)) out.push(inbox);
  return out;
}

const storyTasks = new Set<FederationTask["kind"]>(["story_published", "story_deleted", "story_viewed", "story_replied"]);
export const isStoryTask = (task: FederationTask): task is Extract<FederationTask, { kind: `story_${string}` }> => storyTasks.has(task.kind);

export async function runStoryTask(ctx: RequestContext, task: Extract<FederationTask, { kind: `story_${string}` }>): Promise<void> {
  const db = ctx.bindings.DB;
  const story = await storyById(db, task.storyId);
  if (!story) return;
  const author = await accountById(db, story.accountId);
  if (!author) return;
  switch (task.kind) {
    case "story_published":
    case "story_deleted": {
      if (author.apId) return;
      const id = storyUri(story, author);
      const activity =
        task.kind === "story_published"
          ? story.token && isLive(story)
            ? {
                "@context": AS_CONTEXT,
                id: `${id}/activity`,
                type: "Add",
                actor: actorUri(author).href,
                to: [followersUri(author).href],
                object: { id, type: "Story", object: bearcap(id, story.token) },
              }
            : null
          : { "@context": AS_CONTEXT, id: `${id}#delete`, type: "Delete", actor: actorUri(author).href, object: { id, type: "Story" } };
      if (!activity) return;
      for (const inbox of await storyAudience(ctx, author)) await deliver(ctx, author, inbox, activity);
      return;
    }
    case "story_viewed":
    case "story_replied": {
      if (!author.apId || !author.inbox || !story.apId) return;
      const me = await accountById(db, task.accountId);
      if (!me || me.apId) return;
      const activity =
        task.kind === "story_viewed"
          ? {
              "@context": AS_CONTEXT,
              id: `${actorUri(me).href}#stories/${story.id}/view`,
              type: "View",
              to: author.apId,
              actor: actorUri(me).href,
              object: { type: "Story", object: story.apId },
            }
          : {
              "@context": AS_CONTEXT,
              id: `${actorUri(me).href}#stories/${story.id}/${task.reaction ? "reactions" : "replies"}/${crypto.randomUUID()}`,
              type: task.reaction ? "Story:Reaction" : "Story:Reply",
              to: author.apId,
              actor: actorUri(me).href,
              content: task.text,
              inReplyTo: story.apId,
              published: new Date().toISOString(),
            };
      await deliver(ctx, me, author.inbox, activity);
      return;
    }
  }
}

// --- receiving ----------------------------------------------------------------

/** Whether a delivery is one of Pixelfed's story activities. */
export function isStoryActivity(activity: unknown): boolean {
  const type = typeOf(activity);
  if (type === "Story:Reply" || type === "Story:Reaction") return true;
  if (type !== "Add" && type !== "Delete" && type !== "View") return false;
  return typeOf((activity as Json).object) === "Story";
}

/**
 * Handles a story activity, once its signature has been checked (`signer` is
 * the actor that signed it). Anything that doesn't add up is dropped quietly.
 */
export async function receiveStoryActivity(ctx: RequestContext, activity: Json, signer: string): Promise<void> {
  const db = ctx.bindings.DB;
  const actorId = idOf(activity.actor);
  if (!actorId || actorId !== signer) return;
  const actorHost = hostOf(actorId)!;
  const blocked = await blockedDomains(db);
  if (blocked.some((d) => actorHost === d || actorHost.endsWith(`.${d}`))) return;
  const type = typeOf(activity);
  const object = isObject(activity.object) ? activity.object : null;

  if (type === "Add" && object) {
    const cap = typeof object.object === "string" ? decodeBearcap(object.object) : null;
    if (!cap || hostOf(cap.url) !== actorHost) return;
    const author = await accountByApId(db, actorId);
    // Kept only for people someone here follows.
    if (!author || author.banned || !(await hasLocalFollowers(db, author.id))) return;
    if (await storyByApId(db, cap.url)) return;
    const res = await fetch(cap.url, {
      headers: { accept: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"', authorization: `Bearer ${cap.token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    const story = res?.ok ? ((await res.json().catch(() => null)) as Json | null) : null;
    if (!story || typeOf(story) !== "Story" || idOf(story.attributedTo) !== actorId || hostOf(idOf(story)) !== actorHost) return;
    const attachment = isObject(story.attachment) ? story.attachment : Array.isArray(story.attachment) && isObject(story.attachment[0]) ? (story.attachment[0] as Json) : null;
    const mediaUrl = idOf(attachment?.url) ?? (typeof attachment?.href === "string" ? attachment.href : null);
    const kind = typeOf(attachment);
    if (!mediaUrl || !mediaUrl.startsWith("https://") || (kind !== "Image" && kind !== "Video")) return;
    const mediaType = typeof attachment?.mediaType === "string" ? attachment.mediaType : kind === "Video" ? "video/mp4" : "image/jpeg";
    const published = Date.parse(String(story.published ?? ""));
    const expires = Date.parse(String(story.expiresAt ?? ""));
    const createdAt = Number.isFinite(published) ? Math.floor(published / 1000) : Math.floor(Date.now() / 1000);
    // No longer than a day, whatever the story says.
    const expiresAt = Math.min(Number.isFinite(expires) ? Math.floor(expires / 1000) : createdAt + 86_400, createdAt + 86_400);
    if (expiresAt <= Date.now() / 1000) return;
    await createStory(db, {
      accountId: author.id,
      apId: idOf(story)!,
      mediaUrl,
      contentType: mediaType,
      duration: Math.min(Math.max(Number(story.duration) || 7, 1), 60),
      canReply: story.can_reply === true,
      canReact: story.can_react === true,
      createdAt,
      expiresAt,
    }).catch(() => undefined); // Two deliveries can race; the first wins.
    return;
  }

  if (type === "Delete" && object) {
    const id = idOf(object);
    const story = id ? await storyByApId(db, id) : null;
    if (!story) return;
    const author = await accountById(db, story.accountId);
    if (author?.apId === actorId) await endStory(db, story.id);
    return;
  }

  // The rest are about a story here.
  const storyUrl = type === "View" ? idOf(object?.object) : idOf(activity.inReplyTo);
  const match = storyUrl ? STORY_PATH.exec(new URL(storyUrl).pathname) : null;
  if (!storyUrl || !match || !ctx.config.domains.some((d) => d.domain === hostOf(storyUrl))) return;
  const story = await storyById(db, Number(match[2]));
  if (!story || story.apId || !isLive(story)) return;
  const author = await accountById(db, story.accountId);
  if (!author || author.apId) return;
  // Only followers see a story, so only they may answer it.
  const follows = await db.prepare("SELECT 1 AS x FROM followers WHERE account_id = ? AND actor_id = ? AND pending = 0").bind(author.id, actorId).first();
  if (!follows) return;
  const { people } = await contextsFor(ctx);
  const viewer = await ensureAccount(people, new URL(actorId)).catch(() => null);
  if (!viewer) return;

  if (type === "View") {
    await recordStoryView(db, story.id, viewer.id);
    return;
  }
  const reaction = type === "Story:Reaction";
  if (reaction ? !story.canReact : !story.canReply) return;
  const id = idOf(activity);
  const content = typeof activity.content === "string" ? activity.content.slice(0, 2000) : "";
  if (!id || hostOf(id) !== actorHost || !content) return;
  const lead = reaction ? "Reacted to your story:" : "Replied to your story:";
  const note = new Note({
    id: new URL(id),
    attribution: new URL(actorId),
    content: `<p>${lead} ${escapeHtml(stripTags(content))}</p>`,
    tos: [actorUri(author)],
    tags: [new Mention({ href: actorUri(author), name: `@${author.username}` })],
  });
  await storeRemotePost(people, note, { addressedHere: true }).catch((error: unknown) =>
    logProblem("story_reply_failed", { id, error: String(error) }),
  );
}

const stripTags = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
