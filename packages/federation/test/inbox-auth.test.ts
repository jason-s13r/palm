import { describe, expect, it } from "vitest";
import { hasLdSignature, trustedDelivery } from "../src/inbox-auth.ts";

const ACTOR = "https://m.example/users/a";
const ld = { type: "RsaSignature2017", creator: `${ACTOR}#main-key`, created: "2026-11-20T00:00:00Z", signatureValue: "abc" };
const activity = { id: `${ACTOR}/statuses/1/activity`, type: "Create", actor: ACTOR, object: { type: "Note", content: "hi" }, signature: ld };
const db = {} as D1Database;

const request = (headers = "(request-target) host date digest") =>
  new Request("https://palm.test/inbox", {
    method: "POST",
    headers: { signature: `keyId="${ACTOR}#main-key",headers="${headers}",signature="x"`, digest: "SHA-256=x", "content-type": "application/activity+json" },
    body: JSON.stringify(activity),
  });

describe("trustedDelivery", () => {
  it("passes on an actor's own LD-signed activity without the LD signature", async () => {
    const trusted = await trustedDelivery(db, request(), JSON.stringify(activity), activity, async () => ACTOR);
    expect(trusted).not.toBeNull();
    const body = (await trusted!.json()) as Record<string, unknown>;
    expect(body.signature).toBeUndefined();
    expect(body.actor).toBe(ACTOR);
    expect(trusted!.headers.get("digest")).toBeNull();
  });

  it("leaves Fedify to check forwarded activities and unchecked signatures", async () => {
    // Signed by someone else: a forward, which only the LD signature vouches for.
    expect(await trustedDelivery(db, request(), "", activity, async () => "https://other.example/users/b")).toBeNull();
    // A signature palm can't check.
    expect(await trustedDelivery(db, request(), "", activity, async () => null)).toBeNull();
    // The host isn't signed, so it could be a replay of another server's delivery.
    expect(await trustedDelivery(db, request("(request-target) date digest"), "", activity, async () => ACTOR)).toBeNull();
  });

  it("only steps in when there's an LD signature to skip", async () => {
    const { signature: _, ...plain } = activity;
    expect(hasLdSignature(plain)).toBe(false);
    expect(await trustedDelivery(db, request(), "", plain, async () => ACTOR)).toBeNull();
  });
});
