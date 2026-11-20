import { randomToken } from "@palm/auth";
import { urls, type RequestContext } from "@palm/core";
import {
  acceptRunnerJob,
  addRunnerJobs,
  availableRunnerJobs,
  finishRunnerJob,
  hasAvailableRunnerJobs,
  heldRunnerJob,
  registerMedia,
  registerRunner,
  runnerByToken,
  runnerJobProgress,
  runnerJobsLeft,
  setTranscode,
  unregisterRunner,
  updateVideo,
  videoByPostId,
  videoMediaIds,
  postById,
  mediaById,
  replaceMediaFile,
  saveVideo,
  setVideoMedia,
  untranscodedVideoMedia,
  videosWithoutHls,
  type RunnerJob,
  type RunnerJobType,
  type Video,
} from "@palm/db";
import { Hono } from "hono";
import { fail, type C, type Env } from "./http.ts";
import { PLAYS_EVERYWHERE, probeMp4, r2Reader, type Probe } from "./mp4.ts";

/**
 * PeerTube's remote runners: `peertube-runner` (PeerTube's own, with ffmpeg)
 * on a machine of your own registers here with PEERTUBE_RUNNER_TOKEN and
 * makes a video's renditions, so a free deployment gets them without paying
 * for transcoding. The runner calls out to palm, so nothing on that machine
 * needs to be reachable.
 *
 * palm asks for HLS renditions (a fragmented MP4 and its playlist per
 * resolution), which the PeerTube app needs to play a video, and a web-video
 * MP4 when the upload's codec doesn't play everywhere. palm writes the master
 * playlist itself. Each result comes back in one request, so it has to fit
 * Cloudflare's 100 MB request limit: resolutions likely to be larger aren't
 * asked for.
 */

/** PeerTube's usual bitrates (bits a second, at 30 fps), to guess a rendition's size. */
const BITRATES: Record<number, number> = { 240: 250_000, 360: 500_000, 480: 900_000, 720: 1_750_000, 1080: 3_300_000 };
const MAX_OUTPUT = 90 * 1024 * 1024;

const fits = (duration: number, resolution: number, fps: number) => (duration * BITRATES[resolution]! * (fps > 30 ? 1.5 : 1) * 1.1) / 8 < MAX_OUTPUT;
const fpsFor = (resolution: number, fps: number) => (resolution >= 720 ? fps : Math.min(fps, 30));

/**
 * The renditions worth making for an upload: HLS at each standard
 * resolution up to its own (PeerTube's resolution is the picture's shorter
 * side), and a web-video MP4 at its own when its codec doesn't play
 * everywhere. Only those that fit a request.
 */
export function renditionsFor(probe: Pick<Probe, "width" | "height" | "fps" | "duration"> | null, playsEverywhere: boolean): { type: RunnerJobType; resolution: number; fps: number }[] {
  if (!probe || !probe.height) return [];
  const source = Math.min(probe.width || probe.height, probe.height);
  const fps = probe.fps > 0 ? Math.min(probe.fps, 60) : 30;
  const standard = Object.keys(BITRATES).map(Number);
  const top = standard.filter((r) => r <= source).at(-1) ?? standard[0]!;
  const hls = standard.filter((r) => r <= top && fits(probe.duration, r, fpsFor(r, fps)));
  const jobs: { type: RunnerJobType; resolution: number; fps: number }[] = hls.map((resolution) => ({ type: "vod-hls-transcoding", resolution, fps: fpsFor(resolution, fps) }));
  if (!playsEverywhere && fits(probe.duration, top, fpsFor(top, fps))) jobs.push({ type: "vod-web-video-transcoding", resolution: top, fps: fpsFor(top, fps) });
  return jobs;
}

export async function queueRunnerJobs(db: D1Database, postId: number, probe: Pick<Probe, "width" | "height" | "fps" | "duration"> | null, playsEverywhere: boolean): Promise<void> {
  const jobs = renditionsFor(probe, playsEverywhere);
  if (!jobs.length) return;
  await addRunnerJobs(db, postId, jobs);
  await setTranscode(db, postId, { provider: "runner", startedAt: Math.floor(Date.now() / 1000) });
}

