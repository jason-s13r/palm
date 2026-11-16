# palm

One fediverse identity, used from Lemmy apps and Mastodon apps, on Cloudflare
Workers.

palm is a small, multi-user ActivityPub server for a household or a group of
friends. Each person gets one account, `@name@your.domain`, that works from
Lemmy apps (Voyager, Mlem, Thunder) and Mastodon apps (Mastodon, Ivory, Ice
Cubes). It's built on [Fedify](https://fedify.dev) and runs on Cloudflare's
free plan.

The name is MLAP backwards: Mastodon, Lemmy, ActivityPub.

> **Status: early, in daily use on a staging instance.** Expect rough edges
> and the occasional breaking change before 1.0.

## What works

- **Lemmy apps**: local and remote communities, posts, threaded comments,
  votes, saves, the inbox (replies and mentions), search and
  `resolve_object`, image uploads through `/pictrs`.
- **Mastodon apps**: sign-in, home, local, public and hashtag timelines,
  posting with images and video, replies, edits, direct messages, boosts,
  favourites, bookmarks, follows, profiles and grouped notifications.
- **Both at once**: a Lemmy comment is a Mastodon reply, an upvote is a
  favourite, a save is a bookmark. Lemmy apps see the people you follow as
  person communities (`!name@their.server`), with their statuses as posts.
- **Federation** with Lemmy, Mastodon and other ActivityPub servers: people
  and communities follow and are followed, remote threads and profiles fill
  in their history when opened.
- **Admin**: sign-up by invite, bans, removing posts and comments, blocking
  instances, and a daily prune of old remote posts nobody here touched.

## How it's put together

One Worker serves the domain and routes on the path:

| Path | Serves |
| --- | --- |
| `/.well-known/webfinger`, `/users`, `/c`, `/objects`, `/inbox`, nodeinfo | Federation |
| `/api/v3`, `/pictrs` | The Lemmy API, for Lemmy apps |
| `/api/v1`, `/api/v2`, `/oauth` | The Mastodon API, for Mastodon apps |

People sign in to both kinds of app with the domain itself (`your.domain`), so
apps show their handle as `@name@your.domain`. Nodeinfo answers as Lemmy,
which Lemmy apps check before they sign in.

Data lives in one D1 database, uploads in an R2 bucket, and outgoing
deliveries go through a Cloudflare Queue that the same Worker consumes.

## Running your own

palm is a library; an instance is a small repo of its own that passes a config
to `createPalm`. You'll need a Cloudflare account with your domain on it,
Node 22+ and pnpm.

1. **Pick the domain.** Handles and every ActivityPub ID are minted under it,
   and other servers remember them, so it can't change once anything has
   federated.

2. **Make the instance repo.** Three files:

   ```ts
   // palm.config.ts
   import { defineConfig } from "@jason-s13r/palm-worker";

   export default defineConfig({
     domains: [{ domain: "your.domain" }],
     instance: { name: "Our place", contact: "you@your.domain" },
     registration: "invite",
     // Where browsers landing on pages palm doesn't serve are sent (optional).
     browserRedirect: "https://your.website",
   });
   ```

   ```ts
   // src/index.ts
   import { createPalm } from "@jason-s13r/palm-worker";
   import config from "../palm.config.ts";

   export default createPalm(config);
   ```

   And `wrangler.jsonc`, copied from
   [`apps/worker/wrangler.template.jsonc`](apps/worker/wrangler.template.jsonc)
   with every `<...>` filled in.

3. **Get the package.** Releases publish `@jason-s13r/palm-worker` to GitHub
   Packages, which needs a GitHub token to install even though it's public.
   Without one, build it from a clone of this repo and vendor the tarball:

   ```sh
   pnpm install
   pnpm --filter @jason-s13r/palm-worker build
   cd apps/worker && pnpm pack   # → jason-s13r-palm-worker-X.Y.Z.tgz
   ```

   then in the instance repo, `"@jason-s13r/palm-worker": "file:./vendor/palm-worker.tgz"`.

4. **Deploy**, with `npx wrangler deploy` or by connecting the repo to
   Workers Builds. The first deploy creates the D1 database, R2 bucket and
   queue named in `wrangler.jsonc`. Then visit
   `https://your.domain/.well-known/nodeinfo` once so the tables exist.

5. **Make the first account** from a clone of this repo (the CLI talks to D1
   through wrangler, so be logged in with `npx wrangler login`):

   ```sh
   pnpm palm user create you --domain your.domain --db your-palm --admin
   ```

   It prints a generated password once. Sign in from Voyager or a Mastodon
   app with `your.domain` as the server.

6. **Invite people.** Each invite carries signing keys for whoever uses it:

   ```sh
   pnpm palm invite create --domain your.domain --db your-palm --count 3
   ```

   Lemmy apps take the code as the sign-up answer; Mastodon apps as the
   reason. Communities are made the same way:
   `pnpm palm community create sandbox --domain your.domain --db your-palm`.

If the domain already serves a website, palm needs the whole host: put the
site on `www.` or another domain, and set `browserRedirect` to it.

## Living on the free plan

Cloudflare's free plan allows 10 ms of CPU per request, 10,000 queue
operations a day and 100,000 D1 row writes a day. palm is built around those:

- Signing keys are made by the CLI, not the Worker.
- Received activities are handled in the request. Votes and deletes about
  things palm doesn't hold are dropped unparsed, and votes on remote posts
  are checked and counted without Fedify.
- Only outgoing deliveries use the queue.
- Remote posts are kept only if someone here would see them, and pruned after
  30 days untouched.

Subscribing to many busy Lemmy communities is what pushes against the limits
first. The Workers dashboard shows CPU per request, queue use and D1 writes.

## Releases

Fully automatic from conventional commits, using
[dispat](https://github.com/yohimik/dispat). Running the Release workflow
computes the versions, writes the changelogs, tags `worker@X.Y.Z` and publishes
`@jason-s13r/palm-worker` to GitHub Packages. The worker's version is palm's
version.

A release deploys nothing; each instance pins a version and deploys it.
`main` deploys to palm's staging instance.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test      # the worker's tests run inside workerd
pnpm dev       # wrangler dev on the staging entry
```

See [AGENTS.md](AGENTS.md) for the layout, commit conventions and the rules
that matter.

## Licence

[Unlicense](LICENSE): public domain.
