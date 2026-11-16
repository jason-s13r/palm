/**
 * Edit history, scheduled posts and polls.
 */

const now = () => Math.floor(Date.now() / 1000);

// --- edit history --------------------------------------------------------------

export interface PostVersion {
  contentHtml: string;
  contentSource: string;
  spoilerText: string;
  sensitive: boolean;
  createdAt: number;
}

/** Earlier versions of a post, oldest first. */
export async function postVersions(db: D1Database, postId: number): Promise<PostVersion[]> {
  const { results } = await db
    .prepare("SELECT content_html, content_source, spoiler_text, sensitive, created_at FROM post_edits WHERE post_id = ? ORDER BY id")
    .bind(postId)
    .all<{ content_html: string; content_source: string; spoiler_text: string; sensitive: number; created_at: number }>();
  return results.map((r) => ({ contentHtml: r.content_html, contentSource: r.content_source, spoilerText: r.spoiler_text, sensitive: r.sensitive === 1, createdAt: r.created_at }));
}

// --- scheduled posts -------------------------------------------------------------

export interface ScheduledStatus {
  id: number;
  accountId: number;
  appId: number;
  scheduledAt: number;
  params: Record<string, unknown>;
}

type ScheduledRow = { id: number; account_id: number; app_id: number; scheduled_at: number; params: string };
const toScheduled = (r: ScheduledRow): ScheduledStatus => ({ id: r.id, accountId: r.account_id, appId: r.app_id, scheduledAt: r.scheduled_at, params: JSON.parse(r.params) as Record<string, unknown> });

export async function scheduleStatus(db: D1Database, s: Omit<ScheduledStatus, "id">): Promise<ScheduledStatus> {
  const row = await db
    .prepare("INSERT INTO scheduled_statuses (account_id, app_id, scheduled_at, params, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *")
    .bind(s.accountId, s.appId, s.scheduledAt, JSON.stringify(s.params), now())
    .first<ScheduledRow>();
  return toScheduled(row!);
}

export async function scheduledStatuses(db: D1Database, accountId: number): Promise<ScheduledStatus[]> {
  const { results } = await db.prepare("SELECT * FROM scheduled_statuses WHERE account_id = ? ORDER BY scheduled_at").bind(accountId).all<ScheduledRow>();
  return results.map(toScheduled);
}

export async function rescheduleStatus(db: D1Database, accountId: number, id: number, at: number): Promise<void> {
  await db.prepare("UPDATE scheduled_statuses SET scheduled_at = ? WHERE id = ? AND account_id = ?").bind(at, id, accountId).run();
}

export async function cancelScheduled(db: D1Database, accountId: number, id: number): Promise<void> {
  await db.prepare("DELETE FROM scheduled_statuses WHERE id = ? AND account_id = ?").bind(id, accountId).run();
}

/** Takes the posts now due, so two runs can't publish one twice. */
export async function takeDueStatuses(db: D1Database, limit = 20): Promise<ScheduledStatus[]> {
  const { results } = await db
    .prepare("DELETE FROM scheduled_statuses WHERE id IN (SELECT id FROM scheduled_statuses WHERE scheduled_at <= ? ORDER BY scheduled_at LIMIT ?) RETURNING *")
    .bind(now(), limit)
    .all<ScheduledRow>();
  return results.map(toScheduled);
}

// --- polls ---------------------------------------------------------------------

export interface Poll {
  postId: number;
  options: { title: string; votes: number }[];
  multiple: boolean;
  expiresAt: number | null;
  votersCount: number | null;
}

type PollRow = { post_id: number; options: string; multiple: number; expires_at: number | null; voters_count: number | null };
const toPoll = (r: PollRow): Poll => ({
  postId: r.post_id,
  options: JSON.parse(r.options) as Poll["options"],
  multiple: r.multiple === 1,
  expiresAt: r.expires_at,
  votersCount: r.voters_count,
});

