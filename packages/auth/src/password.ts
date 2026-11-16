import { base64url, fromBase64url, timingSafeEqual, utf8 } from "./encoding.ts";

/**
 * PBKDF2-SHA256 through Web Crypto, which the Workers runtime and Node both
 * provide, so the CLI can hash a password that the Worker later verifies.
 *
 * The iteration count is a trade between brute-force cost and the free plan's
 * 10 ms of CPU per request. It's stored in each hash, so it can be raised later
 * and old hashes upgraded on the next successful login.
 */
export const PASSWORD_ITERATIONS = 50_000;

const PREFIX = "pbkdf2-sha256";

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", utf8(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** Hashes a password as `pbkdf2-sha256$<iterations>$<salt>$<hash>`. */
export async function hashPassword(password: string, iterations = PASSWORD_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations);
  return [PREFIX, iterations, base64url(salt), base64url(hash)].join("$");
}

/** Checks a password against a stored hash. Unknown formats never match. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [prefix, iterationsText, saltText, hashText] = stored.split("$");
  const iterations = Number(iterationsText);
  if (prefix !== PREFIX || !Number.isInteger(iterations) || iterations < 1 || !saltText || !hashText) return false;
  const actual = await derive(password, fromBase64url(saltText), iterations);
  return timingSafeEqual(actual, fromBase64url(hashText));
}

/** True when a stored hash uses fewer iterations than the current setting. */
export function needsRehash(stored: string): boolean {
  return Number(stored.split("$")[1]) < PASSWORD_ITERATIONS;
}
