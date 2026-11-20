/**
 * Pixelfed's stories: a picture or clip someone's followers see for a day.
 * Local stories hold an upload (in `media`) and a token, which other servers
 * fetch the story with (Pixelfed's bearcap); other servers' stories hold their
 * media's URL. Views are kept per viewer, so the author sees who looked.
 */

const now = () => Math.floor(Date.now() / 1000);

/** How long a story lasts. */
export const STORY_SECONDS = 24 * 60 * 60;
/** Pixelfed's daily limit. */
export const MAX_STORIES = 20;

export interface Story {
  id: number;
  accountId: number;
  apId: string | null;
  mediaId: string | null;
  mediaUrl: string | null;
  contentType: string;
  type: "photo" | "video";
  /** Seconds. */
  duration: number;
  overlays: unknown[];
  canReply: boolean;
  canReact: boolean;
  token: string | null;
  active: boolean;
  viewCount: number;
  createdAt: number;
  expiresAt: number;
}

interface StoryRow {
  id: number;
  account_id: number;
  ap_id: string | null;
  media_id: string | null;
  media_url: string | null;
  content_type: string;
  duration: number;
  overlays: string | null;
  can_reply: number;
  can_react: number;
  token: string | null;
  active: number;
  view_count: number;
  created_at: number;
  expires_at: number;
}

