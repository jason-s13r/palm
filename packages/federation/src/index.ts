import { createFederationBuilder, importJwk, type Context, type Federation } from "@fedify/fedify";
import { Accept, Create, Delete, Endpoints, Follow, Image, Note, Person, PUBLIC_COLLECTION, Tombstone, Undo } from "@fedify/fedify/vocab";
import { nodeinfoVersion, type ActivitySink, type PostRef, type RequestContext } from "@palm/core";
import {
  accountById,
  accountForLogin,
  actorKeys,
  addFollower,
  countAccounts,
  countFollowers,
  countLocalPosts,
  countPosts,
  followers,
  postById,
  postsByAccount,
  removeFollower,
  type Account,
  type Post,
} from "@palm/db";
import { Temporal } from "temporal-polyfill";
import { D1KvStore } from "./kv.ts";

export { D1KvStore };

/**
 * palm's ActivityPub surface on the bare domain, on Fedify:
 *
 *   /.well-known/webfinger   acct:name@domain -> the actor
 *   /users/{name}            the Person actor
 *   /users/{name}/inbox      its inbox; /inbox is the shared inbox
 *   /users/{name}/followers  its followers collection
 *   /users/{name}/outbox     its posts, as Create activities
 *   /objects/{id}            a post, as a Note
 *   /nodeinfo/2.1            software and usage, via /.well-known/nodeinfo
 *
 * These paths are the URL scheme in @palm/core's `urls`, and permanent.
 */
const builder = createFederationBuilder<RequestContext>();

/** The account behind an actor identifier, on the domain this request is for. */
async function accountFor(ctx: RequestContext, identifier: string) {
  return (await accountForLogin(ctx.bindings.DB, ctx.domain.domain, identifier))?.account ?? null;
}

builder
  .setActorDispatcher("/users/{identifier}", async (ctx, identifier) => {
    const account = await accountFor(ctx.data, identifier);
    if (!account) return null;
    const keys = await ctx.getActorKeyPairs(identifier);
    return new Person({
      id: ctx.getActorUri(identifier),
      preferredUsername: account.username,
      name: account.displayName ?? account.username,
      summary: account.bio ?? null,
      url: ctx.getActorUri(identifier),
      inbox: ctx.getInboxUri(identifier),
      endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
      followers: ctx.getFollowersUri(identifier),
      // Lemmy refuses actors without an outbox.
      outbox: ctx.getOutboxUri(identifier),
      manuallyApprovesFollowers: false,
      discoverable: true,
      icon: new Image({ url: new URL(`https://${ctx.data.host}/palm/avatar.png`), mediaType: "image/png" }),
      publicKey: keys[0]?.cryptographicKey ?? null,
      assertionMethods: keys.map((k) => k.multikey),
    });
  })
  .setKeyPairsDispatcher(async (ctx, identifier) => {
    const account = await accountFor(ctx.data, identifier);
    if (!account) return [];
    const stored = await actorKeys(ctx.data.bindings.DB, account.id);
    // RSA first: it's what Lemmy and Mastodon verify HTTP Signatures with.
    stored.sort((a, b) => (a.algorithm === "RSASSA-PKCS1-v1_5" ? -1 : b.algorithm === "RSASSA-PKCS1-v1_5" ? 1 : 0));
    return Promise.all(
      stored.map(async (k) => ({
        privateKey: await importJwk(k.privateJwk, "private"),
        publicKey: await importJwk(k.publicJwk, "public"),
      })),
    );
  });

builder
  .setFollowersDispatcher("/users/{identifier}/followers", async (ctx, identifier) => {
    const account = await accountFor(ctx.data, identifier);
    if (!account) return null;
    const items = await followers(ctx.data.bindings.DB, account.id);
    return {
      items: items.map((f) => ({
        id: new URL(f.actorId),
        inboxId: new URL(f.inbox),
        endpoints: f.sharedInbox ? { sharedInbox: new URL(f.sharedInbox) } : null,
      })),
    };
  })
  .setCounter(async (ctx, identifier) => {
    const account = await accountFor(ctx.data, identifier);
    return account ? countFollowers(ctx.data.bindings.DB, account.id) : 0;
  });

/** The actor identifier for an account: its username, lowercased like urls.user. */
const identifierOf = (account: Account) => account.username.toLowerCase();

