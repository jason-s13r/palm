import { hashPassword, needsRehash, verifyPassword } from "@palm/auth";
import { markdownToHtml, urls, userAgentClient, type RequestContext } from "@palm/core";
import {
  accountByHandle,
  accountById,
  accountForLogin,
  accountsByIds,
  addMentions,
  appByName,
  bookmark,
  channelOwnerId,
  channelsOf,
  channelVideoCounts,
  claimVideoRefresh,
  communitiesByIds,
  communityById,
  communityByName,
  countAccounts,
  countFollowers,
  countFollowing,
  countView,
  createApp,
  createPost,
  createToken,
  currentVote,
  deletePost,
  follow,
  followState,
  forgetWatch,
  hasLocalSubscribers,
  interactions,
  listVideos,
  localRatings,
  postById,
  postByIdAny,
  recordWatch,
  revokeToken,
  savedVideoIds,
  setPasswordHash,
  setVideoChapters,
  setVideoCounts,
  subscribe,
  subscription,
  subscriptions,
  tagsFor,
  tokenGrant,
  unbookmark,
  unfollow,
  unsubscribe,
  videoByPostId,
  videoByUuid,
  videoChapters,
  videoComments,
  vote,
  watchHistory,
  watchPositions,
  type Account,
  type Community,
  type ListedVideo,
  type OAuthApp,
  type Post,
  type Video,
} from "@palm/db";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { fail, params, type C, type Env } from "./http.ts";
import { masterPlaylist, runnerRoutes } from "./runner.ts";
import { capabilities, uploadRoutes } from "./upload.ts";
import { CATEGORIES, LANGUAGES, LICENCES, PLAYLIST_PRIVACIES, PRIVACIES } from "./labels.ts";
import { fromShortUuid, isUuid, toShortUuid } from "./short-uuid.ts";
import {
  accountView,
  channelHandle,
  channelView,
  commentView,
  notificationSettings,
  PEERTUBE_VERSION,
  PERSON_CHANNEL_BASE,
  userView,
  videoDetails,
  videoView,
  type Channel,
} from "./views.ts";

export { PEERTUBE_VERSION } from "./views.ts";
export { capabilities } from "./upload.ts";
export { backfillRunnerJobs, queueAttachmentTranscodes, runnerSocket } from "./runner.ts";
export { videoMaintenance } from "./maintenance.ts";
export type { C, Env } from "./http.ts";

/** The OAuth app every PeerTube client signs in with: PeerTube has one local client per server. */
const LOCAL_CLIENT = "PeerTube (local client)";
const ACCESS_SCOPE = "peertube";
const REFRESH_SCOPE = "peertube-refresh";

const str = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined);
const int = (v: unknown) => {
  const n = Number(str(v) ?? v);
  return Number.isInteger(n) ? n : undefined;
};
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",").filter(Boolean) : []);

/** PeerTube pages with start and count (15 by default, 100 at most). */
export const pageOf = (p: Record<string, unknown>) => ({ start: Math.max(0, int(p.start) ?? 0), count: Math.min(100, Math.max(0, int(p.count) ?? 15)) });

const me = (c: C) => c.get("account");

/** PeerTube's list filters: host (one server's videos), isLive, nsfw and isLocal. */
function filtersOf(c: C, p: Record<string, unknown>) {
  const host = str(p.host)?.toLowerCase();
  const live = str(p.isLive);
  return {
    // This server's own host means its own uploads; another's, the videos palm keeps from it.
    ...(host ? (isLocalHost(c, host) ? { localOnly: true } : { host }) : {}),
    ...(str(p.isLocal) === "true" ? { localOnly: true } : {}),
    ...(live === "true" || live === "false" ? { isLive: live === "true" } : {}),
    ...(str(p.nsfw) === "false" ? { safeOnly: true } : {}),
  };
}

/** Splits a PeerTube handle (name, name@host or @name@host) into its parts; no host means this server. */
function handleOf(c: C, handle: string): { name: string; host: string } {
  const parts = decodeURIComponent(handle).replace(/^@/, "").split("@");
  return { name: parts[0] ?? "", host: (parts[1] ?? c.env.domain.domain).toLowerCase() };
}

const isLocalHost = (c: C, host: string) => c.env.config.domains.some((d) => d.domain === host);

// --- finding things ------------------------------------------------------------

/** A video by palm's ID, its UUID or its short UUID. */
async function findVideo(c: C, id: string): Promise<{ post: Post; video: Video } | null> {
  const db = c.env.bindings.DB;
  let video: Video | null = null;
  if (/^\d+$/.test(id)) video = await videoByPostId(db, Number(id));
  else if (isUuid(id)) video = await videoByUuid(db, id);
  else {
    const uuid = fromShortUuid(id);
    if (uuid) video = await videoByUuid(db, uuid);
  }
  if (!video) return null;
  const post = await postById(db, video.postId);
  if (!post) return null;
  // Private and direct videos only for their author.
  if ((post.visibility === "private" || post.visibility === "direct") && post.accountId !== me(c)?.id) return null;
  return { post, video };
}

/** A channel by handle: a community (a PeerTube channel is a Group), or a person's own stand-in. */
export async function findChannel(c: C, handle: string, fetch = true): Promise<Channel | null> {
  const db = c.env.bindings.DB;
  const { name, host } = handleOf(c, handle);
  if (!name) return null;
  const community = await communityByName(db, host, name.toLowerCase());
  if (community) return { kind: "community", community };
  const person = await accountByHandle(db, name, host);
  if (person && !person.banned) return { kind: "person", account: person };
  if (!fetch || isLocalHost(c, host)) return null;
  const found = await c.env.activities.resolve(`!${name}@${host}`).catch(() => null);
  if (found?.kind === "community") {
    const fetched = await communityById(db, found.id);
    return fetched ? { kind: "community", community: fetched } : null;
  }
  if (found?.kind === "account") {
    const fetched = await accountById(db, found.id);
    return fetched ? { kind: "person", account: fetched } : null;
  }
  return null;
}

async function channelById(c: C, id: number): Promise<Channel | null> {
  const db = c.env.bindings.DB;
  if (id > PERSON_CHANNEL_BASE) {
    const account = await accountById(db, id - PERSON_CHANNEL_BASE);
    return account ? { kind: "person", account } : null;
  }
  const community = await communityById(db, id);
  return community ? { kind: "community", community } : null;
}

async function findAccount(c: C, handle: string): Promise<Account | null> {
  const db = c.env.bindings.DB;
  const { name, host } = handleOf(c, handle);
  if (!name) return null;
  const known = await accountByHandle(db, name, host);
  if (known) return known.banned ? null : known;
  if (isLocalHost(c, host)) return null;
  const found = await c.env.activities.resolve(`@${name}@${host}`).catch(() => null);
  return found?.kind === "account" ? accountById(db, found.id) : null;
}

// --- rendering -------------------------------------------------------------

/** A page of videos as PeerTube lists them, with their people, channels and counts in a few queries. */
export async function renderVideos(c: C, rows: ListedVideo[]) {
  const db = c.env.bindings.DB;
  const viewer = me(c);
  const ids = rows.map((r) => r.post.id);
  const [authors, channels, ratings, counts, positions] = await Promise.all([
    accountsByIds(db, rows.map((r) => r.post.accountId)),
    communitiesByIds(db, rows.map((r) => r.video.channelId).filter((id): id is number => id !== null)),
    localRatings(db, ids, viewer?.id ?? null),
    interactions(db, ids, null),
    viewer ? watchPositions(db, viewer.id, ids) : Promise.resolve(new Map<number, number>()),
  ]);
  const out = [];
  for (const { post, video } of rows) {
    const author = authors.get(post.accountId);
    if (!author) continue;
    const community = video.channelId !== null ? channels.get(video.channelId) : undefined;
    const channel: Channel = community ? { kind: "community", community } : { kind: "person", account: author };
    out.push(
      videoView(c.env, post, video, author, channel, {
        likes: ratings.get(post.id)?.likes,
        dislikes: ratings.get(post.id)?.dislikes,
        comments: counts.get(post.id)?.replies ?? 0,
        watchedTo: positions.get(post.id),
      }),
    );
  }
  return out;
}

