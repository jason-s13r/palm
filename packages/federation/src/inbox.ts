import type { Context, FederationBuilder, InboxContext } from "@fedify/fedify";
import {
  Question,
  Note,
  Flag,
  Accept,
  Activity,
  Announce,
  Create,
  Delete,
  Dislike,
  Follow,
  Group,
  Like,
  Move,
  QuoteRequest,
  Reject,
  Undo,
  Update,
} from "@fedify/fedify/vocab";
import { urls, type RequestContext } from "@palm/core";
import {
  addRemotePollVote,
  authorizeQuote,
  effectiveQuotePolicy,
  mayQuote,
  postById,
  setQuoteState,
  accountById,
  follow as followAccount,
  followState,
  forgetRemoteAccount,
  localFollowersOf,
  setMovedTo,
  pollsFor,
  createReport,
  acceptFollow,
  accountByApId,
  isBlockedHost,
  acceptSubscription,
  addCommunityFollower,
  addFollower,
  boost,
  communityById,
  deletePost,
  followByApId,
  hasLocalFollowers,
  notify,
  postByUri,
  removeCommunityFollower,
  removeFollower,
  subscriptionByFollow,
  unboostByApId,
  unfollow,
  unsubscribe,
  updateRemotePost,
  vote,
  type Community,
  type Post,
} from "@palm/db";
import { htmlToText, sanitizeHtml } from "@palm/core";
import { announceToCommunity } from "./delivery.ts";
import { quoteAuthorizationUri } from "./objects.ts";
import { ensureAccount, ensureActor, ensureCommunity, savePollFrom, storeRemotePost } from "./remote.ts";
import { communitySenderKeys, contextsFor, localDomains, logProblem, personKeys, send } from "./shared.ts";

type Ctx = Context<RequestContext>;

/** Where an activity arrived from: straight from its actor, or announced by a community. */
interface Via {
  community: Community | null;
}

const isLocalCommunity = (c: Community | null): c is Community => c !== null && c.apId === null;

/** The post an activity's object points at, local or remote. */
const postFor = (ctx: Ctx, id: URL | null) => (id ? postByUri(ctx.data.bindings.DB, id.href, localDomains(ctx.data)) : Promise.resolve(null));

async function localAuthorOf(ctx: Ctx, post: Post): Promise<number | null> {
  const row = await ctx.data.bindings.DB.prepare("SELECT id FROM accounts WHERE id = ? AND ap_id IS NULL").bind(post.accountId).first<{ id: number }>();
  return row?.id ?? null;
}

/**
 * When something happens in a local community from another server, the
 * community passes it on to its other followers, as Lemmy does.
 */
async function relayIfLocalCommunity(ctx: Ctx, post: Post | null, activity: Activity): Promise<void> {
  if (!post?.communityId) return;
  const community = await communityById(ctx.data.bindings.DB, post.communityId);
  if (isLocalCommunity(community)) await announceToCommunity(ctx.data, community, activity);
}

async function onFollow(ctx: Ctx, follow: Follow): Promise<void> {
  if (!follow.id || !follow.actorId || !follow.objectId) return;
  const db = ctx.data.bindings.DB;
  const target = await ensureActor(ctx, follow.objectId);
  if (!target) return;
  const follower = await follow.getActor(ctx);
  if (!follower?.id || !follower.inboxId) return;
  const row = { actorId: follower.id.href, inbox: follower.inboxId.href, sharedInbox: follower.endpoints?.sharedInbox?.href ?? null, followId: follow.id.href };
  const { people, communities } = await contextsFor(ctx.data);
  if ("account" in target && target.account.apId === null) {
    // A locked account approves its followers: no Accept until it does.
    const locked = target.account.locked;
    await addFollower(db, target.account.id, row, locked);
    const from = await ensureAccount(ctx, follower);
    if (from) await notify(db, { accountId: target.account.id, kind: locked ? "follow_request" : "follow", fromAccountId: from.id });
    if (locked) return;
    await send(people, 
      await personKeys(people, target.account),
      follower,
      new Accept({ id: new URL(`#accepts/${crypto.randomUUID()}`, follow.objectId), actor: follow.objectId, object: follow.id }),
    );
  } else if ("community" in target && isLocalCommunity(target.community)) {
    await addCommunityFollower(db, target.community.id, row);
    await send(communities, 
      await communitySenderKeys(communities, target.community),
      follower,
      // Lemmy wants the Follow itself inside the Accept.
      new Accept({ id: new URL(`#accepts/${crypto.randomUUID()}`, follow.objectId), actor: follow.objectId, object: follow }),
    );
  }
}

