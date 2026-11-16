#!/usr/bin/env node
/**
 * palm's admin CLI. Runs on your machine with Node 22+ (which strips the
 * TypeScript types itself) and talks to the deployment's D1 through wrangler.
 *
 *   pnpm palm user create <username> --domain <domain> --db <d1-name> [--admin] [--password <pw>]
 *
 * Without --password it generates one and prints it once. Without --db it
 * prints the SQL instead of running it.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { hashPassword } from "@palm/auth";

const USAGE = "Usage: pnpm palm user create <username> --domain <domain> [--db <d1-name>] [--admin] [--password <pw>] [--local]";

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

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
    ");";

  if (!values.db) {
    console.log(sql);
  } else {
    // The tables exist once the Worker has served one request after deploy.
    execFileSync("npx", ["wrangler", "d1", "execute", values.db, values.local ? "--local" : "--remote", "--command", sql], {
      stdio: "inherit",
    });
    console.log(`\nCreated @${username}@${values.domain}${values.admin ? " (admin)" : ""}.`);
  }
  if (generated) console.log(`Password: ${password}\nIt isn't stored anywhere else; pass it on now.`);
}

async function main(argv: string[]): Promise<void> {
  const [group, command, ...rest] = argv;
  if (group === "user" && command === "create") return userCreate(rest);
  throw new Error(USAGE);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