/** Queues HLS for local videos that have none: those uploaded before a runner was set up. The cron calls this. */
export async function backfillRunnerJobs(ctx: RequestContext): Promise<void> {
  if (!enabled(ctx)) return;
  const db = ctx.bindings.DB;
  for (const postId of await videosWithoutHls(db)) {
    const video = await videoByPostId(db, postId);
    const original = video?.files[video.files.length - 1];
    if (!video || !original) continue;
    await queueRunnerJobs(db, postId, { width: original.width ?? 0, height: original.height, fps: original.fps, duration: video.duration }, true);
  }
}

const enabled = (ctx: RequestContext) => typeof ctx.bindings.PEERTUBE_RUNNER_TOKEN === "string" && ctx.bindings.PEERTUBE_RUNNER_TOKEN.length >= 16;

function payloadFor(ctx: RequestContext, job: RunnerJob) {
  return {
    input: { videoFileUrl: `https://${ctx.domain.domain}/api/v1/runners/jobs/${job.uuid}/files/videos/${job.postId}/max-quality`, separatedAudioFileUrl: [] },
    output: { resolution: job.resolution, fps: job.fps, ...(job.type === "vod-hls-transcoding" ? { separatedAudio: false } : {}) },
  };
}

const jobView = (ctx: RequestContext, job: RunnerJob, jobToken?: string) => ({
  uuid: job.uuid,
  type: job.type,
  state: job.state === "processing" ? { id: 2, label: "Processing" } : { id: 1, label: "Pending" },
  payload: payloadFor(ctx, job),
  failures: job.failures,
  error: null,
  progress: job.progress,
  priority: 0,
  startedAt: null,
  createdAt: new Date(job.createdAt * 1000).toISOString(),
  updatedAt: new Date().toISOString(),
  finishedAt: null,
  parent: null,
  ...(jobToken ? { jobToken } : {}),
});

/** The runner's body: JSON, or a form (a finished job sends its file in one). */
async function body(request: Request): Promise<{ fields: Record<string, unknown>; files: Map<string, File> }> {
  const fields: Record<string, unknown> = {};
  const files = new Map<string, File>();
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("json")) Object.assign(fields, await request.json().catch(() => ({})));
  else if (type.includes("form")) {
    const form = await request.formData().catch(() => null);
    for (const [k, v] of form?.entries() ?? []) {
      if (typeof v === "string") fields[k] = v;
      else files.set(k, v as unknown as File);
    }
  }
  return { fields, files };
}

export const runnerRoutes = new Hono<Env>({ strict: false });

runnerRoutes.use("/api/v1/runners/*", async (c, next) => {
  if (!enabled(c.env)) return fail(c, 404, "This server has no remote runners.");
  await next();
});

runnerRoutes.post("/api/v1/runners/register", async (c) => {
  const { fields } = await body(c.req.raw);
  if (fields.registrationToken !== c.env.bindings.PEERTUBE_RUNNER_TOKEN) return fail(c, 404, "Registration token not found");
  const created = await registerRunner(c.env.bindings.DB, { name: String(fields.name ?? "runner"), description: typeof fields.description === "string" ? fields.description : null });
  console.log(JSON.stringify({ palm: "runner_registered", id: created.id, name: fields.name }));
  return c.json(created);
});

runnerRoutes.post("/api/v1/runners/unregister", async (c) => {
  const { fields } = await body(c.req.raw);
  const runner = await runnerByToken(c.env.bindings.DB, String(fields.runnerToken ?? ""));
  if (runner) await unregisterRunner(c.env.bindings.DB, runner.id);
  return c.body(null, 204);
});

runnerRoutes.post("/api/v1/runners/jobs/request", async (c) => {
  const { fields } = await body(c.req.raw);
  const db = c.env.bindings.DB;
  const runner = await runnerByToken(db, String(fields.runnerToken ?? ""));
  if (!runner) return fail(c, 404, "Unknown runner token");
  const types = Array.isArray(fields.jobTypes) ? fields.jobTypes.map(String) : null;
  const jobs = await availableRunnerJobs(db, 5, types ?? undefined);
  return c.json({ availableJobs: jobs.map((j) => ({ uuid: j.uuid, type: j.type, payload: payloadFor(c.env, j) })) });
});

runnerRoutes.post("/api/v1/runners/jobs/:uuid/accept", async (c) => {
  const { fields } = await body(c.req.raw);
  const db = c.env.bindings.DB;
  const runner = await runnerByToken(db, String(fields.runnerToken ?? ""));
  if (!runner) return fail(c, 404, "Unknown runner token");
  const accepted = await acceptRunnerJob(db, c.req.param("uuid"), runner.id);
  if (!accepted) return fail(c, 409, "This job is not in pending state anymore", "runner_job_not_in_pending_state");
  return c.json({ job: jobView(c.env, accepted.job, accepted.jobToken) });
});

