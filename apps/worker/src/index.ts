import { handleLemmy } from "@palm/adapter-lemmy";
import { handleMastodon, publishDueStatuses } from "@palm/adapter-mastodon";
import { activitySink, handleFederation, processQueueMessage, type QueueBody } from "@palm/federation";
import { contextScope, defineConfig, enterContext, normaliseHost, resolveSurface, type DomainConfig, type PalmBindings, type PalmConfig, type RequestContext } from "@palm/core";
import { claimFollowImports, domainOf, migrate, pendingDeletes, pendingMoves, prune } from "@palm/db";
import { handleWeb } from "@palm/web";
import { avatarResponse } from "./assets.ts";
import { servePublic, serveUpload } from "./public-cache.ts";
import { VERSION } from "./version.ts";

export { ConfigError, defineConfig } from "@palm/core";
export type { ApiKind, DomainConfig, InstanceConfig, PalmBindings, PalmConfig, Surface } from "@palm/core";
export { VERSION };
/** The Durable Object for Mastodon streaming: a deployment exports it from its entry point. */
export { PalmStreaming } from "@palm/adapter-mastodon";

/**
 * The bindings a deployment gives the Worker: a D1 database bound as `DB`,
 * and optionally an R2 bucket as `MEDIA` and a Queue as `QUEUE`.
 */
export interface PalmEnv extends PalmBindings {}

/** A config, or a function that builds one from the Worker's bindings. */
export type ConfigSource<Env extends PalmEnv = PalmEnv> = PalmConfig | ((env: Env) => PalmConfig);

/**
 * Builds the Worker for one deployment. A deployment repo's entry point is:
 *
 * ```ts
 * import { createPalm } from "@jason-s13r/palm-worker";
 * import config from "../palm.config.ts";
 * export default createPalm(config);
 * ```
 */
export function createPalm<Env extends PalmEnv = PalmEnv>(source: ConfigSource<Env>): ExportedHandler<Env> {
  // A static config is checked once, when the module loads, so a bad config
  // fails the deploy rather than the first request.
  let config: PalmConfig | undefined = typeof source === "function" ? undefined : defineConfig(source);

  const configFor = (env: Env) => (config ??= defineConfig((source as (env: Env) => PalmConfig)(env)));

  return {
    fetch(request, env, ctx) {
      return contextScope(() => handle(configFor(env), request, env, ctx));
    },
    // The same Worker consumes its queue: deliveries and received activities.
    async queue(batch, env, ctx) {
      await contextScope(() => consume(configFor(env), batch as MessageBatch<QueueBody>, env, ctx));
    },
    // The cron runs every 10 minutes: scheduled posts go out when due, and
    // once a day (in the 03:00 UTC run) old remote posts are pruned.
    scheduled(controller, env, ctx) {
      return contextScope(() => scheduled(configFor(env), controller, env, ctx));
    },
  };
}

/** The cron run: due scheduled posts, moves, deletions, follow imports, and the daily prune. */
async function scheduled(config: PalmConfig, controller: ScheduledController, env: PalmEnv, ctx: Pick<ExecutionContext, "waitUntil">): Promise<void> {
  await migrate(env.DB);
  const contextFor = (domain: string) => {
    const found = config.domains.find((d) => d.domain === domain) ?? (domain === "" ? config.domains[0] : undefined);
    return found ? requestContext(config, found, found.domain, env, ctx) : null;
  };
  const published = await publishDueStatuses(contextFor);
  if (published) console.log(JSON.stringify({ palm: "scheduled_published", posts: published }));
  // Moves and deletions set from the CLI (or not yet sent) go out here.
  const [moves, deletes] = await Promise.all([pendingMoves(env.DB), pendingDeletes(env.DB)]);
  for (const [kind, ids] of [["moved", moves], ["account_deleted", deletes]] as const) {
    for (const accountId of ids) {
      const domain = await domainOf(env.DB, accountId);
      contextFor(domain ?? "")?.activities.enqueue({ kind, accountId });
    }
  }
  // Follows brought from another server go out a few at a time, one queue job
  // each: every one is a lookup on another server, and a big import would use
  // up the day's queue operations at once (about 2,000 a day at this rate).
  for (const claimed of await claimFollowImports(env.DB, IMPORTS_PER_RUN)) {
    const domain = await domainOf(env.DB, claimed.accountId);
    contextFor(domain ?? "")?.activities.enqueue({ kind: "import_follow", importId: claimed.id });
  }
  const at = new Date(controller.scheduledTime);
  if (at.getUTCHours() !== 3 || at.getUTCMinutes() >= 10) return;
  let removed = 0;
  // A few batches per run keeps each run short; the next day picks up the rest.
  for (let i = 0; i < 5; i++) {
    const n = await prune(env.DB);
    removed += n;
    if (n === 0) break;
  }
  console.log(JSON.stringify({ palm: "pruned", posts: removed }));
}

