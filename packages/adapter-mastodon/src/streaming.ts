import { DurableObject } from "cloudflare:workers";
import { currentContext, type RequestContext } from "@palm/core";
import { accountById, localFollowerIds, mentionedIds, onNewPost, onNotification, postById, tokenGrant, type Account, type OAuthApp } from "@palm/db";
import { Hono, type Context } from "hono";
import { statuses } from "./statuses.ts";
import { account } from "./views.ts";

/**
 * Mastodon's streaming API on a Durable Object. Each domain has one object
 * that holds every open WebSocket (hibernating, so idle connections cost
 * nothing) and passes events on: new posts for home timelines and the public
 * streams, and notifications. Events come from hooks that run wherever a post
 * or notification is written.
 */

type Env = { Bindings: RequestContext; Variables: { account: Account | null; app: OAuthApp | null } };
type C = Context<Env>;

const STREAMS = ["user", "user:notification", "public", "public:local", "direct"];

interface Attachment {
  account: number;
  streams: string[];
}

interface Event {
  /** Only these people's connections; all of them when absent. */
  accounts?: number[];
  stream: string;
  event: string;
  payload: string;
}

export class PalmStreaming extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const accountId = Number(request.headers.get("x-palm-account"));
      const streams = (request.headers.get("x-palm-streams") ?? "").split(",").filter((s) => STREAMS.includes(s));
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server, [`account:${accountId}`]);
      server.serializeAttachment({ account: accountId, streams } satisfies Attachment);
      return new Response(null, { status: 101, webSocket: client });
    }
    const event = (await request.json()) as Event;
    const sockets = event.accounts ? event.accounts.flatMap((id) => this.ctx.getWebSockets(`account:${id}`)) : this.ctx.getWebSockets();
    for (const ws of sockets) {
      const { streams } = ws.deserializeAttachment() as Attachment;
      const listening = streams.includes(event.stream) || (event.stream === "user:notification" && streams.includes("user"));
      if (!listening) continue;
      try {
        ws.send(JSON.stringify({ stream: [event.stream], event: event.event, payload: event.payload }));
      } catch {
        // A socket closing as we send: the close handler tidies up.
      }
    }
    return new Response(null, { status: 204 });
  }

  /** Mastodon's multiplexed protocol: {"type":"subscribe","stream":"public"}. */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let parsed: { type?: string; stream?: string };
    try {
      parsed = JSON.parse(message) as { type?: string; stream?: string };
    } catch {
      return;
    }
    const attachment = ws.deserializeAttachment() as Attachment;
    if (!parsed.stream || !STREAMS.includes(parsed.stream)) return;
    if (parsed.type === "subscribe" && !attachment.streams.includes(parsed.stream)) attachment.streams.push(parsed.stream);
    if (parsed.type === "unsubscribe") attachment.streams = attachment.streams.filter((s) => s !== parsed.stream);
    ws.serializeAttachment(attachment);
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    ws.close(code === 1005 ? 1000 : code);
  }
}

const stubFor = (ctx: RequestContext) => {
  const ns = ctx.bindings.STREAMING;
  return ns ? ns.get(ns.idFromName(ctx.domain.domain)) : null;
};

/** Sends an event to the domain's streaming object, after the response. */
function publish(ctx: RequestContext, event: Event): void {
  const stub = stubFor(ctx);
  if (!stub) return;
  ctx.waitUntil(
    stub
      .fetch("https://streaming/publish", { method: "POST", body: JSON.stringify(event) })
      .then((r) => r.body?.cancel())
      .catch(() => undefined),
  );
}

export const streamingRoutes = new Hono<Env>();

streamingRoutes.get("/api/v1/streaming/health", (c) => (c.env.bindings.STREAMING ? c.text("OK") : c.text("Not available", 404)));

/** The account a streaming connection is for: by header, ?access_token= or the WebSocket protocol, as Mastodon allows. */
async function streamer(c: C): Promise<Account | null> {
  const signedIn = c.get("account");
  if (signedIn) return signedIn;
  const token = c.req.query("access_token") ?? c.req.header("sec-websocket-protocol") ?? "";
  if (!token) return null;
  const grant = await tokenGrant(c.env.bindings.DB, token);
  return grant?.accountId ? accountById(c.env.bindings.DB, grant.accountId) : null;
}

for (const path of ["/api/v1/streaming", "/api/v1/streaming/:stream{.+}"]) {
  streamingRoutes.get(path, async (c) => {
    const stub = stubFor(c.env);
    if (!stub || c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "Streaming isn't available on this server" }, 404);
    const me = await streamer(c);
    if (!me) return c.json({ error: "The access token is invalid" }, 401);
    // A path stream (/streaming/user) or ?stream=, as older apps connect; or none, then subscribe messages.
    const named = (c.req.param("stream") ?? c.req.query("stream") ?? "").replace(/\//g, ":");
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-palm-account", String(me.id));
    headers.set("x-palm-streams", named);
    const response = await stub.fetch(new Request(c.req.url, { headers }));
    // Echo the protocol back when the token came that way, as browsers require.
    const protocol = c.req.header("sec-websocket-protocol");
    if (protocol && response.webSocket) return new Response(null, { status: 101, webSocket: response.webSocket, headers: { "sec-websocket-protocol": protocol } });
    return response;
  });
}

// --- events -----------------------------------------------------------------

onNewPost(async (db, post) => {
  const ctx = currentContext();
  if (!ctx?.bindings.STREAMING || post.visibility === "direct" || post.rootId !== null) return;
  const author = await accountById(db, post.accountId);
  if (!author) return;
  const [status] = await statuses(ctx, [post], null);
  if (!status) return;
  const payload = JSON.stringify(status);
  // Home: the author and the people here who follow them; mentioned people for followers-only posts.
  const followers = await localFollowerIds(db, author.id, 500);
  const mentioned = (await mentionedIds(db, [post.id])).get(post.id) ?? [];
  const home = [...new Set([...(author.apId ? [] : [author.id]), ...followers, ...(post.visibility === "private" ? mentioned : [])])];
  if (home.length) publish(ctx, { accounts: home, stream: "user", event: "update", payload });
  if (post.visibility === "public" && post.reblogOf === null) {
    publish(ctx, { stream: "public", event: "update", payload });
    if (!author.apId) publish(ctx, { stream: "public:local", event: "update", payload });
  }
});

onNotification(async (db, n) => {
  const ctx = currentContext();
  if (!ctx?.bindings.STREAMING) return;
  const from = await accountById(db, n.fromAccountId);
  if (!from) return;
  const post = n.postId ? await postById(db, n.postId) : null;
  const [status] = post ? await statuses(ctx, [post], await accountById(db, n.accountId)) : [];
  const payload = JSON.stringify({
    id: String(n.id),
    type: n.kind === "reply" ? "mention" : n.kind,
    created_at: new Date(n.createdAt * 1000).toISOString(),
    account: account(ctx, from),
    ...(status ? { status } : {}),
  });
  publish(ctx, { accounts: [n.accountId], stream: "user:notification", event: "notification", payload });
});
