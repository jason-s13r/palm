# Changelog

## db@0.8.2 (2026-11-20)

### Fixes

- keep a video's chapters, which the PeerTube app sets after an upload


## db@0.8.1 (2026-11-20)

### Fixes

- resumable uploads in pieces under 5 MiB, as the PeerTube app sends

- PeerTube lists honour host, isLive and nsfw


## db@0.8.0 (2026-11-20)

### Features

- PeerTube apps, and video hosting
  Watching from PeerTube apps over videos federated here; uploads to R2, with
  thumbnails, renditions and HLS from Media Transformations, peertube-runner or
  Stream when bound.


## db@0.7.0 (2026-11-20)

### Features

- profile directory, and Pixelfed's login activity

- Pixelfed stories


## db@0.6.0 (2026-11-20)

### Features

- say what kind of post it is, and the app and device, per postClients
  Post pages read "on Pixelfed · via Ivory for iPhone"; the new postClients
  setting picks off, service, app (default) or device.

- show which app a local post came from
  Web pages say "via Ivory (Mastodon)", "via Pixelfed" or "via Lemmy"; Mastodon
  apps get the status's application.


## db@0.5.1 (2026-11-20)

### Fixes

- fewer D1 rows read and written
  Remote votes on remote posts kept by actor ID without accounts; WITHOUT ROWID votes, post_tags and fedify_kv; an index for local accounts; site counts and known servers memoised; score sorts consider the newest 200 posts; remote documents cached in memory.


## db@0.5.0 (2026-11-19)

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

- import follows from another server
  `palm user import <username> <file>` reads Mastodon's following_accounts.csv,
  Lemmy's settings export or palm's own export into a new follow_imports table.
  The cron claims 5 every run and sends each as its own queue job, which looks
  the target up and follows it from the app the import names. Lemmy apps'
  settings import now leaves follows past its 40 lookups to the same queue
  instead of dropping them.

### Fixes

- retries no longer repeat notifications, posts or stale subscription changes


## db@0.4.3 (2026-11-18)

### Fixes

- a request could fail while two servers applied the same database update


## db@0.4.2 (2026-11-17)

### Fixes

- community backfill one post per queue job; cut-off thread fetches retried sooner

- other servers' fetches of profiles, WebFinger and nodeinfo served from cache


## db@0.4.1 (2026-11-17)

### Fixes

- lighter Mastodon timelines; link previews fetched apart from deliveries


## db@0.4.0 (2026-11-17)

### Features

- Mastodon follows no longer show as Lemmy subscriptions


## db@0.3.0 (2026-11-17)

### Features

- quote permissions and approvals

- !following and !local feeds; statuses leave Home unless subscribed

### Fixes

- keep values, not pending promises, between requests


## db@0.2.0 (2026-11-17)

### Features

- account moves, deletion and export

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


## db@0.1.0 (2026-11-16)

### Features

- show people's statuses to Lemmy apps as person communities
  Lemmy apps only show posts in communities, so each person gets one in
  palm's Lemmy API: !name@host, with their public statuses as its posts
  (titled from the first line) and the replies under them as comments,
  threaded by what they reply to. Subscribing follows the person and
  their statuses join the Subscribed feed. A comment is sent as a reply
  that mentions the person it answers, so Mastodon notifies them.

  These communities exist only in the API, with IDs above 1,000,000,000.
  Replies to statuses keep their shape, so Mastodon apps see nothing new.

- mark when a remote thread was last refreshed

- hashtags

- accept video uploads and serve media in ranges

- keep boosts as rows in posts, so they sort and page with timelines

- keep remote profiles' outboxes and counts

- bans, blocked servers, invites and pruning

- keep remote people, communities and posts alongside local ones
  Migration 6 marks remote rows by their ActivityPub ID, and adds follows,
  community followers, boosts, bookmarks, mentions and notifications.

- store uploaded images in R2, with attachments to posts

- add communities, subscriptions, votes and Lemmy threads on posts

- store local posts

- add actor keys, followers and a key-value table for Fedify

- add the schema, self-applying migrations and account queries
  The Worker migrates D1 itself on the first request in each isolate, so a
  deployment has no migration step. Accounts, revocable Lemmy sessions, and
  Mastodon OAuth apps, codes and tokens stored by hash.

### Fixes

- count relayed votes on remote posts without Fedify
  Most of a busy Lemmy community's deliveries are votes. A vote, or an
  undone vote, on a remote post palm keeps is now checked against its
  HTTP signature here (keys cached in the new remote_keys table) and
  written straight to D1, with a placeholder account for a voter palm
  hasn't seen. Fedify no longer parses it as JSON-LD or fetches the
  voter's profile and follower counts. Anything that can't be checked
  this way goes through Fedify as before.

### Dependencies

- auth: 0.0.0 -> 0.1.0
