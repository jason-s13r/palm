import { hashPassword, needsRehash, signJwt, verifyJwt, verifyPassword } from "@palm/auth";
import { nodeinfoVersion, type RequestContext } from "@palm/core";
import {
  accountByHandle,
  accountById,
  accountForLogin,
  markNotificationsRead,
  updateProfile,
  bannedAccounts,
  blockedDomains,
  deletePost,
  deletePostsBy,
  knownDomains,
  openInvite,
  postByIdAny,
  redeemInvite,
  restorePost,
  setBanned,
  setBlockedDomains,
  admins,
  countAccounts,
  createSession,
  instanceSecret,
  setPasswordHash,
  revokeSession,
  sessionAccount,
  siteCounts,
  subscriptions,
  threadCounts,
  deleteMedia,
  mediaById,
  mediaResponse,
  storeMedia,
  type Account,
} from "@palm/db";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type {
  CommentReplyView,
  GetFederatedInstancesResponse,
  GetPersonDetailsResponse,
  GetPersonMentionsResponse,
  GetRepliesResponse,
  GetReportCountResponse,
  GetSiteResponse,
  GetUnreadCountResponse,
  LoginResponse,
  PersonMentionView,
  PrivateMessagesResponse,
  ResolveObjectResponse,
  SearchResponse,
  SuccessResponse,
} from "lemmy-js-client";
import { followedPeople, inboxItems, lemmyInboxCounts, personThreads, resolveObject, searchThreads, threadRoutes } from "./threads.ts";
import { LEMMY_VERSION, myUserInfo, personView, siteView } from "./views.ts";

export { LEMMY_VERSION };

type Env = { Bindings: RequestContext; Variables: { auth: Auth | null } };
type C = Context<Env>;

interface Auth {
  account: Account;
  sessionId: string;
}

/** Lemmy answers every error as {"error": "<snake_case_reason>"}. */
const fail = (c: C, error: string, status: 400 | 401 | 403 | 404 = 400) => c.json({ error }, status);

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
  return account && account.domain === c.env.domain.domain && !account.banned ? { account, sessionId: claims.sid } : null;
}

const app = new Hono<Env>();

app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"], maxAge: 86400 }));

// Resolve the caller once, for every API route and image upload.
const resolveAuth = async (c: C, next: () => Promise<void>) => {
  c.set("auth", await authenticate(c, tokenOf(c)));
  await next();
};
app.use("/api/v3/*", resolveAuth);
app.use("/pictrs/*", resolveAuth);

// --- images, where Lemmy keeps them (pict-rs) ------------------------------

app.post("/pictrs/image", async (c) => {
  const auth = c.get("auth");
  if (!auth) return c.json({ msg: "not_logged_in" }, 401);
  const form = await c.req.formData().catch(() => null);
  const file = form?.getAll("images[]").find((f): f is File => f instanceof File) ?? (form?.get("images") as File | null);
  if (!(file instanceof File)) return c.json({ msg: "no_image" }, 400);
  const stored = await storeMedia(c.env.bindings.DB, c.env.bindings.MEDIA, auth.account.id, file, null);
  if (typeof stored === "string") return c.json({ msg: stored }, stored === "no_storage" ? 503 : 400);
  return c.json({ msg: "ok", files: [{ file: stored.file, delete_token: stored.deleteToken }] });
});

app.get("/pictrs/image/delete/:token/:file", async (c) => {
  const media = await mediaById(c.env.bindings.DB, c.req.param("file"));
  if (!media || media.deleteToken !== c.req.param("token")) return c.json({ msg: "not_found" }, 404);
  await deleteMedia(c.env.bindings.DB, c.env.bindings.MEDIA, media);
  return c.body(null, 204);
});

app.on(["GET", "HEAD"], "/pictrs/image/:file", async (c) => {
  const response = await mediaResponse(c.env.bindings.MEDIA, c.req.param("file"), c.req.raw);
  return response ?? c.json({ msg: "not_found" }, 404);
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
    software: { name: "lemmy", version: nodeinfoVersion(c.env.version), repository: "https://github.com/jason-s13r/palm", homepage: "https://github.com/jason-s13r/palm" },
    protocols: ["activitypub"],
    services: { inbound: [], outbound: [] },
    openRegistrations: false,
    usage: { users: { total: await countAccounts(c.env.bindings.DB, c.env.domain.domain) }, localPosts: 0, localComments: 0 },
    metadata: { nodeName: c.env.config.instance.name, palm: { version: c.env.version } },
  }),
);