const parseOverlays = (json: string | null): unknown[] => {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const toStory = (r: StoryRow): Story => ({
  id: r.id,
  accountId: r.account_id,
  apId: r.ap_id,
  mediaId: r.media_id,
  mediaUrl: r.media_url,
  contentType: r.content_type,
  type: r.content_type.startsWith("video/") ? "video" : "photo",
  duration: r.duration,
  overlays: parseOverlays(r.overlays),
  canReply: r.can_reply === 1,
  canReact: r.can_react === 1,
  token: r.token,
  active: r.active === 1,
  viewCount: r.view_count,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

export interface NewStory {
  accountId: number;
  apId?: string | null;
  mediaId?: string | null;
  mediaUrl?: string | null;
  contentType: string;
  duration: number;
  overlays?: unknown[];
  canReply?: boolean;
  canReact?: boolean;
  token?: string | null;
  /** False for Pixelfed's two-step add, then publish. */
  active?: boolean;
  createdAt?: number;
  expiresAt?: number;
}

export async function createStory(db: D1Database, s: NewStory): Promise<Story> {
  const created = s.createdAt ?? now();
  const row = await db
    .prepare(
      `INSERT INTO stories (account_id, ap_id, media_id, media_url, content_type, duration, overlays, can_reply, can_react, token, active, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(
      s.accountId,
      s.apId ?? null,
      s.mediaId ?? null,
      s.mediaUrl ?? null,
      s.contentType,
      s.duration,
      s.overlays?.length ? JSON.stringify(s.overlays) : null,
      s.canReply ? 1 : 0,
      s.canReact ? 1 : 0,
      s.token ?? null,
      s.active === false ? 0 : 1,
      created,
      s.expiresAt ?? created + STORY_SECONDS,
    )
    .first<StoryRow>();
  return toStory(row!);
}

export async function storyById(db: D1Database, id: number): Promise<Story | null> {
  const row = await db.prepare("SELECT * FROM stories WHERE id = ?").bind(id).first<StoryRow>();
  return row ? toStory(row) : null;
}

export async function storyByApId(db: D1Database, apId: string): Promise<Story | null> {
  const row = await db.prepare("SELECT * FROM stories WHERE ap_id = ?").bind(apId).first<StoryRow>();
  return row ? toStory(row) : null;
}

/** A story that can still be seen: published and not yet expired. */
export const isLive = (s: Story, at = now()) => s.active && s.expiresAt > at;

/** Publishes a story added with Pixelfed's two-step flow. */
export async function publishStory(
  db: D1Database,
  id: number,
  accountId: number,
  options: { duration: number; canReply: boolean; canReact: boolean },
): Promise<Story | null> {
  const row = await db
    .prepare("UPDATE stories SET active = 1, duration = ?, can_reply = ?, can_react = ? WHERE id = ? AND account_id = ? RETURNING *")
    .bind(options.duration, options.canReply ? 1 : 0, options.canReact ? 1 : 0, id, accountId)
    .first<StoryRow>();
  return row ? toStory(row) : null;
}

/** Stories someone has posted that are still live, for the daily limit. */
export async function liveStoryCount(db: D1Database, accountId: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM stories WHERE account_id = ? AND active = 1 AND expires_at > ?")
    .bind(accountId, now())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Someone's live stories, oldest first. */
export async function liveStoriesOf(db: D1Database, accountId: number): Promise<Story[]> {
  const { results } = await db
    .prepare("SELECT * FROM stories WHERE account_id = ? AND active = 1 AND expires_at > ? ORDER BY id")
    .bind(accountId, now())
    .all<StoryRow>();
  return results.map(toStory);
}

/**
 * The stories a person can see: their own and those of everyone they follow,
 * oldest first, each with whether they've seen it.
 */
export async function storiesFor(db: D1Database, viewerId: number): Promise<{ story: Story; seen: boolean }[]> {
  const { results } = await db
    .prepare(
      `SELECT s.*, EXISTS (SELECT 1 FROM story_views v WHERE v.story_id = s.id AND v.account_id = ?1) AS seen
       FROM stories s
       WHERE s.active = 1 AND s.expires_at > ?2
         AND (s.account_id = ?1 OR s.account_id IN (SELECT target_id FROM account_follows WHERE account_id = ?1 AND state = 'accepted'))
       ORDER BY s.id`,
    )
    .bind(viewerId, now())
    .all<StoryRow & { seen: number }>();
  return results.map((r) => ({ story: toStory(r), seen: r.seen === 1 || r.account_id === viewerId }));
}

/** Whether `viewerId` follows `authorId` (accepted), the test for seeing a story. */
export async function followsAccount(db: D1Database, viewerId: number, authorId: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS x FROM account_follows WHERE account_id = ? AND target_id = ? AND state = 'accepted'")
    .bind(viewerId, authorId)
    .first();
  return row !== null;
}

/** Records a view. Returns false if they'd seen it already. */
export async function recordStoryView(db: D1Database, storyId: number, accountId: number): Promise<boolean> {
  const result = await db
    .prepare("INSERT OR IGNORE INTO story_views (story_id, account_id, viewed_at) VALUES (?, ?, ?)")
    .bind(storyId, accountId, now())
    .run();
  const added = (result.meta.changes ?? 0) > 0;
  if (added) await db.prepare("UPDATE stories SET view_count = view_count + 1 WHERE id = ?").bind(storyId).run();
  return added;
}

/** Who has seen a story, latest first, paged by `viewed_at`. */
export async function storyViewers(
  db: D1Database,
  storyId: number,
  options: { limit: number; before?: number | undefined },
): Promise<{ accountId: number; viewedAt: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT account_id, viewed_at FROM story_views WHERE story_id = ? AND viewed_at < ?
       ORDER BY viewed_at DESC, account_id DESC LIMIT ?`,
    )
    .bind(storyId, options.before ?? Number.MAX_SAFE_INTEGER, options.limit)
    .all<{ account_id: number; viewed_at: number }>();
  return results.map((r) => ({ accountId: r.account_id, viewedAt: r.viewed_at }));
}

/** Takes a story down. Its row stays until the cleanup, so a Delete can still name it. */
export async function endStory(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE stories SET active = 0, token = NULL WHERE id = ?").bind(id).run();
}

/**
 * Stories past their day, or taken down, with the uploads they leave behind:
 * removed in batches by the cron. Returns the removed stories' uploads.
 */
export async function removeEndedStories(db: D1Database, batch = 100): Promise<{ removed: number; mediaIds: string[] }> {
  // A story added but not yet published (Pixelfed's two steps) keeps its
  // token; it's left an hour, in case the publish is on its way.
  const { results: doomed } = await db
    .prepare(
      `SELECT id, media_id FROM stories
       WHERE expires_at <= ?1 OR (active = 0 AND (token IS NULL OR created_at <= ?1 - 3600))
       LIMIT ?2`,
    )
    .bind(now(), batch)
    .all<{ id: number; media_id: string | null }>();
  if (!doomed.length) return { removed: 0, mediaIds: [] };
  const doomedMarks = doomed.map(() => "?").join(", ");
  const doomedIds = doomed.map((r) => r.id);
  await db.batch([
    db.prepare(`DELETE FROM story_views WHERE story_id IN (${doomedMarks})`).bind(...doomedIds),
    db.prepare(`DELETE FROM stories WHERE id IN (${doomedMarks})`).bind(...doomedIds),
  ]);
  return { removed: doomed.length, mediaIds: doomed.flatMap((r) => (r.media_id ? [r.media_id] : [])) };
}

/**
 * People who follow someone, by name, for tagging them on a story: local
 * followers, and remote ones palm has an account for.
 */
export async function followerIdsMatching(db: D1Database, accountId: number, prefix: string, limit = 10): Promise<number[]> {
  const like = `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const { results } = await db
    .prepare(
      `SELECT a.id FROM accounts a
       WHERE a.username LIKE ?2 ESCAPE '\\' AND a.banned_at IS NULL AND a.deleted_at IS NULL
         AND (a.id IN (SELECT account_id FROM account_follows WHERE target_id = ?1 AND state = 'accepted')
              OR a.ap_id IN (SELECT actor_id FROM followers WHERE account_id = ?1 AND pending = 0))
       ORDER BY a.username LIMIT ?3`,
    )
    .bind(accountId, like, limit)
    .all<{ id: number }>();
  return results.map((r) => r.id);
}

// --- what software other servers run ------------------------------------------

/** Kept a week: servers rarely change software. */
const SOFTWARE_SECONDS = 7 * 24 * 60 * 60;

export async function knownSoftware(db: D1Database, domain: string): Promise<{ software: string | null; version: string | null } | null> {
  const row = await db
    .prepare("SELECT software, version FROM server_software WHERE domain = ? AND checked_at > ?")
    .bind(domain.toLowerCase(), now() - SOFTWARE_SECONDS)
    .first<{ software: string | null; version: string | null }>();
  return row ?? null;
}

export async function rememberSoftware(db: D1Database, domain: string, software: string | null, version: string | null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO server_software (domain, software, version, checked_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (domain) DO UPDATE SET software = excluded.software, version = excluded.version, checked_at = excluded.checked_at`,
    )
    .bind(domain.toLowerCase(), software, version, now())
    .run();
}
