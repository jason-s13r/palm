# Changelog

## adapter-peertube@0.1.2 (2026-11-20)

### Fixes

- keep a video's chapters, which the PeerTube app sets after an upload


## adapter-peertube@0.1.1 (2026-11-20)

### Fixes

- resumable uploads in pieces under 5 MiB, as the PeerTube app sends

- PeerTube lists honour host, isLive and nsfw


## adapter-peertube@0.1.0 (2026-11-20)

### Features

- PeerTube apps, and video hosting
  Watching from PeerTube apps over videos federated here; uploads to R2, with
  thumbnails, renditions and HLS from Media Transformations, peertube-runner or
  Stream when bound.
