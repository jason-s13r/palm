// Tests go through the staging entry point (exports.default) rather than
// importing src/index.ts: importing it here makes the test runner ship Fedify
// to the test isolate a second time, over a channel with a 1 MB message limit.
import { describe, expect, it } from "vitest";
import { worker } from "./helpers.ts";

const version = async (host: string) =>
  (await worker.fetch(`https://${host}/_palm/version`)).json<{ software: string; version: string; surface: string | null; domain: string | null }>();

describe("routing", () => {
  it("reports its version on every host", async () => {
    for (const host of ["palm.test", "lemmy.palm.test", "mastodon.palm.test"]) {
      expect(await version(host)).toMatchObject({ software: "palm", domain: "palm.test" });
    }
  });

  it("names the surface for each host", async () => {
    expect((await version("palm.test")).surface).toBe("federation");
    expect((await version("lemmy.palm.test")).surface).toBe("lemmy");
    expect((await version("mastodon.palm.test")).surface).toBe("mastodon");
  });

  it("refuses hosts it does not serve", async () => {
    expect((await worker.fetch("https://elsewhere.test/")).status).toBe(421);
  });

  it("still reports its version on an unknown host, such as workers.dev", async () => {
    expect(await version("palm-staging.example.workers.dev")).toMatchObject({ software: "palm", surface: null, domain: null });
  });

  it("explains itself at the root of an API host", async () => {
    const res = await worker.fetch("https://lemmy.palm.test/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Lemmy API for palm.test");
  });

  it("sends browsers on the bare domain to the redirect target, keeping the path", async () => {
    const res = await worker.fetch("https://palm.test/some/page?x=1", { headers: { accept: "text/html" }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://site.example/some/page?x=1");
  });

  it("does not redirect ActivityPub requests", async () => {
    const res = await worker.fetch("https://palm.test/users/nobody", {
      headers: { accept: "application/activity+json, text/html" },
      redirect: "manual",
    });
    expect(res.status).toBe(404);
  });

  it("does not redirect inbox posts", async () => {
    const res = await worker.fetch("https://palm.test/inbox", { method: "POST", headers: { accept: "text/html" }, redirect: "manual" });
    expect(res.status).not.toBe(302);
  });

  it("serves the placeholder avatar on every host", async () => {
    const res = await worker.fetch("https://mastodon.palm.test/palm/avatar.png");
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("draws a pattern avatar for a seed, the same each time", async () => {
    const a = await worker.fetch("https://palm.test/palm/avatar/1a2b3c4d.png");
    expect(a.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await a.arrayBuffer());
    expect([...bytes.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    const again = new Uint8Array(await (await worker.fetch("https://palm.test/palm/avatar/1a2b3c4d.png")).arrayBuffer());
    expect(again).toEqual(bytes);
    const other = new Uint8Array(await (await worker.fetch("https://palm.test/palm/avatar/deadbeef.png")).arrayBuffer());
    expect(other).not.toEqual(bytes);
  });
});
