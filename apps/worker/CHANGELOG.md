# Changelog

## worker@0.8.1 (2026-11-20)

### Fixes

- the App Store Pixelfed app signs in, and its legal links stay on palm
  The App Store build of the Pixelfed app needs Pixelfed 0.14.4 or later, so
  palm's Pixelfed nodeinfo now reports 0.15.2. /site/terms, /site/privacy,
  /site/help and /e/terms, /e/privacy, which the app links to, get a page of
  their own instead of falling through to browserRedirect.

### Dependencies

- adapter-mastodon: 0.6.0 -> 0.6.1
- web: 0.1.1 -> 0.1.2


## worker@0.8.0 (2026-11-19)

### Features

- the Pixelfed app
  Pixelfed's API is Mastodon's with extras, so the Mastodon adapter serves it:
  - /api/nodeinfo/2.0.json (Pixelfed's own path, which the app checks before
    signing in) answers as Pixelfed; standard nodeinfo stays Lemmy.
  - Pixelfed apps get Pixelfed's fields on accounts and statuses (pf_type,
    reply_count, liked_by, local, note_text...), added by a middleware only for
    them, so Mastodon apps' responses are unchanged.
  - Its endpoints under /api/v1.1, /api/v1.2 and /api/pixelfed: username lookup,
    mutuals, avatar removal, reports, compose settings and config, discover
    (trending photos, hashtags, popular people), and chats over direct posts.
    Stories and collections answer empty; Pixelfed's push answers unsupported,
    as Pixelfed servers without its gateway do.
  - update_credentials takes its fields from the query string, and POST.

- a moved account can't post
  New statuses (scheduled ones included), posts and comments are refused once
  an account has moved, as Mastodon does.

- import follows from another server
  `palm user import <username> <file>` reads Mastodon's following_accounts.csv,
  Lemmy's settings export or palm's own export into a new follow_imports table.
  The cron claims 5 every run and sends each as its own queue job, which looks
  the target up and follows it from the app the import names. Lemmy apps'
  settings import now leaves follows past its 40 lookups to the same queue
  instead of dropping them.

### Fixes

- retries no longer repeat notifications, posts or stale subscription changes

- another server's "interact from your server" link no longer goes to the configured site

### Dependencies

- core: 1.1.1 -> 1.2.0
- db: 0.4.3 -> 0.5.0
- adapter-lemmy: 0.4.1 -> 0.5.0
- adapter-mastodon: 0.5.0 -> 0.6.0
- federation: 0.4.4 -> 0.5.0
- web: 0.1.0 -> 0.1.1
- cli: 0.3.1 -> 0.4.0


## worker@0.7.1 (2026-11-18)

### Fixes

- communities nobody here subscribes to no longer fill the database

- a request could fail while two servers applied the same database update

### Dependencies

- db: 0.4.2 -> 0.4.3
- federation: 0.4.3 -> 0.4.4


## worker@0.7.0 (2026-11-17)

### Features

- moved accounts show where they went in Mastodon apps

### Fixes

- Mastodon timelines load in fewer database rounds

- uploaded images served from cache

- community backfill one post per queue job; cut-off thread fetches retried sooner

- other servers' fetches of profiles, WebFinger and nodeinfo served from cache

### Dependencies

- core: 1.1.0 -> 1.1.1
- db: 0.4.1 -> 0.4.2
- adapter-lemmy: 0.4.0 -> 0.4.1
- adapter-mastodon: 0.4.2 -> 0.5.0
- federation: 0.4.2 -> 0.4.3
- cli: 0.3.0 -> 0.3.1


## worker@0.6.2 (2026-11-17)

### Fixes

- quick follow/unfollow could end the newer follow; search results showed zero counts

### Dependencies

- adapter-mastodon: 0.4.1 -> 0.4.2
- federation: 0.4.1 -> 0.4.2


## worker@0.6.1 (2026-11-17)

### Fixes

- lighter Mastodon timelines; link previews fetched apart from deliveries

- opening a slow server's profile or thread no longer stalls the app

### Dependencies

- db: 0.4.0 -> 0.4.1
- adapter-mastodon: 0.4.0 -> 0.4.1
- federation: 0.4.0 -> 0.4.1


## worker@0.6.0 (2026-11-17)

### Features

- Mastodon follows no longer show as Lemmy subscriptions

### Dependencies

- db: 0.3.0 -> 0.4.0
- adapter-lemmy: 0.3.0 -> 0.4.0
- adapter-mastodon: 0.3.0 -> 0.4.0
- federation: 0.3.0 -> 0.4.0


## worker@0.5.0 (2026-11-17)

### Features

- quote permissions and approvals

- !following and !local feeds; statuses leave Home unless subscribed

### Fixes

- keep values, not pending promises, between requests

### Dependencies

- db: 0.2.0 -> 0.3.0
- adapter-lemmy: 0.2.0 -> 0.3.0
- adapter-mastodon: 0.2.0 -> 0.3.0
- federation: 0.2.0 -> 0.3.0


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
