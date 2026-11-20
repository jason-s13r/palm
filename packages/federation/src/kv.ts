import type { KvKey, KvStore, KvStoreListEntry, KvStoreSetOptions } from "@fedify/fedify";
import { kvDelete, kvGet, kvList, kvSet } from "@palm/db";

/**
 * Fedify's key-value store on D1. Workers KV would be the obvious choice, but
 * its free plan allows 1,000 writes a day, and Fedify writes on every remote
 * key and document it caches. D1 allows 100,000.
 *
 * Fedify's cache of other servers' documents (actors, objects) stays in the
 * isolate's memory instead: it was most of the store's writes, and palm keeps
 * what it needs from those documents in its own tables (accounts, posts,
 * remote_keys) anyway. Everything else (keys, idempotence) goes to D1.
 */
const MEMORY_PREFIXES = new Set(["remoteDocument"]);
const MEMORY_LIMIT = 500;
const MEMORY_MAX_SECONDS = 60 * 60;

const inMemory = (key: KvKey) => key[0] === "_fedify" && MEMORY_PREFIXES.has(key[1] ?? "");

/** Entries by joined key, oldest first (a Map keeps insertion order). */
const memory = new Map<string, { value: unknown; expires: number }>();
const memoryKey = (key: KvKey) => key.join("\u001f");

export class D1KvStore implements KvStore {
  constructor(private readonly db: D1Database) {}

  async get<T = unknown>(key: KvKey): Promise<T | undefined> {
    if (inMemory(key)) {
      const entry = memory.get(memoryKey(key));
      if (!entry) return undefined;
      if (entry.expires <= Date.now()) {
        memory.delete(memoryKey(key));
        return undefined;
      }
      return entry.value as T;
    }
    return (await kvGet(this.db, key)) as T | undefined;
  }

  async set(key: KvKey, value: unknown, options?: KvStoreSetOptions): Promise<void> {
    const ttl = options?.ttl ? options.ttl.total({ unit: "seconds" }) : null;
    if (inMemory(key)) {
      const k = memoryKey(key);
      memory.delete(k);
      memory.set(k, { value, expires: Date.now() + Math.min(ttl ?? MEMORY_MAX_SECONDS, MEMORY_MAX_SECONDS) * 1000 });
      while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value!);
      return;
    }
    await kvSet(this.db, key, value, ttl);
  }

  async delete(key: KvKey): Promise<void> {
    if (inMemory(key)) {
      memory.delete(memoryKey(key));
      return;
    }
    await kvDelete(this.db, key);
  }

  async *list(prefix?: KvKey): AsyncIterable<KvStoreListEntry> {
    for (const entry of await kvList(this.db, prefix ?? [])) {
      yield { key: entry.key as unknown as KvKey, value: entry.value };
    }
  }
}
