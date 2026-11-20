import { urls, type RequestContext } from "@palm/core";
import type { Account, Community, Post, Video, VideoFile } from "@palm/db";
import { CATEGORIES, label, LANGUAGES, LICENCES, PRIVACIES, STATES } from "./labels.ts";
import { toShortUuid } from "./short-uuid.ts";

/**
 * PeerTube's JSON shapes (packages/models in PeerTube's repository), built
 * from palm's rows. Only what apps read; the rest is PeerTube's defaults.
 */

/** The PeerTube version palm answers as: the current stable series. */
export const PEERTUBE_VERSION = "8.2.0";

/** Channels made up for people with no channel of their own sit above this, as Lemmy's person communities do. */
export const PERSON_CHANNEL_BASE = 1_000_000_000;

const iso = (seconds: number | null | undefined) => new Date((seconds ?? 0) * 1000).toISOString();

/** A picture, as PeerTube lists avatars and banners. Other servers' come through palm's media cache. */
export function images(ctx: RequestContext, url: string | null, local: boolean, width = 120) {
  if (!url) return [];
  const fileUrl = local ? url : urls.proxy(ctx.domain.domain, url);
  const at = new URL(fileUrl);
  return [{ width, height: width, path: at.pathname + at.search, fileUrl, createdAt: iso(0), updatedAt: iso(0) }];
}

export function accountView(ctx: RequestContext, a: Account, counts?: { followers?: number; following?: number }) {
  const local = a.apId === null;
  return {
    id: a.id,
    url: a.apId ?? urls.user(a.domain, a.username),
    name: a.username,
    host: a.domain,
    followingCount: counts?.following ?? a.remoteCounts.following ?? 0,
    followersCount: counts?.followers ?? a.remoteCounts.followers ?? 0,
    createdAt: iso(a.createdAt),
    updatedAt: iso(a.fetchedAt ?? a.createdAt),
    avatars: images(ctx, a.avatarUrl, local),
    avatar: images(ctx, a.avatarUrl, local)[0] ?? null,
    hostRedundancyAllowed: false,
    displayName: a.displayName || a.username,
    description: a.bio ? a.bio.replace(/<[^>]+>/g, "") : "",
    ...(local ? { userId: a.id } : {}),
  };
}

export const accountSummary = (ctx: RequestContext, a: Account) => {
  const full = accountView(ctx, a);
  return { id: full.id, name: full.name, displayName: full.displayName, url: full.url, host: full.host, avatars: full.avatars };
};

/** A channel: a Group palm keeps as a community, or a person's own stand-in when their video names none. */
export type Channel = { kind: "community"; community: Community } | { kind: "person"; account: Account };

export function channelView(ctx: RequestContext, channel: Channel, extra: { owner?: Account | null; videosCount?: number; followers?: number } = {}) {
  if (channel.kind === "person") {
    const a = accountView(ctx, channel.account);
    return {
      ...a,
      id: PERSON_CHANNEL_BASE + channel.account.id,
      support: "",
      hostRedundancyAllowed: false,
      isLocal: channel.account.apId === null,
      banners: [],
      ownerAccount: a,
      ...(extra.videosCount !== undefined ? { videosCount: extra.videosCount } : {}),
    };
  }
  const c = channel.community;
  const local = c.apId === null;
  return {
    id: c.id,
    url: c.apId ?? urls.community(c.domain, c.name),
    name: c.name,
    host: c.domain,
    followingCount: 0,
    followersCount: extra.followers ?? 0,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.fetchedAt ?? c.createdAt),
    avatars: images(ctx, c.iconUrl, local),
    avatar: images(ctx, c.iconUrl, local)[0] ?? null,
    banners: images(ctx, c.bannerUrl, local, 1920),
    displayName: c.title || c.name,
    description: c.description ? c.description.replace(/<[^>]+>/g, "") : "",
    support: "",
    hostRedundancyAllowed: false,
    isLocal: local,
    ...(extra.owner ? { ownerAccount: accountView(ctx, extra.owner) } : {}),
    ...(extra.videosCount !== undefined ? { videosCount: extra.videosCount } : {}),
  };
}

export const channelSummary = (ctx: RequestContext, channel: Channel) => {
  const full = channelView(ctx, channel);
  return { id: full.id, name: full.name, displayName: full.displayName, url: full.url, host: full.host, avatars: full.avatars };
};

/** A channel's handle, as PeerTube writes it: name@host. */
export const channelHandle = (channel: Channel) =>
  channel.kind === "person" ? `${channel.account.username}@${channel.account.domain}` : `${channel.community.name}@${channel.community.domain}`;

const privacyOf = (post: Post) => (post.visibility === "public" ? 1 : post.visibility === "unlisted" ? 2 : 3);

/** The page a video is watched at: its server's for other servers' videos, palm's own for local ones. */
export const watchUrl = (ctx: RequestContext, post: Post, video: Video) =>
  post.apId ? (post.linkUrl ?? post.url ?? post.apId) : `https://${ctx.domain.domain}/videos/watch/${video.uuid}`;

