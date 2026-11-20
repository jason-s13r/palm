import { htmlToText, urls, type RequestContext } from "@palm/core";
import {
  accountByHandle,
  accountsByIds,
  communityById,
  communityByName,
  listCommunities,
  listStatusComments,
  listThreadComments,
  listThreadPosts,
  mediaForPosts,
  postByIdAny,
  statusRootOf,
  type Account,
  type Community,
  type Media,
  type Post,
  type PostClient,
  type ThreadComment,
} from "@palm/db";
import { Hono, type Context } from "hono";
import { html, type Html, notFound, page, raw, time } from "./html.ts";

/**
 * palm's web pages: just enough for a shared link to open on something.
 * A profile, a post with its comments, a community's posts, and an index.
 * Plain HTML with a few lines of CSS and no JavaScript; reading and replying
 * properly is for the apps. Each page carries Open Graph tags so links
 * preview well, and points at its ActivityPub object.
 *
 * Only public and unlisted posts are shown. Other servers' posts and
 * communities are shown when palm keeps them, marked noindex and with the
 * original as canonical.
 */

type Env = { Bindings: RequestContext };
type C = Context<Env>;

const app = new Hono<Env>();

const site = (c: C) => ({ name: c.env.config.instance.name, domain: c.env.domain.domain, version: c.env.version });
const origin = (c: C) => `https://${c.env.domain.domain}`;
const here = (c: C) => origin(c) + new URL(c.req.url).pathname;

const wantsActivityPub = (c: C) => /activity\+json|ld\+json/.test(c.req.header("accept") ?? "");

const isPublic = (p: Post & { deleted?: boolean }) =>
  !p.deleted && (p.visibility === "public" || p.visibility === "unlisted") && p.reblogOf === null;

const points = (n: number) => `${n} ${Math.abs(n) === 1 ? "point" : "points"}`;
/** palm's own picture, for previews of pages with none of their own. */
const fallbackImage = (c: C) => `${origin(c)}/palm/avatar.png`;

const handleOf = (a: Account) => `@${a.username}@${a.domain}`;
const nameOf = (a: Account) => a.displayName || a.username;
/** A handle as bylines show it: "jason" here, "master5o1@lemmy.nz" elsewhere. */
const shortHandle = (a: Account) => (a.apId ? `${a.username}@${a.domain}` : a.username);
const hasDisplayName = (a: Account) => !!a.displayName && a.displayName !== a.username;
/** Short bylines (comments, lists) use the handle, so local and remote people tell apart; the display name shows on hover. */
const personLink = (a: Account) => html`<a href="${profileHref(a)}"${hasDisplayName(a) ? html` title="${a.displayName}"` : ""}>${shortHandle(a)}</a>`;
/** A post's byline: "Jason Test @jason@1j.nz", or the handle alone when there's no display name to go with it. */
const authorLine = (a: Account) =>
  hasDisplayName(a) ? html`<a href="${profileHref(a)}">${a.displayName}</a> ${handleOf(a)}` : html`<a href="${profileHref(a)}">${shortHandle(a)}</a>`;

/** Where palm shows a person: their own page here, or their server's. */
const profileHref = (a: Account) => (a.apId ? (a.profileUrl ?? a.apId) : `/@${encodeURIComponent(a.username)}`);
const communityHref = (x: Community) => (x.apId ? `/c/${encodeURIComponent(x.name)}@${x.domain}` : `/c/${encodeURIComponent(x.name)}`);
/** A post's page here: Lemmy posts and comments by their Lemmy paths, statuses under their author. */
const postHref = (p: Post, author?: Account) =>
  p.rootId !== null ? `/comment/${p.id}` : p.communityId !== null ? `/post/${p.id}` : author && !author.apId ? `/@${author.username}/${p.id}` : `/post/${p.id}`;

/** A short plain-text description of some post HTML. */
const excerpt = (htmlText: string, length = 200) => {
  const text = htmlToText(htmlText).replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};

