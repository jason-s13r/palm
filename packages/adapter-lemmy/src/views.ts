import type { RequestContext } from "@palm/core";
import { htmlToText, urls } from "@palm/core";
import type { Account, Community as StoredCommunity, CommunityStats, ThreadComment, ThreadPost } from "@palm/db";
import type {
  Comment,
  CommentView,
  Community,
  CommunityView,
  Post,
  PostView,
  LocalSite,
  LocalSiteRateLimit,
  LocalUserView,
  MyUserInfo,
  Person,
  PersonView,
  Site,
  SiteView,
} from "lemmy-js-client";

/**
 * Builders for Lemmy's JSON shapes, typed against lemmy-js-client 0.19 so a
 * missing field fails the typecheck rather than an app.
 */

/** The Lemmy version palm reports in the site. Apps gate features on it. */
export { LEMMY_COMPAT_VERSION as LEMMY_VERSION } from "@palm/core";

/** palm is one Lemmy "instance" per domain; Lemmy numbers its own as 1. */
const LOCAL_INSTANCE_ID = 1;

/**
 * Lemmy numbers every instance it knows; palm doesn't keep a table of them,
 * so a remote host gets a stable number from its name. Apps only compare them.
 */
export function instanceId(host: string): number {
  let hash = 0;
  for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return 2 + (Math.abs(hash) % 1_000_000_000);
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

export function person(ctx: RequestContext, account: Account): Person {
  const local = account.apId === null;
  return {
    id: account.id,
    name: account.username,
    ...(account.displayName ? { display_name: account.displayName } : {}),
    ...(account.bio ? { bio: local ? account.bio : htmlToText(account.bio) } : {}),
    ...(account.avatarUrl ? { avatar: account.avatarUrl } : {}),
    ...(account.headerUrl ? { banner: account.headerUrl } : {}),
    banned: false,
    published: iso(account.createdAt),
    actor_id: account.apId ?? urls.user(account.domain, account.username),
    local,
    deleted: false,
    bot_account: account.actorType === "Service",
    instance_id: local ? LOCAL_INSTANCE_ID : instanceId(account.domain),
  };
}

/** Lemmy's post and comment counts for a person. */
export interface PersonCounts {
  posts: number;
  comments: number;
}

export function personView(ctx: RequestContext, account: Account, counts?: PersonCounts): PersonView {
  return {
    person: person(ctx, account),
    counts: { person_id: account.id, post_count: counts?.posts ?? 0, comment_count: counts?.comments ?? 0 },
    is_admin: account.role === "admin",
  };
}

export interface SiteCounts {
  users: number;
  posts: number;
  comments: number;
  communities: number;
}

export function siteView(ctx: RequestContext, counts: SiteCounts): SiteView {
  const domain = ctx.domain.domain;
  const published = iso(0);
  const site: Site = {
    id: 1,
    name: ctx.config.instance.name,
    ...(ctx.config.instance.description ? { description: ctx.config.instance.description } : {}),
    published,
    actor_id: `https://${domain}/`,
    last_refreshed_at: published,
    inbox_url: urls.inbox(domain),
    public_key: "",
    instance_id: LOCAL_INSTANCE_ID,
  };
  const localSite: LocalSite = {
    id: 1,
    site_id: 1,
    site_setup: true,
    enable_downvotes: true,
    enable_nsfw: false,
    community_creation_admin_only: true,
    require_email_verification: false,
    private_instance: false,
    default_theme: "browser",
    default_post_listing_type: "Subscribed",
    hide_modlog_mod_names: true,
    application_email_admins: false,
    actor_name_max_length: 20,
    federation_enabled: true,
    captcha_enabled: false,
    captcha_difficulty: "medium",
    published,
    // With invites, sign-up asks for the code as Lemmy's "application" answer.
    ...(ctx.config.registration === "invite"
      ? { registration_mode: "RequireApplication" as const, application_question: "Your invite code" }
      : { registration_mode: "Closed" as const }),
    reports_email_admins: false,
    federation_signed_fetch: true,
    default_post_listing_mode: "List",
    default_sort_type: "Active",
  };
  const rateLimit: LocalSiteRateLimit = {
    local_site_id: 1,
    message: 180,
    message_per_second: 60,
    post: 6,
    post_per_second: 600,
    register: 3,
    register_per_second: 3600,
    image: 6,
    image_per_second: 3600,
    comment: 6,
    comment_per_second: 600,
    search: 60,
    search_per_second: 600,
    published,
    import_user_settings: 1,
    import_user_settings_per_second: 86400,
  };
  return {
    site,
    local_site: localSite,
    local_site_rate_limit: rateLimit,
    counts: {
      site_id: 1,
      users: counts.users,
      posts: counts.posts,
      comments: counts.comments,
      communities: counts.communities,
      users_active_day: 0,
      users_active_week: 0,
      users_active_month: 0,
      users_active_half_year: 0,
    },
  };
}

export function localUserView(ctx: RequestContext, account: Account): LocalUserView {
  return {
    local_user: {
      id: account.id,
      person_id: account.id,
      show_nsfw: false,
      theme: "browser",
      default_sort_type: "Active",
      default_listing_type: "Subscribed",
      interface_language: "browser",
      show_avatars: true,
      send_notifications_to_email: false,
      show_scores: true,
      show_bot_accounts: true,
      show_read_posts: true,
      email_verified: false,
      accepted_application: true,
      open_links_in_new_tab: false,
      blur_nsfw: true,
      auto_expand: false,
      infinite_scroll_enabled: true,
      admin: account.role === "admin",
      post_listing_mode: "List",
      totp_2fa_enabled: false,
      enable_keyboard_navigation: false,
      enable_animated_images: true,
      collapse_bot_comments: false,
    },
    local_user_vote_display_mode: {
      local_user_id: account.id,
      score: true,
      upvotes: true,
      downvotes: true,
      upvote_percentage: false,
    },
    person: person(ctx, account),
    counts: { person_id: account.id, post_count: 0, comment_count: 0 },
  };
}

export interface Blocks {
  people: Account[];
  communities: StoredCommunity[];
  domains: string[];
}

export function myUserInfo(
  ctx: RequestContext,
  account: Account,
  follows: StoredCommunity[] = [],
  blocks: Blocks = { people: [], communities: [], domains: [] },
): MyUserInfo {
  const follower = person(ctx, account);
  return {
    local_user_view: localUserView(ctx, account),
    follows: follows.map((c) => ({ community: community(ctx, c), follower })),
    moderates: [],
    community_blocks: blocks.communities.map((c) => ({ person: follower, community: community(ctx, c) })),
    instance_blocks: blocks.domains.map((domain) => ({ person: follower, instance: { id: instanceId(domain), domain, published: iso(0) } })),
    person_blocks: blocks.people.map((p) => ({ person: follower, target: person(ctx, p) })),
    discussion_languages: [],
  };
}

export function community(ctx: RequestContext, c: StoredCommunity): Community {
  const local = c.apId === null;
  return {
    id: c.id,
    name: c.name,
    title: c.title,
    ...(c.description ? { description: local ? c.description : htmlToText(c.description) } : {}),
    ...(c.iconUrl ? { icon: c.iconUrl } : {}),
    ...(c.bannerUrl ? { banner: c.bannerUrl } : {}),
    removed: false,
    published: iso(c.createdAt),
    deleted: false,
    nsfw: c.nsfw,
    actor_id: c.apId ?? urls.community(c.domain, c.name),
    local,
    hidden: false,
    posting_restricted_to_mods: false,
    instance_id: local ? LOCAL_INSTANCE_ID : instanceId(c.domain),
    visibility: "Public",
  };
}

/** Lemmy's subscription states. */
const subscribedType = (s: { subscribed: boolean; pending?: boolean }) =>
  s.subscribed ? ("Subscribed" as const) : s.pending ? ("Pending" as const) : ("NotSubscribed" as const);

export function communityView(ctx: RequestContext, c: StoredCommunity & CommunityStats): CommunityView {
  return {
    community: community(ctx, c),
    subscribed: subscribedType(c),
    blocked: false,
    banned_from_community: false,
    counts: {
      community_id: c.id,
      subscribers: c.subscribers,
      subscribers_local: c.subscribers,
      posts: c.posts,
      comments: c.comments,
      published: iso(c.createdAt),
      users_active_day: 0,
      users_active_week: 0,
      users_active_month: 0,
      users_active_half_year: 0,
    },
  };
}

/** Everything a post or comment view needs besides the post itself. */
export interface ThreadContext {
  creator: Account;
  community: StoredCommunity;
  subscribed: boolean;
  pending: boolean;
}

/** A post's or comment's ActivityPub ID. */
const apIdOf = (p: { apId: string | null; id: number }, author: Account) => p.apId ?? urls.object(author.domain, String(p.id));

export function post(ctx: RequestContext, p: ThreadPost, creator?: Account): Post {
  return {
    id: p.id,
    name: p.title ?? "",
    ...(p.linkUrl ? { url: p.linkUrl } : {}),
    // Apps show an image link as the post's picture.
    ...(p.linkUrl && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(p.linkUrl) ? { thumbnail_url: p.linkUrl } : {}),
    ...(p.contentSource ? { body: p.contentSource } : {}),
    creator_id: p.accountId,
    community_id: p.communityId ?? 0,
    removed: false,
    locked: false,
    published: iso(p.createdAt),
    ...(p.updatedAt ? { updated: iso(p.updatedAt) } : {}),
    deleted: false,
    nsfw: p.sensitive,
    ap_id: creator ? apIdOf(p, creator) : (p.apId ?? urls.object(ctx.domain.domain, String(p.id))),
    local: p.apId === null,
    language_id: 0,
    featured_community: false,
    featured_local: false,
  };
}

export function postView(ctx: RequestContext, p: ThreadPost, t: ThreadContext): PostView {
  return {
    post: post(ctx, p, t.creator),
    creator: person(ctx, t.creator),
    community: community(ctx, t.community),
    creator_banned_from_community: false,
    banned_from_community: false,
    creator_is_moderator: false,
    creator_is_admin: t.creator.role === "admin",
    counts: {
      post_id: p.id,
      comments: p.comments,
      score: p.upvotes - p.downvotes,
      upvotes: p.upvotes,
      downvotes: p.downvotes,
      published: iso(p.createdAt),
      newest_comment_time: iso(p.activeAt),
    },
    subscribed: subscribedType(t),
    saved: p.saved,
    read: false,
    hidden: false,
    creator_blocked: false,
    ...(p.myVote ? { my_vote: p.myVote } : {}),
    unread_comments: 0,
  };
}

export function comment(ctx: RequestContext, c: ThreadComment, creator?: Account): Comment {
  return {
    id: c.id,
    creator_id: c.accountId,
    post_id: c.rootId ?? 0,
    content: c.contentSource,
    removed: false,
    published: iso(c.createdAt),
    ...(c.updatedAt ? { updated: iso(c.updatedAt) } : {}),
    deleted: c.deleted,
    ap_id: creator ? apIdOf(c, creator) : (c.apId ?? urls.object(ctx.domain.domain, String(c.id))),
    local: c.apId === null,
    path: c.path ?? `0.${c.id}`,
    distinguished: false,
    language_id: 0,
  };
}

export function commentView(ctx: RequestContext, c: ThreadComment, onPost: ThreadPost, t: ThreadContext): CommentView {
  return {
    comment: comment(ctx, c, t.creator),
    creator: person(ctx, t.creator),
    post: post(ctx, onPost),
    community: community(ctx, t.community),
    counts: {
      comment_id: c.id,
      score: c.upvotes - c.downvotes,
      upvotes: c.upvotes,
      downvotes: c.downvotes,
      published: iso(c.createdAt),
      child_count: c.childCount,
    },
    creator_banned_from_community: false,
    banned_from_community: false,
    creator_is_moderator: false,
    creator_is_admin: t.creator.role === "admin",
    subscribed: subscribedType(t),
    saved: c.saved,
    creator_blocked: false,
    ...(c.myVote ? { my_vote: c.myVote } : {}),
  };
}
