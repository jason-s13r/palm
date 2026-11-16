import { describe, expect, it } from "vitest";
import { hashPassword, needsRehash, randomToken, sha256Hex, signJwt, verifyJwt, verifyPassword } from "../src/index.ts";

describe("passwords", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple", 1_000);
    expect(hash).toMatch(/^pbkdf2-sha256\$1000\$/);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("Correct horse battery staple", hash)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same", 1_000)).not.toBe(await hashPassword("same", 1_000));
  });

  it("never matches a malformed hash", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$10$abc$def")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2-sha256$zero$abc$def")).toBe(false);
  });

  it("flags hashes made with another iteration count", async () => {
    expect(needsRehash(await hashPassword("x", 1_000))).toBe(true);
    expect(needsRehash(await hashPassword("x"))).toBe(false);
  });
});

describe("JWTs", () => {
  const claims = { sub: "1", sid: "abc", iss: "palm.test", iat: 1_700_000_000 };

  it("round-trips claims", async () => {
    const token = await signJwt(claims, "secret");
    expect(await verifyJwt(token, "secret")).toEqual(claims);
  });

  it("rejects a token signed with another secret", async () => {
    expect(await verifyJwt(await signJwt(claims, "secret"), "other")).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const [h, , s] = (await signJwt(claims, "secret")).split(".");
    const forged = btoa(JSON.stringify({ ...claims, sub: "2" })).replace(/=+$/, "");
    expect(await verifyJwt(`${h}.${forged}.${s}`, "secret")).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verifyJwt("not.a.jwt", "secret")).toBeNull();
    expect(await verifyJwt("", "secret")).toBeNull();
  });
});

describe("tokens", () => {
  it("are random and URL-safe", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });

  it("hash to hex", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
