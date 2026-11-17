import { base64url, hashPassword, needsRehash, utf8, verifyPassword } from "@palm/auth";
import { escapeHtml, urls, type RequestContext } from "@palm/core";
import {
  takeDueStatuses,
  accountById,
  accountForLogin,
  appByClientId,
  appById,
  consumeCode,
  countAccounts,
  knownDomains,
  createApp,
  createCode,
  createToken,
  revokeToken,
  setPasswordHash,
  tokenGrant,
  openInvite,
  redeemInvite,
  type Account,
  type OAuthApp,
} from "@palm/db";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { authorizePage, codePage } from "./oauth-page.ts";
import { curationRoutes } from "./curation.ts";
import { pushRoutes } from "./push.ts";
import { streamingRoutes } from "./streaming.ts";
import { vapidKeys } from "./webpush.ts";
import { peopleRoutes } from "./people.ts";
import { accountStats, statusRoutes } from "./statuses.ts";
import { account, credentialAccount, instanceV1, instanceV2, MASTODON_VERSION } from "./views.ts";

export { MASTODON_VERSION };
export { PalmStreaming } from "./streaming.ts";

type Env = { Bindings: RequestContext; Variables: { account: Account | null; app: OAuthApp | null } };
type C = Context<Env>;

const OOB = "urn:ietf:wg:oauth:2.0:oob";

/** Mastodon answers errors as {"error": "<human-readable message>"}. */
const fail = (c: C, error: string, status: 400 | 401 | 403 | 404 | 422 = 400) => c.json({ error }, status);

/** Request parameters from the query string and a JSON or form body, merged. */
async function params(c: C): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...c.req.query() };
  if (c.req.method === "GET" || c.req.method === "HEAD") return out;
  const type = c.req.header("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      for (const [k, v] of Object.entries(await c.req.json<Record<string, unknown>>())) {
        if (Array.isArray(v)) out[k] = v.join(" ");
        else if (v !== null && v !== undefined) out[k] = String(v);
      }
    } else if (type.includes("form")) {
      const form = await c.req.parseBody({ all: true });
      for (const [k, v] of Object.entries(form)) {
        const key = k.replace(/\[\]$/, "");
        out[key] = Array.isArray(v) ? v.map(String).join(" ") : String(v);
      }
    }
  } catch {
    // An unreadable body reads as no parameters.
  }
  return out;
}

const requireAccount = (c: C) => c.get("account");

const app = new Hono<Env>();

app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"], maxAge: 86400 }));

app.use("/api/*", async (c, next) => {
  c.set("account", null);
  c.set("app", null);
  const header = c.req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    const db = c.env.bindings.DB;
    const grant = await tokenGrant(db, header.slice(7).trim());
    if (grant) {
      c.set("app", await appById(db, grant.appId));
      if (grant.accountId !== null) {
        const acct = await accountById(db, grant.accountId);
        if (acct?.domain === c.env.domain.domain && acct.apId === null && !acct.banned) c.set("account", acct);
      }
    }
  }
  await next();
});

// A person who opens this host in a browser gets told what it's for.
app.get("/", (c) =>
  c.text(
    `${c.env.config.instance.name}\n\nThis is the Mastodon API for ${c.env.domain.domain}.\n` +
      `Sign in from Ivory, Ice Cubes or the Mastodon app, with ${c.env.host} as the server.\n`,
  ),
);

// Profile and post pages (the `url` of accounts and statuses). palm has no web
// UI, so they lead to the ActivityPub IDs, which send browsers on as configured.
app.get("/:handle{@[^/]+}", (c) => c.redirect(urls.user(c.env.domain.domain, c.req.param("handle").slice(1)), 302));
app.get("/:handle{@[^/]+}/:id{[0-9]+}", (c) => c.redirect(urls.object(c.env.domain.domain, c.req.param("id")), 302));

// --- discovery -------------------------------------------------------------

