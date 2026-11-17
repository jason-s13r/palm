# Changelog

## worker@0.4.0 (2026-11-17)

### Features

- account moves, deletion and export

- sign a retry when a server refuses an unsigned fetch

- streaming over a Durable Object
  Deployments export PalmStreaming and bind it as STREAMING.

- push notifications over Web Push

- polls, edit history, scheduled posts and quotes

- lists, followed hashtags, filters, read and hidden posts, cross-posts

- reports, community moderation and the mod log

- locked accounts, pinned posts and featured hashtags

- private messages shared by Lemmy and Mastodon apps

- link previews and a cached media proxy

- blocks and mutes for people, communities and servers

### Fixes

- resolve local lookups from the database; add favicon, robots.txt and interaction_policy

### Dependencies

- core: 1.0.0 -> 1.1.0
- db: 0.1.0 -> 0.2.0
- adapter-lemmy: 0.1.0 -> 0.2.0
- adapter-mastodon: 0.1.0 -> 0.2.0
- federation: 0.1.1 -> 0.2.0
- cli: 0.2.0 -> 0.3.0


## worker@0.3.1 (2026-11-16)

### Fixes

- release with federation's delivery fallback
  federation 0.1.1 sends at once when the queue refuses, but dispat
  releases a consumer only when a commit reaches it, so the worker (the
  package deployments install) didn't take it. This releases the worker
  with it. dispat.yaml now lists web and cli among the worker's
  dependencies and says how to reach the worker from a package's commit.


## worker@0.3.0 (2026-11-16)

### Features

- ship the admin CLI as the package's palm bin
  An instance repo now runs `pnpm palm ...` against its own database,
  with no clone of palm. --domain and --db default to the instance's
  package.json "palm" field, or PALM_DOMAIN and PALM_DB; flags still win.


## worker@0.2.0 (2026-11-16)

### Features

- plain web pages for profiles, posts and communities
  Share links now open on something: a profile at /@name, a post with
  its threaded comments at /@name/id, /post/id or /comment/id, and a
  community's posts at /c/name. Plain HTML, a few lines of CSS and no
  JavaScript, with Open Graph and Twitter card tags for link previews and
  a link to each page's ActivityPub object.

  Browsers on an actor's or object's ID land on these pages; servers
  asking for a page with an ActivityPub Accept header are sent to the
  object. Only public and unlisted posts show; other servers' content is
  marked noindex with its original as canonical. The bare domain still
  redirects to browserRedirect when one is set.

- prune daily, and let staging sign up with invites

- consume palm's queue, and give staging one

- route image uploads and give staging its media bucket

- serve the Mastodon API on the bare domain too
  Apps show the handle with the host they signed in to, so signing in with the
  bare domain gives @name@domain. Mastodon's paths don't overlap Lemmy's.

- wire federation delivery into requests and test posting

- serve the Lemmy API on the bare domain as well as its own host
  Voyager talks to the handle's domain once signed in. The Mastodon API stays
  on its own host.

- serve federation on the bare domain, and the client APIs there too
  @fedify/fedify becomes the package's one dependency.

- wire D1 and the Lemmy and Mastodon adapters
  Deployments now bind a D1 database as DB. Staging gets its own database.

### Fixes

- stop serving the client APIs on the bare domain
  The bare domain is federation only again; the Lemmy and Mastodon APIs answer
  on their own hosts.

### Dependencies

- core: 0.1.0 -> 1.0.0
- auth: 0.0.0 -> 0.1.0
- db: 0.0.0 -> 0.1.0
- adapter-lemmy: 0.0.0 -> 0.1.0
- adapter-mastodon: 0.0.0 -> 0.1.0
- federation: 0.0.0 -> 0.1.0


## worker@0.1.0 (2026-11-16)

### Features

- add createPalm, the staging entry and the package build
  createPalm(config) returns the Worker for one deployment. It routes by
  host, answers /_palm/version on any host, sends browsers on the bare
  domain to the configured redirect, and explains itself at the root of an
  API host. The package bundles @palm/* into one module for GitHub Packages.

### Dependencies

- core: 0.0.0 -> 0.1.0
