# palm

One fediverse identity, used from Lemmy apps and Mastodon apps, on Cloudflare
Workers.

palm is a small, multi-user ActivityPub server for a household or a group of
friends. Each person gets one account, `@name@your.domain`, that works from
Lemmy apps (Voyager, Mlem, Thunder), Mastodon apps (Mastodon, Ivory, Ice
Cubes) and the Pixelfed app. It's built on [Fedify](https://fedify.dev) and runs on Cloudflare's
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
- **The Pixelfed app**: sign-in, the photo grid on profiles, albums, the
  home and network feeds, likes ("liked by"), comments, hashtags, discover
  (trending photos, hashtags and people), direct messages, reports and
  profile edits. Stories, collections, Pixelfed's push (it goes through
  pixelfed.org) and its admin screens aren't there; the app hides stories
  when there are none.
- **PeerTube apps**: sign-in, subscriptions (channels arrive as
  communities), the subscriptions feed, watching (other servers' files and
  HLS playlists), likes, comments, Watch later (a save), history, search
  by link or handle, and uploads (see [PeerTube video](#peertube-video)).
- **Both at once**: a Lemmy comment is a Mastodon reply, an upvote is a
  favourite, a save is a bookmark. In Lemmy apps each person is a
  community (`!name@their.server`), with their statuses as posts; subscribing
  to it is separate from following them in a Mastodon app. `!following`
  gathers everyone you follow in Mastodon apps and `!local` everyone on the
  server; subscribing to either puts its statuses in Lemmy's Home.
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
| `/api/v1.1`, `/api/v1.2`, `/api/v2.1`, `/api/pixelfed`, `/api/nodeinfo/2.0.json` | Pixelfed's extras, for the Pixelfed app |
| `/api/v1/videos`, `/api/v1/users`, `/api/v1/video-channels`, `/api/v1/config`... | The PeerTube API, for PeerTube apps (its sections of `/api/v1` aren't Mastodon's) |

People sign in to both kinds of app with the domain itself (`your.domain`), so
apps show their handle as `@name@your.domain`. Nodeinfo answers as Lemmy,
which Lemmy apps check before they sign in. The Pixelfed app checks
Pixelfed's own path, `/api/nodeinfo/2.0.json`, which answers as Pixelfed.

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
     // What post pages say about where a post was written (optional):
     // "off", "service" ("on Pixelfed"), "app" (default, "via Ivory")
     // or "device" ("via Ivory for iPhone").
     postClients: "app",
   });
   ```

   ```ts
   // src/index.ts
   import { createPalm } from "@jason-s13r/palm-worker";
   import config from "../palm.config.ts";

   export default createPalm(config);
   // Mastodon streaming runs in this Durable Object.
   export { PalmStreaming } from "@jason-s13r/palm-worker";
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
   Workers Builds. The first deploy creates the D1 database, R2 bucket,
   queue and streaming Durable Object named in `wrangler.jsonc`. Then visit
   `https://your.domain/.well-known/nodeinfo` once so the tables exist.

5. **Make the first account.** The package carries palm's admin CLI as its
   `palm` bin. Give the instance repo a `palm` script and its defaults:

   ```json
   "scripts": { "palm": "palm" },
   "palm": { "domain": "your.domain", "db": "your-palm" }
   ```

   Then, logged in with `npx wrangler login` (the CLI talks to D1 through
   wrangler):

   ```sh
   pnpm palm user create you --admin
   ```

   It prints a generated password once. Sign in from Voyager or a Mastodon
   app with `your.domain` as the server.

6. **Invite people.** Each invite carries signing keys for whoever uses it:

   ```sh
   pnpm palm invite create --count 3
   ```

   Lemmy apps take the code as the sign-up answer; Mastodon apps as the
   reason. Communities are made the same way:
   `pnpm palm community create sandbox --title Sandbox`. To let people create communities from Lemmy apps, stock
   signing keys for them: `pnpm palm keys stock --count 5`. `--domain` and `--db`
   override the defaults, and without a database the CLI prints the SQL.

7. **Moving and leaving.** `pnpm palm user alias you https://old.example/users/you`
   lets your followers on another server follow you here when you move.
   `pnpm palm user import you following_accounts.csv` brings over who you
   followed: Mastodon's follows export, Lemmy's settings export, or palm's own
   export. People come in as Mastodon follows and communities as Lemmy
   subscriptions (`--via` picks one app for all of them), and the cron sends 5
   every 10 minutes to stay inside the free plan's queue limit. Lemmy apps'
   settings import sends its first 40 at once and leaves the rest to the cron.
   A moved account can't post any more. `pnpm palm user move
   you https://new.example/users/you` moves your followers there (the new
   account has to list this one as an alias first). `pnpm palm user export you`
   writes your posts and follows to a JSON file, and `pnpm palm user delete you`
   deletes the account; Lemmy apps can delete one too. Moves and deletions reach
   other servers on the next cron run.

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

## PeerTube video

Watching needs nothing extra. Hosting video depends on what the deployment
has bound, and palm works out which from its bindings:

| Tier | Bindings | What uploads get |
| --- | --- | --- |
| Free | `MEDIA` (R2) | The MP4 as uploaded, read for its length, size and frame rate (no ffmpeg). Use H.264 MP4: other servers play the file as it is. |
| Free (5,000 a month) | `MEDIA_TRANSFORMS` (Media Transformations) | A thumbnail from a frame of the video, for files under 100 MB. |
| Self-hosted | `PEERTUBE_RUNNER_TOKEN` (a secret) | HLS renditions (240p up to the upload's own, H.264) made by [`peertube-runner`](https://docs.joinpeertube.org/maintain/tools#peertube-runner) on a machine of yours, for videos from any app. A file that doesn't play everywhere (MOV, WebM, MKV, AVI, 3GP, or HEVC) is replaced by the runner's H.264 MP4, and Lemmy, Mastodon and Pixelfed apps can attach videos up to 75 MB. |
| Paid | `STREAM` (Cloudflare Stream) | Stream's HLS playlist and an H.264 MP4 of every upload; MOV, WebM and MKV are taken. |

```jsonc
// wrangler.jsonc, beside the bindings palm already has
"media": { "binding": "MEDIA_TRANSFORMS" },
"stream": { "binding": "STREAM" }
```

For a runner, set the secret (`wrangler secret put PEERTUBE_RUNNER_TOKEN`, at
least 16 characters), then on your machine:

```sh
npx @peertube/peertube-runner server &
npx @peertube/peertube-runner register --url https://your.domain --registration-token <token> --runner-name home
```

The runner calls out to palm, so it can sit behind NAT with no tunnel. palm
answers its socket.io connection just enough to say there's work, and the
runner reconnects about once a minute, which doubles as polling. Each
rendition comes back in one request, so palm asks only for the ones likely to
fit Cloudflare's 100 MB request limit. Uploads arrive in 10 MiB pieces
(PeerTube's resumable upload, into an R2 multipart upload), so the original
can be any size up to each person's quota (`PALM_VIDEO_QUOTA_MB`, 2048 by
default; R2's free tier holds 10 GB in all).

Each person's videos go in one channel, `!name_channel@your.domain`, made on
their first upload. Lemmy apps see it as a community they moderate; PeerTube
servers follow it as a channel.

The official PeerTube app (App Store, F-Droid or the APK) signs in with the
domain, as Lemmy and Mastodon apps do.

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
