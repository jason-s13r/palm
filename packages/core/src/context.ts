import type { DomainConfig, PalmConfig } from "./config.ts";

/** The Cloudflare bindings palm needs from a deployment's wrangler.jsonc. */
export interface PalmBindings {
  /** The D1 database. palm creates and migrates its tables itself. */
  DB: D1Database;
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
}

/**
 * ActivityPub IDs. These are permanent once another server has seen them, so
 * changing any of these is a breaking change (see dispat.yaml).
 */
export const urls = {
  user: (domain: string, username: string) => `https://${domain}/users/${encodeURIComponent(username.toLowerCase())}`,
  object: (domain: string, id: string) => `https://${domain}/objects/${encodeURIComponent(id)}`,
  inbox: (domain: string) => `https://${domain}/inbox`,
  userInbox: (domain: string, username: string) => `${urls.user(domain, username)}/inbox`,
};
