import { describe, expect, it } from "vitest";
import { createAccount, db, MASTODON, mastodonToken, worker } from "./helpers.ts";

async function user(username: string) {
  const id = await createAccount(username, "pw");
  const auth = { authorization: `Bearer ${await mastodonToken(id)}` };
  const call = (method: string, path: string, body?: unknown) =>
    worker.fetch(`${MASTODON}${path}`, {
      method,
      headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { id, call };
}

type Poll = { id: string; votes_count: number; voters_count: number; voted: boolean; own_votes: number[]; options: { title: string; votes_count: number }[] };

describe("Polls, edit history, scheduled posts and quotes", () => {
  it("runs a poll", async () => {
    const asker = await user("asker");
    const voter = await user("voter");
    const status = await (await asker.call("POST", "/api/v1/statuses", { status: "Tea or coffee?", poll: { options: ["Tea", "Coffee"], expires_in: 3600 } })).json<{ id: string; poll: Poll }>();
    expect(status.poll.options.map((o) => o.title)).toEqual(["Tea", "Coffee"]);
    const voted = await (await voter.call("POST", `/api/v1/polls/${status.poll.id}/votes`, { choices: ["0"] })).json<Poll>();
    expect(voted).toMatchObject({ votes_count: 1, voters_count: 1, voted: true, own_votes: [0] });
    expect((await voter.call("POST", `/api/v1/polls/${status.poll.id}/votes`, { choices: ["1"] })).status).toBe(422);
    // The poll federates as a Question.
    const object = await (await worker.fetch(`https://palm.test/objects/${status.id}`, { headers: { accept: "application/activity+json" } })).json<{ type: string; oneOf: { name: string }[] }>();
    expect(object.type).toBe("Question");
    expect(object.oneOf.map((o) => o.name)).toEqual(["Tea", "Coffee"]);
  });

  it("keeps edit history and quotes", async () => {
    const writer = await user("editor");
    const first = await (await writer.call("POST", "/api/v1/statuses", { status: "first draft" })).json<{ id: string }>();
    await writer.call("PUT", `/api/v1/statuses/${first.id}`, { status: "second draft" });
    const history = await (await writer.call("GET", `/api/v1/statuses/${first.id}/history`)).json<{ content: string }[]>();
    expect(history.map((h) => h.content)).toEqual(["<p>first draft</p>", "<p>second draft</p>"]);

    const quoting = await (await writer.call("POST", "/api/v1/statuses", { status: "look", quoted_status_id: first.id })).json<{ quote: { quoted_status: { id: string } | null } | null }>();
    expect(quoting.quote?.quoted_status?.id).toBe(first.id);
  });

  it("schedules a post and publishes it when it's due", async () => {
    const planner = await user("planner");
    const at = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const scheduled = await (await planner.call("POST", "/api/v1/statuses", { status: "later", scheduled_at: at })).json<{ id: string; params: { text: string } }>();
    expect(scheduled.params.text).toBe("later");
    expect((await (await planner.call("GET", "/api/v1/scheduled_statuses")).json<unknown[]>()).length).toBe(1);
    // Bring it due, then run the cron.
    await db.prepare("UPDATE scheduled_statuses SET scheduled_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000) - 1, Number(scheduled.id)).run();
    await (worker as unknown as { scheduled(o: { cron: string; scheduledTime: number }): Promise<unknown> }).scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() });
    expect(await (await planner.call("GET", "/api/v1/scheduled_statuses")).json()).toEqual([]);
    const mine = await (await planner.call("GET", `/api/v1/accounts/${planner.id}/statuses`)).json<{ content: string }[]>();
    expect(mine.map((s) => s.content)).toContain("<p>later</p>");
  });
});
