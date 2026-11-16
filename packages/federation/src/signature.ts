/**
 * Checks a draft-cavage HTTP Signature, the kind Lemmy and Mastodon send,
 * for the fast path in prefilter.ts. Returns the signing actor's id, or null
 * when the request can't be checked here (no signature, RFC 9421, an unknown
 * algorithm, a key that won't load), in which case Fedify checks it instead.
 *
 * Keys are kept in D1 (remote_keys) and imported keys per isolate, so a busy
 * community's deliveries cost one RSA verify each, about a tenth of a
 * millisecond, instead of Fedify parsing the activity as JSON-LD.
 */

const MAX_SKEW_MS = 60 * 60 * 1000;
const imported = new Map<string, CryptoKey>();

function parseSignature(header: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) fields[match[1]!.toLowerCase()] = match[2]!;
  return fields;
}

const base64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function pemToDer(pem: string): Uint8Array {
  return base64ToBytes(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
}

async function sha256Base64(body: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  return btoa(String.fromCharCode(...hash));
}

interface StoredKey {
  owner: string;
  pem: string;
}

async function fetchKey(keyId: string): Promise<StoredKey | null> {
  const res = await fetch(keyId.split("#")[0]!, {
    headers: { accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"' },
  }).catch(() => null);
  if (!res?.ok) return null;
  const doc = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!doc) return null;
  const keys = Array.isArray(doc.publicKey) ? doc.publicKey : [doc.publicKey];
  for (const key of keys as Record<string, unknown>[]) {
    if (!key || key.id !== keyId || typeof key.publicKeyPem !== "string") continue;
    const owner = typeof key.owner === "string" ? key.owner : typeof doc.id === "string" ? doc.id : null;
    // A key speaks for an actor on its own host only.
    if (!owner || new URL(owner).host !== new URL(keyId).host) return null;
    return { owner, pem: key.publicKeyPem };
  }
  return null;
}

async function keyFor(db: D1Database, keyId: string): Promise<{ owner: string; key: CryptoKey } | null> {
  let stored = await db.prepare("SELECT owner, pem FROM remote_keys WHERE key_id = ?").bind(keyId).first<StoredKey>();
  if (!stored) {
    stored = await fetchKey(keyId);
    if (!stored) return null;
    await db
      .prepare("INSERT OR REPLACE INTO remote_keys (key_id, owner, pem, fetched_at) VALUES (?, ?, ?, ?)")
      .bind(keyId, stored.owner, stored.pem, Date.now())
      .run();
  }
  let key = imported.get(keyId);
  if (!key) {
    key = await crypto.subtle
      .importKey("spki", pemToDer(stored.pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])
      .catch(() => undefined);
    if (!key) return null;
    imported.set(keyId, key);
  }
  return { owner: stored.owner, key };
}

export async function verifySignature(db: D1Database, request: Request, body: string): Promise<string | null> {
  const header = request.headers.get("signature");
  if (!header) return null;
  const sig = parseSignature(header);
  if (!sig.keyid || !sig.signature) return null;
  if (sig.algorithm && !["rsa-sha256", "hs2019"].includes(sig.algorithm.toLowerCase())) return null;
  const signed = (sig.headers ?? "date").toLowerCase().split(/\s+/);
  // The body must be covered, and the request recent.
  if (!signed.includes("digest") || !signed.includes("(request-target)")) return null;
  const digest = request.headers.get("digest") ?? "";
  const sha = digest.split(",").map((d) => d.trim()).find((d) => d.toLowerCase().startsWith("sha-256="));
  if (!sha || sha.slice(8) !== (await sha256Base64(body))) return null;
  const date = Date.parse(request.headers.get("date") ?? "");
  if (!Number.isFinite(date) || Math.abs(Date.now() - date) > MAX_SKEW_MS) return null;
  const url = new URL(request.url);
  const lines: string[] = [];
  for (const name of signed) {
    if (name === "(request-target)") lines.push(`(request-target): ${request.method.toLowerCase()} ${url.pathname}${url.search}`);
    else {
      const value = request.headers.get(name);
      if (value === null) return null;
      lines.push(`${name}: ${value}`);
    }
  }
  const found = await keyFor(db, sig.keyid);
  if (!found) return null;
  const ok = await crypto.subtle
    .verify("RSASSA-PKCS1-v1_5", found.key, base64ToBytes(sig.signature), new TextEncoder().encode(lines.join("\n")))
    .catch(() => false);
  return ok ? found.owner : null;
}
