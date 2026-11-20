/**
 * palm's schema, as an ordered list of migrations the Worker applies itself
 * (see migrate.ts). A deployment needs no migration step in its deploy command.
 *
 * Rules, so a rollback to the previous release still works:
 *   * append only: never edit or reorder a migration that has shipped;
 *   * expand then contract: add tables and columns first, drop them a release
 *     after nothing reads them;
 *   * statements are separated by a line that is just ";".
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "accounts, sessions and oauth",
    sql: `
CREATE TABLE IF NOT EXISTS palm_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
;
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  username TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT,
  bio TEXT,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at INTEGER NOT NULL,
  UNIQUE (domain, username)
)
;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  client TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
)
;
CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id)
;
CREATE TABLE IF NOT EXISTS oauth_apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  client_secret TEXT NOT NULL,
  name TEXT NOT NULL,
  website TEXT,
  redirect_uris TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
;
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  app_id INTEGER NOT NULL REFERENCES oauth_apps (id),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  code_challenge TEXT,
  expires_at INTEGER NOT NULL
)
;
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  app_id INTEGER NOT NULL REFERENCES oauth_apps (id),
  account_id INTEGER REFERENCES accounts (id),
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
)
;
CREATE INDEX IF NOT EXISTS oauth_tokens_account ON oauth_tokens (account_id)
`,
  },
  {
    version: 2,
    name: "actor keys, followers and fedify's key-value store",
    sql: `
CREATE TABLE IF NOT EXISTS actor_keys (
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  algorithm TEXT NOT NULL CHECK (algorithm IN ('RSASSA-PKCS1-v1_5', 'Ed25519')),
  public_jwk TEXT NOT NULL,
  private_jwk TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, algorithm)
)
;
CREATE TABLE IF NOT EXISTS followers (
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  actor_id TEXT NOT NULL,
  inbox TEXT NOT NULL,
  shared_inbox TEXT,
  follow_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, actor_id)
)
;
CREATE TABLE IF NOT EXISTS fedify_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
)
;
CREATE INDEX IF NOT EXISTS fedify_kv_expires ON fedify_kv (expires_at) WHERE expires_at IS NOT NULL
`,
  },
  {
    version: 3,
    name: "local posts",
    sql: `
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  content_source TEXT NOT NULL,
  content_html TEXT NOT NULL,
  spoiler_text TEXT NOT NULL DEFAULT '',
  sensitive INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted', 'private', 'direct')),
  language TEXT,
  in_reply_to TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
)
;
CREATE INDEX IF NOT EXISTS posts_account ON posts (account_id, id)
;
CREATE INDEX IF NOT EXISTS posts_public ON posts (visibility, id) WHERE deleted_at IS NULL
;
CREATE INDEX IF NOT EXISTS posts_in_reply_to ON posts (in_reply_to) WHERE in_reply_to IS NOT NULL
`,
  },
  {
    version: 4,
    name: "communities, threads and votes",
    sql: `
CREATE TABLE IF NOT EXISTS communities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  title TEXT NOT NULL,
  description TEXT,
  nsfw INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (domain, name)
)
;
CREATE TABLE IF NOT EXISTS community_keys (
  community_id INTEGER NOT NULL REFERENCES communities (id),
  algorithm TEXT NOT NULL CHECK (algorithm IN ('RSASSA-PKCS1-v1_5', 'Ed25519')),
  public_jwk TEXT NOT NULL,
  private_jwk TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, algorithm)
)
;
CREATE TABLE IF NOT EXISTS community_subscriptions (
  community_id INTEGER NOT NULL REFERENCES communities (id),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, account_id)
)
;
CREATE INDEX IF NOT EXISTS community_subscriptions_account ON community_subscriptions (account_id)
;
ALTER TABLE posts ADD COLUMN community_id INTEGER REFERENCES communities (id)
;
ALTER TABLE posts ADD COLUMN title TEXT
;
ALTER TABLE posts ADD COLUMN link_url TEXT
;
ALTER TABLE posts ADD COLUMN root_id INTEGER REFERENCES posts (id)
;
ALTER TABLE posts ADD COLUMN parent_id INTEGER REFERENCES posts (id)
;
ALTER TABLE posts ADD COLUMN path TEXT
;
ALTER TABLE posts ADD COLUMN updated_at INTEGER
;
CREATE INDEX IF NOT EXISTS posts_community ON posts (community_id, id) WHERE root_id IS NULL
;
CREATE INDEX IF NOT EXISTS posts_root ON posts (root_id, path) WHERE root_id IS NOT NULL
;
CREATE TABLE IF NOT EXISTS votes (
  post_id INTEGER NOT NULL REFERENCES posts (id),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  score INTEGER NOT NULL CHECK (score IN (-1, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, account_id)
)
`,
  },
  {
    version: 5,
    name: "media",
    sql: `
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  description TEXT,
  delete_token TEXT NOT NULL,
  post_id INTEGER REFERENCES posts (id),
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)
;
CREATE INDEX IF NOT EXISTS media_post ON media (post_id, position) WHERE post_id IS NOT NULL
`,
  },
  {
    version: 6,
    name: "remote actors, follows and notifications",
    sql: `
ALTER TABLE accounts ADD COLUMN ap_id TEXT
;
ALTER TABLE accounts ADD COLUMN inbox TEXT
;
ALTER TABLE accounts ADD COLUMN shared_inbox TEXT
;
ALTER TABLE accounts ADD COLUMN profile_url TEXT
;
ALTER TABLE accounts ADD COLUMN avatar_url TEXT
;
ALTER TABLE accounts ADD COLUMN header_url TEXT
;
ALTER TABLE accounts ADD COLUMN actor_type TEXT
;
ALTER TABLE accounts ADD COLUMN fetched_at INTEGER
;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_ap_id ON accounts (ap_id) WHERE ap_id IS NOT NULL
;
ALTER TABLE communities ADD COLUMN ap_id TEXT
;
ALTER TABLE communities ADD COLUMN inbox TEXT
;
ALTER TABLE communities ADD COLUMN shared_inbox TEXT
;
ALTER TABLE communities ADD COLUMN profile_url TEXT
;
ALTER TABLE communities ADD COLUMN icon_url TEXT
;
ALTER TABLE communities ADD COLUMN banner_url TEXT
;
ALTER TABLE communities ADD COLUMN outbox_url TEXT
;
ALTER TABLE communities ADD COLUMN fetched_at INTEGER
;
CREATE UNIQUE INDEX IF NOT EXISTS communities_ap_id ON communities (ap_id) WHERE ap_id IS NOT NULL
;
ALTER TABLE posts ADD COLUMN ap_id TEXT
;
ALTER TABLE posts ADD COLUMN url TEXT
;
ALTER TABLE posts ADD COLUMN attachments TEXT
;
CREATE UNIQUE INDEX IF NOT EXISTS posts_ap_id ON posts (ap_id) WHERE ap_id IS NOT NULL
;
CREATE INDEX IF NOT EXISTS posts_in_reply_to_all ON posts (in_reply_to) WHERE in_reply_to IS NOT NULL
;
ALTER TABLE community_subscriptions ADD COLUMN state TEXT NOT NULL DEFAULT 'accepted'
;
ALTER TABLE community_subscriptions ADD COLUMN follow_ap_id TEXT
;
CREATE TABLE IF NOT EXISTS account_follows (
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  target_id INTEGER NOT NULL REFERENCES accounts (id),
  state TEXT NOT NULL DEFAULT 'accepted' CHECK (state IN ('pending', 'accepted')),
  follow_ap_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, target_id)
)
;
CREATE INDEX IF NOT EXISTS account_follows_target ON account_follows (target_id)
;
CREATE TABLE IF NOT EXISTS community_followers (
  community_id INTEGER NOT NULL REFERENCES communities (id),
  actor_id TEXT NOT NULL,
  inbox TEXT NOT NULL,
  shared_inbox TEXT,
  follow_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, actor_id)
)
;
CREATE TABLE IF NOT EXISTS boosts (
  post_id INTEGER NOT NULL REFERENCES posts (id),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  ap_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, account_id)
)
;
CREATE INDEX IF NOT EXISTS boosts_account ON boosts (account_id, created_at)
;
CREATE TABLE IF NOT EXISTS bookmarks (
  post_id INTEGER NOT NULL REFERENCES posts (id),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, account_id)
)
;
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  kind TEXT NOT NULL CHECK (kind IN ('mention', 'reply', 'follow', 'follow_request', 'favourite', 'reblog')),
  from_account_id INTEGER NOT NULL REFERENCES accounts (id),
  post_id INTEGER REFERENCES posts (id),
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)
;
CREATE INDEX IF NOT EXISTS notifications_account ON notifications (account_id, id)
;
CREATE TABLE IF NOT EXISTS mentions (
  post_id INTEGER NOT NULL REFERENCES posts (id),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  PRIMARY KEY (post_id, account_id)
)
`,
  },
  {
    version: 7,
    name: "moderation and invites",
    sql: `
ALTER TABLE accounts ADD COLUMN banned_at INTEGER
;
CREATE TABLE IF NOT EXISTS blocked_domains (
  domain TEXT PRIMARY KEY,
  reason TEXT,
  created_at INTEGER NOT NULL
)
;
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  key_pairs TEXT NOT NULL,
  used_by INTEGER REFERENCES accounts (id),
  used_at INTEGER,
  created_at INTEGER NOT NULL
)
`,
  },
  {
    version: 8,
    name: "remote profile counts and outboxes",
    sql: `
ALTER TABLE accounts ADD COLUMN outbox_url TEXT
;
ALTER TABLE accounts ADD COLUMN followers_count INTEGER
;
ALTER TABLE accounts ADD COLUMN following_count INTEGER
;
ALTER TABLE accounts ADD COLUMN statuses_count INTEGER
;
ALTER TABLE accounts ADD COLUMN outbox_fetched_at INTEGER
`,
  },
  {
    version: 9,
    name: "boosts in timelines",
    sql: `
ALTER TABLE posts ADD COLUMN reblog_of INTEGER REFERENCES posts (id)
;
CREATE INDEX IF NOT EXISTS posts_reblog_of ON posts (reblog_of) WHERE reblog_of IS NOT NULL
`,
  },
  {
    version: 10,
    name: "hashtags",
    sql: `
CREATE TABLE IF NOT EXISTS post_tags (
  post_id INTEGER NOT NULL REFERENCES posts (id),
  tag TEXT NOT NULL,
  PRIMARY KEY (post_id, tag)
)
;
CREATE INDEX IF NOT EXISTS post_tags_tag ON post_tags (tag, post_id)
`,
  },
  {
    version: 11,
    name: "thread backfill marker",
    sql: `
ALTER TABLE posts ADD COLUMN thread_fetched_at INTEGER
`,
  },
  {
    version: 12,
    name: "remote signing keys",
    sql: `
CREATE TABLE IF NOT EXISTS remote_keys (
  key_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  pem TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
)
`,
  },
  {
    version: 13,
    name: "replies by parent",
    sql: `
CREATE INDEX IF NOT EXISTS posts_parent ON posts (parent_id) WHERE parent_id IS NOT NULL
`,
  },
  {
    version: 14,
    name: "blocks and mutes",
    sql: `
CREATE TABLE IF NOT EXISTS account_blocks (
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  target_id INTEGER NOT NULL REFERENCES accounts (id),
  kind TEXT NOT NULL CHECK (kind IN ('block', 'mute')),
  hide_notifications INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  block_ap_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, target_id, kind)
)
;
CREATE TABLE IF NOT EXISTS community_blocks (
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  community_id INTEGER NOT NULL REFERENCES communities (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, community_id)
)
;
CREATE TABLE IF NOT EXISTS user_domain_blocks (
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  domain TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, domain)
)
`,
  },
  {
    version: 15,
    name: "link previews",
    sql: `
CREATE TABLE IF NOT EXISTS link_cards (
  url TEXT PRIMARY KEY,
  title TEXT,
  description TEXT,
  image TEXT,
  provider TEXT,
  fetched_at INTEGER NOT NULL
)
`,
  },
  {
    version: 16,
    name: "locked accounts, pins and featured tags",
    sql: `
ALTER TABLE accounts ADD COLUMN locked INTEGER NOT NULL DEFAULT 0
;
ALTER TABLE followers ADD COLUMN pending INTEGER NOT NULL DEFAULT 0
;
CREATE TABLE IF NOT EXISTS pinned_posts (
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  post_id INTEGER NOT NULL REFERENCES posts (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, post_id)
)
;
CREATE TABLE IF NOT EXISTS featured_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, tag)
)
`,
  },
  {
    version: 17,
    name: "reports and community moderation",
    sql: `
ALTER TABLE posts ADD COLUMN locked INTEGER NOT NULL DEFAULT 0
;
ALTER TABLE posts ADD COLUMN featured_community INTEGER NOT NULL DEFAULT 0
;
ALTER TABLE posts ADD COLUMN featured_local INTEGER NOT NULL DEFAULT 0
;
CREATE TABLE IF NOT EXISTS community_mods (
  community_id INTEGER NOT NULL REFERENCES communities (id),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, account_id)
)
;
CREATE TABLE IF NOT EXISTS community_bans (
  community_id INTEGER NOT NULL REFERENCES communities (id),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  reason TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, account_id)
)
;
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL REFERENCES accounts (id),
  post_id INTEGER REFERENCES posts (id),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  reason TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolver_id INTEGER REFERENCES accounts (id),
  ap_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
)
;
CREATE INDEX IF NOT EXISTS reports_open ON reports (resolved, id)
;
CREATE TABLE IF NOT EXISTS mod_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  mod_id INTEGER NOT NULL REFERENCES accounts (id),
  post_id INTEGER,
  account_id INTEGER,
  community_id INTEGER,
  reason TEXT,
  value INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
)
;
CREATE TABLE IF NOT EXISTS spare_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_pairs TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
`,
  },
  {
    version: 18,
    name: "lists, followed tags, filters, read and hidden posts",
    sql: `
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  title TEXT NOT NULL,
  replies_policy TEXT NOT NULL DEFAULT 'list',
  exclusive INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)
;
CREATE TABLE IF NOT EXISTS list_members (
  list_id INTEGER NOT NULL REFERENCES lists (id),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  PRIMARY KEY (list_id, account_id)
)
;
CREATE TABLE IF NOT EXISTS followed_tags (
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, tag)
)
;
CREATE TABLE IF NOT EXISTS filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  title TEXT NOT NULL,
  context TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'warn',
  expires_at INTEGER,
  created_at INTEGER NOT NULL
)
;
CREATE TABLE IF NOT EXISTS filter_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filter_id INTEGER NOT NULL REFERENCES filters (id),
  keyword TEXT NOT NULL,
  whole_word INTEGER NOT NULL DEFAULT 1
)
;
CREATE TABLE IF NOT EXISTS post_reads (
  account_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  PRIMARY KEY (account_id, post_id)
)
;
CREATE TABLE IF NOT EXISTS post_hides (
  account_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  PRIMARY KEY (account_id, post_id)
)
`,
  },
  {
    version: 19,
    name: "edit history, scheduled posts, polls and quotes",
    sql: `
CREATE TABLE IF NOT EXISTS post_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts (id),
  content_html TEXT NOT NULL,
  content_source TEXT NOT NULL,
  spoiler_text TEXT NOT NULL DEFAULT '',
  sensitive INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)
;
CREATE INDEX IF NOT EXISTS post_edits_post ON post_edits (post_id, id)
;
CREATE TABLE IF NOT EXISTS scheduled_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  app_id INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL,
  params TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
;
CREATE INDEX IF NOT EXISTS scheduled_statuses_due ON scheduled_statuses (scheduled_at)
;
CREATE TABLE IF NOT EXISTS polls (
  post_id INTEGER PRIMARY KEY REFERENCES posts (id),
  options TEXT NOT NULL,
  multiple INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  voters_count INTEGER
)
;
CREATE TABLE IF NOT EXISTS poll_votes (
  post_id INTEGER NOT NULL REFERENCES posts (id),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  choice INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, account_id, choice)
)
;
ALTER TABLE posts ADD COLUMN quote_of TEXT
`,
  },
  {
    version: 20,
    name: "push subscriptions",
    sql: `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  alerts TEXT NOT NULL,
  policy TEXT NOT NULL DEFAULT 'all',
  standard INTEGER NOT NULL DEFAULT 0,
  access_token TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
;
CREATE INDEX IF NOT EXISTS push_subscriptions_account ON push_subscriptions (account_id)
`,
  },
  {
    version: 21,
    name: "account moves and deletion",
    sql: `
ALTER TABLE accounts ADD COLUMN moved_to TEXT
;
ALTER TABLE accounts ADD COLUMN also_known_as TEXT
;
ALTER TABLE accounts ADD COLUMN move_sent_at INTEGER
;
ALTER TABLE accounts ADD COLUMN deleted_at INTEGER
`,
  },
  {
    version: 22,
    name: "virtual feeds in home",
    sql: `
CREATE TABLE IF NOT EXISTS home_feeds (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  feed TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, feed)
)
`,
  },
  {
    version: 23,
    name: "quote permissions",
    sql: `
ALTER TABLE posts ADD COLUMN quote_policy TEXT
;
ALTER TABLE posts ADD COLUMN quote_state TEXT
;
ALTER TABLE posts ADD COLUMN quote_authorization TEXT
;
ALTER TABLE accounts ADD COLUMN quote_policy TEXT
;
CREATE TABLE IF NOT EXISTS quote_authorizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  quoting_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE (post_id, quoting_id)
)
`,
  },
  {
    version: 24,
    name: "follows per app",
    sql: `
ALTER TABLE account_follows ADD COLUMN mastodon INTEGER NOT NULL DEFAULT 1
;
ALTER TABLE account_follows ADD COLUMN lemmy INTEGER NOT NULL DEFAULT 0
`,
  },
  {
    version: 25,
    name: "profile versions",
    sql: `
ALTER TABLE accounts ADD COLUMN profile_version INTEGER NOT NULL DEFAULT 0
`,
  },
  {
    version: 26,
    name: "idempotency keys",
    sql: `
CREATE TABLE IF NOT EXISTS idempotency_keys (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  post_id INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, key)
)
`,
  },
  {
    version: 27,
    name: "follow imports",
    // Follows brought from another server, sent a few at a time by the cron.
    // target is a handle (name@host) or an ActivityPub ID; via is the app the
    // follow shows in, as in account_follows.
    sql: `
CREATE TABLE IF NOT EXISTS follow_imports (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  via TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  queued_at INTEGER,
  UNIQUE (account_id, target, via)
)
`,
  },
  {
    version: 28,
    name: "cheaper reads and writes",
    // D1 counts every row an index touches, so: the cron's lookups of local
    // accounts get an index of their own (there are few, among thousands of
    // remote ones); a duplicate index on posts goes; and tables keyed by their
    // primary key are rebuilt WITHOUT ROWID, so a write is one row, not two.
    //
    // Remote votes on remote posts move to remote_votes, keyed by the voter's
    // ActivityPub ID: they only move a score, so the voter needs no account.
    // Fedify's cached remote documents aren't carried over: palm keeps them in
    // memory now (see D1KvStore).
    sql: `
CREATE INDEX IF NOT EXISTS accounts_local ON accounts (id) WHERE ap_id IS NULL
;
DROP INDEX IF EXISTS posts_in_reply_to_all
;
CREATE TABLE IF NOT EXISTS remote_votes (
  post_id INTEGER NOT NULL REFERENCES posts (id),
  actor TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score IN (-1, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, actor)
) WITHOUT ROWID
;
INSERT OR IGNORE INTO remote_votes (post_id, actor, score, created_at)
SELECT v.post_id, a.ap_id, v.score, v.created_at
FROM votes v JOIN accounts a ON a.id = v.account_id JOIN posts p ON p.id = v.post_id
WHERE a.ap_id IS NOT NULL AND p.ap_id IS NOT NULL
;
CREATE TABLE votes_new (
  post_id INTEGER NOT NULL REFERENCES posts (id),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  score INTEGER NOT NULL CHECK (score IN (-1, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, account_id)
) WITHOUT ROWID
;
INSERT INTO votes_new (post_id, account_id, score, created_at)
SELECT v.post_id, v.account_id, v.score, v.created_at
FROM votes v JOIN accounts a ON a.id = v.account_id JOIN posts p ON p.id = v.post_id
WHERE a.ap_id IS NULL OR p.ap_id IS NULL
;
DROP TABLE votes
;
ALTER TABLE votes_new RENAME TO votes
;
CREATE TABLE post_tags_new (
  post_id INTEGER NOT NULL REFERENCES posts (id),
  tag TEXT NOT NULL,
  PRIMARY KEY (post_id, tag)
) WITHOUT ROWID
;
INSERT INTO post_tags_new (post_id, tag) SELECT t.post_id, t.tag FROM post_tags t JOIN posts p ON p.id = t.post_id
;
DROP TABLE post_tags
;
ALTER TABLE post_tags_new RENAME TO post_tags
;
CREATE INDEX IF NOT EXISTS post_tags_tag ON post_tags (tag, post_id)
;
CREATE TABLE fedify_kv_new (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
) WITHOUT ROWID
;
INSERT INTO fedify_kv_new (key, value, expires_at)
SELECT key, value, expires_at FROM fedify_kv
WHERE key NOT LIKE '_fedify' || char(31) || 'remoteDocument' || char(31) || '%'
  AND (expires_at IS NULL OR expires_at > unixepoch())
;
DROP TABLE fedify_kv
;
ALTER TABLE fedify_kv_new RENAME TO fedify_kv
;
CREATE INDEX IF NOT EXISTS fedify_kv_expires ON fedify_kv (expires_at) WHERE expires_at IS NOT NULL
`,
  },
  {
    version: 29,
    name: "post clients",
    // Which client API (lemmy, mastodon, pixelfed) and app made a local post.
    sql: `
ALTER TABLE posts ADD COLUMN client TEXT
;
ALTER TABLE posts ADD COLUMN client_app TEXT
`,
  },
  {
    version: 30,
    name: "post client devices",
    // The kind of device a local post came from, read from the app's User-Agent.
    sql: `
ALTER TABLE posts ADD COLUMN client_device TEXT
`,
  },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

export function statementsOf(migration: Migration): string[] {
  return migration.sql
    .split(/^\s*;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}