const isImage = (type: string | null | undefined, url: string) => (type ?? "").startsWith("image/") || /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(url);

interface Attachment {
  url: string;
  type: string | null;
  description: string | null;
}

function attachmentsOf(c: C, p: Post, media: Map<number, Media[]>): Attachment[] {
  const local = (media.get(p.id) ?? []).map((m) => ({ url: urls.media(c.env.domain.domain, m.file), type: m.contentType, description: m.description }));
  return [...local, ...p.attachments.map((a) => ({ url: a.url, type: a.mediaType, description: a.description }))];
}

const renderAttachments = (list: Attachment[]) =>
  list.map((a) =>
    (a.type ?? "").startsWith("video/")
      ? html`<p><video src="${a.url}" controls preload="none"></video></p>`
      : isImage(a.type, a.url)
        ? html`<p><a href="${a.url}"><img src="${a.url}" alt="${a.description ?? ""}" loading="lazy"></a></p>`
        : html`<p><a href="${a.url}">${a.description ?? a.url}</a></p>`,
  );

/** A post's text, behind a summary when it carries a content warning. */
/** The service names a post's client shows as. */
const CLIENT_NAMES: Record<PostClient, string> = { lemmy: "Lemmy", mastodon: "Mastodon", pixelfed: "Pixelfed" };

type Posted = Pick<Post, "client" | "clientApp" | "clientDevice" | "communityId" | "apId">;

/**
 * Where a post was written, as far as the instance's `postClients` setting
 * shows: " · on Pixelfed · via Ivory for iPhone". "On" is the kind of post:
 * anything in a community is Lemmy's; a local status is Pixelfed's when a
 * Pixelfed app wrote it, Mastodon's when another app did. Another server's status says
 * nothing, since palm doesn't know what that server runs.
 */
function postedOf(c: C, p: Posted): Html | string {
  const level = c.env.config.postClients ?? "app";
  if (level === "off") return "";
  // A local status from before palm kept its client says nothing: it could be either.
  const on = p.communityId !== null ? "Lemmy" : p.apId !== null || !p.client ? null : p.client === "pixelfed" ? "Pixelfed" : "Mastodon";
  if (!on) return "";
  const parts: (Html | string)[] = [html` · <span class="via">on ${on}</span>`];
  if (level === "app" || level === "device") {
    const kind = p.client ? CLIENT_NAMES[p.client] : null;
    // A nameless app is named by its kind when that differs from where the post is: "via a Mastodon app".
    let app = p.clientApp ?? (kind && kind !== on ? `a ${kind} app` : null);
    const device = level === "device" ? p.clientDevice : null;
    // "on Pixelfed · via Pixelfed" says nothing new, unless a device follows.
    if (app && app.toLowerCase() === on.toLowerCase() && !device) app = null;
    // Some apps name their platform already ("Pixelfed for iOS"), so the device isn't added twice.
    const via = app && device && !/\bfor\s+\S/i.test(app) ? `${app} for ${device}` : (app ?? device);
    if (via) parts.push(html` · <span class="via">via ${via}</span>`);
  }
  return html`${parts}`;
}

function renderBody(p: Post, attachments: Attachment[]): Html {
  const inner = html`<div class="content">${raw(p.contentHtml)}</div>${renderAttachments(attachments)}`;
  if (p.spoilerText || p.sensitive) return html`<details><summary>${p.spoilerText || "Sensitive content"}</summary>${inner}</details>`;
  return inner;
}

const score = async (db: D1Database, postId: number) =>
  (
    await db
      .prepare("SELECT (SELECT COALESCE(SUM(score), 0) FROM votes WHERE post_id = ?1) + (SELECT COALESCE(SUM(score), 0) FROM remote_votes WHERE post_id = ?1) AS s")
      .bind(postId)
      .first<{ s: number }>()
  )?.s ?? 0;

// --- discovery: ActivityPub clients asking for a web URL get the object -----