app.get("/api/v3/site", async (c) => {
  const db = c.env.bindings.DB;
  const domain = c.env.domain.domain;
  const auth = c.get("auth");
  const [users, adminAccounts, counts, follows] = await Promise.all([
    countAccounts(db, domain),
    admins(db, domain),
    siteCounts(db, domain),
    // Communities subscribed to, and the people followed as person communities.
    auth
      ? Promise.all([subscriptions(db, auth.account.id), followedPeople(c, auth.account.id)]).then(([a, b]) => [...a, ...b])
      : Promise.resolve([]),
  ]);
  const body: GetSiteResponse = {
    site_view: siteView(c.env, { users, ...counts }),
    admins: adminAccounts.map((a) => personView(c.env, a)),
    version: LEMMY_VERSION,
    ...(auth ? { my_user: myUserInfo(c.env, auth.account, follows) } : {}),
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
  if (found.account.banned) return fail(c, "site_ban");
  if (needsRehash(found.passwordHash)) {
    c.env.waitUntil(hashPassword(body.password).then((hash) => setPasswordHash(db, found.account.id, hash)));
  }
  return c.json(await loginResponse(c, found.account));
});

/** A session and its JWT for an account that has just proved who it is. */
async function loginResponse(c: C, account: Account): Promise<LoginResponse> {
  const db = c.env.bindings.DB;
  const sessionId = await createSession(db, account.id, "lemmy");
  const jwt = await signJwt(
    // iss is the host the app signed in on, as Lemmy does: Voyager reads it to
    // know which server to talk to, so it must be the Lemmy API host.
    { sub: String(account.id), sid: sessionId, iss: c.env.host, iat: Math.floor(Date.now() / 1000) },
    await instanceSecret(db, "lemmy-jwt"),
  );
  return { jwt, registration_created: false, verify_email_sent: false };
}

// Sign-up with an invite code, which Lemmy apps send as the application answer.
app.post("/api/v3/user/register", async (c) => {
  if (c.env.config.registration !== "invite") return fail(c, "registration_closed");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const code = typeof body.answer === "string" ? body.answer.trim() : "";
  if (!/^[a-zA-Z0-9_]{1,20}$/.test(username)) return fail(c, "invalid_name");
  if (password.length < 10 || password.length > 60) return fail(c, "invalid_password");
  if (body.password_verify !== undefined && body.password_verify !== password) return fail(c, "passwords_dont_match");
  const db = c.env.bindings.DB;
  const invite = await openInvite(db, c.env.domain.domain, code);
  if (!invite) return fail(c, "registration_application_answer_required");
  const account = await redeemInvite(db, invite, { domain: c.env.domain.domain, username, passwordHash: await hashPassword(password) });
  if (!account) return fail(c, "user_already_exists");
  return c.json(await loginResponse(c, account));
});

// --- moderation, for admins ---------------------------------------------------------

/** The signed-in admin, or null. */
const adminOf = (c: C) => {
  const auth = c.get("auth");
  return auth?.account.role === "admin" ? auth.account : null;
};

app.post("/api/v3/user/ban", async (c) => {
  const admin = adminOf(c);
  if (!admin) return fail(c, "not_an_admin", 403);
  type Ban = { person_id?: number; ban?: boolean; remove_data?: boolean };
  const body = await c.req.json<Ban>().catch((): Ban => ({}));
  const db = c.env.bindings.DB;
  const target = body.person_id === undefined ? null : await accountById(db, body.person_id);
  if (!target || target.id === admin.id) return fail(c, "couldnt_find_person", 404);
  await setBanned(db, target.id, body.ban !== false);
  if (body.ban !== false && body.remove_data) await deletePostsBy(db, target.id);
  return c.json({ person_view: personView(c.env, (await accountById(db, target.id))!), banned: body.ban !== false });
});

app.get("/api/v3/user/banned", async (c) => {
  if (!adminOf(c)) return fail(c, "not_an_admin", 403);
  return c.json({ banned: (await bannedAccounts(c.env.bindings.DB)).map((a) => personView(c.env, a)) });
});

// Removing a post or comment as an admin: it's deleted here, and other servers hear if it was local.
for (const [path, field] of [
  ["/api/v3/post/remove", "post_id"],
  ["/api/v3/comment/remove", "comment_id"],
] as const) {
  app.post(path, async (c) => {
    if (!adminOf(c)) return fail(c, "not_an_admin", 403);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const id = typeof body[field] === "number" ? (body[field] as number) : -1;
    const db = c.env.bindings.DB;
    const post = await postByIdAny(db, id);
    if (!post) return fail(c, field === "post_id" ? "couldnt_find_post" : "couldnt_find_comment", 404);
    if (body.removed === false) await restorePost(db, post.id);
    else {
      await deletePost(db, post.id);
      if (!post.apId) c.env.activities.enqueue({ kind: "post_deleted", postId: post.id });
    }
    return c.json({ success: true });
  });
}

// Blocking other servers is Lemmy's site setting blocked_instances.
app.put("/api/v3/site", async (c) => {
  if (!adminOf(c)) return fail(c, "not_an_admin", 403);
  const body = await c.req.json<{ blocked_instances?: unknown }>().catch(() => ({}) as { blocked_instances?: unknown });
  if (Array.isArray(body.blocked_instances)) await setBlockedDomains(c.env.bindings.DB, body.blocked_instances.map(String));
  const db = c.env.bindings.DB;
  const [users, counts] = await Promise.all([countAccounts(db, c.env.domain.domain), siteCounts(db, c.env.domain.domain)]);
  return c.json({ site_view: siteView(c.env, { users, ...counts }), taglines: [] });
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
  const username = c.req.query("username");
  let account: Account | null = null;
  if (id) account = await accountById(db, Number(id));
  else if (username) account = await personNamed(c, username);
  else account = auth?.account ?? null;
  // A local account of another domain this deployment serves isn't this one's.
  if (!account || (account.apId === null && account.domain !== c.env.domain.domain)) return fail(c, "couldnt_find_person", 404);
  const [counts, threads] = await Promise.all([threadCounts(db, account.id), personThreads(c, account.id)]);
  const body: GetPersonDetailsResponse = { person_view: personView(c.env, account, counts), ...threads, moderates: [] };
  return c.json(body);
});

// Profile settings: Lemmy apps edit the display name, bio, avatar and banner here.
app.put("/api/v3/user/save_user_settings", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const textOf = (name: string) => (typeof params[name] === "string" ? (params[name] as string).trim() : undefined);
  const imageOf = (name: string) => {
    const value = textOf(name);
    return value === undefined ? undefined : /^https?:\/\//.test(value) ? value : null;
  };
  const displayName = textOf("display_name");
  const bio = textOf("bio");
  await updateProfile(c.env.bindings.DB, auth.account.id, {
    ...(displayName !== undefined ? { displayName: displayName || null } : {}),
    ...(bio !== undefined ? { bio: bio || null } : {}),
    avatarUrl: imageOf("avatar"),
    headerUrl: imageOf("banner"),
  });
  c.env.activities.enqueue({ kind: "profile_updated", accountId: auth.account.id });
  return c.json({ success: true } satisfies SuccessResponse);
});

