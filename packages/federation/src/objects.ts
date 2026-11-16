import { Create, Document, Link, Mention, Note, Page, PUBLIC_COLLECTION, Source, Tombstone, type Object as APObject } from "@fedify/fedify/vocab";
import { urls } from "@palm/core";
import {
  accountById,
  accountsByIds,
  communityById,
  mediaForPosts,
  mentionedIds,
  postById,
  postByIdAny,
  type Account,
  type Community,
  type Media,
  type Post,
} from "@palm/db";
import { Temporal } from "temporal-polyfill";

/** An account's ActivityPub ID: its own if remote, else from its local domain. */
export const actorUri = (account: Pick<Account, "apId" | "domain" | "username">) =>
  new URL(account.apId ?? urls.user(account.domain, account.username));

export const followersUri = (account: Pick<Account, "apId" | "domain" | "username">) => new URL(`${actorUri(account).href}/followers`);

export const communityUri = (community: Pick<Community, "apId" | "domain" | "name">) =>
  new URL(community.apId ?? urls.community(community.domain, community.name));

/** A post's ActivityPub ID: its own if remote, else /objects/{id} on its author's domain. */
export const postUri = (post: Pick<Post, "apId" | "id">, author: Pick<Account, "domain">) =>
  new URL(post.apId ?? urls.object(author.domain, String(post.id)));

const instant = (seconds: number) => Temporal.Instant.fromEpochMilliseconds(seconds * 1000);

/** Everything an outgoing object about a post needs, looked up once. */
export interface PostParts {
  post: Post;
  author: Account;
  community: Community | null;
  parent: { post: Post; author: Account } | null;
  media: Media[];
  mentions: Account[];
}

/** Loads a post and what its object needs; deleted posts too, for Delete. */
export async function postParts(db: D1Database, postId: number): Promise<PostParts | null> {
  const post = await postByIdAny(db, postId);
  if (!post) return null;
  const [author, community, parentPost, media, mentioned] = await Promise.all([
    accountById(db, post.accountId),
    post.communityId ? communityById(db, post.communityId) : Promise.resolve(null),
    post.parentId ? postById(db, post.parentId) : Promise.resolve(null),
    mediaForPosts(db, [post.id]),
    mentionedIds(db, [post.id]),
  ]);
  if (!author) return null;
  const parentAuthor = parentPost ? await accountById(db, parentPost.accountId) : null;
  const mentions = [...(await accountsByIds(db, mentioned.get(post.id) ?? [])).values()];
  return {
    post,
    author,
    community,
    parent: parentPost && parentAuthor ? { post: parentPost, author: parentAuthor } : null,
    media: media.get(post.id) ?? [],
    mentions,
  };
}

/** Who a post is addressed to. Lemmy posts and comments go to their community. */
export function addressing(parts: PostParts): { tos: URL[]; ccs: URL[] } {
  const { post, author, community, parent, mentions } = parts;
  const people = [...mentions.map(actorUri), ...(parent && parent.author.id !== author.id ? [actorUri(parent.author)] : [])];
  if (community) {
    // Lemmy: a post goes to its community and the public; a comment to the
    // public, with the community and whoever it answers copied in.
    return post.rootId === null
      ? { tos: [communityUri(community), PUBLIC_COLLECTION], ccs: people }
      : { tos: [PUBLIC_COLLECTION], ccs: [communityUri(community), ...people] };
  }
  const followers = followersUri(author);
  switch (post.visibility) {
    case "public":
      return { tos: [PUBLIC_COLLECTION], ccs: [followers, ...people] };
    case "unlisted":
      return { tos: [followers], ccs: [PUBLIC_COLLECTION, ...people] };
    case "private":
      return { tos: [followers, ...people], ccs: [] };
    case "direct":
      return { tos: people, ccs: [] };
  }
}

/**
 * A post as an ActivityPub object: a Lemmy post is a Page with a title, a
 * comment or a status is a Note.
 */
export function objectFor(parts: PostParts): Note | Page {
  const { post, author, community, parent, media, mentions } = parts;
  const id = postUri(post, author);
  const attachments: (Document | Link)[] = media.map(
    (m) => new Document({ url: new URL(urls.media(author.domain, m.file)), mediaType: m.contentType, name: m.description }),
  );
  // Lemmy carries a link post's link as a Link attachment.
  if (post.linkUrl && !media.some((m) => post.linkUrl?.endsWith(m.file))) attachments.unshift(new Link({ href: new URL(post.linkUrl) }));
  const values = {
    id,
    url: id,
    attribution: actorUri(author),
    ...addressing(parts),
    ...(community ? { audience: communityUri(community) } : {}),
    content: post.contentHtml,
    mediaType: "text/html",
    // Lemmy apps edit Markdown; give them the source as written.
    ...(community ? { source: new Source({ content: post.contentSource, mediaType: "text/markdown" }) } : {}),
    summary: post.spoilerText || null,
    sensitive: post.sensitive,
    published: instant(post.createdAt),
    ...(post.updatedAt ? { updated: instant(post.updatedAt) } : {}),
    replyTarget: parent ? postUri(parent.post, parent.author) : post.inReplyTo ? new URL(post.inReplyTo) : null,
    attachments,
    tags: mentions.map((m) => new Mention({ href: actorUri(m), name: `@${m.username}@${m.domain}` })),
  };
  return post.title && post.rootId === null ? new Page({ ...values, name: post.title }) : new Note(values);
}

export function createFor(parts: PostParts): Create {
  const object = objectFor(parts);
  return new Create({
    id: new URL(`${object.id!.href}#create`),
    actor: actorUri(parts.author),
    ...addressing(parts),
    ...(parts.community ? { audience: communityUri(parts.community) } : {}),
    published: object.published,
    object,
  });
}

export const tombstoneFor = (parts: PostParts): APObject => new Tombstone({ id: postUri(parts.post, parts.author) });
