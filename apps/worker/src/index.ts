import { handleLemmy } from "@palm/adapter-lemmy";
import { handleMastodon } from "@palm/adapter-mastodon";
import { activitySink, handleFederation, processQueueMessage, type QueueBody } from "@palm/federation";
import { defineConfig, normaliseHost, resolveSurface, type DomainConfig, type PalmBindings, type PalmConfig, type RequestContext } from "@palm/core";
import { migrate, prune } from "@palm/db";
import { handleWeb } from "@palm/web";
import { avatarResponse } from "./assets.ts";
import { VERSION } from "./version.ts";

export { ConfigError, defineConfig } from "@palm/core";
export type { ApiKind, DomainConfig, InstanceConfig, PalmBindings, PalmConfig, Surface } from "@palm/core";
export { VERSION };

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
      return handle(configFor(env), request, env, ctx);
    },
    // The same Worker consumes its queue: deliveries and received activities.
    async queue(batch, env, ctx) {
      await consume(configFor(env), batch as MessageBatch<QueueBody>, env, ctx);
    },
    // A daily cron keeps the database small: see prune.
    async scheduled(_controller, env) {
      await migrate(env.DB);
      let removed = 0;
      // A few batches per run keeps each run short; the next day picks up the rest.
      for (let i = 0; i < 5; i++) {
        const n = await prune(env.DB);
        removed += n;
        if (n === 0) break;
      }
      console.log(JSON.stringify({ palm: "pruned", posts: removed }));
    },
  };
}

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

  if (!surface) {
    return json({ error: "unknown_host" }, 421);
  }

  // Everything past here touches the database; bring it up to this release's
  // schema first (a no-op after the first request in each isolate).
  await migrate(env.DB);

  const ctx = requestContext(config, surface.domain, normaliseHost(url.host), env, executionCtx);

  switch (surface.kind) {
    case "lemmy":
      return handleLemmy(request, ctx);
    case "mastodon":
      return handleMastodon(request, ctx);
    case "federation":
      // Both client APIs answer on the bare domain as well as their own hosts.
      // Apps show the handle with the host they signed in to (Voyager and the
      // Mastodon app both do), so signing in with the bare domain gives
      // @name@domain. Their paths don't overlap: Lemmy's API is /api/v3,
      // Mastodon's /api/v1 and /api/v2. Discovery (WebFinger, nodeinfo) stays
      // with federation, which answers nodeinfo as Lemmy.
      // Uploaded images live where Lemmy keeps them, for both kinds of app.
      if (url.pathname.startsWith("/api/v3/") || url.pathname.startsWith("/pictrs/")) return handleLemmy(request, ctx);
      if (isMastodonPath(url.pathname)) return handleMastodon(request, ctx);
      return handleFederation(request, ctx, (req) => federationFallback(config, req, new URL(req.url), ctx));
  }
}

/** Paths the Mastodon API owns on the bare domain. */
function isMastodonPath(path: string): boolean {
  return (
    path.startsWith("/api/v1/") ||
    path.startsWith("/api/v2/") ||
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