/** Who a post is addressed to, by Mastodon's visibility levels. */
function audience(ctx: Context<RequestContext>, account: Account, visibility: PostRef["visibility"]) {
  const followersUri = ctx.getFollowersUri(identifierOf(account));
  switch (visibility) {
    case "public":
      return { tos: [PUBLIC_COLLECTION], ccs: [followersUri] };
    case "unlisted":
      return { tos: [followersUri], ccs: [PUBLIC_COLLECTION] };
    default:
      return { tos: [followersUri], ccs: [] };
  }
}

const noteUri = (ctx: Context<RequestContext>, id: number) => ctx.getObjectUri(Note, { id: String(id) });

function noteFor(ctx: Context<RequestContext>, account: Account, post: Post): Note {
  const id = noteUri(ctx, post.id);
  return new Note({
    id,
    url: id,
    attribution: ctx.getActorUri(identifierOf(account)),
    ...audience(ctx, account, post.visibility),
    content: post.contentHtml,
    summary: post.spoilerText || null,
    sensitive: post.sensitive,
    published: Temporal.Instant.fromEpochMilliseconds(post.createdAt * 1000),
    replyTarget: post.inReplyTo ? new URL(post.inReplyTo) : null,
  });
}

function createFor(ctx: Context<RequestContext>, account: Account, post: Post): Create {
  const note = noteFor(ctx, account, post);
  return new Create({
    id: new URL(`${note.id!.href}#create`),
    actor: ctx.getActorUri(identifierOf(account)),
    ...audience(ctx, account, post.visibility),
    published: note.published,
    object: note,
  });
}

// A post, readable by anyone when it's public or unlisted. Followers-only
// posts reach followers by delivery and aren't served here yet.
builder.setObjectDispatcher(Note, "/objects/{id}", async (ctx, { id }) => {
  if (!/^\d+$/.test(id)) return null;
  const post = await postById(ctx.data.bindings.DB, Number(id));
  if (!post || (post.visibility !== "public" && post.visibility !== "unlisted")) return null;
  const account = await accountById(ctx.data.bindings.DB, post.accountId);
  if (account?.domain !== ctx.data.domain.domain) return null;
  return noteFor(ctx, account, post);
});

const OUTBOX_PAGE = 20;

// The actor's public and unlisted posts, newest first, in pages. The cursor is
// the ID to page below; "top" is the newest page.
builder
  .setOutboxDispatcher("/users/{identifier}/outbox", async (ctx, identifier, cursor) => {
    if (cursor === null) return null;
    const account = await accountFor(ctx.data, identifier);
    if (!account) return null;
    const maxId = cursor === "top" ? undefined : Number(cursor);
    if (maxId !== undefined && !Number.isInteger(maxId)) return null;
    const posts = await postsByAccount(ctx.data.bindings.DB, account.id, ["public", "unlisted"], {
      maxId,
      limit: OUTBOX_PAGE,
    });
    const last = posts.at(-1);
    return {
      items: posts.map((post) => createFor(ctx, account, post)),
      nextCursor: posts.length === OUTBOX_PAGE && last ? String(last.id) : null,
    };
  })
  .setFirstCursor(() => "top")
  .setCounter(async (ctx, identifier) => {
    const account = await accountFor(ctx.data, identifier);
    return account ? countPosts(ctx.data.bindings.DB, account.id) : 0;
  });

builder
  .setInboxListeners("/users/{identifier}/inbox", "/inbox")
  // Someone follows a local account: record them and accept straight away.
  .on(Follow, async (ctx, follow) => {
    if (!follow.id || !follow.actorId || !follow.objectId) return;
    const target = ctx.parseUri(follow.objectId);
    if (target?.type !== "actor") return;
    const account = await accountFor(ctx.data, target.identifier);
    if (!account) return;
    const follower = await follow.getActor(ctx);
    if (!follower?.id || !follower.inboxId) return;
    await addFollower(ctx.data.bindings.DB, account.id, {
      actorId: follower.id.href,
      inbox: follower.inboxId.href,
      sharedInbox: follower.endpoints?.sharedInbox?.href ?? null,
      followId: follow.id.href,
    });
    await ctx.sendActivity(
      { identifier: target.identifier },
      follower,
      new Accept({ id: new URL(`#accepts/${crypto.randomUUID()}`, ctx.getActorUri(target.identifier)), actor: follow.objectId, object: follow }),
    );
  })
  // They unfollow.
  .on(Undo, async (ctx, undo) => {
    const object = await undo.getObject(ctx);
    if (!(object instanceof Follow) || !object.objectId || !undo.actorId) return;
    if (object.actorId?.href !== undo.actorId.href) return;
    const target = ctx.parseUri(object.objectId);
    if (target?.type !== "actor") return;
    const account = await accountFor(ctx.data, target.identifier);
    if (account) await removeFollower(ctx.data.bindings.DB, account.id, undo.actorId.href);
  });

