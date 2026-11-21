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
  // Lemmy apps
  {
    client: "Voyager (iOS and Android)",
    userAgent: /\bVoyagerApp\//,
    as: "lemmy",
    why: "Checks the handle's domain for Lemmy >= 0.19 before signing in.",
  },
  {
    client: "Voyager (web, vger.app)",
    origin: /^https:\/\/(www\.)?vger\.app$/,
    as: "lemmy",
    why: "Checks the handle's domain for Lemmy >= 0.19 before signing in.",
  },
  // Pixelfed servers
  {
    client: "Pixelfed servers",
    userAgent: /\bPixelfed\//,
    as: "pixelfed",
    why: "Only send stories to servers whose nodeinfo says pixelfed.",
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
