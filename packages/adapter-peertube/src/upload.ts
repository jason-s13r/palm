import { randomToken } from "@palm/auth";
import { markdownToHtml, urls, userAgentClient, type RequestContext } from "@palm/core";
import {
  addTags,
  createPost,
  createUpload,
  deleteMedia,
  deletePost,
  deleteUpload,
  editPost,
  ensureLocalChannel,
  mediaById,
  postById,
  recordUploadPart,
  registerMedia,
  saveVideo,
  setTranscode,
  setVideoMedia,
  updateVideo,
  uploadById,
  videoByPostId,
  videoByUuid,
  videoMediaIds,
  type Account,
  type Video,
  type VideoThumbnail,
} from "@palm/db";
import { Hono } from "hono";
import { fail, params, type C, type Env } from "./http.ts";
import { PLAYS_EVERYWHERE, probeMp4, r2Reader, type Probe } from "./mp4.ts";
import { queueRunnerJobs } from "./runner.ts";
import { fromShortUuid, isUuid, toShortUuid } from "./short-uuid.ts";

/** What this deployment can do with video, found from its bindings. */
export interface Capabilities {
  /** An R2 bucket is bound: uploads can be kept. */
  uploads: boolean;
  /**
   * Who makes renditions of an upload: Cloudflare Stream (paid), PeerTube's
   * remote runners (a machine of your own), or nobody (the upload is played
   * as it came, which is free).
   */
  transcoder: "stream" | "runner" | null;
  /** Thumbnails from a frame of the video (Media Transformations). */
  frames: boolean;
  /** Bytes each person may upload in all. */
  quota: number;
  /** The size of each piece of a resumable upload: R2 wants equal parts of at least 5 MiB. */
  chunkSize: number;
  /** The files accepted. Without a transcoder, only MP4 (it plays as it is). */
  extensions: string[];
}

const MIB = 1024 * 1024;
/** R2's smallest multipart part (but the last). */
const MIN_PART = 5 * MIB;
const CHUNK = 10 * MIB;
/** A whole video in one request (PeerTube's older upload): under Cloudflare's 100 MB request limit. */
const MAX_SINGLE_UPLOAD = 95 * MIB;

export function capabilities(ctx: RequestContext): Capabilities {
  const env = ctx.bindings;
  const stream = typeof env.STREAM?.upload === "function";
  const runner = typeof env.PEERTUBE_RUNNER_TOKEN === "string" && env.PEERTUBE_RUNNER_TOKEN.length >= 16;
  const transcoder = stream ? "stream" : runner ? "runner" : null;
  const quotaMb = Number(env.PALM_VIDEO_QUOTA_MB ?? 2048);
  return {
    uploads: env.MEDIA !== undefined,
    transcoder,
    frames: typeof env.MEDIA_TRANSFORMS?.input === "function",
    quota: Math.max(0, Number.isFinite(quotaMb) ? quotaMb : 2048) * MIB,
    chunkSize: CHUNK,
    // Stream takes anything; runners get files palm can read (MP4 and QuickTime share a format).
    extensions: transcoder === "stream" ? [".mp4", ".m4v", ".mov", ".webm", ".mkv"] : transcoder === "runner" ? [".mp4", ".m4v", ".mov"] : [".mp4", ".m4v"],
  };
}

const TYPES: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska" };
const extensionOf = (filename: string) => /\.[a-z0-9]+$/i.exec(filename)?.[0]?.toLowerCase() ?? "";

const hexId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

export const uploadRoutes = new Hono<Env>({ strict: false });

async function quotaLeft(c: C, account: Account): Promise<number> {
  const row = await c.env.bindings.DB.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM media WHERE account_id = ? AND content_type NOT LIKE 'image/%'")
    .bind(account.id)
    .first<{ n: number }>();
  return capabilities(c.env).quota - (row?.n ?? 0);
}

