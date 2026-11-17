import type { QuotePolicy } from "./quotes.ts";

/**
 * A person. Local accounts sign in here; remote ones are other servers'
 * people that palm has met, kept so posts, votes and follows can point at
 * them. A remote account has an `apId`; a local one's comes from urls.user.
 */
export interface Account {
  id: number;
  domain: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  role: "user" | "admin";
  createdAt: number;
  /** Set for remote accounts: their ActivityPub ID. */
  apId: string | null;
  inbox: string | null;
  sharedInbox: string | null;
  /** A remote account's profile page. */
  profileUrl: string | null;
  avatarUrl: string | null;
  headerUrl: string | null;
  /** Person, Service (a bot) and so on; null for local accounts. */
  actorType: string | null;
  /** When a remote account was last fetched. */
  fetchedAt: number | null;
  /** Banned accounts can't sign in, and other servers' banned people are ignored. */
  banned: boolean;
  /** A remote account's outbox, and the counts its server gives. */
  outboxUrl: string | null;
  remoteCounts: { followers: number | null; following: number | null; statuses: number | null };
  /** When palm last read a remote account's outbox for its profile. */
  outboxFetchedAt: number | null;
  /** Followers need approving (Mastodon's locked account). */
  locked: boolean;
  /** Who may quote this account's posts unless a post says otherwise. */
  quotePolicy: QuotePolicy;
  /** The ActivityPub ID of the account this one moved to. */
  movedTo: string | null;
  /** Other accounts' IDs this one says are also it, which a move needs. */
  alsoKnownAs: string[];
  /** A deleted account keeps its row (its ID stays taken) and nothing else. */
  deleted: boolean;
}

interface AccountRow {
  id: number;
  domain: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  password_hash: string | null;
  role: "user" | "admin";
  created_at: number;
  ap_id: string | null;
  inbox: string | null;
  shared_inbox: string | null;
  profile_url: string | null;
  avatar_url: string | null;
  header_url: string | null;
  actor_type: string | null;
  fetched_at: number | null;
  banned_at?: number | null;
  outbox_url?: string | null;
  followers_count?: number | null;
  following_count?: number | null;
  statuses_count?: number | null;
  outbox_fetched_at?: number | null;
  locked?: number | null;
  quote_policy?: string | null;
  moved_to?: string | null;
  also_known_as?: string | null;
  deleted_at?: number | null;
}

const COLUMNS =
  "id, domain, username, display_name, bio, password_hash, role, created_at, ap_id, inbox, shared_inbox, profile_url, avatar_url, header_url, actor_type, fetched_at, banned_at, outbox_url, followers_count, following_count, statuses_count, outbox_fetched_at, locked, quote_policy, moved_to, also_known_as, deleted_at";

export function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    domain: row.domain,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    role: row.role,
    createdAt: row.created_at,
    apId: row.ap_id ?? null,
    inbox: row.inbox ?? null,
    sharedInbox: row.shared_inbox ?? null,
    profileUrl: row.profile_url ?? null,
    avatarUrl: row.avatar_url ?? null,
    headerUrl: row.header_url ?? null,
    actorType: row.actor_type ?? null,
    fetchedAt: row.fetched_at ?? null,
    banned: row.banned_at != null,
    outboxUrl: row.outbox_url ?? null,
    remoteCounts: { followers: row.followers_count ?? null, following: row.following_count ?? null, statuses: row.statuses_count ?? null },
    outboxFetchedAt: row.outbox_fetched_at ?? null,
    locked: row.locked === 1,
    quotePolicy: (row.quote_policy as QuotePolicy | null | undefined) ?? "public",
    movedTo: row.moved_to ?? null,
    alsoKnownAs: row.also_known_as ? (JSON.parse(row.also_known_as) as string[]) : [],
    deleted: row.deleted_at != null,
  };
}

export type { AccountRow };

/** Whether an account lives here (it has no ActivityPub ID of its own). */
export const isLocal = (account: Pick<Account, "apId">) => account.apId === null;

const now = () => Math.floor(Date.now() / 1000);

/** Accounts by ID, for building many views at once. */
export async function accountsByIds(db: D1Database, ids: number[]): Promise<Map<number, Account>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM accounts WHERE id IN (${unique.map(() => "?").join(", ")})`)
    .bind(...unique)
    .all<AccountRow>();
  return new Map(results.map((r) => [r.id, toAccount(r)]));
}

export async function accountByApId(db: D1Database, apId: string): Promise<Account | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM accounts WHERE ap_id = ?`).bind(apId).first<AccountRow>();
  return row ? toAccount(row) : null;
}

