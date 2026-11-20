import { verifySignature } from "./signature.ts";

/**
 * Mastodon (and others) attach a Linked Data Signature (RsaSignature2017) to
 * public activities as well as signing the HTTP request. When an activity
 * carries one, Fedify checks it first, which means canonicalising the whole
 * activity as RDF: tens of milliseconds of CPU, most of a delivery's cost and
 * well past the free plan's 10 ms.
 *
 * The LD signature only matters when the activity is passed on by someone
 * else (a forwarded reply). When the HTTP signature is the activity's own
 * actor's, it already proves who sent it. palm checks that signature here,
 * with its cached keys (see signature.ts), and hands the activity, without its
 * LD signature, to federations that skip Fedify's checks. Anything else
 * (forwarded activities, signatures palm can't check) goes to Fedify as before.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The same test Fedify uses for an LD signature it would verify. */
export function hasLdSignature(activity: Json): boolean {
  const signature = activity.signature;
  return isObject(signature) && signature.type === "RsaSignature2017" && typeof signature.signatureValue === "string";
}

const actorOf = (activity: Json): string | null =>
  typeof activity.actor === "string" ? activity.actor : isObject(activity.actor) && typeof activity.actor.id === "string" ? activity.actor.id : null;

/** The headers a draft-cavage signature covers, lowercased. */
function signedHeaders(request: Request): string[] {
  const header = request.headers.get("signature") ?? "";
  const listed = /headers="([^"]*)"/i.exec(header)?.[1] ?? "date";
  return listed.toLowerCase().split(/\s+/);
}

/**
 * The delivery to hand to the trusted federations, or null when Fedify must
 * check it itself. `body` is the delivery as received; `activity` is it parsed.
 */
export async function trustedDelivery(
  db: D1Database,
  request: Request,
  body: string,
  activity: Json,
  verify: (request: Request, body: string) => Promise<string | null> = (req, text) => verifySignature(db, req, text),
): Promise<Request | null> {
  if (!hasLdSignature(activity)) return null;
  const actor = actorOf(activity);
  if (!actor) return null;
  // The host must be signed too, so a delivery meant for another server
  // can't be replayed here. (Digest, date and the request target are checked
  // in verifySignature.)
  if (!signedHeaders(request).includes("host")) return null;
  const signer = await verify(request, body).catch(() => null);
  if (signer !== actor) return null;
  const { signature: _ld, ...unsigned } = activity;
  const headers = new Headers(request.headers);
  // The body changes, so these no longer describe it; nothing reads them past here.
  headers.delete("content-length");
  headers.delete("digest");
  return new Request(request.url, { method: "POST", headers, body: JSON.stringify(unsigned) });
}
