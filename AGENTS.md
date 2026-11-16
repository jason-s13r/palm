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
- `packages/cli`: admin commands run locally (`pnpm palm user create ...`).

All of these are internal and never published.
- `apps/worker` (`@jason-s13r/palm-worker`): the one published package.
  `createPalm(config)` returns the Worker for a deployment. Built with tsup into
  a single bundle with `@palm/*` inlined.
- `apps/worker/staging`: palm's own staging instance, deployed from `main` by
  Workers Builds. Real deployments live in their own repos (see
  `wrangler.template.jsonc`).

Federation (Fedify, WebFinger, actors, the inbox) arrives next.

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
  counts as breaking.
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
