import type { Context } from "@fedify/fedify";
import {
  Accept,
  Activity,
  Announce,
  Create,
  Delete,
  Dislike,
  Block,
  Flag,
  Follow,
  Like,
  Move,
  Note,
  QuoteRequest,
  Reject,
  type Object as APObject,
  PUBLIC_COLLECTION,
  traverseCollection,
  Undo,
  Update,
  type Recipient,
} from "@fedify/fedify/vocab";
import type { ActivitySink, FederationTask, RequestContext, Resolved } from "@palm/core";
import {
  pollChoices,
  postById,
  postByUri,
  setQuoteState,
  clearFollowers,
  markMoveSent,
  reportById,
  followState,
  accountById,
  blockedDomains,
  communityById,
  communityFollowers,
  followers,
  notify,
  type Account,
  type Community,
} from "@palm/db";
import { actorUri, communityUri, createFor, followersUri, objectFor, postParts, postUri, quoteRequestId, tombstoneFor, type PostParts } from "./objects.ts";
import type { QueueBody } from "./queue.ts";
import { backfillProfile, backfillThread, resolve as resolveRemote, storeRemotePost } from "./remote.ts";
import { cardForPost } from "./cards.ts";
import { communitySenderKeys, contextsFor, federationsFor, localDomains, logProblem, personKeys, recipient, recipientOf, send } from "./shared.ts";
import { personFor } from "./people.ts";

const isLocal = (a: { apId: string | null }) => a.apId === null;

/** Recipients, without repeats, and without anyone palm can't reach. */
function unique(recipients: (Recipient | null)[]): Recipient[] {
  const seen = new Set<string>();
  return recipients.filter((r): r is Recipient => {
    if (!r?.id || seen.has(r.id.href)) return false;
    seen.add(r.id.href);
    return true;
  });
}

/** Leaves out recipients on blocked servers. */
async function allowed(db: D1Database, recipients: Recipient[]): Promise<Recipient[]> {
  const blocked = await blockedDomains(db);
  if (!blocked.length) return recipients;
  return recipients.filter((r) => {
    const host = r.id?.host.toLowerCase() ?? "";
    return !blocked.some((d) => host === d || host.endsWith(`.${d}`));
  });
}

/**
 * A local community passes an activity on to its followers on other servers,
 * wrapped in an Announce, as Lemmy communities do.
 */
export async function announceToCommunity(ctx: RequestContext, community: Community, activity: Activity): Promise<void> {
  const members = await allowed(ctx.bindings.DB, (await communityFollowers(ctx.bindings.DB, community.id)).map(recipient));
  if (!members.length) return;
  const { communities } = await contextsFor(ctx);
  const id = communityUri(community);
  await send(communities, 
    await communitySenderKeys(communities, community),
    members,
    new Announce({
      id: new URL(`${id.href}#announces/${crypto.randomUUID()}`),
      actor: id,
      object: activity,
      tos: [PUBLIC_COLLECTION],
      ccs: [new URL(`${id.href}/followers`)],
    }),
    { preferSharedInbox: true },
  );
}

/** The remote people a post concerns directly: those it mentions or answers. */
const concerned = (parts: PostParts) =>
  [...parts.mentions, ...(parts.parent ? [parts.parent.author] : [])].filter((a) => !isLocal(a) && a.id !== parts.author.id).map(recipientOf);

/**
 * Sends an activity about a post where it belongs: a local community's posts
 * through the community, a remote community's to it, and statuses to the
 * author's followers. Those it mentions or answers get it directly.
 */
async function sendAboutPost(ctx: RequestContext, parts: PostParts, activity: Activity): Promise<void> {
  const db = ctx.bindings.DB;
  const { people } = await contextsFor(ctx);
  const keys = await personKeys(people, parts.author);
  const { community, post } = parts;
  let recipients: (Recipient | null)[] = concerned(parts);
  if (community && isLocal(community)) {
    await announceToCommunity(ctx, community, activity);
  } else if (community) {
    recipients.unshift(recipientOf(community));
  } else if (post.visibility !== "direct") {
    recipients = [...(await followers(db, parts.author.id)).map(recipient), ...recipients];
  }
  const to = await allowed(db, unique(recipients));
  if (to.length) await send(people, keys, to, activity, { preferSharedInbox: true });
}

