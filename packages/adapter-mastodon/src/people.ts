import { type RequestContext, urls } from "@palm/core";
import {
  accountByHandle,
  accountById,
  accountForLogin,
  accountsByIds,
  countUnreadNotifications,
  dismissNotifications,
  follow,
  followers,
  followingIds,
  followState,
  listNotifications,
  acceptFollow,
  answerFollower,
  featuredTags,
  featureTag,
  notify,
  pendingFollowers,
  unfeatureTag,
  usedTags,
  type FeaturedTag,
  blockAccount,
  blockedAccountIds,
  blockStates,
  removeFollower,
  setUserDomainBlock,
  unblockAccount,
  userDomainBlocks,
  localFollowerIds,
  markNotificationsRead,
  postsByIds,
  relationships,
  searchTags,
  storeMedia,
  unfollow,
  updateProfile,
  accountByApId,
  type Account,
  type Notification,
  type NotificationKind,
  type OAuthApp,
} from "@palm/db";
import { Hono, type Context } from "hono";
import { accountStats, statuses, tagView } from "./statuses.ts";
import { account, credentialAccount, iso } from "./views.ts";

/**
 * People: profiles, following, search and notifications. Remote accounts are
 * rows palm has met; their IDs work like local ones.
 */

type Env = { Bindings: RequestContext; Variables: { account: Account | null; app: OAuthApp | null } };
type C = Context<Env>;

const fail = (c: C, error: string, status: 401 | 403 | 404 | 422 = 422) => c.json({ error }, status);

/** An account this domain may show: one of its own, or a remote one. */
const showable = (c: C, a: Account | null) => (a && (a.apId !== null || a.domain === c.env.domain.domain) ? a : null);

async function accountView(c: C, a: Account) {
  return account(c.env, a, await accountStats(c.env, a));
}

/**
 * An account by handle: "name" or "name@this.domain" locally, or a remote
 * "name@host", fetched the first time it's asked for.
 */
export async function accountNamed(c: C, handle: string, fetch = true): Promise<Account | null> {
  const db = c.env.bindings.DB;
  const [name, rawHost] = handle.replace(/^@/, "").split("@");
  if (!name) return null;
  const host = rawHost?.toLowerCase() ?? c.env.domain.domain;
  if (host === c.env.domain.domain) return (await accountForLogin(db, host, name))?.account ?? null;
  const known = await accountByHandle(db, name, host);
  if (known || !fetch) return known;
  const found = await c.env.activities.resolve(`@${name}@${host}`);
  return found?.kind === "account" ? accountById(db, found.id) : null;
}

/** Mastodon's Relationship entity, from the viewer to each account. */
async function relationshipViews(c: C, viewer: Account, ids: number[]) {
  const db = c.env.bindings.DB;
  const [found, blocked, people, domains] = await Promise.all([
    relationships(db, viewer.id, ids),
    blockStates(db, viewer.id, ids),
    accountsByIds(db, ids),
    userDomainBlocks(db, viewer.id),
  ]);
  return ids.map((id) => {
    const r = found.get(id);
    const b = blocked.get(id);
    const domain = people.get(id)?.domain;
    return {
      id: String(id),
      following: r?.following === "accepted",
      requested: r?.following === "pending",
      followed_by: r?.followedBy ?? false,
      showing_reblogs: true,
      notifying: false,
      languages: null,
      blocking: b?.blocking ?? false,
      blocked_by: b?.blockedBy ?? false,
      muting: b?.muting ?? false,
      muting_notifications: b?.mutingNotifications ?? false,
      domain_blocking: domain ? domains.includes(domain) : false,
      endorsed: false,
      note: "",
    };
  });
}

const idsFrom = (c: C) => [...(c.req.queries("id[]") ?? []), ...(c.req.queries("id") ?? [])].filter((id) => /^\d+$/.test(id)).slice(0, 40).map(Number);

export const peopleRoutes = new Hono<Env>();

peopleRoutes.get("/api/v1/accounts/relationships", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  return c.json(await relationshipViews(c, me, idsFrom(c)));
});

peopleRoutes.get("/api/v1/accounts/lookup", async (c) => {
  const found = showable(c, await accountNamed(c, c.req.query("acct") ?? ""));
  return found ? c.json(await accountView(c, found)) : fail(c, "Record not found", 404);
});

