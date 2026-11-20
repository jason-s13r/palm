import type { KvKey, KvStore, KvStoreListEntry, KvStoreSetOptions } from "@fedify/fedify";
import { kvDelete, kvGet, kvList, kvSet } from "@palm/db";

/**
 * Fedify's key-value store on D1. Workers KV would be the obvious choice, but
 * its free plan allows 1,000 writes a day, and Fedify writes on every remote
 * key and document it caches. D1 allows 100,000.
 *
 * Fedify caches other servers' documents for five minutes, so nearly every
 * copy it wrote to D1 expired unread. Those stay in the isolate's memory now,
 * except actors: Fedify fetches the actor behind a delivery's signing key to
 * check the key is theirs, every time its copy has expired, which costs a
 * round trip to the sender and parsing their actor again (about 800 ms and
 * tens of milliseconds of CPU for a Lemmy community). Actors are kept for a
 * day, in memory and in D1, so a fresh isolate finds them too.
 */
const DOCUMENTS = "remoteDocument";
const MEMORY_LIMIT = 500;
const DOCUMENT_MAX_SECONDS = 60 * 60;
const ACTOR_SECONDS = 24 * 60 * 60;
const ACTOR_TYPES = new Set(["Person", "Group", "Service", "Application", "Organization"]);

const isDocument = (key: KvKey) => key[0] === "_fedify" && key[1] === DOCUMENTS;

/** A cached document that is an actor with a key: what checking a signature needs. */
function isActor(value: unknown): boolean {
  const doc = (value as { document?: Record<string, unknown> } | null)?.document;
  if (!doc || typeof doc !== "object") return false;
  const type = Array.isArray(doc.type) ? doc.type[0] : doc.type;
  return typeof type === "string" && ACTOR_TYPES.has(type) && doc.publicKey != null;
}

/** Entries by joined key, oldest first (a Map keeps insertion order). */
const memory = new Map<string, { value: unknown; expires: number }>();
const memoryKey = (key: KvKey) => key.join("\u001f");

function remember(key: KvKey, value: unknown, seconds: number): void {
  const k = memoryKey(key);
  memory.delete(k);
  memory.set(k, { value, expires: Date.now() + seconds * 1000 });
  while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value!);
}

function recall(key: KvKey): unknown {
  const k = memoryKey(key);
  const entry = memory.get(k);
  if (!entry) return undefined;
  if (entry.expires > Date.now()) return entry.value;
  memory.delete(k);
  return undefined;
}

export class D1KvStore implements KvStore {
  constructor(private readonly db: D1Database) {}

  async get<T = unknown>(key: KvKey): Promise<T | undefined> {
    if (!isDocument(key)) return (await kvGet(this.db, key)) as T | undefined;
    const held = recall(key);
    if (held !== undefined) return held as T;
    // An actor another isolate kept: one row, instead of a fetch.
    const stored = await kvGet(this.db, key);
    if (stored !== undefined) remember(key, stored, DOCUMENT_MAX_SECONDS);
    return stored as T | undefined;
  }

  async set(key: KvKey, value: unknown, options?: KvStoreSetOptions): Promise<void> {
    const ttl = options?.ttl ? options.ttl.total({ unit: "seconds" }) : null;
    if (!isDocument(key)) return kvSet(this.db, key, value, ttl);
    if (isActor(value)) {
      remember(key, value, ACTOR_SECONDS);
      await kvSet(this.db, key, value, ACTOR_SECONDS);
      return;
    }
    remember(key, value, Math.min(ttl ?? DOCUMENT_MAX_SECONDS, DOCUMENT_MAX_SECONDS));
  }

  async delete(key: KvKey): Promise<void> {
    if (isDocument(key)) memory.delete(memoryKey(key));
    await kvDelete(this.db, key);
  }

  async *list(prefix?: KvKey): AsyncIterable<KvStoreListEntry> {
    for (const entry of await kvList(this.db, prefix ?? [])) {
      yield { key: entry.key as unknown as KvKey, value: entry.value };
    }
  }
}
