# Changelog

## federation@0.4.3 (2026-11-17)

### Fixes

- community backfill one post per queue job; cut-off thread fetches retried sooner

### Dependencies

- core: 1.1.0 -> 1.1.1
- db: 0.4.1 -> 0.4.2


## federation@0.4.2 (2026-11-17)

### Fixes

- quick follow/unfollow could end the newer follow; search results showed zero counts


## federation@0.4.1 (2026-11-17)

### Fixes

- lighter Mastodon timelines; link previews fetched apart from deliveries

- opening a slow server's profile or thread no longer stalls the app

### Dependencies

- db: 0.4.0 -> 0.4.1


## federation@0.4.0 (2026-11-17)

### Features

- Mastodon follows no longer show as Lemmy subscriptions

### Dependencies

- db: 0.3.0 -> 0.4.0


## federation@0.3.0 (2026-11-17)

### Features

- quote permissions and approvals

### Fixes

- keep values, not pending promises, between requests

### Dependencies

- db: 0.2.0 -> 0.3.0


## federation@0.2.0 (2026-11-17)

### Features

- account moves, deletion and export

- sign a retry when a server refuses an unsigned fetch

- polls, edit history, scheduled posts and quotes

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


## federation@0.1.1 (2026-11-16)

### Fixes

- send at once when the queue refuses, and to one recipient always
  Once the free plan's daily queue operations were used up (they're shared
  by every Worker on the account), nothing palm sent got out: accepting a
  follow threw inside the inbox handler, so the follower's server got a
  500, and new posts went nowhere.

  Activities now go through one helper. A single recipient (accepting a
  follow, notifying a reply's author) is sent straight away, since it's
  one cheap request. Several still go through the queue, and if it
  refuses, they're sent in the request instead of being lost.


## federation@0.1.0 (2026-11-16)

### Features

- fill in a remote thread's earlier comments from its own server
  Lemmy doesn't publish a post's replies over ActivityPub, so palm reads
  Lemmy's comment list or Mastodon's context from the post's server, and walks
  the replies collection for anything else. At most every 15 minutes a thread.

- carry hashtags on objects, and keep them from received posts

- take inbox deliveries at once and check them in a queue job
  Verifying a delivery (fetching the sender's key, parsing the activity) cost
  16-30 ms of CPU per request. With a queue, the request now only stores the
  delivery; a queue job runs it through Fedify's checks as it arrived.

- fetch a remote person's counts, and their recent posts when their profile is opened

- drop activities from blocked servers and banned people, and send them nothing

- federate communities and take in remote content
  Communities are Group actors at /c/{name} on a second Fedify federation.
  The shared inbox listeners store posts, comments, votes, boosts and follows
  from other servers when someone here would see them. Delivery tasks cover
  posts, edits, deletes, votes, boosts, follows, subscriptions and profiles,
  and local communities relay their activity to followers, as Lemmy does.

- deliver through a Cloudflare Queue, signing with RSA only
  Posting enqueues a task; a queue job builds and signs the activity, and
  Fedify fans out per inbox as further jobs. Received activities queue too.

- carry images as Note attachments

- give titled posts a name and keep community posts local for now

- serve posts as Notes, fill the outbox and deliver Create and Delete to followers

- answer nodeinfo as Lemmy, with palm's version as build metadata
  Voyager checks the handle's domain for Lemmy >=0.19 before it will use an
  account, so the bare domain has to say lemmy. The name can only be one
  lowercase word; palm shows in the version, repository and metadata.

- add WebFinger, Person actors, followers and nodeinfo on Fedify
  Follows of local accounts are recorded and accepted straight away; Undo
  removes them. Fedify's key-value store lives in D1, since free Workers KV
  allows only 1,000 writes a day.

### Fixes

- count relayed votes on remote posts without Fedify
  Most of a busy Lemmy community's deliveries are votes. A vote, or an
  undone vote, on a remote post palm keeps is now checked against its
  HTTP signature here (keys cached in the new remote_keys table) and
  written straight to D1, with a placeholder account for a voter palm
  hasn't seen. Fedify no longer parses it as JSON-LD or fetches the
  voter's profile and follower counts. Anything that can't be checked
  this way goes through Fedify as before.

- handle received activities in the request, not the queue
  Each queued delivery cost six of the free plan's 10,000 daily queue
  operations (palm's own deferral, then Fedify's inbox queue), and a few
  busy lemmy.world communities send over a thousand an hour, so the limit
  went within an hour. The queue now carries outgoing delivery only.

  Votes, undone votes and deletes about posts or people palm doesn't hold
  are answered 202 and dropped before Fedify parses them and checks their
  signature. A task the queue refuses runs in the request instead.

- leave boost rows out of outboxes and object lookups

- count a remote Lemmy post or comment as upvoted by its author, as Lemmy does

- give actors an outbox, which Lemmy requires
  Lemmy deserialises Person with a required outbox and silently drops actors
  without one, so lemmy.nz couldn't resolve @jason@palm-test.1j.nz while
  Mastodon could. The outbox is empty until palm stores posts.

### Dependencies

- core: 0.1.0 -> 1.0.0
- db: 0.0.0 -> 0.1.0
