import { describe, expect, it } from "vitest";
import { createAccount, createCommunity, db, json, MASTODON, mastodonToken, worker } from "./helpers.ts";

const API = "https://palm.test/api/v3";

async function invite(code: string) {
  await db
    .prepare("INSERT INTO invites (code, domain, key_pairs, created_at) VALUES (?, 'palm.test', ?, ?)")
    .bind(code, JSON.stringify([{ algorithm: "Ed25519", publicJwk: { kty: "OKP" }, privateJwk: { kty: "OKP" } }]), 1)
    .run();
}

async function lemmyLogin(username: string, password = "pw-pw-pw-pw") {
  return worker.fetch(`${API}/user/login`, json({ username_or_email: username, password }));
}

const as = (jwt: string) => (method: string, path: string, body?: unknown) =>
  worker.fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("Sign-up with invites", () => {
  it("signs up from a Lemmy app with the code as the application answer, once", async () => {
    const site = await (await worker.fetch(`${API}/site`)).json<{ site_view: { local_site: { registration_mode: string } } }>();
    expect(site.site_view.local_site.registration_mode).toBe("RequireApplication");
    await invite("lemmycode1");
    const res = await worker.fetch(`${API}/user/register`, json({ username: "newbie", password: "pw-pw-pw-pw", password_verify: "pw-pw-pw-pw", answer: "lemmycode1" }));
    expect(res.status).toBe(200);
    expect((await res.json<{ jwt: string }>()).jwt).toBeTruthy();
    const keys = await db.prepare("SELECT COUNT(*) AS n FROM actor_keys k JOIN accounts a ON a.id = k.account_id WHERE a.username = 'newbie'").first<{ n: number }>();
    expect(keys?.n).toBe(1);
    const again = await worker.fetch(`${API}/user/register`, json({ username: "newbie2", password: "pw-pw-pw-pw", answer: "lemmycode1" }));
    expect(again.status).toBe(400);
    const wrong = await worker.fetch(`${API}/user/register`, json({ username: "newbie3", password: "pw-pw-pw-pw", answer: "nope" }));
    expect(await wrong.json()).toEqual({ error: "registration_application_answer_required" });
  });

  it("signs up from a Mastodon app with the code as the reason", async () => {
    await invite("mastocode1");
    const app = await (await worker.fetch(`${MASTODON}/api/v1/apps`, json({ client_name: "Test", redirect_uris: "urn:ietf:wg:oauth:2.0:oob" }))).json<{ client_id: string; client_secret: string }>();
    const appToken = await (
      await worker.fetch(`${MASTODON}/oauth/token`, json({ grant_type: "client_credentials", client_id: app.client_id, client_secret: app.client_secret }))
    ).json<{ access_token: string }>();
    const req = json({ username: "fromapp", password: "pw-pw-pw-pw", reason: "mastocode1", agreement: true });
    const res = await worker.fetch(`${MASTODON}/api/v1/accounts`, { ...req, headers: { ...req.headers, authorization: `Bearer ${appToken.access_token}` } });
    expect(res.status).toBe(200);
    const { access_token } = await res.json<{ access_token: string }>();
    const me = await (await worker.fetch(`${MASTODON}/api/v1/accounts/verify_credentials`, { headers: { authorization: `Bearer ${access_token}` } })).json<{ username: string }>();
    expect(me.username).toBe("fromapp");
  });
});

describe("Moderation", () => {
  it("lets an admin ban a person, who then can't sign in or use their session", async () => {
    await createAccount("boss", "pw-pw-pw-pw", "admin");
    const targetId = await createAccount("troll", "pw-pw-pw-pw");
    const admin = as((await (await lemmyLogin("boss")).json<{ jwt: string }>()).jwt);
    const trollJwt = (await (await lemmyLogin("troll")).json<{ jwt: string }>()).jwt;
    const mastodon = await mastodonToken(targetId);

    const notAdmin = await as(trollJwt)("POST", "/user/ban", { person_id: targetId, ban: true });
    expect(notAdmin.status).toBe(403);
    const banned = await admin("POST", "/user/ban", { person_id: targetId, ban: true, remove_data: true });
    expect(await banned.json()).toMatchObject({ banned: true, person_view: { person: { name: "troll" } } });

    expect(await (await lemmyLogin("troll")).json()).toEqual({ error: "site_ban" });
    expect((await as(trollJwt)("GET", "/user/unread_count")).status).toBe(401);
    expect((await worker.fetch(`${MASTODON}/api/v1/accounts/verify_credentials`, { headers: { authorization: `Bearer ${mastodon}` } })).status).toBe(401);
    const list = await (await admin("GET", "/user/banned")).json<{ banned: { person: { name: string } }[] }>();
    expect(list.banned.map((b) => b.person.name)).toContain("troll");
  });

  it("lets an admin remove a post and block servers", async () => {
    await createAccount("chief", "pw-pw-pw-pw", "admin");
    await createAccount("poster", "pw-pw-pw-pw");
    const admin = as((await (await lemmyLogin("chief")).json<{ jwt: string }>()).jwt);
    const poster = as((await (await lemmyLogin("poster")).json<{ jwt: string }>()).jwt);
    const communityId = await createCommunity("moderated");
    const post = await (await poster("POST", "/post", { community_id: communityId, name: "Spam" })).json<{ post_view: { post: { id: number } } }>();
    expect((await admin("POST", "/post/remove", { post_id: post.post_view.post.id, removed: true })).status).toBe(200);
    expect((await poster("GET", `/post?id=${post.post_view.post.id}`)).status).toBe(404);

    expect((await admin("PUT", "/site", { blocked_instances: ["bad.example", "nonsense"] })).status).toBe(200);
    const instances = await (await admin("GET", "/federated_instances")).json<{ federated_instances: { blocked: { domain: string }[] } }>();
    expect(instances.federated_instances.blocked.map((i) => i.domain)).toEqual(["bad.example"]);
  });
});

describe("Pruning", () => {
  it("deletes old remote posts nobody here touched, and keeps the rest", async () => {
    const { prune, vote, migrate } = await import("@palm/db");
    await migrate(db);
    const local = await createAccount("keeper", "pw");
    const remote = await db
      .prepare("INSERT INTO accounts (domain, username, role, created_at, ap_id, inbox) VALUES ('far.example', 'far', 'user', 1, 'https://far.example/u/far', 'https://far.example/inbox') RETURNING id")
      .first<{ id: number }>();
    const old = 1_000;
    const insert = (ap: string) =>
      db
        .prepare("INSERT INTO posts (account_id, content_source, content_html, visibility, created_at, ap_id) VALUES (?, 'x', '<p>x</p>', 'public', ?, ?) RETURNING id")
        .bind(remote!.id, old, ap)
        .first<{ id: number }>();
    const untouched = await insert("https://far.example/p/1");
    const voted = await insert("https://far.example/p/2");
    await vote(db, voted!.id, local, 1);
    expect(await prune(db)).toBeGreaterThanOrEqual(1);
    const left = await db.prepare("SELECT id FROM posts WHERE id IN (?, ?)").bind(untouched!.id, voted!.id).all<{ id: number }>();
    expect(left.results.map((r) => r.id)).toEqual([voted!.id]);
  });
});