app.get("/.well-known/nodeinfo", (c) =>
  c.json({ links: [{ rel: "http://nodeinfo.diaspora.software/ns/schema/2.0", href: `https://${c.env.host}/nodeinfo/2.0` }] }),
);
app.get("/nodeinfo/2.0", async (c) =>
  c.json({
    version: "2.0",
    software: { name: "mastodon", version: MASTODON_VERSION },
    protocols: ["activitypub"],
    services: { inbound: [], outbound: [] },
    openRegistrations: false,
    usage: { users: { total: await countAccounts(c.env.bindings.DB, c.env.domain.domain) }, localPosts: 0 },
    metadata: { nodeName: c.env.config.instance.name },
  }),
);
app.get("/.well-known/oauth-authorization-server", (c) => {
  const base = `https://${c.env.host}`;
  return c.json({
    issuer: `${base}/`,
    service_documentation: "https://docs.joinmastodon.org/",
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    app_registration_endpoint: `${base}/api/v1/apps`,
    scopes_supported: ["read", "write", "follow", "push", "profile"],
    response_types_supported: ["code"],
    response_modes_supported: ["query", "fragment", "form_post"],
    grant_types_supported: ["authorization_code", "client_credentials"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
  });
});

app.get("/api/v1/instance", async (c) =>
  c.json(instanceV1(c.env, c.env.version, await countAccounts(c.env.bindings.DB, c.env.domain.domain))),
);
app.get("/api/v2/instance", async (c) => {
  const instance = instanceV2(c.env, c.env.version, await countAccounts(c.env.bindings.DB, c.env.domain.domain));
  // Apps subscribe to push with this key.
  instance.configuration.vapid.public_key = (await vapidKeys(c.env.bindings.DB)).publicKey;
  return c.json(instance);
});

// --- apps and OAuth --------------------------------------------------------

app.post("/api/v1/apps", async (c) => {
  const p = await params(c);
  const redirectUris = (p.redirect_uris ?? "").split(/\s+/).filter(Boolean);
  if (!p.client_name || redirectUris.length === 0) return fail(c, "client_name and redirect_uris are required", 422);
  const created = await createApp(c.env.bindings.DB, {
    name: p.client_name,
    website: p.website || null,
    redirectUris,
    scopes: p.scopes || "read",
  });
  return c.json({
    id: String(created.id),
    name: created.name,
    website: created.website,
    scopes: created.scopes.split(" "),
    redirect_uri: created.redirectUris.join("\n"),
    redirect_uris: created.redirectUris,
    client_id: created.clientId,
    client_secret: created.clientSecret,
    client_secret_expires_at: 0,
    vapid_key: "",
  });
});

app.get("/api/v1/apps/verify_credentials", (c) => {
  const a = c.get("app");
  if (!a) return fail(c, "The access token is invalid", 401);
  return c.json({ id: String(a.id), name: a.name, website: a.website, scopes: a.scopes.split(" "), redirect_uris: a.redirectUris, vapid_key: "" });
});

/** The authorize request's parameters, checked against the registered app. */
async function authorizeRequest(c: C, p: Record<string, string>) {
  if ((p.response_type ?? "code") !== "code") return { error: "Only response_type=code is supported." } as const;
  const client = p.client_id ? await appByClientId(c.env.bindings.DB, p.client_id) : null;
  if (!client) return { error: "Unknown app. Try adding the account again from the app." } as const;
  const redirectUri = p.redirect_uri || client.redirectUris[0] || OOB;
  if (!client.redirectUris.includes(redirectUri)) return { error: "That redirect address isn't registered for this app." } as const;
  if (p.code_challenge && (p.code_challenge_method ?? "plain") !== "S256") {
    return { error: "Only S256 code challenges are supported." } as const;
  }
  return { client, redirectUri, scopes: p.scope || client.scopes } as const;
}

const carried = (p: Record<string, string>) =>
  Object.fromEntries(
    ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method"]
      .filter((k) => p[k] !== undefined)
      .map((k) => [k, p[k] as string]),
  );

app.get("/oauth/authorize", async (c) => {
  const p = await params(c);
  const request = await authorizeRequest(c, p);
  if ("error" in request) return c.html(`<p>${request.error}</p>`, 400);
  return c.html(authorizePage({ instanceName: c.env.config.instance.name, appName: request.client.name, params: carried(p) }));
});

app.post("/oauth/authorize", async (c) => {
  const p = await params(c);
  const request = await authorizeRequest(c, p);
  if ("error" in request) return c.html(`<p>${request.error}</p>`, 400);
  const db = c.env.bindings.DB;
  const username = (p.username ?? "").trim().replace(/^@/, "").replace(/@.*$/, "");
  const found = username ? await accountForLogin(db, c.env.domain.domain, username) : null;
  const ok = found?.passwordHash && (await verifyPassword(p.password ?? "", found.passwordHash));
  if (!found || !ok || found.account.banned) {
    return c.html(
      authorizePage({
        instanceName: c.env.config.instance.name,
        appName: request.client.name,
        params: carried(p),
        error: found?.account.banned && ok ? "This account is suspended." : "That username and password don't match.",
        username,
      }),
      401,
    );
  }
  if (found.passwordHash && needsRehash(found.passwordHash)) {
    c.env.waitUntil(hashPassword(p.password ?? "").then((hash) => setPasswordHash(db, found.account.id, hash)));
  }
  const code = await createCode(db, {
    appId: request.client.id,
    accountId: found.account.id,
    redirectUri: request.redirectUri,
    scopes: request.scopes,
    codeChallenge: p.code_challenge || null,
  });
  if (request.redirectUri === OOB) return c.html(codePage(c.env.config.instance.name, code));
  const target = new URL(request.redirectUri);
  target.searchParams.set("code", code);
  if (p.state) target.searchParams.set("state", p.state);
  return c.redirect(target.toString(), 302);
});

/** Client credentials from the body or HTTP Basic auth. */
function clientCredentials(c: C, p: Record<string, string>) {
  const basic = c.req.header("authorization");
  if (basic?.toLowerCase().startsWith("basic ")) {
    const [id, secret] = atob(basic.slice(6).trim()).split(":");
    return { clientId: decodeURIComponent(id ?? ""), clientSecret: decodeURIComponent(secret ?? "") };
  }
  return { clientId: p.client_id ?? "", clientSecret: p.client_secret ?? "" };
}

async function s256(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(verifier))));
}