/** Local notifications for a local post: replies to and mentions of local accounts. */
async function notifyLocally(ctx: RequestContext, parts: PostParts): Promise<void> {
  const db = ctx.bindings.DB;
  const told = new Set<number>();
  for (const m of parts.mentions) {
    if (isLocal(m)) {
      await notify(db, { accountId: m.id, kind: "mention", fromAccountId: parts.author.id, postId: parts.post.id });
      told.add(m.id);
    }
  }
  const parentAuthor = parts.parent?.author;
  if (parentAuthor && isLocal(parentAuthor) && !told.has(parentAuthor.id)) {
    await notify(db, { accountId: parentAuthor.id, kind: "reply", fromAccountId: parts.author.id, postId: parts.post.id });
  }
}

const voteId = (voter: Account, postId: number, score: number) =>
  new URL(`${actorUri(voter).href}#${score > 0 ? "likes" : "dislikes"}/${postId}`);

/** Runs one federation task. */
export async function runTask(ctx: RequestContext, task: FederationTask): Promise<void> {
  const db = ctx.bindings.DB;
  const { people } = await contextsFor(ctx);
  switch (task.kind) {
    case "post_created":
    case "post_updated":
    case "post_deleted": {
      const parts = await postParts(db, task.postId);
      if (!parts || !isLocal(parts.author)) return;
      if (task.kind === "post_created") await notifyLocally(ctx, parts);
      if (task.kind !== "post_deleted") ctx.waitUntil(cardForPost(db, parts.post).catch(() => undefined));
      const object = objectFor(parts);
      const { toIds: tos, ccIds: ccs } = object;
      const id = postUri(parts.post, parts.author);
      const activity =
        task.kind === "post_created"
          ? createFor(parts)
          : task.kind === "post_updated"
            ? new Update({ id: new URL(`${id.href}#updates/${Date.now()}`), actor: actorUri(parts.author), tos, ccs, object })
            : new Delete({ id: new URL(`${id.href}#delete`), actor: actorUri(parts.author), tos, ccs, object: tombstoneFor(parts) });
      await sendAboutPost(ctx, parts, activity);
      if (task.kind === "post_created") await requestQuote(ctx, people, parts, object);
      return;
    }
    case "voted": {
      const [parts, voter] = await Promise.all([postParts(db, task.postId), accountById(db, task.accountId)]);
      if (!parts || !voter || !isLocal(voter)) return;
      // A favourite on a status shows in Mastodon apps' notifications.
      if (isLocal(parts.author) && task.score === 1 && !parts.community) {
        await notify(db, { accountId: parts.author.id, kind: "favourite", fromAccountId: voter.id, postId: parts.post.id });
      }
      const object = postUri(parts.post, parts.author);
      const audience = parts.community ? { audience: communityUri(parts.community) } : {};
      const tos = [parts.community ? communityUri(parts.community) : actorUri(parts.author)];
      const make = (score: number) =>
        score > 0
          ? new Like({ id: voteId(voter, parts.post.id, 1), actor: actorUri(voter), object, tos, ...audience })
          : new Dislike({ id: voteId(voter, parts.post.id, -1), actor: actorUri(voter), object, tos, ...audience });
      const activities: Activity[] = [];
      // Changing a vote undoes the old one first; Lemmy also takes a new vote as replacing the old.
      if (task.previous !== 0 && task.previous !== task.score) {
        const old = make(task.previous);
        activities.push(new Undo({ id: new URL(`${old.id!.href}/undo/${Date.now()}`), actor: actorUri(voter), object: old, tos, ...audience }));
      }
      if (task.score !== 0) activities.push(make(task.score));
      const keys = await personKeys(people, voter);
      for (const activity of activities) {
        if (parts.community && isLocal(parts.community)) await announceToCommunity(ctx, parts.community, activity);
        const to = await allowed(db, unique([
          parts.community && !isLocal(parts.community) ? recipientOf(parts.community) : null,
          isLocal(parts.author) ? null : recipientOf(parts.author),
        ]));
        if (to.length) await send(people, keys, to, activity, { preferSharedInbox: true });
      }
      return;
    }
    case "boosted": {
      const [parts, booster] = await Promise.all([postParts(db, task.postId), accountById(db, task.accountId)]);
      if (!parts || !booster || !isLocal(booster)) return;
      if (isLocal(parts.author) && !task.undo) {
        await notify(db, { accountId: parts.author.id, kind: "reblog", fromAccountId: booster.id, postId: parts.post.id });
      }
      const announce = new Announce({
        id: new URL(`${actorUri(booster).href}#announces/${parts.post.id}`),
        actor: actorUri(booster),
        object: postUri(parts.post, parts.author),
        tos: [PUBLIC_COLLECTION],
        ccs: [followersUri(booster), actorUri(parts.author)],
      });
      const activity = task.undo
        ? new Undo({ id: new URL(`${announce.id!.href}/undo/${Date.now()}`), actor: actorUri(booster), object: announce, tos: [PUBLIC_COLLECTION] })
        : announce;
      const to = await allowed(db, unique([...(await followers(db, booster.id)).map(recipient), isLocal(parts.author) ? null : recipientOf(parts.author)]));
      if (to.length) await send(people, await personKeys(people, booster), to, activity, { preferSharedInbox: true });
      return;
    }
    case "followed": {
      const [account, target] = await Promise.all([accountById(db, task.accountId), accountById(db, task.targetId)]);
      if (!account || !target || !isLocal(account)) return;
      if (isLocal(target)) {
        if (!task.undo) {
          const state = await followState(db, account.id, target.id);
          await notify(db, { accountId: target.id, kind: state?.state === "pending" ? "follow_request" : "follow", fromAccountId: account.id });
        }
        return;
      }
      // A follow, unfollow and follow again leave several of these queued, and
      // a retried old one can arrive after a newer one: an old Undo would
      // then end the new follow. Only the current state goes out.
      const current = await followState(db, account.id, target.id);
      if (task.undo ? current !== null : current?.followApId !== task.followApId) return;
      const follow = new Follow({ id: new URL(task.followApId), actor: actorUri(account), object: actorUri(target) });
      const activity = task.undo ? new Undo({ id: new URL(`${task.followApId}/undo`), actor: actorUri(account), object: follow }) : follow;
      const to = recipientOf(target);
      if (to) await send(people, await personKeys(people, account), to, activity);
      return;
    }
    case "poll_voted": {
      const [parts, voter, choices] = await Promise.all([postParts(db, task.postId), accountById(db, task.accountId), pollChoices(db, task.accountId, [task.postId])]);
      if (!parts?.poll || !voter || !isLocal(voter) || isLocal(parts.author)) return;
      const to = recipientOf(parts.author);
      if (!to) return;
      const question = postUri(parts.post, parts.author);
      const keys = await personKeys(people, voter);
      for (const choice of choices.get(task.postId) ?? []) {
        const title = parts.poll.options[choice]?.title;
        if (!title) continue;
        const id = new URL(`${actorUri(voter).href}#votes/${task.postId}/${choice}`);
        const note = new Note({ id, name: title, replyTarget: question, attribution: actorUri(voter), to: actorUri(parts.author) });
        await send(people, keys, to, new Create({ id: new URL(`${id.href}/activity`), actor: actorUri(voter), to: actorUri(parts.author), object: note }));
      }
      return;
    }
    case "reported": {
      const report = await reportById(db, task.reportId);
      const [reporter, parts] = report?.postId ? await Promise.all([accountById(db, report.reporterId), postParts(db, report.postId)]) : [null, null];
      if (!report || !reporter || !parts || !isLocal(reporter) || isLocal(parts.author)) return;
      // Lemmy wants reports at the community; Mastodon at the author's server.
      const to = parts.community && !isLocal(parts.community) ? recipientOf(parts.community) : recipientOf(parts.author);
      if (!to) return;
      const flag = new Flag({
        id: new URL(`${actorUri(reporter).href}#reports/${report.id}`),
        actor: actorUri(reporter),
        objects: [postUri(parts.post, parts.author), actorUri(parts.author)],
        content: report.reason,
        ...(parts.community ? { audience: communityUri(parts.community) } : {}),
      });
      await send(people, await personKeys(people, reporter), to, flag);
      return;
    }
    case "follow_answered": {
      const [account, follower] = await Promise.all([accountById(db, task.accountId), accountById(db, task.followerId)]);
      if (!account || !follower || !isLocal(account) || isLocal(follower)) return;
      const values = { id: new URL(`${actorUri(account).href}#${task.accept ? "accepts" : "rejects"}/${crypto.randomUUID()}`), actor: actorUri(account), object: new URL(task.followId) };
      const to = recipientOf(follower);
      if (to) await send(people, await personKeys(people, account), to, task.accept ? new Accept(values) : new Reject(values));
      return;
    }
    case "blocked": {
      // Mastodon hides a blocker's posts from the blocked and drops their follows.
      const [account, target] = await Promise.all([accountById(db, task.accountId), accountById(db, task.targetId)]);
      if (!account || !target || !isLocal(account) || isLocal(target)) return;
      const block = new Block({ id: new URL(task.blockApId), actor: actorUri(account), object: actorUri(target) });
      const activity = task.undo ? new Undo({ id: new URL(`${task.blockApId}/undo`), actor: actorUri(account), object: block }) : block;
      const to = recipientOf(target);
      if (to) await send(people, await personKeys(people, account), to, activity);
      return;
    }
    case "subscribed": {
      const [account, community] = await Promise.all([accountById(db, task.accountId), communityById(db, task.communityId)]);
      if (!account || !community || !isLocal(account) || isLocal(community)) return;
      const follow = new Follow({ id: new URL(task.followApId), actor: actorUri(account), object: communityUri(community) });
      const activity = task.undo ? new Undo({ id: new URL(`${task.followApId}/undo`), actor: actorUri(account), object: follow }) : follow;
      const to = recipientOf(community);
      if (to) await send(people, await personKeys(people, account), to, activity);
      return;
    }
    case "profile_updated": {
      const account = await accountById(db, task.accountId);
      if (!account || !isLocal(account)) return;
      const person = await personFor(people, account);
      const to = await allowed(db, (await followers(db, account.id)).map(recipient));
      if (person && to.length) {
        await send(people, 
          await personKeys(people, account),
          to,
          new Update({ id: new URL(`${actorUri(account).href}#updates/${Date.now()}`), actor: actorUri(account), tos: [PUBLIC_COLLECTION], object: person }),
          { preferSharedInbox: true },
        );
      }
      return;
    }
    case "card": {
      const post = await postById(db, task.postId);
      if (post) await cardForPost(db, post);
      return;
    }
    case "moved": {
      const account = await accountById(db, task.accountId);
      if (!account || !isLocal(account) || !account.movedTo) return;
      const to = await allowed(db, (await followers(db, account.id)).map(recipient));
      if (to.length) {
        await send(people,
          await personKeys(people, account),
          to,
          new Move({ id: new URL(`${actorUri(account).href}#moves/${Date.now()}`), actor: actorUri(account), object: actorUri(account), target: new URL(account.movedTo), tos: [followersUri(account)] }),
          { preferSharedInbox: true },
        );
      }
      await markMoveSent(db, account.id);
      return;
    }
    case "account_deleted": {
      const account = await accountById(db, task.accountId);
      if (!account || !isLocal(account) || !account.deleted) return;
      const to = await allowed(db, (await followers(db, account.id)).map(recipient));
      if (to.length) {
        await send(people,
          await personKeys(people, account),
          to,
          new Delete({ id: new URL(`${actorUri(account).href}#delete`), actor: actorUri(account), object: actorUri(account), tos: [PUBLIC_COLLECTION] }),
          { preferSharedInbox: true },
        );
      }
      await clearFollowers(db, account.id);
      return;
    }
    case "backfill": {
      const community = await communityById(db, task.communityId);
      if (!community?.outboxUrl) return;
      const outbox = await people.lookupObject(community.outboxUrl).catch(() => null);
      if (!outbox || !("getFirst" in outbox)) return;
      let count = 0;
      for await (const item of traverseCollection(outbox as Parameters<typeof traverseCollection>[0], {
        documentLoader: people.documentLoader,
        contextLoader: people.contextLoader,
      })) {
        if (++count > 25) break;
        // Lemmy's outbox holds the community's Announces of Creates.
        const inner = item instanceof Announce ? await item.getObject({ crossOrigin: "trust" }).catch(() => null) : item;
        const object = inner instanceof Create ? await inner.getObject({ crossOrigin: "trust" }).catch(() => null) : null;
        if (object) await storeRemotePost(people, object, { community }).catch(() => null);
      }
      return;
    }
  }
}