app.get("/:handle{@[^/@]+}", async (c, next) => (wantsActivityPub(c) ? c.redirect(urls.user(c.env.domain.domain, c.req.param("handle").slice(1)), 302) : next()));
for (const path of ["/:handle{@[^/@]+}/:id{[0-9]+}", "/post/:id{[0-9]+}", "/comment/:id{[0-9]+}"]) {
  app.get(path, async (c, next) => {
    if (!wantsActivityPub(c)) return next();
    const post = await postByIdAny(c.env.bindings.DB, Number(c.req.param("id")));
    if (!post || !isPublic(post)) return c.json({ error: "not_found" }, 404);
    return c.redirect(post.apId ?? urls.object(c.env.domain.domain, String(post.id)), 302);
  });
}

// --- the index --------------------------------------------------------------

app.get("/", async (c) => {
  if (c.env.config.browserRedirect) return c.redirect(c.env.config.browserRedirect, 302);
  const db = c.env.bindings.DB;
  const [communities, { results: people }] = await Promise.all([
    listCommunities(db, { domain: c.env.domain.domain, scope: "local", viewerId: null, limit: 50, offset: 0 }),
    db
      .prepare("SELECT id, username, display_name FROM accounts WHERE domain = ? AND ap_id IS NULL AND banned_at IS NULL ORDER BY username LIMIT 200")
      .bind(c.env.domain.domain)
      .all<{ id: number; username: string; display_name: string | null }>(),
  ]);
  const description = c.env.config.instance.description;
  return page(
    site(c),
    { title: c.env.config.instance.name, description, url: `${origin(c)}/` },
    html`<h1>${c.env.config.instance.name}</h1>
${description ? html`<p>${description}</p>` : ""}
${communities.length ? html`<h2>Communities</h2><ul>${communities.map((x) => html`<li><a href="${communityHref(x)}">!${x.name}</a> · ${x.title}</li>`)}</ul>` : ""}
<h2>People</h2>
<ul>${people.map((p) => html`<li><a href="/@${encodeURIComponent(p.username)}">${p.display_name || p.username}</a> · @${p.username}@${c.env.domain.domain}</li>`)}</ul>`,
  );
});

// --- terms, privacy and help -------------------------------------------------
// The Pixelfed app links to these (newer builds to /e/terms and /e/privacy).
// A page here keeps them from falling through to `browserRedirect`.

for (const [paths, title] of [
  [["/site/terms", "/e/terms"], "Terms of use"],
  [["/site/privacy", "/e/privacy"], "Privacy policy"],
  [["/site/help", "/site/about"], "Help"],
] as const) {
  for (const path of paths) {
    app.get(path, (c) => page(site(c), { title, url: here(c) }, html`<h1>${title}</h1>`));
  }
}

// --- interactions from other servers ------------------------------------------

/**
 * Following or replying "from another server": Mastodon's web interface asks
 * for the viewer's server and sends them to /authorize_interaction?uri=…
 * there (older versions: /authorize_follow?acct=…). palm has no web sign-in,
 * so this page says what to search for in the app instead.
 */
for (const [path, param] of [["/authorize_interaction", "uri"], ["/authorize_follow", "acct"]] as const) {
  app.get(path, (c) => {
    const target = (c.req.query(param) ?? "").trim().replace(/^acct:/, "");
    const isHandle = /^@?[^@\s/]+@[^@\s/]+$/.test(target);
    const query = isHandle && !target.startsWith("@") ? `@${target}` : target;
    const usable = isHandle || /^https:\/\//.test(target);
    return page(
      site(c),
      { title: "Open this in your app", description: "Follow, reply and boost from a Lemmy or Mastodon app.", url: `${origin(c)}${path}`, noindex: true },
      usable
        ? html`<h1>Open this in your app</h1>
<p>${c.env.config.instance.name} is used from Lemmy and Mastodon apps, not the web. To follow, reply or boost, search for this in your app:</p>
<p><code>${query}</code></p>
<p class="meta">Signed in with an account on ${c.env.domain.domain}, the app finds it and you can go from there.</p>`
        : html`<h1>Nothing to open</h1>
<p>This link didn't say what to open. Search for the post or account in your Lemmy or Mastodon app.</p>`,
    );
  });
}

