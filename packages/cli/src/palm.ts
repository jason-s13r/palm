#!/usr/bin/env node
/**
 * palm's admin CLI. Runs on your machine with Node 22+ (which strips the
 * TypeScript types itself) and talks to the deployment's D1 through wrangler.
 *
 *   pnpm palm user create <username> --domain <domain> --db <d1-name> [--admin] [--password <pw>]
 *   pnpm palm user keys <username> --domain <domain> --db <d1-name>
 *   pnpm palm invite create --domain <domain> --db <d1-name> [--count <n>]
 *   pnpm palm community create <name> --domain <domain> --db <d1-name> [--title <title>] [--description <text>]
 *   pnpm palm user alias <username> [<actor-id>...]
 *   pnpm palm user move <username> <actor-id>
 *   pnpm palm user delete <username> [--keep-posts]
 *   pnpm palm user export <username> [--out <file>]
 *   pnpm palm user import <username> <file> [--via mastodon|lemmy]
 *
 * Signing keys (RSA for HTTP Signatures, Ed25519 for integrity proofs) are
 * generated here rather than in the Worker, because key generation is too slow
 * for the free plan's 10 ms CPU limit.
 *
 * Without --password it generates one and prints it once. Without --db it
 * prints the SQL instead of running it.
 *
 * Run from an instance repo, --domain and --db default to the "palm" field of
 * its package.json ({ "palm": { "domain": "...", "db": "..." } }), or to the
 * PALM_DOMAIN and PALM_DB environment variables, so `pnpm palm user create
 * jason --admin` is enough there. Flags win over both.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { hashPassword } from "@palm/auth";

const USAGE = [
  "Usage:",
  "  pnpm palm user create <username> --domain <domain> [--db <d1-name>] [--admin] [--password <pw>] [--local]",
  "  pnpm palm user keys <username> --domain <domain> [--db <d1-name>] [--local]",
  "  pnpm palm user alias <username> [<actor-id>...] [--local]   (the accounts this one moved from; none clears)",
  "  pnpm palm user move <username> <actor-id> [--local]          (followers are moved on the next cron run)",
  "  pnpm palm user delete <username> [--keep-posts] [--local]",
  "  pnpm palm user export <username> [--out <file>] [--local]",
  "  pnpm palm user import <username> <file> [--via mastodon|lemmy] [--local]   (follows from another server, sent a few at a time)",
  "  pnpm palm community create <name> --domain <domain> [--db <d1-name>] [--title <title>] [--description <text>] [--local]",
  "  pnpm palm invite create --domain <domain> [--db <d1-name>] [--count <n>] [--local]",
  "  pnpm palm keys stock [--db <d1-name>] [--count <n>] [--local]   (keys for communities made in apps)",
  "",
  "From an instance repo, --domain and --db default to its package.json's",
  '"palm": { "domain": ..., "db": ... }, or PALM_DOMAIN and PALM_DB.',
].join("\n");

/** The instance this directory manages, from its package.json or the environment. */
function instanceDefaults(): { domain?: string; db?: string } {
  let fromPackage: { domain?: unknown; db?: unknown } = {};
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { palm?: { domain?: unknown; db?: unknown } };
    fromPackage = pkg.palm ?? {};
  } catch {
    // No package.json here, or not JSON: no defaults from it.
  }
  const pick = (env: string | undefined, value: unknown) => env || (typeof value === "string" && value ? value : undefined);
  const domain = pick(process.env.PALM_DOMAIN, fromPackage.domain);
  const db = pick(process.env.PALM_DB, fromPackage.db);
  return { ...(domain ? { domain } : {}), ...(db ? { db } : {}) };
}