/** A remote person or community accepted a local account's Follow. */
async function onAccept(ctx: Ctx, accept: Accept): Promise<void> {
  const db = ctx.data.bindings.DB;
  const followId = accept.objectId;
  if (!followId) return;
  if (await answerQuote(ctx, followId, accept.actorId, accept.resultId)) return;
  const follow = await followByApId(db, followId.href);
  if (follow) return acceptFollow(db, follow.accountId, follow.targetId);
  const sub = await subscriptionByFollow(db, followId.href);
  if (sub) await acceptSubscription(db, sub.communityId, sub.accountId);
}

async function onReject(ctx: Ctx, reject: Reject): Promise<void> {
  const db = ctx.data.bindings.DB;
  const followId = reject.objectId;
  if (!followId) return;
  if (await answerQuote(ctx, followId, reject.actorId, null)) return;
  const follow = await followByApId(db, followId.href);
  if (follow) return unfollow(db, follow.accountId, follow.targetId);
  const sub = await subscriptionByFollow(db, followId.href);
  if (sub) await unsubscribe(db, sub.communityId, sub.accountId);
}

/**
 * An answer to palm's request to quote another server's post: an Accept
 * carries the approval (`result`), which the quoting post then points to.
 * Returns whether `requestId` was one of palm's quote requests.
 */
async function answerQuote(ctx: Ctx, requestId: URL, actorId: URL | null, approval: URL | null): Promise<boolean> {
  if (requestId.hash !== "#quote-request" || !localDomains(ctx.data).includes(requestId.host.toLowerCase())) return false;
  const match = /^\/objects\/(\d+)$/.exec(requestId.pathname);
  const db = ctx.data.bindings.DB;
  const post = match ? await postById(db, Number(match[1])) : null;
  if (!post?.quoteOf || !actorId) return true;
  // Only the quoted post's server answers for it.
  if (new URL(post.quoteOf).host !== actorId.host) return true;
  if (approval) await setQuoteState(db, post.id, "accepted", approval.href);
  else await setQuoteState(db, post.id, "rejected");
  // Followers' copies pick up the approval.
  ctx.data.activities.enqueue({ kind: "post_updated", postId: post.id });
  return true;
}

/**
 * Another server asks to quote a post here (Mastodon 4.5). The post's policy
 * decides: an Accept with an approval, which stays readable at its ID, or a
 * Reject.
 */
async function onQuoteRequest(ctx: Ctx, request: QuoteRequest): Promise<void> {
  const db = ctx.data.bindings.DB;
  if (!request.id || !request.actorId || !request.objectId) return;
  const quoted = await postByUri(db, request.objectId.href, localDomains(ctx.data));
  if (!quoted || quoted.apId !== null) return;
  const author = await accountById(db, quoted.accountId);
  const requester = await request.getActor(ctx).catch(() => null);
  if (!author || !requester?.id || !requester.inboxId) return;
  const quoting = request.instrumentId;
  const policy = effectiveQuotePolicy(quoted, author.quotePolicy);
  const allowed = quoting !== null && quoting.host === requester.id.host && (await mayQuote(db, author.id, requester.id.href, policy));
  const { people } = await contextsFor(ctx.data);
  const actor = new URL(urls.user(author.domain, author.username));
  if (!allowed) {
    await send(people, await personKeys(people, author), requester, new Reject({ id: new URL(`#rejects/${crypto.randomUUID()}`, actor), actor, object: request }));
    return;
  }
  const approval = quoteAuthorizationUri(author, await authorizeQuote(db, quoted.id, quoting.href, requester.id.href));
  await send(
    people,
    await personKeys(people, author),
    requester,
    new Accept({ id: new URL(`#accepts/${crypto.randomUUID()}`, actor), actor, object: request, result: approval }),
  );
}