// --- profiles ---------------------------------------------------------------

async function profile(c: C, name: string): Promise<Response> {
  const db = c.env.bindings.DB;
  const [username, host] = name.split("@");
  if (!username) return notFound(site(c), here(c));
  const account = await accountByHandle(db, username, host ?? c.env.domain.domain);
  if (!account || account.banned) return notFound(site(c), here(c));
  // Someone on another server: their own page is the one to see.
  if (account.apId) return c.redirect(account.profileUrl ?? account.apId, 302);
  const before = Number(c.req.query("before")) || Number.MAX_SAFE_INTEGER;
  const { results } = await db
    .prepare(
      `SELECT id, title, content_html, community_id, created_at, client, client_app, client_device FROM posts
       WHERE account_id = ? AND deleted_at IS NULL AND visibility = 'public' AND reblog_of IS NULL
         AND root_id IS NULL AND parent_id IS NULL AND in_reply_to IS NULL AND id < ?
       ORDER BY id DESC LIMIT 20`,
    )
    .bind(account.id, before)
    .all<{ id: number; title: string | null; content_html: string; community_id: number | null; created_at: number; client: PostClient | null; client_app: string | null; client_device: string | null }>();
  const url = `${origin(c)}/@${account.username}`;
  const bio = account.bio ?? "";
  return page(
    site(c),
    {
      title: `${nameOf(account)} (${handleOf(account)})`,
      description: bio || `${nameOf(account)} on ${c.env.config.instance.name}`,
      type: "profile",
      image: account.avatarUrl ?? fallbackImage(c),
      url,
      activityPub: urls.user(account.domain, account.username),
    },
    html`<h1>${account.avatarUrl ? html`<img class="avatar" src="${account.avatarUrl}" alt="">` : ""}${nameOf(account)}</h1>
<p class="meta">${handleOf(account)} · follow from any Lemmy or Mastodon app</p>
${bio ? html`<p>${bio}</p>` : ""}
<h2>Posts</h2>
${results.length ? "" : html`<p>Nothing public yet.</p>`}
<ol class="posts">${results.map(
      (p) =>
        html`<li><a href="${p.community_id !== null ? `/post/${p.id}` : `/@${account.username}/${p.id}`}">${p.title ?? (excerpt(p.content_html, 140) || "(no text)")}</a>
<div class="meta">${time(p.created_at)}${postedOf(c, { client: p.client, clientApp: p.client_app, clientDevice: p.client_device, communityId: p.community_id, apId: null })}</div></li>`,
    )}</ol>
${results.length === 20 ? html`<p><a href="?before=${results.at(-1)!.id}">Older</a></p>` : ""}`,
  );
}

app.get("/:handle{@[^/]+}", (c) => profile(c, c.req.param("handle").slice(1)));
app.get("/u/:name", (c) => c.redirect(`/@${c.req.param("name")}`, 301));
app.get("/users/:name", (c) => c.redirect(`/@${c.req.param("name")}`, 301));

// --- posts and their comments -------------------------------------------------

/** Comments as nested lists, by their Lemmy paths. */
function renderThread(c: C, comments: ThreadComment[], authors: Map<number, Account>, media: Map<number, Media[]>): Html {
  if (!comments.length) return html``;
  const depth = (x: ThreadComment) => (x.path ?? "0").split(".").length;
  const top = Math.min(...comments.map(depth));
  const children = (x: ThreadComment) => comments.filter((y) => depth(y) === depth(x) + 1 && (y.path ?? "").startsWith(`${x.path}.`));
  const one = (x: ThreadComment): Html => {
    const author = authors.get(x.accountId);
    const body = x.deleted || !author ? html`<p class="meta">[deleted]</p>` : renderBody(x, attachmentsOf(c, x, media));
    return html`<li id="c${x.id}"><div class="meta">${author ? personLink(author) : "someone"} · ${points(x.upvotes - x.downvotes)} · ${time(x.createdAt)}${postedOf(c, x)} · <a href="/comment/${x.id}">link</a></div>${body}${
      children(x).length ? html`<ul class="thread">${children(x).map(one)}</ul>` : ""
    }</li>`;
  };
  return html`<ul class="thread">${comments.filter((x) => depth(x) === top).map(one)}</ul>`;
}

