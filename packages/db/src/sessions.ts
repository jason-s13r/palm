import { randomToken, sha256Hex } from "@palm/auth";

const now = () => Math.floor(Date.now() / 1000);

// --- Lemmy sessions: a JWT carries the session ID; the row makes it revocable.

export async function createSession(db: D1Database, accountId: number, client: string): Promise<string> {
  const id = randomToken(16);
  await db
    .prepare("INSERT INTO sessions (id, account_id, client, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, accountId, client, now())
    .run();
  return id;
}

/** The account a live session belongs to, or null if it's unknown or revoked. */
export async function sessionAccount(db: D1Database, sessionId: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT account_id FROM sessions WHERE id = ? AND revoked_at IS NULL")
    .bind(sessionId)
    .first<{ account_id: number }>();
  return row?.account_id ?? null;
}

export async function revokeSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now(), sessionId).run();
}

// --- Mastodon OAuth: apps, short-lived codes and bearer tokens, stored by hash.

export interface OAuthApp {
  id: number;
  clientId: string;
  clientSecret: string;
  name: string;
  website: string | null;
  redirectUris: string[];
  scopes: string;
}

interface AppRow {
  id: number;
  client_id: string;
  client_secret: string;
  name: string;
  website: string | null;
  redirect_uris: string;
  scopes: string;
}

const toApp = (row: AppRow): OAuthApp => ({
  id: row.id,
  clientId: row.client_id,
  clientSecret: row.client_secret,
  name: row.name,
  website: row.website,
  redirectUris: row.redirect_uris.split(/\s+/).filter(Boolean),
  scopes: row.scopes,
});

export async function createApp(
  db: D1Database,
  app: { name: string; website: string | null; redirectUris: string[]; scopes: string },
): Promise<OAuthApp> {
  const clientId = randomToken(24);
  const clientSecret = randomToken(32);
  const row = await db
    .prepare(
      "INSERT INTO oauth_apps (client_id, client_secret, name, website, redirect_uris, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .bind(clientId, clientSecret, app.name, app.website, app.redirectUris.join(" "), app.scopes, now())
    .first<AppRow>();
  if (!row) throw new Error("App was not created.");
  return toApp(row);
}

export async function appByClientId(db: D1Database, clientId: string): Promise<OAuthApp | null> {
  const row = await db.prepare("SELECT * FROM oauth_apps WHERE client_id = ?").bind(clientId).first<AppRow>();
  return row ? toApp(row) : null;
}

export async function appById(db: D1Database, id: number): Promise<OAuthApp | null> {
  const row = await db.prepare("SELECT * FROM oauth_apps WHERE id = ?").bind(id).first<AppRow>();
  return row ? toApp(row) : null;
}

/** Issues a one-time authorization code, valid for ten minutes. */
export async function createCode(
  db: D1Database,
  grant: { appId: number; accountId: number; redirectUri: string; scopes: string; codeChallenge: string | null },
): Promise<string> {
  const code = randomToken(32);
  await db
    .prepare(
      "INSERT INTO oauth_codes (code_hash, app_id, account_id, redirect_uri, scopes, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(await sha256Hex(code), grant.appId, grant.accountId, grant.redirectUri, grant.scopes, grant.codeChallenge, now() + 600)
    .run();
  return code;
}

export interface CodeGrant {
  appId: number;
  accountId: number;
  redirectUri: string;
  scopes: string;
  codeChallenge: string | null;
}

/** Uses up a code: returns its grant if it was valid, and deletes it either way. */
export async function consumeCode(db: D1Database, code: string): Promise<CodeGrant | null> {
  const row = await db
    .prepare("DELETE FROM oauth_codes WHERE code_hash = ? RETURNING app_id, account_id, redirect_uri, scopes, code_challenge, expires_at")
    .bind(await sha256Hex(code))
    .first<{ app_id: number; account_id: number; redirect_uri: string; scopes: string; code_challenge: string | null; expires_at: number }>();
  if (!row || row.expires_at < now()) return null;
  return {
    appId: row.app_id,
    accountId: row.account_id,
    redirectUri: row.redirect_uri,
    scopes: row.scopes,
    codeChallenge: row.code_challenge,
  };
}

export async function createToken(
  db: D1Database,
  grant: { appId: number; accountId: number | null; scopes: string },
): Promise<{ token: string; createdAt: number }> {
  const token = randomToken(32);
  const createdAt = now();
  await db
    .prepare("INSERT INTO oauth_tokens (token_hash, app_id, account_id, scopes, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), grant.appId, grant.accountId, grant.scopes, createdAt)
    .run();
  return { token, createdAt };
}

export interface TokenGrant {
  appId: number;
  accountId: number | null;
  scopes: string;
}

export async function tokenGrant(db: D1Database, token: string): Promise<TokenGrant | null> {
  const row = await db
    .prepare("SELECT app_id, account_id, scopes FROM oauth_tokens WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(await sha256Hex(token))
    .first<{ app_id: number; account_id: number | null; scopes: string }>();
  return row ? { appId: row.app_id, accountId: row.account_id, scopes: row.scopes } : null;
}

export async function revokeToken(db: D1Database, token: string): Promise<void> {
  await db
    .prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(now(), await sha256Hex(token))
    .run();
}
