import { describe, expect, it } from "vitest";
import { createAccount, db, giveKeys, mastodonToken, worker } from "./helpers.ts";

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
    const id = await createAccount("unsigned", "pw");
    const res = await worker.fetch(`${DOMAIN}/inbox`, {
      method: "POST",
      headers: { "content-type": "application/activity+json" },
      body: JSON.stringify({ type: "Follow", actor: "https://elsewhere.test/u/x", object: "https://palm.test/users/unsigned" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const followers = await db.prepare("SELECT COUNT(*) AS n FROM followers WHERE account_id = ?").bind(id).first<{ n: number }>();
    expect(followers?.n).toBe(0);
  });

  it("drops votes and deletes about things palm doesn't hold before checking them", async () => {
    const post = (activity: object) =>
      worker.fetch(`${DOMAIN}/inbox`, {
        method: "POST",
        headers: { "content-type": "application/activity+json" },
        body: JSON.stringify(activity),
      });
    const like = { type: "Like", actor: "https://elsewhere.test/u/x", object: "https://elsewhere.test/post/1" };
    // A community relaying a vote on a post nobody here has.
    expect((await post({ type: "Announce", actor: "https://elsewhere.test/c/x", object: like })).status).toBe(202);
    expect((await post({ type: "Undo", actor: "https://elsewhere.test/u/x", object: like })).status).toBe(202);
    expect((await post({ type: "Delete", actor: "https://elsewhere.test/u/y", object: "https://elsewhere.test/u/y" })).status).toBe(202);
    // A community nobody here subscribes to anymore: whatever it relays.
    await db
      .prepare("INSERT INTO communities (domain, name, title, created_at, ap_id) VALUES ('gone.test', 'old', 'old', 0, 'https://gone.test/c/old')")
      .run();
    const create = { type: "Create", actor: "https://gone.test/u/z", object: { type: "Page", id: "https://gone.test/post/9", name: "hi" } };
    expect((await post({ type: "Announce", actor: "https://gone.test/c/old", object: create })).status).toBe(202);
    // A vote on a local post still goes through the signature check.
    expect((await post({ ...like, object: "https://palm.test/objects/1" })).status).toBeGreaterThanOrEqual(400);
  });

  it("counts a community's relayed vote on a remote post without Fedify, once its signature checks out", async () => {
    const author = await createAccount("votee", "pw");
    const target = "https://elsewhere.test/post/77";
    const post = await db
      .prepare(
        "INSERT INTO posts (account_id, content_source, content_html, visibility, created_at, ap_id) VALUES (?, 'x', 'x', 'public', ?, ?) RETURNING id",
      )
      .bind(author, Date.now(), target)
      .first<{ id: number }>();
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
    const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...spki))}\n-----END PUBLIC KEY-----`;
    const community = "https://elsewhere.test/c/things";
    const keyId = `${community}#main-key`;
    await db.prepare("INSERT INTO remote_keys (key_id, owner, pem, fetched_at) VALUES (?, ?, ?, ?)").bind(keyId, community, pem, Date.now()).run();

    const deliver = async (activity: object, tamper = false) => {
      const body = JSON.stringify(activity);
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
      const digest = `SHA-256=${btoa(String.fromCharCode(...hash))}`;
      const date = new Date().toUTCString();
      const text = `(request-target): post /inbox\nhost: palm.test\ndate: ${date}\ndigest: ${digest}`;
      const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(text)));
      const signature = `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${btoa(String.fromCharCode(...sig))}"`;
      return worker.fetch(`${DOMAIN}/inbox`, {
        method: "POST",
        headers: { "content-type": "application/activity+json", host: "palm.test", date, digest, signature },
        body: tamper ? body.replace("Like", "Dislike") : body,
      });
    };
    const like = { type: "Like", actor: "https://elsewhere.test/u/fan", object: target };
    const score = () => db.prepare("SELECT COALESCE(SUM(score), 0) AS s FROM votes WHERE post_id = ?").bind(post!.id).first<{ s: number }>();

    expect((await deliver({ type: "Announce", actor: community, object: like })).status).toBe(202);
    expect((await score())?.s).toBe(1);
    expect((await deliver({ type: "Announce", actor: community, object: { type: "Undo", actor: like.actor, object: like } })).status).toBe(202);
    expect((await score())?.s).toBe(0);
    // A body that doesn't match its digest isn't counted here; Fedify refuses it.
    expect((await deliver({ type: "Announce", actor: community, object: like }, true)).status).toBeGreaterThanOrEqual(400);
    expect((await score())?.s).toBe(0);
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
