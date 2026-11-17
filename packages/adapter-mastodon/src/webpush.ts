import { metaValue } from "@palm/db";

/**
 * Web Push from a Worker, with Web Crypto alone: VAPID (RFC 8292) to sign
 * each request, and the payload encrypted for the subscriber. Mastodon apps
 * subscribe through their own relays (Ivory's, the Mastodon app's), which
 * expect Mastodon's encoding: the older "aesgcm" draft unless the app asked
 * for the RFC 8291 "aes128gcm" one.
 */

const enc = new TextEncoder();

export const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

interface Vapid {
  publicKey: string;
  privateJwk: JsonWebKey;
}

/** The instance's VAPID key pair: made once (P-256 is cheap), kept in palm_meta. */
export async function vapidKeys(db: D1Database): Promise<Vapid> {
  const stored = await metaValue(db, "vapid", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
    return JSON.stringify({ publicKey: b64url(publicRaw), privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey) });
  });
  return JSON.parse(stored) as Vapid;
}

async function vapidJwt(vapid: Vapid, endpoint: string, subject: string): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(signature)}`;
}

export interface Subscriber {
  endpoint: string;
  p256dh: string;
  auth: string;
  standard: boolean;
}

/** Encrypts and sends one push. Returns the push service's status (410 means the subscription is gone). */
export async function sendPush(db: D1Database, subscriber: Subscriber, payload: object, subject: string): Promise<number> {
  const vapid = await vapidKeys(db);
  const clientPublic = fromB64url(subscriber.p256dh);
  const authSecret = fromB64url(subscriber.auth);
  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const localPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  const clientKey = await crypto.subtle.importKey("raw", clientPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, local.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const message = enc.encode(JSON.stringify(payload));
  const jwt = await vapidJwt(vapid, subscriber.endpoint, subject);

  let body: Uint8Array;
  const headers: Record<string, string> = { TTL: "86400", Urgency: "normal", "Content-Type": "application/octet-stream" };
  if (subscriber.standard) {
    // RFC 8291: aes128gcm, the key and salt in the body's header.
    const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), clientPublic, localPublic), 32);
    const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(message, new Uint8Array([2]))));
    const rs = new Uint8Array([0, 0, 16, 0]);
    body = concat(salt, rs, new Uint8Array([localPublic.length]), localPublic, cipher);
    headers["Content-Encoding"] = "aes128gcm";
    headers.Authorization = `vapid t=${jwt}, k=${vapid.publicKey}`;
  } else {
    // Mastodon's aesgcm (draft-ietf-webpush-encryption-04): salt and key in headers.
    const prk = await hkdf(authSecret, shared, enc.encode("Content-Encoding: auth\0"), 32);
    const length = (n: number) => new Uint8Array([0, n]);
    const context = concat(enc.encode("P-256\0"), length(clientPublic.length), clientPublic, length(localPublic.length), localPublic);
    const cek = await hkdf(salt, prk, concat(enc.encode("Content-Encoding: aesgcm\0"), context), 16);
    const nonce = await hkdf(salt, prk, concat(enc.encode("Content-Encoding: nonce\0"), context), 12);
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
    body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(new Uint8Array([0, 0]), message)));
    headers["Content-Encoding"] = "aesgcm";
    headers.Encryption = `salt=${b64url(salt)}`;
    headers["Crypto-Key"] = `dh=${b64url(localPublic)};p256ecdsa=${vapid.publicKey}`;
    headers.Authorization = `WebPush ${jwt}`;
  }
  const response = await fetch(subscriber.endpoint, { method: "POST", headers, body });
  await response.body?.cancel().catch(() => undefined);
  return response.status;
}
