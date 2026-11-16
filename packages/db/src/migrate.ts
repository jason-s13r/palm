import { randomToken } from "@palm/auth";
import { MIGRATIONS, SCHEMA_VERSION, statementsOf } from "./migrations.ts";

/**
 * Brings the database up to this release's schema. The Worker awaits this
 * before serving, once per isolate: after the first check it costs nothing.
 *
 * Each migration runs as one D1 batch, which D1 applies as a transaction, and
 * records its version in the same batch. Statements are idempotent
 * (IF NOT EXISTS), so two isolates racing on a fresh database both succeed.
 */
const ready = new WeakMap<D1Database, Promise<void>>();

export function migrate(db: D1Database): Promise<void> {
  let pending = ready.get(db);
  if (!pending) {
    pending = run(db).catch((error: unknown) => {
      ready.delete(db); // let the next request try again
      throw error;
    });
    ready.set(db, pending);
  }
  return pending;
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
    await db.batch([
      ...statementsOf(migration).map((sql) => db.prepare(sql)),
      db
        .prepare("INSERT INTO palm_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .bind(String(migration.version)),
    ]);
  }
}

/**
 * The instance's signing secret for Lemmy JWTs, created on first use and kept
 * in D1, so a deployment has no secret to set up by hand.
 */
const secrets = new WeakMap<D1Database, Map<string, Promise<string>>>();

export function instanceSecret(db: D1Database, name: string): Promise<string> {
  let cache = secrets.get(db);
  if (!cache) secrets.set(db, (cache = new Map()));
  let secret = cache.get(name);
  if (!secret) {
    secret = loadSecret(db, name).catch((error: unknown) => {
      cache.delete(name);
      throw error;
    });
    cache.set(name, secret);
  }
  return secret;
}

async function loadSecret(db: D1Database, name: string): Promise<string> {
  const key = `secret:${name}`;
  await db.prepare("INSERT OR IGNORE INTO palm_meta (key, value) VALUES (?, ?)").bind(key, randomToken(32)).run();
  const row = await db.prepare("SELECT value FROM palm_meta WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) throw new Error(`Secret ${name} could not be created.`);
  return row.value;
}
