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
  /** Fetches a remote community's recent posts after the first local subscription. */
  | { kind: "backfill"; communityId: number };

/**
 * ActivityPub IDs. These are permanent once another server has seen them, so
 * changing any of these is a breaking change (see dispat.yaml).
 */
export const urls = {
  user: (domain: string, username: string) => `https://${domain}/users/${encodeURIComponent(username.toLowerCase())}`,
  object: (domain: string, id: string) => `https://${domain}/objects/${encodeURIComponent(id)}`,
  /** A hashtag's page, as Mastodon names it. */
  tag: (domain: string, tag: string) => `https://${domain}/tags/${encodeURIComponent(tag)}`,
  /** An uploaded file, at the path Lemmy's image host (pict-rs) uses. */
  media: (domain: string, file: string) => `https://${domain}/pictrs/image/${encodeURIComponent(file)}`,
  /** A community, as Lemmy names them: `!name@domain` lives at /c/name. */
  community: (domain: string, name: string) => `https://${domain}/c/${encodeURIComponent(name.toLowerCase())}`,
  /** Another server's picture or video, fetched and cached through palm. */
  proxy: (domain: string, url: string) => `https://${domain}/proxy/media?url=${encodeURIComponent(url)}`,
  inbox: (domain: string) => `https://${domain}/inbox`,
  userInbox: (domain: string, username: string) => `${urls.user(domain, username)}/inbox`,
};

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
