import type { Context } from "@fedify/fedify";
import { signRequest } from "@fedify/fedify/sig";
import type { Object as APObject } from "@fedify/fedify/vocab";
import { urls, type FederationTask, type RequestContext } from "@palm/core";
import {
  accountById,
  blockedDomains,
  communityById,
  communityFollowers,
  followers,
  postById,
  saveVideo,
  tagsFor,
  videoByPostId,
  type Account,
  type Community,
  type Video,
} from "@palm/db";
import { contextsFor, logProblem, personKeys } from "./shared.ts";
import { videoFromJson } from "./video-json.ts";

export { parseDuration, videoFromJson, watchPageOf } from "./video-json.ts";

type Json = Record<string, unknown>;

/**
 * A Video object's JSON as its server sent it. Fedify keeps the compact
 * document it parsed when it can; an object embedded in an activity may not
 * have it, so it's fetched (once, when the video is first kept).
 */
export async function rawVideoJson(fctx: Context<RequestContext>, object: APObject): Promise<Json | null> {
  const cached = (object as unknown as { _cachedJsonLd?: unknown })._cachedJsonLd;
  const doc = Array.isArray(cached) ? cached[0] : cached;
  if (doc && typeof doc === "object" && ("uuid" in doc || "url" in doc)) return doc as Json;
  if (!object.id) return null;
  try {
    const loaded = await fctx.documentLoader(object.id.href);
    const document = loaded.document as Json | null;
    return document && typeof document === "object" && document.type === "Video" ? document : null;
  } catch {
    return null;
  }
}

/** Keeps PeerTube's side of a stored Video post. */
export async function recordVideo(fctx: Context<RequestContext>, object: APObject, postId: number, channelId: number | null): Promise<Video | null> {
  const json = await rawVideoJson(fctx, object);
  if (!json) return null;
  const video = videoFromJson(json, postId, channelId);
  if (video) await saveVideo(fctx.data.bindings.DB, video);
  return video;
}

// --- local videos, as PeerTube shapes them ---------------------------------------

/**
 * The terms PeerTube's Video uses beyond ActivityStreams. PeerTube reads its
 * fields as plain JSON; the context is there for anyone expanding it.
 */
const VIDEO_CONTEXT = [
  "https://www.w3.org/ns/activitystreams",
  "https://w3id.org/security/v1",
  {
    pt: "https://joinpeertube.org/ns#",
    sc: "http://schema.org/",
    Hashtag: "as:Hashtag",
    uuid: "sc:identifier",
    category: "sc:category",
    licence: "sc:license",
    subtitleLanguage: "sc:subtitleLanguage",
    sensitive: "as:sensitive",
    language: "sc:inLanguage",
    isLiveBroadcast: "sc:isLiveBroadcast",
    state: { "@type": "sc:Number", "@id": "pt:state" },
    views: { "@type": "sc:Number", "@id": "pt:views" },
    size: { "@type": "sc:Number", "@id": "pt:size" },
    fps: { "@type": "sc:Number", "@id": "pt:fps" },
    commentsEnabled: { "@type": "sc:Boolean", "@id": "pt:commentsEnabled" },
    commentsPolicy: { "@type": "sc:Number", "@id": "pt:commentsPolicy" },
    downloadEnabled: { "@type": "sc:Boolean", "@id": "pt:downloadEnabled" },
    waitTranscoding: { "@type": "sc:Boolean", "@id": "pt:waitTranscoding" },
    support: { "@type": "sc:Text", "@id": "pt:support" },
    aspectRatio: { "@type": "sc:Float", "@id": "pt:aspectRatio" },
    originallyPublishedAt: "sc:datePublished",
  },
];

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** A local video as PeerTube's Video object, which PeerTube servers need (uuid, files with sizes, a thumbnail). */
export async function localVideoObject(ctx: RequestContext, postId: number): Promise<{ object: Json; author: Account; channel: Community | null } | null> {
  const db = ctx.bindings.DB;
  const post = await postById(db, postId);
  if (!post || post.apId !== null) return null;
  const video = await videoByPostId(db, postId);
  const author = await accountById(db, post.accountId);
  if (!video || !author) return null;
  const channel = video.channelId !== null ? await communityById(db, video.channelId) : null;
  const tags = (await tagsFor(db, [post.id])).get(post.id) ?? [];
  const id = urls.object(author.domain, String(post.id));
  const actor = urls.user(author.domain, author.username);
  const channelId = channel ? urls.community(channel.domain, channel.name) : null;
  const followers = `${actor}/followers`;
  const audience =
    post.visibility === "public"
      ? { to: [PUBLIC, ...(channelId ? [channelId] : [])], cc: [followers] }
      : { to: [followers], cc: [PUBLIC] };
  const thumbnail = video.thumbnails.at(-1);
  const icon = thumbnail
    ? { type: "Image", url: thumbnail.url, mediaType: /\.png$/i.test(thumbnail.url) ? "image/png" : /\.webp$/i.test(thumbnail.url) ? "image/webp" : "image/jpeg", width: thumbnail.width ?? 1280, height: thumbnail.height ?? 720 }
    : // PeerTube needs a thumbnail; palm's placeholder stands in.
      { type: "Image", url: `https://${author.domain}/palm/avatar.png`, mediaType: "image/png", width: 96, height: 96 };
  const object: Json = {
    type: "Video",
    id,
    name: post.title ?? "Untitled",
    duration: `PT${Math.max(1, Math.round(video.duration))}S`,
    uuid: video.uuid,
    tag: tags.map((name) => ({ type: "Hashtag", name, href: urls.tag(author.domain, name) })),
    ...(video.category !== null ? { category: { identifier: String(video.category), name: String(video.category) } } : {}),
    ...(video.licence !== null ? { licence: { identifier: String(video.licence), name: String(video.licence) } } : {}),
    ...(video.language ? { language: { identifier: video.language, name: video.language } } : {}),
    views: video.views,
    sensitive: post.sensitive,
    waitTranscoding: false,
    state: video.state,
    commentsEnabled: video.commentsEnabled,
    commentsPolicy: video.commentsEnabled ? 1 : 2,
    canReply: null,
    downloadEnabled: video.downloadEnabled,
    published: iso(post.createdAt),
    updated: iso(post.updatedAt ?? post.createdAt),
    ...(video.originallyPublishedAt ? { originallyPublishedAt: iso(video.originallyPublishedAt) } : {}),
    mediaType: "text/markdown",
    content: post.contentSource,
    source: { content: post.contentSource, mediaType: "text/markdown" },
    support: video.support,
    subtitleLanguage: [],
    icon: [icon],
    aspectRatio: video.aspectRatio,
    url: [
      { type: "Link", mediaType: "text/html", href: `https://${author.domain}/@${encodeURIComponent(author.username)}/${post.id}` },
      ...video.files.map((f) => ({
        type: "Link",
        mediaType: f.mediaType === "video/quicktime" ? "video/mp4" : f.mediaType,
        href: f.url,
        height: f.height,
        width: f.width,
        size: f.size,
        fps: f.fps,
      })),
    ],
    isLiveBroadcast: false,
    attributedTo: [{ type: "Person", id: actor }, ...(channelId ? [{ type: "Group", id: channelId }] : [])],
    ...(channelId ? { audience: channelId } : {}),
    ...audience,
  };
  return { object, author, channel };
}

