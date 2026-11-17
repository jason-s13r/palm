import { toPost, type Post, type PostRow } from "./posts.ts";

/**
 * Ways people shape what they see: Mastodon lists, followed hashtags and
 * keyword filters, and Lemmy's read and hidden posts.
 */

const now = () => Math.floor(Date.now() / 1000);

// --- lists -------------------------------------------------------------------

export interface List {
  id: number;
  accountId: number;
  title: string;
  repliesPolicy: string;
  exclusive: boolean;
}

type ListRow = { id: number; account_id: number; title: string; replies_policy: string; exclusive: number };
const toList = (r: ListRow): List => ({ id: r.id, accountId: r.account_id, title: r.title, repliesPolicy: r.replies_policy, exclusive: r.exclusive === 1 });

export async function listsOf(db: D1Database, accountId: number): Promise<List[]> {
  const { results } = await db.prepare("SELECT * FROM lists WHERE account_id = ? ORDER BY title").bind(accountId).all<ListRow>();
  return results.map(toList);
}

export async function listById(db: D1Database, accountId: number, id: number): Promise<List | null> {
  const row = await db.prepare("SELECT * FROM lists WHERE account_id = ? AND id = ?").bind(accountId, id).first<ListRow>();
  return row ? toList(row) : null;
}

export async function createList(db: D1Database, accountId: number, list: { title: string; repliesPolicy?: string; exclusive?: boolean }): Promise<List> {
  const row = await db
    .prepare("INSERT INTO lists (account_id, title, replies_policy, exclusive, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *")
    .bind(accountId, list.title, list.repliesPolicy ?? "list", list.exclusive ? 1 : 0, now())
    .first<ListRow>();
  return toList(row!);
}

export async function updateList(db: D1Database, id: number, list: { title?: string | undefined; repliesPolicy?: string | undefined; exclusive?: boolean | undefined }): Promise<void> {
  await db
    .prepare("UPDATE lists SET title = COALESCE(?, title), replies_policy = COALESCE(?, replies_policy), exclusive = COALESCE(?, exclusive) WHERE id = ?")
    .bind(list.title ?? null, list.repliesPolicy ?? null, list.exclusive === undefined ? null : list.exclusive ? 1 : 0, id)
    .run();
}

export async function deleteList(db: D1Database, id: number): Promise<void> {
  await db.batch([db.prepare("DELETE FROM list_members WHERE list_id = ?").bind(id), db.prepare("DELETE FROM lists WHERE id = ?").bind(id)]);
}

export async function listMemberIds(db: D1Database, listId: number): Promise<number[]> {
  const { results } = await db.prepare("SELECT account_id FROM list_members WHERE list_id = ?").bind(listId).all<{ account_id: number }>();
  return results.map((r) => r.account_id);
}

export async function setListMembers(db: D1Database, listId: number, accountIds: number[], add: boolean): Promise<void> {
  if (!accountIds.length) return;
  await db.batch(
    accountIds.map((id) =>
      add
        ? db.prepare("INSERT OR IGNORE INTO list_members (list_id, account_id) VALUES (?, ?)").bind(listId, id)
        : db.prepare("DELETE FROM list_members WHERE list_id = ? AND account_id = ?").bind(listId, id),
    ),
  );
}

/** Lists of the viewer's that someone is on. */
export async function listsContaining(db: D1Database, ownerId: number, accountId: number): Promise<List[]> {
  const { results } = await db
    .prepare("SELECT l.* FROM lists l JOIN list_members m ON m.list_id = l.id WHERE l.account_id = ? AND m.account_id = ?")
    .bind(ownerId, accountId)
    .all<ListRow>();
  return results.map(toList);
}

