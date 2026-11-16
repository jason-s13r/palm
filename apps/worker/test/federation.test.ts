import { describe, expect, it } from "vitest";
import { createAccount, giveKeys, mastodonToken, worker } from "./helpers.ts";

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
      // Lemmy refuses an actor without one.
      outbox: "https://palm.test/users/hal/outbox",
    });
    expect((actor.publicKey as { publicKeyPem: string }).publicKeyPem).toContain("BEGIN PUBLIC KEY");
  });

  it("serves the outbox", async () => {
    await createAccount("ivy", "pw");
    const res = await worker.fetch(`${DOMAIN}/users/ivy/outbox`, AP);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ type: "OrderedCollection", totalItems: 0 });
  });

  it("returns 404 for an unknown actor", async () => {
    expect((await worker.fetch(`${DOMAIN}/users/nobody`, AP)).status).toBe(404);
    expect((await worker.fetch(`${DOMAIN}/.well-known/webfinger?resource=acct:nobody@palm.test`)).status).toBe(404);
  });

  it("answers nodeinfo as Lemmy, with palm's version as build metadata", async () => {
    const links = await (await worker.fetch(`${DOMAIN}/.well-known/nodeinfo`)).json<{ links: { href: string }[] }>();
    const info = await (await worker.fetch(links.links[0]!.href)).json<{ software: { name: string; version: string } }>();
    expect(info.software.name).toBe("lemmy");
    expect(info.software.version).toMatch(/^0\.19\.9\+palm\.\d+\.\d+\.\d+$/);
  });

  it("refuses unsigned inbox deliveries", async () => {
    const res = await worker.fetch(`${DOMAIN}/inbox`, {
      method: "POST",
      headers: { "content-type": "application/activity+json" },
      body: JSON.stringify({ type: "Follow", actor: "https://elsewhere.test/u/x", object: "https://palm.test/users/hal" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("serves both client APIs on the bare domain, and keeps nodeinfo as Lemmy", async () => {
    expect((await worker.fetch(`${DOMAIN}/api/v3/site`)).status).toBe(200);
    const instance = await (await worker.fetch(`${DOMAIN}/api/v2/instance`)).json<{ domain: string }>();
    expect(instance.domain).toBe("palm.test");
    expect((await worker.fetch(`${DOMAIN}/.well-known/oauth-authorization-server`)).status).toBe(200);
    const links = await (await worker.fetch(`${DOMAIN}/.well-known/nodeinfo`)).json<{ links: { href: string }[] }>();
    const nodeinfo = await (await worker.fetch(links.links[0]!.href)).json<{ software: { name: string } }>();
    expect(nodeinfo.software.name).toBe("lemmy");
  });

  it("gives accounts signed in on the bare domain a url there, so apps show @name@domain", async () => {
    const id = await createAccount("rua", "pw");
    const token = await mastodonToken(id);
    const me = await (
      await worker.fetch(`${DOMAIN}/api/v1/accounts/verify_credentials`, { headers: { authorization: `Bearer ${token}` } })
    ).json<{ url: string }>();
    expect(me.url).toBe("https://palm.test/@rua");
  });
});
