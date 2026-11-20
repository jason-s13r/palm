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
  type RunnerJob,
} from "@palm/db";
import { Hono } from "hono";
import { fail, type C, type Env } from "./http.ts";
import type { Probe } from "./mp4.ts";

/**
 * PeerTube's remote runners: `peertube-runner` (PeerTube's own, with ffmpeg)
 * on a machine of your own registers here with PEERTUBE_RUNNER_TOKEN and
 * makes a video's renditions, so a free deployment gets them without paying
 * for transcoding. The runner calls out to palm, so nothing on that machine
 * needs to be reachable.
 *
 * palm asks for web-video renditions (one H.264 MP4 per resolution), the
 * simplest of PeerTube's job types. Each comes back in one request, so it has
 * to fit Cloudflare's 100 MB request limit: resolutions likely to be larger
 * aren't asked for.
 */

/** PeerTube's usual bitrates (bits a second, at 30 fps), to guess a rendition's size. */
const BITRATES: Record<number, number> = { 240: 250_000, 360: 500_000, 480: 900_000, 720: 1_750_000, 1080: 3_300_000 };
const MAX_OUTPUT = 90 * 1024 * 1024;

/** The renditions worth making for an upload: each standard height up to its own, that fits a request. */
export function renditionsFor(probe: Probe | null, playsEverywhere: boolean): { resolution: number; fps: number }[] {
  if (!probe || !probe.height) return [];
  const sourceHeight = Math.min(probe.width, probe.height) || probe.height;
  const fps = probe.fps > 0 ? Math.min(probe.fps, 60) : 30;
  return Object.keys(BITRATES)
    .map(Number)
    .filter((r) => r < sourceHeight || (!playsEverywhere && r <= sourceHeight))
    .filter((r) => (probe.duration * BITRATES[r]! * (fps > 30 ? 1.5 : 1) * 1.1) / 8 < MAX_OUTPUT)
    .map((resolution) => ({ resolution, fps: resolution >= 720 ? fps : Math.min(fps, 30) }));
}

export async function queueRunnerJobs(db: D1Database, postId: number, probe: Probe | null, playsEverywhere: boolean): Promise<void> {
  const jobs = renditionsFor(probe, playsEverywhere);
  if (!jobs.length) return;
  await addRunnerJobs(db, postId, jobs);
  await setTranscode(db, postId, { provider: "runner", startedAt: Math.floor(Date.now() / 1000) });
}

const enabled = (ctx: RequestContext) => typeof ctx.bindings.PEERTUBE_RUNNER_TOKEN === "string" && ctx.bindings.PEERTUBE_RUNNER_TOKEN.length >= 16;

function payloadFor(ctx: RequestContext, job: RunnerJob) {
  return {
    input: { videoFileUrl: `https://${ctx.domain.domain}/api/v1/runners/jobs/${job.uuid}/files/videos/${job.postId}/max-quality`, separatedAudioFileUrl: [] },
    output: { resolution: job.resolution, fps: job.fps },
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
  const jobs = types && !types.includes("vod-web-video-transcoding") ? [] : await availableRunnerJobs(db);
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

/** A finished rendition: kept in R2 and added to the video's files, and other servers told. */
runnerRoutes.post("/api/v1/runners/jobs/:uuid/success", async (c) => {
  const { fields, files } = await body(c.req.raw);
  const found = await held(c, fields);
  if (!found) return fail(c, 404, "Unknown job");
  const file = files.get("payload[videoFile]") ?? files.get("videoFile") ?? [...files.values()][0];
  const db = c.env.bindings.DB;
  const bucket = c.env.bindings.MEDIA;
  const post = await postById(db, found.job.postId);
  const video = await videoByPostId(db, found.job.postId);
  if (!file || !bucket || !post || !video) {
    await finishRunnerJob(db, found.job.uuid, "errored", "No video file in the result");
    return fail(c, 400, "A video file is needed");
  }
  const id = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await bucket.put(`media/${id}`, file.stream(), { httpMetadata: { contentType: "video/mp4" } });
  await registerMedia(db, { id, accountId: post.accountId, contentType: "video/mp4", size: file.size, postId: null, token: randomToken(16) });
  // PeerTube's resolution is the picture's shorter side.
  const ratio = video.aspectRatio ?? 16 / 9;
  const even = (n: number) => Math.round(n / 2) * 2;
  const [width, height] = ratio >= 1 ? [even(found.job.resolution * ratio), found.job.resolution] : [found.job.resolution, even(found.job.resolution / ratio)];
  // The original upload stays; an earlier rendition at this height is replaced.
  const { mediaId } = await videoMediaIds(db, post.id);
  const kept = video.files.filter((f) => f.height !== height || (mediaId !== null && f.url.includes(`/${mediaId}.`)));
  const files2 = [...kept, { url: urls.media(c.env.domain.domain, `${id}.mp4`), mediaType: "video/mp4", height, width, size: file.size, fps: found.job.fps }];
  await updateVideo(db, post.id, { files: files2.sort((a, b) => b.height - a.height) });
  await finishRunnerJob(db, found.job.uuid, "completed");
  await settle(c.env, post.id);
  return c.body(null, 204);
});

/** Once a video's last job is done, other servers hear about its new files. */
async function settle(ctx: RequestContext, postId: number): Promise<void> {
  if ((await runnerJobsLeft(ctx.bindings.DB, postId)) > 0) return;
  await setTranscode(ctx.bindings.DB, postId, null);
  ctx.activities.enqueue({ kind: "video_published", postId, update: true });
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
