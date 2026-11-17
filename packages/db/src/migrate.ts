import { randomToken } from "@palm/auth";
import { MIGRATIONS, SCHEMA_VERSION, statementsOf } from "./migrations.ts";

/**
 * Brings the database up to this release's schema. The Worker awaits this
 * before serving, once per isolate: after the first check it costs nothing.
 *
 * Each migration runs as one D1 batch, which D1 applies as a transaction, and
 * records its version in the same batch. Statements are idempotent
 * (IF NOT EXISTS) where SQLite allows; a racing isolate that loses on a
 * column added by the other finds the version recorded and carries on.
 *
 * Only the outcome is kept between requests, not a pending promise: a
 * promise is tied to the request that started it, and fails in another
 * request when the first one ends (an app cancelling it, say) before it
 * settles. Requests that arrive together each check, which is harmless.
 */
const ready = new WeakSet<D1Database>();

export async function migrate(db: D1Database): Promise<void> {
  if (ready.has(db)) return;
  await run(db);
  ready.add(db);
}

async function currentVersion(db: D1Database): Promise<number> {
  try {
    const row = await db.prepare("SELECT value FROM palm_meta WHERE key = 'schema_version'").first<{ value: string }>();
    return row ? Number(row.value) : 0;
  } catch {
    return 0; // palm_meta doesn't exist yet
  }
}

async function run(db: D1Database): Promise<void> {
  const version = await currentVersion(db);
  if (version >= SCHEMA_VERSION) return;
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    try {
      await db.batch([
        ...statementsOf(migration).map((sql) => db.prepare(sql)),
        db
          .prepare("INSERT INTO palm_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
          .bind(String(migration.version)),
      ]);
    } catch (error) {
      // ALTER TABLE ADD COLUMN can't say IF NOT EXISTS: when two isolates
      // race, the second fails. That's fine if the first got there.
      if ((await currentVersion(db)) < migration.version) throw error;
    }
  }
}

/**
 * The instance's signing secret for Lemmy JWTs, created on first use and kept
 * in D1, so a deployment has no secret to set up by hand.
 */
const secrets = new WeakMap<D1Database, Map<string, string>>();

export async function instanceSecret(db: D1Database, name: string): Promise<string> {
  let cache = secrets.get(db);
  if (!cache) secrets.set(db, (cache = new Map()));
  // The value, not a pending promise, is shared between requests (see migrate).
  const known = cache.get(name);
  if (known) return known;
  const secret = await loadSecret(db, name);
  cache.set(name, secret);
  return secret;
}

async function loadSecret(db: D1Database, name: string): Promise<string> {
  const key = `secret:${name}`;
  await db.prepare("INSERT OR IGNORE INTO palm_meta (key, value) VALUES (?, ?)").bind(key, randomToken(32)).run();
  const row = await db.prepare("SELECT value FROM palm_meta WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) throw new Error(`Secret ${name} could not be created.`);
  return row.value;
}
