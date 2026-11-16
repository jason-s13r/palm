import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside the Workers runtime, against the staging entry point and
// its wrangler.jsonc, with the staging hosts overridden to test values.
export default defineConfig({
  // The first request in each test file loads Fedify into a fresh isolate,
  // which can take a few seconds on a cold CI runner.
  test: { testTimeout: 20_000 },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          STAGING_DOMAIN: "palm.test",
          STAGING_LEMMY_HOST: "lemmy.palm.test",
          STAGING_MASTODON_HOST: "mastodon.palm.test",
          STAGING_BROWSER_REDIRECT: "https://site.example",
        },
      },
    }),
  ],
});