/** A list's timeline: its members' posts the owner may see, newest first. */
export async function listTimeline(db: D1Database, ownerId: number, listId: number, page: { maxId?: number | undefined; minId?: number | undefined; limit: number }): Promise<Post[]> {
  const { results } = await db
    .prepare(
      `SELECT p.* FROM posts p
       WHERE p.account_id IN (SELECT account_id FROM list_members WHERE list_id = ?2)
         AND p.deleted_at IS NULL AND p.root_id IS NULL
         AND (p.visibility IN ('public', 'unlisted')
              OR (p.visibility = 'private' AND p.account_id IN (SELECT target_id FROM account_follows WHERE account_id = ?1 AND state = 'accepted')))
         AND (?3 IS NULL OR p.id < ?3) AND (?4 IS NULL OR p.id > ?4)
       ORDER BY p.id DESC LIMIT ?5`,
    )
    .bind(ownerId, listId, page.maxId ?? null, page.minId ?? null, page.limit)
    .all<PostRow>();
  return results.map(toPost);
}

// --- followed hashtags -------------------------------------------------------

export async function followedTags(db: D1Database, accountId: number): Promise<string[]> {
  const { results } = await db.prepare("SELECT tag FROM followed_tags WHERE account_id = ? ORDER BY created_at DESC").bind(accountId).all<{ tag: string }>();
  return results.map((r) => r.tag);
}

