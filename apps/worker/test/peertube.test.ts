import { isPeerTubePath } from "@palm/adapter-peertube";
import { parseMoov } from "../../../packages/adapter-peertube/src/mp4.ts";
import { renditionsFor } from "../../../packages/adapter-peertube/src/runner.ts";
import { fromShortUuid, toShortUuid } from "../../../packages/adapter-peertube/src/short-uuid.ts";
import { parseDuration, videoFromJson } from "../../../packages/federation/src/video-json.ts";
import { saveVideo, subscribe, migrate } from "@palm/db";
import { describe, expect, it } from "vitest";
import { createAccount, db, giveKeys, MASTODON, mastodonToken, worker } from "./helpers.ts";

// What PeerTube apps send, on the bare domain they sign in to.
const SITE = "https://palm.test";
const AP = { accept: "application/activity+json" };

/** PeerTube's sign-in: the local client, then a password grant. */
async function signIn(username: string, password: string) {
  const client = await (await worker.fetch(`${SITE}/api/v1/oauth-clients/local`)).json<{ client_id: string; client_secret: string }>();
  const form = new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, grant_type: "password", response_type: "code", username, password });
  const res = await worker.fetch(`${SITE}/api/v1/users/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
  expect(res.status).toBe(200);
  const token = await res.json<{ access_token: string; refresh_token: string; token_type: string }>();
  const auth = { authorization: `Bearer ${token.access_token}` };
  const get = async <T = Record<string, unknown>>(path: string) => {
    const r = await worker.fetch(`${SITE}${path}`, { headers: auth });
    expect(r.status, path).toBe(200);
    return r.json<T>();
  };
  const send = (method: string, path: string, body?: unknown) =>
    worker.fetch(`${SITE}${path}`, { method, headers: { ...auth, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { client, token, auth, get, send };
}

/** A remote PeerTube channel, its person and one video, as federation would have stored them. */
async function remoteVideo(uuid: string, opts: { channel?: string; title?: string } = {}) {
  await migrate(db);
  const host = "tube.example";
  const person = await db
    .prepare(
      `INSERT INTO accounts (domain, username, display_name, role, created_at, ap_id, inbox, fetched_at) VALUES (?, 'alice', 'Alice', 'user', 0, ?, ?, 0)
       ON CONFLICT DO UPDATE SET display_name = excluded.display_name RETURNING id`,
    )
    .bind(host, `https://${host}/accounts/alice`, `https://${host}/accounts/alice/inbox`)
    .first<{ id: number }>();
  const channelName = opts.channel ?? "alice_channel";
  const channel = await db
    .prepare(
      `INSERT INTO communities (domain, name, title, created_at, ap_id, inbox) VALUES (?, ?, 'Alice makes things', 0, ?, ?)
       ON CONFLICT DO UPDATE SET title = excluded.title RETURNING id`,
    )
    .bind(host, channelName, `https://${host}/video-channels/${channelName}`, `https://${host}/video-channels/${channelName}/inbox`)
    .first<{ id: number }>();
  const post = await db
    .prepare(
      `INSERT INTO posts (account_id, content_source, content_html, spoiler_text, sensitive, visibility, community_id, title, created_at, ap_id, url, link_url)
       VALUES (?, 'A description', '<p>A description</p>', '', 0, 'public', ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(person!.id, channel!.id, opts.title ?? "A video", Math.floor(Date.now() / 1000), `https://${host}/videos/watch/${uuid}`, `https://${host}/w/x`, `https://${host}/w/x`)
    .first<{ id: number }>();
  await saveVideo(db, {
    postId: post!.id,
    uuid,
    channelId: channel!.id,
    duration: 125,
    views: 42,
    likes: 3,
    dislikes: 0,
    state: 1,
    isLive: false,
    category: 15,
    licence: 1,
    language: "en",
    aspectRatio: 1.7778,
    thumbnails: [{ url: `https://${host}/lazy-static/thumbnails/${uuid}.jpg`, width: 280, height: 157 }],
    files: [{ url: `https://${host}/static/web-videos/${uuid}-720.mp4`, mediaType: "video/mp4", height: 720, width: 1280, size: 12_345_678, fps: 30 }],
    hls: { url: `https://${host}/static/streaming-playlists/hls/${uuid}/master.m3u8`, segmentsSha256Url: `https://${host}/sha.json`, files: [] },
    embedUrl: null,
    commentsEnabled: true,
    downloadEnabled: true,
    support: null,
    originallyPublishedAt: null,
  });
  return { personId: person!.id, channelId: channel!.id, postId: post!.id, host, channelName };
}

/** A tiny MP4's moov box: 5 seconds, 1280×720 H.264 at 30 fps, with AAC sound. */
function moov(opts: { rotate?: boolean } = {}): Uint8Array {
  const box = (type: string, ...parts: Uint8Array[]) => {
    const size = 8 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size);
    out.set(new TextEncoder().encode(type), 4);
    let at = 8;
    for (const p of parts) (out.set(p, at), (at += p.length));
    return out;
  };
  const bytes = (n: number, fill: (v: DataView) => void) => {
    const b = new Uint8Array(n);
    fill(new DataView(b.buffer));
    return b;
  };
  const mvhd = box("mvhd", bytes(100, (v) => (v.setUint32(12, 1000), v.setUint32(16, 5000))));
  const tkhd = box(
    "tkhd",
    bytes(84, (v) => {
      v.setInt32(40, opts.rotate ? 0 : 0x10000);
      v.setInt32(44, opts.rotate ? 0x10000 : 0);
      v.setUint32(76, 1280 << 16);
      v.setUint32(80, 720 << 16);
    }),
  );
  const hdlr = (kind: string) => box("hdlr", bytes(24, (v) => [...kind].forEach((ch, i) => v.setUint8(8 + i, ch.charCodeAt(0)))));
  const stsd = (format: string) => box("stsd", bytes(16, (v) => (v.setUint32(4, 1), v.setUint32(8, 8), [...format].forEach((ch, i) => v.setUint8(12 + i, ch.charCodeAt(0))))));
  const stts = box("stts", bytes(16, (v) => (v.setUint32(4, 1), v.setUint32(8, 150), v.setUint32(12, 1000))));
  const mdhd = box("mdhd", bytes(24, (v) => v.setUint32(12, 30000)));
  const video = box("trak", tkhd, box("mdia", mdhd, hdlr("vide"), box("minf", box("stbl", stsd("avc1"), stts))));
  const audio = box("trak", box("mdia", hdlr("soun"), box("minf", box("stbl", stsd("mp4a")))));
  return box("moov", mvhd, video, audio);
}

