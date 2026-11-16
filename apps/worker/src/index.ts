import { handleLemmy } from "@palm/adapter-lemmy";
import { handleMastodon } from "@palm/adapter-mastodon";
import { defineConfig, normaliseHost, resolveSurface, type PalmBindings, type PalmConfig, type RequestContext } from "@palm/core";
import { migrate } from "@palm/db";
import { avatarResponse } from "./assets.ts";
import { VERSION } from "./version.ts";

export { ConfigError, defineConfig } from "@palm/core";
export type { ApiKind, DomainConfig, InstanceConfig, PalmBindings, PalmConfig, Surface } from "@palm/core";
export { VERSION };

/**
 * The bindings a deployment gives the Worker: a D1 database bound as `DB`.
 * R2, the Queue and so on arrive with the milestones that need them.
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

  return {
    fetch(request, env, ctx) {
      config ??= defineConfig((source as (env: Env) => PalmConfig)(env));
      return handle(config, request, env, ctx);
    },
  };
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

  const ctx: RequestContext = {
    config,
    domain: surface.domain,
    host: normaliseHost(url.host),
    bindings: env,
    version: VERSION,
    waitUntil: (promise) => executionCtx.waitUntil(promise),
  };

  switch (surface.kind) {
    case "lemmy":
      return handleLemmy(request, ctx);
    case "mastodon":
      return handleMastodon(request, ctx);
    case "federation":
      return federation(config, request, url);
  }
}

function federation(config: PalmConfig, request: Request, url: URL): Response {
  // Federation (WebFinger, actors, the inbox) arrives with Fedify. Until then,
  // browsers that land here go where the old redirect rule sent them, keeping
  // the path; everything else gets a 404.
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
