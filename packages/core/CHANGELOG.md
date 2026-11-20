# Changelog

## core@1.3.0 (2026-11-20)

### Features

- say what kind of post it is, and the app and device, per postClients
  Post pages read "on Pixelfed · via Ivory for iPhone"; the new postClients
  setting picks off, service, app (default) or device.


## core@1.2.0 (2026-11-19)

### Features

- import follows from another server
  `palm user import <username> <file>` reads Mastodon's following_accounts.csv,
  Lemmy's settings export or palm's own export into a new follow_imports table.
  The cron claims 5 every run and sends each as its own queue job, which looks
  the target up and follows it from the app the import names. Lemmy apps'
  settings import now leaves follows past its 40 lookups to the same queue
  instead of dropping them.


## core@1.1.1 (2026-11-17)

### Fixes

- uploaded images served from cache

- community backfill one post per queue job; cut-off thread fetches retried sooner


## core@1.1.0 (2026-11-17)

### Features

- streaming over a Durable Object
  Deployments export PalmStreaming and bind it as STREAMING.

- polls, edit history, scheduled posts and quotes

- reports, community moderation and the mod log

- locked accounts, pinned posts and featured hashtags

- link previews and a cached media proxy

- blocks and mutes for people, communities and servers


## core@1.0.0 (2026-11-16)

### Breaking Changes

- replace the activity sink's post hooks with federation tasks and resolve
  Adds remote-HTML sanitising, HTML-to-text for Lemmy apps, and mention
  linking in the plain-text renderer.

### Features

- add backfillThread to the activity sink

- find and link hashtags in plain text, and name tag URLs

- add backfillProfile to the activity sink

- render Lemmy's Markdown as HTML

- add the optional QUEUE binding

- add the optional MEDIA bucket binding and media URLs

- add community URLs and the shared plain-text renderer

- make the API hosts optional
  Both client APIs answer on the domain itself, where people sign in, so a
  deployment needs only its domain.

- add the activity sink adapters use to federate local changes

- add the Lemmy compatibility version and the nodeinfo version string
  nodeinfoVersion gives 0.19.9+palm.X.Y.Z: a Lemmy version apps accept, with
  palm's own as semver build metadata, which version comparisons ignore.

- add the request context and the ActivityPub URL scheme
  urls.user, urls.object and urls.inbox mint IDs at the root of the domain.


## core@0.1.0 (2026-11-16)

### Features

- add the config model and host routing
  defineConfig checks a deployment's config (domains, API hosts, browser
  redirect) when the Worker is created. resolveSurface maps a request's host
  to federation or one of the client APIs.
