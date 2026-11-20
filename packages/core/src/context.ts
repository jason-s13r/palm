import type { DomainConfig, PalmConfig } from "./config.ts";

/** The Cloudflare bindings palm needs from a deployment's wrangler.jsonc. */
export interface PalmBindings {
  /** The D1 database. palm creates and migrates its tables itself. */
  DB: D1Database;
  /** An R2 bucket for uploaded images. Without it, uploads are refused. */
  MEDIA?: R2Bucket;
  /**
   * A Cloudflare Queue for delivery and received activities, consumed by the
   * same Worker. Without it, that work runs in the request (slower, and over
   * the free plan's CPU budget once there are followers).
   */
  QUEUE?: Queue;
  /**
   * The PalmStreaming Durable Object, for Mastodon's live streaming. Without
   * it, apps refresh on their own instead.
   */
  STREAMING?: DurableObjectNamespace;
  /**
   * Cloudflare Stream (a paid product), for hosting PeerTube video: when
   * bound, uploads are also sent to Stream, which makes the HLS playlist and
   * an H.264 MP4 that plays everywhere.
   */
  STREAM?: StreamBinding;
  /**
   * Media Transformations, for a video's thumbnail: a frame from its upload.
   * Each frame is one operation; 5,000 a month are free.
   */
  MEDIA_TRANSFORMS?: MediaTransformsBinding;
  /**
   * The registration token for PeerTube's remote runners (`peertube-runner`
   * on a machine of your own): with it set, runners can register and make a
   * video's renditions with ffmpeg, for free. A secret.
   */
  PEERTUBE_RUNNER_TOKEN?: string;
  /** Each person's video quota, in megabytes (2048 if unset). */
  PALM_VIDEO_QUOTA_MB?: string;
}

/**
 * What makes video renditions in this deployment, from its bindings:
 * Cloudflare Stream (paid), PeerTube's remote runners (a machine of your own),
 * or nothing (videos play as uploaded).
 */
export function transcoderOf(bindings: PalmBindings): "stream" | "runner" | null {
  if (typeof bindings.STREAM?.upload === "function") return "stream";
  if (typeof bindings.PEERTUBE_RUNNER_TOKEN === "string" && bindings.PEERTUBE_RUNNER_TOKEN.length >= 16) return "runner";
  return null;
}

/** The parts of Cloudflare Stream's Worker binding palm uses. */
export interface StreamBinding {
  upload(url: string, params?: { meta?: Record<string, string>; creator?: string }): Promise<{ uid?: string; id?: string }>;
  video(id: string): {
    details(): Promise<{ readyToStream?: boolean; status?: { state?: string }; playback?: { hls?: string }; thumbnail?: string; input?: { width?: number; height?: number }; duration?: number }>;
    delete(): Promise<void>;
    downloads: {
      create(type?: string): Promise<unknown>;
      get(): Promise<Record<string, { status?: string; url?: string; percentComplete?: number } | undefined> | { default?: { status?: string; url?: string } }>;
    };
  };
}

/** The parts of the Media Transformations binding palm uses. */
export interface MediaTransformsBinding {
  input(stream: ReadableStream<Uint8Array>): {
    transform(params?: { width?: number; height?: number; fit?: string }): {
      output(params: { mode: "frame" | "video" | "spritesheet" | "audio"; time?: string; format?: string; duration?: string }): {
        response(): Promise<Response>;
      };
    };
    output(params: { mode: "frame" | "video" | "spritesheet" | "audio"; time?: string; format?: string; duration?: string }): {
      response(): Promise<Response>;
    };
  };
}

/** What every adapter gets for one request. */
export interface RequestContext {
  config: PalmConfig;
  /** The domain whose host this request arrived on. */
  domain: DomainConfig;
  /** The request's own host, lowercased, without a port. */
  host: string;
  bindings: PalmBindings;
  /** palm's own version, for instance info. */
  version: string;
  /** For work that may finish after the response, such as logging. */
  waitUntil(promise: Promise<unknown>): void;
  /**
   * Tells other servers about local changes. The worker supplies this from
   * the federation package, so the client adapters don't depend on Fedify.
   */
  activities: ActivitySink;
}

