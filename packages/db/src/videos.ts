import { toCommunity, type Community, type CommunityRow } from "./communities.ts";
import { toPost, type Post, type PostRow } from "./posts.ts";

const now = () => Math.floor(Date.now() / 1000);

/** One playable file: a web video (progressive MP4/WebM) or an HLS rendition. */
export interface VideoFile {
  url: string;
  mediaType: string;
  /** The rendition's height; PeerTube calls it the resolution. 0 for audio only. */
  height: number;
  width: number | null;
  size: number;
  fps: number;
}

/** An HLS playlist and its renditions. */
export interface VideoPlaylist {
  url: string;
  /** The playlist's segment hashes (PeerTube's sha256 JSON), when its server gives them. */
  segmentsSha256Url: string | null;
  files: VideoFile[];
}

export interface VideoThumbnail {
  url: string;
  width: number | null;
  height: number | null;
}

/** PeerTube's side of a post that is a video. */
export interface Video {
  postId: number;
  uuid: string;
  /** The channel it's published in (a Group, in communities). */
  channelId: number | null;
  /** Seconds. */
  duration: number;
  views: number;
  likes: number;
  dislikes: number;
  /** PeerTube's VideoState: 1 published, 2 waiting for transcoding, 3 waiting for live... */
  state: number;
  isLive: boolean;
  category: number | null;
  licence: number | null;
  language: string | null;
  aspectRatio: number | null;
  thumbnails: VideoThumbnail[];
  files: VideoFile[];
  hls: VideoPlaylist | null;
  embedUrl: string | null;
  commentsEnabled: boolean;
  downloadEnabled: boolean;
  support: string | null;
  originallyPublishedAt: number | null;
}

interface VideoRow {
  post_id: number;
  uuid: string;
  channel_id: number | null;
  duration: number;
  views: number;
  likes: number;
  dislikes: number;
  state: number;
  is_live: number;
  category: number | null;
  licence: number | null;
  video_language: string | null;
  aspect_ratio: number | null;
  thumbnails: string | null;
  files: string | null;
  hls: string | null;
  embed_url: string | null;
  comments_enabled: number;
  download_enabled: number;
  support: string | null;
  originally_published_at: number | null;
}

const parse = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const toVideo = (r: VideoRow): Video => ({
  postId: r.post_id,
  uuid: r.uuid,
  channelId: r.channel_id,
  duration: r.duration,
  views: r.views,
  likes: r.likes,
  dislikes: r.dislikes,
  state: r.state,
  isLive: r.is_live === 1,
  category: r.category,
  licence: r.licence,
  language: r.video_language,
  aspectRatio: r.aspect_ratio,
  thumbnails: parse(r.thumbnails, []),
  files: parse(r.files, []),
  hls: parse(r.hls, null),
  embedUrl: r.embed_url,
  commentsEnabled: r.comments_enabled === 1,
  downloadEnabled: r.download_enabled === 1,
  support: r.support,
  originallyPublishedAt: r.originally_published_at,
});

/** Records (or refreshes) a post's video side. */
export async function saveVideo(db: D1Database, video: Video): Promise<void> {
  await db
    .prepare(
      `INSERT INTO videos (post_id, uuid, channel_id, duration, views, likes, dislikes, state, is_live, category, licence, video_language,
         aspect_ratio, thumbnails, files, hls, embed_url, comments_enabled, download_enabled, support, originally_published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (post_id) DO UPDATE SET channel_id = excluded.channel_id, duration = excluded.duration, views = excluded.views,
         likes = excluded.likes, dislikes = excluded.dislikes, state = excluded.state, is_live = excluded.is_live,
         category = excluded.category, licence = excluded.licence, video_language = excluded.video_language, aspect_ratio = excluded.aspect_ratio,
         thumbnails = excluded.thumbnails, files = excluded.files, hls = excluded.hls, embed_url = excluded.embed_url,
         comments_enabled = excluded.comments_enabled, download_enabled = excluded.download_enabled, support = excluded.support,
         originally_published_at = excluded.originally_published_at`,
    )
    .bind(
      video.postId,
      video.uuid,
      video.channelId,
      Math.max(0, Math.round(video.duration)),
      video.views,
      video.likes,
      video.dislikes,
      video.state,
      video.isLive ? 1 : 0,
      video.category,
      video.licence,
      video.language,
      video.aspectRatio,
      JSON.stringify(video.thumbnails),
      JSON.stringify(video.files),
      video.hls ? JSON.stringify(video.hls) : null,
      video.embedUrl,
      video.commentsEnabled ? 1 : 0,
      video.downloadEnabled ? 1 : 0,
      video.support,
      video.originallyPublishedAt,
    )
    .run();
}