// Several accounts at once, by ID; unknown ones are left out.
peopleRoutes.get("/api/v1/accounts", async (c) => {
  const found = await accountsByIds(c.env.bindings.DB, idsFrom(c));
  const shown = [...found.values()].filter((a) => showable(c, a));
  return c.json(await Promise.all(shown.map((a) => accountView(c, a))));
});

// Followers of an account that the signed-in account also follows: not worked out yet.
peopleRoutes.get("/api/v1/accounts/familiar_followers", (c) => c.json(idsFrom(c).map((id) => ({ id: String(id), accounts: [] }))));

peopleRoutes.get("/api/v1/accounts/:id{[0-9]+}", async (c) => {
  const db = c.env.bindings.DB;
  const id = Number(c.req.param("id"));
  let found = showable(c, await accountById(db, id));
  if (!found) return fail(c, "Record not found", 404);
  // Opening a remote profile: bring its counts and recent posts up to date first.
  if (found.apId) {
    await c.env.activities.backfillProfile(found.id);
    found = (await accountById(db, id)) ?? found;
  }
  return c.json(await accountView(c, found));
});

peopleRoutes.post("/api/v1/accounts/:id{[0-9]+}/follow", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const db = c.env.bindings.DB;
  const target = showable(c, await accountById(db, Number(c.req.param("id"))));
  if (!target || target.id === me.id) return fail(c, "Record not found", 404);
  if (!(await followState(db, me.id, target.id))) {
    const followApId = `${urls.user(me.domain, me.username)}#follows/${target.id}-${Date.now()}`;
    // A remote account says yes or no; a local one follows straight away, unless it's locked.
    await follow(db, me.id, target.id, target.apId || target.locked ? { followApId } : undefined);
    c.env.activities.enqueue({ kind: "followed", accountId: me.id, targetId: target.id, followApId, undo: false });
  }
  const [relationship] = await relationshipViews(c, me, [target.id]);
  return c.json(relationship);
});

peopleRoutes.post("/api/v1/accounts/:id{[0-9]+}/unfollow", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const db = c.env.bindings.DB;
  const target = await accountById(db, Number(c.req.param("id")));
  if (!target) return fail(c, "Record not found", 404);
  const existing = await followState(db, me.id, target.id);
  if (existing) {
    await unfollow(db, me.id, target.id);
    if (target.apId && existing.followApId) {
      c.env.activities.enqueue({ kind: "followed", accountId: me.id, targetId: target.id, followApId: existing.followApId, undo: true });
    }
  }
  const [relationship] = await relationshipViews(c, me, [target.id]);
  return c.json(relationship);
});

/**
 * Blocking someone also ends follows both ways, and tells their server (as
 * Mastodon does), so they stop seeing the blocker's posts there too.
 */
async function setBlock(c: C, me: Account, target: Account, on: boolean): Promise<void> {
  const db = c.env.bindings.DB;
  if (on) {
    const blockApId = `${urls.user(me.domain, me.username)}#blocks/${target.id}-${Date.now()}`;
    await blockAccount(db, me.id, target.id, "block", { blockApId: target.apId ? blockApId : null });
    const mine = await followState(db, me.id, target.id);
    if (mine) {
      await unfollow(db, me.id, target.id);
      if (target.apId && mine.followApId) {
        c.env.activities.enqueue({ kind: "followed", accountId: me.id, targetId: target.id, followApId: mine.followApId, undo: true });
      }
    }
    await unfollow(db, target.id, me.id);
    if (target.apId) await removeFollower(db, me.id, target.apId);
    if (target.apId) c.env.activities.enqueue({ kind: "blocked", accountId: me.id, targetId: target.id, blockApId, undo: false });
  } else {
    const removed = await unblockAccount(db, me.id, target.id, "block");
    if (removed?.blockApId && target.apId) {
      c.env.activities.enqueue({ kind: "blocked", accountId: me.id, targetId: target.id, blockApId: removed.blockApId, undo: true });
    }
  }
}

for (const [action, on] of [["block", true], ["unblock", false]] as const) {
  peopleRoutes.post(`/api/v1/accounts/:id{[0-9]+}/${action}`, async (c) => {
    const me = c.get("account");
    if (!me) return fail(c, "The access token is invalid", 401);
    const target = showable(c, await accountById(c.env.bindings.DB, Number(c.req.param("id"))));
    if (!target || target.id === me.id) return fail(c, "Record not found", 404);
    await setBlock(c, me, target, on);
    const [relationship] = await relationshipViews(c, me, [target.id]);
    return c.json(relationship);
  });
}

