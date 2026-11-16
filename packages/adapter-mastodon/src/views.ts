import type { RequestContext } from "@palm/core";
import { urls } from "@palm/core";
import type { Account } from "@palm/db";

/**
 * Mastodon's JSON shapes, hand-written from the API docs
 * (docs.joinmastodon.org/entities). Only the fields apps rely on.
 */

/** The Mastodon version palm reports, in the form compatible servers use. */
export const MASTODON_VERSION = "4.3.0";
export const versionString = (palmVersion: string) => `${MASTODON_VERSION} (compatible; palm ${palmVersion})`;

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
// Mastodon reports account creation as midnight UTC on the day.
const day = (seconds: number) => `${new Date(seconds * 1000).toISOString().slice(0, 10)}T00:00:00.000Z`;

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The placeholder avatar and header every account has until uploads exist. */
export const avatarUrl = (host: string) => `https://${host}/palm/avatar.png`;

/** Counts shown on a profile. Left out, they read as zero. */
export interface AccountStats {
  statuses: number;
  followers: number;
  lastStatusAt: number | null;
}

/**
 * An account's profile page, on the API host as Mastodon does it. Apps rely on
 * this: the Mastodon iOS app finds the signed-in account by matching this
 * URL's host to the server it signed in to. The ActivityPub ID is `uri`.
 */
export const profileUrl = (ctx: RequestContext, username: string) => `https://${ctx.host}/@${encodeURIComponent(username)}`;

export function account(ctx: RequestContext, a: Account, stats?: AccountStats) {
  return {
    id: String(a.id),
    username: a.username,
    acct: a.username,
    display_name: a.displayName ?? a.username,
    locked: false,
    bot: false,
    discoverable: true,
    indexable: false,
    group: false,
    created_at: day(a.createdAt),
    note: a.bio ? `<p>${escapeHtml(a.bio)}</p>` : "",
    url: profileUrl(ctx, a.username),
    uri: urls.user(ctx.domain.domain, a.username),
    avatar: avatarUrl(ctx.host),
    avatar_static: avatarUrl(ctx.host),
    header: avatarUrl(ctx.host),
    header_static: avatarUrl(ctx.host),
    followers_count: stats?.followers ?? 0,
    following_count: 0,
    statuses_count: stats?.statuses ?? 0,
    last_status_at: stats?.lastStatusAt ? iso(stats.lastStatusAt).slice(0, 10) : null,
    hide_collections: false,
    noindex: true,
    emojis: [],
    roles: [],
    fields: [],
  };
}

export function credentialAccount(ctx: RequestContext, a: Account, stats?: AccountStats) {
  return {
    ...account(ctx, a, stats),
    source: {
      privacy: "public",
      sensitive: false,
      language: "",
      note: a.bio ?? "",
      fields: [],
      follow_requests_count: 0,
      hide_collections: false,
      discoverable: true,
      indexable: false,
    },
    role:
      a.role === "admin"
        ? { id: "3", name: "Owner", color: "", permissions: "1", highlighted: true }
        : { id: "-99", name: "", color: "", permissions: "0", highlighted: false },
  };
}

const configuration = (host: string) => ({
  urls: { streaming: `wss://${host}` },
  vapid: { public_key: "" },
  accounts: { max_featured_tags: 10, max_pinned_statuses: 5 },
  statuses: { max_characters: 5000, max_media_attachments: 4, characters_reserved_per_url: 23 },
  media_attachments: {
    supported_mime_types: ["image/jpeg", "image/png", "image/gif", "image/webp"],
    image_size_limit: 10_485_760,
    image_matrix_limit: 16_777_216,
    video_size_limit: 0,
    video_frame_rate_limit: 0,
    video_matrix_limit: 0,
  },
  polls: { max_options: 4, max_characters_per_option: 50, min_expiration: 300, max_expiration: 2_629_746 },
  translation: { enabled: false },
});

export function instanceV2(ctx: RequestContext, palmVersion: string, users: number) {
  const { instance } = ctx.config;
  return {
    domain: ctx.domain.domain,
    title: instance.name,
    version: versionString(palmVersion),
    source_url: "https://github.com/jason-s13r/palm",
    description: instance.description ?? "",
    usage: { users: { active_month: users } },
    thumbnail: { url: avatarUrl(ctx.host) },
    icon: [],
    languages: ["en"],
    configuration: configuration(ctx.host),
    registrations: { enabled: false, approval_required: false, message: null, url: null },
    api_versions: { mastodon: 2 },
    contact: { email: instance.contact ?? "", account: null },
    rules: [],
  };
}

export function instanceV1(ctx: RequestContext, palmVersion: string, users: number) {
  const { instance } = ctx.config;
  return {
    uri: ctx.domain.domain,
    title: instance.name,
    short_description: instance.description ?? "",
    description: instance.description ?? "",
    email: instance.contact ?? "",
    version: versionString(palmVersion),
    urls: { streaming_api: `wss://${ctx.host}` },
    stats: { user_count: users, status_count: 0, domain_count: 0 },
    thumbnail: avatarUrl(ctx.host),
    languages: ["en"],
    registrations: false,
    approval_required: false,
    invites_enabled: false,
    configuration: configuration(ctx.host),
    contact_account: null,
    rules: [],
  };
}

export { escapeHtml, iso };
