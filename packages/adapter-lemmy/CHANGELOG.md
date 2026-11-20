# Changelog

## adapter-lemmy@0.6.0 (2026-11-20)

### Features

- say what kind of post it is, and the app and device, per postClients
  Post pages read "on Pixelfed · via Ivory for iPhone"; the new postClients
  setting picks off, service, app (default) or device.

- show which app a local post came from
  Web pages say "via Ivory (Mastodon)", "via Pixelfed" or "via Lemmy"; Mastodon
  apps get the status's application.

### Fixes

- show pictures as image posts in Lemmy apps
  Statuses' uploads and Lemmy's untyped Image attachments become the post's
  link; statuses join the Lemmy profile; orphaned community comments are dropped.

### Dependencies

- core: 1.2.0 -> 1.3.0
- db: 0.5.1 -> 0.6.0


## adapter-lemmy@0.5.0 (2026-11-19)

### Features

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

### Dependencies

- core: 1.1.1 -> 1.2.0
- db: 0.4.3 -> 0.5.0


## adapter-lemmy@0.4.1 (2026-11-17)

### Fixes

- uploaded images served from cache

### Dependencies

- core: 1.1.0 -> 1.1.1
- db: 0.4.1 -> 0.4.2


## adapter-lemmy@0.4.0 (2026-11-17)

### Features

- Mastodon follows no longer show as Lemmy subscriptions

### Dependencies

- db: 0.3.0 -> 0.4.0


## adapter-lemmy@0.3.0 (2026-11-17)

### Features

- !following and !local feeds; statuses leave Home unless subscribed

### Dependencies

- db: 0.2.0 -> 0.3.0


## adapter-lemmy@0.2.0 (2026-11-17)

### Features

- account moves, deletion and export

- lists, followed hashtags, filters, read and hidden posts, cross-posts

- reports, community moderation and the mod log

- private messages shared by Lemmy and Mastodon apps

- link previews and a cached media proxy

- blocks and mutes for people, communities and servers

### Dependencies

- core: 1.0.0 -> 1.1.0
- db: 0.1.0 -> 0.2.0


## adapter-lemmy@0.1.0 (2026-11-16)

### Features

- answer the endpoints apps keep asking for
  From the unknown_endpoint logs: Mastodon's extended description, peers
  and weekly activity, and Lemmy's modlog and registration applications.
  Streaming answers 404 without being logged, since apps fall back to
  polling.

- show people's statuses to Lemmy apps as person communities
  Lemmy apps only show posts in communities, so each person gets one in
  palm's Lemmy API: !name@host, with their public statuses as its posts
  (titled from the first line) and the replies under them as comments,
  threaded by what they reply to. Subscribing follows the person and
  their statuses join the Subscribed feed. A comment is sent as a reply
  that mentions the person it answers, so Mastodon notifies them.

  These communities exist only in the API, with IDs above 1,000,000,000.
  Replies to statuses keep their shape, so Mastodon apps see nothing new.

- refresh a remote thread's comments when it's opened

- serve uploads with range requests

- invite sign-up, bans, removals, blocked servers, profile settings and Markdown

- subscribe to remote communities, resolve objects, saves and the inbox

- take image uploads at pict-rs's paths, serve them, and answer the report queues

- serve communities, posts, comments and votes

- report palm's version as build metadata in nodeinfo

- serve site, login and empty feeds for Lemmy apps
  Typed against lemmy-js-client 0.19. Unknown endpoints are logged so the next
  ones to build show up in the Worker's logs.

### Fixes

- put the API host in the JWT's iss
  Voyager reads iss to know which server an account is on. palm put the
  federation domain there, so after a restart Voyager connected to the bare
  domain, saw nodeinfo report palm rather than Lemmy, and refused it.

- rehash passwords made with an old setting after login

### Dependencies

- core: 0.1.0 -> 1.0.0
- auth: 0.0.0 -> 0.1.0
- db: 0.0.0 -> 0.1.0