function mp4File(extra = 0): Uint8Array {
  const ftyp = new Uint8Array([0, 0, 0, 16, ...new TextEncoder().encode("ftypisom"), 0, 0, 2, 0]);
  const m = moov();
  const mdat = new Uint8Array(8 + extra);
  new DataView(mdat.buffer).setUint32(0, mdat.length);
  mdat.set(new TextEncoder().encode("mdat"), 4);
  const out = new Uint8Array(ftyp.length + m.length + mdat.length);
  out.set(ftyp, 0);
  out.set(m, ftyp.length);
  out.set(mdat, ftyp.length + m.length);
  return out;
}

describe("PeerTube: pieces", () => {
  it("tells PeerTube's paths from Mastodon's", () => {
    expect(isPeerTubePath("/api/v1/videos/12")).toBe(true);
    expect(isPeerTubePath("/api/v1/users/me/subscriptions/videos")).toBe(true);
    expect(isPeerTubePath("/api/v1/search/videos")).toBe(true);
    expect(isPeerTubePath("/api/v1/accounts/alice@tube.example/videos")).toBe(true);
    expect(isPeerTubePath("/api/v1/accounts/12/statuses")).toBe(false);
    expect(isPeerTubePath("/api/v1/accounts/verify_credentials")).toBe(false);
    expect(isPeerTubePath("/api/v1/search")).toBe(false);
    expect(isPeerTubePath("/api/v1/statuses")).toBe(false);
  });

  it("writes and reads short UUIDs as PeerTube does", () => {
    const uuid = "9c9de5e8-0a1e-484a-b099-e80766180a6d";
    const short = toShortUuid(uuid);
    expect(short).toHaveLength(22);
    expect(fromShortUuid(short)).toBe(uuid);
    expect(toShortUuid("00000000-0000-0000-0000-000000000001")).toBe("1111111111111111111112");
  });

  it("reads a PeerTube Video's files, playlist and thumbnail", () => {
    const video = videoFromJson(
      {
        type: "Video",
        uuid: "9C9DE5E8-0a1e-484a-b099-e80766180a6d",
        duration: "PT1H2M3S",
        views: 7,
        state: 1,
        category: { identifier: "15", name: "Science & Technology" },
        language: { identifier: "en", name: "English" },
        commentsPolicy: 1,
        icon: [
          { type: "Image", url: "https://tube.example/big.jpg", width: 850, height: 480, mediaType: "image/jpeg" },
          { type: "Image", url: "https://tube.example/small.jpg", width: 280, height: 157, mediaType: "image/jpeg" },
        ],
        url: [
          { type: "Link", mediaType: "text/html", href: "https://tube.example/w/abc" },
          { type: "Link", mediaType: "video/mp4", href: "https://tube.example/480.mp4", height: 480, width: 854, size: 1000, fps: 30 },
          { type: "Link", mediaType: "video/mp4", href: "https://tube.example/720.mp4", height: 720, width: 1280, size: 2000, fps: 30 },
          {
            type: "Link",
            mediaType: "application/x-mpegURL",
            href: "https://tube.example/master.m3u8",
            tag: [
              { type: "Link", name: "sha256", mediaType: "application/json", href: "https://tube.example/sha.json" },
              { type: "Link", mediaType: "video/mp4", href: "https://tube.example/hls-720.mp4", height: 720, size: 1900, fps: 30 },
            ],
          },
        ],
      },
      5,
      9,
    );
    expect(video).toMatchObject({ postId: 5, channelId: 9, uuid: "9c9de5e8-0a1e-484a-b099-e80766180a6d", duration: 3723, views: 7, category: 15, language: "en", commentsEnabled: true });
    expect(video!.files.map((f) => f.height)).toEqual([720, 480]);
    expect(video!.hls).toMatchObject({ url: "https://tube.example/master.m3u8", segmentsSha256Url: "https://tube.example/sha.json" });
    expect(video!.hls!.files).toHaveLength(1);
    expect(video!.thumbnails.at(-1)!.url).toBe("https://tube.example/big.jpg");
    expect(parseDuration("PT45S")).toBe(45);
  });

  it("reads an MP4's length, size, frame rate and codecs from its moov", () => {
    expect(parseMoov(moov().subarray(8))).toEqual({ duration: 5, width: 1280, height: 720, fps: 30, videoCodec: "avc1", audioCodec: "mp4a" });
    // A phone's portrait clip is stored on its side.
    expect(parseMoov(moov({ rotate: true }).subarray(8))).toMatchObject({ width: 720, height: 1280 });
  });

  it("asks runners for HLS up to the upload's own resolution, only what fits a request", () => {
    const jobs = (p: { duration: number; width: number; height: number; fps: number }, everywhere = true) => renditionsFor(p, everywhere).map((r) => `${r.type === "vod-hls-transcoding" ? "hls" : "mp4"}${r.resolution}`);
    expect(jobs({ duration: 60, width: 1920, height: 1080, fps: 30 })).toEqual(["hls240", "hls360", "hls480", "hls720", "hls1080"]);
    // A portrait phone clip: its resolution is its shorter side.
    expect(jobs({ duration: 8, width: 720, height: 1280, fps: 30 })).toEqual(["hls240", "hls360", "hls480", "hls720"]);
    // HEVC from a phone: an MP4 that plays everywhere too.
    expect(jobs({ duration: 60, width: 1280, height: 720, fps: 30 }, false)).toContain("mp4720");
    // Twenty minutes: only what fits in 100 MB. An hour: nothing does.
    expect(jobs({ duration: 1200, width: 1280, height: 720, fps: 30 })).toEqual(["hls240", "hls360"]);
    expect(jobs({ duration: 3600, width: 1280, height: 720, fps: 30 })).toEqual([]);
  });
});