async function renderDetails(c: C, post: Post, video: Video) {
  const db = c.env.bindings.DB;
  const author = await accountById(db, post.accountId);
  if (!author) return null;
  const community = video.channelId !== null ? await communityById(db, video.channelId) : null;
  const channel: Channel = community ? { kind: "community", community } : { kind: "person", account: author };
  const viewer = me(c);
  const [ratings, counts, tags, positions] = await Promise.all([
    localRatings(db, [post.id], viewer?.id ?? null),
    interactions(db, [post.id], null),
    tagsFor(db, [post.id]),
    viewer ? watchPositions(db, viewer.id, [post.id]) : Promise.resolve(new Map<number, number>()),
  ]);
  return videoDetails(c.env, post, video, author, channel, {
    likes: ratings.get(post.id)?.likes,
    dislikes: ratings.get(post.id)?.dislikes,
    comments: counts.get(post.id)?.replies ?? 0,
    watchedTo: positions.get(post.id),
    tags: tags.get(post.id) ?? [],
  });
}

async function renderChannel(c: C, channel: Channel) {
  const db = c.env.bindings.DB;
  if (channel.kind === "person") {
    const { total } = await listVideos(db, { accountId: channel.account.id, start: 0, count: 0 });
    return channelView(c.env, channel, { videosCount: total });
  }
  const [ownerId, counts] = await Promise.all([channelOwnerId(db, channel.community.id), channelVideoCounts(db, [channel.community.id])]);
  const owner = ownerId ? await accountById(db, ownerId) : null;
  return channelView(c.env, channel, { owner, videosCount: counts.get(channel.community.id) ?? 0 });
}

// --- the app ---------------------------------------------------------------------

const app = new Hono<Env>({ strict: false });

app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "Content-Range", "X-Upload-Content-Length", "X-Upload-Content-Type"], exposeHeaders: ["Location", "Range", "Retry-After"], maxAge: 86400 }));

app.use("/api/*", async (c, next) => {
  c.set("account", null);
  const header = c.req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    const db = c.env.bindings.DB;
    const grant = await tokenGrant(db, header.slice(7).trim());
    // A refresh token isn't an access token.
    if (grant && grant.scopes !== REFRESH_SCOPE && grant.accountId !== null) {
      const acct = await accountById(db, grant.accountId);
      if (acct?.domain === c.env.domain.domain && acct.apId === null && !acct.banned) c.set("account", acct);
    }
    // PeerTube answers a bad token with 401, so apps refresh or sign in again.
    if (!c.get("account")) return fail(c, 401, "Invalid token: access token is invalid", "invalid_token");
  }
  await next();
});

/** Routes that need someone signed in. */
const signedIn = async (c: C, next: () => Promise<void>) => {
  if (!me(c)) return fail(c, 401, "Authentication is required.");
  await next();
};
for (const path of ["/api/v1/users/me", "/api/v1/users/me/*", "/api/v1/video-playlists/*/videos", "/api/v1/video-playlists/*/videos/*"]) app.use(path, async (c, next) => {
  // Reading a public playlist doesn't need a token; changing one does.
  if (path.startsWith("/api/v1/video-playlists") && c.req.method === "GET") return next();
  return signedIn(c, next);
});

// --- sign-in -----------------------------------------------------------------

async function localClient(c: C): Promise<OAuthApp> {
  const db = c.env.bindings.DB;
  return (await appByName(db, LOCAL_CLIENT)) ?? createApp(db, { name: LOCAL_CLIENT, website: null, redirectUris: ["urn:ietf:wg:oauth:2.0:oob"], scopes: ACCESS_SCOPE });
}

app.get("/api/v1/oauth-clients/local", async (c) => {
  const client = await localClient(c);
  return c.json({ client_id: client.clientId, client_secret: client.clientSecret });
});

/** A new access token and refresh token, as PeerTube's token endpoint answers. */
async function tokenPair(c: C, client: OAuthApp, accountId: number) {
  const db = c.env.bindings.DB;
  const [access, refresh] = await Promise.all([
    createToken(db, { appId: client.id, accountId, scopes: ACCESS_SCOPE }),
    createToken(db, { appId: client.id, accountId, scopes: REFRESH_SCOPE }),
  ]);
  return c.json({
    token_type: "Bearer",
    access_token: access.token,
    refresh_token: refresh.token,
    // palm's tokens last until revoked; apps refresh at these times anyway.
    expires_in: 86400,
    refresh_token_expires_in: 1209600,
  });
}

app.post("/api/v1/users/token", async (c) => {
  const p = await params(c);
  const db = c.env.bindings.DB;
  const client = await localClient(c);
  if (str(p.client_id) !== client.clientId || str(p.client_secret) !== client.clientSecret) {
    return fail(c, 400, "Invalid client: client is invalid", "invalid_client");
  }
  const grantType = str(p.grant_type);
  if (grantType === "refresh_token") {
    const refreshToken = str(p.refresh_token) ?? "";
    const grant = refreshToken ? await tokenGrant(db, refreshToken) : null;
    if (!grant || grant.scopes !== REFRESH_SCOPE || grant.accountId === null) return fail(c, 400, "Invalid grant: refresh token is invalid", "invalid_grant");
    const account = await accountById(db, grant.accountId);
    if (!account || account.banned) return fail(c, 400, "Invalid grant: refresh token is invalid", "invalid_grant");
    await revokeToken(db, refreshToken);
    return tokenPair(c, client, account.id);
  }
  if (grantType !== "password") return fail(c, 400, "Unsupported grant type", "unsupported_grant_type");
  // People sign in with their username (or name@domain, or the email palm makes up from it).
  const username = (str(p.username) ?? "").trim().replace(/^@/, "").replace(/@.*$/, "");
  const found = username ? await accountForLogin(db, c.env.domain.domain, username) : null;
  const ok = found?.passwordHash && (await verifyPassword(str(p.password) ?? "", found.passwordHash));
  if (!found || !ok) return fail(c, 400, "Invalid grant: user credentials are invalid", "invalid_grant");
  if (found.account.banned) return fail(c, 400, "User account is blocked.", "account_blocked");
  if (found.passwordHash && needsRehash(found.passwordHash)) {
    c.env.waitUntil(hashPassword(str(p.password) ?? "").then((hash) => setPasswordHash(db, found.account.id, hash)));
  }
  return tokenPair(c, client, found.account.id);
});

app.post("/api/v1/users/revoke-token", async (c) => {
  const header = c.req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) await revokeToken(c.env.bindings.DB, header.slice(7).trim());
  return c.json({});
});

app.post("/api/v1/users/register", (c) => fail(c, 403, "Sign-up is by invite: use a Lemmy or Mastodon app with an invite code."));
app.post("/api/v1/users/ask-send-verify-email", (c) => c.body(null, 204));

// --- the server -------------------------------------------------------------------

app.get("/api/v1/ping", (c) => c.text("pong"));

