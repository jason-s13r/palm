import type { RequestContext } from "@palm/core";
// Registering the two federations' dispatchers and listeners.
import "./people.ts";
import "./communities.ts";
import { processQueueMessage as processMessage } from "./delivery.ts";
import type { QueueBody } from "./queue.ts";
import { federationsFor } from "./shared.ts";

/** Queue messages are capped at 128 KB; bigger deliveries are checked in the request. */
const MAX_DEFERRED_BODY = 100_000;

const isInboxPath = (path: string) =>
  path === "/inbox" || path === "/communities/inbox" || /^\/(users|c)\/[^/]+\/inbox$/.test(path);

/**
 * Handles one message from palm's queue. `contextFor` builds the request
 * context for a domain, or returns null for one this deployment doesn't serve.
 */
export async function processQueueMessage(body: QueueBody, contextFor: (domain: string) => RequestContext | null): Promise<void> {
  if (body.palm !== "inbox") return processMessage(body, contextFor);
  const url = new URL(body.url);
  const ctx = contextFor(url.host);
  if (!ctx) return;
  // The delivery, as it arrived, now through Fedify's checks. A bad
  // signature answers 401 to nobody; it's logged and dropped.
  const request = new Request(body.url, { method: "POST", headers: body.headers, body: body.body });
  const response = await handleFederation(request, ctx, () => new Response(null, { status: 404 }), { deferInbox: false });
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
  mode: { deferInbox?: boolean } = {},
): Promise<Response> {
  const url = new URL(request.url);
  // A delivery to an inbox: with a queue, take it now and check its signature
  // in a queue job. Checking it here (fetching the sender's key, parsing the
  // activity) costs more CPU than the free plan gives a request.
  const queue = ctx.bindings.QUEUE;
  if ((mode.deferInbox ?? true) && queue && request.method === "POST" && isInboxPath(url.pathname)) {
    const body = await request.text();
    if (body.length <= MAX_DEFERRED_BODY) {
      await queue.send({
        palm: "inbox",
        url: request.url,
        headers: [...request.headers.entries()],
        body,
        receivedAt: Date.now(),
      } satisfies QueueBody);
      return new Response(null, { status: 202 });
    }
    request = new Request(request.url, { method: "POST", headers: request.headers, body });
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
