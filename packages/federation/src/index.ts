import type { RequestContext } from "@palm/core";
// Registering the two federations' dispatchers and listeners.
import "./people.ts";
import "./communities.ts";
import { federationsFor } from "./shared.ts";

export { activitySink, processQueueMessage, runTask } from "./delivery.ts";
export { D1KvStore } from "./kv.ts";
export { CloudflareMessageQueue } from "./queue.ts";
export type { FederationName, QueueBody } from "./queue.ts";

/**
 * Serves one request on the bare domain. Communities (/c/...) go to their
 * federation; everything else to people's, and WebFinger falls through to
 * communities when no person has the name. Anything neither handles goes to
 * `fallback`, which redirects browsers or answers 404.
 */
export async function handleFederation(
  request: Request,
  ctx: RequestContext,
  fallback: (request: Request) => Response | Promise<Response>,
): Promise<Response> {
  const { people, communities } = await federationsFor(ctx.bindings);
  const url = new URL(request.url);
  const options = {
    contextData: ctx,
    onNotFound: fallback,
    // A browser asking for an actor or object gets the browser fallback too.
    onNotAcceptable: fallback,
  };
  if (url.pathname.startsWith("/c/") || url.pathname === "/communities/inbox") return communities.fetch(request, options);
  if (url.pathname === "/.well-known/webfinger") {
    return people.fetch(request, { ...options, onNotFound: (req) => communities.fetch(req, options) });
  }
  return people.fetch(request, options);
}