/** Command arguments with the instance's --domain and --db filled in when not given. */
function withDefaults(args: string[]): string[] {
  const defaults = instanceDefaults();
  const has = (flag: string) => args.some((a) => a === `--${flag}` || a.startsWith(`--${flag}=`));
  return [
    ...args,
    ...(defaults.domain && !has("domain") ? ["--domain", defaults.domain] : []),
    ...(defaults.db && !has("db") ? ["--db", defaults.db] : []),
  ];
}

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** SQL that gives an account fresh RSA and Ed25519 signing keys, replacing any it had. */
async function keySql(domain: string, username: string): Promise<string> {
  const account = `(SELECT id FROM accounts WHERE domain = ${sqlString(domain)} AND username = ${sqlString(username)})`;
  // New keys change the actor document other servers keep a copy of.
  return `${await keyRows("actor_keys", "account_id", account)}\nUPDATE accounts SET profile_version = profile_version + 1 WHERE id = ${account};`;
}

/** INSERTs of a fresh RSA and Ed25519 key pair into `table`, for the row `owner` selects. */
async function keyRows(table: string, column: string, owner: string): Promise<string> {
  const rsa = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const ed = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const now = Math.floor(Date.now() / 1000);
  const row = async (algorithm: string, pair: CryptoKeyPair) =>
    `INSERT OR REPLACE INTO ${table} (${column}, algorithm, public_jwk, private_jwk, created_at) VALUES (${owner}, ${sqlString(algorithm)}, ` +
    `${sqlString(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.publicKey)))}, ` +
    `${sqlString(JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)))}, ${now});`;
  return [await row("RSASSA-PKCS1-v1_5", rsa), await row("Ed25519", ed)].join("\n");
}

function run(db: string | undefined, local: boolean, sql: string): void {
  if (!db) {
    console.log(sql);
    return;
  }
  // The tables exist once the Worker has served one request after deploy.
  execFileSync("npx", ["wrangler", "d1", "execute", db, local ? "--local" : "--remote", "--command", sql], { stdio: "inherit" });
}

async function userCreate(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      domain: { type: "string" },
      db: { type: "string" },
      admin: { type: "boolean", default: false },
      password: { type: "string" },
      local: { type: "boolean", default: false },
    },
  });
  const username = positionals[0]?.toLowerCase();
  if (!username || !/^[a-z0-9_]{1,20}$/.test(username) || !values.domain) {
    throw new Error(`${USAGE}\nUsernames are 1–20 lowercase letters, digits or underscores.`);
  }
  const generated = !values.password;
  const password = values.password ?? randomBytes(15).toString("base64url");
  const hash = await hashPassword(password);
  const sql =
    "INSERT INTO accounts (domain, username, password_hash, role, created_at) VALUES (" +
    [sqlString(values.domain), sqlString(username), sqlString(hash), sqlString(values.admin ? "admin" : "user"), Math.floor(Date.now() / 1000)].join(", ") +
    ");\n" +
    (await keySql(values.domain, username));

  run(values.db, values.local ?? false, sql);
  if (values.db) console.log(`\nCreated @${username}@${values.domain}${values.admin ? " (admin)" : ""}.`);
  if (generated) console.log(`Password: ${password}\nIt isn't stored anywhere else; pass it on now.`);
}

async function userKeys(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { domain: { type: "string" }, db: { type: "string" }, local: { type: "boolean", default: false } },
  });
  const username = positionals[0]?.toLowerCase();
  if (!username || !values.domain) throw new Error(USAGE);
  run(values.db, values.local ?? false, await keySql(values.domain, username));
  if (values.db) console.log(`\nNew signing keys for @${username}@${values.domain}.`);
}

const accountSql = (domain: string, username: string) =>
  `(SELECT id FROM accounts WHERE domain = ${sqlString(domain)} AND username = ${sqlString(username)} AND ap_id IS NULL)`;

/** Arguments of the account commands: a username, then their own options. */
function userArgs(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      domain: { type: "string" },
      db: { type: "string" },
      local: { type: "boolean", default: false },
      "keep-posts": { type: "boolean", default: false },
      out: { type: "string" },
      via: { type: "string" },
    },
  });
  const username = positionals[0]?.toLowerCase();
  if (!username || !values.domain) throw new Error(USAGE);
  return { values, rest: positionals.slice(1), username, domain: values.domain, db: values.db, local: values.local === true };
}

