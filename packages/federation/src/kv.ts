import type { KvKey, KvStore, KvStoreListEntry, KvStoreSetOptions } from "@fedify/fedify";
import { kvDelete, kvGet, kvList, kvSet } from "@palm/db";

/**
 * Fedify's key-value store on D1. Workers KV would be the obvious choice, but
 * its free plan allows 1,000 writes a day, and Fedify writes on every remote
 * key and document it caches. D1 allows 100,000.
 */
export class D1KvStore implements KvStore {
  constructor(private readonly db: D1Database) {}

  async get<T = unknown>(key: KvKey): Promise<T | undefined> {
    return (await kvGet(this.db, key)) as T | undefined;
  }

  async set(key: KvKey, value: unknown, options?: KvStoreSetOptions): Promise<void> {
    const ttl = options?.ttl ? options.ttl.total({ unit: "seconds" }) : null;
    await kvSet(this.db, key, value, ttl);
  }

  async delete(key: KvKey): Promise<void> {
    await kvDelete(this.db, key);
  }

  async *list(prefix?: KvKey): AsyncIterable<KvStoreListEntry> {
    for (const entry of await kvList(this.db, prefix ?? [])) {
      yield { key: entry.key as unknown as KvKey, value: entry.value };
    }
  }
}
