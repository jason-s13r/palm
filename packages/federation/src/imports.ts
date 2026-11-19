import type { FederationTask, RequestContext } from "@palm/core";
import { urls } from "@palm/core";
import {
  accountById,
  finishFollowImport,
  follow,
  followImportById,
  followState,
  hasLocalSubscribers,
  subscribe,
  subscription,
  communityById,
} from "@palm/db";
import { logProblem } from "./shared.ts";

/** palm's Lemmy export marks people followed from Lemmy apps with this. */
const PERSON = "#person";

/**
 * Sends one imported follow: looks the target up, follows it from the app the
 * import named, and sends the Follow with `run` (in this job, so a follow
 * costs one queue message, not two). Something that can't be found is dropped.
 */
export async function importFollow(ctx: RequestContext, importId: number, run: (task: FederationTask) => Promise<void>): Promise<void> {
  const db = ctx.bindings.DB;
  const item = await followImportById(db, importId);
  if (!item) return;
  const me = await accountById(db, item.accountId);
  if (!me || me.apId || me.deleted) return finishFollowImport(db, item.id);
  const target = item.target.endsWith(PERSON) ? item.target.slice(0, -PERSON.length) : item.target;
  const found = await ctx.activities.resolve(target);
  if (!found || found.kind === "post") {
    logProblem("import_not_found", { importId, target });
    return finishFollowImport(db, item.id);
  }
  if (found.kind === "account") {
    const them = await accountById(db, found.id);
    const existing = them && them.id !== me.id ? await followState(db, me.id, them.id) : undefined;
    if (them && existing === null) {
      const followApId = `${urls.user(me.domain, me.username)}#follows/${them.id}-${Date.now()}`;
      await follow(db, me.id, them.id, them.apId || them.locked ? { followApId } : undefined, item.via);
      await run({ kind: "followed", accountId: me.id, targetId: them.id, followApId, undo: false });
    } else if (them && existing && !existing[item.via]) {
      // Already followed from the other app: this one joins it.
      await follow(db, me.id, them.id, undefined, item.via);
    }
    return finishFollowImport(db, item.id);
  }
  const community = await communityById(db, found.id);
  if (community && !(await subscription(db, community.id, me.id))) {
    if (community.apId) {
      const followApId = `${urls.user(me.domain, me.username)}#follows/c${community.id}-${Date.now()}`;
      const first = !(await hasLocalSubscribers(db, community.id));
      await subscribe(db, community.id, me.id, { followApId });
      await run({ kind: "subscribed", accountId: me.id, communityId: community.id, followApId, undo: false });
      // The first subscriber here gets the community's recent posts to start with.
      if (first) ctx.activities.enqueue({ kind: "backfill", communityId: community.id });
    } else {
      await subscribe(db, community.id, me.id);
    }
  }
  return finishFollowImport(db, item.id);
}
