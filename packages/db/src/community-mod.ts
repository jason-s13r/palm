import { toCommunity, type Community, type CommunityRow } from "./communities.ts";
import type { InviteKeyPair } from "./moderation.ts";

/**
 * Community moderation: who moderates, who's banned, reports, and the log
 * Lemmy apps show. Admins can do everything a moderator can, everywhere.
 */

const now = () => Math.floor(Date.now() / 1000);

export async function moderatorIds(db: D1Database, communityId: number): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT account_id FROM community_mods WHERE community_id = ? ORDER BY created_at")
    .bind(communityId)
    .all<{ account_id: number }>();
  return results.map((r) => r.account_id);
}

export async function moderatedCommunityIds(db: D1Database, accountId: number): Promise<number[]> {
  const { results } = await db.prepare("SELECT community_id FROM community_mods WHERE account_id = ?").bind(accountId).all<{ community_id: number }>();
  return results.map((r) => r.community_id);
}

export async function isModerator(db: D1Database, communityId: number, accountId: number): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM community_mods WHERE community_id = ? AND account_id = ?").bind(communityId, accountId).first()) !== null;
}

export async function setModerator(db: D1Database, communityId: number, accountId: number, on: boolean): Promise<void> {
  if (on) await db.prepare("INSERT OR IGNORE INTO community_mods (community_id, account_id, created_at) VALUES (?, ?, ?)").bind(communityId, accountId, now()).run();
  else await db.prepare("DELETE FROM community_mods WHERE community_id = ? AND account_id = ?").bind(communityId, accountId).run();
}

export async function isCommunityBanned(db: D1Database, communityId: number, accountId: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM community_bans WHERE community_id = ? AND account_id = ? AND (expires_at IS NULL OR expires_at > ?)")
    .bind(communityId, accountId, now())
    .first();
  return row !== null;
}

