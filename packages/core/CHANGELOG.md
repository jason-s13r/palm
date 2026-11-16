# Changelog

## core@0.1.0 (2026-11-16)

### Features

- add the config model and host routing
  defineConfig checks a deployment's config (domains, API hosts, browser
  redirect) when the Worker is created. resolveSurface maps a request's host
  to federation or one of the client APIs.