async function postPage(c: C, id: number): Promise<Response> {
  const db = c.env.bindings.DB;
  const post = await postByIdAny(db, id);
  if (!post || !isPublic(post)) return notFound(site(c), here(c));
  const viewer = null;
  const domain = c.env.domain.domain;

  // What sits under it: a Lemmy post's comments, a comment's replies, or the
  // replies threaded under a status.
  let comments: ThreadComment[];
  let root: Post | null = null;
  if (post.communityId !== null && post.rootId === null) {
    comments = await listThreadComments(db, { domain, scope: "all", postId: post.id, sort: "top", viewerId: viewer, limit: 500, offset: 0 });
  } else if (post.rootId !== null) {
    root = await postByIdAny(db, post.rootId);
    comments = await listThreadComments(db, { domain, scope: "all", postId: post.rootId, parentId: post.id, sort: "top", viewerId: viewer, limit: 500, offset: 0 });
  } else {
    const statusRoot = (await statusRootOf(db, post.id)) ?? post.id;
    if (statusRoot !== post.id) root = await postByIdAny(db, statusRoot);
    comments = await listStatusComments(db, statusRoot, { viewerId: viewer, sort: "old", ...(statusRoot !== post.id ? { parentId: post.id } : {}) });
  }
  const parent = post.parentId !== null && post.parentId !== root?.id ? await postByIdAny(db, post.parentId) : null;

  const [authors, media, community, votes] = await Promise.all([
    accountsByIds(db, [post.accountId, ...comments.map((x) => x.accountId), ...(root ? [root.accountId] : []), ...(parent ? [parent.accountId] : [])]),
    mediaForPosts(db, [post.id, ...comments.map((x) => x.id)]),
    post.communityId !== null ? communityById(db, post.communityId) : Promise.resolve(null),
    score(db, post.id),
  ]);
  const author = authors.get(post.accountId);
  if (!author || author.banned) return notFound(site(c), here(c));
  const attachments = attachmentsOf(c, post, media);
  const picture = attachments.find((a) => isImage(a.type, a.url))?.url ?? (post.linkUrl && isImage(null, post.linkUrl) ? post.linkUrl : null);
  const text = excerpt(post.contentHtml);
  const title = post.title ?? (post.rootId !== null && root?.title ? `Comment on “${root.title}”` : `${nameOf(author)}: ${excerpt(post.contentHtml, 80) || "a post"}`);
  const remote = post.apId !== null;
  const live = comments.filter((x) => !x.deleted).length;
  const context = [
    root && root.id !== post.id && isPublic(root) ? html`<p class="meta">On <a href="${postHref(root, authors.get(root.accountId))}">${root.title ?? excerpt(root.contentHtml, 80)}</a></p>` : "",
    parent && isPublic(parent) ? html`<p class="meta">In reply to <a href="${postHref(parent, authors.get(parent.accountId))}">${authors.get(parent.accountId) ? shortHandle(authors.get(parent.accountId)!) : "a post"}</a></p>` : "",
  ];
  return page(
    site(c),
    {
      title,
      description: text || undefined,
      type: "article",
      image: picture ?? author.avatarUrl ?? fallbackImage(c),
      largeImage: picture !== null,
      url: `${origin(c)}${postHref(post, author)}`,
      canonical: remote ? (post.url ?? post.apId) : null,
      activityPub: post.apId ?? urls.object(domain, String(post.id)),
      author: nameOf(author),
      published: post.createdAt,
      noindex: remote,
    },
    html`<article>
${context}
${post.title ? html`<h1>${post.title}</h1>` : ""}
<p class="meta">${authorLine(author)} · ${time(post.createdAt)}${postedOf(c, post)}${
      community ? html` · in <a href="${communityHref(community)}">!${community.name}${community.apId ? `@${community.domain}` : ""}</a>` : ""
    } · ${points(votes)}</p>
${post.linkUrl ? html`<p><a href="${post.linkUrl}">${post.linkUrl}</a></p>` : ""}
${renderBody(post, attachments)}
${remote ? html`<p class="meta">From <a href="${post.url ?? post.apId!}">${new URL(post.apId!).host}</a></p>` : ""}
</article>
<h2>${live} ${live === 1 ? "comment" : "comments"}</h2>
${renderThread(c, comments, authors, media)}`,
  );
}

