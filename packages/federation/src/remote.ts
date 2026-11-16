import type { Context } from "@fedify/fedify";
import {
  Application,
  Article,
  ChatMessage,
  Create,
  traverseCollection,
  Document,
  Group,
  Hashtag,
  Image,
  Link,
  Mention,
  Note,
  Organization,
  Page,
  Person,
  PUBLIC_COLLECTION,
  Question,
  Service,
  Video,
  type Object as APObject,
} from "@fedify/fedify/vocab";
import { htmlToText, markdownToHtml, sanitizeHtml, type RequestContext } from "@palm/core";
import {
  accountByApId,
  accountByHandle,
  accountById,
  savePoll,
  setQuote,
  accountForLogin,
  claimThreadRefresh,
  markOutboxFetched,
  postById,
  addMentions,
  addTags,
  communityByApId,
  communityByName,
  createPost,
  hasLocalFollowers,
  hasLocalSubscribers,
  isBlockedHost,
  notify,
  postByApId,
  postByUri,
  upsertRemoteAccount,
  upsertRemoteCommunity,
  vote,
  type Account,
  type Community,
  type Post,
  type RemoteAttachment,
  type Visibility,
} from "@palm/db";
import { cardForPost } from "./cards.ts";
import { localDomains, logProblem } from "./shared.ts";

/** How long palm trusts what it fetched about a remote actor. */
const ACTOR_TTL_SECONDS = 3 * 24 * 60 * 60;
const now = () => Math.floor(Date.now() / 1000);

const hrefOf = (value: URL | Link | null | undefined): string | null =>
  value instanceof URL ? value.href : value instanceof Link ? (value.href?.href ?? null) : null;

/** Collects an async iterable, stopping at `limit` items. */
async function collect<T>(items: AsyncIterable<T>, limit = 50): Promise<T[]> {
  const out: T[] = [];
  try {
    for await (const item of items) {
      out.push(item);
      if (out.length >= limit) break;
    }
  } catch {
    // An attachment or tag palm can't read is left out.
  }
  return out;
}

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

/** A local account or community from one of this deployment's URLs. */
async function localActor(ctx: RequestContext, url: URL): Promise<{ account: Account } | { community: Community } | null> {
  const host = url.host.toLowerCase();
  if (!localDomains(ctx).includes(host)) return null;
  const user = url.pathname.match(/^\/users\/([^/]+)$/);
  if (user) {
    const found = await accountForLogin(ctx.bindings.DB, host, decodeURIComponent(user[1]!));
    return found ? { account: found.account } : null;
  }
  const group = url.pathname.match(/^\/c\/([^/]+)$/);
  if (group) {
    const found = await communityByName(ctx.bindings.DB, host, decodeURIComponent(group[1]!));
    return found && found.apId === null ? { community: found } : null;
  }
  return null;
}

/** Records a fetched Person, Service, Group and so on, and returns palm's row for it. */
async function recordActor(ctx: RequestContext, actor: APObject): Promise<{ account: Account } | { community: Community } | null> {
  const db = ctx.bindings.DB;
  if (!actor.id) return null;
  const isPerson = actor instanceof Person || actor instanceof Service || actor instanceof Application || actor instanceof Organization;
  if (!isPerson && !(actor instanceof Group)) return null;
  const a = actor as Person | Group;
  const username = a.preferredUsername?.toString();
  const inbox = a.inboxId?.href;
  if (!username || !inbox) return null;
  const icon = await a.getIcon().catch(() => null);
  const image = await a.getImage().catch(() => null);
  const common = {
    apId: actor.id.href,
    domain: actor.id.host,
    inbox,
    sharedInbox: a.endpoints?.sharedInbox?.href ?? null,
    profileUrl: hrefOf(a.url) ,
  };
  if (actor instanceof Group) {
    return {
      community: await upsertRemoteCommunity(db, {
        ...common,
        name: username,
        title: text(a.name) ?? username,
        description: text(a.summary),
        nsfw: a.sensitive ?? false,
        iconUrl: hrefOf(icon?.url),
        bannerUrl: hrefOf(image?.url),
        outboxUrl: a.outboxId?.href ?? null,
      }),
    };
  }
  // The profile's counts live on its server, on its collections.
  const total = async (get: () => Promise<{ totalItems: number | null } | null>) => {
    try {
      return (await get())?.totalItems ?? null;
    } catch {
      return null;
    }
  };
  const person = a as Person;
  const [followersCount, followingCount, statusesCount] = await Promise.all([
    total(() => person.getFollowers()),
    total(() => person.getFollowing()),
    total(() => person.getOutbox()),
  ]);
  return {
    account: await upsertRemoteAccount(db, {
      ...common,
      username,
      displayName: text(a.name),
      bio: a.summary ? sanitizeHtml(String(a.summary)) : null,
      avatarUrl: hrefOf(icon?.url),
      headerUrl: hrefOf(image?.url),
      actorType: actor instanceof Service ? "Service" : actor instanceof Group ? "Group" : "Person",
      outboxUrl: a.outboxId?.href ?? null,
      followersCount,
      followingCount,
      statusesCount,
    }),
  };
}

