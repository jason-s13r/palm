import { describe, expect, it } from "vitest";
import { createAccount, giveKeys, json, MASTODON, mastodonToken, worker } from "./helpers.ts";

const DOMAIN = "https://palm.test";
const AP = { headers: { accept: "application/activity+json" } };

type Status = {
  id: string;
  uri: string;
  content: string;
  visibility: string;
  in_reply_to_id: string | null;
  account: { id: string; statuses_count: number };
};

async function signedIn(username: string) {
  const id = await createAccount(username, "pw");
  await giveKeys(id);
  const token = await mastodonToken(id);
  const auth = { authorization: `Bearer ${token}` };
  const post = async (body: Record<string, unknown>) => {
    const req = json(body);
    return worker.fetch(`${MASTODON}/api/v1/statuses`, { ...req, headers: { ...req.headers, ...auth } });
  };
  const get = (path: string) => worker.fetch(`${MASTODON}${path}`, { headers: auth });
  return { id, auth, post, get };
}

describe("Posting", () => {
  it("posts a status and shows it on the profile and timelines", async () => {
    const me = await signedIn("kit");
    const res = await me.post({ status: "Hello <world>\n\nsee https://example.com/a." });
    expect(res.status).toBe(200);
    const status = await res.json<Status>();
    expect(status.content).toBe(
      '<p>Hello &lt;world&gt;</p><p>see <a href="https://example.com/a" rel="nofollow noopener" target="_blank">example.com/a</a>.</p>',
    );
    expect(status.uri).toBe(`https://palm.test/post/${status.id}`);
    // The Mastodon iOS app matches the account's url host to the server it signed in to.
    expect(status.account).toMatchObject({ url: "https://mastodon.palm.test/@kit", uri: "https://palm.test/users/kit" });
    expect((status as unknown as { url: string }).url).toBe(`https://mastodon.palm.test/@kit/${status.id}`);
    const page = await worker.fetch(`${MASTODON}/@kit/${status.id}`, { redirect: "manual" });
    expect(page.headers.get("location")).toBe(status.uri);
    expect(status.visibility).toBe("public");
    expect(status.account.statuses_count).toBe(1);

    const mine = await (await me.get(`/api/v1/accounts/${me.id}/statuses`)).json<Status[]>();
    expect(mine.map((s) => s.id)).toEqual([status.id]);
    const home = await (await me.get("/api/v1/timelines/home")).json<Status[]>();
    expect(home[0]?.id).toBe(status.id);
    const pub = await (await worker.fetch(`${MASTODON}/api/v1/timelines/public?local=true`)).json<Status[]>();
    expect(pub.some((s) => s.id === status.id)).toBe(true);
  });

  it("serves the post as a Note and lists it in the outbox", async () => {
    const me = await signedIn("lux");
    const status = await (await me.post({ status: "federate me", spoiler_text: "cw" })).json<Status>();

    const note = await (await worker.fetch(status.uri, AP)).json<Record<string, unknown>>();
    expect(note).toMatchObject({
      type: "Note",
      id: status.uri,
      attributedTo: "https://palm.test/users/lux",
      content: "<p>federate me</p>",
      summary: "cw",
      sensitive: true,
      to: "https://www.w3.org/ns/activitystreams#Public",
      cc: "https://palm.test/users/lux/followers",
    });

    const outbox = await (await worker.fetch(`${DOMAIN}/users/lux/outbox`, AP)).json<{ totalItems: number; first: string }>();
    expect(outbox.totalItems).toBe(1);
    const page = await (await worker.fetch(outbox.first, AP)).json<{ orderedItems: { type: string; object: { id: string } }[] }>();
    expect(page.orderedItems[0]).toMatchObject({ type: "Create", object: { id: status.uri } });
  });

  it("keeps followers-only posts out of public views", async () => {
    const me = await signedIn("moe");
    const status = await (await me.post({ status: "just friends", visibility: "private" })).json<Status>();
    expect((await worker.fetch(status.uri, AP)).status).toBe(404);
    expect((await worker.fetch(`${MASTODON}/api/v1/statuses/${status.id}`)).status).toBe(404);
    expect((await me.get(`/api/v1/statuses/${status.id}`)).status).toBe(200);
    const theirs = await (await worker.fetch(`${MASTODON}/api/v1/accounts/${me.id}/statuses`)).json<Status[]>();
    expect(theirs).toEqual([]);
  });

  it("threads replies through context", async () => {
    const me = await signedIn("ned");
    const parent = await (await me.post({ status: "first" })).json<Status>();
    const reply = await (await me.post({ status: "second", in_reply_to_id: parent.id })).json<Status>();
    expect(reply.in_reply_to_id).toBe(parent.id);
    const context = await (await me.get(`/api/v1/statuses/${parent.id}/context`)).json<{ descendants: Status[] }>();
    expect(context.descendants.map((s) => s.id)).toEqual([reply.id]);
    const up = await (await me.get(`/api/v1/statuses/${reply.id}/context`)).json<{ ancestors: Status[] }>();
    expect(up.ancestors.map((s) => s.id)).toEqual([parent.id]);
  });

  it("deletes a post, and only its author can", async () => {
    const me = await signedIn("oz");
    const other = await signedIn("pip");
    const status = await (await me.post({ status: "oops" })).json<Status>();
    const del = (auth: Record<string, string>) =>
      worker.fetch(`${MASTODON}/api/v1/statuses/${status.id}`, { method: "DELETE", headers: auth });
    expect((await del(other.auth)).status).toBe(404);
    const res = await del(me.auth);
    expect(res.status).toBe(200);
    expect((await res.json<{ text: string }>()).text).toBe("oops");
    expect((await me.get(`/api/v1/statuses/${status.id}`)).status).toBe(404);
    expect((await worker.fetch(status.uri, AP)).status).toBe(404);
  });

  it("refuses what it can't do yet", async () => {
    const me = await signedIn("qi");
    expect((await me.post({ status: "" })).status).toBe(422);
    expect((await me.post({ status: "pic", media_ids: ["1"] })).status).toBe(422);
    expect((await me.post({ status: "hi @x", visibility: "direct" })).status).toBe(422);
    expect((await worker.fetch(`${MASTODON}/api/v1/statuses`, json({ status: "anon" }))).status).toBe(401);
  });
});
