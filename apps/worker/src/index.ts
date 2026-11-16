import { defineConfig, resolveSurface, type PalmConfig, type Surface } from "@palm/core";
import { VERSION } from "./version.ts";

export { ConfigError, defineConfig } from "@palm/core";
export type { ApiKind, DomainConfig, InstanceConfig, PalmConfig, Surface } from "@palm/core";
export { VERSION };

/**
 * The bindings a deployment gives the Worker. Empty for now; D1, R2, the Queue
 * and secrets arrive with the milestones that need them.
 */
export interface PalmEnv {}

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
    fetch(request, env) {
      config ??= defineConfig((source as (env: Env) => PalmConfig)(env));
      return handle(config, request);
    },
  };
}

/** Routes one request by its host, then by its path. */
export async function handle(config: PalmConfig, request: Request): Promise<Response> {
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

  if (!surface) {
    return json({ error: "unknown_host" }, 421);
  }

  return surface.kind === "federation" ? federation(config, request, url) : apiHost(config, surface, request, url);
}

function federation(config: PalmConfig, request: Request, url: URL): Response {
  // Nothing federates yet (M1). Browsers that land here go where the old
  // redirect rule sent them, keeping the path; everything else gets a 404.
  if (config.browserRedirect && wantsHtml(request)) {
    return Response.redirect(new URL(url.pathname + url.search, config.browserRedirect).toString(), 302);
  }
  return json({ error: "not_found" }, 404);
}

function apiHost(config: PalmConfig, surface: Surface, request: Request, url: URL): Response {
  if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
    const apps = surface.kind === "lemmy" ? "Voyager, Mlem or Thunder" : "Ivory, Ice Cubes or the Mastodon app";
    const api = surface.kind === "lemmy" ? "Lemmy" : "Mastodon";
    return new Response(
      `${config.instance.name}\n\nThis is the ${api} API for ${surface.domain.domain}.\n` +
        `Sign in from ${apps}, with ${url.host} as the server.\n`,
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  // Lemmy and Mastodon both answer errors as {"error": "..."}.
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