async function onCreate(ctx: Ctx, create: Create, via: Via): Promise<void> {
  const object = await create.getObject({ crossOrigin: "trust" }).catch(() => null);
  if (!object?.id || !create.actorId) return;
  // A vote in a poll here: a Note naming the option, answering the Question, with no text.
  if (object instanceof Note && object.name && object.replyTargetId && !object.content) {
    const poll = await postFor(ctx, object.replyTargetId);
    if (poll && poll.apId === null) {
      const voter = await ensureAccount(ctx, create.actorId);
      const options = (await pollsFor(ctx.data.bindings.DB, [poll.id])).get(poll.id)?.options ?? [];
      const choice = options.findIndex((o) => o.title === String(object.name));
      if (voter && choice >= 0) await addRemotePollVote(ctx.data.bindings.DB, poll.id, voter.id, choice);
      return;
    }
  }
  // The author has to be who sent it (Lemmy communities relay others' posts, via Announce).
  if (object.attributionId && object.attributionId.href !== create.actorId.href) return;
  const addressedHere = [...create.toIds, ...create.ccIds, ...object.toIds, ...object.ccIds].some((u) =>
    localDomains(ctx.data).includes(u.host.toLowerCase()),
  );
  const post = await storeRemotePost(ctx, object, { community: via.community, addressedHere });
  // Posted straight to a local community: pass it on to the community's followers.
  if (post && !via.community) await relayIfLocalCommunity(ctx, post, create);
}

async function onUpdate(ctx: Ctx, update: Update, via: Via): Promise<void> {
  const object = await update.getObject({ crossOrigin: "trust" }).catch(() => null);
  if (!object?.id || !update.actorId) return;
  // A profile or community changed: refetch it.
  if (object.id.href === update.actorId.href || object instanceof Group) {
    await ensureActor(ctx, object);
    return;
  }
  const post = await postFor(ctx, object.id);
  if (!post?.apId) return;
  const author = await ensureAccount(ctx, update.actorId);
  if (author?.id !== post.accountId) return;
  const html = sanitizeHtml(String((object as { content?: unknown }).content ?? ""));
  const source = (object as { source?: { content?: unknown; mediaType?: string | null } | null }).source;
  await updateRemotePost(ctx.data.bindings.DB, post.id, {
    contentHtml: html,
    contentSource: source?.mediaType === "text/markdown" && source.content ? String(source.content) : htmlToText(html),
    title: post.title === null ? null : String((object as { name?: unknown }).name ?? post.title),
    spoilerText: post.spoilerText,
    sensitive: (object as { sensitive?: boolean | null }).sensitive ?? post.sensitive,
    linkUrl: post.linkUrl,
  });
  // A poll's counts change as people vote.
  if (object instanceof Question) await savePollFrom(ctx.data.bindings.DB, post.id, object).catch(() => undefined);
  if (!via.community) await relayIfLocalCommunity(ctx, post, update);
}

async function onDelete(ctx: Ctx, del: Delete, via: Via): Promise<void> {
  const objectId = del.objectId;
  if (!objectId || !del.actorId) return;
  // An account deleting itself: palm keeps the row (posts point at it) and
  // drops its posts and follows.
  if (objectId.href === del.actorId.href) {
    const account = await accountByApId(ctx.data.bindings.DB, objectId.href);
    if (account?.apId) await forgetRemoteAccount(ctx.data.bindings.DB, account.id, account.apId);
    return;
  }
  const post = await postFor(ctx, objectId);
  if (!post?.apId) return;
  const actor = await ensureAccount(ctx, del.actorId);
  // Its author, or (through a community's Announce) the community's moderators, may delete it.
  if (actor?.id !== post.accountId && (!via.community || via.community.id !== post.communityId)) return;
  await deletePost(ctx.data.bindings.DB, post.id);
  if (!via.community) await relayIfLocalCommunity(ctx, post, del);
}

