import type { KeyAlgorithm, StoredKeyPair } from "./federation.ts";

const now = () => Math.floor(Date.now() / 1000);

/** A community hosted here. Its ActivityPub ID is urls.community(domain, name). */
export interface Community {
  id: number;
  domain: string;
  name: string;
  title: string;
  description: string | null;
  nsfw: boolean;
  createdAt: number;
}

interface CommunityRow {
  id: number;
  domain: string;
  name: string;
  title: string;
  description: string | null;
  nsfw: number;
  created_at: number;
}

const toCommunity = (r: CommunityRow): Community => ({
  id: r.id,
  domain: r.domain,
  name: r.name,
  title: r.title,
  description: r.description,
  nsfw: r.nsfw === 1,
  createdAt: r.created_at,
});

export async function communityById(db: D1Database, id: number): Promise<Community | null> {
  const row = await db.prepare("SELECT * FROM communities WHERE id = ?").bind(id).first<CommunityRow>();
  return row ? toCommunity(row) : null;
}

export async function communityByName(db: D1Database, domain: string, name: string): Promise<Community | null> {
  const row = await db.prepare("SELECT * FROM communities WHERE domain = ? AND name = ?").bind(domain, name).first<CommunityRow>();
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
  /** Whether the viewer subscribes. */
  subscribed: boolean;
}

export interface CommunityListing {
  domain: string;
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
  const where = ["c.domain = ?"];
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
         (SELECT COUNT(*) FROM community_subscriptions s WHERE s.community_id = c.id) AS subscribers,
         (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id AND p.root_id IS NULL AND p.deleted_at IS NULL) AS post_count,
         (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id AND p.root_id IS NOT NULL AND p.deleted_at IS NULL) AS comment_count,
         EXISTS (SELECT 1 FROM community_subscriptions s WHERE s.community_id = c.id AND s.account_id = ?) AS subscribed
       FROM communities c WHERE ${where.join(" AND ")}
       ORDER BY subscribers DESC, c.id LIMIT ? OFFSET ?`,
    )
    .bind(listing.viewerId ?? -1, ...params, listing.limit, listing.offset)
    .all<CommunityRow & { subscribers: number; post_count: number; comment_count: number; subscribed: number }>();
  return results.map((r) => ({
    ...toCommunity(r),
    subscribers: r.subscribers,
    posts: r.post_count,
    comments: r.comment_count,
    subscribed: r.subscribed === 1,
  }));
}

export async function countCommunities(db: D1Database, domain: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM communities WHERE domain = ?").bind(domain).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function subscribe(db: D1Database, communityId: number, accountId: number): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO community_subscriptions (community_id, account_id, created_at) VALUES (?, ?, ?)")
    .bind(communityId, accountId, now())
    .run();
}

export async function unsubscribe(db: D1Database, communityId: number, accountId: number): Promise<void> {
  await db.prepare("DELETE FROM community_subscriptions WHERE community_id = ? AND account_id = ?").bind(communityId, accountId).run();
}

/** The communities an account subscribes to. */
export async function subscriptions(db: D1Database, accountId: number): Promise<Community[]> {
  const { results } = await db
    .prepare(
      "SELECT c.* FROM communities c JOIN community_subscriptions s ON s.community_id = c.id WHERE s.account_id = ? ORDER BY c.name",
    )
    .bind(accountId)
    .all<CommunityRow>();
  return results.map(toCommunity);
}

/** A community's signing keys, made by `palm community create`. */
export async function communityKeys(db: D1Database, communityId: number): Promise<StoredKeyPair[]> {
  const { results } = await db
    .prepare("SELECT algorithm, public_jwk, private_jwk FROM community_keys WHERE community_id = ?")
    .bind(communityId)
    .all<{ algorithm: KeyAlgorithm; public_jwk: string; private_jwk: string }>();
  return results.map((r) => ({ algorithm: r.algorithm, publicJwk: JSON.parse(r.public_jwk), privateJwk: JSON.parse(r.private_jwk) }));
}
