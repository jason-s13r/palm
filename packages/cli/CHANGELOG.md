# Changelog

## cli@0.3.0 (2026-11-17)

### Features

- account moves, deletion and export

- reports, community moderation and the mod log


## cli@0.2.0 (2026-11-16)

### Features

- ship the admin CLI as the package's palm bin
  An instance repo now runs `pnpm palm ...` against its own database,
  with no clone of palm. --domain and --db default to the instance's
  package.json "palm" field, or PALM_DOMAIN and PALM_DB; flags still win.


## cli@0.1.0 (2026-11-16)

### Features

- add invite create

- add community create, with the community's signing keys

- generate actor signing keys in palm user create and palm user keys

- add palm user create
  Hashes a password locally and inserts the account through wrangler d1
  execute, or prints the SQL.

### Dependencies

- auth: 0.0.0 -> 0.1.0
