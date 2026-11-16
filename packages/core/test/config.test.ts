import { describe, expect, it } from "vitest";
import { ConfigError, defineConfig, type PalmConfig } from "../src/index.ts";

const base: PalmConfig = {
  domains: [{ domain: "example.social", hosts: { lemmy: "lemmy.example.social", mastodon: "mastodon.example.social" } }],
  instance: { name: "Example" },
};

describe("defineConfig", () => {
  it("returns a valid config unchanged", () => {
    expect(defineConfig(base)).toBe(base);
  });

  it("needs at least one domain", () => {
    expect(() => defineConfig({ ...base, domains: [] })).toThrow(ConfigError);
  });

  it("needs an instance name", () => {
    expect(() => defineConfig({ ...base, instance: { name: " " } })).toThrow(/instance.name/);
  });

  it("rejects hostnames that are not lowercase", () => {
    expect(() =>
      defineConfig({ ...base, domains: [{ domain: "Example.social", hosts: {} }] }),
    ).toThrow(/not a valid lowercase hostname/);
  });

  it("rejects a single-label hostname", () => {
    expect(() => defineConfig({ ...base, domains: [{ domain: "localhost", hosts: {} }] })).toThrow(ConfigError);
  });

  it("rejects a host used twice", () => {
    expect(() =>
      defineConfig({
        ...base,
        domains: [{ domain: "example.social", hosts: { lemmy: "api.example.social", mastodon: "api.example.social" } }],
      }),
    ).toThrow(/used twice/);
  });

  it("rejects an API host that is another domain", () => {
    expect(() =>
      defineConfig({
        ...base,
        domains: [
          { domain: "one.example", hosts: { lemmy: "two.example" } },
          { domain: "two.example", hosts: {} },
        ],
      }),
    ).toThrow(/used twice/);
  });

  it("only accepts an https browser redirect", () => {
    expect(() => defineConfig({ ...base, browserRedirect: "http://example.com" })).toThrow(/https/);
    expect(() => defineConfig({ ...base, browserRedirect: "not a url" })).toThrow(/not a URL/);
    expect(defineConfig({ ...base, browserRedirect: "https://example.com" }).browserRedirect).toBe(
      "https://example.com",
    );
  });
});
