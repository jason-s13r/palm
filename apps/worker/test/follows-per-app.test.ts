import { describe, expect, it } from "vitest";
import { createAccount, json, MASTODON, mastodonToken, worker } from "./helpers.ts";

const API = "https://palm.test/api/v3";

type CommunityView = { community: { id: number; name: string }; subscribed: string };
type PostView = { post: { id: number } };

describe("Follows per app", () => {
  it("keeps Mastodon follows and Lemmy subscriptions apart", async () => {
    const authorId = await createAccount("fpa_author", "pw");
    const authorAuth = { authorization: `Bearer ${await mastodonToken(authorId)}`, "content-type": "application/json" };
    const status = await (
      await worker.fetch(`${MASTODON}/api/v1/statuses`, { method: "POST", headers: authorAuth, body: JSON.stringify({ status: "hello from mastodon" }) })
    ).json<{ id: string }>();

    const readerId = await createAccount("fpa_reader", "pw-pw-pw");
    const mastodon = { authorization: `Bearer ${await mastodonToken(readerId)}` };
    const { jwt } = await (await worker.fetch(`${API}/user/login`, json({ username_or_email: "fpa_reader", password: "pw-pw-pw" }))).json<{ jwt: string }>();
    const lemmy = (path: string, body?: unknown) =>
      worker.fetch(`${API}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const subscribedIds = async () =>
      (await (await lemmy("/community/list?type_=Subscribed")).json<{ communities: CommunityView[] }>()).communities.map((x) => x.community.name);
    const siteFollows = async () =>
      (await (await lemmy("/site")).json<{ my_user: { follows: { community: { name: string } }[] } }>()).my_user.follows.map((f) => f.community.name);
    const home = async () => (await (await lemmy("/post/list?type_=Subscribed&sort=New")).json<{ posts: PostView[] }>()).posts.map((p) => p.post.id);
    const relationship = async () =>
      (await (await worker.fetch(`${MASTODON}/api/v1/accounts/relationships?id[]=${authorId}`, { headers: mastodon })).json<{ following: boolean }[]>())[0]!.following;

    // Following in a Mastodon app: no person community in Voyager, nothing in Home.
    await worker.fetch(`${MASTODON}/api/v1/accounts/${authorId}/follow`, { method: "POST", headers: mastodon });
    expect(await relationship()).toBe(true);
    expect(await subscribedIds()).not.toContain("fpa_author");
    expect(await siteFollows()).not.toContain("fpa_author");
    expect(await home()).not.toContain(Number(status.id));

    // Subscribing to their person community in Voyager: listed, and in Home.
    const person = await (await lemmy("/community?name=fpa_author@palm.test")).json<{ community_view: CommunityView }>();
    expect(person.community_view.subscribed).toBe("NotSubscribed");
    await lemmy("/community/follow", { community_id: person.community_view.community.id, follow: true });
    expect(await subscribedIds()).toContain("fpa_author");
    expect(await siteFollows()).toContain("fpa_author");
    expect(await home()).toContain(Number(status.id));

    // Unsubscribing in Voyager keeps the Mastodon follow, and the other way round.
    await lemmy("/community/follow", { community_id: person.community_view.community.id, follow: false });
    expect(await subscribedIds()).not.toContain("fpa_author");
    expect(await relationship()).toBe(true);
    await lemmy("/community/follow", { community_id: person.community_view.community.id, follow: true });
    await worker.fetch(`${MASTODON}/api/v1/accounts/${authorId}/unfollow`, { method: "POST", headers: mastodon });
    expect(await relationship()).toBe(false);
    expect(await subscribedIds()).toContain("fpa_author");
  });
});