/**
 * Handles one message from palm's queue. `contextFor` builds the request
 * context for a domain, or returns null for one this deployment doesn't serve.
 */
export async function processQueueMessage(body: QueueBody, contextFor: (domain: string) => RequestContext | null): Promise<void> {
  if (body.palm === "task") {
    const ctx = contextFor(body.domain);
    if (ctx) await runTask(ctx, body.task);
    return;
  }
  if (body.palm !== "fedify") return;
  // Fedify's messages carry the origin they were made for.
  const baseUrl = (body.message as { baseUrl?: string }).baseUrl;
  const ctx = baseUrl ? contextFor(new URL(baseUrl).host) : null;
  if (!ctx) return;
  const federations = await federationsFor(ctx.bindings);
  const federation = federations[body.federation];
  await federation.processQueuedTask(ctx, body.message as Parameters<typeof federation.processQueuedTask>[1]);
}

/**
 * Federation as the client adapters see it. With a queue, a request only
 * enqueues a task; without one, the work runs after the response.
 */
export function activitySink(ctx: RequestContext): ActivitySink {
  return {
    enqueue(task) {
      const queue = ctx.bindings.QUEUE;
      // When the queue refuses (the free plan's daily operations are used
      // up), the task runs here instead of being lost.
      const work = queue
        ? queue.send({ palm: "task", domain: ctx.domain.domain, task } satisfies QueueBody).catch((error: unknown) => {
            logProblem("queue_send_failed", { task: task.kind, error: String(error) });
            return runTask(ctx, task);
          })
        : runTask(ctx, task);
      ctx.waitUntil(work.catch((error: unknown) => logProblem("task_failed", { task: task.kind, error: String(error) })));
    },
    async resolve(query): Promise<Resolved | null> {
      const { people } = await contextsFor(ctx);
      return resolveRemote(people, query);
    },
    async backfillThread(postId) {
      const { people } = await contextsFor(ctx);
      await waitAWhile(
        ctx,
        backfillThread(people, postId).catch((error: unknown) => logProblem("thread_backfill_failed", { postId, error: String(error) })),
      );
    },
    async backfillProfile(accountId) {
      const { people } = await contextsFor(ctx);
      await waitAWhile(
        ctx,
        backfillProfile(people, accountId).catch((error: unknown) => logProblem("profile_backfill_failed", { accountId, error: String(error) })),
      );
    },
  };
}