/**
 * The account or community behind an actor ID, fetching it if palm hasn't
 * met it or last fetched it a while ago. Local URLs resolve to local rows.
 */
export async function ensureActor(
  fctx: Context<RequestContext>,
  ref: URL | APObject | null | undefined,
): Promise<{ account: Account } | { community: Community } | null> {
  const ctx = fctx.data;
  const db = ctx.bindings.DB;
  const id = ref instanceof URL ? ref : ref?.id;
  if (!id) return null;
  const local = await localActor(ctx, id);
  if (local) return local;
  const [account, community] = await Promise.all([accountByApId(db, id.href), communityByApId(db, id.href)]);
  const known = account ? { account } : community ? { community } : null;
  const fetchedAt = account?.fetchedAt ?? community?.fetchedAt ?? 0;
  if (known && now() - fetchedAt < ACTOR_TTL_SECONDS && ref instanceof URL) return known;
  try {
    const actor = ref instanceof URL ? await fctx.lookupObject(id) : ref;
    return (actor && (await recordActor(ctx, actor))) ?? known;
  } catch (error) {
    logProblem("actor_fetch_failed", { id: id.href, error: String(error) });
    return known;
  }
}

export async function ensureAccount(fctx: Context<RequestContext>, ref: URL | APObject | null | undefined): Promise<Account | null> {
  const found = await ensureActor(fctx, ref);
  return found && "account" in found ? found.account : null;
}

export async function ensureCommunity(fctx: Context<RequestContext>, ref: URL | APObject | null | undefined): Promise<Community | null> {
  const found = await ensureActor(fctx, ref);
  return found && "community" in found ? found.community : null;
}

/** The kinds of object palm keeps as posts. */
const isPostLike = (object: unknown): object is Note | Page | Article | Question | Video =>
  object instanceof Note || object instanceof Page || object instanceof Article || object instanceof Question || object instanceof Video;

/** Mastodon's visibility, read back from a post's addressing. */
function visibilityOf(object: APObject, author: Account): Visibility {
  const to = object.toIds.map((u) => u.href);
  const cc = object.ccIds.map((u) => u.href);
  if (to.includes(PUBLIC_COLLECTION.href)) return "public";
  if (cc.includes(PUBLIC_COLLECTION.href)) return "unlisted";
  const followers = `${author.apId}/followers`;
  return to.includes(followers) || cc.includes(followers) ? "private" : "direct";
}

/** Why palm would keep a received post: someone here cares about it. */
export interface StoreReason {
  /** It came through a community: palm keeps it if someone here subscribes (or the community is local). */
  community?: Community | null;
  /** It was addressed to someone here directly. */
  addressedHere?: boolean;
  /** It's needed as the parent of something palm is keeping. */
  required?: boolean;
}

/**
 * Keeps a remote post if anyone here would see it: it's in a community
 * someone here subscribes to, answers a post palm has, is by someone a local
 * account follows, or mentions a local account. Returns palm's row, or null
 * if it isn't wanted (or can't be read).
 */