/** Follow imports sent per cron run: 720 a day. */
const IMPORTS_PER_RUN = 5;

/** Builds the context palm's code runs with, for a request or a queued job. */
function requestContext(
  config: PalmConfig,
  domain: DomainConfig,
  host: string,
  env: PalmEnv,
  executionCtx: Pick<ExecutionContext, "waitUntil">,
): RequestContext {
  const ctx = {
    config,
    domain,
    host,
    bindings: env,
    version: VERSION,
    waitUntil: (promise: Promise<unknown>) => executionCtx.waitUntil(promise),
  } as RequestContext;
  // The sink delivers with the finished context, so it's attached after.
  ctx.activities = activitySink(ctx);
  // Push and streaming hooks find it from here.
  enterContext(ctx);
  return ctx;
}

/**
 * Runs a batch from palm's queue, one message at a time. A message that
 * throws is retried by the queue; Fedify's own messages retry themselves.
 */
export async function consume(
  config: PalmConfig,
  batch: MessageBatch<QueueBody>,
  env: PalmEnv,
  executionCtx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  await migrate(env.DB);
  const contextFor = (host: string) => {
    const domain = config.domains.find((d) => d.domain === normaliseHost(host));
    return domain ? requestContext(config, domain, domain.domain, env, executionCtx) : null;
  };
  for (const message of batch.messages) {
    try {
      await processQueueMessage(message.body, contextFor);
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({ palm: "queue_failed", body: message.body.palm, attempts: message.attempts, error: String(error) }));
      message.retry({ delaySeconds: Math.min(60 * 2 ** message.attempts, 3600) });
    }
  }
}

/** Routes one request by its host, then by its path. */
export async function handle(
  config: PalmConfig,
  request: Request,
  env: PalmEnv,
  executionCtx: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  const url = new URL(request.url);
  const surface = resolveSurface(config, url.host);

  // Answered on any host, including workers.dev, so a fresh deploy can be
  // checked before its routes exist.
  if (url.pathname === "/_palm/version") {
    return json({
      software: "palm",
      version: VERSION,
      surface: surface?.kind ?? null,
      domain: surface?.domain.domain ?? null,
    });
  }
  if (url.pathname === "/palm/avatar.png") return avatarResponse();
  if (url.pathname === "/favicon.ico") return avatarResponse();
  if (url.pathname === "/robots.txt") return robotsResponse();

  if (!surface) {
    return json({ error: "unknown_host" }, 421);
  }

  const served = surface;
  // Uploads come from cache when they can, before any database work.
  if (url.pathname.startsWith("/pictrs/image/") && !url.pathname.startsWith("/pictrs/image/delete/")) {
    return serveUpload(request, url, surface.domain.domain, (p) => executionCtx.waitUntil(p), () => routeRequest());
  }
  return routeRequest();

  async function routeRequest(): Promise<Response> {
    // Everything past here touches the database; bring it up to this release's
    // schema first (a no-op after the first request in each isolate).
    await migrate(env.DB);

    const ctx = requestContext(config, served.domain, normaliseHost(url.host), env, executionCtx);
    if (url.pathname === "/proxy/media") return proxyMedia(request, ctx);

    switch (served.kind) {
      case "lemmy":
        return handleLemmy(request, ctx);
      case "mastodon":
        return handleMastodon(request, ctx);
      case "federation":
        // Both client APIs answer on the bare domain as well as their own hosts.
        // Apps show the handle with the host they signed in to (Voyager and the
        // Mastodon app both do), so signing in with the bare domain gives
        // @name@domain. Their paths don't overlap: Lemmy's API is /api/v3,
        // Mastodon's /api/v1 and /api/v2 (and Pixelfed's extras). Discovery (WebFinger, nodeinfo) stays
        // with federation, which answers nodeinfo as Lemmy.
        // Uploaded images live where Lemmy keeps them, for both kinds of app.
        if (url.pathname.startsWith("/api/v3/") || url.pathname.startsWith("/pictrs/")) return handleLemmy(request, ctx);
        if (isMastodonPath(url.pathname)) return handleMastodon(request, ctx);
        // Actors, collections, WebFinger and nodeinfo come from cache when they can.
        return servePublic(request, ctx, () => handleFederation(request, ctx, (req) => federationFallback(config, req, new URL(req.url), ctx)));
    }
  }
}