const aspect = (w: number | null, h: number | null) => {
  if (!w || !h) return "16:9";
  const r = w / h;
  return r > 1.7 ? "16:9" : r > 1.55 ? "16:10" : r > 1.3 ? "4:3" : r > 1.1 ? "5:4" : "1:1";
};

function thumbnailsOf(ctx: RequestContext, post: Post, video: Video) {
  return video.thumbnails.map((t) => {
    const fileUrl = post.apId ? urls.proxy(ctx.domain.domain, t.url) : t.url;
    return { width: t.width ?? 0, height: t.height ?? 0, aspectRatio: aspect(t.width, t.height), fileUrl };
  });
}

const pathOf = (url: string | undefined) => {
  if (!url) return null;
  const at = new URL(url);
  return at.pathname + at.search;
};

/** Per viewer and per video: what palm counted beside what the video's server counted. */
export interface VideoExtras {
  likes?: number | undefined;
  dislikes?: number | undefined;
  comments?: number | undefined;
  /** Where the viewer stopped watching, in seconds. */
  watchedTo?: number | undefined;
}

export function videoView(ctx: RequestContext, post: Post, video: Video, author: Account, channel: Channel, extras: VideoExtras = {}) {
  const thumbnails = thumbnailsOf(ctx, post, video);
  const small = thumbnails[0];
  const large = thumbnails.at(-1);
  const description = post.contentSource ?? "";
  const url = watchUrl(ctx, post, video);
  return {
    id: post.id,
    uuid: video.uuid,
    shortUUID: toShortUuid(video.uuid),
    isLocal: post.apId === null,
    url,
    name: post.title ?? description.split("\n")[0]?.slice(0, 120) ?? "",
    category: label(CATEGORIES, video.category),
    licence: label(LICENCES, video.licence),
    language: label(LANGUAGES, video.language),
    privacy: label(PRIVACIES, privacyOf(post)),
    description: description.slice(0, 250),
    truncatedDescription: description.length > 250 ? `${description.slice(0, 247)}...` : description,
    duration: video.duration,
    aspectRatio: video.aspectRatio,
    isLive: video.isLive,
    thumbnails,
    thumbnailPath: pathOf(small?.fileUrl),
    thumbnailUrl: small?.fileUrl ?? null,
    previewPath: pathOf(large?.fileUrl),
    previewUrl: large?.fileUrl ?? null,
    embedPath: `/videos/embed/${toShortUuid(video.uuid)}`,
    embedUrl: video.embedUrl ?? `https://${ctx.domain.domain}/videos/embed/${video.uuid}`,
    createdAt: iso(post.createdAt),
    updatedAt: iso(post.updatedAt ?? post.createdAt),
    publishedAt: iso(post.createdAt),
    originallyPublishedAt: video.originallyPublishedAt ? iso(video.originallyPublishedAt) : null,
    views: video.views,
    viewers: 0,
    downloads: 0,
    likes: Math.max(video.likes, extras.likes ?? 0),
    dislikes: Math.max(video.dislikes, extras.dislikes ?? 0),
    comments: extras.comments ?? 0,
    nsfw: post.sensitive,
    nsfwFlags: 0,
    nsfwSummary: post.spoilerText || null,
    aiUsage: { id: 0, label: "Not specified" },
    commercialContent: { id: 0, label: "None" },
    recommendationScope: { id: 1, label: "All" },
    state: label(STATES, video.state),
    waitTranscoding: false,
    account: accountSummary(ctx, author),
    channel: channelSummary(ctx, channel),
    ...(extras.watchedTo !== undefined ? { userHistory: { currentTime: extras.watchedTo } } : {}),
  };
}

/**
 * A playable file, with every field a PeerTube server sends. palm makes no
 * torrents, but apps read these as strings, so they're empty rather than null.
 */
function fileView(ctx: RequestContext, video: Video, file: VideoFile, i: number, downloadable: boolean) {
  const ratio = video.aspectRatio ?? 16 / 9;
  const width = file.width ?? (file.height ? Math.round((file.height * (ratio >= 1 ? ratio : 1)) / 2) * 2 : 0);
  return {
    id: i + 1,
    resolution: { id: file.height, label: file.height ? `${file.height}p` : "Audio" },
    size: file.size,
    width,
    height: file.height,
    torrentUrl: "",
    torrentDownloadUrl: "",
    fileUrl: file.url,
    fileDownloadUrl: downloadable ? file.url : "",
    fps: file.fps,
    metadataUrl: `https://${ctx.domain.domain}/api/v1/videos/${video.uuid}/metadata/${i + 1}`,
    magnetUri: "",
    hasAudio: true,
    hasVideo: file.height > 0,
    storage: 0,
  };
}

