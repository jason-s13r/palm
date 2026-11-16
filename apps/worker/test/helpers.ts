import { hashPassword } from "@palm/auth";
import { migrate } from "@palm/db";
import { env, exports } from "cloudflare:workers";

// `wrangler types` would type these; the tests only need fetch() and DB.
export const worker = (exports as unknown as { default: Fetcher }).default;
export const db = (env as unknown as { DB: D1Database }).DB;

/** The staging entry's hosts, as vitest.config.ts sets them. */
export const DOMAIN = "palm.test";
export const LEMMY = "https://lemmy.palm.test";
export const MASTODON = "https://mastodon.palm.test";

/** Creates an account with a known password; cheap hashing keeps tests fast. */
export async function createAccount(username: string, password: string, role: "user" | "admin" = "user"): Promise<number> {
  await migrate(db);
  const row = await db
    .prepare("INSERT INTO accounts (domain, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .bind(DOMAIN, username, await hashPassword(password, 1_000), role, Math.floor(Date.now() / 1000))
    .first<{ id: number }>();
  return row!.id;
}

export const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
