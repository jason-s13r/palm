# Changelog

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
