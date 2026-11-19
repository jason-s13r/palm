import { describe, expect, it } from "vitest";
import { createAccount, db, MASTODON, mastodonToken, worker } from "./helpers.ts";

const SITE = "https://palm.test";

async function signedIn(username: string) {
  const id = await createAccount(username, "pw");
  const auth = { authorization: `Bearer ${await mastodonToken(id)}`, "content-type": "application/json" };
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    worker.fetch(`${MASTODON}${path}`, { method: "POST", headers: { ...auth, ...headers }, body: JSON.stringify(body) });
  return { id, post };
}

describe("Retries", () => {
  it("posts a status once for one Idempotency-Key", async () => {
    const me = await signedIn("idem_poster");
    const send = () => me.post("/api/v1/statuses", { status: "only once" }, { "idempotency-key": "key-1" });
    const first = await (await send()).json<{ id: string }>();
    const again = await (await send()).json<{ id: string }>();
    expect(again.id).toBe(first.id);
    const other = await (await me.post("/api/v1/statuses", { status: "only once" }, { "idempotency-key": "key-2" })).json<{ id: string }>();
    expect(other.id).not.toBe(first.id);
    const row = await db.prepare("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND deleted_at IS NULL").bind(me.id).first<{ n: number }>();
    expect(row?.n).toBe(2);
  });

  it("notifies once when the same favourite or follow happens again", async () => {
    const author = await signedIn("idem_author");
    const fan = await signedIn("idem_fan");
    const status = await (await author.post("/api/v1/statuses", { status: "like me" })).json<{ id: string }>();
    for (const action of ["favourite", "unfavourite", "favourite"]) await fan.post(`/api/v1/statuses/${status.id}/${action}`);
    for (const action of ["follow", "unfollow", "follow"]) await fan.post(`/api/v1/accounts/${author.id}/${action}`);
    // The follow-up work runs as queue jobs; give them a moment.
    await new Promise((r) => setTimeout(r, 1500));
    const { results } = await db
      .prepare("SELECT kind FROM notifications WHERE account_id = ? AND from_account_id = ? ORDER BY kind")
      .bind(author.id, fan.id)
      .all<{ kind: string }>();
    expect(results.map((r) => r.kind)).toEqual(["favourite", "follow"]);
  });

  it("answers another server's interaction link instead of sending it to the configured site", async () => {
    const page = await worker.fetch(`${SITE}/authorize_interaction?uri=${encodeURIComponent("https://mastodon.social/@Iloro")}`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("https://mastodon.social/@Iloro");
    const follow = await worker.fetch(`${SITE}/authorize_follow?acct=someone@elsewhere.test`, { headers: { accept: "text/html" }, redirect: "manual" });
    expect(await follow.text()).toContain("@someone@elsewhere.test");
  });
});
