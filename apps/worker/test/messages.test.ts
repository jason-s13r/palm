import { describe, expect, it } from "vitest";
import { createAccount, json, MASTODON, mastodonToken, worker } from "./helpers.ts";

const SITE = "https://palm.test";

async function both(username: string) {
  const id = await createAccount(username, "pw-pw-pw");
  const auth = { authorization: `Bearer ${await mastodonToken(id)}` };
  const masto = (method: string, path: string, body?: unknown) =>
    worker.fetch(`${MASTODON}${path}`, {
      method,
      headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const { jwt } = await (await worker.fetch(`${SITE}/api/v3/user/login`, json({ username_or_email: username, password: "pw-pw-pw" }))).json<{ jwt: string }>();
  const lemmy = (method: string, path: string, body?: unknown) =>
    worker.fetch(`${SITE}/api/v3${path}`, {
      method,
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { id, masto, lemmy };
}

async function until<T>(check: () => Promise<T | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

type PM = { private_message: { id: number; content: string; read: boolean; creator_id: number; recipient_id: number } };

describe("Private messages", () => {
  it("are one conversation in Lemmy and Mastodon apps", async () => {
    const ann = await both("pm_ann");
    const ben = await both("pm_ben");
    const sent = await (await ann.lemmy("POST", "/private_message", { content: "hi *ben*", recipient_id: ben.id })).json<{ private_message_view: PM }>();
    expect(sent.private_message_view.private_message).toMatchObject({ creator_id: ann.id, recipient_id: ben.id, read: true });

    // Ben sees it unread in Voyager once its notification lands.
    await until(async () => (await (await ben.lemmy("GET", "/user/unread_count")).json<{ private_messages: number }>()).private_messages === 1);
    const list = await (await ben.lemmy("GET", "/private_message/list?unread_only=true")).json<{ private_messages: PM[] }>();
    expect(list.private_messages.map((m) => m.private_message.content)).toEqual(["hi *ben*"]);

    // And as a conversation in Mastodon apps; reading it there reads it in Voyager.
    const convos = await (await ben.masto("GET", "/api/v1/conversations")).json<{ id: string; unread: boolean; accounts: { id: string }[] }[]>();
    expect(convos).toHaveLength(1);
    expect(convos[0]).toMatchObject({ unread: true, accounts: [{ id: String(ann.id) }] });
    await ben.masto("POST", `/api/v1/conversations/${convos[0]!.id}/read`);
    expect((await (await ben.lemmy("GET", "/user/unread_count")).json<{ private_messages: number }>()).private_messages).toBe(0);

    // A Mastodon direct message answers it, and shows in Ann's Voyager.
    await ben.masto("POST", "/api/v1/statuses", { status: "@pm_ann hello back", visibility: "direct" });
    const annList = await until(async () => {
      const got = await (await ann.lemmy("GET", "/private_message/list")).json<{ private_messages: PM[] }>();
      return got.private_messages.length === 2 ? got : false;
    });
    expect(annList.private_messages[0]!.private_message).toMatchObject({ creator_id: ben.id, recipient_id: ann.id });
  });
});
