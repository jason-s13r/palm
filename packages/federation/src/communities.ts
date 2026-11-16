import { Announce, Endpoints, Group, PUBLIC_COLLECTION } from "@fedify/fedify/vocab";
import type { RequestContext } from "@palm/core";
import { communityByName, communityFollowers, listThreadPosts, type Community } from "@palm/db";
import { registerInbox } from "./inbox.ts";
import { createFor, postParts } from "./objects.ts";
import { communitiesBuilder as builder, communityKeyPairs, recipient } from "./shared.ts";

/**
 * Communities, as Lemmy shapes them:
 *
 *   /c/{name}             the Group actor (!name@domain by WebFinger)
 *   /c/{name}/inbox       where members send posts, comments and votes
 *   /communities/inbox    the communities' shared inbox
 *   /c/{name}/followers   its members on other servers
 *   /c/{name}/outbox      recent posts, as the community's Announces
 *
 * These paths are permanent once another server has seen them.
 */

/** The local community behind an identifier, on the domain this request is for. */
async function communityFor(ctx: RequestContext, identifier: string): Promise<Community | null> {
  const found = await communityByName(ctx.bindings.DB, ctx.domain.domain, identifier);
  return found && found.apId === null ? found : null;
}

builder
  .setActorDispatcher("/c/{identifier}", async (ctx, identifier) => {
    const community = await communityFor(ctx.data, identifier);
    if (!community) return null;
    const keys = await ctx.getActorKeyPairs(identifier);
    return new Group({
      id: ctx.getActorUri(identifier),
      preferredUsername: community.name,
      name: community.title,
      summary: community.description ?? null,
      url: ctx.getActorUri(identifier),
      inbox: ctx.getInboxUri(identifier),
      // Lemmy delivers to an instance's shared inbox where it can.
      endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
      followers: ctx.getFollowersUri(identifier),
      outbox: ctx.getOutboxUri(identifier),
      sensitive: community.nsfw,
      manuallyApprovesFollowers: false,
      discoverable: true,
      publicKey: keys[0]?.cryptographicKey ?? null,
      assertionMethods: keys.map((k) => k.multikey),
    });
  })
  // WebFinger names communities by name, as it does people.
  .mapHandle(async (ctx, username) => ((await communityFor(ctx.data, username)) ? username.toLowerCase() : null))
  .setKeyPairsDispatcher(async (ctx, identifier) => {
    const community = await communityFor(ctx.data, identifier);
    return community ? communityKeyPairs(ctx.data.bindings.DB, community.id) : [];
  });

builder
  .setFollowersDispatcher("/c/{identifier}/followers", async (ctx, identifier) => {
    const community = await communityFor(ctx.data, identifier);
    if (!community) return null;
    return { items: (await communityFollowers(ctx.data.bindings.DB, community.id)).map(recipient) };
  })
  .setCounter(async (ctx, identifier) => {
    const community = await communityFor(ctx.data, identifier);
    return community ? (await communityFollowers(ctx.data.bindings.DB, community.id)).length : 0;
  });

// The community's recent posts, as Lemmy's outbox has them: its Announces of
// each post's Create. Lemmy reads this to fill a community it starts following.
builder.setOutboxDispatcher("/c/{identifier}/outbox", async (ctx, identifier) => {
  const community = await communityFor(ctx.data, identifier);
  if (!community) return null;
  const db = ctx.data.bindings.DB;
  const posts = await listThreadPosts(db, {
    domain: ctx.data.domain.domain,
    scope: "local",
    communityId: community.id,
    sort: "new",
    viewerId: null,
    limit: 20,
    offset: 0,
  });
  const id = ctx.getActorUri(identifier);
  const items = [];
  for (const post of posts) {
    const parts = await postParts(db, post.id);
    if (!parts) continue;
    items.push(
      new Announce({
        id: new URL(`${id.href}#announces/create-${post.id}`),
        actor: id,
        object: createFor(parts),
        tos: [PUBLIC_COLLECTION],
        ccs: [ctx.getFollowersUri(identifier)],
      }),
    );
  }
  return { items };
});

registerInbox(builder, "/c/{identifier}/inbox", "/communities/inbox");