export async function storeRemotePost(
  fctx: Context<RequestContext>,
  object: APObject,
  reason: StoreReason = {},
  depth = 0,
): Promise<Post | null> {
  const ctx = fctx.data;
  const db = ctx.bindings.DB;
  if (!object.id || !isPostLike(object)) return null;
  const existing = await postByUri(db, object.id.href, localDomains(ctx));
  if (existing) return existing;

  const author = await ensureAccount(fctx, object.attributionId);
  if (!author) return null;

  // A reply: palm keeps it under its parent, fetching the parent if needed.
  let parent: Post | null = null;
  const parentId = object.replyTargetId;
  if (parentId) {
    parent = await postByUri(db, parentId.href, localDomains(ctx));
    if (!parent && depth < 4) {
      const fetched = await fctx.lookupObject(parentId).catch(() => null);
      if (fetched) parent = await storeRemotePost(fctx, fetched, { ...reason, required: true }, depth + 1);
    }
  }

  // The community: from Lemmy's audience, the thread it's in, or the one it came through.
  let community = reason.community ?? null;
  if (!community && parent?.communityId) community = { id: parent.communityId } as Community;
  if (!community && object.audienceId) community = await ensureCommunity(fctx, object.audienceId);
  if (!community) {
    for (const id of [...object.toIds, ...object.ccIds]) {
      const known = await communityByApId(db, id.href);
      if (known) {
        community = known;
        break;
      }
    }
  }

  const tags = await collect(object.getTags());
  const localMentions: Account[] = [];
  const hashtags = tags.filter((t): t is Hashtag => t instanceof Hashtag).map((t) => String(t.name ?? "")).filter(Boolean);
  for (const tag of tags) {
    if (tag instanceof Mention && tag.href) {
      const found = await ensureAccount(fctx, tag.href).catch(() => null);
      if (found && found.apId === null) localMentions.push(found);
    }
  }
  // A Lemmy private message names its recipient in `to` alone, with no Mention.
  if (object instanceof ChatMessage) {
    for (const id of object.toIds) {
      if (!localDomains(fctx.data).includes(id.host.toLowerCase())) continue;
      const found = await accountByApIdOrLocal(db, id);
      if (found && !localMentions.some((m) => m.id === found.id)) localMentions.push(found);
    }
  }

  const wanted =
    reason.required ||
    reason.addressedHere ||
    parent !== null ||
    localMentions.length > 0 ||
    (community !== null && ("apId" in community ? community.apId === null || (await hasLocalSubscribers(db, community.id)) : true)) ||
    (await hasLocalFollowers(db, author.id));
  if (!wanted) return null;

  const attachments: RemoteAttachment[] = [];
  let linkUrl: string | null = null;
  for (const attachment of await collect(object.getAttachments(), 10)) {
    if (attachment instanceof Link) linkUrl ??= attachment.href?.href ?? null;
    else if (attachment instanceof Document || attachment instanceof Image || attachment instanceof Video) {
      const url = hrefOf(attachment.url);
      if (url) attachments.push({ url, mediaType: attachment.mediaType ?? null, description: text(attachment.name) });
    }
  }
  const isThreadPost = community !== null && !parent;
  // A Lemmy image post: its image is the post's link.
  if (isThreadPost && !linkUrl && attachments[0]?.mediaType?.startsWith("image/")) linkUrl = attachments[0].url;

  const html = sanitizeHtml(text(object.content) ?? "");
  const source = object.source;
  const markdown = source?.mediaType === "text/markdown" && source.content ? String(source.content) : htmlToText(html);
  const title = isThreadPost ? (text(object.name) ?? markdown.split("\n")[0]?.slice(0, 200) ?? "Untitled") : null;

  const rootId = parent ? (parent.rootId ?? (parent.communityId ? parent.id : null)) : null;
  const post = await createPost(db, {
    accountId: author.id,
    contentSource: markdown,
    contentHtml: html,
    spoilerText: object instanceof Page ? "" : (text(object.summary) ?? ""),
    sensitive: object.sensitive ?? false,
    visibility: visibilityOf(object, author),
    language: null,
    inReplyTo: parentId?.href ?? null,
    communityId: community?.id ?? parent?.communityId ?? null,
    title,
    linkUrl,
    rootId: parent?.communityId ? rootId : null,
    parentId: parent?.id ?? null,
    apId: object.id.href,
    url: hrefOf(object.url) ?? object.id.href,
    attachments,
    ...(object.published ? { createdAt: Math.floor(object.published.epochMilliseconds / 1000) } : {}),
    ...(object.updated ? { updatedAt: Math.floor(object.updated.epochMilliseconds / 1000) } : {}),
  }).catch(async (error: unknown) => {
    // Two deliveries of the same post can race; the second finds the first's row.
    const raced = await postByApId(db, object.id!.href);
    if (raced) return raced;
    throw error;
  });

  // Lemmy counts an author's own post or comment as upvoted, without sending a vote for it.
  if (post.communityId) await vote(db, post.id, author.id, 1);
  if (object instanceof Question) await savePollFrom(db, post.id, object).catch(() => undefined);
  const quote = (object as { quoteUrl?: URL | null }).quoteUrl;
  if (quote) await setQuote(db, post.id, quote.href);
  if (localMentions.length) await addMentions(db, post.id, localMentions.map((m) => m.id));
  if (hashtags.length) await addTags(db, post.id, hashtags);
  for (const m of localMentions) await notify(db, { accountId: m.id, kind: "mention", fromAccountId: author.id, postId: post.id });
  if (parent) {
    const parentAuthorLocal = await accountByIdLocal(db, parent.accountId);
    if (parentAuthorLocal && !localMentions.some((m) => m.id === parentAuthorLocal)) {
      await notify(db, { accountId: parentAuthorLocal, kind: "reply", fromAccountId: author.id, postId: post.id });
    }
  }
  // Link previews for posts, not every comment under them; after the response.
  if (!post.rootId) fctx.data.waitUntil(cardForPost(db, post).catch(() => undefined));
  return post;
}

