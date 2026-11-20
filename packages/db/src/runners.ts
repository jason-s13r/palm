import { randomToken, sha256Hex } from "@palm/auth";

const now = () => Math.floor(Date.now() / 1000);

/** A machine running PeerTube's `peertube-runner`, registered here to make renditions of videos. */
export interface Runner {
  id: number;
  name: string;
  description: string | null;
  lastContact: number | null;
  createdAt: number;
}

export async function registerRunner(db: D1Database, runner: { name: string; description: string | null }): Promise<{ id: number; runnerToken: string }> {
  const runnerToken = `ptrt-${randomToken(24)}`;
  const row = await db
    .prepare("INSERT INTO runners (token_hash, name, description, created_at) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(await sha256Hex(runnerToken), runner.name.slice(0, 100), runner.description?.slice(0, 500) ?? null, now())
    .first<{ id: number }>();
  return { id: row!.id, runnerToken };
}

export async function runnerByToken(db: D1Database, runnerToken: string): Promise<Runner | null> {
  if (!runnerToken) return null;
  const row = await db
    .prepare("UPDATE runners SET last_contact = ? WHERE token_hash = ? RETURNING id, name, description, last_contact, created_at")
    .bind(now(), await sha256Hex(runnerToken))
    .first<{ id: number; name: string; description: string | null; last_contact: number | null; created_at: number }>();
  return row ? { id: row.id, name: row.name, description: row.description, lastContact: row.last_contact, createdAt: row.created_at } : null;
}

export async function unregisterRunner(db: D1Database, id: number): Promise<void> {
  await db.batch([
    db.prepare("UPDATE runner_jobs SET state = 'pending', runner_id = NULL, job_token_hash = NULL, updated_at = ? WHERE runner_id = ? AND state = 'processing'").bind(now(), id),
    db.prepare("DELETE FROM runners WHERE id = ?").bind(id),
  ]);
}

/** One rendition for a runner to make: PeerTube's vod-web-video-transcoding job. */
export interface RunnerJob {
  uuid: string;
  postId: number;
  type: string;
  resolution: number;
  fps: number;
  state: "pending" | "processing" | "completed" | "errored";
  runnerId: number | null;
  progress: number | null;
  failures: number;
  createdAt: number;
}

interface JobRow {
  uuid: string;
  post_id: number;
  type: string;
  resolution: number;
  fps: number;
  state: RunnerJob["state"];
  runner_id: number | null;
  progress: number | null;
  failures: number;
  created_at: number;
}

const toJob = (r: JobRow): RunnerJob => ({
  uuid: r.uuid,
  postId: r.post_id,
  type: r.type,
  resolution: r.resolution,
  fps: r.fps,
  state: r.state,
  runnerId: r.runner_id,
  progress: r.progress,
  failures: r.failures,
  createdAt: r.created_at,
});

export type RunnerJobType = "vod-web-video-transcoding" | "vod-hls-transcoding";

export async function addRunnerJobs(db: D1Database, postId: number, jobs: { type: RunnerJobType; resolution: number; fps: number }[]): Promise<void> {
  if (!jobs.length) return;
  const at = now();
  await db.batch(
    jobs.map((j) =>
      db
        .prepare("INSERT INTO runner_jobs (uuid, post_id, type, resolution, fps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), postId, j.type, j.resolution, j.fps, at, at),
    ),
  );
}

/** Jobs waiting for a runner (of the types it takes), and any a runner took and went quiet on for an hour. */
export async function availableRunnerJobs(db: D1Database, limit = 5, types?: string[]): Promise<RunnerJob[]> {
  const only = types?.length ? `AND type IN (${types.map(() => "?").join(", ")})` : "";
  const { results } = await db
    .prepare(
      `SELECT * FROM runner_jobs WHERE (state = 'pending' OR (state = 'processing' AND updated_at < ?)) ${only}
       ORDER BY created_at LIMIT ?`,
    )
    .bind(now() - 3600, ...(types?.length ? types : []), limit)
    .all<JobRow>();
  return results.map(toJob);
}

export async function hasAvailableRunnerJobs(db: D1Database): Promise<boolean> {
  return (await availableRunnerJobs(db, 1)).length > 0;
}

/** Hands a job to a runner: its job token proves it's theirs. Null if another runner took it first. */
export async function acceptRunnerJob(db: D1Database, uuid: string, runnerId: number): Promise<{ job: RunnerJob; jobToken: string } | null> {
  const jobToken = `ptrj-${randomToken(24)}`;
  const row = await db
    .prepare(
      `UPDATE runner_jobs SET state = 'processing', runner_id = ?, job_token_hash = ?, progress = 0, updated_at = ?
       WHERE uuid = ? AND (state = 'pending' OR (state = 'processing' AND updated_at < ?)) RETURNING *`,
    )
    .bind(runnerId, await sha256Hex(jobToken), now(), uuid, now() - 3600)
    .first<JobRow>();
  return row ? { job: toJob(row), jobToken } : null;
}

/** A job the given runner holds, by its job token. */
export async function heldRunnerJob(db: D1Database, uuid: string, runnerId: number, jobToken: string): Promise<RunnerJob | null> {
  const row = await db
    .prepare("SELECT * FROM runner_jobs WHERE uuid = ? AND runner_id = ? AND job_token_hash = ? AND state = 'processing'")
    .bind(uuid, runnerId, await sha256Hex(jobToken ?? ""))
    .first<JobRow>();
  return row ? toJob(row) : null;
}

export async function runnerJobProgress(db: D1Database, uuid: string, progress: number | null): Promise<void> {
  await db.prepare("UPDATE runner_jobs SET progress = ?, updated_at = ? WHERE uuid = ?").bind(progress, now(), uuid).run();
}

/** A job finished, gave up (back to the queue, three tries), or was abandoned. */
export async function finishRunnerJob(db: D1Database, uuid: string, outcome: "completed" | "errored" | "aborted", error?: string): Promise<void> {
  if (outcome === "completed") {
    await db.prepare("UPDATE runner_jobs SET state = 'completed', progress = 100, updated_at = ? WHERE uuid = ?").bind(now(), uuid).run();
  } else if (outcome === "aborted") {
    await db.prepare("UPDATE runner_jobs SET state = 'pending', runner_id = NULL, job_token_hash = NULL, updated_at = ? WHERE uuid = ?").bind(now(), uuid).run();
  } else {
    await db
      .prepare(
        `UPDATE runner_jobs SET failures = failures + 1, error = ?, runner_id = NULL, job_token_hash = NULL, updated_at = ?,
           state = CASE WHEN failures + 1 >= 3 THEN 'errored' ELSE 'pending' END WHERE uuid = ?`,
      )
      .bind(error?.slice(0, 500) ?? null, now(), uuid)
      .run();
  }
}

/** Whether a video still has renditions to come. */
export async function runnerJobsLeft(db: D1Database, postId: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM runner_jobs WHERE post_id = ? AND state IN ('pending', 'processing')")
    .bind(postId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Local videos with no HLS playlist and nothing being made for them: uploads
 * from before a runner was set up. A few at a time.
 */
export async function videosWithoutHls(db: D1Database, limit = 3): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT v.post_id FROM videos v JOIN posts p ON p.id = v.post_id
       WHERE p.ap_id IS NULL AND p.deleted_at IS NULL AND v.hls IS NULL AND v.transcode IS NULL AND v.media_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM runner_jobs j WHERE j.post_id = v.post_id AND j.type = 'vod-hls-transcoding')
       ORDER BY v.post_id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<{ post_id: number }>();
  return results.map((r) => r.post_id);
}
