import type { KvKey } from "@fedify/fedify";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { D1KvStore } from "../src/kv.ts";

/** Just enough of D1 for the fedify_kv queries. */
function fakeD1() {
  const rows = new Map<string, { value: string; expires_at: number | null }>();
  const writes: { key: string; ttl: number | null }[] = [];
  const now = () => Math.floor(Date.now() / 1000);
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              const row = rows.get(args[0] as string);
              return row ?? null;
            },
            async run() {
              if (sql.startsWith("INSERT INTO fedify_kv")) {
                const [key, value, expires] = args as [string, string, number | null];
                rows.set(key, { value, expires_at: expires });
                writes.push({ key, ttl: expires === null ? null : expires - now() });
              } else if (sql.startsWith("DELETE FROM fedify_kv WHERE key")) rows.delete(args[0] as string);
              return {};
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, rows, writes };
}

const doc = (document: Record<string, unknown>) => ({ contextUrl: null, documentUrl: document.id, document });
const fiveMinutes = { ttl: Temporal.Duration.from({ minutes: 5 }) };

describe("D1KvStore", () => {
  it("keeps other servers' objects in memory, not D1", async () => {
    const { db, writes } = fakeD1();
    const kv = new D1KvStore(db);
    const key: KvKey = ["_fedify", "remoteDocument", "https://remote.test/post/1"];
    const value = doc({ id: "https://remote.test/post/1", type: "Page" });
    await kv.set(key, value, fiveMinutes);
    expect(writes).toEqual([]);
    expect(await kv.get(key)).toEqual(value);
  });

  it("keeps actors with keys in D1 for a day, for signature checks in other isolates", async () => {
    const { db, writes, rows } = fakeD1();
    const kv = new D1KvStore(db);
    const key: KvKey = ["_fedify", "remoteDocument", "https://remote.test/c/piracy"];
    const value = doc({ id: "https://remote.test/c/piracy", type: "Group", publicKey: { id: "https://remote.test/c/piracy#main-key" } });
    await kv.set(key, value, fiveMinutes);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.ttl).toBeGreaterThanOrEqual(24 * 60 * 60 - 1);
    // Another isolate, which never saw it, reads it from D1.
    const other: KvKey = ["_fedify", "remoteDocument", "https://remote.test/u/someone"];
    const actor = doc({ id: "https://remote.test/u/someone", type: "Person", publicKey: {} });
    rows.set(other.join("\u001f"), { value: JSON.stringify(actor), expires_at: Math.floor(Date.now() / 1000) + 3600 });
    expect(await kv.get(other)).toEqual(actor);
  });

  it("leaves Fedify's other keys in D1", async () => {
    const { db, writes } = fakeD1();
    const kv = new D1KvStore(db);
    await kv.set(["_fedify", "activityIdempotence", "x"], true, fiveMinutes);
    expect(writes.map((w) => w.key)).toEqual(["_fedify\u001factivityIdempotence\u001fx"]);
  });
});