app.get("/api/v1/config", async (c) => c.json(serverConfig(c)));
app.get("/api/v1/config/about", (c) => {
  const instance = c.env.config.instance;
  return c.json({
    instance: {
      name: instance.name,
      shortDescription: instance.description ?? "",
      description: instance.description ?? "",
      terms: "",
      codeOfConduct: "",
      hardwareInformation: "",
      creationReason: "",
      moderationInformation: "",
      administrator: "",
      maintenanceLifetime: "",
      businessModel: "",
      languages: ["en"],
      categories: [],
      serverCountry: "",
      support: { text: "" },
      social: { externalLink: "", mastodonLink: "", blueskyLink: "", xLink: "" },
      avatars: [],
      banners: [],
    },
  });
});

app.get("/api/v1/server/stats", async (c) => {
  const db = c.env.bindings.DB;
  const [users, local] = await Promise.all([countAccounts(db, c.env.domain.domain), listVideos(db, { start: 0, count: 0, localOnly: true })]);
  const all = await listVideos(db, { start: 0, count: 0 });
  return c.json({
    totalUsers: users,
    totalDailyActiveUsers: 0,
    totalWeeklyActiveUsers: 0,
    totalMonthlyActiveUsers: 0,
    totalModerators: 0,
    totalAdmins: 1,
    totalLocalVideos: local.total,
    totalLocalVideoViews: 0,
    totalLocalVideoComments: 0,
    totalLocalVideoFilesSize: 0,
    totalVideos: all.total,
    totalVideoComments: 0,
    totalLocalVideoChannels: 0,
    totalLocalDailyActiveVideoChannels: 0,
    totalLocalWeeklyActiveVideoChannels: 0,
    totalLocalMonthlyActiveVideoChannels: 0,
    totalLocalPlaylists: 0,
    totalInstanceFollowers: 0,
    totalInstanceFollowing: 0,
    videosRedundancy: [],
    totalActivityPubMessagesProcessed: 0,
    totalActivityPubMessagesSuccesses: 0,
    totalActivityPubMessagesErrors: 0,
    activityPubMessagesProcessedPerSecond: 0,
    totalActivityPubMessagesWaiting: 0,
  });
});

/** PeerTube's server config, as palm can honour it. Uploads follow what the deployment can do. */
function serverConfig(c: C) {
  const instance = c.env.config.instance;
  const caps = capabilities(c.env);
  const resolutions = caps.transcoder ? [240, 360, 480, 720, 1080] : [];
  return {
    serverVersion: PEERTUBE_VERSION,
    serverCommit: `palm ${c.env.version}`,
    client: {
      newFeaturesInfo: false,
      header: { hideInstanceName: false },
      videos: { miniature: { preferAuthorDisplayName: true }, resumableUpload: { minChunkSize: caps.chunkSize, maxChunkSize: caps.chunkSize } },
      browseVideos: { defaultSort: "-publishedAt", defaultScope: "federated", includeScheduledLive: false },
      menu: { login: { redirectOnSingleExternalAuth: false } },
      openInApp: {
        android: { intent: { enabled: false, host: "", scheme: "", fallbackUrl: "" } },
        ios: { enabled: false, host: "", scheme: "", fallbackUrl: "" },
      },
    },
    defaults: {
      publish: { downloadEnabled: true, commentsPolicy: 1, recommendationScope: 1, privacy: 1, licence: null },
      live: { saveReplay: false },
      p2p: { webapp: { enabled: false }, embed: { enabled: false } },
      player: { theme: "galaxy", autoPlay: true },
    },
    webadmin: { configuration: { edition: { allowed: false } } },
    security: { passwordConfirmation: { enabled: false } },
    instance: {
      name: instance.name,
      shortDescription: instance.description ?? "",
      isNSFW: false,
      defaultNSFWPolicy: "blur",
      serverCountry: "",
      support: { text: "" },
      social: { externalLink: "", mastodonLink: "", blueskyLink: "", xLink: "" },
      defaultClientRoute: "/videos/browse",
      customizations: { javascript: "", css: "" },
      avatars: [],
      banners: [],
      defaultLanguage: "en",
      logo: [],
    },
    search: {
      remoteUri: { users: true, anonymous: false },
      searchIndex: { enabled: false, url: "", disableLocalSearch: false, isDefaultSearch: false },
    },
    plugin: { registered: [], registeredExternalAuths: [], registeredIdAndPassAuths: [] },
    theme: { registered: [], builtIn: [{ name: "peertube-core-light-beige" }, { name: "peertube-core-dark-brown" }], default: "default", customization: {} },
    email: { enabled: false },
    contactForm: { enabled: false },
    signup: { allowed: false, allowedForCurrentIP: false, requiresEmailVerification: false, requiresApproval: false, minimumAge: 16 },
    transcoding: {
      hls: { enabled: caps.transcoder === "stream" || caps.transcoder === "runner", splitAudioAndVideo: false },
      web_videos: { enabled: true },
      enabledResolutions: resolutions,
      profile: "default",
      availableProfiles: ["default"],
      remoteRunners: { enabled: caps.transcoder === "runner" },
      alwaysTranscodeOriginalResolution: false,
      alwaysTranscodePodcastOptimizedAudio: false,
    },
    live: {
      enabled: false,
      allowReplay: false,
      dvr: { maxWindow: 0 },
      latencySetting: { enabled: false },
      maxDuration: -1,
      maxInstanceLives: 0,
      maxUserLives: 0,
      transcoding: { enabled: false, remoteRunners: { enabled: false }, enabledResolutions: [], profile: "default", availableProfiles: ["default"] },
      rtmp: { port: 1935 },
    },
    videoStudio: { enabled: false, remoteRunners: { enabled: false } },
    videoFile: { update: { enabled: false } },
    videoTranscription: { enabled: false, remoteRunners: { enabled: false } },
    import: {
      videos: { http: { enabled: false }, torrent: { enabled: false } },
      videoChannelSynchronization: { enabled: false },
      users: { enabled: false, resumableUpload: { minChunkSize: caps.chunkSize } },
    },
    export: { users: { enabled: false, exportExpiration: 0, maxUserVideoQuota: 0 } },
    autoBlacklist: { videos: { ofUsers: { enabled: false } } },
    blocklist: { publicLog: { enabled: false } },
    avatar: { file: { size: { max: 4 * 1024 * 1024 }, extensions: [".png", ".jpeg", ".jpg", ".gif", ".webp"] } },
    banner: { file: { size: { max: 4 * 1024 * 1024 }, extensions: [".png", ".jpeg", ".jpg", ".gif", ".webp"] } },
    logo: { file: { size: { max: 4 * 1024 * 1024 }, extensions: [".png", ".jpeg", ".jpg", ".gif", ".webp"] } },
    video: {
      image: { size: { max: 4 * 1024 * 1024 }, extensions: [".png", ".jpg", ".jpeg", ".webp"] },
      file: { extensions: caps.uploads ? caps.extensions : [] },
    },
    videoCaption: { file: { size: { max: 20 * 1024 * 1024 }, extensions: [".vtt", ".srt"] } },
    user: { videoQuota: caps.uploads ? caps.quota : 0, videoQuotaDaily: -1 },
    videoChannels: { maxPerUser: 1 },
    trending: { videos: { intervalDays: 7, algorithms: { enabled: ["hot", "most-viewed", "most-liked"], default: "most-viewed" } } },
    tracker: { enabled: false },
    followings: { instance: { autoFollowIndex: { indexUrl: "" } } },
    federation: { enabled: true },
    homepage: { enabled: false },
    openTelemetry: { metrics: { enabled: false, playbackStatsInterval: 15000 } },
    views: { videos: { watchingInterval: { anonymous: 5000, users: 5000 } } },
    storyboards: { enabled: false, remoteRunners: { enabled: false } },
    webrtc: { enabled: false },
    nsfwFlagsSettings: { enabled: false },
    fieldsConstraints: { users: { password: { minLength: 10, maxLength: 200 } } },
    videoComments: { acceptRemoteComments: true },
    broadcastMessage: { enabled: false, message: "", level: "info", dismissable: true },
  };
}