peopleRoutes.post("/api/v1/accounts/:id{[0-9]+}/mute", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const target = showable(c, await accountById(c.env.bindings.DB, Number(c.req.param("id"))));
  if (!target || target.id === me.id) return fail(c, "Record not found", 404);
  const params = await c.req.json<{ notifications?: unknown; duration?: unknown }>().catch(() => ({}) as { notifications?: unknown; duration?: unknown });
  const duration = Number(params.duration ?? c.req.query("duration") ?? 0);
  await blockAccount(c.env.bindings.DB, me.id, target.id, "mute", {
    hideNotifications: params.notifications !== false && params.notifications !== "false",
    expiresAt: duration > 0 ? Math.floor(Date.now() / 1000) + duration : null,
  });
  const [relationship] = await relationshipViews(c, me, [target.id]);
  return c.json(relationship);
});

peopleRoutes.post("/api/v1/accounts/:id{[0-9]+}/unmute", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  await unblockAccount(c.env.bindings.DB, me.id, Number(c.req.param("id")), "mute");
  const [relationship] = await relationshipViews(c, me, [Number(c.req.param("id"))]);
  return c.json(relationship);
});

for (const [path, kind] of [["/api/v1/blocks", "block"], ["/api/v1/mutes", "mute"]] as const) {
  peopleRoutes.get(path, async (c) => {
    const me = c.get("account");
    if (!me) return fail(c, "The access token is invalid", 401);
    const db = c.env.bindings.DB;
    const ids = await blockedAccountIds(db, me.id, kind, Math.min(Number(c.req.query("limit")) || 40, 80));
    const people = await accountsByIds(db, ids);
    return c.json(await Promise.all(ids.flatMap((id) => (people.has(id) ? [accountView(c, people.get(id)!)] : []))));
  });
}

peopleRoutes.get("/api/v1/domain_blocks", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  return c.json(await userDomainBlocks(c.env.bindings.DB, me.id));
});

for (const [method, on] of [["post", true], ["delete", false]] as const) {
  peopleRoutes[method]("/api/v1/domain_blocks", async (c) => {
    const me = c.get("account");
    if (!me) return fail(c, "The access token is invalid", 401);
    const fromBody = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const fromJson = await c.req.json<{ domain?: string }>().catch(() => ({}) as { domain?: string });
    const domain = String(c.req.query("domain") ?? fromJson.domain ?? fromBody.domain ?? "").trim().toLowerCase();
    if (!domain || domain === c.env.domain.domain) return fail(c, "Validation failed: Domain is invalid", 422);
    await setUserDomainBlock(c.env.bindings.DB, me.id, domain, on);
    return c.json({});
  });
}

peopleRoutes.get("/api/v1/accounts/:id{[0-9]+}/following", async (c) => {
  const db = c.env.bindings.DB;
  const found = await accountsByIds(db, await followingIds(db, Number(c.req.param("id"))));
  return c.json([...found.values()].map((a) => account(c.env, a)));
});

// Followers: local ones by their follows, remote ones as far as palm has met them.
peopleRoutes.get("/api/v1/accounts/:id{[0-9]+}/followers", async (c) => {
  const db = c.env.bindings.DB;
  const id = Number(c.req.param("id"));
  const local = await accountsByIds(db, await localFollowerIds(db, id));
  const remote = await Promise.all((await followers(db, id)).slice(0, 80).map((f) => accountByApId(db, f.actorId)));
  return c.json([...local.values(), ...remote.filter((a): a is Account => a !== null)].map((a) => account(c.env, a)));
});

// --- the signed-in account's profile ------------------------------------------------

