import { describe, expect, it } from "vitest";
import { createPalm, handle, VERSION } from "../src/index.ts";

import { db, worker } from "./helpers.ts";

const env = { DB: db };
const executionCtx = { waitUntil: () => {} };

describe("staging entry point", () => {
  it("reports its version on every host", async () => {
    for (const host of ["palm.test", "lemmy.palm.test", "mastodon.palm.test"]) {
      const res = await worker.fetch(`https://${host}/_palm/version`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ software: "palm", version: VERSION, domain: "palm.test" });
    }
  });

  it("names the surface for each host", async () => {
    const surface = async (host: string) =>
      ((await (await worker.fetch(`https://${host}/_palm/version`)).json()) as { surface: string }).surface;
    expect(await surface("palm.test")).toBe("federation");
    expect(await surface("lemmy.palm.test")).toBe("lemmy");
    expect(await surface("mastodon.palm.test")).toBe("mastodon");
  });

  it("refuses hosts it does not serve", async () => {
    const res = await worker.fetch("https://elsewhere.test/");
    expect(res.status).toBe(421);
  });

  it("still reports its version on an unknown host, such as workers.dev", async () => {
    const res = await worker.fetch("https://palm-staging.example.workers.dev/_palm/version");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ software: "palm", version: VERSION, surface: null, domain: null });
  });

  it("explains itself at the root of an API host", async () => {
    const res = await worker.fetch("https://lemmy.palm.test/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Lemmy API for palm.test");
  });
});

describe("handle", () => {
  const config = {
    domains: [{ domain: "1j.example", hosts: { lemmy: "lemmy.1j.example" } }],
    instance: { name: "Test" },
    browserRedirect: "https://site.example",
  };

  it("sends browsers on the bare domain to the redirect target, keeping the path", async () => {
    const res = await handle(config, new Request("https://1j.example/some/page?x=1", { headers: { accept: "text/html" } }), env, executionCtx);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://site.example/some/page?x=1");
  });

  it("does not redirect ActivityPub requests", async () => {
    const res = await handle(config, new Request("https://1j.example/users/jason", { headers: { accept: "application/activity+json, text/html" } }), env, executionCtx);
    expect(res.status).toBe(404);
  });

  it("does not redirect non-GET requests", async () => {
    const res = await handle(config, new Request("https://1j.example/inbox", { method: "POST", headers: { accept: "text/html" } }), env, executionCtx);
    expect(res.status).not.toBe(302);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("checks a static config when the Worker is created", () => {
    expect(() => createPalm({ domains: [], instance: { name: "x" } })).toThrow(/At least one domain/);
  });
});