app.post("/oauth/token", async (c) => {
  const p = await params(c);
  const db = c.env.bindings.DB;
  const { clientId, clientSecret } = clientCredentials(c, p);
  const client = clientId ? await appByClientId(db, clientId) : null;
  const invalidClient = () => c.json({ error: "invalid_client", error_description: "Client authentication failed." }, 401);
  const invalidGrant = () =>
    c.json({ error: "invalid_grant", error_description: "The authorization code is invalid, expired or already used." }, 400);

  if (p.grant_type === "client_credentials") {
    if (!client || client.clientSecret !== clientSecret) return invalidClient();
    const { token, createdAt } = await createToken(db, { appId: client.id, accountId: null, scopes: p.scope || "read" });
    return c.json({ access_token: token, token_type: "Bearer", scope: p.scope || "read", created_at: createdAt });
  }

  if (p.grant_type !== "authorization_code") {
    return c.json({ error: "unsupported_grant_type", error_description: "Use authorization_code." }, 400);
  }
  if (!client) return invalidClient();
  const grant = p.code ? await consumeCode(db, p.code) : null;
  if (!grant || grant.appId !== client.id) return invalidGrant();
  if (grant.codeChallenge) {
    // PKCE: the verifier stands in for the client secret.
    if (!p.code_verifier || (await s256(p.code_verifier)) !== grant.codeChallenge) return invalidGrant();
  } else if (client.clientSecret !== clientSecret) {
    return invalidClient();
  }
  if (p.redirect_uri && p.redirect_uri !== grant.redirectUri) return invalidGrant();
  const { token, createdAt } = await createToken(db, { appId: client.id, accountId: grant.accountId, scopes: grant.scopes });
  return c.json({ access_token: token, token_type: "Bearer", scope: grant.scopes, created_at: createdAt });
});

// Sign-up from a Mastodon app, with an invite code in the reason field. Needs
// the app's own token (client_credentials), as Mastodon does.
app.post("/api/v1/accounts", async (c) => {
  const client = c.get("app");
  if (!client) return fail(c, "This action needs an app token", 401);
  if (c.env.config.registration !== "invite") return fail(c, "Registrations are closed", 403);
  const p = await params(c);
  const username = (p.username ?? "").trim();
  const password = p.password ?? "";
  if (!/^[a-zA-Z0-9_]{1,20}$/.test(username)) return fail(c, "Validation failed: Username is invalid", 422);
  if (password.length < 10) return fail(c, "Validation failed: Password is too short (minimum is 10 characters)", 422);
  const db = c.env.bindings.DB;
  const invite = await openInvite(db, c.env.domain.domain, p.invite_code ?? p.reason ?? "");
  if (!invite) return fail(c, "Validation failed: An invite code is needed: put it in the reason field", 422);
  const created = await redeemInvite(db, invite, { domain: c.env.domain.domain, username, passwordHash: await hashPassword(password) });
  if (!created) return fail(c, "Validation failed: Username has already been taken", 422);
  const { token, createdAt } = await createToken(db, { appId: client.id, accountId: created.id, scopes: "read write follow push" });
  return c.json({ access_token: token, token_type: "Bearer", scope: "read write follow push", created_at: createdAt });
});