/** A post's author's ID if the author is local, else null. */
/** A remote Question's options and counts, kept as a poll. */
export async function savePollFrom(db: D1Database, postId: number, question: Question): Promise<void> {
  const inclusive = await collect(question.getInclusiveOptions());
  const exclusive = inclusive.length ? [] : await collect(question.getExclusiveOptions());
  const options = [];
  for (const option of inclusive.length ? inclusive : exclusive) {
    const replies = await option.getReplies().catch(() => null);
    options.push({ title: String(option.name ?? ""), votes: replies?.totalItems ?? 0 });
  }
  if (options.length < 2) return;
  const end = question.endTime ?? question.closed;
  await savePoll(db, {
    postId,
    options,
    multiple: inclusive.length > 0,
    expiresAt: end && typeof end === "object" && "epochMilliseconds" in end ? Math.floor(end.epochMilliseconds / 1000) : null,
    votersCount: question.voters ?? null,
  });
}

/** A local person by their actor URL (https://domain/users/name). */
async function accountByApIdOrLocal(db: D1Database, id: URL): Promise<Account | null> {
  const name = id.pathname.match(/^\/users\/([^/]+)$/)?.[1];
  if (!name) return null;
  const found = await accountByHandle(db, decodeURIComponent(name), id.host.toLowerCase());
  return found && found.apId === null ? found : null;
}

async function accountByIdLocal(db: D1Database, id: number): Promise<number | null> {
  const row = await db.prepare("SELECT id FROM accounts WHERE id = ? AND ap_id IS NULL").bind(id).first<{ id: number }>();
  return row?.id ?? null;
}

/**
 * Finds a remote person, community or post from a search: `@name@host` or
 * `name@host` (a person, or a community if there's no person), `!name@host`
 * (a community), or a URL. Records whatever it finds.
 */
