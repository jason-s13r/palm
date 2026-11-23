import type { QueueBody } from "./queue.ts";

/**
 * Which received activities are handled in a queue job instead of the
 * request. Most deliveries (votes, deletes, follows) cost a few ms and stay in
 * the request: a busy Lemmy community sends over a thousand an hour, and each
 * queued one costs three of the free plan's 10,000 daily queue operations. A
 * new post is different: storing it means JSON-LD, the author's profile, its
 * community and its tags, 40-150 ms of CPU. Those are about one delivery in
 * twenty, so they're queued, and the request answers 202 at once.
 *
 * Replies (comments) stay in the request for now, to keep the queue near a
 * quarter of the free plan's daily operations; the `inbox_received` log line
 * says what each delivery was, so the split can be revisited.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

const typeOf = (value: unknown): string | null => {
  if (!isObject(value)) return null;
  const type = Array.isArray(value.type) ? value.type[0] : value.type;
  return typeof type === "string" ? type : null;
};

const POST_TYPES = new Set(["Note", "Page", "Article", "Question", "Video"]);

/** What a delivery is, as logged: its type, and for a Create or Update, what it carries. */
export interface Received {
  type: string | null;
  /** A community's Announce: the type of what it relays. */
  relayed: string | null;
  /** For a Create or Update: the object's type, and whether it's a reply. */
  object: string | null;
  reply: boolean;
}

export function receivedOf(activity: Json): Received {
  const type = typeOf(activity);
  const inner = type === "Announce" && isObject(activity.object) ? activity.object : activity;
  const innerType = typeOf(inner);
  const object = innerType === "Create" || innerType === "Update" ? inner.object : null;
  return {
    type,
    relayed: inner === activity ? null : innerType,
    object: typeOf(object),
    reply: isObject(object) && object.inReplyTo != null && object.inReplyTo !== "",
  };
}

/** Whether a delivery is a new or edited post (not a reply), worth its own queue job. */
export function shouldDefer(received: Received): boolean {
  const create = (received.relayed ?? received.type) === "Create" || (received.relayed ?? received.type) === "Update";
  return create && received.object !== null && POST_TYPES.has(received.object) && !received.reply;
}

/** Queue messages are capped at 128 KB; bigger deliveries are handled in the request. */
const MAX_QUEUED_BYTES = 100_000;

/** Marks a delivery that came back from the queue, so it isn't queued again. */
export const DEFERRED_HEADER = "x-palm-deferred";

/**
 * Puts a delivery on the queue as it arrived (its signature is checked in
 * the job). Returns false when it can't be queued: no queue, too big, or the
 * queue refused (the daily operations used up), and the request handles it.
 */
export async function deferDelivery(queue: Queue | undefined, request: Request, body: string): Promise<boolean> {
  if (!queue || request.headers.has(DEFERRED_HEADER) || !request.headers.has("signature") || body.length > MAX_QUEUED_BYTES) return false;
  const headers = [...request.headers.entries()].filter(([name]) => name !== "cf-connecting-ip" && name !== "x-real-ip" && !name.startsWith("cf-"));
  try {
    await queue.send({ palm: "inbox", url: request.url, headers, body, receivedAt: Date.now() } satisfies QueueBody);
    return true;
  } catch (error) {
    console.warn(JSON.stringify({ palm: "inbox_defer_refused", error: String(error) }));
    return false;
  }
}
