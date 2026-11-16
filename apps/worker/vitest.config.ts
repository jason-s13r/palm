import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside the Workers runtime, against the staging entry point and
// its wrangler.jsonc, with the staging hosts overridden to test values.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          STAGING_DOMAIN: "palm.test",
          STAGING_LEMMY_HOST: "lemmy.palm.test",
          STAGING_MASTODON_HOST: "mastodon.palm.test",
        },
      },
    }),
  ],
});
