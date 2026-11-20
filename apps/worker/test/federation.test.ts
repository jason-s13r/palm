import { describe, expect, it } from "vitest";
import { createAccount, createCommunity, db, giveKeys, mastodonToken, worker } from "./helpers.ts";

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

  it("serves a community post as Lemmy reads one: public, with the community in cc", async () => {
    const author = await createAccount("poster", "pw");
    await giveKeys(author);
    const community = await createCommunity("ccs");
    const post = await db
      .prepare(
        "INSERT INTO posts (account_id, community_id, title, content_source, content_html, visibility, created_at) VALUES (?, ?, 'Hello', 'x', '<p>x</p>', 'public', ?) RETURNING id",
      )
      .bind(author, community, Math.floor(Date.now() / 1000))
      .first<{ id: number }>();
    const page = await (await worker.fetch(`${DOMAIN}/objects/${post!.id}`, AP)).json<{ type: string; to: unknown; cc: unknown; audience: string }>();
    expect(page.type).toBe("Page");
    // Lemmy matches addressing as plain URLs.
    expect([page.to].flat()).toContain("https://www.w3.org/ns/activitystreams#Public");
    expect([page.cc].flat()).toContain("https://palm.test/c/ccs");
    expect(page.audience).toBe("https://palm.test/c/ccs");
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
    const score = () => db.prepare("SELECT COALESCE(SUM(score), 0) AS s FROM remote_votes WHERE post_id = ?").bind(post!.id).first<{ s: number }>();

    expect((await deliver({ type: "Announce", actor: community, object: like })).status).toBe(202);
    expect((await score())?.s).toBe(1);
    expect((await deliver({ type: "Announce", actor: community, object: { type: "Undo", actor: like.actor, object: like } })).status).toBe(202);
    expect((await score())?.s).toBe(0);
    // A body that doesn't match its digest isn't counted here; Fedify refuses it.
    expect((await deliver({ type: "Announce", actor: community, object: like }, true)).status).toBeGreaterThanOrEqual(400);
    expect((await score())?.s).toBe(0);
  });

  it("takes Pixelfed's story views and replies from followers on other servers", async () => {
    const authorId = await createAccount("storyteller", "pw");
    await giveKeys(authorId);
    const now = Math.floor(Date.now() / 1000);
    const story = await db
      .prepare("INSERT INTO stories (account_id, content_type, token, can_reply, created_at, expires_at) VALUES (?, 'image/png', 'tok', 1, ?, ?) RETURNING id")
      .bind(authorId, now, now + 3600)
      .first<{ id: number }>();
    const storyUrl = `${DOMAIN}/stories/storyteller/${story!.id}`;

    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
    const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...spki))}\n-----END PUBLIC KEY-----`;
    const fan = "https://pixel.test/users/fan";
    await db.prepare("INSERT INTO remote_keys (key_id, owner, pem, fetched_at) VALUES (?, ?, ?, ?)").bind(`${fan}#main-key`, fan, pem, Date.now()).run();
    const fanId = (await db
      .prepare("INSERT INTO accounts (domain, username, created_at, ap_id, inbox, fetched_at) VALUES ('pixel.test', 'fan', ?, ?, ?, ?) RETURNING id")
      .bind(now, fan, `${fan}/inbox`, now)
      .first<{ id: number }>())!.id;

    const deliver = async (activity: object) => {
      const body = JSON.stringify(activity);
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
      const digest = `SHA-256=${btoa(String.fromCharCode(...hash))}`;
      const date = new Date().toUTCString();
      const text = `(request-target): post /inbox\nhost: palm.test\ndate: ${date}\ndigest: ${digest}`;
      const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(text)));
      const signature = `keyId="${fan}#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${btoa(String.fromCharCode(...sig))}"`;
      return worker.fetch(`${DOMAIN}/inbox`, { method: "POST", headers: { "content-type": "application/activity+json", host: "palm.test", date, digest, signature }, body });
    };
    const view = { "@context": "https://www.w3.org/ns/activitystreams", id: `${fan}#stories/1/view`, type: "View", actor: fan, object: { type: "Story", object: storyUrl } };
    const views = () => db.prepare("SELECT COUNT(*) AS n FROM story_views WHERE story_id = ?").bind(story!.id).first<{ n: number }>();

    // Not a follower yet: ignored.
    expect((await deliver(view)).status).toBe(202);
    expect((await views())?.n).toBe(0);
    await db.prepare("INSERT INTO followers (account_id, actor_id, inbox, created_at) VALUES (?, ?, ?, ?)").bind(authorId, fan, `${fan}/inbox`, now).run();
    expect((await deliver(view)).status).toBe(202);
    expect((await views())?.n).toBe(1);

    const reply = { id: "https://pixel.test/p/fan/99", type: "Story:Reply", actor: fan, to: `${DOMAIN}/users/storyteller`, inReplyTo: storyUrl, content: "nice <b>one</b>" };
    expect((await deliver(reply)).status).toBe(202);
    const dm = await db.prepare("SELECT content_html, visibility FROM posts WHERE ap_id = ?").bind(reply.id).first<{ content_html: string; visibility: string }>();
    expect(dm).toMatchObject({ visibility: "direct" });
    expect(dm!.content_html).toContain("Replied to your story: nice one");
    const told = await db.prepare("SELECT kind FROM notifications WHERE account_id = ? AND from_account_id = ?").bind(authorId, fanId).first<{ kind: string }>();
    expect(told?.kind).toBe("mention");

    // A story from someone nobody here follows isn't fetched or kept.
    const add = { id: "https://pixel.test/stories/fan/5/activity", type: "Add", actor: fan, object: { id: "https://pixel.test/stories/fan/5", type: "Story", object: "bear:?t=abcdefghijkl&u=https://pixel.test/stories/fan/5" } };
    expect((await deliver(add)).status).toBe(202);
    expect(await db.prepare("SELECT 1 FROM stories WHERE ap_id = ?").bind(add.object.id).first()).toBeNull();
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