const actorId = (value: string) => {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`Not an https actor ID: ${value}`);
  return url.href;
};

/** The other accounts this one says are also it: a move here from elsewhere needs it. */
function userAlias(args: string[]): void {
  const { rest, username, domain, db, local } = userArgs(args);
  const ids = rest.map(actorId);
  run(db, local, `UPDATE accounts SET also_known_as = ${ids.length ? sqlString(JSON.stringify(ids)) : "NULL"}, profile_version = profile_version + 1 WHERE id = ${accountSql(domain, username)};`);
  if (db) console.log(ids.length ? `\n@${username}@${domain} is also: ${ids.join(", ")}` : `\nCleared @${username}@${domain}'s aliases.`);
}

/** Moves an account's followers to another account, which must list this one as an alias. */
function userMove(args: string[]): void {
  const { rest, username, domain, db, local } = userArgs(args);
  if (!rest[0]) throw new Error(USAGE);
  const target = actorId(rest[0]);
  run(db, local, `UPDATE accounts SET moved_to = ${sqlString(target)}, move_sent_at = NULL, profile_version = profile_version + 1 WHERE id = ${accountSql(domain, username)};`);
  if (db) console.log(`\n@${username}@${domain} moves to ${target}; its followers are told on the next cron run.`);
}

type Via = "mastodon" | "lemmy";

/**
 * The follows in an export from another server: Mastodon's
 * following_accounts.csv, Lemmy's settings export, or palm's own export.
 * People come in as Mastodon follows and communities as Lemmy subscriptions,
 * unless `via` says otherwise.
 */
