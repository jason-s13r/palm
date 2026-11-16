import type { RequestContext } from "@palm/core";
import { urls } from "@palm/core";
import type { Account } from "@palm/db";
import type {
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

/** The Lemmy version palm reports. Apps gate features on it. */
export const LEMMY_VERSION = "0.19.9";

/** palm is one Lemmy "instance" per domain; Lemmy numbers its own as 1. */
const LOCAL_INSTANCE_ID = 1;

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

export function person(ctx: RequestContext, account: Account): Person {
  return {
    id: account.id,
    name: account.username,
    ...(account.displayName ? { display_name: account.displayName } : {}),
    ...(account.bio ? { bio: account.bio } : {}),
    banned: false,
    published: iso(account.createdAt),
    actor_id: urls.user(ctx.domain.domain, account.username),
    local: true,
    deleted: false,
    bot_account: false,
    instance_id: LOCAL_INSTANCE_ID,
  };
}

export function personView(ctx: RequestContext, account: Account): PersonView {
  return {
    person: person(ctx, account),
    counts: { person_id: account.id, post_count: 0, comment_count: 0 },
    is_admin: account.role === "admin",
  };
}

export function siteView(ctx: RequestContext, users: number): SiteView {
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
    registration_mode: "Closed",
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
      users,
      posts: 0,
      comments: 0,
      communities: 0,
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

export function myUserInfo(ctx: RequestContext, account: Account): MyUserInfo {
  return {
    local_user_view: localUserView(ctx, account),
    follows: [],
    moderates: [],
    community_blocks: [],
    instance_blocks: [],
    person_blocks: [],
    discussion_languages: [],
  };
}
