import { describe, expect, it } from "vitest";
import { createAccount, giveKeys, MASTODON, mastodonToken, worker } from "./helpers.ts";

async function user(username: string) {
  const id = await createAccount(username, "pw");
  await giveKeys(id);
  const auth = { authorization: `Bearer ${await mastodonToken(id)}` };
  const call = (method: string, path: string, body?: unknown) =>
    worker.fetch(`${MASTODON}${path}`, {
      method,
      headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { id, call };
}

describe("Locked accounts, pins and featured tags", () => {
  it("holds follows for a locked account until it approves them", async () => {
    const lock = await user("lockie");
    const fan = await user("fan");
    const me = await (await lock.call("PATCH", "/api/v1/accounts/update_credentials", { locked: true })).json<{ locked: boolean }>();
    expect(me.locked).toBe(true);
    const asked = await (await fan.call("POST", `/api/v1/accounts/${lock.id}/follow`)).json<{ following: boolean; requested: boolean }>();
    expect(asked).toMatchObject({ following: false, requested: true });
    const requests = await (await lock.call("GET", "/api/v1/follow_requests")).json<{ id: string }[]>();
    expect(requests.map((r) => r.id)).toEqual([String(fan.id)]);
    const answered = await (await lock.call("POST", `/api/v1/follow_requests/${fan.id}/authorize`)).json<{ followed_by: boolean }>();
    expect(answered.followed_by).toBe(true);
    expect(await (await lock.call("GET", "/api/v1/follow_requests")).json()).toEqual([]);
    // The actor tells other servers to ask first.
    const actor = await (await worker.fetch("https://palm.test/users/lockie", { headers: { accept: "application/activity+json" } })).json<{ manuallyApprovesFollowers: boolean; featured: string }>();
    expect(actor.manuallyApprovesFollowers).toBe(true);
    expect(actor.featured).toBe("https://palm.test/users/lockie/featured");
  });

  it("pins posts and features hashtags on a profile", async () => {
    const pinner = await user("pinner");
    const post = await (await pinner.call("POST", "/api/v1/statuses", { status: "pin me #gardening" })).json<{ id: string }>();
    const pinned = await (await pinner.call("POST", `/api/v1/statuses/${post.id}/pin`)).json<{ pinned: boolean }>();
    expect(pinned.pinned).toBe(true);
    const pins = await (await pinner.call("GET", `/api/v1/accounts/${pinner.id}/statuses?pinned=true`)).json<{ id: string }[]>();
    expect(pins.map((p) => p.id)).toEqual([post.id]);
    const featured = await (await worker.fetch("https://palm.test/users/pinner/featured", { headers: { accept: "application/activity+json" } })).json<{ orderedItems?: unknown[]; items?: unknown[] }>();
    expect((featured.orderedItems ?? featured.items ?? []).length).toBe(1);

    const tag = await (await pinner.call("POST", "/api/v1/featured_tags", { name: "gardening" })).json<{ id: string; name: string; statuses_count: string }>();
    expect(tag).toMatchObject({ name: "gardening", statuses_count: "1" });
    const listed = await (await worker.fetch(`${MASTODON}/api/v1/accounts/${pinner.id}/featured_tags`)).json<{ name: string }[]>();
    expect(listed.map((t) => t.name)).toEqual(["gardening"]);
    await pinner.call("DELETE", `/api/v1/featured_tags/${tag.id}`);
    expect(await (await pinner.call("GET", "/api/v1/featured_tags")).json()).toEqual([]);
  });
});