peopleRoutes.patch("/api/v1/accounts/update_credentials", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const db = c.env.bindings.DB;
  const type = c.req.header("content-type") ?? "";
  const form = type.includes("json")
    ? new Map(Object.entries(await c.req.json<Record<string, unknown>>().catch(() => ({}))))
    : await c.req.formData().catch(() => null);
  const get = (name: string) => form?.get(name) ?? undefined;
  const textOf = (name: string) => {
    const value = get(name);
    return typeof value === "string" ? value.trim() : undefined;
  };
  const imageOf = async (name: string) => {
    const file = get(name);
    if (!(file instanceof File) || !file.size) return undefined;
    const stored = await storeMedia(db, c.env.bindings.MEDIA, me.id, file, null);
    return typeof stored === "string" ? undefined : urls.media(me.domain, stored.file);
  };
  const displayName = textOf("display_name");
  const note = textOf("note");
  const lockedValue = get("locked");
  const locked = lockedValue === undefined ? undefined : lockedValue === true || lockedValue === "true" || lockedValue === "1";
  await updateProfile(db, me.id, {
    ...(locked !== undefined ? { locked } : {}),
    ...(displayName !== undefined ? { displayName: displayName || null } : {}),
    ...(note !== undefined ? { bio: note || null } : {}),
    avatarUrl: await imageOf("avatar"),
    headerUrl: await imageOf("header"),
  });
  c.env.activities.enqueue({ kind: "profile_updated", accountId: me.id });
  const updated = (await accountById(db, me.id))!;
  return c.json(credentialAccount(c.env, updated, await accountStats(c.env, updated)));
});

// --- follow requests, for locked accounts ---------------------------------------

/** People waiting for approval: local ones in account_follows, remote ones in followers. */
async function followRequesters(c: C, me: Account): Promise<Account[]> {
  const db = c.env.bindings.DB;
  const { results } = await db
    .prepare("SELECT account_id FROM account_follows WHERE target_id = ? AND state = 'pending' ORDER BY created_at DESC")
    .bind(me.id)
    .all<{ account_id: number }>();
  const local = await accountsByIds(db, results.map((r) => r.account_id));
  const remote = await Promise.all((await pendingFollowers(db, me.id)).map((f) => accountByApId(db, f.actorId)));
  return [...local.values(), ...remote.filter((a): a is Account => a !== null)];
}

peopleRoutes.get("/api/v1/follow_requests", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const people = await followRequesters(c, me);
  return c.json(await Promise.all(people.slice(0, 80).map((a) => accountView(c, a))));
});

for (const [action, accept] of [["authorize", true], ["reject", false]] as const) {
  peopleRoutes.post(`/api/v1/follow_requests/:id{[0-9]+}/${action}`, async (c) => {
    const me = c.get("account");
    if (!me) return fail(c, "The access token is invalid", 401);
    const db = c.env.bindings.DB;
    const requester = await accountById(db, Number(c.req.param("id")));
    if (!requester) return fail(c, "Record not found", 404);
    if (requester.apId) {
      const answered = await answerFollower(db, me.id, requester.apId, accept);
      if (answered?.followId) {
        c.env.activities.enqueue({ kind: "follow_answered", accountId: me.id, followerId: requester.id, followId: answered.followId, accept });
      }
    } else if (accept) {
      await acceptFollow(db, requester.id, me.id);
      await notify(db, { accountId: me.id, kind: "follow", fromAccountId: requester.id });
    } else {
      await unfollow(db, requester.id, me.id);
    }
    const [relationship] = await relationshipViews(c, me, [requester.id]);
    return c.json(relationship);
  });
}

// --- featured hashtags ----------------------------------------------------------

const featuredTagView = (c: C, account: Account, t: FeaturedTag) => ({
  id: String(t.id),
  name: t.tag,
  url: `${urls.tag(account.domain, t.tag)}`,
  statuses_count: String(t.statuses),
  last_status_at: t.lastStatusAt ? new Date(t.lastStatusAt * 1000).toISOString().slice(0, 10) : null,
});

peopleRoutes.get("/api/v1/featured_tags", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  return c.json((await featuredTags(c.env.bindings.DB, me.id)).map((t) => featuredTagView(c, me, t)));
});

peopleRoutes.get("/api/v1/accounts/:id{[0-9]+}/featured_tags", async (c) => {
  const account = showable(c, await accountById(c.env.bindings.DB, Number(c.req.param("id"))));
  if (!account || account.apId) return c.json([]);
  return c.json((await featuredTags(c.env.bindings.DB, account.id)).map((t) => featuredTagView(c, account, t)));
});

peopleRoutes.post("/api/v1/featured_tags", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const type = c.req.header("content-type") ?? "";
  const params = type.includes("json") ? await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string }) : ((await c.req.parseBody().catch(() => ({}))) as { name?: string });
  const name = String(params.name ?? c.req.query("name") ?? "").replace(/^#/, "").trim().toLowerCase();
  if (!/^[\p{L}\p{N}_]+$/u.test(name)) return fail(c, "Validation failed: Tag is invalid", 422);
  await featureTag(c.env.bindings.DB, me.id, name);
  const tag = (await featuredTags(c.env.bindings.DB, me.id)).find((t) => t.tag === name)!;
  return c.json(featuredTagView(c, me, tag));
});