function followsIn(text: string, via?: Via): { target: string; via: Via }[] {
  const found: { target: string; via: Via }[] = [];
  const add = (target: string, as: Via) => found.push({ target, via: via ?? as });
  const urlsOf = (value: unknown) =>
    (Array.isArray(value) ? value : []).filter((v): v is string => typeof v === "string" && /^https:\/\/\S+$/.test(v));
  if (text.trimStart().startsWith("{")) {
    const data = JSON.parse(text) as Record<string, unknown>;
    // Lemmy: communities, and palm's people marked with #person.
    for (const id of urlsOf(data.followed_communities)) add(id, "lemmy");
    // palm: people and communities.
    for (const id of urlsOf(data.following)) add(id, "mastodon");
    for (const id of urlsOf(data.communities)) add(id, "lemmy");
  } else {
    // Mastodon: "Account address,Show boosts,..." then one account a line
    // (older exports have no header).
    for (const line of text.split(/\r?\n/)) {
      const address = line.split(",")[0]!.trim().replace(/^@/, "");
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) add(address, "mastodon");
    }
  }
  const seen = new Set<string>();
  return found.filter((f) => {
    const key = `${f.via} ${f.target.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Queues follows from another server's export; the cron sends a few each run. */
function userImport(args: string[]): void {
  const { values, rest, username, domain, db, local } = userArgs(args);
  if (!rest[0]) throw new Error(USAGE);
  const via = values.via;
  if (via !== undefined && via !== "mastodon" && via !== "lemmy") throw new Error("--via is mastodon or lemmy");
  const follows = followsIn(readFileSync(rest[0], "utf8"), via);
  if (!follows.length) throw new Error(`No follows found in ${rest[0]}`);
  const at = Math.floor(Date.now() / 1000);
  const id = accountSql(domain, username);
  // A few hundred rows a command keeps each one well under wrangler's limits.
  for (let i = 0; i < follows.length; i += 200) {
    const rows = follows
      .slice(i, i + 200)
      .map((f) => `INSERT OR IGNORE INTO follow_imports (account_id, target, via, created_at) SELECT ${id}, ${sqlString(f.target)}, ${sqlString(f.via)}, ${at} WHERE ${id} IS NOT NULL;`);
    run(db, local, rows.join("\n"));
  }
  if (db) console.log(`\nQueued ${follows.length} follows for @${username}@${domain}: the cron sends 5 every 10 minutes (about ${Math.ceil(follows.length / 30)} h).`);
}

/** Deletes an account. Its name stays taken; other servers are told on the next cron run. */
function userDelete(args: string[]): void {
  const { values, username, domain, db, local } = userArgs(args);
  const id = accountSql(domain, username);
  const now = Math.floor(Date.now() / 1000);
  const sql = [
    `UPDATE accounts SET deleted_at = ${now}, banned_at = COALESCE(banned_at, ${now}), profile_version = profile_version + 1, password_hash = NULL, display_name = NULL, bio = NULL, avatar_url = NULL, header_url = NULL WHERE id = ${id};`,
    ...["sessions", "oauth_tokens", "oauth_codes", "push_subscriptions", "community_subscriptions", "notifications"].map((t) => `DELETE FROM ${t} WHERE account_id = ${id};`),
    `DELETE FROM account_follows WHERE account_id = ${id} OR target_id = ${id};`,
    ...(values["keep-posts"] ? [] : [`UPDATE posts SET deleted_at = ${now} WHERE account_id = ${id} AND deleted_at IS NULL;`]),
  ].join("\n");
  run(db, local, sql);
  if (db) console.log(`\nDeleted @${username}@${domain}.`);
}

/** An account's profile, posts, follows and followers, as JSON. */
function userExport(args: string[]): void {
  const { values, username, domain, db, local } = userArgs(args);
  if (!db) throw new Error("export needs --db");
  const id = accountSql(domain, username);
  const query = (sql: string) => {
    const out = execFileSync("npx", ["wrangler", "d1", "execute", db, local ? "--local" : "--remote", "--json", "--command", sql], { encoding: "utf8" });
    return (JSON.parse(out) as { results: Record<string, unknown>[] }[])[0]?.results ?? [];
  };
  const data = {
    exported_at: new Date().toISOString(),
    account: query(`SELECT username, domain, display_name, bio, avatar_url, header_url, created_at, also_known_as, moved_to FROM accounts WHERE id = ${id}`)[0] ?? null,
    posts: query(
      `SELECT id, title, content_source, content_html, link_url, visibility, parent_id, community_id, created_at, updated_at FROM posts WHERE account_id = ${id} AND deleted_at IS NULL ORDER BY id`,
    ),
    following: query(
      `SELECT COALESCE(a.ap_id, 'https://' || a.domain || '/users/' || lower(a.username)) AS id FROM account_follows f JOIN accounts a ON a.id = f.target_id WHERE f.account_id = ${id}`,
    ).map((r) => r.id),
    followers: query(`SELECT actor_id AS id FROM followers WHERE account_id = ${id} AND pending = 0`).map((r) => r.id),
    communities: query(
      `SELECT COALESCE(c.ap_id, 'https://' || c.domain || '/c/' || lower(c.name)) AS id FROM community_subscriptions s JOIN communities c ON c.id = s.community_id WHERE s.account_id = ${id}`,
    ).map((r) => r.id),
  };
  if (!data.account) throw new Error(`No local account @${username}@${domain}.`);
  const file = typeof values.out === "string" ? values.out : `${username}@${domain}.json`;
  writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`Wrote ${data.posts.length} posts and ${data.following.length} follows to ${file}.`);
}

async function communityCreate(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      domain: { type: "string" },
      db: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      local: { type: "boolean", default: false },
    },
  });
  const name = positionals[0]?.toLowerCase();
  if (!name || !/^[a-z0-9_]{1,20}$/.test(name) || !values.domain) {
    throw new Error(`${USAGE}\nCommunity names are 1–20 lowercase letters, digits or underscores.`);
  }
  const domain = sqlString(values.domain);
  // Names share WebFinger with usernames, so a community can't take a person's name.
  const sql =
    `INSERT INTO communities (domain, name, title, description, created_at) SELECT ${domain}, ${sqlString(name)}, ` +
    `${sqlString(values.title ?? name)}, ${values.description ? sqlString(values.description) : "NULL"}, ${Math.floor(Date.now() / 1000)} ` +
    `WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE domain = ${domain} AND username = ${sqlString(name)});\n` +
    (await keyRows("community_keys", "community_id", `(SELECT id FROM communities WHERE domain = ${domain} AND name = ${sqlString(name)})`));
  run(values.db, values.local ?? false, sql);
  if (values.db) console.log(`\nCreated !${name}@${values.domain}.`);
}

/**
 * Invite codes for signing up. Each carries a key pair made here, because
 * making one in the Worker would blow the free plan's CPU budget; whoever
 * signs up with the code gets those keys.
 */
async function inviteCreate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { domain: { type: "string" }, db: { type: "string" }, count: { type: "string" }, local: { type: "boolean", default: false } },
  });
  if (!values.domain) throw new Error(USAGE);
  const count = Math.min(Math.max(Number(values.count ?? 1) || 1, 1), 20);
  const codes: string[] = [];
  const rows: string[] = [];
  for (let i = 0; i < count; i++) {
    // Short enough to type on a phone: 12 characters, no look-alikes.
    const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    const code = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => alphabet[b % alphabet.length]).join("");
    const keyPairs = await keyPairsJson();
    rows.push(
      `INSERT INTO invites (code, domain, key_pairs, created_at) VALUES (${sqlString(code)}, ${sqlString(values.domain)}, ${sqlString(keyPairs)}, ${Math.floor(Date.now() / 1000)});`,
    );
    codes.push(code);
  }
  run(values.db, values.local ?? false, rows.join("\n"));
  if (values.db) {
    console.log(`\nInvite codes for ${values.domain} (each signs up one account, in a Lemmy app's application answer or a Mastodon app's reason):`);
    for (const code of codes) console.log(`  ${code}`);
  }
}

/** A fresh RSA and Ed25519 key pair, as the JSON invites and spare keys carry. */
async function keyPairsJson(): Promise<string> {
  const rsa = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const ed = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const pair = async (algorithm: string, keys: CryptoKeyPair) => ({
    algorithm,
    publicJwk: await crypto.subtle.exportKey("jwk", keys.publicKey),
    privateJwk: await crypto.subtle.exportKey("jwk", keys.privateKey),
  });
  return JSON.stringify([await pair("RSASSA-PKCS1-v1_5", rsa), await pair("Ed25519", ed)]);
}

/** Spare key pairs, for communities people create from Lemmy apps. */
async function keysStock(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { domain: { type: "string" }, db: { type: "string" }, count: { type: "string" }, local: { type: "boolean", default: false } },
  });
  const count = Math.min(Math.max(Number(values.count ?? 5) || 5, 1), 50);
  const now = Math.floor(Date.now() / 1000);
  const rows: string[] = [];
  for (let i = 0; i < count; i++) rows.push(`INSERT INTO spare_keys (key_pairs, created_at) VALUES (${sqlString(await keyPairsJson())}, ${now});`);
  run(values.db, values.local ?? false, rows.join("\n"));
  if (values.db) console.log(`\nAdded ${count} spare key pairs: people can create that many communities from Lemmy apps.`);
}

async function main(argv: string[]): Promise<void> {
  const [group, command, ...given] = argv;
  const rest = withDefaults(given);
  if (group === "user" && command === "create") return userCreate(rest);
  if (group === "user" && command === "keys") return userKeys(rest);
  if (group === "user" && command === "alias") return userAlias(rest);
  if (group === "user" && command === "move") return userMove(rest);
  if (group === "user" && command === "delete") return userDelete(rest);
  if (group === "user" && command === "export") return userExport(rest);
  if (group === "user" && command === "import") return userImport(rest);
  if (group === "community" && command === "create") return communityCreate(rest);
  if (group === "invite" && command === "create") return inviteCreate(rest);
  if (group === "keys" && command === "stock") return keysStock(rest);
  throw new Error(USAGE);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