/** Updates the parts of a video that change after it's published (counts, state, files). */
export async function updateVideo(db: D1Database, postId: number, changes: Partial<Pick<Video, "state" | "files" | "hls" | "thumbnails" | "duration" | "aspectRatio">>): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (changes.state !== undefined) (sets.push("state = ?"), values.push(changes.state));
  if (changes.files !== undefined) (sets.push("files = ?"), values.push(JSON.stringify(changes.files)));
  if (changes.hls !== undefined) (sets.push("hls = ?"), values.push(changes.hls ? JSON.stringify(changes.hls) : null));
  if (changes.thumbnails !== undefined) (sets.push("thumbnails = ?"), values.push(JSON.stringify(changes.thumbnails)));
  if (changes.duration !== undefined) (sets.push("duration = ?"), values.push(Math.round(changes.duration)));
  if (changes.aspectRatio !== undefined) (sets.push("aspect_ratio = ?"), values.push(changes.aspectRatio));
  if (!sets.length) return;
  await db.prepare(`UPDATE videos SET ${sets.join(", ")} WHERE post_id = ?`).bind(...values, postId).run();
}

export async function videoByPostId(db: D1Database, postId: number): Promise<Video | null> {
  const row = await db.prepare("SELECT * FROM videos WHERE post_id = ?").bind(postId).first<VideoRow>();
  return row ? toVideo(row) : null;
}

export async function videoByUuid(db: D1Database, uuid: string): Promise<Video | null> {
  const row = await db.prepare("SELECT * FROM videos WHERE uuid = ?").bind(uuid.toLowerCase()).first<VideoRow>();
  return row ? toVideo(row) : null;
}

export async function videosByPostIds(db: D1Database, ids: number[]): Promise<Map<number, Video>> {
  const out = new Map<number, Video>();
  const unique = [...new Set(ids)];
  if (!unique.length) return out;
  const { results } = await db
    .prepare(`SELECT * FROM videos WHERE post_id IN (${unique.map(() => "?").join(", ")})`)
    .bind(...unique)
    .all<VideoRow>();
  for (const r of results) out.set(r.post_id, toVideo(r));
  return out;
}

/** Which videos to list, PeerTube's way: a start offset and a count. */
export interface VideoListing {
  start: number;
  count: number;
  /** "-publishedAt" (newest first, the default), "publishedAt", "-views", "-likes", "name"... */
  sort?: string | undefined;
  channelId?: number | undefined;
  accountId?: number | undefined;
  /** Videos from the channels this account subscribes to, and the people it follows. */
  subscribedBy?: number | undefined;
  /** Only videos uploaded here. */
  localOnly?: boolean | undefined;
  /** Words in the title or description. */
  search?: string | undefined;
  /** Unlisted (and the author's own private) videos too: a person's own list. */
  includeUnlisted?: boolean | undefined;
  /** Only these posts (a playlist, history). */
  postIds?: number[] | undefined;
}

export interface ListedVideo {
  post: Post;
  video: Video;
}

const SORTS: Record<string, string> = {
  "-publishedAt": "p.created_at DESC, p.id DESC",
  publishedAt: "p.created_at ASC, p.id ASC",
  "-createdAt": "p.id DESC",
  createdAt: "p.id ASC",
  "-originallyPublishedAt": "COALESCE(v.originally_published_at, p.created_at) DESC",
  "-views": "v.views DESC, p.id DESC",
  "-likes": "v.likes DESC, p.id DESC",
  "-trending": "v.views DESC, p.id DESC",
  "-hot": "v.likes DESC, p.created_at DESC",
  "-best": "v.likes DESC, p.created_at DESC",
  name: "p.title COLLATE NOCASE ASC",
  "-name": "p.title COLLATE NOCASE DESC",
  duration: "v.duration ASC",
  "-duration": "v.duration DESC",
  "-match": "p.created_at DESC",
};