/** Creates or replaces a poll (a remote one's counts come from its server). */
export async function savePoll(db: D1Database, poll: Poll): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO polls (post_id, options, multiple, expires_at, voters_count) VALUES (?, ?, ?, ?, ?)")
    .bind(poll.postId, JSON.stringify(poll.options), poll.multiple ? 1 : 0, poll.expiresAt, poll.votersCount)
    .run();
}

export async function pollsFor(db: D1Database, postIds: number[]): Promise<Map<number, Poll>> {
  const unique = [...new Set(postIds)];
  if (!unique.length) return new Map();
  const { results } = await db.prepare(`SELECT * FROM polls WHERE post_id IN (${unique.map(() => "?").join(", ")})`).bind(...unique).all<PollRow>();
  return new Map(results.map((r) => [r.post_id, toPoll(r)]));
}

/** The choices someone made in polls. */
export async function pollChoices(db: D1Database, accountId: number | null | undefined, postIds: number[]): Promise<Map<number, number[]>> {
  const unique = [...new Set(postIds)];
  const out = new Map<number, number[]>();
  if (!accountId || !unique.length) return out;
  const { results } = await db
    .prepare(`SELECT post_id, choice FROM poll_votes WHERE account_id = ? AND post_id IN (${unique.map(() => "?").join(", ")})`)
    .bind(accountId, ...unique)
    .all<{ post_id: number; choice: number }>();
  for (const r of results) out.set(r.post_id, [...(out.get(r.post_id) ?? []), r.choice]);
  return out;
}

/**
 * Records someone's choices in a poll. For a local poll the counts are kept
 * here; a remote poll's are its server's, so only the voter's choices are.
 */
export async function votePoll(db: D1Database, postId: number, accountId: number, choices: number[], countHere: boolean): Promise<boolean> {
  const poll = (await pollsFor(db, [postId])).get(postId);
  if (!poll || (poll.expiresAt !== null && poll.expiresAt <= now())) return false;
  const voted = await db.prepare("SELECT 1 FROM poll_votes WHERE post_id = ? AND account_id = ?").bind(postId, accountId).first();
  if (voted) return false;
  const valid = [...new Set(choices)].filter((n) => Number.isInteger(n) && n >= 0 && n < poll.options.length);
  if (!valid.length || (!poll.multiple && valid.length > 1)) return false;
  await db.batch(valid.map((n) => db.prepare("INSERT OR IGNORE INTO poll_votes (post_id, account_id, choice, created_at) VALUES (?, ?, ?, ?)").bind(postId, accountId, n, now())));
  if (countHere) {
    for (const n of valid) poll.options[n]!.votes += 1;
    poll.votersCount = (poll.votersCount ?? 0) + 1;
    await savePoll(db, poll);
  }
  return true;
}

export async function setQuote(db: D1Database, postId: number, quoteOf: string | null): Promise<void> {
  await db.prepare("UPDATE posts SET quote_of = ? WHERE id = ?").bind(quoteOf, postId).run();
}

/** A vote from another server in a poll here: one choice per Note it sends. */
export async function addRemotePollVote(db: D1Database, postId: number, accountId: number, choice: number): Promise<boolean> {
  const poll = (await pollsFor(db, [postId])).get(postId);
  if (!poll || choice < 0 || choice >= poll.options.length || (poll.expiresAt !== null && poll.expiresAt <= now())) return false;
  const earlier = await db.prepare("SELECT COUNT(*) AS n FROM poll_votes WHERE post_id = ? AND account_id = ?").bind(postId, accountId).first<{ n: number }>();
  if ((earlier?.n ?? 0) > 0 && !poll.multiple) return false;
  const inserted = await db
    .prepare("INSERT OR IGNORE INTO poll_votes (post_id, account_id, choice, created_at) VALUES (?, ?, ?, ?)")
    .bind(postId, accountId, choice, now())
    .run();
  if (!inserted.meta.changes) return false;
  poll.options[choice]!.votes += 1;
  if (!earlier?.n) poll.votersCount = (poll.votersCount ?? 0) + 1;
  await savePoll(db, poll);
  return true;
}