/** Checks an upload can start: someone signed in, storage bound, a type and size palm takes. */
async function admit(c: C, filename: string, size: number, type: string): Promise<{ account: Account; contentType: string } | Response> {
  const account = c.get("account");
  if (!account) return fail(c, 401, "Authentication is required.");
  if (account.movedTo) return fail(c, 403, "This account has moved.");
  const caps = capabilities(c.env);
  if (!caps.uploads) return fail(c, 403, "This server doesn't keep videos: it has no storage for them.");
  const ext = extensionOf(filename) || (type === "video/mp4" ? ".mp4" : "");
  if (!caps.extensions.includes(ext)) {
    return fail(c, 415, `This server takes ${caps.extensions.join(", ")} files${caps.transcoder ? "" : " (it plays them as they are, so use H.264 MP4)"}.`, "video_unsupported_type");
  }
  if (!Number.isFinite(size) || size <= 0) return fail(c, 400, "The video's size is needed (X-Upload-Content-Length).");
  if (size > (await quotaLeft(c, account))) return fail(c, 413, "The video is larger than your quota allows.", "quota_reached");
  return { account, contentType: TYPES[ext] ?? type ?? "video/mp4" };
}

// --- resumable upload: start, pieces, cancel ----------------------------------------

/** Waiting pieces, one after another, as one stream of known length (R2's uploadPart needs the length). */
async function joinPieces(bucket: R2Bucket, keys: string[], total: number): Promise<ReadableStream> {
  const { readable, writable } = new FixedLengthStream(total);
  (async () => {
    for (const key of keys) {
      const piece = await bucket.get(key);
      if (!piece) throw new Error(`Missing upload piece ${key}`);
      await piece.body.pipeTo(writable, { preventClose: true });
    }
    await writable.close();
  })().catch((error: unknown) => writable.abort(error).catch(() => undefined));
  return readable;
}

uploadRoutes.post("/api/v1/videos/upload-resumable", async (c) => {
  const p = await params(c);
  const filename = String(p.filename ?? p.name ?? "video.mp4");
  const size = Number(c.req.header("x-upload-content-length") ?? p.size ?? 0);
  const admitted = await admit(c, filename, size, c.req.header("x-upload-content-type") ?? "video/mp4");
  if (admitted instanceof Response) return admitted;
  if (!String(p.name ?? "").trim()) return fail(c, 400, "A video needs a name.");
  const mediaId = hexId();
  const multipart = await c.env.bindings.MEDIA!.createMultipartUpload(`media/${mediaId}`, { httpMetadata: { contentType: admitted.contentType } });
  const id = randomToken(16);
  await createUpload(c.env.bindings.DB, {
    id,
    accountId: admitted.account.id,
    mediaId,
    contentType: admitted.contentType,
    r2UploadId: multipart.uploadId,
    size,
    meta: { ...p, filename },
  });
  c.header("Location", `//${c.env.host}/api/v1/videos/upload-resumable?upload_id=${id}`);
  return c.body(null, 201);
});

