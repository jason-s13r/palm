import type { Context } from "@fedify/fedify";
import {
  Application,
  Article,
  Document,
  Group,
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
import { htmlToText, sanitizeHtml, type RequestContext } from "@palm/core";
import {
  accountByApId,
  accountForLogin,
  addMentions,
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
  return {
    account: await upsertRemoteAccount(db, {
      ...common,
      username,
      displayName: text(a.name),
      bio: a.summary ? sanitizeHtml(String(a.summary)) : null,
      avatarUrl: hrefOf(icon?.url),
      headerUrl: hrefOf(image?.url),
      actorType: actor instanceof Service ? "Service" : actor instanceof Group ? "Group" : "Person",
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
  for (const tag of tags) {
    if (tag instanceof Mention && tag.href) {
      const found = await ensureAccount(fctx, tag.href).catch(() => null);
      if (found && found.apId === null) localMentions.push(found);
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
  if (localMentions.length) await addMentions(db, post.id, localMentions.map((m) => m.id));
  for (const m of localMentions) await notify(db, { accountId: m.id, kind: "mention", fromAccountId: author.id, postId: post.id });
  if (parent) {
    const parentAuthorLocal = await accountByIdLocal(db, parent.accountId);
    if (parentAuthorLocal && !localMentions.some((m) => m.id === parentAuthorLocal)) {
      await notify(db, { accountId: parentAuthorLocal, kind: "reply", fromAccountId: author.id, postId: post.id });
    }
  }
  return post;
}

/** A post's author's ID if the author is local, else null. */
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
