import { createFederationBuilder, importJwk, type Federation } from "@fedify/fedify";
import { Accept, Endpoints, Follow, Image, Person, Undo } from "@fedify/fedify/vocab";
import { nodeinfoVersion, type RequestContext } from "@palm/core";
import { accountForLogin, actorKeys, addFollower, countAccounts, countFollowers, followers, removeFollower } from "@palm/db";
import { D1KvStore } from "./kv.ts";

export { D1KvStore };

/**
 * palm's ActivityPub surface on the bare domain, on Fedify:
 *
 *   /.well-known/webfinger   acct:name@domain -> the actor
 *   /users/{name}            the Person actor
 *   /users/{name}/inbox      its inbox; /inbox is the shared inbox
 *   /users/{name}/followers  its followers collection
 *   /users/{name}/outbox     its posts
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

// The actor's posts. Empty until palm stores posts; Lemmy needs it to exist.
builder
  .setOutboxDispatcher("/users/{identifier}/outbox", async (ctx, identifier) => {
    const account = await accountFor(ctx.data, identifier);
    return account ? { items: [] } : null;
  })
  .setCounter(async () => 0);

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
    localPosts: 0,
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