export async function resolve(
  fctx: Context<RequestContext>,
  query: string,
): Promise<{ kind: "account"; id: number } | { kind: "community"; id: number } | { kind: "post"; id: number } | null> {
  const q = query.trim();
  const handle = q.match(/^([@!]?)([^@\s/]+)@([^@\s/]+\.[^@\s/]+)$/);
  let lookup: string | null = null;
  // WebFinger finds people and Lemmy communities alike by acct:name@host.
  if (handle) lookup = `@${handle[2]}@${handle[3]}`;
  else if (/^https?:\/\/\S+$/.test(q)) lookup = q;
  if (!lookup) return null;
  const host = handle ? handle[3]! : new URL(q).host;
  // Something on this domain is read from the database: fetching it would mean
  // the Worker fetching itself, which fails.
  if (localDomains(fctx.data).includes(host.toLowerCase())) return resolveLocal(fctx.data, handle ? handle : null, q);
  if (await isBlockedHost(fctx.data.bindings.DB, host)) return null;
  try {
    const object = await fctx.lookupObject(lookup);
    if (!object) return null;
    const actor = await ensureActor(fctx, object);
    if (actor) return "account" in actor ? { kind: "account", id: actor.account.id } : { kind: "community", id: actor.community.id };
    const post = await storeRemotePost(fctx, object, { required: true });
    return post ? { kind: "post", id: post.id } : null;
  } catch (error) {
    logProblem("resolve_failed", { query: q, error: String(error) });
    return null;
  }
}

type Resolved = { kind: "account"; id: number } | { kind: "community"; id: number } | { kind: "post"; id: number };

/** A handle or URL on this domain: a person, a community or a post palm holds. */
async function resolveLocal(ctx: RequestContext, handle: RegExpMatchArray | null, q: string): Promise<Resolved | null> {
  const db = ctx.bindings.DB;
  const person = async (name: string, host: string) => {
    const account = await accountByHandle(db, decodeURIComponent(name), host);
    return account && !account.apId && !account.banned ? ({ kind: "account", id: account.id } as const) : null;
  };
  const community = async (name: string, host: string) => {
    const found = await communityByName(db, host, decodeURIComponent(name).toLowerCase());
    return found && !found.apId ? ({ kind: "community", id: found.id } as const) : null;
  };
  if (handle) {
    const [, sigil, name, host] = handle;
    const domain = host!.toLowerCase();
    if (sigil === "!") return community(name!, domain);
    return (await person(name!, domain)) ?? (sigil === "@" ? null : community(name!, domain));
  }
  const url = new URL(q);
  const domain = url.host.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");
  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/(?:objects|post|comment)\/(\d+)$/)) || (m = path.match(/^\/@[^/]+\/(\d+)$/))) {
    const post = await postById(db, Number(m[1]));
    return post && !post.apId && post.reblogOf === null && (post.visibility === "public" || post.visibility === "unlisted") ? { kind: "post", id: post.id } : null;
  }
  if ((m = path.match(/^\/(?:users|u)\/([^/]+)$/)) || (m = path.match(/^\/@([^/]+)$/))) return person(m[1]!, domain);
  if ((m = path.match(/^\/c\/([^/]+)$/))) return community(m[1]!, domain);
  return null;
}

/** How long a remote profile's posts stay fresh before palm reads its outbox again. */
const OUTBOX_TTL_SECONDS = 6 * 60 * 60;

/**
 * Fills in a remote person's recent public posts, read from their outbox, so
 * their profile isn't empty the first time someone here opens it. Also
 * refreshes their profile and counts if those are stale.
 */
export async function backfillProfile(fctx: Context<RequestContext>, accountId: number): Promise<void> {
  const db = fctx.data.bindings.DB;
  let account = await accountById(db, accountId);
  if (!account?.apId) return;
  if (account.outboxFetchedAt && now() - account.outboxFetchedAt < OUTBOX_TTL_SECONDS) return;
  await markOutboxFetched(db, account.id);
  account = (await ensureAccount(fctx, new URL(account.apId))) ?? account;
  if (!account.outboxUrl) return;
  try {
    const outbox = await fctx.lookupObject(account.outboxUrl);
    if (!outbox || !("getFirst" in outbox)) return;
    let count = 0;
    for await (const item of traverseCollection(outbox as Parameters<typeof traverseCollection>[0], {
      documentLoader: fctx.documentLoader,
      contextLoader: fctx.contextLoader,
    })) {
      if (++count > 20) break;
      // Their own posts; boosts of others' are left out.
      if (!(item instanceof Create)) continue;
      const object = await item.getObject({ crossOrigin: "trust" }).catch(() => null);
      if (object) await storeRemotePost(fctx, object, { required: true }).catch(() => null);
    }
  } catch (error) {
    logProblem("outbox_fetch_failed", { account: account.apId, error: String(error) });
  }
}