app.get("/:handle{@[^/@]+}/:id{[0-9]+}", (c) => postPage(c, Number(c.req.param("id"))));
app.get("/post/:id{[0-9]+}", (c) => postPage(c, Number(c.req.param("id"))));
app.get("/comment/:id{[0-9]+}", (c) => postPage(c, Number(c.req.param("id"))));
// A browser following a post's ActivityPub ID.
app.get("/objects/:id{[0-9]+}", (c) => postPage(c, Number(c.req.param("id"))));

// --- communities ------------------------------------------------------------

app.get("/c/:name", async (c) => {
  const db = c.env.bindings.DB;
  const [name, host] = c.req.param("name").split("@");
  const community = name ? await communityByName(db, host ?? c.env.domain.domain, name) : null;
  if (!community || (host && !community.apId) || (!host && community.apId)) return notFound(site(c), here(c));
  const pageNo = Math.max(Number(c.req.query("page")) || 1, 1);
  const posts = await listThreadPosts(db, {
    domain: c.env.domain.domain,
    scope: "all",
    communityId: community.id,
    sort: "active",
    viewerId: null,
    limit: 25,
    offset: (pageNo - 1) * 25,
  });
  const authors = await accountsByIds(db, posts.map((p) => p.accountId));
  const remote = community.apId !== null;
  const description = community.description ? (remote ? htmlToText(community.description) : community.description) : "";
  return page(
    site(c),
    {
      title: `${community.title} (!${community.name}@${community.domain})`,
      description: description || `The ${community.title} community`,
      image: community.iconUrl ?? fallbackImage(c),
      url: `${origin(c)}${communityHref(community)}`,
      canonical: remote ? (community.profileUrl ?? community.apId) : null,
      activityPub: community.apId ?? urls.community(community.domain, community.name),
      noindex: remote,
    },
    html`<h1>${community.title}</h1>
<p class="meta">!${community.name}@${community.domain} · subscribe from any Lemmy app</p>
${description ? html`<p>${description}</p>` : ""}
${posts.length ? "" : html`<p>No posts yet.</p>`}
<ol class="posts" start="${(pageNo - 1) * 25 + 1}">${posts.map((p) => {
      const author = authors.get(p.accountId);
      const href = postHref(p);
      return html`<li><a href="${p.linkUrl ?? href}">${p.title ?? "(untitled)"}</a>${p.linkUrl ? html` <span class="meta">(${hostOf(p.linkUrl)})</span>` : ""}
<div class="meta">${points(p.upvotes - p.downvotes)} · ${author ? personLink(author) : ""} · ${time(p.createdAt)}${postedOf(c, p)} · <a href="${href}">${p.comments} comments</a></div></li>`;
    })}</ol>
${posts.length === 25 ? html`<p><a href="?page=${pageNo + 1}">More</a></p>` : ""}`,
  );
});

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Serves a browser's request for one of palm's pages, or returns null when
 * the path isn't one, so the caller can redirect or answer 404.
 */
export async function handleWeb(request: Request, ctx: RequestContext): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  let matched = true;
  const response = await app.fetch(request, ctx, undefined);
  if (response.status === 404 && response.headers.get("x-palm-web") === "unmatched") matched = false;
  return matched ? response : null;
}

app.notFound((c) => c.body(null, 404, { "x-palm-web": "unmatched" }));