export async function setTagFollow(db: D1Database, accountId: number, tag: string, follow: boolean): Promise<void> {
  const name = tag.replace(/^#/, "").toLowerCase();
  if (follow) await db.prepare("INSERT OR IGNORE INTO followed_tags (account_id, tag, created_at) VALUES (?, ?, ?)").bind(accountId, name, now()).run();
  else await db.prepare("DELETE FROM followed_tags WHERE account_id = ? AND tag = ?").bind(accountId, name).run();
}

// --- keyword filters -----------------------------------------------------------

export interface Filter {
  id: number;
  title: string;
  context: string[];
  action: "warn" | "hide";
  expiresAt: number | null;
  keywords: { id: number; keyword: string; wholeWord: boolean }[];
}

export async function filtersOf(db: D1Database, accountId: number, includeExpired = false): Promise<Filter[]> {
  const [filters, keywords] = await db.batch<Record<string, unknown>>([
    db
      .prepare(`SELECT * FROM filters WHERE account_id = ?${includeExpired ? "" : " AND (expires_at IS NULL OR expires_at > ?)"} ORDER BY id`)
      .bind(...(includeExpired ? [accountId] : [accountId, now()])),
    db.prepare("SELECT k.* FROM filter_keywords k JOIN filters f ON f.id = k.filter_id WHERE f.account_id = ?").bind(accountId),
  ]);
  const byFilter = new Map<number, Filter["keywords"]>();
  for (const k of keywords!.results as { id: number; filter_id: number; keyword: string; whole_word: number }[]) {
    byFilter.set(k.filter_id, [...(byFilter.get(k.filter_id) ?? []), { id: k.id, keyword: k.keyword, wholeWord: k.whole_word === 1 }]);
  }
  return (filters!.results as { id: number; title: string; context: string; action: string; expires_at: number | null }[]).map((f) => ({
    id: f.id,
    title: f.title,
    context: JSON.parse(f.context) as string[],
    action: f.action === "hide" ? "hide" : "warn",
    expiresAt: f.expires_at,
    keywords: byFilter.get(f.id) ?? [],
  }));
}

export async function saveFilter(
  db: D1Database,
  accountId: number,
  filter: { id?: number; title: string; context: string[]; action: "warn" | "hide"; expiresAt: number | null },
  keywords: { add: { keyword: string; wholeWord: boolean }[]; removeIds: number[] },
): Promise<number> {
  let id = filter.id;
  if (id === undefined) {
    const row = await db
      .prepare("INSERT INTO filters (account_id, title, context, action, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(accountId, filter.title, JSON.stringify(filter.context), filter.action, filter.expiresAt, now())
      .first<{ id: number }>();
    id = row!.id;
  } else {
    await db
      .prepare("UPDATE filters SET title = ?, context = ?, action = ?, expires_at = ? WHERE id = ? AND account_id = ?")
      .bind(filter.title, JSON.stringify(filter.context), filter.action, filter.expiresAt, id, accountId)
      .run();
  }
  const statements = [
    ...keywords.add.map((k) => db.prepare("INSERT INTO filter_keywords (filter_id, keyword, whole_word) VALUES (?, ?, ?)").bind(id, k.keyword, k.wholeWord ? 1 : 0)),
    ...keywords.removeIds.map((k) => db.prepare("DELETE FROM filter_keywords WHERE id = ? AND filter_id = ?").bind(k, id)),
  ];
  if (statements.length) await db.batch(statements);
  return id;
}

export async function deleteFilter(db: D1Database, accountId: number, id: number): Promise<void> {
  const owned = await db.prepare("SELECT 1 FROM filters WHERE id = ? AND account_id = ?").bind(id, accountId).first();
  if (!owned) return;
  await db.batch([db.prepare("DELETE FROM filter_keywords WHERE filter_id = ?").bind(id), db.prepare("DELETE FROM filters WHERE id = ?").bind(id)]);
}

/** The filters whose keywords a text matches. */
export function matchFilters(filters: Filter[], text: string): { filter: Filter; matches: string[] }[] {
  const lower = text.toLowerCase();
  const out: { filter: Filter; matches: string[] }[] = [];
  for (const filter of filters) {
    const matches = filter.keywords
      .filter((k) => {
        const word = k.keyword.toLowerCase();
        if (!k.wholeWord) return lower.includes(word);
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, "u").test(lower);
      })
      .map((k) => k.keyword);
    if (matches.length) out.push({ filter, matches });
  }
  return out;
}

// --- Lemmy's read and hidden posts -----------------------------------------------

export async function setPostMarks(db: D1Database, accountId: number, postIds: number[], mark: "read" | "hidden", on: boolean): Promise<void> {
  const table = mark === "read" ? "post_reads" : "post_hides";
  if (!postIds.length) return;
  await db.batch(
    postIds.map((id) =>
      on
        ? db.prepare(`INSERT OR IGNORE INTO ${table} (account_id, post_id) VALUES (?, ?)`).bind(accountId, id)
        : db.prepare(`DELETE FROM ${table} WHERE account_id = ? AND post_id = ?`).bind(accountId, id),
    ),
  );
}

export async function postMarks(db: D1Database, accountId: number | null | undefined, postIds: number[]): Promise<{ read: Set<number>; hidden: Set<number> }> {
  const unique = [...new Set(postIds)];
  if (!accountId || !unique.length) return { read: new Set(), hidden: new Set() };
  const marks = unique.map(() => "?").join(", ");
  const [read, hidden] = await db.batch<{ post_id: number }>([
    db.prepare(`SELECT post_id FROM post_reads WHERE account_id = ? AND post_id IN (${marks})`).bind(accountId, ...unique),
    db.prepare(`SELECT post_id FROM post_hides WHERE account_id = ? AND post_id IN (${marks})`).bind(accountId, ...unique),
  ]);
  return { read: new Set(read!.results.map((r) => r.post_id)), hidden: new Set(hidden!.results.map((r) => r.post_id)) };
}

/**
 * Palm's own Lemmy feeds (!following, !local) an account has subscribed to,
 * which puts their statuses in its Home feed. None by default.
 */
export type HomeFeed = "following" | "local";

export async function homeFeeds(db: D1Database, accountId: number): Promise<Set<HomeFeed>> {
  const { results } = await db.prepare("SELECT feed FROM home_feeds WHERE account_id = ?").bind(accountId).all<{ feed: HomeFeed }>();
  return new Set(results.map((r) => r.feed));
}

export async function setHomeFeed(db: D1Database, accountId: number, feed: HomeFeed, on: boolean): Promise<void> {
  await (on
    ? db.prepare("INSERT OR IGNORE INTO home_feeds (account_id, feed, created_at) VALUES (?, ?, ?)").bind(accountId, feed, Math.floor(Date.now() / 1000))
    : db.prepare("DELETE FROM home_feeds WHERE account_id = ? AND feed = ?").bind(accountId, feed)
  ).run();
}

export async function countHomeFeed(db: D1Database, feed: HomeFeed): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM home_feeds WHERE feed = ?").bind(feed).first<{ n: number }>())?.n ?? 0;
}
