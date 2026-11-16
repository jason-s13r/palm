# palm

One fediverse identity, used from Lemmy apps and Mastodon apps, on Cloudflare
Workers.

palm is a small, multi-user ActivityPub server for a household or a group of
friends. Each person gets one account, `@name@your.domain`, that works from
Lemmy apps (Voyager, Mlem, Thunder) and Mastodon apps (Ivory, Ice Cubes). It's
built on [Fedify](https://fedify.dev) and aims to run on Cloudflare's free
tier.

The name is MLAP backwards: Mastodon, Lemmy, ActivityPub.

> **Status: early.** This is the M0 skeleton: config, host routing, the
> release pipeline and a staging Worker. Nothing federates yet.

## How it's put together

One Worker serves every host and routes on the `Host` header:

| Host | Serves |
| --- | --- |
| `your.domain` | Federation: WebFinger, nodeinfo, actors, the inbox |
| `lemmy.your.domain` | The Lemmy API v3, for Lemmy apps |
| `mastodon.your.domain` | The Mastodon API, for Mastodon apps |

The code is generic. A deployment lives in its own repo and passes its config
to `createPalm`:

```ts
// palm.config.ts
import { defineConfig } from "@jason-s13r/palm-worker";

export default defineConfig({
  domains: [{ domain: "your.domain", hosts: { lemmy: "lemmy.your.domain", mastodon: "mastodon.your.domain" } }],
  instance: { name: "Our place" },
  browserRedirect: "https://your.website",
});
```

```ts
// src/index.ts
import { createPalm } from "@jason-s13r/palm-worker";
import config from "../palm.config.ts";

export default createPalm(config);
```

Start a deployment's `wrangler.jsonc` from
[`apps/worker/wrangler.template.jsonc`](apps/worker/wrangler.template.jsonc).

## Releases

Fully automatic from conventional commits, using
[dispat](https://github.com/yohimik/dispat). Running the Release workflow
computes the versions, writes the changelogs, tags `worker@X.Y.Z` and publishes
`@jason-s13r/palm-worker` to GitHub Packages. The worker's version is palm's
version.

A release deploys nothing to production; each deployment pins a version and
deploys it. `main` deploys to palm's staging instance.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm dev
```

See [AGENTS.md](AGENTS.md) for the commit conventions and the rules that
matter.
