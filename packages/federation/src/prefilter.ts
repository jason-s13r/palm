import { remoteVote, setPostFlag } from "@palm/db";

/**
 * A cheap first look at a delivery, before Fedify parses it and checks its
 * signature. Most of what a busy Lemmy community relays is votes:
 *
 * - A vote, undone vote or delete about something palm never kept can't
 *   change anything here. It's answered 202 and dropped unchecked.
 * - A vote on a remote post palm keeps only moves a score. Its signature is
 *   checked here (see verifySignature) and the vote written straight to D1,
 *   without Fedify parsing it or fetching the voter's profile. It's kept by
 *   the voter's ActivityPub ID (remote_votes), with no account for them.
 *
 * - Anything a community relays (Announce) when nobody here subscribes to it
 *   is dropped: its server may have missed an unsubscribe.
 *
 * Everything else, including votes on local posts (which notify their
 * author), goes through Fedify as before.
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

/** What an activity does to something palm must already hold, if that's all it does. */
export type Act =
  | { kind: "vote"; target: string; voter: string | null; score: number }
  | { kind: "unvote"; target: string; voter: string | null }
  | { kind: "delete"; target: string }
  | { kind: "unboost"; target: string }
  /** A Lemmy community's moderators locking or pinning a post (Fedify doesn't know Lock). */
  | { kind: "lock" | "feature"; target: string; value: boolean };

export function actOf(activity: unknown): Act | null {
  // A community's Announce wraps the activity it relays.
  const inner = typeOf(activity) === "Announce" && isObject((activity as Json).object) ? (activity as Json).object : activity;
  if (!isObject(inner)) return null;
  const type = typeOf(inner);
  const actor = idOf(inner.actor);
  if (type && VOTES.has(type)) {
    const target = idOf(inner.object);
    // An emoji reaction counts as an upvote, as Lemmy shows them.
    return target ? { kind: "vote", target, voter: actor, score: type === "Dislike" ? -1 : 1 } : null;
  }
  if (type === "Lock") {
    const target = idOf(inner.object);
    return target ? { kind: "lock", target, value: true } : null;
  }
  if ((type === "Add" || type === "Remove") && /\/featured$/.test(idOf(inner.target) ?? "")) {
    const target = idOf(inner.object);
    return target ? { kind: "feature", target, value: type === "Add" } : null;
  }
  if (type === "Delete") {
    const target = idOf(inner.object);
    return target ? { kind: "delete", target } : null;
  }
  if (type === "Undo" && isObject(inner.object)) {
    const undone = typeOf(inner.object);
    const target = idOf(inner.object.object);
    if (!target) return null;
    if (undone && VOTES.has(undone)) return { kind: "unvote", target, voter: idOf(inner.object.actor) ?? actor };
    if (undone === "Announce") return { kind: "unboost", target };
    if (undone === "Lock") return { kind: "lock", target, value: false };
  }
  return null;
}

export type Triage = "drop" | "handled" | "fedify";

/**
 * Decides what to do with a delivery: drop it, handle it here (a vote on a
 * remote post, once its signature checks out), or pass it to Fedify.
 */
export async function triage(
  db: D1Database,
  request: Request,
  body: string,
  localHosts: readonly string[],
  verify: (request: Request, body: string) => Promise<string | null>,
): Promise<Triage> {
  let activity: unknown;
  try {
    activity = JSON.parse(body);
  } catch {
    return "fedify";
  }
  // A community nobody here subscribes to anymore, still relaying to palm
  // (its server missed the unsubscribe): everything it sends is dropped,
  // before it writes posts, comments and votes nobody here would see.
  if (typeOf(activity) === "Announce") {
    const from = idOf((activity as Json).actor);
    let fromHost: string | null = null;
    try {
      fromHost = from ? new URL(from).host.toLowerCase() : null;
    } catch {
      fromHost = null;
    }
    if (from && fromHost && !localHosts.includes(fromHost)) {
      const row = await db
        .prepare(
          `SELECT EXISTS (SELECT 1 FROM communities WHERE ap_id = ?1) AS known,
                  EXISTS (SELECT 1 FROM community_subscriptions s JOIN communities c ON c.id = s.community_id WHERE c.ap_id = ?1) AS subscribed`,
        )
        .bind(from)
        .first<{ known: number; subscribed: number }>();
      if (row?.known && !row.subscribed) return "drop";
    }
  }
  const act = actOf(activity);
  if (!act) return "fedify";
  let host: string;
  try {
    host = new URL(act.target).host.toLowerCase();
  } catch {
    return "fedify";
  }
  // Local posts and people have no ap_id to look up, and votes on them notify.
  if (localHosts.includes(host)) return "fedify";
  const post = await db.prepare("SELECT id, community_id FROM posts WHERE ap_id = ?1").bind(act.target).first<{ id: number; community_id: number | null }>();
  if (!post) {
    if (act.kind !== "delete") return "drop";
    const account = await db.prepare("SELECT 1 FROM accounts WHERE ap_id = ?1").bind(act.target).first();
    return account ? "fedify" : "drop";
  }
  if (act.kind === "lock" || act.kind === "feature") {
    // Only the post's own community (or a moderator on its server) may.
    const community = post.community_id
      ? await db.prepare("SELECT ap_id FROM communities WHERE id = ?").bind(post.community_id).first<{ ap_id: string | null }>()
      : null;
    if (!community?.ap_id) return "drop";
    const signer = await verify(request, body);
    if (!signer) return "drop";
    const allowed = signer === community.ap_id || new URL(signer).host === new URL(community.ap_id).host;
    if (!allowed) return "drop";
    await setPostFlag(db, post.id, act.kind === "lock" ? "locked" : "featured_community", act.value);
    return "handled";
  }
  if ((act.kind !== "vote" && act.kind !== "unvote") || !act.voter) return "fedify";
  // The signer is the voter, or a community relaying the vote.
  const signer = await verify(request, body);
  if (!signer) return "fedify";
  const signerHost = new URL(signer).host.toLowerCase();
  const voterHost = new URL(act.voter).host.toLowerCase();
  const wrapped = typeOf(activity) === "Announce";
  if (!wrapped && signerHost !== voterHost) return "fedify";
  if (wrapped && signer !== idOf((activity as Json).actor)) return "fedify";
  await remoteVote(db, post.id, act.voter, act.kind === "vote" ? act.score : 0);
  return "handled";
}
