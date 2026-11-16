# Changelog

## worker@0.1.0 (2026-11-16)

### Features

- add createPalm, the staging entry and the package build
  createPalm(config) returns the Worker for one deployment. It routes by
  host, answers /_palm/version on any host, sends browsers on the bare
  domain to the configured redirect, and explains itself at the root of an
  API host. The package bundles @palm/* into one module for GitHub Packages.

### Dependencies

- core: 0.0.0 -> 0.1.0
