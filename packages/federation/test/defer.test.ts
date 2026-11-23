import { describe, expect, it } from "vitest";
import { receivedOf, shouldDefer } from "../src/defer.ts";

describe("Deferred deliveries", () => {
  const create = (object: Record<string, unknown>) => ({ type: "Create", actor: "https://x.test/u/a", object });

  it("queues new posts, and keeps replies and everything else in the request", () => {
    expect(shouldDefer(receivedOf(create({ type: "Page", name: "A post" })))).toBe(true);
    expect(shouldDefer(receivedOf(create({ type: "Note", content: "A status" })))).toBe(true);
    // A community's Announce of a post.
    expect(shouldDefer(receivedOf({ type: "Announce", object: create({ type: "Page" }) }))).toBe(true);
    expect(shouldDefer(receivedOf(create({ type: "Note", inReplyTo: "https://x.test/post/1" })))).toBe(false);
    expect(shouldDefer(receivedOf({ type: "Follow", object: "https://palm.test/users/a" }))).toBe(false);
    expect(shouldDefer(receivedOf({ type: "Announce", object: { type: "Like", object: "https://x.test/post/1" } }))).toBe(false);
  });
});