export async function setCommunityBan(
  db: D1Database,
  communityId: number,
  accountId: number,
  on: boolean,
  options: { reason?: string | null; expiresAt?: number | null } = {},
): Promise<void> {
  if (on) {
    await db
      .prepare("INSERT OR REPLACE INTO community_bans (community_id, account_id, reason, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(communityId, accountId, options.reason ?? null, options.expiresAt ?? null, now())
      .run();
  } else {
    await db.prepare("DELETE FROM community_bans WHERE community_id = ? AND account_id = ?").bind(communityId, accountId).run();
  }
}

export type PostFlag = "locked" | "featured_community" | "featured_local";

export async function setPostFlag(db: D1Database, postId: number, flag: PostFlag, value: boolean): Promise<void> {
  await db.prepare(`UPDATE posts SET ${flag} = ? WHERE id = ?`).bind(value ? 1 : 0, postId).run();
}

// --- making communities from apps --------------------------------------------

/** Adds key pairs made by the CLI, for communities people create from apps. */
export async function addSpareKeys(db: D1Database, keyPairs: InviteKeyPair[]): Promise<void> {
  await db.prepare("INSERT INTO spare_keys (key_pairs, created_at) VALUES (?, ?)").bind(JSON.stringify(keyPairs), now()).run();
}

export async function countSpareKeys(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM spare_keys").first<{ n: number }>())?.n ?? 0;
}

/**
 * Creates a local community with spare keys (making keys in the Worker
 * costs more CPU than the free plan allows), and makes its creator its
 * moderator. Null when the name is taken or no keys are left.
 */
export async function createLocalCommunity(
  db: D1Database,
  community: { domain: string; name: string; title: string; description: string | null; nsfw: boolean; iconUrl: string | null; bannerUrl: string | null },
  creatorId: number,
): Promise<Community | "taken" | "no_keys"> {
  const taken = await db
    .prepare("SELECT 1 FROM accounts WHERE domain = ?1 AND username = ?2 UNION SELECT 1 FROM communities WHERE domain = ?1 AND name = ?2 AND ap_id IS NULL")
    .bind(community.domain, community.name)
    .first();
  if (taken) return "taken";
  const keys = await db.prepare("DELETE FROM spare_keys WHERE id = (SELECT MIN(id) FROM spare_keys) RETURNING key_pairs").first<{ key_pairs: string }>();
  if (!keys) return "no_keys";
  const at = now();
  const row = await db
    .prepare(
      `INSERT INTO communities (domain, name, title, description, nsfw, created_at, icon_url, banner_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(community.domain, community.name, community.title, community.description, community.nsfw ? 1 : 0, at, community.iconUrl, community.bannerUrl)
    .first<CommunityRow>();
  const created = toCommunity(row!);
  const pairs = JSON.parse(keys.key_pairs) as InviteKeyPair[];
  await db.batch([
    db.prepare("INSERT INTO community_mods (community_id, account_id, created_at) VALUES (?, ?, ?)").bind(created.id, creatorId, at),
    db.prepare("INSERT OR IGNORE INTO community_subscriptions (community_id, account_id, created_at) VALUES (?, ?, ?)").bind(created.id, creatorId, at),
    ...pairs.map((k) =>
      db
        .prepare("INSERT OR REPLACE INTO community_keys (community_id, algorithm, public_jwk, private_jwk, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(created.id, k.algorithm, JSON.stringify(k.publicJwk), JSON.stringify(k.privateJwk), at),
    ),
  ]);
  return created;
}

export async function updateCommunity(
  db: D1Database,
  id: number,
  changes: { title?: string | undefined; description?: string | null | undefined; nsfw?: boolean | undefined; iconUrl?: string | null | undefined; bannerUrl?: string | null | undefined },
): Promise<void> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const set = (column: string, value: string | number | null | undefined) => {
    if (value === undefined) return;
    sets.push(`${column} = ?`);
    params.push(value);
  };
  set("title", changes.title);
  set("description", changes.description);
  set("nsfw", changes.nsfw === undefined ? undefined : changes.nsfw ? 1 : 0);
  set("icon_url", changes.iconUrl);
  set("banner_url", changes.bannerUrl);
  if (!sets.length) return;
  await db.prepare(`UPDATE communities SET ${sets.join(", ")} WHERE id = ?`).bind(...params, id).run();
}

// --- reports ---------------------------------------------------------------

export interface Report {
  id: number;
  reporterId: number;
  postId: number | null;
  accountId: number;
  reason: string;
  resolved: boolean;
  resolverId: number | null;
  createdAt: number;
  updatedAt: number | null;
}

type ReportRow = {
  id: number;
  reporter_id: number;
  post_id: number | null;
  account_id: number;
  reason: string;
  resolved: number;
  resolver_id: number | null;
  created_at: number;
  updated_at: number | null;
};

const toReport = (r: ReportRow): Report => ({
  id: r.id,
  reporterId: r.reporter_id,
  postId: r.post_id,
  accountId: r.account_id,
  reason: r.reason,
  resolved: r.resolved === 1,
  resolverId: r.resolver_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function createReport(
  db: D1Database,
  report: { reporterId: number; postId: number | null; accountId: number; reason: string; apId?: string | null },
): Promise<Report> {
  const row = await db
    .prepare("INSERT INTO reports (reporter_id, post_id, account_id, reason, ap_id, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
    .bind(report.reporterId, report.postId, report.accountId, report.reason.slice(0, 2000), report.apId ?? null, now())
    .first<ReportRow>();
  return toReport(row!);
}

/**
 * Reports on posts (Lemmy posts, `comments` false) or comments. Moderators
 * see their communities' reports; `communityIds` null means every one (admins).
 */
export async function listReports(
  db: D1Database,
  options: { comments: boolean; communityIds: number[] | null; unresolvedOnly: boolean; limit: number; offset: number },
): Promise<Report[]> {
  if (options.communityIds && !options.communityIds.length) return [];
  const where = [`p.root_id IS ${options.comments ? "NOT NULL" : "NULL"}`];
  const params: (number | string)[] = [];
  if (options.unresolvedOnly) where.push("r.resolved = 0");
  if (options.communityIds) {
    where.push(`p.community_id IN (${options.communityIds.map(() => "?").join(", ")})`);
    params.push(...options.communityIds);
  }
  const { results } = await db
    .prepare(`SELECT r.* FROM reports r JOIN posts p ON p.id = r.post_id WHERE ${where.join(" AND ")} ORDER BY r.id DESC LIMIT ? OFFSET ?`)
    .bind(...params, options.limit, options.offset)
    .all<ReportRow>();
  return results.map(toReport);
}

export async function reportById(db: D1Database, id: number): Promise<Report | null> {
  const row = await db.prepare("SELECT * FROM reports WHERE id = ?").bind(id).first<ReportRow>();
  return row ? toReport(row) : null;
}

export async function resolveReport(db: D1Database, id: number, resolverId: number, resolved: boolean): Promise<void> {
  await db.prepare("UPDATE reports SET resolved = ?, resolver_id = ?, updated_at = ? WHERE id = ?").bind(resolved ? 1 : 0, resolverId, now(), id).run();
}

export async function countOpenReports(db: D1Database, communityIds: number[] | null): Promise<{ posts: number; comments: number }> {
  if (communityIds && !communityIds.length) return { posts: 0, comments: 0 };
  const scope = communityIds ? `AND p.community_id IN (${communityIds.map(() => "?").join(", ")})` : "";
  const row = await db
    .prepare(
      `SELECT SUM(p.root_id IS NULL) AS posts, SUM(p.root_id IS NOT NULL) AS comments
       FROM reports r JOIN posts p ON p.id = r.post_id WHERE r.resolved = 0 ${scope}`,
    )
    .bind(...(communityIds ?? []))
    .first<{ posts: number | null; comments: number | null }>();
  return { posts: row?.posts ?? 0, comments: row?.comments ?? 0 };
}

// --- the mod log -------------------------------------------------------------

export type ModAction = "remove_post" | "remove_comment" | "lock_post" | "feature_post" | "ban_from_community" | "ban" | "add_mod";

export interface ModLogEntry {
  id: number;
  kind: ModAction;
  modId: number;
  postId: number | null;
  accountId: number | null;
  communityId: number | null;
  reason: string | null;
  value: boolean;
  createdAt: number;
}

export async function logMod(
  db: D1Database,
  entry: { kind: ModAction; modId: number; postId?: number | null; accountId?: number | null; communityId?: number | null; reason?: string | null; value?: boolean },
): Promise<void> {
  await db
    .prepare("INSERT INTO mod_log (kind, mod_id, post_id, account_id, community_id, reason, value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(entry.kind, entry.modId, entry.postId ?? null, entry.accountId ?? null, entry.communityId ?? null, entry.reason ?? null, entry.value === false ? 0 : 1, now())
    .run();
}

export async function listModLog(db: D1Database, options: { communityId?: number | undefined; limit: number; offset: number }): Promise<ModLogEntry[]> {
  const { results } = await db
    .prepare(`SELECT * FROM mod_log ${options.communityId !== undefined ? "WHERE community_id = ?" : ""} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...(options.communityId !== undefined ? [options.communityId] : []), options.limit, options.offset)
    .all<{ id: number; kind: ModAction; mod_id: number; post_id: number | null; account_id: number | null; community_id: number | null; reason: string | null; value: number; created_at: number }>();
  return results.map((r) => ({
    id: r.id,
    kind: r.kind,
    modId: r.mod_id,
    postId: r.post_id,
    accountId: r.account_id,
    communityId: r.community_id,
    reason: r.reason,
    value: r.value === 1,
    createdAt: r.created_at,
  }));
}