// --- reference lists ---------------------------------------------------------------

app.get("/api/v1/videos/categories", (c) => c.json(CATEGORIES));
app.get("/api/v1/videos/licences", (c) => c.json(LICENCES));
app.get("/api/v1/videos/languages", (c) => c.json(LANGUAGES));
app.get("/api/v1/videos/privacies", (c) => c.json(PRIVACIES));
app.get("/api/v1/video-playlists/privacies", (c) => c.json(PLAYLIST_PRIVACIES));

// --- uploads (when the deployment can store video) -----------------------------------

app.route("/", uploadRoutes);
app.route("/", runnerRoutes);

// --- the signed-in person -------------------------------------------------------------

/** Watch later is each person's saves, as one playlist: its ID is theirs. */
const watchLaterUuid = (accountId: number) => `00000000-0000-4000-8000-${accountId.toString(16).padStart(12, "0")}`;

app.get("/api/v1/users/me", async (c) => {
  const account = me(c)!;
  const db = c.env.bindings.DB;
  const [followers, following, ownChannels, used] = await Promise.all([
    countFollowers(db, account.id),
    countFollowing(db, account.id),
    channelsOf(db, account.id),
    quotaUsed(c, account),
  ]);
  const communities = await communitiesByIds(db, ownChannels);
  const channels: Channel[] = [...communities.values()].filter((x) => x.apId === null).map((community) => ({ kind: "community", community }));
  // Everyone has a channel in PeerTube's model: without one of their own, their person stands in.
  if (!channels.length) channels.push({ kind: "person", account });
  const caps = capabilities(c.env);
  return c.json(
    userView(c.env, account, {
      channels: channels.map((ch) => channelView(c.env, ch, { owner: account })),
      watchLaterId: account.id,
      quota: caps.uploads ? caps.quota : 0,
      quotaUsed: used,
      counts: { followers, following },
    }),
  );
});

async function quotaUsed(c: C, account: Account): Promise<number> {
  const row = await c.env.bindings.DB.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM media WHERE account_id = ? AND content_type LIKE 'video/%'")
    .bind(account.id)
    .first<{ n: number }>()
    .catch(() => null);
  return row?.n ?? 0;
}

app.get("/api/v1/users/me/video-quota-used", async (c) => c.json({ videoQuotaUsed: await quotaUsed(c, me(c)!), videoQuotaUsedDaily: 0 }));
// Settings live in the Lemmy and Mastodon apps; PeerTube's are taken and kept to defaults.
app.put("/api/v1/users/me", (c) => c.body(null, 204));
app.post("/api/v1/users/me/new-feature-info/read", (c) => c.body(null, 204));
app.put("/api/v1/users/me/notification-settings", (c) => c.body(null, 204));
app.get("/api/v1/users/me/notifications", (c) => c.json({ total: 0, data: [] }));
app.post("/api/v1/users/me/notifications/read", (c) => c.body(null, 204));
app.post("/api/v1/users/me/notifications/read-all", (c) => c.body(null, 204));
app.get("/api/v1/users/me/notification-settings", (c) => c.json(notificationSettings()));
for (const path of ["/api/v1/users/me/videos/imports", "/api/v1/users/me/videos/comments", "/api/v1/users/me/blocklist/accounts", "/api/v1/users/me/blocklist/servers", "/api/v1/users/me/abuses", "/api/v1/users/me/video-channel-syncs"]) {
  app.get(path, (c) => c.json({ total: 0, data: [] }));
}

app.get("/api/v1/users/me/videos", async (c) => {
  const p = await params(c);
  const { start, count } = pageOf(p);
  const listed = await listVideos(c.env.bindings.DB, { accountId: me(c)!.id, start, count, sort: str(p.sort), postIds: undefined, includeUnlisted: true });
  return c.json({ total: listed.total, data: await renderVideos(c, listed.data) });
});

app.get("/api/v1/users/me/videos/:id/rating", async (c) => {
  const found = await findVideo(c, c.req.param("id"));
  if (!found) return fail(c, 404, "Video not found");
  const score = await currentVote(c.env.bindings.DB, found.post.id, me(c)!.id);
  return c.json({ videoId: found.post.id, rating: score === 1 ? "like" : score === -1 ? "dislike" : "none" });
});

// --- subscriptions ----------------------------------------------------------------------

/** The communities that are video channels: PeerTube's, or any with videos palm keeps. */
async function channelSubscriptions(c: C, account: Account): Promise<Community[]> {
  const subs = await subscriptions(c.env.bindings.DB, account.id);
  const counts = await channelVideoCounts(c.env.bindings.DB, subs.map((s) => s.id));
  return subs.filter((s) => (s.apId ?? "").includes("/video-channels/") || (counts.get(s.id) ?? 0) > 0);
}

app.get("/api/v1/users/me/subscriptions", async (c) => {
  const p = await params(c);
  const { start, count } = pageOf(p);
  let subs = await channelSubscriptions(c, me(c)!);
  const search = str(p.search)?.toLowerCase();
  if (search) subs = subs.filter((s) => s.name.toLowerCase().includes(search) || s.title.toLowerCase().includes(search));
  const data = await Promise.all(subs.slice(start, start + count).map((community) => renderChannel(c, { kind: "community", community })));
  return c.json({ total: subs.length, data });
});

app.get("/api/v1/users/me/subscriptions/videos", async (c) => {
  const p = await params(c);
  const { start, count } = pageOf(p);
  const listed = await listVideos(c.env.bindings.DB, { subscribedBy: me(c)!.id, start, count, sort: str(p.sort), ...filtersOf(c, p) });
  return c.json({ total: listed.total, data: await renderVideos(c, listed.data) });
});

app.get("/api/v1/users/me/subscriptions/exist", async (c) => {
  const p = await params(c);
  const db = c.env.bindings.DB;
  const account = me(c)!;
  const out: Record<string, boolean> = {};
  for (const uri of list(p.uris).slice(0, 50)) {
    const channel = await findChannel(c, uri, false);
    out[uri] =
      channel?.kind === "community"
        ? (await subscription(db, channel.community.id, account.id)) !== null
        : channel?.kind === "person"
          ? (await followState(db, account.id, channel.account.id)) !== null
          : false;
  }
  return c.json(out);
});