describe("PeerTube: the app's API", () => {
  it("answers as a PeerTube server, and signs in with a password", async () => {
    const config = await (await worker.fetch(`${SITE}/api/v1/config`)).json<{ serverVersion: string; signup: { allowed: boolean }; user: { videoQuota: number } }>();
    expect(config.serverVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(config.signup.allowed).toBe(false);
    // Tests bind R2: uploads are on, with the default quota.
    expect(config.user.videoQuota).toBe(2048 * 1024 * 1024);

    const id = await createAccount("pt_viewer", "pw-long-enough");
    const { get, token, client } = await signIn("pt_viewer", "pw-long-enough");
    expect(token.token_type).toBe("Bearer");
    const me = await get<{ id: number; username: string; account: { name: string; host: string }; specialPlaylists: { type: number }[]; videoChannels: unknown[] }>("/api/v1/users/me");
    expect(me).toMatchObject({ id, username: "pt_viewer", account: { name: "pt_viewer", host: "palm.test" } });
    expect(me.specialPlaylists[0]!.type).toBe(2);
    expect(me.videoChannels).toHaveLength(1);

    // A refresh token makes a new pair, and only once.
    const refresh = new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, grant_type: "refresh_token", refresh_token: token.refresh_token });
    const first = await worker.fetch(`${SITE}/api/v1/users/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: refresh.toString() });
    expect(first.status).toBe(200);
    const again = await worker.fetch(`${SITE}/api/v1/users/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: refresh.toString() });
    expect(again.status).toBe(400);

    // A refresh token isn't an access token.
    const misuse = await worker.fetch(`${SITE}/api/v1/users/me`, { headers: { authorization: `Bearer ${token.refresh_token}` } });
    expect(misuse.status).toBe(401);
  });

  it("refuses a wrong password", async () => {
    await createAccount("pt_wrong", "pw-long-enough");
    const client = await (await worker.fetch(`${SITE}/api/v1/oauth-clients/local`)).json<{ client_id: string; client_secret: string }>();
    const form = new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, grant_type: "password", username: "pt_wrong", password: "nope" });
    const res = await worker.fetch(`${SITE}/api/v1/users/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_grant" });
  });

  it("lists subscribed channels' videos, and shows one with its files", async () => {
    const uuid = "11111111-2222-4333-8444-555555555555";
    const remote = await remoteVideo(uuid);
    const id = await createAccount("pt_sub", "pw-long-enough");
    await subscribe(db, remote.channelId, id);
    const { get } = await signIn("pt_sub", "pw-long-enough");

    const subs = await get<{ total: number; data: { name: string; host: string }[] }>("/api/v1/users/me/subscriptions");
    expect(subs.data.map((s) => `${s.name}@${s.host}`)).toContain("alice_channel@tube.example");
    const exist = await get<Record<string, boolean>>("/api/v1/users/me/subscriptions/exist?uris=alice_channel@tube.example&uris=nobody@tube.example");
    expect(exist).toEqual({ "alice_channel@tube.example": true, "nobody@tube.example": false });

    const feed = await get<{ total: number; data: { id: number; uuid: string; shortUUID: string; name: string; duration: number; channel: { name: string }; account: { name: string; host: string }; thumbnailPath: string }[] }>(
      "/api/v1/users/me/subscriptions/videos",
    );
    const listed = feed.data.find((v) => v.uuid === uuid)!;
    expect(listed).toMatchObject({ id: remote.postId, name: "A video", duration: 125, channel: { name: "alice_channel" }, account: { name: "alice", host: "tube.example" } });
    // Thumbnails come through palm's media cache, at a path on this server.
    expect(listed.thumbnailPath).toMatch(/^\/proxy\/media\?url=/);

    // By ID, UUID or short UUID.
    for (const key of [String(remote.postId), uuid, listed.shortUUID]) {
      const details = await get<{ uuid: string; files: { fileUrl: string; resolution: { id: number } }[]; streamingPlaylists: { playlistUrl: string }[]; description: string }>(`/api/v1/videos/${key}`);
      expect(details.uuid).toBe(uuid);
      expect(details.files[0]).toMatchObject({ resolution: { id: 720 }, fileUrl: `https://tube.example/static/web-videos/${uuid}-720.mp4` });
      expect(details.streamingPlaylists[0]!.playlistUrl).toContain("master.m3u8");
      expect(details.description).toBe("A description");
    }

    const channel = await get<{ name: string; displayName: string; videosCount: number; ownerAccount: { name: string } }>("/api/v1/video-channels/alice_channel@tube.example");
    expect(channel).toMatchObject({ name: "alice_channel", displayName: "Alice makes things", videosCount: 1, ownerAccount: { name: "alice" } });
    const channelVideos = await get<{ total: number }>("/api/v1/video-channels/alice_channel@tube.example/videos");
    expect(channelVideos.total).toBe(1);

    // The app browses a platform through its own server, by host; and asks for lives apart.
    const fromHost = await get<{ data: { uuid: string }[] }>("/api/v1/search/videos?searchTarget=local&host=tube.example&count=50");
    expect(fromHost.data.map((v) => v.uuid)).toContain(uuid);
    expect((await get<{ total: number }>("/api/v1/search/videos?searchTarget=local&host=elsewhere.example")).total).toBe(0);
    expect((await get<{ total: number }>("/api/v1/videos?isLive=true&host=tube.example")).total).toBe(0);
  });

  it("rates, comments on, and saves a video for later", async () => {
    const uuid = "21111111-2222-4333-8444-555555555555";
    const remote = await remoteVideo(uuid, { channel: "bob_channel", title: "Another" });
    const id = await createAccount("pt_rater", "pw-long-enough");
    const { get, send } = await signIn("pt_rater", "pw-long-enough");

    expect((await send("PUT", `/api/v1/videos/${uuid}/rate`, { rating: "like" })).status).toBe(204);
    expect(await get(`/api/v1/users/me/videos/${remote.postId}/rating`)).toEqual({ videoId: remote.postId, rating: "like" });
    const vote = await db.prepare("SELECT score FROM votes WHERE post_id = ? AND account_id = ?").bind(remote.postId, id).first<{ score: number }>();
    expect(vote?.score).toBe(1);

    const thread = await (await send("POST", `/api/v1/videos/${uuid}/comment-threads`, { text: "Great video" })).json<{ comment: { id: number; threadId: number; text: string } }>();
    expect(thread.comment).toMatchObject({ text: "Great video", threadId: thread.comment.id });
    const reply = await (await send("POST", `/api/v1/videos/${uuid}/comments/${thread.comment.id}`, { text: "Agreed" })).json<{ comment: { id: number; threadId: number; inReplyToCommentId: number } }>();
    expect(reply.comment).toMatchObject({ threadId: thread.comment.id, inReplyToCommentId: thread.comment.id });
    // The app asks with a trailing slash.
    expect((await get<{ total: number }>(`/api/v1/videos/${uuid}/comment-threads/?count=0`)).total).toBe(1);
    const threads = await get<{ total: number; data: { id: number; totalReplies: number }[] }>(`/api/v1/videos/${uuid}/comment-threads`);
    expect(threads.data).toEqual([expect.objectContaining({ id: thread.comment.id, totalReplies: 1 })]);
    const tree = await get<{ comment: { id: number }; children: { comment: { text: string } }[] }>(`/api/v1/videos/${uuid}/comment-threads/${thread.comment.id}`);
    expect(tree.children[0]!.comment.text).toBe("Agreed");
    // It's a comment on the channel's thread, as Lemmy apps see it.
    const stored = await db.prepare("SELECT root_id, community_id, client FROM posts WHERE id = ?").bind(reply.comment.id).first();
    expect(stored).toEqual({ root_id: remote.postId, community_id: remote.channelId, client: "peertube" });

    expect((await send("POST", `/api/v1/video-playlists/${id}/videos`, { videoId: remote.postId })).status).toBe(200);
    const exists = await get<Record<string, unknown[]>>(`/api/v1/users/me/video-playlists/videos-exist?videoIds=${remote.postId}`);
    expect(exists[String(remote.postId)]).toHaveLength(1);
    const later = await get<{ total: number; data: { video: { uuid: string } }[] }>(`/api/v1/video-playlists/${id}/videos`);
    expect(later.data[0]!.video.uuid).toBe(uuid);
    // Saved for later is a Lemmy save and a Mastodon bookmark.
    expect(await db.prepare("SELECT 1 AS x FROM bookmarks WHERE post_id = ? AND account_id = ?").bind(remote.postId, id).first()).toEqual({ x: 1 });

    expect((await send("POST", `/api/v1/videos/${uuid}/views`, { currentTime: 30 })).status).toBe(204);
    const history = await get<{ data: { uuid: string; userHistory: { currentTime: number } }[] }>("/api/v1/users/me/history/videos");
    expect(history.data[0]).toMatchObject({ uuid, userHistory: { currentTime: 30 } });
  });

  it("leaves Mastodon's own /api/v1 paths to Mastodon", async () => {
    const res = await worker.fetch(`${SITE}/api/v1/instance`);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("uri");
  });
});

