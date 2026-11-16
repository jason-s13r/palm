import { importJwk, type Context } from "@fedify/fedify";
import { Endpoints, Hashtag, Image, Object as APObject, Person } from "@fedify/fedify/vocab";
import { nodeinfoVersion, urls, type RequestContext } from "@palm/core";
import {
  featuredTags,
  pinnedPosts,
  accountForLogin,
  actorKeys,
  countAccounts,
  countFollowers,
  countLocalPosts,
  countPosts,
  followers,
  postByIdAny,
  postsByAccount,
  type Account,
} from "@palm/db";
import { registerInbox } from "./inbox.ts";
import { createFor, objectFor, postParts } from "./objects.ts";
import { peopleBuilder as builder, identifierOf, recipient } from "./shared.ts";

/**
 * People, on the bare domain:
 *
 *   /.well-known/webfinger   acct:name@domain -> the actor
 *   /users/{name}            the Person actor
 *   /users/{name}/inbox      its inbox; /inbox is the shared inbox
 *   /users/{name}/followers  its followers collection
 *   /users/{name}/outbox     its posts, as Create activities
 *   /objects/{id}            a post: a Note, or a Lemmy post as a Page
 *   /nodeinfo/2.1            software and usage, via /.well-known/nodeinfo
 *
 * These paths are the URL scheme in @palm/core's `urls`, and permanent.
 */

/** The local account behind an actor identifier, on the domain this request is for. */
async function accountFor(ctx: RequestContext, identifier: string): Promise<Account | null> {
  return (await accountForLogin(ctx.bindings.DB, ctx.domain.domain, identifier))?.account ?? null;
}

/** A local account as a Person. */
export async function personFor(ctx: Context<RequestContext>, account: Account): Promise<Person> {
  const identifier = identifierOf(account);
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
    manuallyApprovesFollowers: account.locked,
    featured: ctx.getFeaturedUri(identifier),
    featuredTags: ctx.getFeaturedTagsUri(identifier),
    discoverable: true,
    icon: new Image({
      url: new URL(account.avatarUrl ?? `https://${ctx.data.domain.domain}/palm/avatar.png`),
      mediaType: account.avatarUrl ? null : "image/png",
    }),
    ...(account.headerUrl ? { image: new Image({ url: new URL(account.headerUrl) }) } : {}),
    published: null,
    publicKey: keys[0]?.cryptographicKey ?? null,
    assertionMethods: keys.map((k) => k.multikey),
  });
}

builder
  .setActorDispatcher("/users/{identifier}", async (ctx, identifier) => {
    const account = await accountFor(ctx.data, identifier);
    return account ? personFor(ctx, account) : null;
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

// Pinned posts and featured hashtags, which Mastodon shows on profiles.
builder.setFeaturedDispatcher("/users/{identifier}/featured", async (ctx, identifier) => {
  const account = await accountFor(ctx.data, identifier);
  if (!account) return null;
  const items = [];
  for (const post of await pinnedPosts(ctx.data.bindings.DB, account.id)) {
    if (post.visibility !== "public" && post.visibility !== "unlisted") continue;
    const parts = await postParts(ctx.data.bindings.DB, post.id);
    if (parts) items.push(objectFor(parts));
  }
  return { items };
});

builder.setFeaturedTagsDispatcher("/users/{identifier}/collections/tags", async (ctx, identifier) => {
  const account = await accountFor(ctx.data, identifier);
  if (!account) return null;
  const tags = await featuredTags(ctx.data.bindings.DB, account.id);
  return { items: tags.map((t) => new Hashtag({ href: new URL(urls.tag(account.domain, t.tag)), name: `#${t.tag}` })) };
});

builder
  .setFollowersDispatcher("/users/{identifier}/followers", async (ctx, identifier) => {
    const account = await accountFor(ctx.data, identifier);
    if (!account) return null;
    return { items: (await followers(ctx.data.bindings.DB, account.id)).map(recipient) };
  })
  .setCounter(async (ctx, identifier) => {
    const account = await accountFor(ctx.data, identifier);
    return account ? countFollowers(ctx.data.bindings.DB, account.id) : 0;
  });

// A post, readable by anyone when it's public or unlisted. Followers-only
// posts reach followers by delivery and aren't served here yet.
builder.setObjectDispatcher(APObject, "/objects/{id}", async (ctx, { id }) => {
  if (!/^\d+$/.test(id)) return null;
  const post = await postByIdAny(ctx.data.bindings.DB, Number(id));
  if (!post || post.deleted || post.apId || post.reblogOf !== null || (post.visibility !== "public" && post.visibility !== "unlisted")) return null;
  const parts = await postParts(ctx.data.bindings.DB, post.id);
  if (!parts || parts.author.domain !== ctx.data.domain.domain) return null;
  return objectFor(parts);
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
    const posts = await postsByAccount(ctx.data.bindings.DB, account.id, ["public", "unlisted"], { maxId, limit: OUTBOX_PAGE });
    const items = [];
    for (const post of posts) {
      if (post.reblogOf !== null) continue;
      const parts = await postParts(ctx.data.bindings.DB, post.id);
      if (parts) items.push(createFor(parts));
    }
    const last = posts.at(-1);
    return { items, nextCursor: posts.length === OUTBOX_PAGE && last ? String(last.id) : null };
  })
  .setFirstCursor(() => "top")
  .setCounter(async (ctx, identifier) => {
    const account = await accountFor(ctx.data, identifier);
    return account ? countPosts(ctx.data.bindings.DB, account.id) : 0;
  });

registerInbox(builder, "/users/{identifier}/inbox", "/inbox");

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


