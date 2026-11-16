import { urls, type RequestContext } from "@palm/core";
import {
  accountById,
  accountsByIds,
  blockAccount,
  blockedAccountIds,
  blockedCommunityIds,
  communitiesByIds,
  communityById,
  followState,
  knownDomains,
  removeFollower,
  setCommunityBlock,
  setUserDomainBlock,
  unblockAccount,
  unfollow,
  userDomainBlocks,
  type Account,
} from "@palm/db";
import { Hono, type Context } from "hono";
import { instanceId, personView, communityView, type Blocks } from "./views.ts";

/**
 * Lemmy's blocks: people, communities and whole instances. They're the same
 * blocks Mastodon apps see, so a person blocked in Voyager is blocked in Ivory.
 */

interface Auth {
  account: Account;
  sessionId: string;
}
type Env = { Bindings: RequestContext; Variables: { auth: Auth | null } };
type C = Context<Env>;

const fail = (c: C, error: string, status: 400 | 401 | 404 = 400) => c.json({ error }, status);
const body = async (c: C) => (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>;

/** What the signed-in person has blocked, for the site's my_user. */
export async function blocksOf(ctx: RequestContext, accountId: number): Promise<Blocks> {
  const db = ctx.bindings.DB;
  const [peopleIds, communityIds, domains] = await Promise.all([
    blockedAccountIds(db, accountId, "block", 500),
    blockedCommunityIds(db, accountId),
    userDomainBlocks(db, accountId),
  ]);
  const [people, communities] = await Promise.all([accountsByIds(db, peopleIds), communitiesByIds(db, communityIds)]);
  return { people: [...people.values()], communities: [...communities.values()], domains };
}

/** Blocking someone ends follows both ways and tells their server, as in Mastodon apps. */
export async function setBlock(ctx: RequestContext, me: Account, target: Account, on: boolean): Promise<void> {
  const db = ctx.bindings.DB;
  if (on) {
    const blockApId = `${urls.user(me.domain, me.username)}#blocks/${target.id}-${Date.now()}`;
    await blockAccount(db, me.id, target.id, "block", { blockApId: target.apId ? blockApId : null });
    const mine = await followState(db, me.id, target.id);
    if (mine) {
      await unfollow(db, me.id, target.id);
      if (target.apId && mine.followApId) {
        ctx.activities.enqueue({ kind: "followed", accountId: me.id, targetId: target.id, followApId: mine.followApId, undo: true });
      }
    }
    await unfollow(db, target.id, me.id);
    if (target.apId) {
      await removeFollower(db, me.id, target.apId);
      ctx.activities.enqueue({ kind: "blocked", accountId: me.id, targetId: target.id, blockApId, undo: false });
    }
  } else {
    const removed = await unblockAccount(db, me.id, target.id, "block");
    if (removed?.blockApId && target.apId) {
      ctx.activities.enqueue({ kind: "blocked", accountId: me.id, targetId: target.id, blockApId: removed.blockApId, undo: true });
    }
  }
}

export const blockRoutes = new Hono<Env>();

blockRoutes.post("/api/v3/user/block", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const target = await accountById(c.env.bindings.DB, Number(params.person_id));
  if (!target || target.id === auth.account.id) return fail(c, "couldnt_find_person", 404);
  const blocked = params.block !== false;
  await setBlock(c.env, auth.account, target, blocked);
  return c.json({ person_view: personView(c.env, target), blocked });
});

blockRoutes.post("/api/v3/community/block", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const community = await communityById(c.env.bindings.DB, Number(params.community_id));
  if (!community) return fail(c, "couldnt_find_community", 404);
  const blocked = params.block !== false;
  await setCommunityBlock(c.env.bindings.DB, auth.account.id, community.id, blocked);
  const view = communityView(c.env, { ...community, subscribers: 0, posts: 0, comments: 0, subscribed: false, pending: false });
  return c.json({ community_view: { ...view, blocked }, blocked });
});

blockRoutes.post("/api/v3/site/block", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const id = Number(params.instance_id);
  // Lemmy names instances by number; palm's numbers come from their domains.
  const domain = (await knownDomains(c.env.bindings.DB, 5000)).find((d) => instanceId(d) === id);
  if (!domain) return fail(c, "couldnt_find_instance", 404);
  const blocked = params.block !== false;
  await setUserDomainBlock(c.env.bindings.DB, auth.account.id, domain, blocked);
  return c.json({ blocked });
});
