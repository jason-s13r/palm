import { describe, expect, it } from "vitest";
import { createAccount, json, MASTODON, mastodonToken, worker } from "./helpers.ts";

const API = "https://palm.test/api/v3";

async function lemmyUser(username: string) {
  const id = await createAccount(username, "pw-pw-pw");
  const { jwt } = await (await worker.fetch(`${API}/user/login`, json({ username_or_email: username, password: "pw-pw-pw" }))).json<{ jwt: string }>();
  const auth = { authorization: `Bearer ${jwt}` };
  const call = (method: string, path: string, body?: unknown) =>
    worker.fetch(`${API}${path}`, {
      method,
      headers: { ...auth, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { id, get: (path: string) => call("GET", path), post: (path: string, body: unknown) => call("POST", path, body) };
}

async function mastodonUser(username: string) {
  const id = await createAccount(username, "pw");
  const auth = { authorization: `Bearer ${await mastodonToken(id)}` };
  const call = (method: string, path: string, body?: unknown) =>
    worker.fetch(`${MASTODON}${path}`, {
      method,
      headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { id, get: (p: string) => call("GET", p), post: (p: string, b: unknown = {}) => call("POST", p, b) };
}

type CommunityView = { community: { id: number; name: string; title: string }; subscribed: string };
type PostView = { post: { id: number; name: string; community_id: number }; community: { name: string }; counts: { comments: number } };
type CommentView = { comment: { id: number; content: string; path: string; post_id: number }; counts: { child_count: number } };

describe("Person communities", () => {
  it("shows a person's statuses as a community Lemmy apps can follow and comment in", async () => {
    const poster = await mastodonUser("poster");
    const reader = await lemmyUser("reader");
    const status = await (
      await poster.post("/api/v1/statuses", { status: "First line of a status\nand a second one" })
    ).json<{ id: string }>();
    // A private status stays out of Lemmy apps.
    await poster.post("/api/v1/statuses", { status: "followers only", visibility: "private" });

    const found = await (await reader.get("/community?name=poster@palm.test")).json<{ community_view: CommunityView }>();
    const community = found.community_view.community;
    expect(community.name).toBe("poster");
    expect(community.id).toBeGreaterThan(1_000_000_000);

    // Subscribing follows the person.
    const followed = await (await reader.post("/community/follow", { community_id: community.id, follow: true })).json<{ community_view: CommunityView }>();
    expect(followed.community_view.subscribed).toBe("Subscribed");
    const site = await (await reader.get("/site")).json<{ my_user: { follows: { community: { id: number } }[] } }>();
    expect(site.my_user.follows.map((f) => f.community.id)).toContain(community.id);
    const subscribed = await (await reader.get("/community/list?type_=Subscribed")).json<{ communities: CommunityView[] }>();
    expect(subscribed.communities.map((x) => x.community.id)).toContain(community.id);

    // Their statuses are its posts, titled from the first line.
    const inCommunity = await (await reader.get(`/post/list?community_id=${community.id}`)).json<{ posts: PostView[] }>();
    expect(inCommunity.posts.map((p) => p.post.name)).toEqual(["First line of a status"]);
    // Subscribing puts their statuses in Home.
    const home = async () => (await (await reader.get("/post/list?type_=Subscribed&sort=New")).json<{ posts: PostView[] }>()).posts.map((p) => p.post.id);
    expect(await home()).toContain(Number(status.id));
    // A Lemmy subscription isn't a Mastodon follow: !following leaves them out.
    const following = await (await reader.get("/community?name=following")).json<{ community_view: CommunityView }>();
    expect(following.community_view.subscribed).toBe("NotSubscribed");
    const inFollowing = await (await reader.get(`/post/list?community_id=${following.community_view.community.id}`)).json<{ posts: PostView[] }>();
    expect(inFollowing.posts.map((p) => p.post.id)).not.toContain(Number(status.id));

    // !local is every local person's public statuses, followed or not.
    const local = await (await reader.get("/community?name=local")).json<{ community_view: CommunityView }>();
    const inLocal = await (await reader.get(`/post/list?community_id=${local.community_view.community.id}`)).json<{ posts: PostView[] }>();
    expect(inLocal.posts.map((p) => p.post.id)).toContain(Number(status.id));
    expect((await reader.post("/post", { community_id: local.community_view.community.id, name: "nope" })).status).toBe(400);
    const one = await (await reader.get(`/post?id=${status.id}`)).json<{ post_view: PostView; community_view: CommunityView }>();
    expect(one.community_view.community.id).toBe(community.id);

    // A comment is a reply, which the poster sees and answers from Mastodon.
    const commented = await (await reader.post("/comment", { post_id: Number(status.id), content: "a comment" })).json<{ comment_view: CommentView }>();
    expect(commented.comment_view.comment.post_id).toBe(Number(status.id));
    const context = await (await poster.get(`/api/v1/statuses/${status.id}/context`)).json<{ descendants: { id: string }[] }>();
    expect(context.descendants.map((d) => Number(d.id))).toContain(commented.comment_view.comment.id);
    // The notification comes from a queued task.
    const deadline = Date.now() + 5000;
    let types: string[] = [];
    while (!types.includes("mention") && Date.now() < deadline) {
      types = (await (await poster.get("/api/v1/notifications")).json<{ type: string }[]>()).map((n) => n.type);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(types).toContain("mention");
    await poster.post("/api/v1/statuses", { status: "a reply", in_reply_to_id: String(commented.comment_view.comment.id) });

    const comments = await (await reader.get(`/comment/list?post_id=${status.id}&max_depth=8&sort=Old`)).json<{ comments: CommentView[] }>();
    expect(comments.comments.map((c) => c.comment.content)).toEqual(["a comment", "a reply"]);
    const [top, reply] = comments.comments;
    expect(reply!.comment.path).toBe(`0.${top!.comment.id}.${reply!.comment.id}`);
    expect(top!.counts.child_count).toBe(1);
    const listed = await (await reader.get(`/post/list?community_id=${community.id}`)).json<{ posts: PostView[] }>();
    expect(listed.posts[0]!.counts.comments).toBe(2);

    // Nobody posts into someone else's statuses.
    expect((await reader.post("/post", { community_id: community.id, name: "nope" })).status).toBe(400);

    // Unsubscribing unfollows.
    await reader.post("/community/follow", { community_id: community.id, follow: false });
    const after = await (await reader.get("/post/list?type_=Subscribed")).json<{ posts: PostView[] }>();
    expect(after.posts.map((p) => p.post.id)).not.toContain(Number(status.id));
  });
});