/** Paths the Mastodon API owns on the bare domain. */
function isMastodonPath(path: string): boolean {
  return (
    path.startsWith("/api/v1/") ||
    path.startsWith("/api/v2/") ||
    // Pixelfed's apps: its extra API versions, and its own nodeinfo path.
    path.startsWith("/api/v1.1/") ||
    path.startsWith("/api/v1.2/") ||
    path.startsWith("/api/v2.1/") ||
    path.startsWith("/api/pixelfed/") ||
    path === "/api/nodeinfo/2.0.json" ||
    path.startsWith("/oauth/") ||
    path === "/.well-known/oauth-authorization-server"
  );
}

async function federationFallback(config: PalmConfig, request: Request, url: URL, ctx: RequestContext): Promise<Response> {
  // What Fedify doesn't serve: palm's own pages for profiles, posts and
  // communities (and the URLs other servers link to them by)...
  if (wantsHtml(request) || /^\/(@|post\/|comment\/)/.test(url.pathname)) {
    const page = await handleWeb(request, ctx);
    if (page) return page;
  }
  // ...then browsers go where the old redirect rule sent them, keeping the
  // path; everything else gets a 404.
  if (config.browserRedirect && wantsHtml(request)) {
    return Response.redirect(new URL(url.pathname + url.search, config.browserRedirect).toString(), 302);
  }
  return json({ error: "not_found" }, 404);
}

const PROXY_MAX_BYTES = 40 * 1024 * 1024;
const PROXY_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Other servers' pictures and video, fetched once and kept in Cloudflare's
 * cache, so they load fast and outlast a slow or vanished server for a while.
 * Only media from servers palm knows is fetched (so this isn't an open proxy
 * for anyone's URLs); anything else is a redirect to the original.
 */
async function proxyMedia(request: Request, ctx: RequestContext): Promise<Response> {
  const target = new URL(request.url).searchParams.get("url") ?? "";
  let source: URL;
  try {
    source = new URL(target);
  } catch {
    return json({ error: "bad_url" }, 400);
  }
  if (source.protocol !== "https:" && source.protocol !== "http:") return json({ error: "bad_url" }, 400);
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(`https://${ctx.domain.domain}/proxy/media?url=${encodeURIComponent(source.href)}`);
  const range = request.headers.get("range");
  const cached = await cache.match(range ? new Request(key, { headers: { range } }) : key);
  if (cached) return cached;
  // The media's host or a domain above it (media.example.com for example.com),
  // looked up by the domain indexes rather than matched against every row.
  const labels = source.hostname.toLowerCase().split(".");
  const domains = labels.slice(0, -1).map((_, i) => labels.slice(i).join("."));
  if (source.port || !domains.length) domains.unshift(source.host.toLowerCase());
  const marks = domains.map((_, i) => `?${i + 1}`).join(", ");
  const known = await ctx.bindings.DB.prepare(
    `SELECT 1 FROM accounts WHERE domain IN (${marks}) AND ap_id IS NOT NULL
     UNION ALL SELECT 1 FROM communities WHERE domain IN (${marks}) AND ap_id IS NOT NULL LIMIT 1`,
  )
    .bind(...domains)
    .first();
  if (!known) return Response.redirect(source.href, 302);
  const upstream = await fetch(source.href, { headers: { "user-agent": "palm (+https://github.com/jason-s13r/palm; media)" }, redirect: "follow" }).catch(() => null);
  const type = upstream?.headers.get("content-type") ?? "";
  const size = Number(upstream?.headers.get("content-length") ?? 0);
  if (!upstream?.ok || !/^(image|video|audio)\//.test(type) || type.includes("svg") || size > PROXY_MAX_BYTES) {
    await upstream?.body?.cancel().catch(() => undefined);
    return Response.redirect(source.href, 302);
  }
  const response = new Response(upstream.body, {
    headers: {
      "content-type": type,
      ...(size ? { "content-length": String(size) } : {}),
      "cache-control": `public, max-age=${PROXY_TTL_SECONDS}`,
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    },
  });
  ctx.waitUntil(cache.put(key, response.clone()).catch(() => undefined));
  return response;
}

/** Crawlers may read the web pages; the APIs and sign-in aren't for them. */
function robotsResponse(): Response {
  return new Response("User-agent: *\nDisallow: /api/\nDisallow: /oauth/\nDisallow: /pictrs/\nAllow: /\n", {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" },
  });
}

function wantsHtml(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html") && !accept.includes("activity+json") && !accept.includes("ld+json");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
