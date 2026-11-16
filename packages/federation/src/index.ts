import type { RequestContext } from "@palm/core";
// Registering the two federations' dispatchers and listeners.
import "./people.ts";
import "./communities.ts";
import { processQueueMessage as processMessage } from "./delivery.ts";
import type { QueueBody } from "./queue.ts";
import { triage } from "./prefilter.ts";
import { verifySignature } from "./signature.ts";
import { federationsFor } from "./shared.ts";

const isInboxPath = (path: string) =>
  path === "/inbox" || path === "/communities/inbox" || /^\/(users|c)\/[^/]+\/inbox$/.test(path);

/**
 * Handles one message from palm's queue. `contextFor` builds the request
 * context for a domain, or returns null for one this deployment doesn't serve.
 */
export async function processQueueMessage(body: QueueBody, contextFor: (domain: string) => RequestContext | null): Promise<void> {
  if (body.palm !== "inbox") return processMessage(body, contextFor);
  // Deliveries queued before inbox deferral was dropped.
  const url = new URL(body.url);
  const ctx = contextFor(url.host);
  if (!ctx) return;
  // The delivery, as it arrived, now through Fedify's checks. A bad
  // signature answers 401 to nobody; it's logged and dropped.
  const request = new Request(body.url, { method: "POST", headers: body.headers, body: body.body });
  const response = await handleFederation(request, ctx, () => new Response(null, { status: 404 }));
  if (response.status >= 400) {
    console.warn(JSON.stringify({ palm: "inbox_refused", url: body.url, status: response.status, waited: Date.now() - body.receivedAt }));
  }
}

export { activitySink, runTask } from "./delivery.ts";
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
  const url = new URL(request.url);
  // A delivery to an inbox: dropped or handled cheaply when it's only a vote
  // or a delete (see prefilter.ts), otherwise checked and parsed by Fedify.
  if (request.method === "POST" && isInboxPath(url.pathname)) {
    const body = await request.text();
    const db = ctx.bindings.DB;
    const hosts = ctx.config.domains.map((d) => d.domain.toLowerCase());
    request = new Request(request.url, { method: "POST", headers: request.headers, body });
    const outcome = await triage(db, request, body, hosts, (req, text) => verifySignature(db, req, text)).catch((error: unknown) => {
      console.warn(JSON.stringify({ palm: "triage_failed", error: String(error) }));
      return "fedify" as const;
    });
    if (outcome !== "fedify") return new Response(null, { status: 202 });
  }
  const { people, communities } = await federationsFor(ctx.bindings);
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
