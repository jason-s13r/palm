import type { ApiKind, DomainConfig, PalmConfig } from "./config.ts";

/**
 * What a request's host is for. `federation` is the bare domain, where
 * WebFinger, nodeinfo, actors and the inbox live; the others are client APIs.
 */
export type Surface =
  | { kind: "federation"; domain: DomainConfig }
  | { kind: ApiKind; domain: DomainConfig };

/** Finds which domain and surface a host belongs to, or null for a stranger. */
export function resolveSurface(config: PalmConfig, host: string): Surface | null {
  const name = normaliseHost(host);
  for (const domain of config.domains) {
    if (domain.domain === name) return { kind: "federation", domain };
    for (const [kind, apiHost] of Object.entries(domain.hosts ?? {}) as [ApiKind, string | undefined][]) {
      if (apiHost === name) return { kind, domain };
    }
  }
  return null;
}

/** Lowercases a Host header value and drops any port. */
export function normaliseHost(host: string): string {
  const lower = host.trim().toLowerCase();
  // A bracketed IPv6 literal keeps its colons; anything else loses ":port".
  if (lower.startsWith("[")) return lower.slice(0, lower.indexOf("]") + 1);
  const colon = lower.lastIndexOf(":");
  return colon === -1 ? lower : lower.slice(0, colon);
}