async function onVote(ctx: Ctx, activity: Like | Dislike, via: Via): Promise<void> {
  const post = await postFor(ctx, activity.objectId);
  if (!post || !activity.actorId) return;
  const voter = await ensureAccount(ctx, activity.actorId);
  if (!voter) return;
  const db = ctx.data.bindings.DB;
  const score = activity instanceof Dislike ? -1 : 1;
  await vote(db, post.id, voter.id, score);
  const author = await localAuthorOf(ctx, post);
  // A favourite on Mastodon, an upvote on Lemmy: only Mastodon apps show these.
  if (author && score === 1 && !post.communityId) await notify(db, { accountId: author, kind: "favourite", fromAccountId: voter.id, postId: post.id });
  if (!via.community) await relayIfLocalCommunity(ctx, post, activity);
}

async function onAnnounce(ctx: Ctx, announce: Announce): Promise<void> {
  if (!announce.actorId) return;
  const db = ctx.data.bindings.DB;
  const actor = await ensureActor(ctx, announce.actorId);
  if (!actor) return;
  if ("community" in actor) {
    // A Lemmy community passing on something that happened in it.
    const inner = await announce.getObject({ crossOrigin: "trust" }).catch(() => null);
    if (inner instanceof Activity && !(await refused(ctx, inner))) await dispatch(ctx, inner, { community: actor.community });
    return;
  }
  // A boost. Keep it if someone here follows the booster, or it's a local post.
  const booster = actor.account;
  let post = await postFor(ctx, announce.objectId);
  if (!post && (await hasLocalFollowers(db, booster.id))) {
    const object = await announce.getObject({ crossOrigin: "trust" }).catch(() => null);
    if (object) post = await storeRemotePost(ctx, object, { required: true });
  }
  if (!post) return;
  await boost(db, post.id, booster.id, announce.id?.href ?? null);
  const author = await localAuthorOf(ctx, post);
  if (author) await notify(db, { accountId: author, kind: "reblog", fromAccountId: booster.id, postId: post.id });
}

async function onUndo(ctx: Ctx, undo: Undo, via: Via): Promise<void> {
  const db = ctx.data.bindings.DB;
  if (!undo.actorId) return;
  const object = await undo.getObject({ crossOrigin: "trust" }).catch(() => null);
  if (!(object instanceof Activity)) return;
  // Only the one who did it can undo it.
  if (object.actorId?.href !== undo.actorId.href) return;
  if (object instanceof Follow && object.objectId) {
    const target = await ensureActor(ctx, object.objectId);
    if (target && "account" in target) await removeFollower(db, target.account.id, undo.actorId.href);
    if (target && "community" in target) await removeCommunityFollower(db, target.community.id, undo.actorId.href);
  } else if (object instanceof Like || object instanceof Dislike) {
    const post = await postFor(ctx, object.objectId);
    const voter = await ensureAccount(ctx, undo.actorId);
    if (post && voter) await vote(db, post.id, voter.id, 0);
    if (!via.community) await relayIfLocalCommunity(ctx, post, undo);
  } else if (object instanceof Announce && object.id) {
    const booster = await ensureAccount(ctx, undo.actorId);
    if (booster) await unboostByApId(db, object.id.href, booster.id);
  }
}

/** Handles one activity, received directly or unwrapped from a community's Announce. */
async function dispatch(ctx: Ctx, activity: Activity, via: Via): Promise<void> {
  try {
    if (activity instanceof Create) await onCreate(ctx, activity, via);
    else if (activity instanceof Update) await onUpdate(ctx, activity, via);
    else if (activity instanceof Delete) await onDelete(ctx, activity, via);
    else if (activity instanceof Like || activity instanceof Dislike) await onVote(ctx, activity, via);
    else if (activity instanceof Undo) await onUndo(ctx, activity, via);
    else if (activity instanceof Announce && !via.community) await onAnnounce(ctx, activity);
  } catch (error) {
    logProblem("inbox_failed", { activity: activity.id?.href, type: activity.constructor.name, error: String(error) });
    throw error;
  }
}

const direct: Via = { community: null };

/**
 * Activities from blocked servers, or from people banned here, are dropped
 * before palm reads them further.
 */
async function refused(ctx: Ctx, activity: Activity): Promise<boolean> {
  const actor = activity.actorId;
  if (!actor) return true;
  const db = ctx.data.bindings.DB;
  if (await isBlockedHost(db, actor.host)) return true;
  const known = await accountByApId(db, actor.href);
  return known?.banned ?? false;
}