/** How long a remote thread's comments stay fresh before palm reads them again. */
const THREAD_TTL_SECONDS = 15 * 60;
/** The most comments palm takes in one refresh. */
const THREAD_LIMIT = 100;

/** A person from another server's API, recorded without fetching their actor (palm does that when it needs to). */
export async function placeholderAccount(
  db: D1Database,
  person: { apId: string; username: string; displayName: string | null; avatarUrl: string | null },
): Promise<Account> {
  const known = await accountByApId(db, person.apId);
  if (known) return known;
  const url = new URL(person.apId);
  const account = await upsertRemoteAccount(db, {
    apId: person.apId,
    domain: url.host,
    username: person.username,
    displayName: person.displayName,
    bio: null,
    // Lemmy and Mastodon both put inboxes here; the actor's own refresh corrects it if not.
    inbox: `${person.apId}/inbox`,
    sharedInbox: `https://${url.host}/inbox`,
    profileUrl: person.apId,
    avatarUrl: person.avatarUrl,
    headerUrl: null,
    actorType: "Person",
    outboxUrl: null,
    followersCount: null,
    followingCount: null,
    statusesCount: null,
  });
  // Marked stale, so the next look at them fetches the real thing.
  await db.prepare("UPDATE accounts SET fetched_at = 0 WHERE id = ?").bind(account.id).run();
  return account;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "palm (+https://github.com/jason-s13r/palm)" } });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

interface LemmyCommentView {
  comment: { id: number; ap_id: string; content: string; published: string; updated?: string; deleted: boolean; removed: boolean; path: string };
  creator: { actor_id: string; name: string; display_name?: string; avatar?: string };
}

interface MastodonStatus {
  id: string;
  uri: string;
  url: string | null;
  in_reply_to_id: string | null;
  content: string;
  created_at: string;
  edited_at: string | null;
  spoiler_text: string;
  sensitive: boolean;
  visibility: "public" | "unlisted" | "private" | "direct";
  account: { uri?: string; url: string; username: string; display_name: string; avatar: string };
}

const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/**
 * Fills in a remote thread's comments that arrived before anyone here was
 * following along. Lemmy doesn't publish a post's replies over ActivityPub,
 * so palm asks the post's own server, as Lemmy apps do: Lemmy's comment list,
 * or Mastodon's context. Anything else, it walks the object's replies.
 */
