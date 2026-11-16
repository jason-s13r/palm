import { urls, type RequestContext } from "@palm/core";
import {
  accountsByIds,
  createList,
  deleteFilter,
  deleteList,
  filtersOf,
  followedTags,
  listById,
  listMemberIds,
  listsContaining,
  listsOf,
  listTimeline,
  saveFilter,
  setListMembers,
  setTagFollow,
  updateList,
  type Account,
  type Filter,
  type List,
  type OAuthApp,
} from "@palm/db";
import { Hono, type Context } from "hono";
import { page, statusList } from "./statuses.ts";
import { account } from "./views.ts";

/** Mastodon's lists, followed hashtags and keyword filters. */

type Env = { Bindings: RequestContext; Variables: { account: Account | null; app: OAuthApp | null } };
type C = Context<Env>;

const fail = (c: C, error: string, status: 401 | 404 | 422 = 422) => c.json({ error }, status);

/** A request's parameters, from JSON, a form or the query string. */
async function params(c: C): Promise<Record<string, unknown>> {
  const type = c.req.header("content-type") ?? "";
  const body = type.includes("json")
    ? await c.req.json<Record<string, unknown>>().catch(() => ({}))
    : await c.req.parseBody({ all: true, dot: true }).catch(() => ({}));
  return { ...c.req.query(), ...(body as Record<string, unknown>) };
}

const listView = (l: List) => ({ id: String(l.id), title: l.title, replies_policy: l.repliesPolicy, exclusive: l.exclusive });

export const curationRoutes = new Hono<Env>();

// --- lists -----------------------------------------------------------------------

curationRoutes.get("/api/v1/lists", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  return c.json((await listsOf(c.env.bindings.DB, me.id)).map(listView));
});

curationRoutes.post("/api/v1/lists", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const p = await params(c);
  const title = String(p.title ?? "").trim();
  if (!title) return fail(c, "Validation failed: Title can't be blank");
  const list = await createList(c.env.bindings.DB, me.id, { title, repliesPolicy: String(p.replies_policy ?? "list"), exclusive: p.exclusive === true || p.exclusive === "true" });
  return c.json(listView(list));
});

const ownList = async (c: C, me: Account) => listById(c.env.bindings.DB, me.id, Number(c.req.param("id")));

curationRoutes.get("/api/v1/lists/:id{[0-9]+}", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const list = await ownList(c, me);
  return list ? c.json(listView(list)) : fail(c, "Record not found", 404);
});

curationRoutes.put("/api/v1/lists/:id{[0-9]+}", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const list = await ownList(c, me);
  if (!list) return fail(c, "Record not found", 404);
  const p = await params(c);
  await updateList(c.env.bindings.DB, list.id, {
    title: typeof p.title === "string" && p.title.trim() ? p.title.trim() : undefined,
    repliesPolicy: typeof p.replies_policy === "string" ? p.replies_policy : undefined,
    exclusive: p.exclusive === undefined ? undefined : p.exclusive === true || p.exclusive === "true",
  });
  return c.json(listView((await ownList(c, me))!));
});

curationRoutes.delete("/api/v1/lists/:id{[0-9]+}", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const list = await ownList(c, me);
  if (list) await deleteList(c.env.bindings.DB, list.id);
  return c.json({});
});

curationRoutes.get("/api/v1/lists/:id{[0-9]+}/accounts", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const list = await ownList(c, me);
  if (!list) return fail(c, "Record not found", 404);
  const people = await accountsByIds(c.env.bindings.DB, await listMemberIds(c.env.bindings.DB, list.id));
  return c.json([...people.values()].map((a) => account(c.env, a)));
});

for (const [method, add] of [["post", true], ["delete", false]] as const) {
  curationRoutes[method]("/api/v1/lists/:id{[0-9]+}/accounts", async (c) => {
    const me = c.get("account");
    if (!me) return fail(c, "The access token is invalid", 401);
    const list = await ownList(c, me);
    if (!list) return fail(c, "Record not found", 404);
    const p = await params(c);
    const raw = p.account_ids ?? p["account_ids[]"] ?? [];
    const ids = (Array.isArray(raw) ? raw : [raw]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    await setListMembers(c.env.bindings.DB, list.id, ids, add);
    return c.json({});
  });
}

curationRoutes.get("/api/v1/accounts/:id{[0-9]+}/lists", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  return c.json((await listsContaining(c.env.bindings.DB, me.id, Number(c.req.param("id")))).map(listView));
});

curationRoutes.get("/api/v1/timelines/list/:id{[0-9]+}", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const list = await ownList(c, me);
  if (!list) return fail(c, "Record not found", 404);
  return statusList(c, await listTimeline(c.env.bindings.DB, me.id, list.id, page(c)));
});

// --- followed hashtags ---------------------------------------------------------------

