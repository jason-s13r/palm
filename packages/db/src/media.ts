import { randomToken } from "@palm/auth";


const now = () => Math.floor(Date.now() / 1000);

/** Types palm accepts, and the file extension each is served under. */
export const MEDIA_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

/** The largest image palm takes, in bytes. */
export const MAX_MEDIA_SIZE = 10 * 1024 * 1024;
/** The largest video: a phone clip of a minute or two. */
export const MAX_VIDEO_SIZE = 40 * 1024 * 1024;

export const isVideo = (contentType: string) => contentType.startsWith("video/");

/** An uploaded file. It's stored in R2 under `media/<id>` and served at /pictrs/image/<file>. */
export interface Media {
  id: string;
  accountId: number;
  contentType: string;
  size: number;
  description: string | null;
  deleteToken: string;
  postId: number | null;
  createdAt: number;
  /** The name it's served under: the ID and the type's extension. */
  file: string;
}

interface MediaRow {
  id: string;
  account_id: number;
  content_type: string;
  size: number;
  description: string | null;
  delete_token: string;
  post_id: number | null;
  created_at: number;
}

const toMedia = (r: MediaRow): Media => ({
  id: r.id,
  accountId: r.account_id,
  contentType: r.content_type,
  size: r.size,
  description: r.description,
  deleteToken: r.delete_token,
  postId: r.post_id,
  createdAt: r.created_at,
  file: `${r.id}.${MEDIA_TYPES[r.content_type] ?? "bin"}`,
});

/** Why an upload was refused, for the API to put in its own words. */
export type UploadProblem = "unsupported_type" | "too_large" | "no_storage";

/** Stores an upload in R2 and records it. */
export async function storeMedia(
  db: D1Database,
  bucket: R2Bucket | undefined,
  accountId: number,
  file: File,
  description: string | null,
): Promise<Media | UploadProblem> {
  if (!bucket) return "no_storage";
  if (!MEDIA_TYPES[file.type]) return "unsupported_type";
  if (file.size > (isVideo(file.type) ? MAX_VIDEO_SIZE : MAX_MEDIA_SIZE)) return "too_large";
  // Hex, so the served name is the same in any case.
  const id = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await bucket.put(`media/${id}`, file.stream(), { httpMetadata: { contentType: file.type } });
  const row = await db
    .prepare(
      `INSERT INTO media (id, account_id, content_type, size, description, delete_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(id, accountId, file.type, file.size, description, randomToken(16), now())
    .first<MediaRow>();
  return toMedia(row!);
}

/** A file by its ID or its served name ("abc123.jpg"). */
export async function mediaById(db: D1Database, idOrFile: string): Promise<Media | null> {
  const id = idOrFile.replace(/\.[a-z0-9]+$/i, "");
  const row = await db.prepare("SELECT * FROM media WHERE id = ?").bind(id).first<MediaRow>();
  return row ? toMedia(row) : null;
}

export async function describeMedia(db: D1Database, id: string, description: string | null): Promise<void> {
  await db.prepare("UPDATE media SET description = ? WHERE id = ?").bind(description, id).run();
}

/**
 * Attaches an account's unattached uploads to a post, in the order given.
 * Returns how many it attached, so a caller can tell when an ID wasn't theirs.
 */
export async function attachMedia(db: D1Database, postId: number, accountId: number, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const results = await db.batch(
    ids.map((id, position) =>
      db
        .prepare("UPDATE media SET post_id = ?, position = ? WHERE id = ? AND account_id = ? AND post_id IS NULL")
        .bind(postId, position, id, accountId),
    ),
  );
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

/** The files attached to each of these posts, in order. */
export async function mediaForPosts(db: D1Database, postIds: number[]): Promise<Map<number, Media[]>> {
  const unique = [...new Set(postIds)];
  const out = new Map<number, Media[]>();
  if (!unique.length) return out;
  const { results } = await db
    .prepare(`SELECT * FROM media WHERE post_id IN (${unique.map(() => "?").join(", ")}) ORDER BY post_id, position`)
    .bind(...unique)
    .all<MediaRow>();
  for (const row of results) {
    const list = out.get(row.post_id!) ?? [];
    list.push(toMedia(row));
    out.set(row.post_id!, list);
  }
  return out;
}

/** Removes a file from R2 and the database. */
export async function deleteMedia(db: D1Database, bucket: R2Bucket | undefined, media: Media): Promise<void> {
  await bucket?.delete(`media/${media.id}`);
  await db.prepare("DELETE FROM media WHERE id = ?").bind(media.id).run();
}

/**
 * Serves a stored file, cached for good: a file's name never changes what it
 * holds. Answers Range requests, which video players need to seek (iOS won't
 * play a video without them).
 */
export async function mediaResponse(bucket: R2Bucket | undefined, idOrFile: string, request: Request): Promise<Response | null> {
  if (!bucket) return null;
  const id = idOrFile.replace(/\.[a-z0-9]+$/i, "");
  if (!/^[a-z0-9]+$/.test(id)) return null;
  const key = `media/${id}`;
  const ranged = request.headers.has("range");
  const object = request.method === "HEAD" ? await bucket.head(key) : await bucket.get(key, ranged ? { range: request.headers } : {});
  if (!object) return null;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("access-control-allow-origin", "*");
  const range = (object as R2ObjectBody).range as { offset?: number; length?: number } | undefined;
  if (ranged && range && "body" in object) {
    const start = range.offset ?? 0;
    const length = range.length ?? object.size - start;
    headers.set("content-range", `bytes ${start}-${start + length - 1}/${object.size}`);
    headers.set("content-length", String(length));
    return new Response((object as R2ObjectBody).body, { status: 206, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response("body" in object ? (object as R2ObjectBody).body : null, { headers });
}
