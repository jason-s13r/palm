# Changelog

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