/** A runner's own job, by its runner token and job token. */
async function held(c: C, fields: Record<string, unknown>) {
  const db = c.env.bindings.DB;
  const runner = await runnerByToken(db, String(fields.runnerToken ?? ""));
  if (!runner) return null;
  const job = await heldRunnerJob(db, c.req.param("uuid") ?? "", runner.id, String(fields.jobToken ?? ""));
  return job ? { runner, job } : null;
}

// The upload to transcode. The runner fetches it with POST and its tokens, as PeerTube serves it.
runnerRoutes.post("/api/v1/runners/jobs/:uuid/files/videos/:videoId/max-quality", async (c) => {
  const { fields } = await body(c.req.raw);
  const found = await held(c, fields);
  if (!found) return fail(c, 404, "Unknown job");
  const { mediaId } = await videoMediaIds(c.env.bindings.DB, found.job.postId);
  const object = mediaId ? await c.env.bindings.MEDIA?.get(`media/${mediaId}`) : null;
  if (!object) return fail(c, 404, "Video file not found");
  return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType ?? "video/mp4", "content-length": String(object.size) } });
});

runnerRoutes.post("/api/v1/runners/jobs/:uuid/update", async (c) => {
  const { fields } = await body(c.req.raw);
  const found = await held(c, fields);
  if (!found) return fail(c, 404, "Unknown job");
  const progress = Number(fields.progress);
  await runnerJobProgress(c.env.bindings.DB, found.job.uuid, Number.isFinite(progress) ? Math.round(progress) : null);
  return c.body(null, 204);
});

runnerRoutes.post("/api/v1/runners/jobs/:uuid/abort", async (c) => {
  const { fields } = await body(c.req.raw);
  const found = await held(c, fields);
  if (found) await finishRunnerJob(c.env.bindings.DB, found.job.uuid, "aborted");
  return c.body(null, 204);
});

runnerRoutes.post("/api/v1/runners/jobs/:uuid/error", async (c) => {
  const { fields } = await body(c.req.raw);
  const found = await held(c, fields);
  if (!found) return fail(c, 404, "Unknown job");
  await finishRunnerJob(c.env.bindings.DB, found.job.uuid, "errored", String(fields.message ?? ""));
  console.warn(JSON.stringify({ palm: "runner_job_failed", uuid: found.job.uuid, message: fields.message }));
  await settle(c.env, found.job.postId);
  return c.body(null, 204);
});

/** Keeps a runner's file in R2, as one of the person's uploads. */
async function keep(c: C, accountId: number, body: ReadableStream | ArrayBuffer | string, contentType: string, size: number): Promise<string> {
  const id = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await c.env.bindings.MEDIA!.put(`media/${id}`, body, { httpMetadata: { contentType } });
  await registerMedia(c.env.bindings.DB, { id, accountId, contentType, size, postId: null, token: randomToken(16) });
  return id;
}

