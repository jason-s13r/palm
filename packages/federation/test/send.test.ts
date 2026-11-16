import { Note } from "@fedify/fedify/vocab";
import { describe, expect, it } from "vitest";
import { send } from "../src/shared.ts";

type Call = { recipients: unknown; immediate: boolean | undefined };

/** A Fedify context whose queue refuses work, as it does once the day's operations are used up. */
function fakeContext(queueWorks: boolean) {
  const calls: Call[] = [];
  const ctx = {
    async sendActivity(_keys: unknown, recipients: unknown, _activity: unknown, options: { immediate?: boolean } = {}) {
      calls.push({ recipients, immediate: options.immediate });
      if (!options.immediate && !queueWorks) throw new Error("You have exceeded the daily write operations limit in Queues free tier");
    },
  };
  return { ctx: ctx as unknown as Parameters<typeof send>[0], calls };
}

const person = (n: number) => ({ id: new URL(`https://example.test/u/${n}`), inboxId: new URL(`https://example.test/u/${n}/inbox`), endpoints: null });
const activity = new Note({ id: new URL("https://palm.test/objects/1") }) as unknown as Parameters<typeof send>[3];

describe("send", () => {
  it("sends to one recipient straight away", async () => {
    const { ctx, calls } = fakeContext(true);
    await send(ctx, [], person(1), activity);
    expect(calls).toEqual([{ recipients: person(1), immediate: true }]);
  });

  it("queues several recipients", async () => {
    const { ctx, calls } = fakeContext(true);
    await send(ctx, [], [person(1), person(2)], activity);
    expect(calls.map((c) => c.immediate)).toEqual([undefined]);
  });

  it("sends now when the queue refuses", async () => {
    const { ctx, calls } = fakeContext(false);
    await send(ctx, [], [person(1), person(2)], activity, { preferSharedInbox: true });
    expect(calls.map((c) => c.immediate)).toEqual([undefined, true]);
  });
});
