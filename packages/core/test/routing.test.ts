import { describe, expect, it } from "vitest";
import { defineConfig, normaliseHost, resolveSurface } from "../src/index.ts";

const config = defineConfig({
  domains: [
    { domain: "one.example", hosts: { lemmy: "lemmy.one.example", mastodon: "mastodon.one.example" } },
    { domain: "two.example", hosts: { lemmy: "lemmy.two.example" } },
    { domain: "three.example" },
  ],
  instance: { name: "Test" },
});

describe("resolveSurface", () => {
  it("maps the bare domain to federation", () => {
    expect(resolveSurface(config, "one.example")).toMatchObject({ kind: "federation", domain: { domain: "one.example" } });
    expect(resolveSurface(config, "three.example")).toMatchObject({ kind: "federation", domain: { domain: "three.example" } });
  });

  it("maps API hosts to their API and domain", () => {
    expect(resolveSurface(config, "lemmy.one.example")).toMatchObject({ kind: "lemmy", domain: { domain: "one.example" } });
    expect(resolveSurface(config, "mastodon.one.example")).toMatchObject({ kind: "mastodon" });
    expect(resolveSurface(config, "lemmy.two.example")).toMatchObject({ kind: "lemmy", domain: { domain: "two.example" } });
  });

  it("ignores case and port", () => {
    expect(resolveSurface(config, "Lemmy.One.Example:8787")).toMatchObject({ kind: "lemmy" });
  });

  it("returns null for a host it does not serve", () => {
    expect(resolveSurface(config, "mastodon.two.example")).toBeNull();
    expect(resolveSurface(config, "elsewhere.example")).toBeNull();
  });
});

describe("normaliseHost", () => {
  it("keeps bracketed IPv6 literals whole", () => {
    expect(normaliseHost("[::1]")).toBe("[::1]");
    expect(normaliseHost("[::1]:8787")).toBe("[::1]");
  });
});
