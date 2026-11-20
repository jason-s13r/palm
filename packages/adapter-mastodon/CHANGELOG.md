# Changelog

## adapter-mastodon@0.9.0 (2026-11-20)

### Features

- runners transcode any uploaded video
  Videos from Lemmy, Mastodon and Pixelfed apps get HLS too, and a file that
  doesn't play everywhere is replaced by the runner's H.264 MP4. With a
  transcoder, MOV, WebM, MKV, AVI and 3GP are taken, up to 75 MB.

### Dependencies

- core: 1.5.1 -> 1.6.0
- db: 0.9.1 -> 0.10.0


## adapter-mastodon@0.8.0 (2026-11-20)

### Features

- profile directory, and Pixelfed's login activity

- Pixelfed stories

### Dependencies

- core: 1.3.0 -> 1.4.0
- db: 0.6.0 -> 0.7.0


## adapter-mastodon@0.7.0 (2026-11-20)

### Features

- say what kind of post it is, and the app and device, per postClients
  Post pages read "on Pixelfed · via Ivory for iPhone"; the new postClients
  setting picks off, service, app (default) or device.

- show which app a local post came from
  Web pages say "via Ivory (Mastodon)", "via Pixelfed" or "via Lemmy"; Mastodon
  apps get the status's application.

### Dependencies

- core: 1.2.0 -> 1.3.0
- db: 0.5.1 -> 0.6.0


## adapter-mastodon@0.6.2 (2026-11-20)

### Fixes

- Pixelfed's /api/v2.1/config, which the App Store app checks
  The App Store build of the Pixelfed app (1.8) reads the server's version from
  /api/v2.1/config, not /api/nodeinfo/2.0.json, and refused palm with "needs to
  be running Pixelfed 0.14.4" because that path was a 404. palm now answers it
  (version 0.15.2, as on pixelfed.social), and the account timeline settings
  beside it, and routes /api/v2.1/ to the Mastodon adapter.


## adapter-mastodon@0.6.1 (2026-11-20)

### Fixes

- the App Store Pixelfed app signs in, and its legal links stay on palm
  The App Store build of the Pixelfed app needs Pixelfed 0.14.4 or later, so
  palm's Pixelfed nodeinfo now reports 0.15.2. /site/terms, /site/privacy,
  /site/help and /e/terms, /e/privacy, which the app links to, get a page of
  their own instead of falling through to browserRedirect.


## adapter-mastodon@0.6.0 (2026-11-19)

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

### Fixes

- retries no longer repeat notifications, posts or stale subscription changes

### Dependencies

- core: 1.1.1 -> 1.2.0
- db: 0.4.3 -> 0.5.0


## adapter-mastodon@0.5.0 (2026-11-17)

### Features

- moved accounts show where they went in Mastodon apps

### Fixes

- Mastodon timelines load in fewer database rounds

### Dependencies

- core: 1.1.0 -> 1.1.1
- db: 0.4.1 -> 0.4.2


## adapter-mastodon@0.4.2 (2026-11-17)

### Fixes

- quick follow/unfollow could end the newer follow; search results showed zero counts


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