uploadRoutes.put("/api/v1/videos/upload-resumable", async (c) => {
  const account = c.get("account");
  if (!account) return fail(c, 401, "Authentication is required.");
  const db = c.env.bindings.DB;
  const bucket = c.env.bindings.MEDIA;
  const upload = await uploadById(db, c.req.query("upload_id") ?? "");
  if (!upload || upload.accountId !== account.id || !bucket) return fail(c, 404, "Upload not found");
  const incomplete = (received: number) => {
    if (received > 0) c.header("Range", `bytes=0-${received - 1}`);
    return c.body(null, 308);
  };
  const range = c.req.header("content-range") ?? "";
  // "bytes */total": where did we get to?
  if (/^bytes \*\/\d+$/.test(range)) return incomplete(upload.received);
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
  if (!match) return fail(c, 400, "A Content-Range is needed.");
  const [start, end, total] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const length = end - start + 1;
  if (total !== upload.size) return fail(c, 400, "The upload's size changed.");
  // A piece palm already has (a retry), or one past what it has: tell the app where to go on from.
  if (start !== upload.received) return incomplete(upload.received);
  const last = end + 1 === upload.size;
  // The app picks its piece size (the PeerTube app sends 1 MiB). R2 wants
  // equal parts of at least 5 MiB, so smaller pieces wait in R2 until there
  // are enough to join into one part.
  const chunkSize = upload.chunkSize ?? length;
  if (!last && length !== chunkSize) return fail(c, 400, `Send the upload in equal pieces (this one started with ${chunkSize} bytes).`);
  const partSize = upload.partSize ?? (chunkSize >= MIN_PART ? chunkSize : chunkSize * Math.ceil(MIN_PART / chunkSize));
  const body = c.req.raw.body;
  if (!body) return fail(c, 400, "The piece was empty.");
  const multipart = bucket.resumeMultipartUpload(`media/${upload.mediaId}`, upload.r2UploadId);
  const flushed = upload.received - upload.buffered;
  const partNumber = Math.floor(flushed / partSize) + 1;
  let part: { partNumber: number; etag: string } | null = null;
  let buffered = 0;
  let chunks = 0;
  if (upload.buffered === 0 && (length === partSize || last)) {
    part = await multipart.uploadPart(partNumber, body);
  } else {
    const pieceKey = (n: number) => `uploads/${upload.id}/${n}`;
    await bucket.put(pieceKey(upload.chunks), body);
    buffered = upload.buffered + length;
    chunks = upload.chunks + 1;
    if (buffered >= partSize || last) {
      part = await multipart.uploadPart(partNumber, await joinPieces(bucket, Array.from({ length: chunks }, (_, i) => pieceKey(i)), buffered));
      c.env.waitUntil(bucket.delete(Array.from({ length: chunks }, (_, i) => pieceKey(i))).catch(() => undefined));
      buffered = 0;
      chunks = 0;
    }
  }
  const recorded = await recordUploadPart(db, upload, { length, partSize, chunkSize, part, buffered, chunks });
  if (!recorded) return incomplete((await uploadById(db, upload.id))?.received ?? upload.received);
  if (!last) return incomplete(upload.received + length);
  const parts = [...upload.parts.filter((x) => x.partNumber !== part!.partNumber), part!].sort((a, b) => a.partNumber - b.partNumber);
  await multipart.complete(parts);
  await deleteUpload(db, upload.id);
  const video = await publishUpload(c, account, { mediaId: upload.mediaId, contentType: upload.contentType, size: upload.size, meta: upload.meta, thumbnail: null });
  return c.json({ video });
});

uploadRoutes.delete("/api/v1/videos/upload-resumable", async (c) => {
  const account = c.get("account");
  const db = c.env.bindings.DB;
  const upload = await uploadById(db, c.req.query("upload_id") ?? "");
  if (upload && account && upload.accountId === account.id) {
    await c.env.bindings.MEDIA?.resumeMultipartUpload(`media/${upload.mediaId}`, upload.r2UploadId).abort().catch(() => undefined);
    if (upload.chunks) await c.env.bindings.MEDIA?.delete(Array.from({ length: upload.chunks }, (_, i) => `uploads/${upload.id}/${i}`)).catch(() => undefined);
    await deleteUpload(db, upload.id);
  }
  return c.body(null, 204);
});

// --- the older upload: one request, the file in a form ----------------------------------