/** How long an app waits on a fetch from another server before getting what palm has. */
const BACKFILL_WAIT_MS = 2500;

/**
 * Waits for `work` up to BACKFILL_WAIT_MS, and lets it finish after the
 * response if it takes longer: a slow server (one profile took 26 seconds)
 * then delays the app by seconds, and the posts show on the next refresh.
 */
async function waitAWhile(ctx: RequestContext, work: Promise<void>): Promise<void> {
  ctx.waitUntil(work);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, BACKFILL_WAIT_MS)))]);
  if (timer !== undefined) clearTimeout(timer);
}

/**
 * A new post quoting another server's post asks that post's author for
 * approval (Mastodon 4.5); the answer arrives as an Accept or a Reject
 * (answerQuote in inbox.ts). Until then the quote shows as pending.
 */
async function requestQuote(ctx: RequestContext, people: Context<RequestContext>, parts: PostParts, object: APObject): Promise<void> {
  const { post, author } = parts;
  if (!post.quoteOf || (post.quoteState !== null && post.quoteState !== "pending")) return;
  const quotedId = new URL(post.quoteOf);
  if (localDomains(ctx).includes(quotedId.host.toLowerCase())) return;
  const db = ctx.bindings.DB;
  const quoted = await postByUri(db, quotedId.href, localDomains(ctx));
  const quotedAuthor = quoted ? await accountById(db, quoted.accountId) : null;
  const to = quotedAuthor ? recipientOf(quotedAuthor) : null;
  if (!to) return;
  await setQuoteState(db, post.id, "pending");
  const id = postUri(post, author);
  await send(
    people,
    await personKeys(people, author),
    to,
    new QuoteRequest({ id: quoteRequestId(id), actor: actorUri(author), object: quotedId, instrument: object }),
  );
}
