import { hashPassword, needsRehash, signJwt, verifyJwt, verifyPassword } from "@palm/auth";
import type { RequestContext } from "@palm/core";
import {
  accountById,
  accountForLogin,
  admins,
  countAccounts,
  createSession,
  instanceSecret,
  setPasswordHash,
  revokeSession,
  sessionAccount,
  type Account,
} from "@palm/db";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type {
  GetFederatedInstancesResponse,
  GetPersonDetailsResponse,
  GetPersonMentionsResponse,
  GetPostsResponse,
  GetRepliesResponse,
  GetReportCountResponse,
  GetSiteResponse,
  GetUnreadCountResponse,
  ListCommunitiesResponse,
  LoginResponse,
  PrivateMessagesResponse,
  SearchResponse,
  SuccessResponse,
} from "lemmy-js-client";
import { LEMMY_VERSION, myUserInfo, personView, siteView } from "./views.ts";

export { LEMMY_VERSION };

type Env = { Bindings: RequestContext; Variables: { auth: Auth | null } };
type C = Context<Env>;

interface Auth {
  account: Account;
  sessionId: string;
}

/** Lemmy answers every error as {"error": "<snake_case_reason>"}. */
const fail = (c: C, error: string, status: 400 | 401 | 404 = 400) => c.json({ error }, status);

/**
 * The JWT a Lemmy app sends: the Authorization header on 0.19, and the older
 * `auth` query or body field, or the `jwt` cookie, from older apps.
 */
function tokenOf(c: C, body?: Record<string, unknown>): string | null {
  const header = c.req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const fromQuery = c.req.query("auth");
  if (fromQuery) return fromQuery;
  if (typeof body?.auth === "string") return body.auth;
  const cookie = c.req.header("cookie")?.match(/(?:^|;\s*)jwt=([^;]+)/);
  return cookie?.[1] ?? null;
}

async function authenticate(c: C, token: string | null): Promise<Auth | null> {
  if (!token) return null;
  const db = c.env.bindings.DB;
  const claims = await verifyJwt(token, await instanceSecret(db, "lemmy-jwt"));
  if (!claims) return null;
  const accountId = await sessionAccount(db, claims.sid);
  if (accountId === null || String(accountId) !== claims.sub) return null;
  const account = await accountById(db, accountId);
  return account && account.domain === c.env.domain.domain ? { account, sessionId: claims.sid } : null;
}

const app = new Hono<Env>();

app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"], maxAge: 86400 }));

// Resolve the caller once, for every API route.
app.use("/api/v3/*", async (c, next) => {
  c.set("auth", await authenticate(c, tokenOf(c)));
  await next();
});

// A person who opens this host in a browser gets told what it's for.
app.get("/", (c) =>
  c.text(
    `${c.env.config.instance.name}\n\nThis is the Lemmy API for ${c.env.domain.domain}.\n` +
      `Sign in from Voyager, Mlem or Thunder, with ${c.env.host} as the server.\n`,
  ),
);

// Apps and other servers detect the software from nodeinfo. This host answers
// as Lemmy, so Lemmy apps treat it as one.
app.get("/.well-known/nodeinfo", (c) =>
  c.json({ links: [{ rel: "http://nodeinfo.diaspora.software/ns/schema/2.1", href: `https://${c.env.host}/nodeinfo/2.1` }] }),
);
app.get("/nodeinfo/2.1", async (c) =>
  c.json({
    version: "2.1",
    software: { name: "lemmy", version: LEMMY_VERSION, repository: "https://github.com/jason-s13r/palm" },
    protocols: ["activitypub"],
    services: { inbound: [], outbound: [] },
    openRegistrations: false,
    usage: { users: { total: await countAccounts(c.env.bindings.DB, c.env.domain.domain) }, localPosts: 0, localComments: 0 },
    metadata: {},
  }),
);

app.get("/api/v3/site", async (c) => {
  const db = c.env.bindings.DB;
  const domain = c.env.domain.domain;
  const [users, adminAccounts] = await Promise.all([countAccounts(db, domain), admins(db, domain)]);
  const auth = c.get("auth");
  const body: GetSiteResponse = {
    site_view: siteView(c.env, users),
    admins: adminAccounts.map((a) => personView(c.env, a)),
    version: LEMMY_VERSION,
    ...(auth ? { my_user: myUserInfo(c.env, auth.account) } : {}),
    all_languages: [{ id: 0, code: "und", name: "Undetermined" }, { id: 37, code: "en", name: "English" }],
    discussion_languages: [],
    taglines: [],
    custom_emojis: [],
    blocked_urls: [],
  };
  return c.json(body);
});

