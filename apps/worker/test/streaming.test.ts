import { describe, expect, it } from "vitest";
import { createAccount, MASTODON, mastodonToken, worker } from "./helpers.ts";

describe("Streaming", () => {
  it("streams new posts and notifications over a WebSocket", async () => {
    const id = await createAccount("listener", "pw");
    const friend = await createAccount("friend", "pw");
    const token = await mastodonToken(id);
    const friendToken = await mastodonToken(friend);
    const post = (t: string, body: unknown) =>
      worker.fetch(`${MASTODON}/api/v1/statuses`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    await worker.fetch(`${MASTODON}/api/v1/accounts/${friend}/follow`, { method: "POST", headers: { authorization: `Bearer ${token}` } });

    expect(await (await worker.fetch(`${MASTODON}/api/v1/streaming/health`)).text()).toBe("OK");
    const res = await worker.fetch(`${MASTODON}/api/v1/streaming?access_token=${token}&stream=user`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const events: { event: string; payload: string }[] = [];
    ws.addEventListener("message", (m) => events.push(JSON.parse(String(m.data)) as { event: string; payload: string }));

    await post(friendToken, { status: "streamed" });
    await post(friendToken, { status: "@listener hi" });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(events.some((e) => e.event === "update") && events.some((e) => e.event === "notification"))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const update = events.find((e) => e.event === "update");
    expect((JSON.parse(update!.payload) as { content: string }).content).toBe("<p>streamed</p>");
    expect(events.some((e) => e.event === "notification")).toBe(true);
    ws.close();
  });
});
