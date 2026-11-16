import { describe, expect, it } from "vitest";
import { createAccount, createCommunity, json, MASTODON, mastodonToken, worker } from "./helpers.ts";

const SITE = "https://palm.test";

describe("Looking up this domain's own things", () => {
  it("resolves local URLs and handles without fetching itself", async () => {
    await createCommunity("homegrown", "Home grown");
    const id = await createAccount("otter", "pw-pw-pw");
    const auth = { authorization: `Bearer ${await mastodonToken(id)}` };
    const status = await (
      await worker.fetch(`${MASTODON}/api/v1/statuses`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ status: "local one" }) })
    ).json<{ id: string }>();

    const { jwt } = await (await worker.fetch(`${SITE}/api/v3/user/login`, json({ username_or_email: "otter", password: "pw-pw-pw" }))).json<{ jwt: string }>();
    const lemmy = (q: string) =>
      worker.fetch(`${SITE}/api/v3/resolve_object?q=${encodeURIComponent(q)}`, { headers: { authorization: `Bearer ${jwt}` } }).then((r) => r.json<Record<string, { community?: { name: string }; person?: { name: string }; post?: { id: number } }>>());
    expect((await lemmy(`${SITE}/c/homegrown`)).community?.community?.name).toBe("homegrown");
    expect((await lemmy("!homegrown@palm.test")).community?.community?.name).toBe("homegrown");
    expect((await lemmy(`${SITE}/@otter`)).person?.person?.name).toBe("otter");
    expect((await lemmy(`${SITE}/@otter/${status.id}`)).post?.post?.id).toBe(Number(status.id));

    const search = await (
      await worker.fetch(`${MASTODON}/api/v2/search?q=${encodeURIComponent(`${SITE}/objects/${status.id}`)}&resolve=true`, { headers: auth })
    ).json<{ statuses: { id: string }[] }>();
    expect(search.statuses.map((s) => s.id)).toContain(status.id);

    // Setting a quote policy hands the status back.
    const policy = await worker.fetch(`${MASTODON}/api/v1/statuses/${status.id}/interaction_policy`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ quote_approval_policy: "public" }),
    });
    expect(policy.status).toBe(200);
  });

  it("serves a favicon and robots.txt", async () => {
    const icon = await worker.fetch(`${SITE}/favicon.ico`);
    expect(icon.headers.get("content-type")).toContain("image/");
    expect(await (await worker.fetch(`${SITE}/robots.txt`)).text()).toContain("Disallow: /api/");
  });
});