app.post("/api/v1/users/me/subscriptions", async (c) => {
  const p = await params(c);
  const uri = str(p.uri) ?? "";
  const account = me(c)!;
  const channel = await findChannel(c, uri.replace(/^https?:\/\/([^/]+)\/(?:video-channels|c|a)\/([^/?#]+).*$/, "$2@$1"));
  if (!channel) return fail(c, 404, "Channel not found");
  await subscribeTo(c, account, channel);
  return c.body(null, 204);
});

async function subscribeTo(c: C, account: Account, channel: Channel): Promise<void> {
  const db = c.env.bindings.DB;
  if (channel.kind === "community") {
    const community = channel.community;
    if (await subscription(db, community.id, account.id)) return;
    if (community.apId === null) return subscribe(db, community.id, account.id);
    const followApId = `${urls.user(account.domain, account.username)}#follows/c${community.id}-${Date.now()}`;
    const first = !(await hasLocalSubscribers(db, community.id));
    await subscribe(db, community.id, account.id, { followApId });
    c.env.activities.enqueue({ kind: "subscribed", accountId: account.id, communityId: community.id, followApId, undo: false });
    if (first) c.env.activities.enqueue({ kind: "backfill", communityId: community.id });
    return;
  }
  const target = channel.account;
  if (target.id === account.id || (await followState(db, account.id, target.id))) return;
  const followApId = `${urls.user(account.domain, account.username)}#follows/${target.id}-${Date.now()}`;
  await follow(db, account.id, target.id, target.apId || target.locked ? { followApId } : undefined, "mastodon");
  c.env.activities.enqueue({ kind: "followed", accountId: account.id, targetId: target.id, followApId, undo: false });
}

app.get("/api/v1/users/me/subscriptions/:uri", async (c) => {
  const channel = await findChannel(c, c.req.param("uri"), false);
  if (!channel) return fail(c, 404, "Subscription not found");
  return c.json(await renderChannel(c, channel));
});

app.delete("/api/v1/users/me/subscriptions/:uri", async (c) => {
  const db = c.env.bindings.DB;
  const account = me(c)!;
  const channel = await findChannel(c, c.req.param("uri"), false);
  if (!channel) return fail(c, 404, "Subscription not found");
  if (channel.kind === "community") {
    const sub = await subscription(db, channel.community.id, account.id);
    if (!sub) return fail(c, 404, "Subscription not found");
    await unsubscribe(db, channel.community.id, account.id);
    if (channel.community.apId && sub.followApId) {
      c.env.activities.enqueue({ kind: "subscribed", accountId: account.id, communityId: channel.community.id, followApId: sub.followApId, undo: true });
    }
  } else {
    const state = await followState(db, account.id, channel.account.id);
    if (!state) return fail(c, 404, "Subscription not found");
    if (await unfollow(db, account.id, channel.account.id)) {
      c.env.activities.enqueue({ kind: "followed", accountId: account.id, targetId: channel.account.id, followApId: state.followApId ?? "", undo: true });
    }
  }
  return c.body(null, 204);
});

// --- history -------------------------------------------------------------------------------

app.get("/api/v1/users/me/history/videos", async (c) => {
  const p = await params(c);
  const { start, count } = pageOf(p);
  const history = await watchHistory(c.env.bindings.DB, me(c)!.id, start, count);
  const listed = await listVideos(c.env.bindings.DB, { postIds: history.postIds, start: 0, count: history.postIds.length });
  const byId = new Map(listed.data.map((v) => [v.post.id, v]));
  const ordered = history.postIds.map((id) => byId.get(id)).filter((v): v is ListedVideo => v !== undefined);
  return c.json({ total: history.total, data: await renderVideos(c, ordered) });
});

app.delete("/api/v1/users/me/history/videos/:id", async (c) => {
  const found = await findVideo(c, c.req.param("id"));
  if (found) await forgetWatch(c.env.bindings.DB, me(c)!.id, found.post.id);
  return c.body(null, 204);
});

app.post("/api/v1/users/me/history/videos/remove", async (c) => {
  const p = await params(c);
  const before = str(p.beforeDate);
  await forgetWatch(c.env.bindings.DB, me(c)!.id, undefined, before ? Math.floor(Date.parse(before) / 1000) : undefined);
  return c.body(null, 204);
});

// --- watch later (palm's saves) ------------------------------------------------------------

async function watchLaterView(c: C, owner: Account) {
  const ids = await savedVideoIds(c.env.bindings.DB, owner.id);
  return {
    id: owner.id,
    uuid: watchLaterUuid(owner.id),
    shortUUID: toShortUuid(watchLaterUuid(owner.id)),
    isLocal: true,
    url: `https://${c.env.domain.domain}/w/p/${toShortUuid(watchLaterUuid(owner.id))}`,
    displayName: "Watch later",
    description: null,
    privacy: { id: 3, label: "Private" },
    thumbnailPath: null,
    thumbnailUrl: null,
    embedPath: `/video-playlists/embed/${watchLaterUuid(owner.id)}`,
    embedUrl: null,
    videosLength: ids.length,
    type: { id: 2, label: "Watch later" },
    createdAt: new Date(owner.createdAt * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    ownerAccount: accountView(c.env, owner),
    videoChannel: null,
    videoChannelPosition: null,
  };
}

/** Only one's own Watch later exists; by its ID or UUID. */
function isMyWatchLater(c: C, id: string): boolean {
  const account = me(c);
  if (!account) return false;
  return id === String(account.id) || id === watchLaterUuid(account.id) || id === toShortUuid(watchLaterUuid(account.id));
}

app.get("/api/v1/video-playlists", (c) => c.json({ total: 0, data: [] }));
app.post("/api/v1/video-playlists", (c) => fail(c, 400, "palm keeps one playlist per person: Watch later."));

app.get("/api/v1/video-playlists/:id", async (c) => {
  if (!isMyWatchLater(c, c.req.param("id"))) return fail(c, 404, "Video playlist not found");
  return c.json(await watchLaterView(c, me(c)!));
});

app.get("/api/v1/video-playlists/:id/videos", async (c) => {
  if (!isMyWatchLater(c, c.req.param("id"))) return fail(c, 404, "Video playlist not found");
  const p = await params(c);
  const { start, count } = pageOf(p);
  const ids = await savedVideoIds(c.env.bindings.DB, me(c)!.id);
  const page = ids.slice(start, start + count);
  const listed = await listVideos(c.env.bindings.DB, { postIds: page, start: 0, count: page.length });
  const byId = new Map(listed.data.map((v) => [v.post.id, v]));
  const rows = page.map((id) => byId.get(id)).filter((v): v is ListedVideo => v !== undefined);
  const videos = await renderVideos(c, rows);
  return c.json({
    total: ids.length,
    data: videos.map((video, i) => ({ id: video.id, position: start + i + 1, startTimestamp: null, stopTimestamp: null, type: 0, video })),
  });
});

app.post("/api/v1/video-playlists/:id/videos", async (c) => {
  if (!isMyWatchLater(c, c.req.param("id"))) return fail(c, 404, "Video playlist not found");
  const p = await params(c);
  const found = await findVideo(c, String(p.videoId ?? ""));
  if (!found) return fail(c, 404, "Video not found");
  await bookmark(c.env.bindings.DB, found.post.id, me(c)!.id);
  return c.json({ videoPlaylistElement: { id: found.post.id } });
});

app.put("/api/v1/video-playlists/:id/videos/:element", (c) => c.body(null, 204));
app.post("/api/v1/video-playlists/:id/videos/reorder", (c) => c.body(null, 204));

app.delete("/api/v1/video-playlists/:id/videos/:element", async (c) => {
  if (!isMyWatchLater(c, c.req.param("id"))) return fail(c, 404, "Video playlist not found");
  await unbookmark(c.env.bindings.DB, Number(c.req.param("element")), me(c)!.id);
  return c.body(null, 204);
});

app.get("/api/v1/users/me/video-playlists/videos-exist", async (c) => {
  const p = await params(c);
  const account = me(c)!;
  const saved = new Set(await savedVideoIds(c.env.bindings.DB, account.id));
  const out: Record<string, unknown[]> = {};
  for (const id of list(p.videoIds)) {
    const n = Number(id);
    out[id] = saved.has(n) ? [{ playlistElementId: n, playlistId: account.id, playlistDisplayName: "Watch later", playlistShortUUID: toShortUuid(watchLaterUuid(account.id)), startTimestamp: null, stopTimestamp: null }] : [];
  }
  return c.json(out);
});

// --- videos ----------------------------------------------------------------------------------

app.get("/api/v1/videos", async (c) => {
  const p = await params(c);
  const { start, count } = pageOf(p);
  const listed = await listVideos(c.env.bindings.DB, { start, count, sort: str(p.sort), search: str(p.search), ...filtersOf(c, p) });
  return c.json({ total: listed.total, data: await renderVideos(c, listed.data) });
});

app.get("/api/v1/videos/:id", async (c) => {
  const found = await findVideo(c, c.req.param("id"));
  if (!found) return fail(c, 404, "Video not found");
  if (found.post.apId) c.env.waitUntil(refreshCounts(c, found.post, found.video));
  const details = await renderDetails(c, found.post, found.video);
  return details ? c.json(details) : fail(c, 404, "Video not found");
});

/** Other servers' counts (views, likes) come from their own API, at most every 15 minutes, after the response. */
async function refreshCounts(c: C, post: Post, video: Video): Promise<void> {
  const db = c.env.bindings.DB;
  if (!(await claimVideoRefresh(db, post.id, 15 * 60))) return;
  try {
    const host = new URL(post.apId!).host;
    const res = await fetch(`https://${host}/api/v1/videos/${video.uuid}`, { headers: { accept: "application/json", "user-agent": "palm (+https://github.com/jason-s13r/palm)" } });
    if (!res.ok) return;
    const data = (await res.json()) as { views?: number; likes?: number; dislikes?: number };
    await setVideoCounts(db, post.id, { views: data.views ?? video.views, likes: data.likes ?? video.likes, dislikes: data.dislikes ?? video.dislikes });
  } catch {
    // Counts stay as they were.
  }
}

app.get("/api/v1/videos/:id/description", async (c) => {
  const found = await findVideo(c, c.req.param("id"));
  if (!found) return fail(c, 404, "Video not found");
  return c.json({ description: found.post.contentSource });
});

for (const [path, body] of [
  ["captions", { total: 0, data: [] }],
  ["storyboards", { storyboards: [] }],
] as const) {
  app.get(`/api/v1/videos/:id/${path}`, (c) => c.json(body));
}
app.get("/api/v1/videos/:id/chapters", async (c) => {
  const found = await findVideo(c, c.req.param("id"));
  if (!found) return fail(c, 404, "Video not found");
  return c.json({ chapters: await videoChapters(c.env.bindings.DB, found.post.id) });
});

// The app sends chapters after an upload (an empty list when there are none).
app.put("/api/v1/videos/:id/chapters", async (c) => {
  const account = me(c);
  if (!account) return fail(c, 401, "Authentication is required.");
  const found = await findVideo(c, c.req.param("id"));
  if (!found) return fail(c, 404, "Video not found");
  if (found.post.accountId !== account.id || found.post.apId !== null) return fail(c, 403, "Cannot edit another user's video");
  const p = await params(c);
  const chapters = (Array.isArray(p.chapters) ? p.chapters : [])
    .map((x) => x as { timecode?: unknown; title?: unknown })
    .map((x) => ({ timecode: Math.max(0, Math.round(Number(x.timecode) || 0)), title: String(x.title ?? "").slice(0, 100) }))
    .filter((x) => x.title)
    .sort((a, b) => a.timecode - b.timecode)
    .slice(0, 100);
  await setVideoChapters(c.env.bindings.DB, found.post.id, chapters);
  return c.body(null, 204);
});

// A file's ffprobe metadata, which PeerTube links from each file. palm has no ffprobe: what it read from the MP4.
app.get("/api/v1/videos/:id/metadata/:fileId", async (c) => {
  const found = await findVideo(c, c.req.param("id"));
  if (!found) return fail(c, 404, "Video not found");
  return c.json({ streams: [], format: { duration: String(found.video.duration) } });
});

app.get("/api/v1/player-settings/videos/:id", (c) => c.json({ theme: "channel-default" }));
app.get("/api/v1/player-settings/video-channels/:handle", (c) => c.json({ theme: "instance-default" }));

app.post("/api/v1/videos/:id/views", async (c) => {
  const found = await findVideo(c, c.req.param("id"));
  if (!found) return fail(c, 404, "Video not found");
  const p = await params(c);
  const at = Number(p.currentTime ?? 0) || 0;
  const db = c.env.bindings.DB;
  const viewer = me(c);
  let first = at <= 5;
  if (viewer) {
    first = !(await watchPositions(db, viewer.id, [found.post.id])).has(found.post.id);
    await recordWatch(db, viewer.id, found.post.id, at);
  }
  // Views of local videos are counted here; other servers count their own.
  if (first && found.post.apId === null) await countView(db, found.post.id);
  return c.body(null, 204);
});

app.put("/api/v1/videos/:id/rate", async (c) => {
  const account = me(c);
  if (!account) return fail(c, 401, "Authentication is required.");
  const found = await findVideo(c, c.req.param("id"));
  if (!found) return fail(c, 404, "Video not found");
  const p = await params(c);
  const rating = str(p.rating);
  const score = rating === "like" ? 1 : rating === "dislike" ? -1 : rating === "none" ? 0 : null;
  if (score === null) return fail(c, 400, "Rating must be like, dislike or none");
  const db = c.env.bindings.DB;
  const previous = await currentVote(db, found.post.id, account.id);
  if (previous !== score) {
    await vote(db, found.post.id, account.id, score);
    c.env.activities.enqueue({ kind: "voted", postId: found.post.id, accountId: account.id, score, previous });
  }
  return c.body(null, 204);
});

// --- comments --------------------------------------------------------------------------------

/** A video's comments as PeerTube threads them: each top-level comment heads a thread. */
async function commentTree(c: C, post: Post) {
  const db = c.env.bindings.DB;
  // Other servers' comments that arrived before anyone here was watching.
  if (post.apId) await c.env.activities.backfillThread(post.id).catch(() => undefined);
  const comments = await videoComments(db, post.id);
  const authors = await accountsByIds(db, comments.map((x) => x.accountId));
  const children = new Map<number, typeof comments>();
  for (const comment of comments) {
    const parent = comment.parentId ?? post.id;
    children.set(parent, [...(children.get(parent) ?? []), comment]);
  }
  const descendants = (id: number): typeof comments => (children.get(id) ?? []).flatMap((x) => [x, ...descendants(x.id)]);
  const view = (comment: (typeof comments)[number], threadId: number) => {
    const below = descendants(comment.id).filter((x) => !x.deleted);
    const author = authors.get(comment.accountId);
    return author
      ? commentView(c.env, comment, author, post.id, threadId, { total: below.length, fromVideoAuthor: below.filter((x) => x.accountId === post.accountId).length })
      : null;
  };
  const tree = (comment: (typeof comments)[number], threadId: number): unknown => {
    const kids = children.get(comment.id) ?? [];
    return { comment: view(comment, threadId), children: kids.map((k) => tree(k, threadId)).filter((t) => (t as { comment: unknown }).comment), totalChildren: kids.length };
  };
  return { comments, children, view, tree };
}

app.get("/api/v1/videos/:id/comment-threads", async (c) => {
  const found = await findVideo(c, c.req.param("id"));
  if (!found) return fail(c, 404, "Video not found");
  const p = await params(c);
  const { start, count } = pageOf(p);
  const { comments, children, view } = await commentTree(c, found.post);
  let top = children.get(found.post.id) ?? [];
  // Deleted threads with no replies left are dropped, as PeerTube does.
  top = top.filter((x) => !x.deleted || (children.get(x.id)?.length ?? 0) > 0);
  const sort = str(p.sort) ?? "-createdAt";
  if (sort === "-createdAt") top = [...top].reverse();
  else if (sort === "-totalReplies") top = [...top].sort((a, b) => (children.get(b.id)?.length ?? 0) - (children.get(a.id)?.length ?? 0));
  return c.json({
    total: top.length,
    totalNotDeletedComments: comments.filter((x) => !x.deleted).length,
    data: top.slice(start, start + count).map((x) => view(x, x.id)).filter(Boolean),
  });
});

app.get("/api/v1/videos/:id/comment-threads/:threadId", async (c) => {
  const found = await findVideo(c, c.req.param("id"));
  if (!found) return fail(c, 404, "Video not found");
  const { comments, tree } = await commentTree(c, found.post);
  const head = comments.find((x) => x.id === Number(c.req.param("threadId")) && x.parentId === found.post.id);
  if (!head) return fail(c, 404, "Video comment thread not found");
  return c.json(tree(head, head.id));
});

app.get("/api/v1/videos/:id/comments/:commentId/replies", async (c) => {
  const found = await findVideo(c, c.req.param("id"));
  if (!found) return fail(c, 404, "Video not found");
  const p = await params(c);
  const { start, count } = pageOf(p);
  const { comments, children, tree } = await commentTree(c, found.post);
  const target = comments.find((x) => x.id === Number(c.req.param("commentId")));
  if (!target) return fail(c, 404, "Video comment not found");
  let threadId = target.id;
  for (let at: Post | undefined = target; at && at.parentId !== found.post.id; at = comments.find((x) => x.id === at!.parentId)) threadId = at.parentId ?? threadId;
  const kids = children.get(target.id) ?? [];
  return c.json({ total: kids.length, data: kids.slice(start, start + count).map((k) => tree(k, threadId)) });
});

async function addComment(c: C, videoId: string, parentId: number | null) {
  const account = me(c);
  if (!account) return fail(c, 401, "Authentication is required.");
  if (account.movedTo) return fail(c, 403, "This account has moved.");
  const found = await findVideo(c, videoId);
  if (!found) return fail(c, 404, "Video not found");
  if (!found.video.commentsEnabled) return fail(c, 409, "This video does not allow comments");
  const p = await params(c);
  const text = (str(p.text) ?? "").trim();
  if (!text || text.length > 10000) return fail(c, 400, "Comment text must be between 1 and 10,000 characters");
  const db = c.env.bindings.DB;
  let inReplyTo: Post = found.post;
  if (parentId !== null) {
    const parent = await postById(db, parentId);
    const comments = parent ? await videoComments(db, found.post.id) : [];
    if (!parent || !comments.some((x) => x.id === parent.id)) return fail(c, 404, "Video comment not found");
    inReplyTo = parent;
  }
  const parentAuthor = await accountById(db, inReplyTo.accountId);
  const agent = userAgentClient(c.req.header("user-agent"));
  const created = await createPost(db, {
    accountId: account.id,
    client: "peertube",
    clientApp: agent.app,
    clientDevice: agent.device,
    contentSource: text,
    contentHtml: markdownToHtml(text),
    spoilerText: "",
    sensitive: false,
    visibility: "public",
    language: null,
    inReplyTo: inReplyTo.apId ?? urls.object(parentAuthor?.domain ?? c.env.domain.domain, String(inReplyTo.id)),
    communityId: found.post.communityId,
    // In a channel (a community), a comment is a Lemmy comment on the video's thread.
    ...(found.post.communityId !== null ? { rootId: found.post.id } : {}),
    parentId: inReplyTo.id,
  });
  await vote(db, created.id, account.id, 1);
  // Mastodon notifies whoever a reply answers only when they're mentioned.
  if (found.post.communityId === null && parentAuthor && parentAuthor.id !== account.id) await addMentions(db, created.id, [parentAuthor.id]);
  c.env.activities.enqueue({ kind: "post_created", postId: created.id });
  const threadId = parentId === null ? created.id : await threadOf(c, found.post, created);
  return c.json({ comment: commentView(c.env, created, account, found.post.id, threadId, { total: 0, fromVideoAuthor: 0 }) });
}

async function threadOf(c: C, video: Post, comment: Post): Promise<number> {
  let at: Post | null = comment;
  for (let i = 0; at && at.parentId !== video.id && i < 30; i++) at = at.parentId ? await postById(c.env.bindings.DB, at.parentId) : null;
  return at?.id ?? comment.id;
}

app.post("/api/v1/videos/:id/comment-threads", (c) => addComment(c, c.req.param("id"), null));
app.post("/api/v1/videos/:id/comments/:commentId", (c) => addComment(c, c.req.param("id"), Number(c.req.param("commentId"))));

app.delete("/api/v1/videos/:id/comments/:commentId", async (c) => {
  const account = me(c);
  if (!account) return fail(c, 401, "Authentication is required.");
  const comment = await postByIdAny(c.env.bindings.DB, Number(c.req.param("commentId")));
  if (!comment || comment.deleted) return fail(c, 404, "Video comment not found");
  if (comment.accountId !== account.id) return fail(c, 403, "Cannot remove a video comment of another user");
  await deletePost(c.env.bindings.DB, comment.id);
  c.env.activities.enqueue({ kind: "post_deleted", postId: comment.id });
  return c.body(null, 204);
});

// --- channels and accounts ---------------------------------------------------------------------

app.get("/api/v1/video-channels", async (c) => {
  // Local channels: the communities here that hold videos.
  const db = c.env.bindings.DB;
  const p = await params(c);
  const { start, count } = pageOf(p);
  const { results } = await db
    .prepare(
      "SELECT DISTINCT v.channel_id AS id FROM videos v JOIN posts p ON p.id = v.post_id JOIN communities c ON c.id = v.channel_id WHERE c.ap_id IS NULL LIMIT 200",
    )
    .all<{ id: number }>();
  const communities = await communitiesByIds(db, results.map((r) => r.id));
  const all = [...communities.values()];
  const data = await Promise.all(all.slice(start, start + count).map((community) => renderChannel(c, { kind: "community", community })));
  return c.json({ total: all.length, data });
});

app.get("/api/v1/video-channels/:handle", async (c) => {
  const channel = await findChannel(c, c.req.param("handle"));
  if (!channel) return fail(c, 404, "Video channel not found");
  return c.json(await renderChannel(c, channel));
});

app.get("/api/v1/video-channels/:handle/videos", async (c) => {
  const channel = await findChannel(c, c.req.param("handle"));
  if (!channel) return fail(c, 404, "Video channel not found");
  const p = await params(c);
  const { start, count } = pageOf(p);
  const listed = await listVideos(c.env.bindings.DB, {
    ...(channel.kind === "community" ? { channelId: channel.community.id } : { accountId: channel.account.id }),
    start,
    count,
    sort: str(p.sort),
    ...filtersOf(c, p),
  });
  return c.json({ total: listed.total, data: await renderVideos(c, listed.data) });
});

for (const path of ["/api/v1/video-channels/:handle/video-playlists", "/api/v1/video-channels/:handle/followers", "/api/v1/accounts/:handle/video-channel-syncs", "/api/v1/accounts/:handle/followers", "/api/v1/accounts/:handle/ratings"]) {
  app.get(path, (c) => c.json({ total: 0, data: [] }));
}

app.get("/api/v1/accounts/:handle", async (c) => {
  const account = await findAccount(c, c.req.param("handle"));
  if (!account) return fail(c, 404, "Account not found");
  return c.json(accountView(c.env, account));
});

app.get("/api/v1/accounts/:handle/videos", async (c) => {
  const account = await findAccount(c, c.req.param("handle"));
  if (!account) return fail(c, 404, "Account not found");
  const p = await params(c);
  const { start, count } = pageOf(p);
  const listed = await listVideos(c.env.bindings.DB, { accountId: account.id, start, count, sort: str(p.sort), ...filtersOf(c, p) });
  return c.json({ total: listed.total, data: await renderVideos(c, listed.data) });
});

app.get("/api/v1/accounts/:handle/video-channels", async (c) => {
  const account = await findAccount(c, c.req.param("handle"));
  if (!account) return fail(c, 404, "Account not found");
  const db = c.env.bindings.DB;
  const ids = await channelsOf(db, account.id);
  const communities = [...(await communitiesByIds(db, ids)).values()];
  const channels: Channel[] = communities.map((community) => ({ kind: "community", community }));
  if (!channels.length) channels.push({ kind: "person", account });
  const data = await Promise.all(channels.map((ch) => renderChannel(c, ch)));
  return c.json({ total: data.length, data });
});

app.get("/api/v1/accounts/:handle/video-playlists", async (c) => {
  const account = await findAccount(c, c.req.param("handle"));
  const viewer = me(c);
  // Watch later is private: only its owner sees it.
  if (!account || !viewer || account.id !== viewer.id) return c.json({ total: 0, data: [] });
  return c.json({ total: 1, data: [await watchLaterView(c, viewer)] });
});

// --- search ------------------------------------------------------------------------------------

const looksRemote = (q: string) => /^https?:\/\//.test(q) || /^@?[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q);

app.get("/api/v1/search/videos", async (c) => {
  const p = await params(c);
  const q = (str(p.search) ?? "").trim();
  const { start, count } = pageOf(p);
  const db = c.env.bindings.DB;
  if (/^https?:\/\//.test(q)) {
    // A watch link (PeerTube's /w/{shortUUID} or /videos/watch/{uuid}): look it up there.
    const found = me(c) ? await c.env.activities.resolve(q).catch(() => null) : null;
    const video = found?.kind === "post" ? await videoByPostId(db, found.id) : null;
    const post = video ? await postById(db, video.postId) : null;
    if (!video || !post) return c.json({ total: 0, data: [] });
    return c.json({ total: 1, data: await renderVideos(c, [{ post, video }]) });
  }
  const listed = await listVideos(db, { search: q, start, count, sort: str(p.sort) === "-match" ? undefined : str(p.sort), ...filtersOf(c, p) });
  return c.json({ total: listed.total, data: await renderVideos(c, listed.data) });
});

app.get("/api/v1/search/video-channels", async (c) => {
  const p = await params(c);
  const q = (str(p.search) ?? "").trim();
  const { start, count } = pageOf(p);
  if (looksRemote(q)) {
    const handle = q.replace(/^https?:\/\/([^/]+)\/(?:video-channels|c|a)\/([^/?#]+).*$/, "$2@$1");
    const channel = me(c) || !/[@/]/.test(handle) ? await findChannel(c, handle) : await findChannel(c, handle, false);
    return c.json(channel ? { total: 1, data: [await renderChannel(c, channel)] } : { total: 0, data: [] });
  }
  if (!q) return c.json({ total: 0, data: [] });
  const db = c.env.bindings.DB;
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const { results } = await db
    .prepare(
      `SELECT DISTINCT c.id FROM communities c JOIN videos v ON v.channel_id = c.id
       WHERE c.name LIKE ? OR c.title LIKE ? LIMIT 100`,
    )
    .bind(like, like)
    .all<{ id: number }>();
  const communities = [...(await communitiesByIds(db, results.map((r) => r.id))).values()];
  const data = await Promise.all(communities.slice(start, start + count).map((community) => renderChannel(c, { kind: "community", community })));
  return c.json({ total: communities.length, data });
});

app.get("/api/v1/search/video-playlists", (c) => c.json({ total: 0, data: [] }));

// --- the rest: empty, as a new server answers -------------------------------------------------

app.get("/api/v1/overviews/videos", (c) => c.json({ categories: [], channels: [], tags: [] }));
app.get("/api/v1/blocklist/status", (c) => c.json({ accounts: {}, hosts: {} }));
app.get("/api/v1/custom-pages/homepage/instance", (c) => fail(c, 404, "Custom page not found"));
app.get("/api/v1/plugins/registered-auths", (c) => c.json({ registeredExternalAuths: [], registeredIdAndPassAuths: [] }));
app.get("/api/v1/server/redundancy/videos", (c) => c.json({ total: 0, data: [] }));
for (const path of ["/api/v1/server/following", "/api/v1/server/followers"]) app.get(path, (c) => c.json({ total: 0, data: [] }));

// Watch links, as PeerTube's apps share them: to the video's page (palm's own, or its server's).
const watchRedirect = async (c: C, id: string) => {
  const found = await findVideo(c, id);
  if (!found) return c.text("Video not found", 404);
  const author = await accountById(c.env.bindings.DB, found.post.accountId);
  const target = found.post.apId
    ? (found.post.linkUrl ?? found.post.url ?? found.post.apId)
    : `https://${c.env.domain.domain}/@${encodeURIComponent(author?.username ?? "")}/${found.post.id}`;
  return c.redirect(target, 302);
};
// A local video's HLS master playlist, written from the renditions runners made.
app.get("/static/streaming-playlists/hls/:uuid/master.m3u8", async (c) => {
  const video = isUuid(c.req.param("uuid")) ? await videoByUuid(c.env.bindings.DB, c.req.param("uuid")) : null;
  const text = video ? masterPlaylist(video) : null;
  if (!text) return c.text("Not found", 404);
  return c.body(text, 200, { "content-type": "application/vnd.apple.mpegurl", "cache-control": "public, max-age=60", "access-control-allow-origin": "*" });
});

// The app loads PeerTube's server-string translations; palm's labels are English already.
app.get("/client/locales/:lang/server.json", (c) => c.json({}, 200, { "cache-control": "public, max-age=86400" }));
app.get("/w/:id", (c) => watchRedirect(c, c.req.param("id")));
app.get("/videos/watch/:id", (c) => watchRedirect(c, c.req.param("id")));
app.get("/videos/embed/:id", (c) => watchRedirect(c, c.req.param("id")));

app.all("/api/*", (c) => {
  console.warn(JSON.stringify({ palm: "unknown_endpoint", api: "peertube", method: c.req.method, path: c.req.path }));
  return fail(c, 404, "Not found");
});

app.notFound((c) => fail(c, 404, "Not found"));

/** Serves one request from a PeerTube app. */
export function handlePeerTube(request: Request, ctx: RequestContext): Promise<Response> {
  return Promise.resolve(app.fetch(request, ctx));
}

/** The top-level paths of PeerTube's API under /api/v1 that Mastodon's doesn't use. */
const PEERTUBE_SECTIONS = new Set([
  "server",
  "abuses",
  "bulk",
  "oauth-clients",
  "config",
  "users",
  "video-channels",
  "video-channel-syncs",
  "video-playlists",
  "videos",
  "jobs",
  "metrics",
  "overviews",
  "recommendations",
  "player-settings",
  "plugins",
  "custom-pages",
  "blocklist",
  "runners",
  "watched-words",
  "automatic-tags",
  "client-config",
  "ping",
]);

/** Mastodon's own words after /api/v1/accounts/; anything else there (a name, not a number) is PeerTube's. */
const MASTODON_ACCOUNT_WORDS = new Set(["verify_credentials", "update_credentials", "lookup", "search", "relationships", "familiar_followers"]);

/**
 * Whether a request on the bare domain is for PeerTube's API. PeerTube shares
 * /api/v1 with Mastodon, but their paths don't overlap: PeerTube's sections
 * (videos, users, video-channels...) aren't Mastodon's, and its accounts are
 * named where Mastodon's are numbered.
 */
export function isPeerTubePath(path: string): boolean {
  const match = /^\/api\/v1\/([^/]+)(?:\/([^/]+))?/.exec(path);
  if (!match) return false;
  const [, section, next] = match;
  if (PEERTUBE_SECTIONS.has(section!)) return true;
  if (section === "search") return next === "videos" || next === "video-channels" || next === "video-playlists";
  if (section === "accounts") return next !== undefined && !/^\d+$/.test(next) && !MASTODON_ACCOUNT_WORDS.has(next);
  return false;
}
