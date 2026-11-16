import { base64url, fromBase64url, utf8 } from "./encoding.ts";

/**
 * Minimal HS256 JWTs, which is what Lemmy issues to its apps. Apps treat the
 * token as opaque; palm reads `sub` (the account) and `sid` (the session, so a
 * token can be revoked).
 */
export interface JwtClaims {
  /** The account ID, as Lemmy does. */
  sub: string;
  /** The session ID; revoking the session revokes the token. */
  sid: string;
  /** The domain that issued it. */
  iss: string;
  /** Issued at, in seconds. */
  iat: number;
}

const HEADER = base64url(utf8(JSON.stringify({ alg: "HS256", typ: "JWT" })));

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signJwt(claims: JwtClaims, secret: string): Promise<string> {
  const body = `${HEADER}.${base64url(utf8(JSON.stringify(claims)))}`;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(body)));
  return `${body}.${base64url(signature)}`;
}

/** Returns the claims of a token signed with `secret`, or null. */
export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  const [header, payload, signature] = token.split(".");
  if (header !== HEADER || !payload || !signature) return null;
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromBase64url(signature), utf8(`${header}.${payload}`));
  } catch {
    return null;
  }
  if (!valid) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as Partial<JwtClaims>;
    if (typeof claims.sub !== "string" || typeof claims.sid !== "string") return null;
    return claims as JwtClaims;
  } catch {
    return null;
  }
}
