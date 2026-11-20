import type { Video, VideoFile, VideoPlaylist, VideoThumbnail } from "@palm/db";

/** Reading PeerTube's Video objects: plain JSON in, palm's video fields out. No Fedify here, so tests can load it cheaply. */

export type Json = Record<string, unknown>;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
const href = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return str((value as Json).href) ?? str((value as Json).url) ?? str((value as Json).id);
  return null;
};

/** An ISO 8601 duration (PT1H2M3S, as ActivityStreams sends it) in seconds. */
export function parseDuration(value: unknown): number {
  if (typeof value === "number") return value;
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(value ?? ""));
  if (!match) return 0;
  const [, d, h, m, s] = match.map((x) => Number(x ?? 0));
  return Math.round((d ?? 0) * 86400 + (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0));
}

const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/ogg", "audio/mp4", "video/quicktime"]);

function fileOf(link: Json): VideoFile | null {
  const url = str(link.href);
  const mediaType = str(link.mediaType) ?? str(link.mimeType);
  if (!url || !mediaType || !VIDEO_TYPES.has(mediaType)) return null;
  return {
    url,
    mediaType,
    height: num(link.height) ?? 0,
    width: num(link.width),
    size: num(link.size) ?? 0,
    fps: num(link.fps) ?? -1,
  };
}

/** Uuid-shaped, the way PeerTube checks it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PeerTube's video fields from a Video object as its server sent it: files,
 * the HLS playlist, thumbnails, duration and the rest. Null for a Video that
 * isn't PeerTube's shape (no uuid and no files), which stays a plain post.
 */
export function videoFromJson(json: Json, postId: number, channelId: number | null): Video | null {
  const urls = asArray(json.url).filter((u): u is Json => !!u && typeof u === "object");
  const files: VideoFile[] = [];
  let hls: VideoPlaylist | null = null;
  let watchPage: string | null = null;
  for (const link of urls) {
    const type = str(link.mediaType) ?? str(link.mimeType);
    if (type === "application/x-mpegURL" && str(link.href)) {
      const tags = asArray(link.tag).filter((t): t is Json => !!t && typeof t === "object");
      hls = {
        url: str(link.href)!,
        segmentsSha256Url: tags.map((t) => (str(t.name) === "sha256" ? str(t.href) : null)).find(Boolean) ?? null,
        files: tags.map(fileOf).filter((f): f is VideoFile => f !== null),
      };
    } else if (type === "text/html") {
      watchPage ??= str(link.href);
    } else {
      const file = fileOf(link);
      if (file) files.push(file);
    }
  }
  const uuidRaw = str(json.uuid);
  if (!uuidRaw && !files.length && !hls) return null;
  const thumbnails: VideoThumbnail[] = asArray(json.icon)
    .map((i) => {
      const icon = (typeof i === "string" ? { url: i } : i) as Json;
      const url = href(icon.url) ?? href(icon);
      return url ? { url, width: num(icon.width), height: num(icon.height) } : null;
    })
    .filter((t): t is VideoThumbnail => t !== null)
    // Largest last, as PeerTube lists them; apps pick the one they want.
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  const identifier = (v: unknown) => (v && typeof v === "object" ? str((v as Json).identifier) : null);
  const published = str(json.originallyPublishedAt);
  return {
    postId,
    uuid: uuidRaw && UUID.test(uuidRaw) ? uuidRaw.toLowerCase() : crypto.randomUUID(),
    channelId,
    duration: parseDuration(json.duration),
    views: num(json.views) ?? 0,
    likes: 0,
    dislikes: 0,
    state: num(json.state) ?? 1,
    isLive: json.isLiveBroadcast === true,
    category: num(identifier(json.category)),
    licence: num(identifier(json.licence)),
    language: identifier(json.language),
    aspectRatio: num(json.aspectRatio),
    thumbnails,
    files: files.sort((a, b) => b.height - a.height),
    hls,
    embedUrl: str(json.embedUrl),
    // Older servers say commentsEnabled; 7.x and later commentsPolicy (1 enabled, 2 disabled, 3 needs approval).
    commentsEnabled: json.commentsEnabled === false ? false : num(json.commentsPolicy) === 2 ? false : true,
    downloadEnabled: json.downloadEnabled !== false,
    support: str(json.support),
    originallyPublishedAt: published && !Number.isNaN(Date.parse(published)) ? Math.floor(Date.parse(published) / 1000) : null,
  };
}

/** The watch page among a Video's URLs, for Lemmy and Mastodon apps to link to. */
export function watchPageOf(json: Json): string | null {
  for (const link of asArray(json.url)) {
    if (link && typeof link === "object" && (str((link as Json).mediaType) === "text/html" || !(link as Json).mediaType)) {
      const url = str((link as Json).href);
      if (url) return url;
    }
    if (typeof link === "string") return link;
  }
  return null;
}