/** A page of videos, and how many there are in all. Public and unlisted only; deleted ones never. */
export async function listVideos(db: D1Database, listing: VideoListing): Promise<{ total: number; data: ListedVideo[] }> {
  const where = ["p.deleted_at IS NULL", listing.includeUnlisted ? "1 = 1" : "p.visibility IN ('public', 'unlisted')"];
  const values: unknown[] = [];
  if (listing.channelId !== undefined) (where.push("v.channel_id = ?"), values.push(listing.channelId));
  if (listing.accountId !== undefined) (where.push("p.account_id = ?"), values.push(listing.accountId));
  if (listing.localOnly) where.push("p.ap_id IS NULL");
  if (listing.subscribedBy !== undefined) {
    where.push(
      `(v.channel_id IN (SELECT community_id FROM community_subscriptions WHERE account_id = ?)
        OR p.account_id IN (SELECT target_id FROM account_follows WHERE account_id = ? AND state = 'accepted'))`,
    );
    values.push(listing.subscribedBy, listing.subscribedBy);
  }
  if (listing.search?.trim()) {
    where.push("(p.title LIKE ? OR p.content_source LIKE ?)");
    const like = `%${listing.search.trim().replace(/[%_]/g, "")}%`;
    values.push(like, like);
  }
  if (listing.postIds) {
    if (!listing.postIds.length) return { total: 0, data: [] };
    where.push(`p.id IN (${listing.postIds.map(() => "?").join(", ")})`);
    values.push(...listing.postIds);
  }
  // Only public videos show in lists; unlisted ones are found by their link.
  if (!listing.postIds && !listing.includeUnlisted) where.push("p.visibility = 'public'");
  const from = `FROM posts p JOIN videos v ON v.post_id = p.id WHERE ${where.join(" AND ")}`;
  const order = SORTS[listing.sort ?? "-publishedAt"] ?? SORTS["-publishedAt"];
  const [count, rows] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n ${from}`).bind(...values),
    db.prepare(`SELECT p.*, v.* ${from} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...values, Math.min(Math.max(listing.count, 0), 100), Math.max(listing.start, 0)),
  ]);
  const total = (count?.results?.[0] as { n: number } | undefined)?.n ?? 0;
  const data = ((rows?.results ?? []) as (PostRow & VideoRow)[]).map((r) => ({ post: toPost(r), video: toVideo(r) }));
  return { total, data };
}

/** How many videos each channel has (public ones). */
export async function channelVideoCounts(db: D1Database, channelIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const unique = [...new Set(channelIds)];
  if (!unique.length) return out;
  const { results } = await db
    .prepare(
      `SELECT v.channel_id AS id, COUNT(*) AS n FROM videos v JOIN posts p ON p.id = v.post_id
       WHERE p.deleted_at IS NULL AND p.visibility = 'public' AND v.channel_id IN (${unique.map(() => "?").join(", ")}) GROUP BY v.channel_id`,
    )
    .bind(...unique)
    .all<{ id: number; n: number }>();
  for (const r of results) out.set(r.id, r.n);
  return out;
}

/** The person most of a channel's videos are by: PeerTube's channel owner. */
export async function channelOwnerId(db: D1Database, channelId: number): Promise<number | null> {
  const row = await db
    .prepare("SELECT p.account_id AS id FROM videos v JOIN posts p ON p.id = v.post_id WHERE v.channel_id = ? ORDER BY p.id DESC LIMIT 1")
    .bind(channelId)
    .first<{ id: number }>();
  return row?.id ?? null;
}

/** Channels with videos by this person. */
export async function channelsOf(db: D1Database, accountId: number): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT DISTINCT v.channel_id AS id FROM videos v JOIN posts p ON p.id = v.post_id WHERE p.account_id = ? AND v.channel_id IS NOT NULL LIMIT 50")
    .bind(accountId)
    .all<{ id: number }>();
  return results.map((r) => r.id);
}

/** The local likes and dislikes on videos, beside what their servers counted. */
export async function localRatings(db: D1Database, postIds: number[], viewerId: number | null): Promise<Map<number, { likes: number; dislikes: number; mine: "like" | "dislike" | "none" }>> {
  const out = new Map<number, { likes: number; dislikes: number; mine: "like" | "dislike" | "none" }>();
  const unique = [...new Set(postIds)];
  if (!unique.length) return out;
  const { results } = await db
    .prepare(
      `SELECT p.id,
         (SELECT COUNT(*) FROM votes x WHERE x.post_id = p.id AND x.score = 1) AS likes,
         (SELECT COUNT(*) FROM votes x WHERE x.post_id = p.id AND x.score = -1) AS dislikes,
         (SELECT score FROM votes x WHERE x.post_id = p.id AND x.account_id = ?1) AS mine
       FROM posts p WHERE p.id IN (${unique.map((_, i) => `?${i + 2}`).join(", ")})`,
    )
    .bind(viewerId ?? -1, ...unique)
    .all<{ id: number; likes: number; dislikes: number; mine: number | null }>();
  for (const r of results) out.set(r.id, { likes: r.likes, dislikes: r.dislikes, mine: r.mine === 1 ? "like" : r.mine === -1 ? "dislike" : "none" });
  return out;
}

