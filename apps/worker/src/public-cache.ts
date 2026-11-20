import { uploadCacheKey, type RequestContext } from "@palm/core";
import { profileVersion } from "@palm/db";

/**
 * Other servers' fetches of what palm publishes (actors, their collections,
 * WebFinger and nodeinfo) are the same for everyone who asks, and they come
 * often: each server that sees a post checks who wrote it. Building an actor
 * costs about 40 ms of CPU (keys, JSON-LD), so these are answered from
 * Cloudflare's cache.
 *
 * The cache is per data centre, and palm can only clear the one it's in. So
 * a person's actor and WebFinger are kept under their profile version, which
 * goes up whenever the actor changes: every data centre misses the old copy
 * at once, and the copies can be kept a day. Collections change with every
 * follow and post, so they're kept briefly and not versioned.
 */

const DAY = 24 * 60 * 60;
const COLLECTION_SECONDS = 10 * 60;
/** Nodeinfo's counts are themselves worked out at most hourly; nobody needs them fresher. */
const NODEINFO_SECONDS = 6 * 60 * 60;

interface Rule {
  ttl: number;
  /** The local person whose profile version the copy is kept under. */
  person: string | null;
}

const PERSON = /^\/users\/([^/]+)$/;
const COLLECTION = /^\/(users|c)\/[^/]+\/(followers|following|outbox|featured|collections\/tags)$/;
const COMMUNITY = /^\/c\/[^/]+$/;
const NODEINFO = /^\/(\.well-known\/nodeinfo|nodeinfo\/[0-9.]+)$/;

const wantsActivityJson = (request: Request) => {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("activity+json") || accept.includes("ld+json");
};

/** Who a WebFinger query is about, when it's a person here. */
function webfingerPerson(url: URL, domain: string): string | null {
  const resource = url.searchParams.get("resource") ?? "";
  const acct = /^acct:@?([^@]+)@(.+)$/i.exec(resource);
  if (acct) return acct[2]!.toLowerCase() === domain ? acct[1]! : null;
  try {
    const target = new URL(resource);
    if (target.host.toLowerCase() !== domain) return null;
    return /^\/(?:users\/|@)([^/]+)$/.exec(target.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

function ruleFor(request: Request, url: URL, domain: string): Rule | null {
  if (request.method !== "GET") return null;
  if (NODEINFO.test(url.pathname)) return { ttl: NODEINFO_SECONDS, person: null };
  if (url.pathname === "/.well-known/webfinger") {
    const person = webfingerPerson(url, domain);
    return person ? { ttl: DAY, person } : null;
  }
  // Browsers on these URLs get palm's web pages, which aren't cached here.
  if (!wantsActivityJson(request)) return null;
  const person = PERSON.exec(url.pathname)?.[1];
  if (person) return { ttl: DAY, person: decodeURIComponent(person) };
  if (COLLECTION.test(url.pathname) || COMMUNITY.test(url.pathname)) return { ttl: COLLECTION_SECONDS, person: null };
  return null;
}

const cache = () => (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;

/**
 * Answers `request` from cache when palm can, and otherwise runs `serve`
 * and keeps what it returns.
 */
export async function servePublic(request: Request, ctx: RequestContext, serve: () => Promise<Response>): Promise<Response> {
  const store = cache();
  const url = new URL(request.url);
  const rule = store ? ruleFor(request, url, ctx.domain.domain) : null;
  if (!store || !rule) return serve();
  let version = 0;
  if (rule.person) {
    const found = await profileVersion(ctx.bindings.DB, ctx.domain.domain, rule.person);
    // Nobody by that name: no copy to keep.
    if (found === null) return serve();
    version = found;
  }
  // The key marks the copy as palm's, for ActivityPub or JSON, at a version.
  const key = new URL(url.href);
  key.hash = "";
  key.searchParams.set("_palm", `ap.${version}`);
  const hit = await store.match(key.href);
  if (hit) {
    const marked = new Response(hit.body, hit);
    marked.headers.set("x-palm-cache", "hit");
    return marked;
  }
  const response = await serve();
  const type = response.headers.get("content-type") ?? "";
  if (response.status === 200 && type.includes("json")) {
    const copy = new Response(response.clone().body, response);
    copy.headers.set("cache-control", `public, max-age=${rule.ttl}`);
    copy.headers.delete("set-cookie");
    ctx.waitUntil(store.put(key.href, copy));
  }
  return response;
}

const UPLOAD = /^\/pictrs\/image\/([a-z0-9]+)(\.[a-z0-9]+)?$/i;
/** How long a data centre keeps an upload: a deleted one can show that long elsewhere. */
const UPLOAD_SECONDS = 24 * 60 * 60;

/**
 * Uploads (avatars, banners, attachments) from cache. Other servers fetch a
 * person's avatar and banner each time they see them, about four a minute
 * here; their names are random and never reused, so a copy stays right.
 * Range requests (video) are answered from a cached copy when there is one.
 */
export async function serveUpload(
  request: Request,
  url: URL,
  domain: string,
  waitUntil: (p: Promise<unknown>) => void,
  serve: () => Promise<Response>,
): Promise<Response> {
  const store = cache();
  const id = UPLOAD.exec(url.pathname)?.[1];
  if (!store || !id || request.method !== "GET") return serve();
  const key = uploadCacheKey(domain, id.toLowerCase());
  const range = request.headers.get("range");
  const hit = await store.match(range ? new Request(key, { headers: { range } }) : key);
  if (hit) {
    const marked = new Response(hit.body, hit);
    marked.headers.set("x-palm-cache", "hit");
    return marked;
  }
  const response = await serve();
  if (!range && response.status === 200) {
    const copy = new Response(response.clone().body, response);
    copy.headers.set("cache-control", `public, max-age=${UPLOAD_SECONDS}`);
    waitUntil(store.put(key, copy));
  }
  return response;
}
