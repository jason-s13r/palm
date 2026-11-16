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
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

export function statementsOf(migration: Migration): string[] {
  return migration.sql
    .split(/^\s*;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}
