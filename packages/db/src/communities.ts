import type { KeyAlgorithm, StoredKeyPair } from "./federation.ts";

const now = () => Math.floor(Date.now() / 1000);

/**
 * A community: one hosted here (its ActivityPub ID is urls.community), or a
 * remote one palm has met, which has an `apId`.
 */
export interface Community {
  id: number;
  domain: string;
  name: string;
  title: string;
  description: string | null;
  nsfw: boolean;
  createdAt: number;
  apId: string | null;
  inbox: string | null;
  sharedInbox: string | null;
  profileUrl: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  outboxUrl: string | null;
  fetchedAt: number | null;
}

interface CommunityRow {
  id: number;
  domain: string;
  name: string;
  title: string;
  description: string | null;
  nsfw: number;
  created_at: number;
  ap_id: string | null;
  inbox: string | null;
  shared_inbox: string | null;
  profile_url: string | null;
  icon_url: string | null;
  banner_url: string | null;
  outbox_url: string | null;
  fetched_at: number | null;
}

const toCommunity = (r: CommunityRow): Community => ({
  id: r.id,
  domain: r.domain,
  name: r.name,
  title: r.title,
  description: r.description,
  nsfw: r.nsfw === 1,
  createdAt: r.created_at,
  apId: r.ap_id ?? null,
  inbox: r.inbox ?? null,
  sharedInbox: r.shared_inbox ?? null,
  profileUrl: r.profile_url ?? null,
  iconUrl: r.icon_url ?? null,
  bannerUrl: r.banner_url ?? null,
  outboxUrl: r.outbox_url ?? null,
  fetchedAt: r.fetched_at ?? null,
});

export async function communityByApId(db: D1Database, apId: string): Promise<Community | null> {
  const row = await db.prepare("SELECT * FROM communities WHERE ap_id = ?").bind(apId).first<CommunityRow>();
  return row ? toCommunity(row) : null;
}

/** What palm keeps of a remote community. */
export interface RemoteCommunity {
  apId: string;
  domain: string;
  name: string;
  title: string;
  description: string | null;
  nsfw: boolean;
  inbox: string;
  sharedInbox: string | null;
  profileUrl: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  outboxUrl: string | null;
}

/** Records a remote community, or refreshes what palm knows of it. */
export async function upsertRemoteCommunity(db: D1Database, remote: RemoteCommunity): Promise<Community> {
  const at = now();
  const row = await db
    .prepare(
      `INSERT INTO communities (domain, name, title, description, nsfw, created_at, ap_id, inbox, shared_inbox, profile_url, icon_url, banner_url, outbox_url, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (ap_id) WHERE ap_id IS NOT NULL DO UPDATE SET
         title = excluded.title, description = excluded.description, nsfw = excluded.nsfw, inbox = excluded.inbox,
         shared_inbox = excluded.shared_inbox, profile_url = excluded.profile_url, icon_url = excluded.icon_url,
         banner_url = excluded.banner_url, outbox_url = excluded.outbox_url, fetched_at = excluded.fetched_at
       RETURNING *`,
    )
    .bind(
      remote.domain.toLowerCase(),
      remote.name,
      remote.title,
      remote.description,
      remote.nsfw ? 1 : 0,
      at,
      remote.apId,
      remote.inbox,
      remote.sharedInbox,
      remote.profileUrl,
      remote.iconUrl,
      remote.bannerUrl,
      remote.outboxUrl,
      at,
    )
    .first<CommunityRow>();
  return toCommunity(row!);
}

export async function communityById(db: D1Database, id: number): Promise<Community | null> {
  const row = await db.prepare("SELECT * FROM communities WHERE id = ?").bind(id).first<CommunityRow>();
  return row ? toCommunity(row) : null;
}

/** A community by name on a domain: a local one, or a remote one palm already knows. */
export async function communityByName(db: D1Database, domain: string, name: string): Promise<Community | null> {
  const row = await db.prepare("SELECT * FROM communities WHERE domain = ? AND name = ?").bind(domain.toLowerCase(), name).first<CommunityRow>();
  return row ? toCommunity(row) : null;
}

