import { afterEach, describe, expect, it, vi } from "vitest";
import { b64url, fromB64url, sendPush } from "../src/webpush.ts";

/** Just enough of D1 for palm_meta. */
function fakeDb() {
  const meta = new Map<string, string>();
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => statement(sql, a),
    first: async () => (sql.startsWith("SELECT") && meta.has(String(args[0])) ? { value: meta.get(String(args[0])) } : null),
    run: async () => {
      if (sql.startsWith("INSERT OR IGNORE") && !meta.has(String(args[0]))) meta.set(String(args[0]), String(args[1]));
      return {};
    },
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

const enc = new TextEncoder();
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** A subscriber's side: their keys, and decrypting what arrives. */
async function subscriber() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const shared = async (serverPublic: Uint8Array) => {
    const key = await crypto.subtle.importKey("raw", serverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: key } as never, pair.privateKey, 256));
  };
  return { publicRaw, auth, shared };
}

afterEach(() => vi.unstubAllGlobals());

describe("Web Push", () => {
  for (const standard of [true, false]) {
    it(`encrypts a payload a subscriber can read (${standard ? "aes128gcm" : "aesgcm"})`, async () => {
      const sub = await subscriber();
      let sent: { headers: Record<string, string>; body: Uint8Array } | null = null;
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        sent = { headers: init.headers as Record<string, string>, body: init.body as Uint8Array };
        return new Response(null, { status: 201 });
      });
      const status = await sendPush(fakeDb(), { endpoint: "https://push.example/abc", p256dh: b64url(sub.publicRaw), auth: b64url(sub.auth), standard }, { title: "hi" }, "https://palm.test/");
      expect(status).toBe(201);
      const { headers, body } = sent!;
      let plain: Uint8Array;
      if (standard) {
        const salt = body.slice(0, 16);
        const keyLength = body[20]!;
        const serverPublic = body.slice(21, 21 + keyLength);
        const ikm = await hkdf(sub.auth, await sub.shared(serverPublic), concat(enc.encode("WebPush: info\0"), sub.publicRaw, serverPublic), 32);
        const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
        const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
        const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
        plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + keyLength)));
        plain = plain.slice(0, plain.lastIndexOf(2));
        expect(headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
      } else {
        const salt = fromB64url(headers.Encryption!.replace("salt=", ""));
        const serverPublic = fromB64url(headers["Crypto-Key"]!.match(/dh=([^;]+)/)![1]!);
        const prk = await hkdf(sub.auth, await sub.shared(serverPublic), enc.encode("Content-Encoding: auth\0"), 32);
        const context = concat(enc.encode("P-256\0"), new Uint8Array([0, 65]), sub.publicRaw, new Uint8Array([0, 65]), serverPublic);
        const cek = await hkdf(salt, prk, concat(enc.encode("Content-Encoding: aesgcm\0"), context), 16);
        const nonce = await hkdf(salt, prk, concat(enc.encode("Content-Encoding: nonce\0"), context), 12);
        const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
        plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body)).slice(2);
        expect(headers.Authorization).toMatch(/^WebPush .+\..+\..+$/);
      }
      expect(JSON.parse(new TextDecoder().decode(plain))).toEqual({ title: "hi" });
    });
  }
});
