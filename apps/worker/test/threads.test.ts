import { describe, expect, it } from "vitest";
import { createAccount, createCommunity, json, MASTODON, mastodonToken, worker } from "./helpers.ts";

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
  return { id, get: (path: string) => call("GET", path), post: (path: string, body: unknown) => call("POST", path, body), put: (path: string, body: unknown) => call("PUT", path, body) };
}

type PostView = { post: { id: number; name: string; body?: string; deleted: boolean }; counts: { score: number; comments: number }; my_vote?: number; subscribed: string; community: { name: string; actor_id: string } };
type CommentView = { comment: { id: number; content: string; path: string; deleted: boolean; post_id: number }; counts: { child_count: number; score: number } };

describe("Communities, posts and comments", () => {
  it("lists a community, subscribes, and shows it in the site", async () => {
    const communityId = await createCommunity("sandbox", "Sandbox");
    const me = await lemmyUser("sam");

    const list = await (await me.get("/community/list?type_=All")).json<{ communities: { community: { name: string; actor_id: string } }[] }>();
    expect(list.communities.map((c) => c.community.name)).toContain("sandbox");
    const one = await (await me.get("/community?name=sandbox@palm.test")).json<{ community_view: { community: { id: number; actor_id: string } } }>();
    expect(one.community_view.community).toMatchObject({ id: communityId, actor_id: "https://palm.test/c/sandbox" });

    const follow = await (await me.post("/community/follow", { community_id: communityId, follow: true })).json<{ community_view: { subscribed: string; counts: { subscribers: number } } }>();
    expect(follow.community_view).toMatchObject({ subscribed: "Subscribed", counts: { subscribers: 1 } });
    const site = await (await me.get("/site")).json<{ my_user: { follows: { community: { name: string } }[] } }>();
    expect(site.my_user.follows.map((f) => f.community.name)).toEqual(["sandbox"]);
    const subscribed = await (await me.get("/community/list?type_=Subscribed")).json<{ communities: unknown[] }>();
    expect(subscribed.communities).toHaveLength(1);
  });

  it("posts, comments, threads replies and votes", async () => {
    const communityId = await createCommunity("talk");
    const me = await lemmyUser("tia");
    const other = await lemmyUser("uma");

    const created = await (await me.post("/post", { community_id: communityId, name: "Hello", body: "First post" })).json<{ post_view: PostView }>();
    expect(created.post_view).toMatchObject({ post: { name: "Hello", body: "First post" }, counts: { score: 1 }, my_vote: 1 });
    const postId = created.post_view.post.id;

    const list = await (await other.get(`/post/list?community_name=talk&sort=New`)).json<{ posts: PostView[] }>();
    expect(list.posts.map((p) => p.post.id)).toEqual([postId]);

    const top = await (await other.post("/comment", { post_id: postId, content: "Top level" })).json<{ comment_view: CommentView }>();
    expect(top.comment_view.comment.path).toBe(`0.${top.comment_view.comment.id}`);
    const reply = await (await me.post("/comment", { post_id: postId, parent_id: top.comment_view.comment.id, content: "A reply" })).json<{ comment_view: CommentView }>();
    expect(reply.comment_view.comment.path).toBe(`0.${top.comment_view.comment.id}.${reply.comment_view.comment.id}`);

    const tree = await (await other.get(`/comment/list?post_id=${postId}&max_depth=8&sort=Hot`)).json<{ comments: CommentView[] }>();
    expect(tree.comments).toHaveLength(2);
    expect(tree.comments.find((c) => c.comment.id === top.comment_view.comment.id)?.counts.child_count).toBe(1);

    // One comment's thread, as Voyager opens it from the inbox: the parent comes back with its replies.
    const thread = await (await other.get(`/comment/list?post_id=${postId}&parent_id=${top.comment_view.comment.id}&max_depth=8&sort=Hot`)).json<{ comments: CommentView[] }>();
    expect(thread.comments.map((c) => c.comment.id).sort()).toEqual([top.comment_view.comment.id, reply.comment_view.comment.id].sort());

    const liked = await (await other.post("/post/like", { post_id: postId, score: 1 })).json<{ post_view: PostView }>();
    expect(liked.post_view).toMatchObject({ counts: { score: 2, comments: 2 }, my_vote: 1 });
    const unliked = await (await other.post("/post/like", { post_id: postId, score: 0 })).json<{ post_view: PostView }>();
    expect(unliked.post_view.counts.score).toBe(1);
    expect(unliked.post_view.my_vote).toBeUndefined();

    const page = await (await other.get(`/post?id=${postId}`)).json<{ post_view: PostView; community_view: { community: { name: string } } }>();
    expect(page.community_view.community.name).toBe("talk");

    const profile = await (await other.get(`/user?username=tia`)).json<{ person_view: { counts: { post_count: number; comment_count: number } }; posts: unknown[]; comments: unknown[] }>();
    expect(profile.person_view.counts).toMatchObject({ post_count: 1, comment_count: 1 });
    expect(profile.posts).toHaveLength(1);
    expect(profile.comments).toHaveLength(1);
  });

  it("edits and deletes, keeping deleted comments in the thread", async () => {
    const communityId = await createCommunity("edits");
    const me = await lemmyUser("vic");
    const postId = (await (await me.post("/post", { community_id: communityId, name: "Draft" })).json<{ post_view: PostView }>()).post_view.post.id;
    const edited = await (await me.put("/post", { post_id: postId, name: "Final", body: "Now with words" })).json<{ post_view: PostView }>();
    expect(edited.post_view.post).toMatchObject({ name: "Final", body: "Now with words" });

    const commentId = (await (await me.post("/comment", { post_id: postId, content: "oops" })).json<{ comment_view: CommentView }>()).comment_view.comment.id;
    const deleted = await (await me.post("/comment/delete", { comment_id: commentId, deleted: true })).json<{ comment_view: CommentView }>();
    expect(deleted.comment_view.comment).toMatchObject({ deleted: true, content: "" });
    const tree = await (await me.get(`/comment/list?post_id=${postId}&max_depth=8`)).json<{ comments: CommentView[] }>();
    expect(tree.comments[0]?.comment.deleted).toBe(true);

    expect((await me.post("/post/delete", { post_id: postId, deleted: true })).status).toBe(200);
    expect((await me.get(`/post?id=${postId}`)).status).toBe(404);
  });

  it("refuses writes without a login and posts to unknown communities", async () => {
    const me = await lemmyUser("wes");
    expect((await worker.fetch(`${API}/post`, json({ community_id: 1, name: "x" }))).status).toBe(401);
    expect((await me.post("/post", { community_id: 9999, name: "x" })).status).toBe(404);
    expect((await me.get("/community?name=sandbox@elsewhere.example")).status).toBe(404);
  });

  it("shows Lemmy posts to Mastodon apps as statuses with their title", async () => {
    const communityId = await createCommunity("both");
    const me = await lemmyUser("xia");
    await me.post("/post", { community_id: communityId, name: "Seen from Mastodon", body: "body" });
    const token = await mastodonToken(me.id);
    const statuses = await (await worker.fetch(`${MASTODON}/api/v1/accounts/${me.id}/statuses`, { headers: { authorization: `Bearer ${token}` } })).json<{ content: string }[]>();
    expect(statuses[0]?.content).toBe("<p><strong>Seen from Mastodon</strong></p><p>body</p>");
  });
});