peopleRoutes.delete("/api/v1/featured_tags/:id{[0-9]+}", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  await unfeatureTag(c.env.bindings.DB, me.id, Number(c.req.param("id")));
  return c.json({});
});

peopleRoutes.get("/api/v1/featured_tags/suggestions", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  return c.json((await usedTags(c.env.bindings.DB, me.id)).map((t) => ({ name: t, url: urls.tag(me.domain, t), history: [], following: false })));
});

// --- search ------------------------------------------------------------------------

peopleRoutes.get("/api/v2/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const type = c.req.query("type");
  const resolve = c.req.query("resolve") === "true" && c.get("account") !== null;
  const out = { accounts: [] as unknown[], statuses: [] as unknown[], hashtags: [] as unknown[] };
  if (!q) return c.json(out);
  const db = c.env.bindings.DB;
  if (/^https?:\/\//.test(q) && resolve) {
    const found = await c.env.activities.resolve(q);
    if (found?.kind === "account") {
      const a = await accountById(db, found.id);
      if (a) out.accounts.push(await accountView(c, a));
    } else if (found?.kind === "post") {
      const posts = await postsByIds(db, [found.id]);
      out.statuses.push(...(await statuses(c.env, [...posts.values()], c.get("account"))));
    }
    return c.json(out);
  }
  if (type === "hashtags" || q.startsWith("#")) {
    out.hashtags.push(...(await searchTags(db, q)).map((t) => tagView(c.env, t)));
    if (!(await searchTags(db, q, 1)).length && /^#?[\p{L}\p{N}_]+$/u.test(q)) out.hashtags.push(tagView(c.env, q.replace(/^#/, "").toLowerCase()));
    return c.json(out);
  }
  if (type === "statuses") return c.json(out);
  // A handle is looked up (and fetched, with resolve); otherwise names that match, here and known.
  if (/^@?[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q)) {
    const found = await accountNamed(c, q, resolve);
    if (found) out.accounts.push(await accountView(c, found));
    return c.json(out);
  }
  const name = q.replace(/^@/, "");
  const { results } = await db
    .prepare(
      `SELECT id FROM accounts WHERE (username LIKE ?1 OR display_name LIKE ?1) AND (ap_id IS NOT NULL OR domain = ?2)
       ORDER BY ap_id IS NOT NULL, id LIMIT 20`,
    )
    .bind(`%${name}%`, c.env.domain.domain)
    .all<{ id: number }>();
  const found = await accountsByIds(db, results.map((r) => r.id));
  out.accounts.push(...[...found.values()].map((a) => account(c.env, a)));
  return c.json(out);
});

// --- notifications -----------------------------------------------------------------

const KINDS: NotificationKind[] = ["mention", "reply", "follow", "follow_request", "favourite", "reblog"];

/** Mastodon has no "reply" type: a reply is a mention of the one it answers. */
const mastodonType = (kind: NotificationKind) => (kind === "reply" ? "mention" : kind);

/** The notification kinds a request asks for, from Mastodon's types[] and exclude_types[]. */
function kindsFrom(c: C): NotificationKind[] {
  const asked = [...(c.req.queries("types[]") ?? []), ...(c.req.queries("types") ?? [])];
  const excluded = new Set([...(c.req.queries("exclude_types[]") ?? []), ...(c.req.queries("exclude_types") ?? [])]);
  const wanted = asked.length ? KINDS.filter((k) => asked.includes(mastodonType(k))) : KINDS;
  return wanted.filter((k) => !excluded.has(mastodonType(k)));
}

function notificationPage(c: C) {
  const num = (name: string) => {
    const value = c.req.query(name);
    return value && /^\d+$/.test(value) ? Number(value) : undefined;
  };
  return {
    maxId: num("max_id"),
    minId: num("min_id") ?? num("since_id"),
    limit: Math.min(Math.max(num("limit") ?? 20, 1), 40),
  };
}

/** Accounts and statuses that a page of notifications refers to, as views. */
async function notificationParts(c: C, items: Notification[]) {
  const db = c.env.bindings.DB;
  const [people, posts] = await Promise.all([
    accountsByIds(db, items.map((n) => n.fromAccountId)),
    postsByIds(db, items.map((n) => n.postId).filter((id): id is number => id !== null)),
  ]);
  const statusList = await statuses(c.env, [...posts.values()], c.get("account"));
  const statusById = new Map(statusList.map((s) => [s.id, s]));
  return { people, statusById };
}

