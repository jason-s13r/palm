/**
 * Quote permissions (Mastodon 4.5, FEP-044f). A post says who may quote it;
 * another server asks before quoting, and the author's server answers with an
 * approval (a QuoteAuthorization) that the quoting post then points to.
 */

/** Who may quote: anyone, the author's followers, or nobody but the author. */
export type QuotePolicy = "public" | "followers" | "nobody";
/** Where a quote's approval stands, as Mastodon shows it. */
export type QuoteState = "pending" | "accepted" | "rejected";

export const QUOTE_POLICIES: readonly QuotePolicy[] = ["public", "followers", "nobody"];
export const isQuotePolicy = (value: unknown): value is QuotePolicy => QUOTE_POLICIES.includes(value as QuotePolicy);

const now = () => Math.floor(Date.now() / 1000);

/** A post's own policy, or its author's default; private posts can't be quoted. */
export function effectiveQuotePolicy(post: { quotePolicy: QuotePolicy | null; visibility: string }, authorDefault: QuotePolicy): QuotePolicy {
  if (post.visibility !== "public" && post.visibility !== "unlisted") return "nobody";
  return post.quotePolicy ?? authorDefault;
}

export async function setPostQuotePolicy(db: D1Database, postId: number, policy: QuotePolicy | null): Promise<void> {
  await db.prepare("UPDATE posts SET quote_policy = ? WHERE id = ?").bind(policy, postId).run();
}

export async function setAccountQuotePolicy(db: D1Database, accountId: number, policy: QuotePolicy): Promise<void> {
  await db.prepare("UPDATE accounts SET quote_policy = ? WHERE id = ?").bind(policy, accountId).run();
}

/** Where this post's own quote stands, and the approval when it has one. */
export async function setQuoteState(db: D1Database, postId: number, state: QuoteState, authorization: string | null = null): Promise<void> {
  await db.prepare("UPDATE posts SET quote_state = ?, quote_authorization = ? WHERE id = ?").bind(state, authorization, postId).run();
}

/** Records an approval for `quotingId` to quote a local post; the same pair gets the same approval. */
export async function authorizeQuote(db: D1Database, postId: number, quotingId: string, actorId: string): Promise<number> {
  await db
    .prepare("INSERT INTO quote_authorizations (post_id, quoting_id, actor_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (post_id, quoting_id) DO UPDATE SET revoked_at = NULL")
    .bind(postId, quotingId, actorId, now())
    .run();
  const row = await db.prepare("SELECT id FROM quote_authorizations WHERE post_id = ? AND quoting_id = ?").bind(postId, quotingId).first<{ id: number }>();
  return row!.id;
}

export interface QuoteAuthorizationRow {
  id: number;
  postId: number;
  quotingId: string;
  actorId: string;
}

export async function quoteAuthorization(db: D1Database, id: number): Promise<QuoteAuthorizationRow | null> {
  const row = await db
    .prepare("SELECT id, post_id, quoting_id, actor_id FROM quote_authorizations WHERE id = ? AND revoked_at IS NULL")
    .bind(id)
    .first<{ id: number; post_id: number; quoting_id: string; actor_id: string }>();
  return row ? { id: row.id, postId: row.post_id, quotingId: row.quoting_id, actorId: row.actor_id } : null;
}

/** A local post quoting a remote one, found by the quoted post's ID, waiting on approval. */
export async function pendingQuoteOf(db: D1Database, quotingPostId: number): Promise<{ id: number; quoteOf: string } | null> {
  const row = await db
    .prepare("SELECT id, quote_of FROM posts WHERE id = ? AND quote_of IS NOT NULL AND deleted_at IS NULL")
    .bind(quotingPostId)
    .first<{ id: number; quote_of: string }>();
  return row ? { id: row.id, quoteOf: row.quote_of } : null;
}

/** Whether a remote actor may quote an author's post under `policy`: blocks and followers-only count. */
export async function mayQuote(db: D1Database, authorId: number, actorId: string, policy: QuotePolicy): Promise<boolean> {
  if (policy === "nobody") return false;
  const host = new URL(actorId).host.toLowerCase();
  const row = await db
    .prepare(
      `SELECT
         EXISTS (SELECT 1 FROM account_blocks b JOIN accounts a ON a.id = b.target_id WHERE b.account_id = ?1 AND a.ap_id = ?2) AS blocked,
         EXISTS (SELECT 1 FROM user_domain_blocks WHERE account_id = ?1 AND domain = ?3) AS domain_blocked,
         EXISTS (SELECT 1 FROM followers WHERE account_id = ?1 AND actor_id = ?2 AND pending = 0) AS follower`,
    )
    .bind(authorId, actorId, host)
    .first<{ blocked: number; domain_blocked: number; follower: number }>();
  if (!row || row.blocked || row.domain_blocked) return false;
  return policy === "public" || row.follower === 1;
}