/** Wraps a listener so refused activities never reach it. */
const gated =
  <A extends Activity>(handler: (ctx: InboxContext<RequestContext>, activity: A) => Promise<void>) =>
  async (ctx: InboxContext<RequestContext>, activity: A) => {
    if (await refused(ctx, activity)) return;
    await handler(ctx, activity);
  };

/**
 * A remote account moved. If the new account names the old one as an alias,
 * local followers of the old one follow the new one instead, as Mastodon does.
 */
async function onMove(ctx: Ctx, move: Move): Promise<void> {
  const old = move.actorId;
  const targetId = move.targetId;
  if (!old || !targetId || move.objectId?.href !== old.href) return;
  const db = ctx.data.bindings.DB;
  const from = await accountByApId(db, old.href);
  if (!from) return;
  const target = await ctx.lookupObject(targetId).catch(() => null);
  const aliases = target && "aliasIds" in target ? (target.aliasIds as URL[]) : [];
  if (!target || !aliases.some((u) => u.href === old.href)) return;
  const moved = await ensureActor(ctx, target);
  if (!moved || !("account" in moved) || moved.account.id === from.id) return;
  const to = moved.account;
  await setMovedTo(db, from.id, targetId.href);
  for (const id of await localFollowersOf(db, from.id)) {
    const local = await accountById(db, id);
    if (!local) continue;
    await unfollow(db, id, from.id);
    if (await followState(db, id, to.id)) continue;
    const followApId = `${urls.user(local.domain, local.username)}#follows/${to.id}-${Date.now()}`;
    await followAccount(db, id, to.id, to.apId || to.locked ? { followApId } : undefined);
    ctx.data.activities.enqueue({ kind: "followed", accountId: id, targetId: to.id, followApId, undo: false });
  }
}

/** Registers palm's inbox listeners on a federation builder. */
export function registerInbox(
  builder: FederationBuilder<RequestContext>,
  inboxPath: `${string}{identifier}${string}`,
  sharedInboxPath?: string,
): void {
  const listeners = sharedInboxPath ? builder.setInboxListeners(inboxPath, sharedInboxPath) : builder.setInboxListeners(inboxPath);
  listeners
    .on(Follow, gated<Follow>((ctx, follow) => onFollow(ctx, follow)))
    .on(Accept, gated<Accept>((ctx, accept) => onAccept(ctx, accept)))
    .on(Reject, gated<Reject>((ctx, reject) => onReject(ctx, reject)))
    .on(Create, gated<Create>((ctx, create) => dispatch(ctx, create, direct)))
    .on(Update, gated<Update>((ctx, update) => dispatch(ctx, update, direct)))
    .on(Delete, gated<Delete>((ctx, del) => dispatch(ctx, del, direct)))
    .on(Like, gated<Like>((ctx, like) => dispatch(ctx, like, direct)))
    .on(Dislike, gated<Dislike>((ctx, dislike) => dispatch(ctx, dislike, direct)))
    .on(Undo, gated<Undo>((ctx, undo) => dispatch(ctx, undo, direct)))
    .on(Announce, gated<Announce>((ctx, announce) => onAnnounce(ctx, announce)))
    .on(Flag, gated<Flag>((ctx, flag) => onFlag(ctx, flag)))
    .on(Move, gated<Move>((ctx, move) => onMove(ctx, move)))
    .on(QuoteRequest, gated<QuoteRequest>((ctx, request) => onQuoteRequest(ctx, request)));
}

/**
 * A report from another server about posts here: each local post it names
 * becomes a report for the admins and the community's moderators.
 */
async function onFlag(ctx: Ctx, flag: Flag): Promise<void> {
  if (!flag.actorId) return;
  const reporter = await ensureAccount(ctx, flag.actorId).catch(() => null);
  if (!reporter) return;
  const db = ctx.data.bindings.DB;
  const reason = String(flag.content ?? "").slice(0, 2000) || "(no reason given)";
  for (const id of flag.objectIds) {
    const post = await postFor(ctx, id);
    if (post && post.apId === null) {
      await createReport(db, { reporterId: reporter.id, postId: post.id, accountId: post.accountId, reason, apId: flag.id?.href ?? null });
    }
  }
}
