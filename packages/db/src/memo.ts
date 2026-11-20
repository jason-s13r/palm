/**
 * Counts that are the same for everyone and change slowly (nodeinfo, site
 * statistics, the servers palm knows), worked out at most once per `ttl`
 * seconds per key. Crawlers ask for these hundreds of times a day, and each
 * count reads thousands of rows; a kept copy is one row in palm_meta.
 *
 * The copy lives in the isolate's memory and in palm_meta, so a fresh isolate
 * reads one row rather than counting again. Only finished values are kept
 * between requests (see migrate).
 */
const memory = new WeakMap<D1Database, Map<string, { value: unknown; until: number }>>();

export async function memoized<T>(db: D1Database, key: string, ttl: number, compute: () => Promise<T>): Promise<T> {
  let local = memory.get(db);
  if (!local) memory.set(db, (local = new Map()));
  const nowMs = Date.now();
  const held = local.get(key);
  if (held && held.until > nowMs) return held.value as T;
  const metaKey = `memo:${key}`;
  const row = await db
    .prepare("SELECT value FROM palm_meta WHERE key = ?")
    .bind(metaKey)
    .first<{ value: string }>()
    .catch(() => null);
  if (row) {
    try {
      const stored = JSON.parse(row.value) as { until: number; value: T };
      if (stored.until > nowMs) {
        local.set(key, stored);
        return stored.value;
      }
    } catch {
      // Unreadable: counted again below.
    }
  }
  const value = await compute();
  const stored = { until: nowMs + ttl * 1000, value };
  local.set(key, stored);
  await db
    .prepare("INSERT INTO palm_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(metaKey, JSON.stringify(stored))
    .run()
    .catch(() => undefined);
  return value;
}