uploadRoutes.post("/api/v1/videos/upload", async (c) => {
  const length = Number(c.req.header("content-length") ?? 0);
  if (length > MAX_SINGLE_UPLOAD) return fail(c, 413, "Large videos go through the resumable upload.");
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.videofile;
  if (!(file instanceof File)) return fail(c, 400, "videofile is needed.");
  const admitted = await admit(c, file.name, file.size, file.type);
  if (admitted instanceof Response) return admitted;
  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(form ?? {})) if (typeof v === "string") meta[k.replace(/\[\]$/, "")] = v;
  if (!String(meta.name ?? "").trim()) return fail(c, 400, "A video needs a name.");
  const mediaId = hexId();
  await c.env.bindings.MEDIA!.put(`media/${mediaId}`, file.stream(), { httpMetadata: { contentType: admitted.contentType } });
  const thumbnail = form?.thumbnailfile instanceof File ? form.thumbnailfile : form?.previewfile instanceof File ? form.previewfile : null;
  const video = await publishUpload(c, admitted.account, { mediaId, contentType: admitted.contentType, size: file.size, meta, thumbnail });
  return c.json({ video });
});

// --- publishing an upload ---------------------------------------------------------------

const PRIVACY: Record<number, "public" | "unlisted" | "direct"> = { 1: "public", 2: "unlisted", 3: "direct", 4: "unlisted", 5: "direct" };

/** A thumbnail palm keeps itself (a frame, or one the app sent), in R2 like any upload. */
async function storeThumbnail(c: C, account: Account, postId: number, bytes: ReadableStream | ArrayBuffer, type: string, size: number): Promise<VideoThumbnail | null> {
  const bucket = c.env.bindings.MEDIA;
  if (!bucket) return null;
  const id = hexId();
  const contentType = type === "image/png" ? "image/png" : type === "image/webp" ? "image/webp" : "image/jpeg";
  await bucket.put(`media/${id}`, bytes, { httpMetadata: { contentType } });
  await registerMedia(c.env.bindings.DB, { id, accountId: account.id, contentType, size, postId: null, token: randomToken(16) });
  await setVideoMedia(c.env.bindings.DB, postId, { thumbnailMediaId: id });
  const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  return { url: urls.media(c.env.domain.domain, `${id}.${ext}`), width: 1280, height: 720 };
}

