import { describe, expect, it } from "vitest";
import { createAccount, db, worker } from "./helpers.ts";

const SITE = "https://palm.test";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Runner socket", () => {
  it("keeps the socket alive with pings and tells the runner about new jobs once", async () => {
    const { addRunnerJobs, migrate, registerRunner } = await import("@palm/db");
    await migrate(db);
    const { runnerToken } = await registerRunner(db, { name: "socket", description: null });

    const res = await worker.fetch(`${SITE}/socket.io/?EIO=4&transport=websocket`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const got: string[] = [];
    ws.addEventListener("message", (m) => got.push(String(m.data)));
    ws.accept();
    ws.send(`40/runners,${JSON.stringify({ runnerToken })}`);
    await wait(300);

    const open = JSON.parse(got[0]!.slice(1)) as { pingInterval: number; pingTimeout: number };
    expect(open.pingInterval + open.pingTimeout).toBeLessThan(100_000);
    expect(got.some((m) => m.startsWith("40/runners,"))).toBe(true);
    const notices = () => got.filter((m) => m.includes("available-jobs")).length;
    expect(notices()).toBe(0);

    await wait(1300);
    expect(got).toContain("2");

    const owner = await createAccount("socket_owner", "pw-long-enough");
    const post = await db
      .prepare("INSERT INTO posts (account_id, content_source, content_html, visibility, created_at) VALUES (?, 'v', '<p>v</p>', 'public', 1) RETURNING id")
      .bind(owner)
      .first<{ id: number }>();
    await addRunnerJobs(db, post!.id, [{ type: "vod-hls-transcoding", resolution: 480, fps: 30 }]);
    await wait(1500);
    expect(notices()).toBe(1);
    await wait(1500);
    expect(notices()).toBe(1);
    ws.close();
  });

  it("refuses an unknown runner", async () => {
    const res = await worker.fetch(`${SITE}/socket.io/?EIO=4&transport=websocket`, { headers: { upgrade: "websocket" } });
    const ws = res.webSocket!;
    const got: string[] = [];
    ws.addEventListener("message", (m) => got.push(String(m.data)));
    ws.accept();
    ws.send(`40/runners,${JSON.stringify({ runnerToken: "ptrt-nope" })}`);
    await wait(300);
    expect(got.some((m) => m.startsWith("44/runners,"))).toBe(true);
    await wait(1200);
    expect(got).not.toContain("2");
    ws.close();
  });
});
