import { describe, expect, it } from "vitest";
import { createAccount, db, json, MASTODON, mastodonToken, worker } from "./helpers.ts";

const API = "https://palm.test/api/v3";

async function lemmyUser(username: string) {
  const id = await createAccount(username, "pw-pw-pw");
  const { jwt } = await (await worker.fetch(`${API}/user/login`, json({ username_or_email: username, password: "pw-pw-pw" }))).json<{ jwt: string }>();
  const call = (method: string, path: string, body?: unknown) =>
    worker.fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { id, call };
}

const spareKeys = () =>
  db
    .prepare("INSERT INTO spare_keys (key_pairs, created_at) VALUES (?, ?)")
    .bind(JSON.stringify([{ algorithm: "RSASSA-PKCS1-v1_5", publicJwk: {}, privateJwk: {} }]), Math.floor(Date.now() / 1000))
    .run();

describe("Community moderation", () => {
  it("lets people make communities and moderate them", async () => {
    const mod = await lemmyUser("modder");
    const member = await lemmyUser("member");
    expect(await (await mod.call("POST", "/community", { name: "nokeys", title: "No keys" })).json()).toEqual({ error: "couldnt_create_community" });
    await spareKeys();
    const made = await (await mod.call("POST", "/community", { name: "garden", title: "Garden", description: "Plants" })).json<{ community_view: { community: { id: number } } }>();
    const communityId = made.community_view.community.id;
    const got = await (await mod.call("GET", `/community?id=${communityId}`)).json<{ moderators: { moderator: { id: number } }[] }>();
    expect(got.moderators.map((m) => m.moderator.id)).toEqual([mod.id]);
    await mod.call("PUT", "/community", { community_id: communityId, title: "The Garden" });
    expect((await (await mod.call("GET", `/community?id=${communityId}`)).json<{ community_view: { community: { title: string } } }>()).community_view.community.title).toBe("The Garden");

    const first = await (await member.call("POST", "/post", { community_id: communityId, name: "first" })).json<{ post_view: { post: { id: number } } }>();
    const second = await (await member.call("POST", "/post", { community_id: communityId, name: "second" })).json<{ post_view: { post: { id: number } } }>();
    // Members can't moderate.
    expect((await member.call("POST", "/post/lock", { post_id: first.post_view.post.id, locked: true })).status).toBe(403);

    // Pinning puts a post first; locking stops comments.
    await mod.call("POST", "/post/feature", { post_id: first.post_view.post.id, featured: true, feature_type: "Community" });
    const listed = await (await mod.call("GET", `/post/list?community_id=${communityId}&sort=New`)).json<{ posts: { post: { id: number; featured_community: boolean } }[] }>();
    expect(listed.posts[0]!.post).toMatchObject({ id: first.post_view.post.id, featured_community: true });
    await mod.call("POST", "/post/lock", { post_id: second.post_view.post.id, locked: true });
    expect(await (await member.call("POST", "/comment", { post_id: second.post_view.post.id, content: "hi" })).json()).toEqual({ error: "locked" });

    // A comment is reported, the moderator sees it, removes it and resolves the report.
    const comment = await (await member.call("POST", "/comment", { post_id: first.post_view.post.id, content: "rude" })).json<{ comment_view: { comment: { id: number } } }>();
    const reporter = await lemmyUser("reporter");
    await reporter.call("POST", "/comment/report", { comment_id: comment.comment_view.comment.id, reason: "rude" });
    expect(await (await mod.call("GET", "/user/report_count")).json()).toMatchObject({ comment_reports: 1, post_reports: 0 });
    const reports = await (await mod.call("GET", "/comment/report/list?unresolved_only=true")).json<{ comment_reports: { comment_report: { id: number; reason: string } }[] }>();
    expect(reports.comment_reports.map((r) => r.comment_report.reason)).toEqual(["rude"]);
    expect((await reporter.call("GET", "/comment/report/list")).status).toBe(200);
    expect(await (await reporter.call("GET", "/comment/report/list")).json()).toEqual({ comment_reports: [] });
    await mod.call("POST", "/comment/remove", { comment_id: comment.comment_view.comment.id, removed: true, reason: "rude" });
    await mod.call("PUT", "/comment/report/resolve", { report_id: reports.comment_reports[0]!.comment_report.id, resolved: true });
    expect(await (await mod.call("GET", "/user/report_count")).json()).toMatchObject({ comment_reports: 0 });

    // Banning someone from the community stops their posts there.
    await mod.call("POST", "/community/ban_user", { community_id: communityId, person_id: member.id, ban: true, reason: "spam" });
    expect(await (await member.call("POST", "/post", { community_id: communityId, name: "again" })).json()).toEqual({ error: "banned_from_community" });

    const log = await (await mod.call("GET", `/modlog?community_id=${communityId}`)).json<Record<string, unknown[]>>();
    expect(log.removed_comments).toHaveLength(1);
    expect(log.locked_posts).toHaveLength(1);
    expect(log.featured_posts).toHaveLength(1);
    expect(log.banned_from_community).toHaveLength(1);
  });

  it("files reports from Mastodon apps", async () => {
    const id = await createAccount("snitch", "pw");
    const other = await createAccount("target", "pw");
    const auth = { authorization: `Bearer ${await mastodonToken(id)}`, "content-type": "application/json" };
    const post = await (await worker.fetch(`${MASTODON}/api/v1/statuses`, { method: "POST", headers: { authorization: `Bearer ${await mastodonToken(other)}`, "content-type": "application/json" }, body: JSON.stringify({ status: "bad" }) })).json<{ id: string }>();
    const report = await (await worker.fetch(`${MASTODON}/api/v1/reports`, { method: "POST", headers: auth, body: JSON.stringify({ account_id: String(other), status_ids: [post.id], comment: "spam" }) })).json<{ comment: string; status_ids: string[] }>();
    expect(report).toMatchObject({ comment: "spam", status_ids: [post.id] });
  });
});
