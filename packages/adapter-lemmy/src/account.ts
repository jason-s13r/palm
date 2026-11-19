import { verifyPassword } from "@palm/auth";
import { urls, type RequestContext } from "@palm/core";
import {
  accountByApId,
  accountById,
  accountForLogin,
  bookmark,
  communityByApId,
  deleteLocalAccount,
  exportAccount,
  follow,
  followState,
  hasLocalSubscribers,
  postByUri,
  setCommunityBlock,
  setUserDomainBlock,
  subscribe,
  queueFollowImports,
  subscription,
  type Account,
} from "@palm/db";
import { Hono, type Context } from "hono";
import { setBlock } from "./blocks.ts";

/** Deleting an account, and Lemmy's settings export and import. */

interface Auth {
  account: Account;
  sessionId: string;
}
type Env = { Bindings: RequestContext; Variables: { auth: Auth | null } };
type C = Context<Env>;

const fail = (c: C, error: string, status: 400 | 401 | 404 = 400) => c.json({ error }, status);
const body = async (c: C) => (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>;
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

// Each unknown ID is a fetch from its server: an import looks up this many at
// most, and leaves the rest of its follows to the cron (`follow_imports`).
const IMPORT_LOOKUPS = 40;

export const accountRoutes = new Hono<Env>();

accountRoutes.post("/api/v3/user/delete_account", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const db = c.env.bindings.DB;
  const me = auth.account;
  const found = await accountForLogin(db, me.domain, me.username);
  if (typeof params.password !== "string" || !found?.passwordHash || !(await verifyPassword(params.password, found.passwordHash))) {
    return fail(c, "incorrect_login");
  }
  await deleteLocalAccount(db, me.id, params.delete_content === true);
  c.env.activities.enqueue({ kind: "account_deleted", accountId: me.id });
  return c.json({ success: true });
});

accountRoutes.get("/api/v3/user/export_settings", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const me = auth.account;
  const data = await exportAccount(c.env.bindings.DB, me.id);
  return c.json({
    display_name: me.displayName,
    bio: me.bio,
    avatar: me.avatarUrl,
    banner: me.headerUrl,
    matrix_id: null,
    bot_account: false,
    settings: null,
    followed_communities: [...data.communities, ...data.people.map(personCommunity)],
    blocked_communities: data.blockedCommunities,
    blocked_users: data.blockedPeople,
    blocked_instances: data.blockedDomains,
    saved_posts: data.saved.filter((s) => !s.comment).map((s) => s.id),
    saved_comments: data.saved.filter((s) => s.comment).map((s) => s.id),
  });
});

// People followed show in Voyager as communities; in the export they're
// marked so an import here follows the person again.
const PERSON = "#person";
const personCommunity = (id: string) => `${id}${PERSON}`;

accountRoutes.post("/api/v3/user/import_settings", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const ctx = c.env;
  const db = ctx.bindings.DB;
  const me = auth.account;
  let lookups = 0;
  const resolve = async (id: string) => {
    if (lookups >= IMPORT_LOOKUPS) return null;
    lookups++;
    return ctx.activities.resolve(id).catch(() => null);
  };
  const personFor = async (id: string) => (await accountByApId(db, id)) ?? (await resolve(id).then((r) => (r?.kind === "account" ? accountById(db, r.id) : null)));
  const communityFor = async (id: string) => {
    const known = await communityByApId(db, id);
    if (known) return known.id;
    const r = await resolve(id);
    return r?.kind === "community" ? r.id : null;
  };

  // Follows past the lookup limit are sent later, a few at a time by the cron.
  const later: { target: string; via: "lemmy" }[] = [];
  for (const id of strings(params.followed_communities)) {
    if (lookups >= IMPORT_LOOKUPS) {
      const ap = id.endsWith(PERSON) ? id.slice(0, -PERSON.length) : id;
      const known = id.endsWith(PERSON) ? await accountByApId(db, ap) : await communityByApId(db, ap);
      if (!known) {
        later.push({ target: id, via: "lemmy" });
        continue;
      }
    }
    if (id.endsWith(PERSON)) {
      const target = await personFor(id.slice(0, -PERSON.length));
      if (!target || target.id === me.id) continue;
      const existing = await followState(db, me.id, target.id);
      if (existing?.lemmy) continue;
      if (existing) {
        await follow(db, me.id, target.id, undefined, "lemmy");
        continue;
      }
      const followApId = `${urls.user(me.domain, me.username)}#follows/${target.id}-${Date.now()}`;
      await follow(db, me.id, target.id, target.apId || target.locked ? { followApId } : undefined, "lemmy");
      ctx.activities.enqueue({ kind: "followed", accountId: me.id, targetId: target.id, followApId, undo: false });
      continue;
    }
    const communityId = await communityFor(id);
    if (!communityId || (await subscription(db, communityId, me.id))) continue;
    const remote = (await communityByApId(db, id)) !== null;
    if (remote) {
      const followApId = `${urls.user(me.domain, me.username)}#follows/c${communityId}-${Date.now()}`;
      const first = !(await hasLocalSubscribers(db, communityId));
      await subscribe(db, communityId, me.id, { followApId });
      ctx.activities.enqueue({ kind: "subscribed", accountId: me.id, communityId, followApId, undo: false });
      if (first) ctx.activities.enqueue({ kind: "backfill", communityId });
    } else {
      await subscribe(db, communityId, me.id);
    }
  }
  await queueFollowImports(db, me.id, later);
  for (const id of strings(params.blocked_communities)) {
    const communityId = await communityFor(id);
    if (communityId) await setCommunityBlock(db, me.id, communityId, true);
  }
  for (const id of strings(params.blocked_users)) {
    const target = await personFor(id);
    if (target && target.id !== me.id) await setBlock(ctx, me, target, true);
  }
  for (const domain of strings(params.blocked_instances)) await setUserDomainBlock(db, me.id, domain.toLowerCase(), true);
  const domains = ctx.config.domains.map((d) => d.domain);
  for (const id of [...strings(params.saved_posts), ...strings(params.saved_comments)]) {
    const post = await postByUri(db, id, domains);
    if (post) await bookmark(db, post.id, me.id);
  }
  return c.json({ success: true });
});
