import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { consume, defineConfig } from "../src/index.ts";
import { stagingConfig } from "../staging/index.ts";
import { describe, expect, it } from "vitest";
import { createAccount, giveKeys, json, MASTODON, mastodonToken, worker } from "./helpers.ts";


describe("Queue", () => {
  it("posts without delivering in the request, and runs the delivery as a queue job", async () => {
    const id = await createAccount("que", "pw");
    await giveKeys(id);
    const auth = { authorization: `Bearer ${await mastodonToken(id)}` };
    const req = json({ status: "queued" });
    const status = await (await worker.fetch(`${MASTODON}/api/v1/statuses`, { ...req, headers: { ...req.headers, ...auth } })).json<{ id: string }>();

    const batch = createMessageBatch("palm-staging", [
      { id: "m1", timestamp: new Date(), attempts: 1, body: { palm: "task", domain: "palm.test", task: { kind: "post_created", postId: Number(status.id) } } },
      { id: "m2", timestamp: new Date(), attempts: 1, body: { palm: "task", domain: "elsewhere.example", task: { kind: "post_created", postId: 1 } } },
    ]);
    const ctx = createExecutionContext();
    await consume(defineConfig(stagingConfig(env as never)), batch as never, env as never, ctx);
    const result = await getQueueResult(batch, ctx);
    // No followers, so nothing to send; an unknown domain is dropped, not retried.
    expect(result.explicitAcks.sort()).toEqual(["m1", "m2"]);
    expect(result.retryMessages).toEqual([]);
  });
});

