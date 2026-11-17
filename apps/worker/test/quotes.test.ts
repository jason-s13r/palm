import { describe, expect, it } from "vitest";
import { createAccount, giveKeys, MASTODON, mastodonToken, worker } from "./helpers.ts";

async function user(username: string) {
  const id = await createAccount(username, "pw");
  await giveKeys(id);
  const auth = { authorization: `Bearer ${await mastodonToken(id)}`, "content-type": "application/json" };
  const call = (method: string, path: string, body?: unknown) =>
    worker.fetch(`${MASTODON}${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { id, get: (p: string) => call("GET", p), post: (p: string, b: unknown = {}) => call("POST", p, b), put: (p: string, b: unknown) => call("PUT", p, b) };
}

type Status = {
  id: string;
  uri: string;
  quote: { state: string; quoted_status: { id: string } | null } | null;
  quote_approval: { automatic: string[]; current_user: string };
};

describe("Quote permissions", () => {
  it("keeps who may quote a status, and approves or refuses quotes here", async () => {
    const amy = await user("q_amy");
    const bob = await user("q_bob");

    const open = await (await amy.post("/api/v1/statuses", { status: "quote me" })).json<Status>();
    expect(open.quote_approval).toMatchObject({ automatic: ["public"], current_user: "automatic" });
    const closed = await (await amy.post("/api/v1/statuses", { status: "followers only quotes", quote_approval_policy: "followers" })).json<Status>();
    expect((await (await bob.get(`/api/v1/statuses/${closed.id}`)).json<Status>()).quote_approval).toMatchObject({
      automatic: ["followers"],
      current_user: "denied",
    });

    // Other servers see the policy on the Note.
    const note = await (await worker.fetch(closed.uri, { headers: { accept: "application/activity+json" } })).json<{ interactionPolicy: { canQuote: { automaticApproval: unknown } } }>();
    expect([note.interactionPolicy.canQuote.automaticApproval].flat()).toContain("https://palm.test/users/q_amy/followers");

    // Allowed: approved at once, with an approval other servers can read.
    const quoting = await (await bob.post("/api/v1/statuses", { status: "quoting", quoted_status_id: open.id })).json<Status>();
    expect(quoting.quote).toMatchObject({ state: "accepted", quoted_status: { id: open.id } });
    const quotingNote = await (await worker.fetch(quoting.uri, { headers: { accept: "application/activity+json" } })).json<{ quote: string; quoteAuthorization: string }>();
    expect(quotingNote.quote).toBe(open.uri);
    const approval = await (await worker.fetch(quotingNote.quoteAuthorization, { headers: { accept: "application/activity+json" } })).json<{
      type: string;
      interactingObject: string;
      interactionTarget: string;
    }>();
    expect(approval).toMatchObject({ type: "QuoteAuthorization", interactingObject: quoting.uri, interactionTarget: open.uri });

    // Not allowed: refused.
    const refused = await (await bob.post("/api/v1/statuses", { status: "quoting anyway", quoted_status_id: closed.id })).json<Status>();
    expect(refused.quote?.state).toBe("rejected");

    // The author changes their mind.
    const changed = await (await amy.put(`/api/v1/statuses/${open.id}/interaction_policy`, { quote_approval_policy: "nobody" })).json<Status>();
    expect(changed.quote_approval.automatic).toEqual([]);
    expect((await amy.put(`/api/v1/statuses/${open.id}/interaction_policy`, { quote_approval_policy: "everyone" })).status).toBe(422);
  });

  it("keeps an account's default for new posts", async () => {
    const cat = await user("q_cat");
    const res = await worker.fetch(`${MASTODON}/api/v1/accounts/update_credentials`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${await mastodonToken(cat.id)}`, "content-type": "application/json" },
      body: JSON.stringify({ source: { quote_policy: "followers" } }),
    });
    expect((await res.json<{ source: { quote_policy: string } }>()).source.quote_policy).toBe("followers");
    const status = await (await cat.post("/api/v1/statuses", { status: "default applies" })).json<Status>();
    expect(status.quote_approval.automatic).toEqual(["followers"]);
  });
});
