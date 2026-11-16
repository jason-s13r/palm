export interface Account {
  id: number;
  domain: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  role: "user" | "admin";
  createdAt: number;
}

interface AccountRow {
  id: number;
  domain: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  password_hash: string | null;
  role: "user" | "admin";
  created_at: number;
}

const COLUMNS = "id, domain, username, display_name, bio, password_hash, role, created_at";

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    domain: row.domain,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    role: row.role,
    createdAt: row.created_at,
  };
}

export async function accountById(db: D1Database, id: number): Promise<Account | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`).bind(id).first<AccountRow>();
  return row ? toAccount(row) : null;
}

/** An account and its password hash, for login. Usernames match case-insensitively. */
export async function accountForLogin(
  db: D1Database,
  domain: string,
  username: string,
): Promise<{ account: Account; passwordHash: string | null } | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM accounts WHERE domain = ? AND username = ?`)
    .bind(domain, username)
    .first<AccountRow>();
  return row ? { account: toAccount(row), passwordHash: row.password_hash } : null;
}

export async function setPasswordHash(db: D1Database, id: number, passwordHash: string): Promise<void> {
  await db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?").bind(passwordHash, id).run();
}

export async function countAccounts(db: D1Database, domain: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE domain = ?").bind(domain).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function admins(db: D1Database, domain: string): Promise<Account[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM accounts WHERE domain = ? AND role = 'admin' ORDER BY id`)
    .bind(domain)
    .all<AccountRow>();
  return results.map(toAccount);
}