/** A local video asked for by another server (/objects/{id}): PeerTube's shape, not Fedify's Note. Null for anything else. */
export async function serveVideoObject(request: Request, ctx: RequestContext): Promise<Response | null> {
  const accept = request.headers.get("accept") ?? "";
  if (!/activity\+json|ld\+json/.test(accept)) return null;
  const id = /^\/objects\/(\d+)$/.exec(new URL(request.url).pathname)?.[1];
  if (!id) return null;
  const found = await localVideoObject(ctx, Number(id));
  if (!found) return null;
  const post = await postById(ctx.bindings.DB, Number(id));
  if (!post || post.visibility === "direct" || post.visibility === "private") return null;
  return new Response(JSON.stringify({ "@context": VIDEO_CONTEXT, ...found.object }), {
    headers: { "content-type": "application/activity+json", "cache-control": "public, max-age=60", vary: "Accept" },
  });
}

/**
 * Sends a local video's Create (or Update) to the followers of its person and
 * of its channel, one request per server. Sent as palm builds it, not through
 * Fedify, which would drop PeerTube's fields.
 */
export async function runVideoTask(ctx: RequestContext, task: Extract<FederationTask, { kind: "video_published" }>): Promise<void> {
  const found = await localVideoObject(ctx, task.postId);
  if (!found) return;
  const { object, author, channel } = found;
  const db = ctx.bindings.DB;
  const blocked = await blockedDomains(db);
  const local = new Set(ctx.config.domains.map((d) => d.domain));
  const inboxes = new Map<string, string>();
  const add = (inbox: string, shared: string | null) => {
    const target = shared ?? inbox;
    let host: string;
    try {
      host = new URL(target).host.toLowerCase();
    } catch {
      return;
    }
    if (local.has(host) || inboxes.has(host) || blocked.some((d) => host === d || host.endsWith(`.${d}`))) return;
    inboxes.set(host, target);
  };
  for (const f of await followers(db, author.id)) add(f.inbox, f.sharedInbox);
  if (channel) for (const f of await communityFollowers(db, channel.id)) add(f.inbox, f.sharedInbox);
  const id = String(object.id);
  const activity = {
    "@context": VIDEO_CONTEXT,
    id: task.update ? `${id}#update-${Date.now()}` : `${id}/activity`,
    type: task.update ? "Update" : "Create",
    actor: urls.user(author.domain, author.username),
    to: object.to,
    cc: object.cc,
    object,
  };
  const { people } = await contextsFor(ctx);
  const key = (await personKeys(people, author))[0];
  if (!key) return;
  const body = JSON.stringify(activity);
  for (const inbox of inboxes.values()) {
    const request = await signRequest(
      new Request(inbox, { method: "POST", headers: { "content-type": "application/activity+json", accept: "application/activity+json" }, body }),
      key.privateKey,
      key.keyId,
      { spec: "draft-cavage-http-signatures-12", body: new TextEncoder().encode(body).buffer as ArrayBuffer },
    );
    const res = await fetch(request).catch((error: unknown) => {
      logProblem("video_delivery_failed", { inbox, error: String(error) });
      return null;
    });
    if (res && !res.ok) logProblem("video_delivery_refused", { inbox, status: res.status });
    await res?.body?.cancel().catch(() => undefined);
  }
}