/** A person by name: "jason", "jason@this.domain", or a remote "name@host", fetched if new. */
async function personNamed(c: C, name: string): Promise<Account | null> {
  const db = c.env.bindings.DB;
  const [local, rawHost] = name.replace(/^@/, "").split("@");
  if (!local) return null;
  const host = rawHost?.toLowerCase() ?? c.env.domain.domain;
  if (host === c.env.domain.domain) return (await accountForLogin(db, host, local))?.account ?? null;
  const known = await accountByHandle(db, local, host);
  if (known) return known;
  const found = await c.env.activities.resolve(`@${local}@${host}`);
  return found?.kind === "account" ? accountById(db, found.id) : null;
}

app.route("/", threadRoutes);

// --- the inbox: replies to and mentions of the signed-in account -------------

app.get("/api/v3/user/unread_count", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const counts = await lemmyInboxCounts(c.env.bindings.DB, auth.account.id);
  return c.json({ ...counts, private_messages: 0 } satisfies GetUnreadCountResponse);
});

app.get("/api/v3/user/replies", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  return c.json({ replies: (await inboxItems(c, auth.account, "reply")) as CommentReplyView[] } satisfies GetRepliesResponse);
});

app.get("/api/v3/user/mention", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  return c.json({ mentions: (await inboxItems(c, auth.account, "mention")) as PersonMentionView[] } satisfies GetPersonMentionsResponse);
});

