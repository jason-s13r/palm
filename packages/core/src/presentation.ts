/**
 * What palm says it is in nodeinfo, by who's asking.
 *
 * palm presents as itself by default. Some clients only work with the software
 * they were built for and check nodeinfo first, so they're shown that
 * software instead. To add one, add a row to PRESENTATIONS: the first row that
 * matches wins.
 *
 * This covers /.well-known/nodeinfo and /nodeinfo/2.1. Each client API keeps
 * its own answers: Lemmy's /api/v3/site says Lemmy, and the Pixelfed app's
 * own /api/nodeinfo/2.0.json says Pixelfed, whoever asks.
 */
export type Presentation = "palm" | "lemmy" | "pixelfed";

export interface PresentationRule {
  /** Who this row is for, as people know it. */
  client: string;
  /** Matched against the User-Agent header. */
  userAgent?: RegExp;
  /** Matched against the Origin header, for web clients (which send their browser's User-Agent). */
  origin?: RegExp;
  as: Presentation;
  /** Why this client needs it. */
  why: string;
}

export const PRESENTATIONS: readonly PresentationRule[] = [
  // Lemmy apps that read nodeinfo to tell Lemmy from PieFed (or Mbin) before
  // signing in. Taken from each app's source; apps that only speak Lemmy
  // (Jerboa, Sync) or work it out from the API (Mlem) don't need a row.
  {
    client: "Voyager (iOS and Android)",
    userAgent: /\bVoyagerApp\//,
    as: "lemmy",
    why: "Needs Lemmy >= 0.19 in the handle domain's nodeinfo before it signs in.",
  },
  {
    client: "Voyager (web, vger.app)",
    origin: /^https:\/\/(www\.)?vger\.app$/,
    as: "lemmy",
    why: "As the apps; the browser sends its own User-Agent.",
  },
  {
    client: "Thunder",
    // Its nodeinfo check uses Dart's HTTP client as it comes, so it sends
    // Dart's User-Agent rather than its own ("Thunder/x.y.z").
    userAgent: /^Dart\/\d/,
    as: "lemmy",
    why: "Picks its Lemmy or PieFed API from nodeinfo's software name; anything else fails.",
  },
  {
    client: "Interstellar",
    userAgent: /^Interstellar\//,
    as: "lemmy",
    why: "Picks its Mbin, Lemmy or PieFed API from /nodeinfo/2.0.json's software name.",
  },
  {
    client: "Blorp (iOS and Android)",
    // Its app is a web view that adds "Blorp" to the system's User-Agent.
    userAgent: /\bBlorp\b/,
    as: "lemmy",
    why: "Picks its Lemmy or PieFed API from /nodeinfo/2.1's software name.",
  },
  {
    client: "Blorp (web, blorp.* hosts such as blorp.lemmy.world)",
    origin: /^https:\/\/blorp\.[a-z0-9.-]+$/,
    as: "lemmy",
    why: "As the apps; the browser sends its own User-Agent.",
  },
  // Pixelfed servers
  {
    client: "Pixelfed servers",
    userAgent: /\bPixelfed\//,
    as: "pixelfed",
    why: "Send stories to a server when its nodeinfo says pixelfed.",
  },
];

/** What palm presents as to the client that sent these headers. */
export function presentationFor(headers: Headers): Presentation {
  const userAgent = headers.get("user-agent") ?? "";
  const origin = headers.get("origin") ?? "";
  for (const rule of PRESENTATIONS) {
    if ((rule.userAgent && rule.userAgent.test(userAgent)) || (rule.origin && rule.origin.test(origin))) return rule.as;
  }
  return "palm";
}
