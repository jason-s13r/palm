/**
 * What each person has chosen not to see: people they block or mute,
 * communities they block, and whole servers they block. Applied when views
 * are built (see Hidden), so every listing stays one query.
 */

const now = () => Math.floor(Date.now() / 1000);

export type BlockKind = "block" | "mute";

export async function blockAccount(
  db: D1Database,
  accountId: number,
  targetId: number,
  kind: BlockKind,
  options: { hideNotifications?: boolean; expiresAt?: number | null; blockApId?: string | null } = {},
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO account_blocks (account_id, target_id, kind, hide_notifications, expires_at, block_ap_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, target_id, kind) DO UPDATE SET hide_notifications = excluded.hide_notifications, expires_at = excluded.expires_at`,
    )
    .bind(accountId, targetId, kind, options.hideNotifications === false ? 0 : 1, options.expiresAt ?? null, options.blockApId ?? null, now())
    .run();
}

/** Removes a block or mute, returning the Block activity's ID if one was sent. */
export async function unblockAccount(db: D1Database, accountId: number, targetId: number, kind: BlockKind): Promise<{ blockApId: string | null } | null> {
  const row = await db
    .prepare("DELETE FROM account_blocks WHERE account_id = ? AND target_id = ? AND kind = ? RETURNING block_ap_id")
    .bind(accountId, targetId, kind)
    .first<{ block_ap_id: string | null }>();
  return row ? { blockApId: row.block_ap_id } : null;
}

export async function blockedAccountIds(db: D1Database, accountId: number, kind: BlockKind, limit = 80, offset = 0): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT target_id FROM account_blocks WHERE account_id = ? AND kind = ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(accountId, kind, now(), limit, offset)
    .all<{ target_id: number }>();
  return results.map((r) => r.target_id);
}

export async function setCommunityBlock(db: D1Database, accountId: number, communityId: number, blocked: boolean): Promise<void> {
  if (blocked) {
    await db.prepare("INSERT OR IGNORE INTO community_blocks (account_id, community_id, created_at) VALUES (?, ?, ?)").bind(accountId, communityId, now()).run();
  } else {
    await db.prepare("DELETE FROM community_blocks WHERE account_id = ? AND community_id = ?").bind(accountId, communityId).run();
  }
}

export async function setUserDomainBlock(db: D1Database, accountId: number, domain: string, blocked: boolean): Promise<void> {
  const host = domain.trim().toLowerCase();
  if (blocked) {
    await db.prepare("INSERT OR IGNORE INTO user_domain_blocks (account_id, domain, created_at) VALUES (?, ?, ?)").bind(accountId, host, now()).run();
  } else {
    await db.prepare("DELETE FROM user_domain_blocks WHERE account_id = ? AND domain = ?").bind(accountId, host).run();
  }
}

export async function userDomainBlocks(db: D1Database, accountId: number): Promise<string[]> {
  const { results } = await db.prepare("SELECT domain FROM user_domain_blocks WHERE account_id = ? ORDER BY domain").bind(accountId).all<{ domain: string }>();
  return results.map((r) => r.domain);
}

export async function blockedCommunityIds(db: D1Database, accountId: number): Promise<number[]> {
  const { results } = await db.prepare("SELECT community_id FROM community_blocks WHERE account_id = ?").bind(accountId).all<{ community_id: number }>();
  return results.map((r) => r.community_id);
}

/** Everything one person has hidden, loaded once per request. */
export interface Hidden {
  /** People blocked or muted. */
  accounts: Set<number>;
  /** People blocked (a subset of accounts): they can't interact either. */
  blocked: Set<number>;
  /** People whose notifications are hidden. */
  quietNotifications: Set<number>;
  communities: Set<number>;
  domains: Set<string>;
}

export const NOTHING_HIDDEN: Hidden = { accounts: new Set(), blocked: new Set(), quietNotifications: new Set(), communities: new Set(), domains: new Set() };

export async function hiddenFor(db: D1Database, accountId: number | null | undefined): Promise<Hidden> {
  if (!accountId) return NOTHING_HIDDEN;
  const [people, communities, domains] = await db.batch<Record<string, unknown>>([
    db
      .prepare("SELECT target_id, kind, hide_notifications FROM account_blocks WHERE account_id = ? AND (expires_at IS NULL OR expires_at > ?)")
      .bind(accountId, now()),
    db.prepare("SELECT community_id FROM community_blocks WHERE account_id = ?").bind(accountId),
    db.prepare("SELECT domain FROM user_domain_blocks WHERE account_id = ?").bind(accountId),
  ]);
  const hidden: Hidden = { accounts: new Set(), blocked: new Set(), quietNotifications: new Set(), communities: new Set(), domains: new Set() };
  for (const r of people!.results as { target_id: number; kind: BlockKind; hide_notifications: number }[]) {
    hidden.accounts.add(r.target_id);
    if (r.kind === "block") hidden.blocked.add(r.target_id);
    if (r.kind === "block" || r.hide_notifications) hidden.quietNotifications.add(r.target_id);
  }
  for (const r of communities!.results as { community_id: number }[]) hidden.communities.add(r.community_id);
  for (const r of domains!.results as { domain: string }[]) hidden.domains.add(r.domain);
  return hidden;
}

/** Whether something by this author (and in this community) is hidden from the viewer. */
export function isHidden(hidden: Hidden, author: { id: number; domain: string } | undefined, communityId?: number | null): boolean {
  if (hidden === NOTHING_HIDDEN) return false;
  if (author && (hidden.accounts.has(author.id) || hidden.domains.has(author.domain.toLowerCase()))) return true;
  return communityId != null && hidden.communities.has(communityId);
}

/** Block, mute and domain-block state toward some people, for relationships. */
export async function blockStates(
  db: D1Database,
  viewerId: number,
  ids: number[],
): Promise<Map<number, { blocking: boolean; muting: boolean; mutingNotifications: boolean; blockedBy: boolean }>> {
  const out = new Map<number, { blocking: boolean; muting: boolean; mutingNotifications: boolean; blockedBy: boolean }>();
  for (const id of ids) out.set(id, { blocking: false, muting: false, mutingNotifications: false, blockedBy: false });
  if (!ids.length) return out;
  const marks = ids.map(() => "?").join(", ");
  const [mine, theirs] = await Promise.all([
    db
      .prepare(`SELECT target_id, kind, hide_notifications FROM account_blocks WHERE account_id = ? AND target_id IN (${marks}) AND (expires_at IS NULL OR expires_at > ?)`)
      .bind(viewerId, ...ids, now())
      .all<{ target_id: number; kind: BlockKind; hide_notifications: number }>(),
    db
      .prepare(`SELECT account_id FROM account_blocks WHERE target_id = ? AND kind = 'block' AND account_id IN (${marks})`)
      .bind(viewerId, ...ids)
      .all<{ account_id: number }>(),
  ]);
  for (const r of mine.results) {
    const s = out.get(r.target_id)!;
    if (r.kind === "block") s.blocking = true;
    else {
      s.muting = true;
      s.mutingNotifications = r.hide_notifications === 1;
    }
  }
  for (const r of theirs.results) out.get(r.account_id)!.blockedBy = true;
  return out;
}

/** Whether `blocker` blocks `target`: a local person blocking someone stops their replies, mentions and follows. */
export async function blocks(db: D1Database, blockerId: number, targetId: number): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM account_blocks WHERE account_id = ? AND target_id = ? AND kind = 'block'").bind(blockerId, targetId).first();
  return row !== null;
}