app.post("/oauth/revoke", async (c) => {
  const p = await params(c);
  if (p.token) await revokeToken(c.env.bindings.DB, p.token);
  return c.json({});
});

// --- accounts --------------------------------------------------------------

app.get("/api/v1/accounts/verify_credentials", async (c) => {
  const acct = requireAccount(c);
  if (!acct) return fail(c, "The access token is invalid", 401);
  return c.json(credentialAccount(c.env, acct, await accountStats(c.env, acct)));
});

app.route("/", peopleRoutes);

app.get("/api/v1/preferences", (c) =>
  c.json({
    "posting:default:visibility": "public",
    "posting:default:sensitive": false,
    "posting:default:language": null,
    "reading:expand:media": "default",
    "reading:expand:spoilers": false,
  }),
);

// --- statuses and timelines ------------------------------------------------

app.route("/", streamingRoutes);
app.route("/", pushRoutes);
app.route("/", curationRoutes);
app.route("/", statusRoutes);

// --- lists that stay empty until federation brings content (M2, M6) --------

const empty = (c: C) => c.json([]);
for (const path of [
  "/api/v1/accounts/:id/endorsements",
  "/api/v1/endorsements",
  "/api/v1/filters",
  "/api/v1/custom_emojis",
  "/api/v1/announcements",
  "/api/v1/blocks",
  "/api/v1/mutes",
  "/api/v1/domain_blocks",
  "/api/v1/scheduled_statuses",
  "/api/v1/trends",
  "/api/v1/trends/tags",
  "/api/v1/trends/statuses",
  "/api/v1/trends/links",
  "/api/v1/suggestions",
  "/api/v2/suggestions",
]) {
  app.get(path, empty);
}

app.get("/api/v1/instance/translation_languages", (c) => c.json({}));
app.get("/api/v1/instance/extended_description", (c) =>
  c.json({ updated_at: new Date(0).toISOString(), content: escapeHtml(c.env.config.instance.description ?? "") }),
);
// The servers palm has met: people and communities it keeps.
app.get("/api/v1/instance/peers", async (c) => c.json(await knownDomains(c.env.bindings.DB)));
// Weekly activity isn't kept; an empty list is what a new server answers.
app.get("/api/v1/instance/activity", (c) => c.json([]));

app.get("/api/v2/notifications/policy", (c) =>
  c.json({
    for_not_following: "accept",
    for_not_followers: "accept",
    for_new_accounts: "accept",
    for_private_mentions: "accept",
    for_limited_accounts: "filter",
    summary: { pending_requests_count: 0, pending_notifications_count: 0 },
  }),
);

app.all("/api/*", (c) => {
  console.warn(JSON.stringify({ palm: "unknown_endpoint", api: "mastodon", method: c.req.method, path: c.req.path }));
  return fail(c, "Record not found", 404);
});

app.notFound((c) => fail(c, "Record not found", 404));

/** Serves one request on a Mastodon API host. */
export function handleMastodon(request: Request, ctx: RequestContext): Promise<Response> {
  return Promise.resolve(app.fetch(request, ctx));
}

/**
 * Publishes scheduled posts that are due, each as its author would have
 * posted it then, through the same endpoint (with a token made for the
 * moment). Run by the Worker's cron.
 */
export async function publishDueStatuses(contextFor: (domain: string) => RequestContext | null): Promise<number> {
  let published = 0;
  const any = contextFor("");
  if (!any) return 0;
  const db = any.bindings.DB;
  for (const due of await takeDueStatuses(db)) {
    const author = await accountById(db, due.accountId);
    const ctx = author ? contextFor(author.domain) : null;
    if (!author || !ctx || author.banned) continue;
    const { token } = await createToken(db, { appId: due.appId, accountId: author.id, scopes: "read write follow" });
    const response = await handleMastodon(
      new Request(`https://${ctx.domain.domain}/api/v1/statuses`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(due.params),
      }),
      ctx,
    );
    await revokeToken(db, token);
    if (response.ok) published++;
    else console.warn(JSON.stringify({ palm: "scheduled_post_failed", id: due.id, status: response.status }));
  }
  return published;
}
