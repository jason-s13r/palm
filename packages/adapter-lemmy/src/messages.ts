import { markdownToHtml, urls, type RequestContext } from "@palm/core";
import { lemmyClient } from "./client.ts";
import {
  accountById,
  accountsByIds,
  addMentions,
  blocks,
  createPost,
  deletePost,
  directMessages,
  editPost,
  markMessagesRead,
  postByIdAny,
  restorePost,
  type Account,
  type DirectMessage,
} from "@palm/db";
import { Hono, type Context } from "hono";
import type { PrivateMessageView } from "lemmy-js-client";
import { person } from "./views.ts";

/**
 * Lemmy's private messages, as direct posts. A message from Voyager is a
 * direct message in Mastodon apps and the other way round; to someone on
 * Lemmy it federates as a ChatMessage, as Lemmy sends them.
 */

interface Auth {
  account: Account;
  sessionId: string;
}
type Env = { Bindings: RequestContext; Variables: { auth: Auth | null } };
type C = Context<Env>;

const fail = (c: C, error: string, status: 400 | 401 | 404 = 400) => c.json({ error }, status);
const body = async (c: C) => (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const MAX_MESSAGE = 10_000;

async function views(c: C, me: Account, messages: DirectMessage[]): Promise<PrivateMessageView[]> {
  const people = await accountsByIds(c.env.bindings.DB, messages.flatMap((m) => [m.post.accountId, ...m.recipientIds]));
  return messages.flatMap((m) => {
    const creator = people.get(m.post.accountId);
    // Lemmy messages have one recipient: whoever isn't the sender, me if I'm named.
    const recipientId = m.post.accountId === me.id ? m.recipientIds[0] : me.id;
    const recipient = recipientId !== undefined ? people.get(recipientId) : undefined;
    if (!creator || !recipient) return [];
    return [
      {
        private_message: {
          id: m.post.id,
          creator_id: creator.id,
          recipient_id: recipient.id,
          content: m.post.contentSource,
          deleted: false,
          read: m.read,
          published: iso(m.post.createdAt),
          ...(m.post.updatedAt ? { updated: iso(m.post.updatedAt) } : {}),
          ap_id: m.post.apId ?? urls.object(creator.domain, String(m.post.id)),
          local: m.post.apId === null,
        },
        creator: person(c.env, creator),
        recipient: person(c.env, recipient),
      },
    ];
  });
}

async function one(c: C, me: Account, id: number) {
  const [found] = (await directMessages(c.env.bindings.DB, me.id, { limit: 200 })).filter((m) => m.post.id === id);
  if (!found) return null;
  const [view] = await views(c, me, [found]);
  return view ?? null;
}

export const messageRoutes = new Hono<Env>();

messageRoutes.get("/api/v3/private_message/list", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 50);
  const page = Math.max(Number(c.req.query("page")) || 1, 1);
  const creatorId = Number(c.req.query("creator_id")) || undefined;
  const messages = await directMessages(c.env.bindings.DB, auth.account.id, {
    unreadOnly: c.req.query("unread_only") === "true",
    withAccountId: creatorId,
    limit,
    offset: (page - 1) * limit,
  });
  return c.json({ private_messages: await views(c, auth.account, messages) });
});

messageRoutes.post("/api/v3/private_message", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const text = String(params.content ?? "").trim();
  if (!text || text.length > MAX_MESSAGE) return fail(c, "invalid_body_field");
  const db = c.env.bindings.DB;
  const recipient = await accountById(db, Number(params.recipient_id));
  if (!recipient || recipient.id === auth.account.id || recipient.actorType === "Group") return fail(c, "couldnt_find_person", 404);
  if (await blocks(db, recipient.id, auth.account.id)) return fail(c, "person_is_blocked");
  const created = await createPost(db, {
    accountId: auth.account.id,
    ...lemmyClient(c),
    contentSource: text,
    contentHtml: markdownToHtml(text),
    spoilerText: "",
    sensitive: false,
    visibility: "direct",
    language: null,
    inReplyTo: null,
  });
  await addMentions(db, created.id, [recipient.id]);
  c.env.activities.enqueue({ kind: "post_created", postId: created.id });
  const view = await one(c, auth.account, created.id);
  return view ? c.json({ private_message_view: view }) : fail(c, "couldnt_create_private_message");
});

messageRoutes.put("/api/v3/private_message", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const id = Number(params.private_message_id);
  const post = await postByIdAny(c.env.bindings.DB, id);
  if (!post || post.deleted || post.accountId !== auth.account.id || post.visibility !== "direct") return fail(c, "couldnt_update_private_message");
  const text = String(params.content ?? "").trim();
  if (!text || text.length > MAX_MESSAGE) return fail(c, "invalid_body_field");
  await editPost(c.env.bindings.DB, id, { contentSource: text, contentHtml: markdownToHtml(text) });
  c.env.activities.enqueue({ kind: "post_updated", postId: id });
  const view = await one(c, auth.account, id);
  return view ? c.json({ private_message_view: view }) : fail(c, "couldnt_update_private_message");
});

messageRoutes.post("/api/v3/private_message/delete", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const id = Number(params.private_message_id);
  const post = await postByIdAny(c.env.bindings.DB, id);
  if (!post || post.accountId !== auth.account.id || post.visibility !== "direct") return fail(c, "couldnt_update_private_message");
  const before = await one(c, auth.account, id);
  if (params.deleted === false) await restorePost(c.env.bindings.DB, id);
  else {
    await deletePost(c.env.bindings.DB, id);
    c.env.activities.enqueue({ kind: "post_deleted", postId: id });
  }
  if (!before) return fail(c, "couldnt_update_private_message");
  before.private_message.deleted = params.deleted !== false;
  return c.json({ private_message_view: before });
});

messageRoutes.post("/api/v3/private_message/mark_as_read", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await body(c);
  const id = Number(params.private_message_id);
  await markMessagesRead(c.env.bindings.DB, auth.account.id, [id], params.read !== false);
  const view = await one(c, auth.account, id);
  return view ? c.json({ private_message_view: view }) : fail(c, "couldnt_update_private_message");
});