/** An account by handle: a local username, or a remote one palm already knows. */
export async function accountByHandle(db: D1Database, username: string, domain: string): Promise<Account | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM accounts WHERE domain = ? AND username = ?`)
    .bind(domain.toLowerCase(), username)
    .first<AccountRow>();
  return row ? toAccount(row) : null;
}

/** What palm keeps of a remote person. */
export interface RemoteAccount {
  apId: string;
  domain: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  inbox: string;
  sharedInbox: string | null;
  profileUrl: string | null;
  avatarUrl: string | null;
  headerUrl: string | null;
  actorType: string;
  outboxUrl: string | null;
  followersCount: number | null;
  followingCount: number | null;
  statusesCount: number | null;
  /** The account it moved to (Mastodon's movedTo). */
  movedTo?: string | null;
  alsoKnownAs?: string[];
}

/** Records a remote person, or refreshes what palm knows of them. */
export async function upsertRemoteAccount(db: D1Database, remote: RemoteAccount): Promise<Account> {
  const row = await db
    .prepare(
      `INSERT INTO accounts (domain, username, display_name, bio, role, created_at, ap_id, inbox, shared_inbox, profile_url, avatar_url, header_url, actor_type, fetched_at,
                             outbox_url, followers_count, following_count, statuses_count, moved_to, also_known_as)
       VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (ap_id) WHERE ap_id IS NOT NULL DO UPDATE SET
         display_name = excluded.display_name, bio = excluded.bio, inbox = excluded.inbox,
         shared_inbox = excluded.shared_inbox, profile_url = excluded.profile_url, avatar_url = excluded.avatar_url,
         header_url = excluded.header_url, actor_type = excluded.actor_type, fetched_at = excluded.fetched_at,
         outbox_url = excluded.outbox_url, moved_to = excluded.moved_to, also_known_as = excluded.also_known_as,
         followers_count = COALESCE(excluded.followers_count, followers_count),
         following_count = COALESCE(excluded.following_count, following_count),
         statuses_count = COALESCE(excluded.statuses_count, statuses_count)
       RETURNING ${COLUMNS}`,
    )
    .bind(
      remote.domain.toLowerCase(),
      remote.username,
      remote.displayName,
      remote.bio,
      now(),
      remote.apId,
      remote.inbox,
      remote.sharedInbox,
      remote.profileUrl,
      remote.avatarUrl,
      remote.headerUrl,
      remote.actorType,
      now(),
      remote.outboxUrl,
      remote.followersCount,
      remote.followingCount,
      remote.statusesCount,
      remote.movedTo ?? null,
      remote.alsoKnownAs?.length ? JSON.stringify(remote.alsoKnownAs) : null,
    )
    .first<AccountRow>();
  return toAccount(row!);
}

/** Changes a local account's profile. Undefined fields stay as they are. */
export async function updateProfile(
  db: D1Database,
  id: number,
  profile: {
    displayName?: string | null | undefined;
    bio?: string | null | undefined;
    avatarUrl?: string | null | undefined;
    headerUrl?: string | null | undefined;
    locked?: boolean | undefined;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  // Other servers' cached copies of the actor are keyed by this (see the worker's public-cache.ts).
  sets.push("profile_version = profile_version + 1");
  if (profile.locked !== undefined) {
    sets.push("locked = ?");
    params.push(profile.locked ? 1 : 0);
  }
  const set = (column: string, value: string | null | undefined) => {
    if (value === undefined) return;
    sets.push(`${column} = ?`);
    params.push(value);
  };
  set("display_name", profile.displayName);
  set("bio", profile.bio);
  set("avatar_url", profile.avatarUrl);
  set("header_url", profile.headerUrl);
  if (!sets.length) return;
  await db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ? AND ap_id IS NULL`).bind(...params, id).run();
}

export async function accountById(db: D1Database, id: number): Promise<Account | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`).bind(id).first<AccountRow>();
  return row ? toAccount(row) : null;
}

/** An account and its password hash, for login. Usernames match case-insensitively. */
export async function accountForLogin(
  db: D1Database,
  domain: string,
  username: string,
): Promise<{ account: Account; passwordHash: string | null } | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM accounts WHERE domain = ? AND username = ? AND ap_id IS NULL`)
    .bind(domain, username)
    .first<AccountRow>();
  return row ? { account: toAccount(row), passwordHash: row.password_hash } : null;
}

export async function setPasswordHash(db: D1Database, id: number, passwordHash: string): Promise<void> {
  await db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?").bind(passwordHash, id).run();
}

export async function countAccounts(db: D1Database, domain: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE domain = ? AND ap_id IS NULL").bind(domain).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function admins(db: D1Database, domain: string): Promise<Account[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM accounts WHERE domain = ? AND role = 'admin' ORDER BY id`)
    .bind(domain)
    .all<AccountRow>();
  return results.map(toAccount);
}

/** Records that palm read a remote account's outbox just now. */
export async function markOutboxFetched(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE accounts SET outbox_fetched_at = ? WHERE id = ?").bind(now(), id).run();
}

/**
 * A local account's profile version, which goes up whenever its actor
 * document changes; null for no such account. Cached copies of the actor
 * are keyed by it, so a change reaches every data centre at once.
 */
export async function profileVersion(db: D1Database, domain: string, username: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT profile_version FROM accounts WHERE domain = ? AND username = ? AND ap_id IS NULL")
    .bind(domain, username)
    .first<{ profile_version: number }>();
  return row?.profile_version ?? null;
}