function setLinks(c: C, items: Notification[]) {
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return;
  const url = new URL(c.req.url);
  url.searchParams.delete("max_id");
  url.searchParams.delete("min_id");
  url.searchParams.delete("since_id");
  const older = new URL(url);
  older.searchParams.set("max_id", String(last.id));
  const newer = new URL(url);
  newer.searchParams.set("min_id", String(first.id));
  c.header("Link", `<${older.href}>; rel="next", <${newer.href}>; rel="prev"`);
}

peopleRoutes.get("/api/v1/notifications", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const items = await listNotifications(c.env.bindings.DB, me.id, { kinds: kindsFrom(c), ...notificationPage(c) });
  const { people, statusById } = await notificationParts(c, items);
  setLinks(c, items);
  return c.json(
    items.flatMap((n) => {
      const from = people.get(n.fromAccountId);
      if (!from) return [];
      const status = n.postId ? statusById.get(String(n.postId)) : undefined;
      if (n.postId && !status) return [];
      return [{ id: String(n.id), type: mastodonType(n.kind), created_at: iso(n.createdAt), account: account(c.env, from), ...(status ? { status } : {}) }];
    }),
  );
});

// Mastodon 4.3's grouped notifications. palm doesn't group yet: each one is its own group.
peopleRoutes.get("/api/v2/notifications", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const items = await listNotifications(c.env.bindings.DB, me.id, { kinds: kindsFrom(c), ...notificationPage(c) });
  const { people, statusById } = await notificationParts(c, items);
  const shown = items.filter((n) => people.has(n.fromAccountId) && (!n.postId || statusById.has(String(n.postId))));
  setLinks(c, shown);
  return c.json({
    accounts: [...new Set(shown.map((n) => n.fromAccountId))].map((id) => account(c.env, people.get(id)!)),
    statuses: [...new Set(shown.map((n) => n.postId).filter((id): id is number => id !== null))].map((id) => statusById.get(String(id))),
    notification_groups: shown.map((n) => ({
      group_key: `ungrouped-${n.id}`,
      notifications_count: 1,
      type: mastodonType(n.kind),
      most_recent_notification_id: n.id,
      page_min_id: String(n.id),
      page_max_id: String(n.id),
      latest_page_notification_at: iso(n.createdAt),
      sample_account_ids: [String(n.fromAccountId)],
      status_id: n.postId ? String(n.postId) : null,
    })),
  });
});

for (const path of ["/api/v1/notifications/unread_count", "/api/v2/notifications/unread_count"]) {
  peopleRoutes.get(path, async (c) => {
    const me = c.get("account");
    if (!me) return fail(c, "The access token is invalid", 401);
    return c.json({ count: await countUnreadNotifications(c.env.bindings.DB, me.id) });
  });
}

peopleRoutes.post("/api/v1/notifications/clear", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  await dismissNotifications(c.env.bindings.DB, me.id);
  return c.json({});
});

peopleRoutes.post("/api/v1/notifications/:id{[0-9]+}/dismiss", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  await dismissNotifications(c.env.bindings.DB, me.id, Number(c.req.param("id")));
  return c.json({});
});

// The read marker: apps set it as you scroll; palm marks notifications up to it read.
peopleRoutes.get("/api/v1/markers", (c) => c.json({}));
peopleRoutes.post("/api/v1/markers", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const type = c.req.header("content-type") ?? "";
  const params: Record<string, unknown> = type.includes("json")
    ? await c.req.json<Record<string, unknown>>().catch(() => ({}))
    : await c.req.parseBody().catch(() => ({}));
  const nested = params.notifications as { last_read_id?: string } | undefined;
  const lastRead = nested?.last_read_id ?? (params["notifications[last_read_id]"] as string | undefined);
  if (lastRead && /^\d+$/.test(lastRead)) {
    await c.env.bindings.DB.prepare("UPDATE notifications SET read = 1 WHERE account_id = ? AND id <= ?").bind(me.id, Number(lastRead)).run();
  }
  return c.json(
    lastRead ? { notifications: { last_read_id: lastRead, version: 1, updated_at: new Date().toISOString() } } : {},
  );
});

export { markNotificationsRead };