/**
 * What the client adapters ask of federation, so they don't depend on Fedify:
 * tell other servers about local changes, and look up remote things.
 */
export interface ActivitySink {
  /**
   * Hands a change to federation. It returns straight away; the work runs on
   * the queue (or after the response, without one).
   */
  enqueue(task: FederationTask): void;
  /**
   * Finds a remote person, community or post by handle (`@name@host`,
   * `!name@host`) or URL, fetching and recording it if palm hasn't met it.
   */
  resolve(query: string): Promise<Resolved | null>;
  /**
   * Fills in a remote person's recent posts and counts from their server,
   * for their profile. Waits for it, so the profile can show them; does
   * nothing if palm did so recently.
   */
  backfillProfile(accountId: number): Promise<void>;
  /**
   * Fills in a remote post's comments from its own server, for a thread
   * someone here has opened. Does nothing if palm did so recently.
   */
  backfillThread(postId: number): Promise<void>;
}

/** What `resolve` found, by its ID in palm's tables. */
export type Resolved = { kind: "account"; id: number } | { kind: "community"; id: number } | { kind: "post"; id: number };

/** Local changes that other servers hear about. */
export type FederationTask =
  | { kind: "post_created"; postId: number }
  | { kind: "post_updated"; postId: number }
  | { kind: "post_deleted"; postId: number }
  /** A vote on a post or comment: 1, -1, or 0 for taking one back (a Mastodon favourite is 1). */
  | { kind: "voted"; postId: number; accountId: number; score: number; previous: number }
  | { kind: "boosted"; postId: number; accountId: number; undo: boolean }
  /** Following a person. `followApId` names the Follow, so it can be undone or accepted. */
  | { kind: "followed"; accountId: number; targetId: number; followApId: string; undo: boolean }
  | { kind: "blocked"; accountId: number; targetId: number; blockApId: string; undo: boolean }
  /** A report about another server's post, sent there as a Flag. */
  | { kind: "reported"; reportId: number }
  /** Someone here voting in another server's poll: a Note per choice, to its author. */
  | { kind: "poll_voted"; postId: number; accountId: number }
  /** A locked account answering a follow request from another server. */
  | { kind: "follow_answered"; accountId: number; followerId: number; followId: string; accept: boolean }
  | { kind: "subscribed"; accountId: number; communityId: number; followApId: string; undo: boolean }
  | { kind: "profile_updated"; accountId: number }
  /** A link preview to fetch for a post, apart from the request that stored it. */
  | { kind: "card"; postId: number }
  /** A local account moved elsewhere: its followers are sent a Move. */
  | { kind: "moved"; accountId: number }
  /** A follow brought from another server (`follow_imports`): look it up and follow it. */
  | { kind: "import_follow"; importId: number }
  /** A local account was deleted: its followers are sent a Delete of it. */
  | { kind: "account_deleted"; accountId: number }
  /** Fetches a remote community's recent posts after the first local subscription. */
  | { kind: "backfill"; communityId: number }
  /** One post of a community's backfill, in a job of its own. */
  | { kind: "backfill_post"; communityId: number; url: string }
  /** A local story, offered to followers on servers that show stories (Pixelfed's Add). */
  | { kind: "story_published"; storyId: number }
  /** A local PeerTube video, published or changed: its Video goes to followers of its person and channel. */
  | { kind: "video_published"; postId: number; update: boolean }
  /** A local story taken down before its day was up. */
  | { kind: "story_deleted"; storyId: number }
  /** Someone here saw another server's story: its author is told (a View). */
  | { kind: "story_viewed"; storyId: number; accountId: number }
  /** Someone here answered another server's story (Story:Reply) or reacted to it (Story:Reaction). */
  | { kind: "story_replied"; storyId: number; accountId: number; text: string; reaction: boolean };

/**
 * ActivityPub IDs. These are permanent once another server has seen them, so
 * changing any of these is a breaking change (see dispat.yaml).
 */
