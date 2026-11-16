import { hashPassword } from "@palm/auth";
import { createApp, createToken, migrate } from "@palm/db";
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

/** Gives an account RSA and Ed25519 keys, as `palm user keys` does. */
export async function giveKeys(accountId: number): Promise<void> {
  const rsa = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const ed = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  for (const [algorithm, pair] of [["RSASSA-PKCS1-v1_5", rsa], ["Ed25519", ed]] as const) {
    await db
      .prepare("INSERT INTO actor_keys (account_id, algorithm, public_jwk, private_jwk, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(
        accountId,
        algorithm,
        JSON.stringify(await crypto.subtle.exportKey("jwk", pair.publicKey)),
        JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)),
        0,
      )
      .run();
  }
}

/** A Mastodon API bearer token for an account, as if it had signed in through OAuth. */
export async function mastodonToken(accountId: number): Promise<string> {
  const app = await createApp(db, { name: "Test", website: null, redirectUris: ["ivory://oauth"], scopes: "read write follow" });
  return (await createToken(db, { appId: app.id, accountId, scopes: "read write follow" })).token;
}
