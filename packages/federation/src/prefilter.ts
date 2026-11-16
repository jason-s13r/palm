/**
 * A cheap first look at a delivery, before Fedify parses it and checks its
 * signature. Most of what a busy Lemmy community relays is votes, and most of
 * those are on posts palm never kept; Mastodon sends a Delete for every
 * account removed anywhere it federates with. Neither can change anything
 * here, so they're answered 202 and dropped.
 *
 * Only activities that act on something palm must already hold are dropped
 * this way. Anything that could create a row (Create, Update, Follow,
 * Announce of a post) goes through Fedify as before.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

const typeOf = (value: unknown): string | null => {
  if (!isObject(value)) return null;
  const type = Array.isArray(value.type) ? value.type[0] : value.type;
  return typeof type === "string" ? type : null;
};

const idOf = (value: unknown): string | null =>
  typeof value === "string" ? value : isObject(value) && typeof value.id === "string" ? value.id : null;

const VOTES = new Set(["Like", "Dislike", "EmojiReact"]);

/** The id an activity acts on, when it can only act on something already held. */
export function existingTarget(activity: unknown): string | null {
  // A community's Announce wraps the activity it relays.
  const inner = typeOf(activity) === "Announce" && isObject((activity as Json).object) ? (activity as Json).object : activity;
  const type = typeOf(inner);
  if (!isObject(inner)) return null;
  if (type && VOTES.has(type)) return idOf(inner.object);
  if (type === "Delete") return idOf(inner.object);
  if (type === "Undo") {
    const undone = typeOf(inner.object);
    if (undone && (VOTES.has(undone) || undone === "Announce")) return idOf((inner.object as Json).object);
  }
  return null;
}

/** Whether a delivery's body can be dropped without checking it. */
export async function irrelevantDelivery(db: D1Database, body: string, localHosts: readonly string[]): Promise<boolean> {
  let activity: unknown;
  try {
    activity = JSON.parse(body);
  } catch {
    return false;
  }
  const target = existingTarget(activity);
  if (!target) return false;
  let host: string;
  try {
    host = new URL(target).host.toLowerCase();
  } catch {
    return false;
  }
  // Local posts and people have no ap_id row to look up.
  if (localHosts.includes(host)) return false;
  const held = await db
    .prepare("SELECT 1 FROM posts WHERE ap_id = ?1 UNION ALL SELECT 1 FROM accounts WHERE ap_id = ?1 LIMIT 1")
    .bind(target)
    .first();
  return !held;
}