/** Communities by ID, for building many views at once. */
export async function communitiesByIds(db: D1Database, ids: number[]): Promise<Map<number, Community>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const { results } = await db
    .prepare(`SELECT * FROM communities WHERE id IN (${unique.map(() => "?").join(", ")})`)
    .bind(...unique)
    .all<CommunityRow>();
  return new Map(results.map((r) => [r.id, toCommunity(r)]));
}

export interface CommunityStats {
  subscribers: number;
  posts: number;
  comments: number;
  /** Whether the viewer subscribes; "pending" until a remote community accepts. */
  subscribed: boolean;
  pending: boolean;
}

export interface CommunityListing {
  domain: string;
  /** "local" lists this domain's communities; "all" adds the remote ones palm knows. */
  scope?: "local" | "all" | undefined;
  /** Only the ones this account subscribes to. */
  subscribedBy?: number | undefined;
  /** Matches the name or title. */
  query?: string | undefined;
  ids?: number[] | undefined;
  viewerId: number | null;
  limit: number;
  offset: number;
}

/** Communities with their counts, most subscribed first. */
export async function listCommunities(db: D1Database, listing: CommunityListing): Promise<(Community & CommunityStats)[]> {
  const where = [listing.scope === "all" ? "(c.ap_id IS NOT NULL OR c.domain = ?)" : "(c.domain = ? AND c.ap_id IS NULL)"];
  const params: (string | number)[] = [listing.domain];
  if (listing.subscribedBy !== undefined) {
    where.push("EXISTS (SELECT 1 FROM community_subscriptions s WHERE s.community_id = c.id AND s.account_id = ?)");
    params.push(listing.subscribedBy);
  }
  if (listing.ids) {
    if (!listing.ids.length) return [];
    where.push(`c.id IN (${listing.ids.map(() => "?").join(", ")})`);
    params.push(...listing.ids);
  }
  if (listing.query) {
    where.push("(c.name LIKE ? OR c.title LIKE ?)");
    params.push(`%${listing.query}%`, `%${listing.query}%`);
  }
  const { results } = await db
    .prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM community_subscriptions s WHERE s.community_id = c.id)
           + (SELECT COUNT(*) FROM community_followers f WHERE f.community_id = c.id) AS subscribers,
         (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id AND p.root_id IS NULL AND p.deleted_at IS NULL) AS post_count,
         (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id AND p.root_id IS NOT NULL AND p.deleted_at IS NULL) AS comment_count,
         (SELECT state FROM community_subscriptions s WHERE s.community_id = c.id AND s.account_id = ?) AS subscription
       FROM communities c WHERE ${where.join(" AND ")}
       ORDER BY subscribers DESC, c.id LIMIT ? OFFSET ?`,
    )
    .bind(listing.viewerId ?? -1, ...params, listing.limit, listing.offset)
    .all<CommunityRow & { subscribers: number; post_count: number; comment_count: number; subscription: string | null }>();
  return results.map((r) => ({
    ...toCommunity(r),
    subscribers: r.subscribers,
    posts: r.post_count,
    comments: r.comment_count,
    subscribed: r.subscription === "accepted",
    pending: r.subscription === "pending",
  }));
}

export async function countCommunities(db: D1Database, domain: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM communities WHERE domain = ? AND ap_id IS NULL").bind(domain).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Subscribes an account to a community. A remote community's subscription
 * stays "pending" until it accepts the Follow sent as `followApId`.
 */
export async function subscribe(
  db: D1Database,
  communityId: number,
  accountId: number,
  pending?: { followApId: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO community_subscriptions (community_id, account_id, created_at, state, follow_ap_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (community_id, account_id) DO NOTHING`,
    )
    .bind(communityId, accountId, now(), pending ? "pending" : "accepted", pending?.followApId ?? null)
    .run();
}

/** A remote community accepted (or palm assumes it accepted) a subscription. */
export async function acceptSubscription(db: D1Database, communityId: number, accountId: number): Promise<void> {
  await db
    .prepare("UPDATE community_subscriptions SET state = 'accepted' WHERE community_id = ? AND account_id = ?")
    .bind(communityId, accountId)
    .run();
}

