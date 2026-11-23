import type { RequestContext } from "@palm/core";
// Registering the two federations' dispatchers and listeners.
import "./people.ts";
import "./communities.ts";
import { processQueueMessage as processMessage } from "./delivery.ts";
import type { QueueBody } from "./queue.ts";
import { triage } from "./prefilter.ts";
import { verifySignature } from "./signature.ts";
import { trustedDelivery } from "./inbox-auth.ts";
import { DEFERRED_HEADER, deferDelivery, receivedOf, shouldDefer } from "./defer.ts";
import { federationsFor } from "./shared.ts";
import { isStoryActivity, receiveStoryActivity } from "./stories.ts";

const isInboxPath = (path: string) =>
  path === "/inbox" || path === "/communities/inbox" || /^\/(users|c)\/[^/]+\/inbox$/.test(path);

/**
 * Handles one message from palm's queue. `contextFor` builds the request
 * context for a domain, or returns null for one this deployment doesn't serve.
 */
export async function processQueueMessage(body: QueueBody, contextFor: (domain: string) => RequestContext | null): Promise<void> {
  if (body.palm !== "inbox") return processMessage(body, contextFor);
  // A delivery deferred to the queue (see defer.ts).
  const url = new URL(body.url);
  const ctx = contextFor(url.host);
  if (!ctx) return;
  // The delivery, as it arrived, now through Fedify's checks. A bad
  // signature answers 401 to nobody; it's logged and dropped.
  const headers = new Headers(body.headers);
  headers.set(DEFERRED_HEADER, "1");
  const request = new Request(body.url, { method: "POST", headers, body: body.body });
  const response = await handleFederation(request, ctx, () => new Response(null, { status: 404 }));
  if (response.status >= 400) {
    console.warn(JSON.stringify({ palm: "inbox_refused", url: body.url, status: response.status, waited: Date.now() - body.receivedAt }));
  }
}

export { activitySink, runTask } from "./delivery.ts";
export { serveStory } from "./stories.ts";
export { serveVideoObject } from "./videos.ts";
export { D1KvStore } from "./kv.ts";
export { CloudflareMessageQueue } from "./queue.ts";
export type { FederationName, QueueBody } from "./queue.ts";

/**
 * Serves one request on the bare domain. Communities (/c/...) go to their
 * federation; everything else to people's, and WebFinger falls through to
 * communities when no person has the name. Anything neither handles goes to
 * `fallback`, which redirects browsers or answers 404.
 */
/** What the two federations answer: actors, objects, inboxes, WebFinger and nodeinfo. */
const FEDIFY_PATH = /^\/(users\/|c\/|objects\/|inbox$|communities\/inbox$|nodeinfo\/|\.well-known\/(webfinger|nodeinfo)$)/;

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
    // Pixelfed's stories: Fedify knows neither the Story type nor Story:Reply,
    // so they're checked and handled here.
    const parsed = parseJson(body);
    if (parsed && isStoryActivity(parsed)) {
      const signer = await verifySignature(db, request, body).catch(() => null);
      if (signer) {
        await receiveStoryActivity(ctx, parsed, signer).catch((error: unknown) =>
          console.warn(JSON.stringify({ palm: "story_activity_failed", type: parsed.type, error: String(error) })),
        );
      }
      return new Response(null, { status: 202 });
    }
    const outcome = await triage(db, request, body, hosts, (req, text) => verifySignature(db, req, text)).catch((error: unknown) => {
      console.warn(JSON.stringify({ palm: "triage_failed", error: String(error) }));
      return "fedify" as const;
    });
    if (outcome !== "fedify") return new Response(null, { status: 202 });
    // A new post is costly to store, so it's handled in a queue job of its own.
    const received = parsed ? receivedOf(parsed) : null;
    const deferred = received !== null && shouldDefer(received) && (await deferDelivery(ctx.bindings.QUEUE, request, body));
    if (received && !request.headers.has(DEFERRED_HEADER)) console.log(JSON.stringify({ palm: "inbox_received", ...received, deferred }));
    if (deferred) return new Response(null, { status: 202 });
    // An activity whose HTTP signature is its own actor's: its LD signature
    // needn't be checked (see inbox-auth.ts).
    const trusted = parsed ? await trustedDelivery(db, request, body, parsed) : null;
    if (trusted) {
      const { people, communities } = await federationsFor(ctx.bindings, true);
      const options = { contextData: ctx, onNotFound: fallback, onNotAcceptable: fallback };
      const target = url.pathname.startsWith("/c/") || url.pathname === "/communities/inbox" ? communities : people;
      return target.fetch(trusted, options);
    }
  }
  // A local post asked for by Lemmy's paths (/post/{id}, /comment/{id}), as
  // newer posts are minted: Fedify serves it from /objects/{id}, whichever ID
  // it was minted with. Browsers get the web page.
  const alias = request.method === "GET" && /activity\+json|ld\+json/.test(request.headers.get("accept") ?? "") ? /^\/(?:post|comment)\/(\d+)$/.exec(url.pathname) : null;
  if (alias) {
    const objectUrl = new URL(`/objects/${alias[1]}`, url);
    return handleFederation(new Request(objectUrl, { headers: request.headers }), ctx, fallback);
  }
  // Paths Fedify doesn't serve (web pages, the bare domain, scanners trying
  // /.env) go straight to the fallback: building the federations costs more
  // CPU than the rest of such a request.
  if (!FEDIFY_PATH.test(url.pathname)) return fallback(request);
  const { people, communities } = await federationsFor(ctx.bindings);
  const options = {
    contextData: ctx,
    onNotFound: fallback,
    // A browser asking for an actor or object gets the browser fallback too.
    onNotAcceptable: fallback,
  };
  if (url.pathname.startsWith("/c/") || url.pathname === "/communities/inbox") return publicAddressing(await communities.fetch(request, options));
  if (url.pathname === "/.well-known/webfinger") {
    return people.fetch(request, { ...options, onNotFound: (req) => communities.fetch(req, options) });
  }
  return publicAddressing(await people.fetch(request, options));
}

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const ADDRESSING = new Set(["to", "cc", "bto", "bcc", "audience"]);

/**
 * Spells out `as:Public` in addressing, and makes a lone `attachment` a list,
 * as Fedify does for what it sends.
 */
function forLemmy(value: unknown, key?: string, listed = false): unknown {
  if (typeof value === "string") return key && ADDRESSING.has(key) && (value === "as:Public" || value === "Public") ? PUBLIC : value;
  if (Array.isArray(value)) return value.map((v) => forLemmy(v, key, true));
  if (value && typeof value === "object") {
    const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "@context" ? v : forLemmy(v, k)]));
    return key === "attachment" && !listed ? [out] : out;
  }
  return value;
}

/**
 * Objects and collections palm serves, readable by Lemmy 0.19: it compares
 * addressing as plain URLs, so it refuses a fetched post addressed to
 * `as:Public` as not public; and it reads `attachment` only as a list, so a
 * link post with its link as a lone Link fails to parse at all, and every
 * vote or comment on it sends the server to fetch it again. Fedify fixes both
 * in what it sends, not in what it serves. Signed documents are left as they
 * are.
 */
async function publicAddressing(res: Response): Promise<Response> {
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !/activity\+json|ld\+json/.test(type)) return res;
  const text = await res.text();
  if (!text.includes("Public") && !/"attachment"\s*:\s*\{/.test(text)) return new Response(text, res);
  const doc = JSON.parse(text) as Record<string, unknown>;
  if ("proof" in doc || "signature" in doc) return new Response(text, res);
  return new Response(JSON.stringify(forLemmy(doc)), res);
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