export function videoDetails(
  ctx: RequestContext,
  post: Post,
  video: Video,
  author: Account,
  channel: Channel,
  extras: VideoExtras & { tags?: string[]; owner?: Account | null } = {},
) {
  const base = videoView(ctx, post, video, author, channel, extras);
  const playlist = video.hls;
  return {
    ...base,
    description: post.contentSource ?? "",
    support: video.support ?? "",
    liveSchedules: [],
    account: accountView(ctx, author),
    channel: channelView(ctx, channel, { owner: extras.owner ?? author }),
    tags: extras.tags ?? [],
    commentsEnabled: video.commentsEnabled,
    commentsPolicy: video.commentsEnabled ? { id: 1, label: "Enabled" } : { id: 2, label: "Disabled" },
    downloadEnabled: video.downloadEnabled,
    trackerUrls: [],
    inputFileUpdatedAt: null,
    embedPrivacyPolicy: { id: 1, label: "All allowed" },
    blacklisted: false,
    blacklistedReason: null,
    files: video.files.map((f, i) => fileView(ctx, video, f, i, video.downloadEnabled)),
    streamingPlaylists: playlist
      ? [
          {
            id: 1,
            type: 1,
            playlistUrl: playlist.url,
            segmentsSha256Url: playlist.segmentsSha256Url,
            redundancies: [],
            files: playlist.files.map((f, i) => ({ ...fileView(ctx, video, f, i + video.files.length, video.downloadEnabled), playlistUrl: f.playlistUrl ?? playlist.url })),
          },
        ]
      : [],
  };
}

export function commentView(
  ctx: RequestContext,
  comment: Post & { deleted?: boolean },
  author: Account,
  videoPostId: number,
  threadId: number,
  replies: { total: number; fromVideoAuthor: number },
) {
  const deleted = comment.deleted === true;
  return {
    id: comment.id,
    url: comment.apId ?? urls.object(ctx.domain.domain, String(comment.id)),
    text: deleted ? "" : (comment.contentSource ?? ""),
    threadId,
    inReplyToCommentId: comment.parentId === videoPostId ? null : comment.parentId,
    videoId: videoPostId,
    createdAt: iso(comment.createdAt),
    updatedAt: iso(comment.updatedAt ?? comment.createdAt),
    deletedAt: deleted ? iso(comment.updatedAt ?? comment.createdAt) : null,
    isDeleted: deleted,
    totalRepliesFromVideoAuthor: replies.fromVideoAuthor,
    totalReplies: replies.total,
    account: deleted ? null : accountView(ctx, author),
    heldForReview: false,
  };
}

/** The signed-in person, as PeerTube's /users/me answers. */
export function userView(
  ctx: RequestContext,
  a: Account,
  extra: { channels: ReturnType<typeof channelView>[]; watchLaterId: number; quota: number; quotaUsed: number; counts: { followers: number; following: number } },
) {
  return {
    id: a.id,
    username: a.username,
    email: `${a.username}@${a.domain}`,
    pendingEmail: null,
    emailVerified: true,
    nsfwPolicy: "blur",
    nsfwFlagsDisplayed: 0,
    nsfwFlagsHidden: 0,
    nsfwFlagsBlurred: 0,
    nsfwFlagsWarned: 0,
    aiUsagesHidden: [],
    adminFlags: 0,
    autoPlayVideo: true,
    autoPlayNextVideo: false,
    autoPlayNextVideoPlaylist: true,
    p2pEnabled: false,
    videosHistoryEnabled: true,
    videoLanguages: null,
    videoCategories: null,
    videoLive: "both",
    language: "en",
    role: a.role === "admin" ? { id: 0, label: "Administrator" } : { id: 2, label: "User" },
    videoQuota: extra.quota,
    videoQuotaDaily: -1,
    videoQuotaUsed: extra.quotaUsed,
    videoQuotaUsedDaily: 0,
    theme: "instance-default",
    account: accountView(ctx, a, extra.counts),
    notificationSettings: notificationSettings(),
    videoChannels: extra.channels.map((c) => ({ ...c, ownerAccountId: a.id, ownerAccountName: a.username })),
    videoChannelCollaborations: [],
    blocked: a.banned,
    blockedReason: null,
    noInstanceConfigWarningModal: true,
    noWelcomeModal: true,
    noAccountSetupWarningModal: true,
    createdAt: iso(a.createdAt),
    pluginAuth: null,
    lastLoginDate: new Date().toISOString(),
    twoFactorEnabled: false,
    newFeaturesInfoRead: 100,
    specialPlaylists: [{ id: extra.watchLaterId, name: "Watch later", type: 2 }],
  };
}

/** Every notification kind off: palm's notifications reach people through their Lemmy and Mastodon apps. */
export function notificationSettings() {
  const none = 0;
  return Object.fromEntries(
    [
      "abuseAsModerator",
      "videoAutoBlacklistAsModerator",
      "newVideoFromSubscription",
      "blacklistOnMyVideo",
      "myVideoPublished",
      "myVideoImportFinished",
      "commentMention",
      "newCommentOnMyVideo",
      "newUserRegistration",
      "newFollow",
      "newInstanceFollower",
      "autoInstanceFollowing",
      "abuseStateChange",
      "abuseNewMessage",
      "newPeerTubeVersion",
      "newPluginVersion",
      "myVideoStudioEditionFinished",
      "myVideoTranscriptionGenerated",
    ].map((k) => [k, none]),
  );
}