/** A finished rendition: kept in R2, added to the video's files or its HLS playlist, and other servers told. */
runnerRoutes.post("/api/v1/runners/jobs/:uuid/success", async (c) => {
  const { fields, files } = await body(c.req.raw);
  const found = await held(c, fields);
  if (!found) return fail(c, 404, "Unknown job");
  const file = files.get("payload[videoFile]") ?? files.get("videoFile");
  const db = c.env.bindings.DB;
  const post = await postById(db, found.job.postId);
  const video = await videoByPostId(db, found.job.postId);
  const hls = found.job.type === "vod-hls-transcoding";
  const playlist = hls ? (files.get("payload[resolutionPlaylistFile]") ?? files.get("resolutionPlaylistFile")) : undefined;
  if (!file || !c.env.bindings.MEDIA || !post || !video || (hls && !playlist)) {
    await finishRunnerJob(db, found.job.uuid, "errored", "The result was missing a file");
    return fail(c, 400, "A video file is needed");
  }
  // PeerTube's resolution is the picture's shorter side.
  const ratio = video.aspectRatio ?? 16 / 9;
  const even = (n: number) => Math.round(n / 2) * 2;
  const [width, height] = ratio >= 1 ? [even(found.job.resolution * ratio), found.job.resolution] : [found.job.resolution, even(found.job.resolution / ratio)];
  if (hls) {
    const fileId = await keep(c, post.accountId, file.stream(), "video/mp4", file.size);
    const fileUrl = urls.media(c.env.domain.domain, `${fileId}.mp4`);
    // The rendition's playlist names its file by the runner's own name; palm serves it from R2.
    const text = (await playlist!.text()).replaceAll(file.name, fileUrl);
    const playlistId = await keep(c, post.accountId, text, "application/vnd.apple.mpegurl", text.length);
    const playlistUrl = urls.media(c.env.domain.domain, `${playlistId}.m3u8`);
    const before = (await videoByPostId(db, post.id))?.hls?.files ?? [];
    // Listed by resolution, as PeerTube lists HLS files.
    const renditions = [...before.filter((f) => f.height !== found.job.resolution), { url: fileUrl, mediaType: "video/mp4", height: found.job.resolution, width: null, size: file.size, fps: found.job.fps, playlistUrl }];
    await updateVideo(db, post.id, {
      hls: { url: masterUrl(c.env, video.uuid), segmentsSha256Url: null, files: renditions.sort((a, b) => b.height - a.height) },
    });
  } else {
    // An H.264 copy of an upload that doesn't play everywhere (HEVC, WebM,
    // MKV...): it takes the upload's place, under the same ID, so every link
    // to it (a status's attachment, a Lemmy post's link) plays the copy.
    const { mediaId } = await videoMediaIds(db, post.id);
    if (!mediaId) {
      await finishRunnerJob(db, found.job.uuid, "errored", "The video has no upload to replace");
      return fail(c, 400, "The video has no upload to replace");
    }
    const before = await mediaById(db, mediaId);
    await replaceMediaFile(db, c.env.bindings.MEDIA, mediaId, file.stream(), "video/mp4", file.size);
    const fileUrl = urls.media(c.env.domain.domain, `${mediaId}.mp4`);
    await updateVideo(db, post.id, { files: [{ url: fileUrl, mediaType: "video/mp4", height, width, size: file.size, fps: found.job.fps }] });
    // A Lemmy post links to its upload by name, which now ends in .mp4.
    if (before && post.linkUrl?.endsWith(`/${before.file}`)) await db.prepare("UPDATE posts SET link_url = ? WHERE id = ?").bind(fileUrl, post.id).run();
  }
  await finishRunnerJob(db, found.job.uuid, "completed");
  await settle(c.env, post.id);
  return c.body(null, 204);
});

/** Where a local video's master playlist is served: palm writes it from the renditions it has. */
export const masterUrl = (ctx: RequestContext, uuid: string) => `https://${ctx.domain.domain}/static/streaming-playlists/hls/${uuid}/master.m3u8`;