// palm answers as Lemmy, because Lemmy apps (Voyager) check the handle's
// domain for a Lemmy server before they'll use it. The version carries palm's
// own as build metadata ("0.19.9+palm.0.2.0"); see nodeinfoVersion.
builder.setNodeInfoDispatcher("/nodeinfo/2.1", async (ctx) => ({
  software: {
    name: "lemmy",
    version: nodeinfoVersion(ctx.data.version),
    repository: new URL("https://github.com/jason-s13r/palm"),
    homepage: new URL("https://github.com/jason-s13r/palm"),
  },
  protocols: ["activitypub"],
  openRegistrations: false,
  usage: {
    users: { total: await countAccounts(ctx.data.bindings.DB, ctx.data.domain.domain) },
    localPosts: await countLocalPosts(ctx.data.bindings.DB, ctx.data.domain.domain),
    localComments: 0,
  },
  metadata: { nodeName: ctx.data.config.instance.name, palm: { version: ctx.data.version } },
}));

// One Federation per database per isolate: building it is the costly part.
const built = new WeakMap<D1Database, Promise<Federation<RequestContext>>>();

function federationFor(db: D1Database): Promise<Federation<RequestContext>> {
  let federation = built.get(db);
  if (!federation) {
    federation = builder.build({ kv: new D1KvStore(db) });
    built.set(db, federation);
  }
  return federation;
}

/**
 * Serves one request on the bare domain. Anything Fedify doesn't handle goes
 * to `fallback`, which redirects browsers or answers 404.
 */
export async function handleFederation(
  request: Request,
  ctx: RequestContext,
  fallback: (request: Request) => Response | Promise<Response>,
): Promise<Response> {
  const federation = await federationFor(ctx.bindings.DB);
  return federation.fetch(request, {
    contextData: ctx,
    onNotFound: fallback,
    // A browser asking for an actor or object gets the browser fallback too.
    onNotAcceptable: fallback,
  });
}

/**
 * Delivers activities about local posts to followers' servers. Delivery runs
 * in the background; failures are logged, not retried, until palm has a queue.
 */
export function activitySink(ctx: RequestContext): ActivitySink {
  const run = (name: string, work: () => Promise<void>) =>
    ctx.waitUntil(
      work().catch((error: unknown) =>
        console.error(JSON.stringify({ palm: "delivery_failed", activity: name, error: String(error) })),
      ),
    );

  async function prepare(ref: PostRef) {
    const db = ctx.bindings.DB;
    const account = await accountById(db, ref.accountId);
    if (!account || account.domain !== ctx.domain.domain) return null;
    const federation = await federationFor(db);
    return { account, fctx: federation.createContext(new URL(`https://${ctx.domain.domain}`), ctx) };
  }

  return {
    postCreated(ref) {
      if (ref.visibility === "direct") return;
      run("Create", async () => {
        const ready = await prepare(ref);
        const post = await postById(ctx.bindings.DB, ref.id);
        if (!ready || !post) return;
        await ready.fctx.sendActivity({ identifier: identifierOf(ready.account) }, "followers", createFor(ready.fctx, ready.account, post), {
          preferSharedInbox: true,
        });
      });
    },
    postDeleted(ref) {
      if (ref.visibility === "direct") return;
      run("Delete", async () => {
        const ready = await prepare(ref);
        if (!ready) return;
        const { account, fctx } = ready;
        const id = noteUri(fctx, ref.id);
        await fctx.sendActivity(
          { identifier: identifierOf(account) },
          "followers",
          new Delete({
            id: new URL(`${id.href}#delete`),
            actor: fctx.getActorUri(identifierOf(account)),
            ...audience(fctx, account, ref.visibility),
            object: new Tombstone({ id }),
          }),
          { preferSharedInbox: true },
        );
      });
    },
  };
}
