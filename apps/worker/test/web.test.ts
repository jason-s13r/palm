import { describe, expect, it } from "vitest";
import { createAccount, createCommunity, db, json, MASTODON, mastodonToken, worker } from "./helpers.ts";

const SITE = "https://palm.test";
const BROWSER = { headers: { accept: "text/html,application/xhtml+xml" }, redirect: "manual" as const };

async function mastodonUser(username: string) {
  const id = await createAccount(username, "pw-pw-pw");
  const auth = { authorization: `Bearer ${await mastodonToken(id)}` };
  const post = (path: string, body: unknown) =>
    worker.fetch(`${MASTODON}${path}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { id, post };
}

async function lemmyLogin(username: string) {
  const { jwt } = await (await worker.fetch(`${SITE}/api/v3/user/login`, json({ username_or_email: username, password: "pw-pw-pw" }))).json<{ jwt: string }>();
  return (path: string, body: unknown) =>
    worker.fetch(`${SITE}/api/v3${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
}

const meta = (page: string, property: string) => page.match(new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)"`))?.[1];

describe("Web pages", () => {
  it("names people by handle in bylines, and drops the repeat when there's no display name", async () => {
    const plover = await mastodonUser("plover");
    const status = await (await plover.post("/api/v1/statuses", { status: "anyone there?" })).json<{ id: string }>();
    const far = await db
      .prepare(
        "INSERT INTO accounts (domain, username, display_name, role, created_at, ap_id, inbox) VALUES ('far.example', 'gull', 'A \"Gull\"', 'user', 1, 'https://far.example/u/gull', 'https://far.example/inbox') RETURNING id",
      )
      .first<{ id: number }>();
    await db
      .prepare("INSERT INTO posts (account_id, content_source, content_html, spoiler_text, sensitive, visibility, in_reply_to, parent_id, created_at, ap_id) VALUES (?, 'yes', '<p>yes</p>', '', 0, 'public', ?, ?, 2, 'https://far.example/n/1')")
      .bind(far!.id, `https://palm.test/objects/${status.id}`, Number(status.id))
      .run();

    const page = await (await worker.fetch(`${SITE}/@plover/${status.id}`, BROWSER)).text();
    // No display name: the handle alone, not "plover @plover@palm.test".
    expect(page).toContain(">plover</a> · ");
    expect(page).not.toContain("plover</a> @plover@palm.test");
    // Comments name people by handle, so another server's show its host; display names show on hover.
    expect(page).toContain('title="A &quot;Gull&quot;">gull@far.example</a>');

    // A status from before palm kept its client doesn't guess which kind it is.
    const old = await db
      .prepare("INSERT INTO posts (account_id, content_source, content_html, spoiler_text, sensitive, visibility, created_at) VALUES (?, 'old', '<p>old</p>', '', 0, 'public', 3) RETURNING id")
      .bind(plover.id)
      .first<{ id: number }>();
    const oldPage = await (await worker.fetch(`${SITE}/@plover/${old!.id}`, BROWSER)).text();
    expect(oldPage).not.toContain("on Mastodon");
  });

  it("says what kind of post it is and which app and device it came from", async () => {
    const id = await createAccount("kestrel", "pw-pw-pw");
    const headers = { authorization: `Bearer ${await mastodonToken(id)}`, "content-type": "application/json", "user-agent": "Test/1.0 (iPhone; iOS 18.1)" };
    const made = await worker.fetch(`${MASTODON}/api/v1/statuses`, { method: "POST", headers, body: JSON.stringify({ status: "from a Mastodon app" }) });
    const status = await made.json<{ id: string; application: { name: string } | null }>();
    expect(status.application?.name).toBe("Test");
    // A Lemmy app with a webview's User-Agent names no app.
    const reply = await lemmyLogin("kestrel");
    await reply("/comment", { post_id: Number(status.id), content: "from a Lemmy app" });

    const page = await (await worker.fetch(`${SITE}/@kestrel/${status.id}`, BROWSER)).text();
    expect(page).toContain("on Mastodon</span> · <span class=\"via\">via Test for iPhone");
    expect(page).toContain("via a Lemmy app");
  });

  it("shows a profile and a status with its replies, with link-preview tags and no scripts", async () => {
    const wren = await mastodonUser("wren");
    const status = await (await wren.post("/api/v1/statuses", { status: "Hello from <script>alert(1)</script> the web" })).json<{ id: string }>();
    const reply = await lemmyLogin("wren");
    await reply("/comment", { post_id: Number(status.id), content: "a *reply*" });
    await wren.post("/api/v1/statuses", { status: "secret", visibility: "private" });

    const profile = await worker.fetch(`${SITE}/@wren`, BROWSER);
    expect(profile.status).toBe(200);
    expect(profile.headers.get("content-security-policy")).toContain("default-src 'none'");
    const profileHtml = await profile.text();
    expect(meta(profileHtml, "og:type")).toBe("profile");
    expect(profileHtml).toContain("@wren@palm.test");
    expect(profileHtml).toContain(`/@wren/${status.id}`);
    expect(profileHtml).not.toContain("secret");
    expect(profileHtml).not.toContain("<script");
    expect(profileHtml).toMatch(/palm<\/a> \d+\.\d+\.\d+/);

    const page = await (await worker.fetch(`${SITE}/@wren/${status.id}`, BROWSER)).text();
    expect(meta(page, "og:type")).toBe("article");
    expect(meta(page, "og:description")).toContain("Hello from");
    expect(page).toContain('<link rel="alternate" type="application/activity+json"');
    expect(page).toContain("<em>reply</em>");
    expect(page).toContain("1 comment");
    expect(page).not.toContain("<script>");
  });

  it("shows a community and a Lemmy post with nested comments", async () => {
    const communityId = await createCommunity("webby", "Web things");
    await createAccount("finch", "pw-pw-pw");
    const call = await lemmyLogin("kestrel");
    const post = await (await call("/post", { community_id: communityId, name: "A link post", url: "https://example.com/thing" })).json<{ post_view: { post: { id: number } } }>();
    const id = post.post_view.post.id;
    const top = await (await call("/comment", { post_id: id, content: "top" })).json<{ comment_view: { comment: { id: number } } }>();
    await call("/comment", { post_id: id, parent_id: top.comment_view.comment.id, content: "nested" });

    const community = await (await worker.fetch(`${SITE}/c/webby`, BROWSER)).text();
    expect(community).toContain("Web things");
    expect(community).toContain('href="https://example.com/thing"');
    expect(community).toContain("(example.com)");
    expect(community).toContain("2 comments");

    const page = await (await worker.fetch(`${SITE}/post/${id}`, BROWSER)).text();
    expect(meta(page, "og:title")).toBe("A link post");
    expect(page).toMatch(/<ul class="thread"><li id="c\d+">[\s\S]*top[\s\S]*<ul class="thread"><li id="c\d+">[\s\S]*nested/);

    // A comment's own link opens that comment and what's under it.
    const comment = await (await worker.fetch(`${SITE}/comment/${top.comment_view.comment.id}`, BROWSER)).text();
    expect(comment).toContain("A link post");
    expect(comment).toContain("nested");
  });

  it("sends apps and other servers to the right place", async () => {
    await createAccount("lark", "pw-pw-pw");
    // A server resolving a profile link gets the actor.
    const ap = await worker.fetch(`${SITE}/@lark`, { headers: { accept: "application/activity+json" }, redirect: "manual" });
    expect(ap.status).toBe(302);
    expect(ap.headers.get("location")).toBe("https://palm.test/users/lark");
    // A browser on an actor's ID gets the profile page.
    const actor = await worker.fetch(`${SITE}/users/lark`, BROWSER);
    expect(actor.status).toBe(301);
    expect(actor.headers.get("location")).toBe("/@lark");
    // Anything else still goes to the configured site.
    const other = await worker.fetch(`${SITE}/about`, BROWSER);
    expect(other.headers.get("location")).toBe("https://site.example/about");
    expect((await worker.fetch(`${SITE}/@nobody`, BROWSER)).status).toBe(404);
  });
});
