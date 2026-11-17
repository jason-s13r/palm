import { htmlToText, urls, type RequestContext } from "@palm/core";
import type { Account, Community, CommunityStats, HomeFeed, Post } from "@palm/db";

/**
 * Lemmy apps only show posts that sit in a community, so a person's statuses
 * (Mastodon posts, which have none) show in a "person community": one per
 * person, named after them (`!json@mastodon.nz`). Subscribing to it follows
 * the person; its posts are their statuses and its comments the replies.
 *
 * These communities exist only in palm's Lemmy API. They're never sent to
 * other servers, and their IDs sit above PERSON_COMMUNITY_BASE so they can't
 * meet a real community's. Lemmy's IDs are 32-bit, which leaves room for a
 * billion people; palm's feeds (!following, !local) sit above them.
 */
export const PERSON_COMMUNITY_BASE = 1_000_000_000;


/**
 * palm's own feeds, as communities: !following, the statuses of everyone the
 * viewer follows (like a multireddit of their person communities), and
 * !local, the public statuses of this domain's people. Subscribing to one
 * puts its statuses in the Home feed. Their IDs sit above the person
 * communities' billion.
 */
export const FEEDS = {
  following: {
    id: 2_100_000_000,
    title: "Following",
    description: "Posts from the people you follow. Subscribe to see them in Home.",
  },
  local: {
    id: 2_100_000_001,
    title: "Local",
    description: "Posts from everyone on this server. Subscribe to see them in Home.",
  },
} as const satisfies Record<HomeFeed, { id: number; title: string; description: string }>;

export const feedOfCommunity = (id: number): HomeFeed | null =>
  id === FEEDS.following.id ? "following" : id === FEEDS.local.id ? "local" : null;

export const isFeedName = (name: string): name is HomeFeed => name === "following" || name === "local";

export const isPersonCommunityId = (id: number) => id > PERSON_COMMUNITY_BASE && feedOfCommunity(id) === null;
export const personCommunityId = (accountId: number) => PERSON_COMMUNITY_BASE + accountId;
export const accountIdOfCommunity = (id: number) => id - PERSON_COMMUNITY_BASE;

/** Communities that exist only in palm's Lemmy API: the feeds and person communities. */
export const isVirtualCommunityId = (id: number) => id > PERSON_COMMUNITY_BASE;

export function feedCommunity(feed: HomeFeed, domain: string, createdAt: number): Community {
  return {
    id: FEEDS[feed].id,
    domain,
    name: feed,
    title: FEEDS[feed].title,
    description: FEEDS[feed].description,
    nsfw: false,
    createdAt,
    apId: `https://${domain}/c/${feed}`,
    inbox: null,
    sharedInbox: null,
    profileUrl: null,
    iconUrl: null,
    bannerUrl: null,
    outboxUrl: null,
    fetchedAt: null,
  };
}

/** Whether an account can have a person community: people, not Lemmy communities. */
export const hasPersonCommunity = (account: Account) => account.actorType !== "Group" && !account.banned;

export function personCommunity(account: Account): Community {
  return {
    id: personCommunityId(account.id),
    domain: account.domain,
    name: account.username,
    title: account.displayName || account.username,
    description: account.bio,
    nsfw: false,
    createdAt: account.createdAt,
    // The person's own actor: apps link the community to it.
    apId: account.apId ?? urls.user(account.domain, account.username),
    inbox: null,
    sharedInbox: null,
    profileUrl: account.profileUrl,
    iconUrl: account.avatarUrl,
    bannerUrl: account.headerUrl,
    outboxUrl: null,
    fetchedAt: null,
  };
}

export type FollowStates = Map<number, "accepted" | "pending">;

/** The people whose person communities an account subscribes to (or has asked to), by account ID. */
export async function followStates(db: D1Database, accountId: number | null): Promise<FollowStates> {
  if (accountId === null) return new Map();
  const { results } = await db
    .prepare("SELECT target_id, state FROM account_follows WHERE account_id = ? AND lemmy = 1")
    .bind(accountId)
    .all<{ target_id: number; state: string }>();
  return new Map(results.map((r) => [r.target_id, r.state === "accepted" ? "accepted" : "pending"]));
}

/** A person community with the counts and subscription state Lemmy shows. */
export async function personCommunityStats(
  ctx: RequestContext,
  account: Account,
  viewerId: number | null,
): Promise<Community & CommunityStats> {
  const db = ctx.bindings.DB;
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM account_follows WHERE target_id = ?1 AND state = 'accepted') AS followers,
         (SELECT COUNT(*) FROM posts WHERE account_id = ?1 AND community_id IS NULL AND parent_id IS NULL AND in_reply_to IS NULL
            AND reblog_of IS NULL AND deleted_at IS NULL AND visibility IN ('public', 'unlisted')) AS statuses,
         (SELECT state FROM account_follows WHERE account_id = ?2 AND target_id = ?1 AND lemmy = 1) AS state`,
    )
    .bind(account.id, viewerId ?? -1)
    .first<{ followers: number; statuses: number; state: string | null }>();
  return {
    ...personCommunity(account),
    // A remote person's own counts are better than what palm has seen of them.
    subscribers: account.remoteCounts.followers ?? counts?.followers ?? 0,
    posts: account.remoteCounts.statuses ?? counts?.statuses ?? 0,
    comments: 0,
    subscribed: counts?.state === "accepted",
    pending: counts?.state === "pending",
  };
}

/**
 * A Lemmy title for a status, which has none: its first line, as text,
 * cut at a word near 100 characters.
 */
export function statusTitle(post: Pick<Post, "contentHtml" | "spoilerText">): string {
  if (post.spoilerText) return post.spoilerText;
  const text = htmlToText(post.contentHtml).trim();
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (!line) return "(no text)";
  if (line.length <= 100) return line;
  const cut = line.slice(0, 100);
  const space = cut.lastIndexOf(" ");
  return `${space > 60 ? cut.slice(0, space) : cut}…`;
}