describe("PeerTube: hosting", () => {
  it("takes an MP4, puts it in its person's channel, and serves it as a PeerTube Video", async () => {
    const id = await createAccount("pt_maker", "pw-long-enough");
    await giveKeys(id);
    const { auth, get } = await signIn("pt_maker", "pw-long-enough");
    const form = new FormData();
    form.set("name", "My first video");
    form.set("description", "Made with **palm**");
    form.set("channelId", "1");
    form.set("privacy", "1");
    form.set("videofile", new File([mp4File(1000)], "clip.mp4", { type: "video/mp4" }));
    const res = await worker.fetch(`${SITE}/api/v1/videos/upload`, { method: "POST", headers: auth, body: form });
    expect(res.status).toBe(200);
    const { video } = await res.json<{ video: { id: number; uuid: string; shortUUID: string } }>();

    const details = await get<{ name: string; duration: number; files: { resolution: { id: number }; fileUrl: string }[]; channel: { name: string; isLocal: boolean } }>(`/api/v1/videos/${video.shortUUID}`);
    expect(details).toMatchObject({ name: "My first video", duration: 5, channel: { name: "pt_maker_channel", isLocal: true } });
    expect(details.files[0]!.resolution.id).toBe(720);
    // The file plays from palm's own storage, with ranges.
    const file = await worker.fetch(details.files[0]!.fileUrl, { headers: { range: "bytes=0-15" } });
    expect(file.status).toBe(206);
    await file.arrayBuffer();

    // Other servers get PeerTube's Video, with what PeerTube checks for.
    const object = await (await worker.fetch(`${SITE}/objects/${video.id}`, { headers: AP })).json<Record<string, unknown>>();
    expect(object).toMatchObject({ type: "Video", uuid: video.uuid, duration: "PT5S", name: "My first video", mediaType: "text/markdown", content: "Made with **palm**" });
    expect((object.attributedTo as { type: string }[]).map((a) => a.type)).toEqual(["Person", "Group"]);
    expect((object.url as { mediaType: string; size?: number; height?: number }[]).find((u) => u.mediaType === "video/mp4")).toMatchObject({ height: 720, size: expect.any(Number) });
    expect((object.icon as unknown[]).length).toBe(1);

    // The channel is a Group that names its person, as PeerTube needs.
    const group = await (await worker.fetch(`${SITE}/c/pt_maker_channel`, { headers: AP })).json<Record<string, unknown>>();
    expect(group).toMatchObject({ type: "Group", attributedTo: "https://palm.test/users/pt_maker" });

    // Its page says where it came from.
    const page = await (await worker.fetch(`${SITE}/@pt_maker/${video.id}`, { headers: { accept: "text/html" } })).text();
    expect(page).toContain("on PeerTube");
    expect(page).not.toContain("on Lemmy");

    const mine = await get<{ total: number }>("/api/v1/users/me/videos");
    expect(mine.total).toBe(1);

    // The app sets chapters after an upload, an empty list included.
    const chapters = (body: unknown) => worker.fetch(`${SITE}/api/v1/videos/${video.uuid}/chapters`, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await chapters({ chapters: [] })).status).toBe(204);
    expect((await chapters({ chapters: [{ timecode: 3, title: "Middle" }, { timecode: 0, title: "Start" }] })).status).toBe(204);
    expect(await get(`/api/v1/videos/${video.uuid}/chapters`)).toEqual({ chapters: [{ timecode: 0, title: "Start" }, { timecode: 3, title: "Middle" }] });
  });

  it("takes a resumable upload in equal pieces", async () => {
    const id = await createAccount("pt_chunks", "pw-long-enough");
    await giveKeys(id);
    const { auth, get } = await signIn("pt_chunks", "pw-long-enough");
    const bytes = mp4File(6 * 1024 * 1024);
    const start = await worker.fetch(`${SITE}/api/v1/videos/upload-resumable`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "x-upload-content-length": String(bytes.length), "x-upload-content-type": "video/mp4" },
      body: JSON.stringify({ name: "In pieces", channelId: 1, filename: "pieces.mp4" }),
    });
    expect(start.status).toBe(201);
    const location = `https:${start.headers.get("location")}`;
    const part = 5 * 1024 * 1024;
    const first = await worker.fetch(location, { method: "PUT", headers: { ...auth, "content-range": `bytes 0-${part - 1}/${bytes.length}`, "content-length": String(part) }, body: bytes.slice(0, part) });
    expect(first.status).toBe(308);
    expect(first.headers.get("range")).toBe(`bytes=0-${part - 1}`);
    const last = await worker.fetch(location, {
      method: "PUT",
      headers: { ...auth, "content-range": `bytes ${part}-${bytes.length - 1}/${bytes.length}`, "content-length": String(bytes.length - part) },
      body: bytes.slice(part),
    });
    expect(last.status).toBe(200);
    const { video } = await last.json<{ video: { uuid: string } }>();
    const details = await get<{ duration: number; files: { size: number }[] }>(`/api/v1/videos/${video.uuid}`);
    expect(details).toMatchObject({ duration: 5, files: [{ size: bytes.length }] });
  });

  it("takes the PeerTube app's pieces, any size, cutting them into equal parts", async () => {
    const id = await createAccount("pt_small", "pw-long-enough");
    await giveKeys(id);
    const { auth, get } = await signIn("pt_small", "pw-long-enough");
    // As the app sent it: 3 MB, an octet-stream, in 1 MiB pieces. And a bigger one, over a part.
    for (const extra of [3 * 1024 * 1024, 11 * 1024 * 1024 + 7, 27 * 1024 * 1024 + 13]) {
      const bytes = mp4File(extra);
      const start = await worker.fetch(`${SITE}/api/v1/videos/upload-resumable`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "x-upload-content-length": String(bytes.length), "x-upload-content-type": "application/octet-stream" },
        body: JSON.stringify({ name: "Small pieces", channelId: 1, filename: "phone.mp4" }),
      });
      expect(start.status).toBe(201);
      const location = `https:${start.headers.get("location")}`;
      // The app starts at 1 MiB and grows its pieces: 1, 2, 3 MiB...
      let piece = 1024 * 1024;
      let res: Response | null = null;
      for (let at = 0; at < bytes.length; at += piece, piece += extra > 4 * 1024 * 1024 ? 1024 * 1024 : 0) {
        const end = Math.min(at + piece, bytes.length);
        res = await worker.fetch(location, { method: "PUT", headers: { ...auth, "content-type": "application/octet-stream", "content-range": `bytes ${at}-${end - 1}/${bytes.length}` }, body: bytes.slice(at, end) });
        expect(res.status, `piece at ${at}`).toBe(end === bytes.length ? 200 : 308);
        if (end < bytes.length) expect(res.headers.get("range")).toBe(`bytes=0-${end - 1}`);
      }
      const { video } = await res!.json<{ video: { uuid: string } }>();
      const details = await get<{ duration: number; files: { size: number; fileUrl: string }[] }>(`/api/v1/videos/${video.uuid}`);
      expect(details).toMatchObject({ duration: 5, files: [{ size: bytes.length }] });
      const file = await worker.fetch(details.files[0]!.fileUrl);
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    }
  });

  it("hands HLS jobs to a runner and serves the playlists it makes", async () => {
    const id = await createAccount("pt_runner", "pw-long-enough");
    await giveKeys(id);
    const { auth, get } = await signIn("pt_runner", "pw-long-enough");
    const form = new FormData();
    form.set("name", "For the runner");
    form.set("videofile", new File([mp4File(1000)], "clip.mp4", { type: "video/mp4" }));
    const { video } = await (await worker.fetch(`${SITE}/api/v1/videos/upload`, { method: "POST", headers: auth, body: form })).json<{ video: { id: number; uuid: string } }>();

    const call = (path: string, body: Record<string, unknown>) =>
      worker.fetch(`${SITE}/api/v1/runners${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await call("/register", { registrationToken: "wrong", name: "x" })).status).toBe(404);
    const { runnerToken } = await (await call("/register", { registrationToken: "test-runner-registration-token", name: "homelab" })).json<{ runnerToken: string }>();
    const { availableJobs } = await (await call("/jobs/request", { runnerToken, jobTypes: ["vod-hls-transcoding"] })).json<{ availableJobs: { uuid: string }[] }>();
    expect(availableJobs.length).toBeGreaterThan(0);
    // Other tests' uploads queue jobs too: this video's 720p one.
    const job720 = (await db.prepare("SELECT uuid FROM runner_jobs WHERE post_id = ? AND resolution = 720 AND type = 'vod-hls-transcoding'").bind(video.id).first<{ uuid: string }>())!;
    const { job } = await (await call(`/jobs/${job720.uuid}/accept`, { runnerToken })).json<{ job: { jobToken: string; payload: { input: { videoFileUrl: string } } } }>();
    // The runner fetches the upload with its tokens.
    const input = await worker.fetch(job.payload.input.videoFileUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runnerToken, jobToken: job.jobToken }) });
    expect(input.status).toBe(200);
    await input.arrayBuffer();

    // As peertube-runner sends it: the fragmented MP4 and its playlist, which names it.
    const done = new FormData();
    done.set("runnerToken", runnerToken);
    done.set("jobToken", job.jobToken);
    done.set("payload[videoFile]", new File([new Uint8Array(4096)], "abc-720-fragmented.mp4", { type: "video/mp4" }));
    done.set("payload[resolutionPlaylistFile]", new File(['#EXTM3U\n#EXT-X-MAP:URI="abc-720-fragmented.mp4",BYTERANGE="800@0"\n#EXTINF:5,\n#EXT-X-BYTERANGE:3296@800\nabc-720-fragmented.mp4\n#EXT-X-ENDLIST\n'], "abc-720.m3u8"));
    expect((await worker.fetch(`${SITE}/api/v1/runners/jobs/${job720.uuid}/success`, { method: "POST", body: done })).status).toBe(204);

    const details = await get<{ streamingPlaylists: { playlistUrl: string; files: { resolution: { id: number }; playlistUrl: string }[] }[] }>(`/api/v1/videos/${video.uuid}`);
    const hls = details.streamingPlaylists[0]!;
    expect(hls.playlistUrl).toBe(`https://palm.test/static/streaming-playlists/hls/${video.uuid}/master.m3u8`);
    expect(hls.files[0]!.resolution.id).toBe(720);
    const master = await (await worker.fetch(hls.playlistUrl)).text();
    expect(master).toContain("RESOLUTION=1280x720");
    expect(master).toContain(hls.files[0]!.playlistUrl);
    const rendition = await (await worker.fetch(hls.files[0]!.playlistUrl)).text();
    expect(rendition).not.toContain("abc-720-fragmented.mp4");
    expect(rendition).toContain('#EXT-X-MAP:URI="https://palm.test/pictrs/image/');
  });

  it("has runners transcode a video posted from a Mastodon app, replacing a file that won't play everywhere", async () => {
    const id = await createAccount("pt_mkv", "pw-long-enough");
    await giveKeys(id);
    const auth = { authorization: `Bearer ${await mastodonToken(id)}` };
    const form = new FormData();
    form.append("file", new File([new Uint8Array(2000)], "clip.mkv", { type: "video/x-matroska" }));
    const media = await (await worker.fetch(`${MASTODON}/api/v2/media`, { method: "POST", headers: auth, body: form })).json<{ id: string; type: string }>();
    expect(media.type).toBe("video");
    const status = await (await worker.fetch(`${MASTODON}/api/v1/statuses`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ status: "a clip", media_ids: [media.id] }) })).json<{ id: string }>();

    await (worker as unknown as { scheduled(o: { cron: string; scheduledTime: number }): Promise<unknown> }).scheduled({ cron: "*/10 * * * *", scheduledTime: Date.UTC(2026, 0, 1, 12, 0) });
    const jobs = await db.prepare("SELECT uuid, type FROM runner_jobs WHERE post_id = ?").bind(Number(status.id)).all<{ uuid: string; type: string }>();
    expect(jobs.results.map((j) => j.type)).toContain("vod-hls-transcoding");
    const web = jobs.results.find((j) => j.type === "vod-web-video-transcoding")!;
    expect(web).toBeDefined();

    const call = (path: string, body: Record<string, unknown>) =>
      worker.fetch(`${SITE}/api/v1/runners${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const { runnerToken } = await (await call("/register", { registrationToken: "test-runner-registration-token", name: "mkv" })).json<{ runnerToken: string }>();
    const { job } = await (await call(`/jobs/${web.uuid}/accept`, { runnerToken })).json<{ job: { jobToken: string } }>();
    const done = new FormData();
    done.set("runnerToken", runnerToken);
    done.set("jobToken", job.jobToken);
    done.set("payload[videoFile]", new File([new Uint8Array(3000)], "out.mp4", { type: "video/mp4" }));
    expect((await worker.fetch(`${SITE}/api/v1/runners/jobs/${web.uuid}/success`, { method: "POST", body: done })).status).toBe(204);

    const row = await db.prepare("SELECT content_type, size FROM media WHERE id = ?").bind(media.id).first<{ content_type: string; size: number }>();
    expect(row).toEqual({ content_type: "video/mp4", size: 3000 });
    const shown = await (await worker.fetch(`${MASTODON}/api/v1/statuses/${status.id}`, { headers: auth })).json<{ media_attachments: { url: string }[] }>();
    expect(shown.media_attachments[0]!.url).toMatch(/\.mp4$/);
    expect((await (await worker.fetch(shown.media_attachments[0]!.url)).arrayBuffer()).byteLength).toBe(3000);
  });

  it("refuses files no transcoder takes", async () => {
    await createAccount("pt_mov", "pw-long-enough");
    const { auth } = await signIn("pt_mov", "pw-long-enough");
    const res = await worker.fetch(`${SITE}/api/v1/videos/upload-resumable`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "x-upload-content-length": "1000", "x-upload-content-type": "video/x-flv" },
      body: JSON.stringify({ name: "Nope", channelId: 1, filename: "clip.flv" }),
    });
    expect(res.status).toBe(415);
  });
});
