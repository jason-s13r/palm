# Working on palm

palm is a multi-user ActivityPub server on Cloudflare Workers, used through
existing Lemmy and Mastodon apps, with one identity per person. Federation is
built on [Fedify](https://fedify.dev). The build plan and its decisions live
outside this repo (the Palm project's `palm-decisions.md`).

## Layout

- `packages/core` (`@palm/core`): the config model (`defineConfig`), host
  routing (`resolveSurface`), the request context and the ActivityPub URL
  scheme (`urls`).
- `packages/auth`: password hashing (PBKDF2), Lemmy JWTs and tokens, on Web
  Crypto so the Worker and the CLI share them.
- `packages/db`: the D1 schema as self-applying migrations (`migrate`), and the
  queries. Append-only migrations; see `migrations.ts`.
- `packages/adapter-lemmy`, `packages/adapter-mastodon`: the client APIs as
  Hono apps over palm's data. Unknown endpoints are logged as
  `{"palm":"unknown_endpoint"}` so the next one to build shows in the logs.
  The Pixelfed app is served by the Mastodon adapter too (`pixelfed.ts`):
  Pixelfed's API is Mastodon's plus extra fields, added only for Pixelfed
  apps (`_pe=1`, `X-PIXELFED-APP` or an app named for Pixelfed), and its own
  endpoints under `/api/v1.1`, `/api/v1.2`, `/api/v2.1` and `/api/pixelfed`. The app checks
  `/api/nodeinfo/2.0.json` for "pixelfed" (the App Store build reads
  `/api/v2.1/config`'s version); standard nodeinfo says palm (see below).
- `packages/adapter-peertube`: the PeerTube client API (PeerTube's apps),
  on the bare domain beside Mastodon's: PeerTube's sections of `/api/v1`
  (videos, users, video-channels, config...) aren't Mastodon's, and its
  accounts are named where Mastodon's are numbered (`isPeerTubePath`).
  Channels are communities; a video is a post with a row in `videos`. Uploads
  (`upload.ts`) go to R2, and what happens next depends on the bindings
  (`capabilities`): the MP4 as uploaded (read by `mp4.ts`), a frame as the
  thumbnail (`MEDIA_TRANSFORMS`), Stream's renditions (`STREAM`, polled by
  the cron in `maintenance.ts`), or PeerTube's remote runners
  (`PEERTUBE_RUNNER_TOKEN`, `runner.ts`). Local videos federate as
  PeerTube's Video, built and sent as JSON (`federation/src/videos.ts`):
  Fedify would drop PeerTube's fields.
- `packages/federation`: ActivityPub on Fedify: WebFinger, Person actors,
  followers, the inboxes and nodeinfo, with Fedify's key-value store on D1
  (`D1KvStore`) and its message queue on a Cloudflare Queue
  (`CloudflareMessageQueue`). Outgoing delivery to several inboxes runs as queue
  jobs, which the same Worker consumes; a single recipient is sent at once, and
  anything the queue refuses (the daily quota is account-wide) is sent at once
  too (`send` in `shared.ts`). Received activities are handled in the request, not
  queued: a busy Lemmy community sends over a thousand an hour, and each queue
  message costs three of the free plan's 10,000 daily operations. Votes and
  deletes about things palm doesn't hold are dropped before Fedify parses them
  (`prefilter.ts`). Deliveries are signed with the
  RSA key alone: the Ed25519 Object Integrity Proof costs several times the
  rest of signing. Two federations share the database: people at
  `/users/{name}` and communities (Lemmy Groups) at `/c/{name}`, because
  Fedify allows one actor path per federation.

Remote people, communities and posts live in the same tables as local ones
(`accounts`, `communities`, `posts`), marked by their `ap_id`; local rows have
none. palm keeps a remote post only if someone here would see it, and a daily
cron prunes old remote posts nobody here touched. Other servers' votes on
other servers' posts only move a score, so they're kept by the voter's
ActivityPub ID (`remote_votes`), with no account row. Fedify's cache of remote
documents stays in memory, except actors, kept a day in D1 too: Fedify fetches
the actor behind every signing key to check it owns the key.
- `packages/web`: plain HTML pages for share links (profiles at `/@name`,
  posts at `/@name/id`, `/post/id` and `/comment/id`, communities at `/c/name`),
  with Open Graph tags, a few lines of CSS and no JavaScript. Browsers on an
  actor's or object's ID land on these; ActivityPub clients asking for these
  URLs are sent to the object. Only public and unlisted posts show. Other
  servers' people and communities redirect to their own pages, and so do their
  posts unless someone here posted or commented in the thread (or it's in a
  local community).
- `packages/cli`: admin commands run locally (`pnpm palm user create ...`,
  `pnpm palm user keys|alias|move|delete|export|import ...`, `pnpm palm community create ...`,
  `pnpm palm invite create ...`). Signing keys are generated here, not in the
  Worker, because key generation is too slow for the free CPU limit; invites
  carry a key pair for whoever signs up with them. The worker package ships
  it bundled as its `palm` bin (`dist/cli.js`), so instance repos run
  `pnpm palm ...`; `--domain` and `--db` default to their package.json's
  `"palm"` field or `PALM_DOMAIN` / `PALM_DB`.

All of the above are internal and never published.

- `apps/worker` (`@jason-s13r/palm-worker`): the one published package.
  `createPalm(config)` returns the Worker for a deployment. Built with tsup into
  a single bundle with `@palm/*` inlined.
- `apps/worker/staging`: palm's own staging instance, deployed from `main` by
  Workers Builds. Real deployments live in their own repos (see
  `wrangler.template.jsonc`).

`@fedify/fedify` stays external to the bundle, along with `temporal-polyfill`
(Fedify's own Temporal, which palm uses for ActivityPub dates); they're the
published package's dependencies.

Nodeinfo answers as palm, except to the clients listed in `PRESENTATIONS`
(`packages/core/src/presentation.ts`), matched by User-Agent or Origin. Lemmy
apps are told Lemmy, with palm's version as semver build metadata
(`0.19.9+palm.X.Y.Z`): Voyager saves an account under the handle's domain and
then only talks to that domain, after checking its nodeinfo for Lemmy >=0.19.
Pixelfed servers are pointed at the Pixelfed nodeinfo, so they send stories.
A client that needs another software's name gets a row there.

Both client APIs answer on the bare domain as well as on their own hosts, so
people sign in with the domain in their handle. Apps build the handle from the
host they signed in to (the Mastodon iOS app uses the host of the account's
`url`, and matches it to that host to find the signed-in account). The paths
don't overlap: Lemmy's API is `/api/v3`, Mastodon's `/api/v1`, `/api/v2` and
`/oauth`.

## Commands

- `pnpm install`
- `pnpm typecheck`
- `pnpm test` (the worker's tests run inside workerd through
  `@cloudflare/vitest-plugin`)
- `pnpm --filter @jason-s13r/palm-worker build`
- `pnpm dev` (wrangler dev on the staging entry)

## Rules that matter

- **Work goes straight to `main`.** No PRs or feature branches for now.
- **No session references in commits or PR text.** A Co-Authored-By line is fine.
- **Commits are conventional and scoped to a package folder**: `feat(core):`,
  `fix(worker):`, `feat(core,worker)!:`. Repo-wide changes use `repo`
  (`chore(repo):`, `ci(repo):`, `docs(repo):`). dispat computes versions from
  these, so a wrong scope means a wrong release; see `dispat.yaml` for what
  counts as breaking. A change in an internal package only reaches deployments
  when the worker is released too, so scope it as well (`fix(federation,worker):`)
  or use `^` to reach consumers (`fix(federation)^:`).
- **Never hand-edit versions** in `package.json` or `apps/worker/src/version.ts`.
  dispat writes them.
- **Nothing deployment-specific in this repo.** No real domains, IDs or names
  beyond the staging instance. Deployments pass a config to `createPalm`.
- **ActivityPub IDs are permanent** once another server has seen them. Changes
  to how they're minted are breaking and need a deliberate decision.
- **Free-tier budget**: 10 ms CPU per request, Workers KV avoided (1,000 writes
  a day), D1 capped at 500 MB per database. Keep hot paths cheap and measure.
- **Expand-then-contract migrations** (from M1): add first, drop a release
  later, so a rollback still matches the schema.
