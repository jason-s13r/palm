import { describe, expect, it } from "vitest";
import { createAccount, MASTODON, mastodonToken, worker } from "./helpers.ts";

describe("Push subscriptions", () => {
  it("subscribes, updates and unsubscribes, with the server's VAPID key", async () => {
    const id = await createAccount("pusher", "pw");
    const auth = { authorization: `Bearer ${await mastodonToken(id)}`, "content-type": "application/json" };
    const instance = await (await worker.fetch(`${MASTODON}/api/v2/instance`)).json<{ configuration: { vapid: { public_key: string } } }>();
    expect(instance.configuration.vapid.public_key).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
    const created = await (
      await worker.fetch(`${MASTODON}/api/v1/push/subscription`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ subscription: { endpoint: "https://push.example/sub", keys }, data: { alerts: { mention: true, follow: true }, policy: "all" } }),
      })
    ).json<{ endpoint: string; alerts: Record<string, boolean>; server_key: string }>();
    expect(created).toMatchObject({ endpoint: "https://push.example/sub", alerts: { mention: true, follow: true, favourite: false } });
    expect(created.server_key).toBe(instance.configuration.vapid.public_key);
    const updated = await (
      await worker.fetch(`${MASTODON}/api/v1/push/subscription`, { method: "PUT", headers: auth, body: JSON.stringify({ data: { alerts: { favourite: true } } }) })
    ).json<{ alerts: Record<string, boolean> }>();
    expect(updated.alerts.favourite).toBe(true);
    await worker.fetch(`${MASTODON}/api/v1/push/subscription`, { method: "DELETE", headers: auth });
    expect((await worker.fetch(`${MASTODON}/api/v1/push/subscription`, { headers: auth })).status).toBe(404);
  });
});