/** A frame from the video, by Media Transformations, when it's bound (and the file is under its 100 MB limit). */
async function frameThumbnail(c: C, account: Account, postId: number, mediaId: string, size: number, duration: number): Promise<VideoThumbnail | null> {
  const transforms = c.env.bindings.MEDIA_TRANSFORMS;
  const bucket = c.env.bindings.MEDIA;
  if (!transforms || !bucket || size >= 100 * MIB) return null;
  try {
    const source = await bucket.get(`media/${mediaId}`);
    if (!source) return null;
    const at = Math.min(Math.max(1, Math.floor(duration / 3)), 30, Math.max(0, Math.floor(duration) - 1));
    const response = await transforms.input(source.body).transform({ width: 1280, height: 720, fit: "contain" }).output({ mode: "frame", time: `${at}s`, format: "jpg" }).response();
    if (!response.ok || !response.body) return null;
    const bytes = await response.arrayBuffer();
    return storeThumbnail(c, account, postId, bytes, "image/jpeg", bytes.byteLength);
  } catch (error) {
    console.warn(JSON.stringify({ palm: "video_frame_failed", error: String(error) }));
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const bool = (v: unknown, fallback: boolean) => (v === undefined || v === null || v === "" ? fallback : v === true || v === "true" || v === "1");

/**
 * Turns a finished upload into a video: reads its MP4 header, makes the post
 * (in its person's channel, a community), and its PeerTube side, picks a
 * thumbnail, hands it to a transcoder if there is one, and tells followers.
 */
async function publishUpload(
  c: C,
  account: Account,
  upload: { mediaId: string; contentType: string; size: number; meta: Record<string, unknown>; thumbnail: File | null },
) {
  const db = c.env.bindings.DB;
  const bucket = c.env.bindings.MEDIA!;
  const caps = capabilities(c.env);
  const probe: Probe | null = upload.contentType === "video/mp4" || upload.contentType === "video/quicktime" ? await probeMp4(r2Reader(bucket, `media/${upload.mediaId}`), upload.size) : null;
  const channel = await ensureLocalChannel(db, account);
  const meta = upload.meta;
  const description = (str(meta.description) ?? "").trim();
  const name = (str(meta.name) ?? "Untitled").trim().slice(0, 120);
  const ext = upload.contentType === "video/mp4" ? "mp4" : upload.contentType === "video/quicktime" ? "mov" : upload.contentType === "video/webm" ? "webm" : "bin";
  const fileUrl = urls.media(c.env.domain.domain, `${upload.mediaId}.${ext}`);
  const agent = userAgentClient(c.req.header("user-agent"));
  const post = await createPost(db, {
    accountId: account.id,
    client: "peertube",
    clientApp: agent.app,
    clientDevice: agent.device,
    contentSource: description,
    contentHtml: description ? markdownToHtml(description) : "",
    spoilerText: "",
    sensitive: bool(meta.nsfw, false),
    visibility: PRIVACY[num(meta.privacy) ?? 1] ?? "public",
    language: str(meta.language) ?? null,
    inReplyTo: null,
    communityId: channel.id,
    title: name,
    // Lemmy apps play a link to a video file in place.
    linkUrl: fileUrl,
  });
  await registerMedia(db, { id: upload.mediaId, accountId: account.id, contentType: upload.contentType, size: upload.size, postId: post.id, token: randomToken(16) });
  const uuid = crypto.randomUUID();
  const video: Video = {
    postId: post.id,
    uuid,
    channelId: channel.id,
    duration: Math.round(probe?.duration ?? 0),
    views: 0,
    likes: 0,
    dislikes: 0,
    state: 1,
    isLive: false,
    category: num(meta.category),
    licence: num(meta.licence),
    language: str(meta.language) ?? null,
    aspectRatio: probe?.width && probe.height ? Math.round((probe.width / probe.height) * 10000) / 10000 : null,
    thumbnails: [],
    files: [{ url: fileUrl, mediaType: upload.contentType, height: probe?.height ?? 0, width: probe?.width ?? null, size: upload.size, fps: probe?.fps ?? -1 }],
    hls: null,
    embedUrl: null,
    commentsEnabled: num(meta.commentsPolicy) !== null ? num(meta.commentsPolicy) !== 2 : bool(meta.commentsEnabled, true),
    downloadEnabled: bool(meta.downloadEnabled, true),
    support: str(meta.support) ?? null,
    originallyPublishedAt: str(meta.originallyPublishedAt) ? Math.floor(Date.parse(str(meta.originallyPublishedAt)!) / 1000) || null : null,
  };
  await saveVideo(db, video);
  await setVideoMedia(db, post.id, { mediaId: upload.mediaId });
  const tags = (Array.isArray(meta.tags) ? meta.tags : typeof meta.tags === "string" ? meta.tags.split(",") : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 5);
  if (tags.length) await addTags(db, post.id, tags);

  // The thumbnail: the app's, else a frame (Media Transformations), else palm's placeholder.
  const thumbnail = upload.thumbnail
    ? await storeThumbnail(c, account, post.id, upload.thumbnail.stream(), upload.thumbnail.type, upload.thumbnail.size)
    : caps.frames
      ? await frameThumbnail(c, account, post.id, upload.mediaId, upload.size, video.duration)
      : null;
  if (thumbnail) await updateVideo(db, post.id, { thumbnails: [thumbnail] });

  // Renditions, where there's something to make them.
  if (caps.transcoder === "stream") {
    try {
      const sent = await c.env.bindings.STREAM!.upload(fileUrl, { meta: { name, palm: String(post.id) } });
      const id = sent.uid ?? sent.id;
      if (id) await setTranscode(db, post.id, { provider: "stream", id, status: "processing", startedAt: Math.floor(Date.now() / 1000) });
    } catch (error) {
      console.warn(JSON.stringify({ palm: "stream_upload_failed", postId: post.id, error: String(error) }));
    }
  } else if (caps.transcoder === "runner") {
    await queueRunnerJobs(db, post.id, probe, PLAYS_EVERYWHERE.has(probe?.videoCodec ?? ""));
  }

  if (post.visibility !== "direct") c.env.activities.enqueue({ kind: "video_published", postId: post.id, update: false });
  return { id: post.id, uuid, shortUUID: toShortUuid(uuid) };
}

// --- changing and removing one's own videos ---------------------------------------------

async function ownVideo(c: C, id: string) {
  const db = c.env.bindings.DB;
  const account = c.get("account");
  if (!account) return null;
  let video: Video | null = null;
  if (/^\d+$/.test(id)) video = await videoByPostId(db, Number(id));
  else video = await videoByUuid(db, isUuid(id) ? id : (fromShortUuid(id) ?? ""));
  const post = video ? await postById(db, video.postId) : null;
  return video && post && post.accountId === account.id && post.apId === null ? { account, video, post } : null;
}

uploadRoutes.put("/api/v1/videos/:id", async (c) => {
  const own = await ownVideo(c, c.req.param("id"));
  if (!own) return fail(c, 404, "Video not found");
  const type = c.req.header("content-type") ?? "";
  const form: Record<string, unknown> = type.includes("json") ? await c.req.json<Record<string, unknown>>().catch(() => ({})) : await c.req.parseBody().catch(() => ({}));
  const db = c.env.bindings.DB;
  const name = str(form.name)?.trim();
  const description = str(form.description);
  if (name !== undefined || description !== undefined) {
    const text = description ?? own.post.contentSource;
    await editPost(db, own.post.id, { contentSource: text, contentHtml: text ? markdownToHtml(text) : "", title: name || null });
  }
  const privacy = num(form.privacy);
  if (privacy !== null && PRIVACY[privacy]) await db.prepare("UPDATE posts SET visibility = ? WHERE id = ?").bind(PRIVACY[privacy], own.post.id).run();
  const thumb = form.thumbnailfile instanceof File ? form.thumbnailfile : form.previewfile instanceof File ? form.previewfile : null;
  if (thumb) {
    const stored = await storeThumbnail(c, own.account, own.post.id, thumb.stream(), thumb.type, thumb.size);
    if (stored) await updateVideo(db, own.post.id, { thumbnails: [stored] });
  }
  c.env.activities.enqueue({ kind: "video_published", postId: own.post.id, update: true });
  return c.body(null, 204);
});

uploadRoutes.delete("/api/v1/videos/:id", async (c) => {
  const own = await ownVideo(c, c.req.param("id"));
  if (!own) return fail(c, 404, "Video not found");
  const db = c.env.bindings.DB;
  await deletePost(db, own.post.id);
  c.env.activities.enqueue({ kind: "post_deleted", postId: own.post.id });
  // Its files go after the Delete is on its way.
  const { mediaId, thumbnailMediaId } = await videoMediaIds(db, own.post.id);
  for (const id of [mediaId, thumbnailMediaId]) {
    const media = id ? await mediaById(db, id) : null;
    if (media) c.env.waitUntil(deleteMedia(db, c.env.bindings.MEDIA, media).catch(() => undefined));
  }
  const transcode = await db.prepare("SELECT transcode FROM videos WHERE post_id = ?").bind(own.post.id).first<{ transcode: string | null }>();
  const streamId = transcode?.transcode ? (JSON.parse(transcode.transcode) as { provider: string; id?: string }) : null;
  if (streamId?.provider === "stream" && streamId.id) c.env.waitUntil(c.env.bindings.STREAM?.video(streamId.id).delete().catch(() => undefined) ?? Promise.resolve());
  await setTranscode(db, own.post.id, null);
  return c.body(null, 204);
});
