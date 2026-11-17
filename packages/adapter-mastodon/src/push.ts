import { sha256Hex } from "@palm/auth";
import { htmlToText, type RequestContext } from "@palm/core";
import {
  accountById,
  deletePushSubscription,
  followState,
  onNotification,
  postById,
  pushSubscription,
  pushSubscriptionsFor,
  savePushSubscription,
  type Account,
  type OAuthApp,
  type PushSubscription,
} from "@palm/db";
import { Hono, type Context } from "hono";
import { sendPush, vapidKeys } from "./webpush.ts";

/**
 * Mastodon's push notifications: an app subscribes with its push endpoint
 * (usually its own relay to Apple's or Google's service) and keys, and each
 * notification is encrypted and sent there.
 */

type Env = { Bindings: RequestContext; Variables: { account: Account | null; app: OAuthApp | null } };
type C = Context<Env>;

const fail = (c: C, error: string, status: 401 | 404 | 422 = 422) => c.json({ error }, status);
const ALERTS = ["mention", "status", "reblog", "follow", "follow_request", "favourite", "poll", "update", "admin.sign_up", "admin.report"];

const tokenOf = (c: C) => (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

/** Nested parameters from JSON, or a form's subscription[keys][auth] style. */
async function params(c: C): Promise<Record<string, unknown>> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("json")) return c.req.json<Record<string, unknown>>().catch(() => ({}));
  const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form)) {
    const path = key.replace(/\]/g, "").split("[");
    let at = out;
    for (const part of path.slice(0, -1)) at = (at[part] ??= {}) as Record<string, unknown>;
    at[path.at(-1)!] = value;
  }
  return out;
}

const truthy = (v: unknown) => v === true || v === "true" || v === "1";

async function view(c: C, s: PushSubscription) {
  return {
    id: s.tokenHash.slice(0, 16),
    endpoint: s.endpoint,
    standard: s.standard,
    alerts: Object.fromEntries(ALERTS.map((a) => [a, s.alerts[a] ?? false])),
    server_key: (await vapidKeys(c.env.bindings.DB)).publicKey,
    policy: s.policy,
  };
}

export const pushRoutes = new Hono<Env>();

pushRoutes.get("/api/v1/push/subscription", async (c) => {
  if (!c.get("account")) return fail(c, "The access token is invalid", 401);
  const found = await pushSubscription(c.env.bindings.DB, await sha256Hex(tokenOf(c)));
  return found ? c.json(await view(c, found)) : fail(c, "Record not found", 404);
});

pushRoutes.post("/api/v1/push/subscription", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const p = await params(c);
  const sub = (p.subscription ?? {}) as { endpoint?: string; keys?: { p256dh?: string; auth?: string }; standard?: unknown };
  if (!sub.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys.auth) return fail(c, "Validation failed: Endpoint and keys are required");
  const data = (p.data ?? {}) as { alerts?: Record<string, unknown>; policy?: string };
  const token = tokenOf(c);
  const subscription: PushSubscription = {
    tokenHash: await sha256Hex(token),
    accountId: me.id,
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    alerts: Object.fromEntries(ALERTS.map((a) => [a, truthy(data.alerts?.[a])])),
    policy: ["all", "followed", "follower", "none"].includes(String(data.policy)) ? String(data.policy) : "all",
    standard: truthy(sub.standard),
    accessToken: token,
  };
  await savePushSubscription(c.env.bindings.DB, subscription);
  return c.json(await view(c, subscription));
});

pushRoutes.put("/api/v1/push/subscription", async (c) => {
  if (!c.get("account")) return fail(c, "The access token is invalid", 401);
  const found = await pushSubscription(c.env.bindings.DB, await sha256Hex(tokenOf(c)));
  if (!found) return fail(c, "Record not found", 404);
  const data = ((await params(c)).data ?? {}) as { alerts?: Record<string, unknown>; policy?: string };
  for (const a of ALERTS) if (data.alerts && a in data.alerts) found.alerts[a] = truthy(data.alerts[a]);
  if (data.policy && ["all", "followed", "follower", "none"].includes(data.policy)) found.policy = data.policy;
  await savePushSubscription(c.env.bindings.DB, found);
  return c.json(await view(c, found));
});

pushRoutes.delete("/api/v1/push/subscription", async (c) => {
  if (!c.get("account")) return fail(c, "The access token is invalid", 401);
  await deletePushSubscription(c.env.bindings.DB, await sha256Hex(tokenOf(c)));
  return c.json({});
});

// --- sending ---------------------------------------------------------------------

const TYPE: Record<string, string> = { reply: "mention", mention: "mention", follow: "follow", follow_request: "follow_request", favourite: "favourite", reblog: "reblog" };
const TITLE: Record<string, (name: string) => string> = {
  mention: (n) => `${n} mentioned you`,
  follow: (n) => `${n} followed you`,
  follow_request: (n) => `${n} wants to follow you`,
  favourite: (n) => `${n} favourited your post`,
  reblog: (n) => `${n} boosted your post`,
};

onNotification(async (db, n) => {
  const subscriptions = await pushSubscriptionsFor(db, n.accountId);
  if (!subscriptions.length) return;
  const type = TYPE[n.kind] ?? n.kind;
  const [from, recipient, post] = await Promise.all([accountById(db, n.fromAccountId), accountById(db, n.accountId), n.postId ? postById(db, n.postId) : Promise.resolve(null)]);
  if (!from || !recipient) return;
  const name = from.displayName || from.username;
  const body = post ? htmlToText(post.contentHtml).slice(0, 140) : "";
  for (const s of subscriptions) {
    if (!s.alerts[type] || s.policy === "none") continue;
    if (s.policy === "followed" && (await followState(db, recipient.id, from.id))?.state !== "accepted") continue;
    if (s.policy === "follower" && (await followState(db, from.id, recipient.id))?.state !== "accepted") continue;
    const payload = {
      access_token: s.accessToken,
      preferred_locale: "en",
      notification_id: n.id,
      notification_type: type,
      icon: from.avatarUrl ?? `https://${recipient.domain}/palm/avatar.png`,
      title: (TITLE[type] ?? ((x: string) => x))(name),
      body,
    };
    const status = await sendPush(db, s, payload, `https://${recipient.domain}/`).catch(() => 0);
    // The push service has forgotten this subscription: so does palm.
    if (status === 404 || status === 410) await deletePushSubscription(db, s.tokenHash);
  }
});
