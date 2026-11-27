# Changelog

## adapter-peertube@0.4.1 (2026-11-27)

### Fixes

- keep the runner socket open with pings, telling the runner about new jobs


## adapter-peertube@0.4.0 (2026-11-20)

### Features

- mint new posts as /post/{id} and /comment/{id}
  Older posts keep /objects/{id}; all three paths resolve.


## adapter-peertube@0.3.0 (2026-11-20)

### Features

- runners transcode any uploaded video
  Videos from Lemmy, Mastodon and Pixelfed apps get HLS too, and a file that
  doesn't play everywhere is replaced by the runner's H.264 MP4. With a
  transcoder, MOV, WebM, MKV, AVI and 3GP are taken, up to 75 MB.


## adapter-peertube@0.2.1 (2026-11-20)

### Fixes

- uploads in pieces of any size, and video files shaped as PeerTube sends them


## adapter-peertube@0.2.0 (2026-11-20)

### Features

- HLS renditions from PeerTube runners, with palm's master playlist


## adapter-peertube@0.1.3 (2026-11-20)

### Fixes

- PeerTube routes with a trailing slash, and the app's server.json


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
