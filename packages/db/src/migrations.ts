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
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

export function statementsOf(migration: Migration): string[] {
  return migration.sql
    .split(/^\s*;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}
