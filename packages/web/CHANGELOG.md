# Changelog

## web@0.1.3 (2026-11-20)

### Fixes

- fewer D1 rows read and written
  Remote votes on remote posts kept by actor ID without accounts; WITHOUT ROWID votes, post_tags and fedify_kv; an index for local accounts; site counts and known servers memoised; score sorts consider the newest 200 posts; remote documents cached in memory.

### Dependencies

- db: 0.5.0 -> 0.5.1


## web@0.1.2 (2026-11-20)

### Fixes

- the App Store Pixelfed app signs in, and its legal links stay on palm
  The App Store build of the Pixelfed app needs Pixelfed 0.14.4 or later, so
  palm's Pixelfed nodeinfo now reports 0.15.2. /site/terms, /site/privacy,
  /site/help and /e/terms, /e/privacy, which the app links to, get a page of
  their own instead of falling through to browserRedirect.


## web@0.1.1 (2026-11-19)

### Fixes

- another server's "interact from your server" link no longer goes to the configured site

### Dependencies

- core: 1.1.1 -> 1.2.0
- db: 0.4.3 -> 0.5.0


## web@0.1.0 (2026-11-16)

### Features

- show palm's version in the page footer

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
