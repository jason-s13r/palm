import { describe, expect, it } from "vitest";
import { createAccount, createCommunity, db, json, MASTODON, mastodonToken, worker } from "./helpers.ts";

const SITE = "https://palm.test";

describe("Link previews and the media cache", () => {
  it("shows a link's preview in both apps, with its picture through the cache", async () => {
    const id = await createAccount("linker", "pw-pw-pw");
    const communityId = await createCommunity("links", "Links");
    const link = "https://news.example/story";
    await db
      .prepare("INSERT INTO link_cards (url, title, description, image, provider, fetched_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(link, "A story", "What happened", "https://news.example/pic.jpg", "News", Math.floor(Date.now() / 1000))
      .run();

    const auth = { authorization: `Bearer ${await mastodonToken(id)}` };
    const status = await (
      await worker.fetch(`${MASTODON}/api/v1/statuses`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ status: `read this ${link}` }) })
    ).json<{ card: { title: string; image: string; provider_name: string } | null }>();
    expect(status.card?.title).toBe("A story");
    expect(status.card?.image).toBe(`https://palm.test/proxy/media?url=${encodeURIComponent("https://news.example/pic.jpg")}`);

    const { jwt } = await (await worker.fetch(`${SITE}/api/v3/user/login`, json({ username_or_email: "linker", password: "pw-pw-pw" }))).json<{ jwt: string }>();
    const created = await (
      await worker.fetch(`${SITE}/api/v3/post`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify({ community_id: communityId, name: "Story", url: link }),
      })
    ).json<{ post_view: { post: { embed_title?: string; embed_description?: string; thumbnail_url?: string } } }>();
    expect(created.post_view.post.embed_title).toBe("A story");
    expect(created.post_view.post.embed_description).toBe("What happened");
    expect(created.post_view.post.thumbnail_url).toContain("/proxy/media?url=");
  });

  it("sends media from servers palm doesn't know to the original", async () => {
    const res = await worker.fetch(`${SITE}/proxy/media?url=${encodeURIComponent("https://stranger.example/a.png")}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://stranger.example/a.png");
    expect((await worker.fetch(`${SITE}/proxy/media?url=javascript:alert(1)`)).status).toBe(400);
  });
});