/** The subscription a Follow ID belongs to, for matching an Accept or Reject. */
export async function subscriptionByFollow(db: D1Database, followApId: string): Promise<{ communityId: number; accountId: number } | null> {
  const row = await db
    .prepare("SELECT community_id, account_id FROM community_subscriptions WHERE follow_ap_id = ?")
    .bind(followApId)
    .first<{ community_id: number; account_id: number }>();
  return row ? { communityId: row.community_id, accountId: row.account_id } : null;
}

export async function subscription(
  db: D1Database,
  communityId: number,
  accountId: number,
): Promise<{ state: "pending" | "accepted"; followApId: string | null } | null> {
  const row = await db
    .prepare("SELECT state, follow_ap_id FROM community_subscriptions WHERE community_id = ? AND account_id = ?")
    .bind(communityId, accountId)
    .first<{ state: "pending" | "accepted"; follow_ap_id: string | null }>();
  return row ? { state: row.state, followApId: row.follow_ap_id } : null;
}

/** Whether any local account subscribes to a community: if none, palm needn't keep what it sends. */
export async function hasLocalSubscribers(db: D1Database, communityId: number): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM community_subscriptions WHERE community_id = ? LIMIT 1").bind(communityId).first();
  return row !== null;
}

/** Another server's member of a local community. */
export interface CommunityFollower {
  actorId: string;
  inbox: string;
  sharedInbox: string | null;
}

export async function addCommunityFollower(
  db: D1Database,
  communityId: number,
  follower: CommunityFollower & { followId: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO community_followers (community_id, actor_id, inbox, shared_inbox, follow_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (community_id, actor_id) DO UPDATE SET inbox = excluded.inbox, shared_inbox = excluded.shared_inbox, follow_id = excluded.follow_id`,
    )
    .bind(communityId, follower.actorId, follower.inbox, follower.sharedInbox, follower.followId, now())
    .run();
}

export async function removeCommunityFollower(db: D1Database, communityId: number, actorId: string): Promise<void> {
  await db.prepare("DELETE FROM community_followers WHERE community_id = ? AND actor_id = ?").bind(communityId, actorId).run();
}

export async function communityFollowers(db: D1Database, communityId: number): Promise<CommunityFollower[]> {
  const { results } = await db
    .prepare("SELECT actor_id, inbox, shared_inbox FROM community_followers WHERE community_id = ? ORDER BY created_at")
    .bind(communityId)
    .all<{ actor_id: string; inbox: string; shared_inbox: string | null }>();
  return results.map((r) => ({ actorId: r.actor_id, inbox: r.inbox, sharedInbox: r.shared_inbox }));
}

export async function unsubscribe(db: D1Database, communityId: number, accountId: number): Promise<void> {
  await db.prepare("DELETE FROM community_subscriptions WHERE community_id = ? AND account_id = ?").bind(communityId, accountId).run();
}

/** The communities an account subscribes to, with whether each has accepted yet. */
export async function subscriptions(db: D1Database, accountId: number): Promise<(Community & { pending: boolean })[]> {
  const { results } = await db
    .prepare(
      "SELECT c.*, s.state FROM communities c JOIN community_subscriptions s ON s.community_id = c.id WHERE s.account_id = ? ORDER BY c.name",
    )
    .bind(accountId)
    .all<CommunityRow & { state: string }>();
  return results.map((r) => ({ ...toCommunity(r), pending: r.state === "pending" }));
}

/** A community's signing keys, made by `palm community create`. */
export async function communityKeys(db: D1Database, communityId: number): Promise<StoredKeyPair[]> {
  const { results } = await db
    .prepare("SELECT algorithm, public_jwk, private_jwk FROM community_keys WHERE community_id = ?")
    .bind(communityId)
    .all<{ algorithm: KeyAlgorithm; public_jwk: string; private_jwk: string }>();
  return results.map((r) => ({ algorithm: r.algorithm, publicJwk: JSON.parse(r.public_jwk), privateJwk: JSON.parse(r.private_jwk) }));
}