export const urls = {
  user: (domain: string, username: string) => `https://${domain}/users/${encodeURIComponent(username.toLowerCase())}`,
  object: (domain: string, id: string) => `https://${domain}/objects/${encodeURIComponent(id)}`,
  /** A local post, as Lemmy names them (newer posts; older ones keep /objects/{id}). */
  post: (domain: string, id: number) => `https://${domain}/post/${id}`,
  /** A local reply, as Lemmy names comments (newer replies; older ones keep /objects/{id}). */
  comment: (domain: string, id: number) => `https://${domain}/comment/${id}`,
  /** A hashtag's page, as Mastodon names it. */
  tag: (domain: string, tag: string) => `https://${domain}/tags/${encodeURIComponent(tag)}`,
  /** An uploaded file, at the path Lemmy's image host (pict-rs) uses. */
  media: (domain: string, file: string) => `https://${domain}/pictrs/image/${encodeURIComponent(file)}`,
  /** A community, as Lemmy names them: `!name@domain` lives at /c/name. */
  community: (domain: string, name: string) => `https://${domain}/c/${encodeURIComponent(name.toLowerCase())}`,
  /** A story, at the path Pixelfed uses: `/stories/{name}/{id}`. */
  story: (domain: string, username: string, id: number) => `https://${domain}/stories/${encodeURIComponent(username.toLowerCase())}/${id}`,
  /** Another server's picture or video, fetched and cached through palm. */
  proxy: (domain: string, url: string) => `https://${domain}/proxy/media?url=${encodeURIComponent(url)}`,
  inbox: (domain: string) => `https://${domain}/inbox`,
  userInbox: (domain: string, username: string) => `${urls.user(domain, username)}/inbox`,
};

/** What a post's ActivityPub ID is made from. */
export interface PostIdentity {
  id: number;
  /** A remote post's own ID; null for local posts. */
  apId: string | null;
  /** A local post minted with Lemmy's paths (/post/{id}, /comment/{id}) rather than /objects/{id}. */
  lemmyPath?: boolean;
  rootId?: number | null;
  parentId?: number | null;
  inReplyTo?: string | null;
}

/**
 * A post's ActivityPub ID: a remote post's own, else the path it was minted
 * with. Local posts made before Lemmy's paths keep /objects/{id}, since other
 * servers know them by it; newer ones are /post/{id}, or /comment/{id} for a
 * reply, so Lemmy apps (Voyager's links, for one) read them as Lemmy's.
 */
export function postApId(domain: string, post: PostIdentity): string {
  if (post.apId) return post.apId;
  if (!post.lemmyPath) return urls.object(domain, String(post.id));
  const reply = post.rootId != null || post.parentId != null || post.inReplyTo != null;
  return reply ? urls.comment(domain, post.id) : urls.post(domain, post.id);
}

/** The local post an ID or alias names: /objects/{id}, /post/{id} or /comment/{id} all resolve. */
export const LOCAL_POST_PATH = /^\/(?:objects|post|comment)\/(\d+)$/;

export function localPostId(pathname: string): number | null {
  const match = LOCAL_POST_PATH.exec(pathname);
  return match ? Number(match[1]) : null;
}

/**
 * The Lemmy version palm answers as. Lemmy apps check it (Voyager needs
 * ">=0.19.0"), so it's a real Lemmy version.
 */
export const LEMMY_COMPAT_VERSION = "0.19.9";

/**
 * The version palm reports in nodeinfo: the Lemmy version it's compatible
 * with, plus palm's own as semver build metadata, e.g. "0.19.9+palm.0.2.0".
 * Comparisons ignore build metadata, so app version checks still pass; anyone
 * reading it can see it's palm. (The software name has to be plain "lemmy":
 * the schema allows one lowercase word.)
 */
export const nodeinfoVersion = (palmVersion: string) =>
  `${LEMMY_COMPAT_VERSION}+palm.${palmVersion.replace(/[^0-9A-Za-z.-]/g, "-")}`;
