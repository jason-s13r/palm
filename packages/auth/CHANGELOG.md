# Changelog

## auth@0.1.0 (2026-11-16)

### Features

- add password hashing, JWTs and tokens on Web Crypto
  PBKDF2-SHA256 with the iteration count stored in each hash, HS256 JWTs for
  Lemmy sessions, random tokens and SHA-256 hex for storing tokens by hash.

### Fixes

- lower PBKDF2 to 20,000 iterations to fit the free CPU limit
  50,000 measured 10–13 ms per login on Workers. needsRehash now flags any
  other iteration count, so existing hashes move to the new setting.
