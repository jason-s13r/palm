import type { RequestContext } from "@palm/core";
import { deleteUpload, pendingTranscodes, setTranscode, staleUploads, updateVideo, videoByPostId } from "@palm/db";

/**
 * The cron's video work: Cloudflare Stream's renditions, when they're ready,
 * become the video's HLS playlist and an H.264 MP4; uploads left unfinished
 * for a day are thrown away.
 */
export async function videoMaintenance(ctx: RequestContext): Promise<void> {
  const db = ctx.bindings.DB;
  for (const upload of await staleUploads(db)) {
    await ctx.bindings.MEDIA?.resumeMultipartUpload(`media/${upload.mediaId}`, upload.r2UploadId).abort().catch(() => undefined);
    await deleteUpload(db, upload.id);
  }
  const stream = ctx.bindings.STREAM;
  if (!stream) return;
  for (const { postId, transcode } of await pendingTranscodes(db, "stream", 5)) {
    if (!transcode.id) continue;
    try {
      const handle = stream.video(transcode.id);
      const video = await videoByPostId(db, postId);
      if (!video) {
        await setTranscode(db, postId, null);
        continue;
      }
      if (transcode.status === "processing") {
        const details = await handle.details();
        if (details.status?.state === "error") {
          console.warn(JSON.stringify({ palm: "stream_failed", postId, id: transcode.id }));
          await setTranscode(db, postId, null);
          continue;
        }
        if (!details.readyToStream) continue;
        await updateVideo(db, postId, {
          hls: details.playback?.hls ? { url: details.playback.hls, segmentsSha256Url: null, files: [] } : null,
          // Stream's own thumbnail when palm has none.
          ...(video.thumbnails.length === 0 && details.thumbnail ? { thumbnails: [{ url: details.thumbnail, width: details.input?.width ?? 1280, height: details.input?.height ?? 720 }] } : {}),
        });
        // An H.264 MP4 of the best rendition: what other servers and older players can play.
        await handle.downloads.create("default").catch(() => undefined);
        await setTranscode(db, postId, { ...transcode, status: "downloading" });
        ctx.activities.enqueue({ kind: "video_published", postId, update: true });
        continue;
      }
      if (transcode.status === "downloading") {
        const downloads = (await handle.downloads.get()) as Record<string, { status?: string; url?: string } | undefined>;
        const mp4 = downloads.default;
        if (mp4?.status !== "ready" || !mp4.url) {
          // Given an hour; then the HLS playlist will do.
          if (Date.now() / 1000 - transcode.startedAt > 3600) await setTranscode(db, postId, null);
          continue;
        }
        const details = await handle.details();
        const height = details.input?.height ?? 0;
        const width = details.input?.width ?? null;
        const shorter = width ? Math.min(width, height) : height;
        await updateVideo(db, postId, {
          files: [...video.files.filter((f) => f.url !== mp4.url), { url: mp4.url, mediaType: "video/mp4", height: shorter || height, width, size: 0, fps: -1 }],
        });
        await setTranscode(db, postId, null);
        ctx.activities.enqueue({ kind: "video_published", postId, update: true });
      }
    } catch (error) {
      console.warn(JSON.stringify({ palm: "stream_poll_failed", postId, error: String(error) }));
    }
  }
}
