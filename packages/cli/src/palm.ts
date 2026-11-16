#!/usr/bin/env node
/**
 * palm's admin CLI. Runs on your machine with Node 22+ (which strips the
 * TypeScript types itself) and talks to the deployment's D1 through wrangler.
 *
 *   pnpm palm user create <username> --domain <domain> --db <d1-name> [--admin] [--password <pw>]
 *   pnpm palm user keys <username> --domain <domain> --db <d1-name>
 *   pnpm palm community create <name> --domain <domain> --db <d1-name> [--title <title>] [--description <text>]
 *
 * Signing keys (RSA for HTTP Signatures, Ed25519 for integrity proofs) are
 * generated here rather than in the Worker, because key generation is too slow
 * for the free plan's 10 ms CPU limit.
 *
 * Without --password it generates one and prints it once. Without --db it
 * prints the SQL instead of running it.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { hashPassword } from "@palm/auth";

const USAGE = [
  "Usage:",
  "  pnpm palm user create <username> --domain <domain> [--db <d1-name>] [--admin] [--password <pw>] [--local]",
  "  pnpm palm user keys <username> --domain <domain> [--db <d1-name>] [--local]",
  "  pnpm palm community create <name> --domain <domain> [--db <d1-name>] [--title <title>] [--description <text>] [--local]",
].join("\n");

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** SQL that gives an account fresh RSA and Ed25519 signing keys, replacing any it had. */
async function keySql(domain: string, username: string): Promise<string> {
  const account = `(SELECT id FROM accounts WHERE domain = ${sqlString(domain)} AND username = ${sqlString(username)})`;
  return keyRows("actor_keys", "account_id", account);
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

async function main(argv: string[]): Promise<void> {
  const [group, command, ...rest] = argv;
  if (group === "user" && command === "create") return userCreate(rest);
  if (group === "user" && command === "keys") return userKeys(rest);
  if (group === "community" && command === "create") return communityCreate(rest);
  throw new Error(USAGE);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