/** A local video's HLS master playlist, listing each rendition the runners made. */
export function masterPlaylist(video: Video): string | null {
  const renditions = video.hls?.files.filter((f) => f.playlistUrl) ?? [];
  if (!renditions.length) return null;
  const lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-INDEPENDENT-SEGMENTS"];
  const ratio = video.aspectRatio ?? 16 / 9;
  const even = (n: number) => Math.round(n / 2) * 2;
  for (const f of [...renditions].sort((a, b) => a.height - b.height)) {
    const bandwidth = video.duration > 0 ? Math.round(((f.size * 8) / video.duration) * 1.2) : 1_000_000;
    // f.height is PeerTube's resolution, the shorter side.
    const [w, h] = ratio >= 1 ? [even(f.height * ratio), f.height] : [f.height, even(f.height / ratio)];
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${w}x${h}${f.fps > 0 ? `,FRAME-RATE=${f.fps.toFixed(3)}` : ""}`, f.playlistUrl!);
  }
  return `${lines.join("\n")}\n`;
}

/** Once a video's last job is done, other servers hear about its new files. */
async function settle(ctx: RequestContext, postId: number): Promise<void> {
  if ((await runnerJobsLeft(ctx.bindings.DB, postId)) > 0) return;
  await setTranscode(ctx.bindings.DB, postId, null);
  // A PeerTube upload federates as PeerTube's Video; anything else as the post it was, now with its new file.
  const post = await postById(ctx.bindings.DB, postId);
  if (post?.client === "peertube") ctx.activities.enqueue({ kind: "video_published", postId, update: true });
  else if (post) ctx.activities.enqueue({ kind: "post_updated", postId });
}

/**
 * Videos posted from Lemmy, Mastodon and Pixelfed apps, handed to the runner
 * too: HLS for PeerTube apps, and an H.264 copy in place of an upload that
 * doesn't play everywhere. The cron calls this; a few posts a run.
 */
export async function queueAttachmentTranscodes(ctx: RequestContext): Promise<void> {
  if (!enabled(ctx) || !ctx.bindings.MEDIA) return;
  const db = ctx.bindings.DB;
  for (const media of await untranscodedVideoMedia(db)) {
    const post = media.postId !== null ? await postById(db, media.postId) : null;
    if (!post) continue;
    const readable = media.contentType === "video/mp4" || media.contentType === "video/quicktime" || media.contentType === "video/x-m4v";
    const probe = readable ? await probeMp4(r2Reader(ctx.bindings.MEDIA, `media/${media.id}`), media.size) : null;
    const playsEverywhere = media.contentType === "video/mp4" && PLAYS_EVERYWHERE.has(probe?.videoCodec ?? "");
    await saveVideo(db, {
      postId: post.id,
      uuid: crypto.randomUUID(),
      // A Lemmy post's community is its channel; a status has none (its person stands in).
      channelId: post.communityId,
      duration: Math.round(probe?.duration ?? 0),
      views: 0,
      likes: 0,
      dislikes: 0,
      state: 1,
      isLive: false,
      category: null,
      licence: null,
      language: post.language,
      aspectRatio: probe?.width && probe.height ? Math.round((probe.width / probe.height) * 10000) / 10000 : null,
      thumbnails: [],
      files: [{ url: urls.media(ctx.domain.domain, media.file), mediaType: media.contentType, height: probe?.height ?? 0, width: probe?.width ?? null, size: media.size, fps: probe?.fps ?? -1 }],
      hls: null,
      embedUrl: null,
      commentsEnabled: true,
      downloadEnabled: true,
      support: null,
      originallyPublishedAt: null,
    });
    await setVideoMedia(db, post.id, { mediaId: media.id });
    // A file palm can't read (WebM, MKV...) is assumed 720p: the runner reads it properly.
    await queueRunnerJobs(db, post.id, probe ?? { width: 1280, height: 720, fps: 30, duration: 0 }, playsEverywhere);
  }
}

/**
 * The runner's socket.io connection, enough of it to tell runners there's
 * work: palm speaks Engine.IO 4 over a WebSocket, answers the /runners
 * namespace's connect, and says "available-jobs" when there are some. It
 * sends no pings, so the runner reconnects every 45 seconds or so, and each
 * reconnect is a fresh look at the queue: polling, without a Durable Object.
 */
export async function runnerSocket(request: Request, ctx: RequestContext): Promise<Response> {
  if (!enabled(ctx) || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Not found", { status: 404 });
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  server.accept();
  server.send(`0${JSON.stringify({ sid: randomToken(10), upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 })}`);
  server.addEventListener("message", (event) => {
    const data = typeof event.data === "string" ? event.data : "";
    if (data === "2") return server.send("3");
    // Other namespaces (the app's /user-notifications) are refused, so its client stops trying.
    const other = /^40(\/[^,]*)?,?/.exec(data);
    if (other && other[1] !== "/runners") return server.send(`44${other[1] ?? ""},${JSON.stringify({ message: "Not supported" })}`);
    const connect = /^40\/runners,(.*)$/.exec(data);
    if (!connect) return;
    ctx.waitUntil(
      (async () => {
        let token = "";
        try {
          token = String((JSON.parse(connect[1] || "{}") as { runnerToken?: string }).runnerToken ?? "");
        } catch {
          // No token: refused below.
        }
        const runner = await runnerByToken(ctx.bindings.DB, token);
        if (!runner) {
          server.send(`44/runners,${JSON.stringify({ message: "Not authorized" })}`);
          return;
        }
        server.send(`40/runners,${JSON.stringify({ sid: randomToken(10) })}`);
        if (await hasAvailableRunnerJobs(ctx.bindings.DB)) server.send(`42/runners,${JSON.stringify(["available-jobs"])}`);
      })().catch(() => undefined),
    );
  });
  return new Response(null, { status: 101, webSocket: client });
}