/** Refreshes another server's counts for a video, as its own API reported them. */
export async function setVideoCounts(db: D1Database, postId: number, counts: { views: number; likes: number; dislikes: number }): Promise<void> {
  await db
    .prepare("UPDATE videos SET views = ?, likes = ?, dislikes = ?, fetched_at = ? WHERE post_id = ?")
    .bind(counts.views, counts.likes, counts.dislikes, now(), postId)
    .run();
}

/** Claims a refresh of another server's counts, if the last was over `ttl` seconds ago. */
export async function claimVideoRefresh(db: D1Database, postId: number, ttl: number): Promise<boolean> {
  const row = await db
    .prepare("UPDATE videos SET fetched_at = ? WHERE post_id = ? AND (fetched_at IS NULL OR fetched_at < ?) RETURNING post_id")
    .bind(now(), postId, now() - ttl)
    .first();
  return row !== null;
}

/** Counts a view of a local video (other servers' views stay theirs). */
export async function countView(db: D1Database, postId: number): Promise<void> {
  await db.prepare("UPDATE videos SET views = views + 1 WHERE post_id = ?").bind(postId).run();
}

// --- watch history -------------------------------------------------------------

export async function recordWatch(db: D1Database, accountId: number, postId: number, currentTime: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO video_history (account_id, post_id, watched_to, viewed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, post_id) DO UPDATE SET watched_to = excluded.watched_to, viewed_at = excluded.viewed_at`,
    )
    .bind(accountId, postId, Math.max(0, Math.round(currentTime)), now())
    .run();
}

/** Where this person stopped watching each video. */
export async function watchPositions(db: D1Database, accountId: number, postIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const unique = [...new Set(postIds)];
  if (!unique.length) return out;
  const { results } = await db
    .prepare(`SELECT post_id, watched_to FROM video_history WHERE account_id = ? AND post_id IN (${unique.map(() => "?").join(", ")})`)
    .bind(accountId, ...unique)
    .all<{ post_id: number; watched_to: number }>();
  for (const r of results) out.set(r.post_id, r.watched_to);
  return out;
}

/** The videos this person watched, latest first. */
export async function watchHistory(db: D1Database, accountId: number, start: number, count: number): Promise<{ total: number; postIds: number[] }> {
  const [total, rows] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM video_history WHERE account_id = ?").bind(accountId),
    db.prepare("SELECT post_id FROM video_history WHERE account_id = ? ORDER BY viewed_at DESC LIMIT ? OFFSET ?").bind(accountId, count, start),
  ]);
  return {
    total: (total?.results?.[0] as { n: number } | undefined)?.n ?? 0,
    postIds: ((rows?.results ?? []) as { post_id: number }[]).map((r) => r.post_id),
  };
}

export async function forgetWatch(db: D1Database, accountId: number, postId?: number, before?: number): Promise<void> {
  if (postId !== undefined) {
    await db.prepare("DELETE FROM video_history WHERE account_id = ? AND post_id = ?").bind(accountId, postId).run();
  } else {
    await db.prepare("DELETE FROM video_history WHERE account_id = ? AND viewed_at < ?").bind(accountId, before ?? now() + 1).run();
  }
}

/** The posts this person saved (PeerTube's Watch later), newest first. */
export async function savedVideoIds(db: D1Database, accountId: number): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT k.post_id FROM bookmarks k JOIN videos v ON v.post_id = k.post_id WHERE k.account_id = ? ORDER BY k.created_at DESC LIMIT 500")
    .bind(accountId)
    .all<{ post_id: number }>();
  return results.map((r) => r.post_id);
}

/**
 * A video's comments, all levels, oldest first, deleted ones included (so
 * threads keep their shape). Comments sit below the video by parent_id, as
 * replies to statuses and Lemmy comments both do.
 */
export async function videoComments(db: D1Database, postId: number, limit = 1000): Promise<(Post & { deleted: boolean })[]> {
  const { results } = await db
    .prepare(
      `WITH RECURSIVE thread(id, depth) AS (
         SELECT id, 1 FROM posts WHERE parent_id = ?1 AND reblog_of IS NULL
         UNION ALL
         SELECT p.id, t.depth + 1 FROM posts p JOIN thread t ON p.parent_id = t.id WHERE p.reblog_of IS NULL AND t.depth < 30
       )
       SELECT p.* FROM posts p JOIN thread t ON t.id = p.id ORDER BY p.id LIMIT ?2`,
    )
    .bind(postId, limit)
    .all<PostRow & { deleted_at: number | null }>();
  return results.map((r) => ({ ...toPost(r), deleted: r.deleted_at !== null }));
}

// --- hosting ---------------------------------------------------------------------

/**
 * A person's PeerTube channel: a local community they own (`{name}_channel`,
 * as PeerTube names a first channel), made the first time they upload. It
 * signs with a copy of its owner's keys, since making keys in the Worker
 * costs more CPU than the free plan allows. Lemmy apps see it as a
 * community its owner moderates.
 */
export async function ensureLocalChannel(db: D1Database, owner: { id: number; domain: string; username: string; displayName: string | null }): Promise<Community> {
  const existing = await db.prepare("SELECT * FROM communities WHERE channel_owner_id = ?").bind(owner.id).first<CommunityRow>();
  if (existing) return toCommunity(existing);
  const base = `${owner.username.toLowerCase()}_channel`;
  let name = base;
  for (let i = 2; i < 20; i++) {
    const taken = await db
      .prepare("SELECT 1 FROM accounts WHERE domain = ?1 AND username = ?2 UNION SELECT 1 FROM communities WHERE domain = ?1 AND name = ?2 AND ap_id IS NULL")
      .bind(owner.domain, name)
      .first();
    if (!taken) break;
    name = `${base}${i}`;
  }
  const at = now();
  const row = await db
    .prepare(
      `INSERT INTO communities (domain, name, title, description, nsfw, created_at, channel_owner_id)
       VALUES (?, ?, ?, ?, 0, ?, ?) ON CONFLICT DO NOTHING RETURNING *`,
    )
    .bind(owner.domain, name, `Main ${owner.displayName || owner.username} channel`, null, at, owner.id)
    .first<CommunityRow>();
  // Two first uploads at once: the other made it.
  if (!row) return toCommunity((await db.prepare("SELECT * FROM communities WHERE channel_owner_id = ?").bind(owner.id).first<CommunityRow>())!);
  await db.batch([
    db
      .prepare(
        `INSERT OR REPLACE INTO community_keys (community_id, algorithm, public_jwk, private_jwk, created_at)
         SELECT ?, algorithm, public_jwk, private_jwk, ? FROM actor_keys WHERE account_id = ?`,
      )
      .bind(row.id, at, owner.id),
    db.prepare("INSERT OR IGNORE INTO community_mods (community_id, account_id, created_at) VALUES (?, ?, ?)").bind(row.id, owner.id, at),
    db.prepare("INSERT OR IGNORE INTO community_subscriptions (community_id, account_id, created_at) VALUES (?, ?, ?)").bind(row.id, owner.id, at),
  ]);
  return toCommunity(row);
}

/** Who owns a local channel, or null for a community that isn't one. */
export async function channelOwnerOf(db: D1Database, communityId: number): Promise<number | null> {
  const row = await db.prepare("SELECT channel_owner_id AS id FROM communities WHERE id = ?").bind(communityId).first<{ id: number | null }>();
  return row?.id ?? null;
}

/** A local video's own files: its upload and its thumbnail, in the media table. */
export async function videoMediaIds(db: D1Database, postId: number): Promise<{ mediaId: string | null; thumbnailMediaId: string | null }> {
  const row = await db.prepare("SELECT media_id, thumbnail_media_id FROM videos WHERE post_id = ?").bind(postId).first<{ media_id: string | null; thumbnail_media_id: string | null }>();
  return { mediaId: row?.media_id ?? null, thumbnailMediaId: row?.thumbnail_media_id ?? null };
}

export async function setVideoMedia(db: D1Database, postId: number, media: { mediaId?: string | null; thumbnailMediaId?: string | null }): Promise<void> {
  if (media.mediaId !== undefined) await db.prepare("UPDATE videos SET media_id = ? WHERE post_id = ?").bind(media.mediaId, postId).run();
  if (media.thumbnailMediaId !== undefined) await db.prepare("UPDATE videos SET thumbnail_media_id = ? WHERE post_id = ?").bind(media.thumbnailMediaId, postId).run();
}

/** Records a file already in R2 (under media/<id>) as an upload. */
export async function registerMedia(db: D1Database, media: { id: string; accountId: number; contentType: string; size: number; postId: number | null; token: string }): Promise<void> {
  await db
    .prepare("INSERT INTO media (id, account_id, content_type, size, description, delete_token, post_id, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)")
    .bind(media.id, media.accountId, media.contentType, media.size, media.token, media.postId, now())
    .run();
}

/** Work done on a local video after it's published: another service making its renditions. */
export interface Transcode {
  provider: "stream" | "runner";
  /** Stream's video ID. */
  id?: string;
  /** Stream: "processing", then "downloading" while its MP4 is made. */
  status?: string;
  startedAt: number;
}

export async function setTranscode(db: D1Database, postId: number, transcode: Transcode | null): Promise<void> {
  await db.prepare("UPDATE videos SET transcode = ? WHERE post_id = ?").bind(transcode ? JSON.stringify(transcode) : null, postId).run();
}

export async function pendingTranscodes(db: D1Database, provider: Transcode["provider"], limit = 10): Promise<{ postId: number; transcode: Transcode }[]> {
  const { results } = await db
    .prepare("SELECT post_id, transcode FROM videos WHERE transcode IS NOT NULL ORDER BY post_id LIMIT 50")
    .all<{ post_id: number; transcode: string }>();
  return results
    .map((r) => ({ postId: r.post_id, transcode: parse<Transcode | null>(r.transcode, null) }))
    .filter((r): r is { postId: number; transcode: Transcode } => r.transcode?.provider === provider)
    .slice(0, limit);
}

// --- resumable uploads ---------------------------------------------------------------

/** A video being sent in pieces (PeerTube's resumable upload), into an R2 multipart upload. */
export interface VideoUpload {
  id: string;
  accountId: number;
  mediaId: string;
  contentType: string;
  r2UploadId: string;
  size: number;
  received: number;
  partSize: number | null;
  parts: { partNumber: number; etag: string }[];
  /** The video's details, as the app sent them when it started. */
  meta: Record<string, unknown>;
  createdAt: number;
}

interface UploadRow {
  id: string;
  account_id: number;
  media_id: string;
  content_type: string;
  r2_upload_id: string;
  size: number;
  received: number;
  part_size: number | null;
  parts: string;
  meta: string;
  created_at: number;
}

const toUpload = (r: UploadRow): VideoUpload => ({
  id: r.id,
  accountId: r.account_id,
  mediaId: r.media_id,
  contentType: r.content_type,
  r2UploadId: r.r2_upload_id,
  size: r.size,
  received: r.received,
  partSize: r.part_size,
  parts: parse(r.parts, []),
  meta: parse(r.meta, {}),
  createdAt: r.created_at,
});

export async function createUpload(db: D1Database, upload: Omit<VideoUpload, "received" | "partSize" | "parts" | "createdAt">): Promise<void> {
  await db
    .prepare("INSERT INTO video_uploads (id, account_id, media_id, content_type, r2_upload_id, size, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(upload.id, upload.accountId, upload.mediaId, upload.contentType, upload.r2UploadId, upload.size, JSON.stringify(upload.meta), now())
    .run();
}

export async function uploadById(db: D1Database, id: string): Promise<VideoUpload | null> {
  const row = await db.prepare("SELECT * FROM video_uploads WHERE id = ?").bind(id).first<UploadRow>();
  return row ? toUpload(row) : null;
}

/** Records a received piece, if no other request recorded one at the same place first. */
export async function recordUploadPart(db: D1Database, upload: VideoUpload, part: { partNumber: number; etag: string; length: number; partSize: number }): Promise<boolean> {
  const parts = [...upload.parts.filter((p) => p.partNumber !== part.partNumber), { partNumber: part.partNumber, etag: part.etag }];
  const result = await db
    .prepare("UPDATE video_uploads SET received = received + ?, part_size = ?, parts = ? WHERE id = ? AND received = ?")
    .bind(part.length, part.partSize, JSON.stringify(parts), upload.id, upload.received)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteUpload(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM video_uploads WHERE id = ?").bind(id).run();
}

/** Uploads left unfinished for a day. */
export async function staleUploads(db: D1Database): Promise<VideoUpload[]> {
  const { results } = await db.prepare("SELECT * FROM video_uploads WHERE created_at < ? LIMIT 20").bind(now() - 86400).all<UploadRow>();
  return results.map(toUpload);
}