app.post("/api/v3/user/login", async (c) => {
  const body = await c.req.json<{ username_or_email?: unknown; password?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.username_or_email !== "string" || typeof body.password !== "string") {
    return fail(c, "incorrect_login");
  }
  const db = c.env.bindings.DB;
  const domain = c.env.domain.domain;
  // Accept "jason", "@jason" or "jason@1j.nz".
  const username = body.username_or_email.trim().replace(/^@/, "").replace(new RegExp(`@${domain.replaceAll(".", "\\.")}$`, "i"), "");
  const found = await accountForLogin(db, domain, username);
  if (!found?.passwordHash || !(await verifyPassword(body.password, found.passwordHash))) {
    return fail(c, "incorrect_login");
  }
  if (needsRehash(found.passwordHash)) {
    c.env.waitUntil(hashPassword(body.password).then((hash) => setPasswordHash(db, found.account.id, hash)));
  }
  const sessionId = await createSession(db, found.account.id, "lemmy");
  const jwt = await signJwt(
    { sub: String(found.account.id), sid: sessionId, iss: domain, iat: Math.floor(Date.now() / 1000) },
    await instanceSecret(db, "lemmy-jwt"),
  );
  const response: LoginResponse = { jwt, registration_created: false, verify_email_sent: false };
  return c.json(response);
});

app.post("/api/v3/user/logout", async (c) => {
  const auth = c.get("auth");
  if (auth) await revokeSession(c.env.bindings.DB, auth.sessionId);
  return c.json({ success: true } satisfies SuccessResponse);
});

app.get("/api/v3/user/validate_auth", (c) =>
  c.get("auth") ? c.json({ success: true } satisfies SuccessResponse) : fail(c, "not_logged_in", 401),
);

app.get("/api/v3/user", async (c) => {
  const auth = c.get("auth");
  const db = c.env.bindings.DB;
  const id = c.req.query("person_id");
  const username = c.req.query("username")?.replace(/@.*$/, "");
  let account: Account | null = null;
  if (id) account = await accountById(db, Number(id));
  else if (username) account = (await accountForLogin(db, c.env.domain.domain, username))?.account ?? null;
  else account = auth?.account ?? null;
  if (!account || account.domain !== c.env.domain.domain) return fail(c, "couldnt_find_person", 404);
  const body: GetPersonDetailsResponse = { person_view: personView(c.env, account), comments: [], posts: [], moderates: [] };
  return c.json(body);
});

// Feeds and inboxes: empty until federation brings content in (M2, M3).
app.get("/api/v3/post/list", (c) => c.json({ posts: [] } satisfies GetPostsResponse));
app.get("/api/v3/comment/list", (c) => c.json({ comments: [] }));
app.get("/api/v3/community/list", (c) => c.json({ communities: [] } satisfies ListCommunitiesResponse));
app.get("/api/v3/user/unread_count", (c) =>
  c.json({ replies: 0, mentions: 0, private_messages: 0 } satisfies GetUnreadCountResponse),
);
app.get("/api/v3/user/report_count", (c) =>
  c.json({ comment_reports: 0, post_reports: 0, private_message_reports: 0 } satisfies GetReportCountResponse),
);
app.get("/api/v3/user/replies", (c) => c.json({ replies: [] } satisfies GetRepliesResponse));
app.get("/api/v3/user/mention", (c) => c.json({ mentions: [] } satisfies GetPersonMentionsResponse));
app.get("/api/v3/private_message/list", (c) => c.json({ private_messages: [] } satisfies PrivateMessagesResponse));
app.get("/api/v3/federated_instances", (c) =>
  c.json({ federated_instances: { linked: [], allowed: [], blocked: [] } } satisfies GetFederatedInstancesResponse),
);
app.get("/api/v3/search", (c) =>
  c.json({ type_: "All", comments: [], posts: [], communities: [], users: [] } satisfies SearchResponse),
);
app.get("/api/v3/resolve_object", (c) => fail(c, "couldnt_find_object", 404));
app.get("/api/v3/post", (c) => fail(c, "couldnt_find_post", 404));
app.get("/api/v3/community", (c) => fail(c, "couldnt_find_community", 404));

// Everything else: logged, so the next endpoint to build shows up in the
// Worker's logs as apps ask for it.
app.all("/api/*", (c) => {
  console.warn(JSON.stringify({ palm: "unknown_endpoint", api: "lemmy", method: c.req.method, path: c.req.path }));
  return fail(c, "unknown_endpoint", 404);
});

app.notFound((c) => fail(c, "not_found", 404));

/** Serves one request on a Lemmy API host. */
export function handleLemmy(request: Request, ctx: RequestContext): Promise<Response> {
  return Promise.resolve(app.fetch(request, ctx));
}