app.post("/api/v3/comment/mark_as_read", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await c.req.json<{ comment_reply_id?: number; read?: boolean }>().catch(() => ({}) as { comment_reply_id?: number });
  if (params.comment_reply_id !== undefined) await markNotificationsRead(c.env.bindings.DB, auth.account.id, [params.comment_reply_id]);
  return c.json({ success: true } satisfies SuccessResponse);
});

app.post("/api/v3/user/mention/mark_as_read", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  const params = await c.req.json<{ person_mention_id?: number }>().catch(() => ({}) as { person_mention_id?: number });
  if (params.person_mention_id !== undefined) await markNotificationsRead(c.env.bindings.DB, auth.account.id, [params.person_mention_id]);
  return c.json({ success: true } satisfies SuccessResponse);
});

app.post("/api/v3/user/mark_all_as_read", async (c) => {
  const auth = c.get("auth");
  if (!auth) return fail(c, "not_logged_in", 401);
  await markNotificationsRead(c.env.bindings.DB, auth.account.id);
  return c.json({ replies: [] } satisfies GetRepliesResponse);
});
app.get("/api/v3/user/report_count", (c) =>
  c.json({ comment_reports: 0, post_reports: 0, private_message_reports: 0 } satisfies GetReportCountResponse),
);
app.get("/api/v3/user/replies", (c) => c.json({ replies: [] } satisfies GetRepliesResponse));
app.get("/api/v3/user/mention", (c) => c.json({ mentions: [] } satisfies GetPersonMentionsResponse));
// Moderation queues: nothing is reported until reports exist.
app.get("/api/v3/comment/report/list", (c) => c.json({ comment_reports: [] }));
app.get("/api/v3/post/report/list", (c) => c.json({ post_reports: [] }));
app.get("/api/v3/private_message/report/list", (c) => c.json({ private_message_reports: [] }));
app.get("/api/v3/private_message/list", (c) => c.json({ private_messages: [] } satisfies PrivateMessagesResponse));
app.get("/api/v3/federated_instances", async (c) => {
  const db = c.env.bindings.DB;
  const [linked, blocked] = await Promise.all([knownDomains(db), blockedDomains(db)]);
  const instance = (domain: string, i: number) => ({ id: i + 2, domain, published: new Date(0).toISOString() });
  return c.json({
    federated_instances: { linked: linked.map(instance), allowed: [], blocked: blocked.map(instance) },
  } satisfies GetFederatedInstancesResponse);
});
app.get("/api/v3/search", async (c) => {
  const type = c.req.query("type_") ?? "All";
  const query = c.req.query("q")?.trim() ?? "";
  const found = query ? await searchThreads(c, query, type) : { communities: [], posts: [] };
  // A handle or URL is looked up remotely too, as Lemmy does.
  const remote = /^[@!]?[^@\s/]+@[^@\s/]+\.[^@\s/]+$|^https?:\/\//.test(query) ? await resolveObject(c, query) : null;
  return c.json({
    type_: "All",
    comments: remote?.comment ? [remote.comment] : [],
    users: remote?.person ? [remote.person] : [],
    communities: [...(remote?.community ? [remote.community] : []), ...found.communities.filter((x) => x.community.id !== remote?.community?.community.id)],
    posts: [...(remote?.post ? [remote.post] : []), ...found.posts],
  } as SearchResponse);
});
app.get("/api/v3/resolve_object", async (c) => {
  const query = c.req.query("q")?.trim();
  const found = query ? await resolveObject(c, query) : null;
  return found ? c.json(found as ResolveObjectResponse) : fail(c, "couldnt_find_object", 404);
});

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
