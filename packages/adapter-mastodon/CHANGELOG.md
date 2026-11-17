# Changelog

## adapter-mastodon@0.4.1 (2026-11-17)

### Fixes

- lighter Mastodon timelines; link previews fetched apart from deliveries

### Dependencies

- db: 0.4.0 -> 0.4.1


## adapter-mastodon@0.4.0 (2026-11-17)

### Features

- Mastodon follows no longer show as Lemmy subscriptions

### Dependencies

- db: 0.3.0 -> 0.4.0


## adapter-mastodon@0.3.0 (2026-11-17)

### Features

- quote permissions and approvals

### Dependencies

- db: 0.2.0 -> 0.3.0


## adapter-mastodon@0.2.0 (2026-11-17)

### Features

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


## adapter-mastodon@0.1.0 (2026-11-16)

### Features

- answer the endpoints apps keep asking for
  From the unknown_endpoint logs: Mastodon's extended description, peers
  and weekly activity, and Lemmy's modlog and registration applications.
  Streaming answers 404 without being logged, since apps fall back to
  polling.

- refresh a remote thread's comments when it's opened

- hashtags on statuses, tag timelines and hashtag search

- video attachments

- show boosts in timelines and on profiles

- invite sign-up and suspended accounts

- follows, favourites, boosts, bookmarks, mentions, edits, notifications and profiles

- upload media, attach it to statuses, and look up accounts in bulk

- show Lemmy posts as statuses led by their title

- post, read and delete statuses, with profile and timeline lists

- answer translation languages, notification policy and push
  Rehashes passwords made with an old setting after sign-in, too.

- add OAuth sign-in, instance info and empty timelines
  Apps register, open palm's sign-in page at /oauth/authorize, and exchange the
  code for a token, with PKCE supported. verify_credentials and the endpoints
  apps load at startup answer; the rest are logged.

### Fixes

- show remote profiles with their own counts and recent posts

- leave an image post's link out of its text, since the image is attached

- answer familiar followers, endorsements, featured tags and push unsubscribe

- give accounts and statuses profile URLs on the API host
  The Mastodon iOS app finds the signed-in account by matching its url's host
  to the server it signed in to; with the ActivityPub ID there it found none,
  showed no profile in the composer and refused to publish.

### Dependencies

- core: 0.1.0 -> 1.0.0
- auth: 0.0.0 -> 0.1.0
- db: 0.0.0 -> 0.1.0
