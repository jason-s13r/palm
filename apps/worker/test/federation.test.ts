import { describe, expect, it } from "vitest";
import { createAccount, giveKeys, json, worker } from "./helpers.ts";

const DOMAIN = "https://palm.test";
const AP = { headers: { accept: "application/activity+json" } };

describe("federation", () => {
  it("resolves a handle through WebFinger", async () => {
    await createAccount("gus", "pw");
    const res = await worker.fetch(`${DOMAIN}/.well-known/webfinger?resource=acct:gus@palm.test`);
    expect(res.status).toBe(200);
    const body = await res.json<{ subject: string; links: { rel: string; href?: string }[] }>();
    expect(body.subject).toBe("acct:gus@palm.test");
    expect(body.links.find((l) => l.rel === "self")?.href).toBe("https://palm.test/users/gus");
  });

  it("serves the actor with its public key and inboxes", async () => {
    const id = await createAccount("hal", "pw");
    await giveKeys(id);
    const res = await worker.fetch(`${DOMAIN}/users/hal`, AP);
    expect(res.status).toBe(200);
    const actor = await res.json<Record<string, unknown>>();
    expect(actor).toMatchObject({
      id: "https://palm.test/users/hal",
      type: "Person",
      preferredUsername: "hal",
      inbox: "https://palm.test/users/hal/inbox",
      endpoints: { sharedInbox: "https://palm.test/inbox" },
    });
    expect((actor.publicKey as { publicKeyPem: string }).publicKeyPem).toContain("BEGIN PUBLIC KEY");
  });

  it("returns 404 for an unknown actor", async () => {
    expect((await worker.fetch(`${DOMAIN}/users/nobody`, AP)).status).toBe(404);
    expect((await worker.fetch(`${DOMAIN}/.well-known/webfinger?resource=acct:nobody@palm.test`)).status).toBe(404);
  });

  it("reports itself as palm in nodeinfo", async () => {
    const links = await (await worker.fetch(`${DOMAIN}/.well-known/nodeinfo`)).json<{ links: { href: string }[] }>();
    const info = await (await worker.fetch(links.links[0]!.href)).json<{ software: { name: string } }>();
    expect(info.software.name).toBe("palm");
  });

  it("refuses unsigned inbox deliveries", async () => {
    const res = await worker.fetch(`${DOMAIN}/inbox`, {
      method: "POST",
      headers: { "content-type": "application/activity+json" },
      body: JSON.stringify({ type: "Follow", actor: "https://elsewhere.test/u/x", object: "https://palm.test/users/hal" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("serves both client APIs on the bare domain too", async () => {
    await createAccount("ida", "pw-ida");
    expect((await worker.fetch(`${DOMAIN}/api/v3/user/login`, json({ username_or_email: "ida", password: "pw-ida" }))).status).toBe(200);
    expect((await (await worker.fetch(`${DOMAIN}/api/v2/instance`)).json<{ domain: string }>()).domain).toBe("palm.test");
  });
});