export async function backfillThread(fctx: Context<RequestContext>, postId: number): Promise<void> {
  const ctx = fctx.data;
  const db = ctx.bindings.DB;
  const root = await postById(db, postId);
  if (!root?.apId || root.rootId !== null) return;
  if (!(await claimThreadRefresh(db, root.id, THREAD_TTL_SECONDS))) return;
  const origin = new URL(root.apId);
  if (await isBlockedHost(db, origin.host)) return;

  const lemmyPost = origin.pathname.match(/^\/post\/(\d+)$/);
  const mastodonStatus = origin.pathname.match(/^\/users\/[^/]+\/statuses\/(\d+)$/);

  if (lemmyPost) {
    const data = await fetchJson<{ comments: LemmyCommentView[] }>(
      `https://${origin.host}/api/v3/comment/list?post_id=${lemmyPost[1]}&max_depth=8&limit=${THREAD_LIMIT}&sort=Old&type_=All`,
    );
    // Parents first: Lemmy's path is "0.<ancestors>.<id>", so sort by depth.
    const comments = (data?.comments ?? []).sort((a, b) => a.comment.path.split(".").length - b.comment.path.split(".").length);
    const apIdByOriginId = new Map(comments.map((c) => [String(c.comment.id), c.comment.ap_id]));
    for (const view of comments) {
      const c = view.comment;
      if (c.deleted || c.removed || (await postByUri(db, c.ap_id, localDomains(ctx)))) continue;
      const ids = c.path.split(".");
      const parentApId = ids.length > 2 ? apIdByOriginId.get(ids[ids.length - 2]!) : root.apId;
      const parent = parentApId ? await postByUri(db, parentApId, localDomains(ctx)) : null;
      if (!parent) continue;
      const author = await placeholderAccount(db, {
        apId: view.creator.actor_id,
        username: view.creator.name,
        displayName: view.creator.display_name ?? null,
        avatarUrl: view.creator.avatar ?? null,
      });
      const created = await createPost(db, {
        accountId: author.id,
        contentSource: c.content,
        contentHtml: sanitizeHtml(markdownToHtml(c.content)),
        spoilerText: "",
        sensitive: false,
        visibility: "public",
        language: null,
        inReplyTo: parentApId!,
        communityId: root.communityId,
        rootId: root.id,
        parentId: parent.id,
        apId: c.ap_id,
        url: c.ap_id,
        createdAt: seconds(c.published),
        ...(c.updated ? { updatedAt: seconds(c.updated) } : {}),
      }).catch(() => null);
      if (created) await vote(db, created.id, author.id, 1);
    }
    return;
  }

  if (mastodonStatus) {
    const data = await fetchJson<{ descendants: MastodonStatus[] }>(`https://${origin.host}/api/v1/statuses/${mastodonStatus[1]}/context`);
    const statuses = data?.descendants ?? [];
    const uriByOriginId = new Map(statuses.map((s) => [s.id, s.uri]));
    uriByOriginId.set(mastodonStatus[1]!, root.apId);
    for (const status of statuses.slice(0, THREAD_LIMIT)) {
      if (status.visibility !== "public" && status.visibility !== "unlisted") continue;
      if (await postByUri(db, status.uri, localDomains(ctx))) continue;
      const parentUri = status.in_reply_to_id ? uriByOriginId.get(status.in_reply_to_id) : null;
      const parent = parentUri ? await postByUri(db, parentUri, localDomains(ctx)) : null;
      if (!parent) continue;
      const author = await placeholderAccount(db, {
        apId: status.account.uri ?? status.account.url,
        username: status.account.username,
        displayName: status.account.display_name || null,
        avatarUrl: status.account.avatar || null,
      });
      const html = sanitizeHtml(status.content);
      await createPost(db, {
        accountId: author.id,
        contentSource: htmlToText(html),
        contentHtml: html,
        spoilerText: status.spoiler_text,
        sensitive: status.sensitive,
        visibility: status.visibility,
        language: null,
        inReplyTo: parentUri!,
        parentId: parent.id,
        // In a Lemmy community's thread, a reply is a comment there too.
        ...(root.communityId ? { communityId: root.communityId, rootId: root.id } : {}),
        apId: status.uri,
        url: status.url ?? status.uri,
        createdAt: seconds(status.created_at),
        ...(status.edited_at ? { updatedAt: seconds(status.edited_at) } : {}),
      }).catch(() => null);
    }
    return;
  }

  // Other software: the object's own replies collection, as far as it goes.
  const object = await fctx.lookupObject(root.apId).catch(() => null);
  if (!object || !("getReplies" in object)) return;
  const replies = await (object as Note).getReplies().catch(() => null);
  if (!replies) return;
  let count = 0;
  for await (const item of traverseCollection(replies, { documentLoader: fctx.documentLoader, contextLoader: fctx.contextLoader })) {
    if (++count > 30) break;
    const reply = item instanceof Note ? item : item.id ? await fctx.lookupObject(item.id).catch(() => null) : null;
    if (reply && !(reply instanceof Link)) await storeRemotePost(fctx, reply, { required: true }).catch(() => null);
  }
}
