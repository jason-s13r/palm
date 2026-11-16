// The entry point of palm's own staging instance, deployed from `main` by
// Workers Builds. Its hosts come from wrangler vars, so the staging domain is
// set in wrangler.jsonc rather than in code.
import { createPalm, type PalmEnv } from "../src/index.ts";

interface StagingEnv extends PalmEnv {
  STAGING_DOMAIN: string;
  STAGING_LEMMY_HOST?: string;
  STAGING_MASTODON_HOST?: string;
  /** Where browsers on the bare domain go; unset means a plain 404. */
  STAGING_BROWSER_REDIRECT?: string;
}

export default createPalm<StagingEnv>((env) => ({
  domains: [
    {
      domain: env.STAGING_DOMAIN,
      hosts: {
        ...(env.STAGING_LEMMY_HOST ? { lemmy: env.STAGING_LEMMY_HOST } : {}),
        ...(env.STAGING_MASTODON_HOST ? { mastodon: env.STAGING_MASTODON_HOST } : {}),
      },
    },
  ],
  instance: { name: "palm staging", description: "palm's test instance. Accounts here are wiped without notice." },
  ...(env.STAGING_BROWSER_REDIRECT ? { browserRedirect: env.STAGING_BROWSER_REDIRECT } : {}),
}));