const tagView = (c: C, tag: string, following: boolean) => ({ name: tag, url: urls.tag(c.env.domain.domain, tag), history: [], following });

curationRoutes.get("/api/v1/followed_tags", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  return c.json((await followedTags(c.env.bindings.DB, me.id)).map((t) => tagView(c, t, true)));
});

curationRoutes.get("/api/v1/tags/:tag", async (c) => {
  const tag = c.req.param("tag").toLowerCase();
  const me = c.get("account");
  const following = me ? (await followedTags(c.env.bindings.DB, me.id)).includes(tag) : false;
  return c.json(tagView(c, tag, following));
});

for (const [action, follow] of [["follow", true], ["unfollow", false]] as const) {
  curationRoutes.post(`/api/v1/tags/:tag/${action}`, async (c) => {
    const me = c.get("account");
    if (!me) return fail(c, "The access token is invalid", 401);
    const tag = c.req.param("tag").toLowerCase();
    await setTagFollow(c.env.bindings.DB, me.id, tag, follow);
    return c.json(tagView(c, tag, follow));
  });
}

// --- keyword filters (v2) -------------------------------------------------------------

export const filterView = (f: Filter) => ({
  id: String(f.id),
  title: f.title,
  context: f.context,
  expires_at: f.expiresAt ? new Date(f.expiresAt * 1000).toISOString() : null,
  filter_action: f.action,
  keywords: f.keywords.map((k) => ({ id: String(k.id), keyword: k.keyword, whole_word: k.wholeWord })),
  statuses: [],
});

const CONTEXTS = ["home", "notifications", "public", "thread", "account"];

/** Keyword changes from Mastodon's keywords_attributes[] (form or JSON). */
function keywordChanges(p: Record<string, unknown>) {
  const raw = p.keywords_attributes ?? p["keywords_attributes[]"] ?? [];
  const list = (Array.isArray(raw) ? raw : typeof raw === "object" && raw ? Object.values(raw) : []) as Record<string, unknown>[];
  const add: { keyword: string; wholeWord: boolean }[] = [];
  const removeIds: number[] = [];
  for (const k of list) {
    const destroy = k._destroy === true || k._destroy === "true" || k._destroy === "1";
    if (k.id && destroy) removeIds.push(Number(k.id));
    else if (k.id) {
      removeIds.push(Number(k.id));
      if (k.keyword) add.push({ keyword: String(k.keyword), wholeWord: k.whole_word !== false && k.whole_word !== "false" });
    } else if (k.keyword) add.push({ keyword: String(k.keyword), wholeWord: k.whole_word !== false && k.whole_word !== "false" });
  }
  return { add, removeIds };
}

curationRoutes.get("/api/v2/filters", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  return c.json((await filtersOf(c.env.bindings.DB, me.id, true)).map(filterView));
});

curationRoutes.get("/api/v2/filters/:id{[0-9]+}", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  const found = (await filtersOf(c.env.bindings.DB, me.id, true)).find((f) => f.id === Number(c.req.param("id")));
  return found ? c.json(filterView(found)) : fail(c, "Record not found", 404);
});

async function upsertFilter(c: C, me: Account, id?: number) {
  const p = await params(c);
  const existing = id !== undefined ? (await filtersOf(c.env.bindings.DB, me.id, true)).find((f) => f.id === id) : undefined;
  if (id !== undefined && !existing) return fail(c, "Record not found", 404);
  const rawContext = p.context ?? p["context[]"] ?? existing?.context ?? [];
  const context = (Array.isArray(rawContext) ? rawContext : [rawContext]).map(String).filter((x) => CONTEXTS.includes(x));
  const title = String(p.title ?? existing?.title ?? "").trim();
  if (!title || !context.length) return fail(c, "Validation failed: Title and context are required");
  const expiresIn = Number(p.expires_in);
  const saved = await saveFilter(
    c.env.bindings.DB,
    me.id,
    {
      ...(id !== undefined ? { id } : {}),
      title,
      context,
      action: p.filter_action === "hide" ? "hide" : p.filter_action === "warn" ? "warn" : (existing?.action ?? "warn"),
      expiresAt: expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : p.expires_in === "" ? null : (existing?.expiresAt ?? null),
    },
    keywordChanges(p),
  );
  const filter = (await filtersOf(c.env.bindings.DB, me.id, true)).find((f) => f.id === saved)!;
  return c.json(filterView(filter));
}

curationRoutes.post("/api/v2/filters", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  return upsertFilter(c, me);
});

curationRoutes.put("/api/v2/filters/:id{[0-9]+}", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  return upsertFilter(c, me, Number(c.req.param("id")));
});

curationRoutes.delete("/api/v2/filters/:id{[0-9]+}", async (c) => {
  const me = c.get("account");
  if (!me) return fail(c, "The access token is invalid", 401);
  await deleteFilter(c.env.bindings.DB, me.id, Number(c.req.param("id")));
  return c.json({});
});

