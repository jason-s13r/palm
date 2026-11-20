/**
 * The configuration that turns the generic palm code into one instance.
 *
 * Nothing about a specific deployment (1j.nz or anyone else's) lives in the
 * palm repository: a deployment repo passes its config to `createPalm`.
 */

/** The client APIs palm can serve. */
export type ApiKind = "lemmy" | "mastodon";

export interface DomainConfig {
  /**
   * The domain people's handles live on, and the host every ActivityPub ID is
   * minted under: `@jason@1j.nz`, `https://1j.nz/users/jason`.
   * These IDs are permanent once anything has federated, so this does not
   * change after launch.
   */
  domain: string;
  /**
   * Extra hosts for the client APIs, if wanted. Both APIs already answer on
   * the domain itself, which is where people should sign in: apps show the
   * handle with the host they signed in to. A separate host serves its one
   * API at its root.
   */
  hosts?: Partial<Record<ApiKind, string>>;
}

export interface InstanceConfig {
  /** Shown in apps' instance info. */
  name: string;
  description?: string;
  /** An address people can reach the admin at, shown in instance info. */
  contact?: string;
}

export interface PalmConfig {
  /** One or more domains this deployment serves. Most have one. */
  domains: DomainConfig[];
  instance: InstanceConfig;
  /**
   * Where a browser goes when it lands on a page palm does not serve, such as
   * the bare domain. Without it, palm answers those requests with a short
   * text page.
   */
  browserRedirect?: string;
  /** How new accounts are created. Only invites for now. */
  registration?: "invite";
  /**
   * How much a post's page says about where it was written:
   * - "off": nothing;
   * - "service": the kind of post ("on Lemmy", "on Pixelfed", "on Mastodon");
   * - "app" (the default): and the app ("via Ivory");
   * - "device": and the device ("via Ivory for iPhone").
   * Mastodon apps get the app's name as a status's `application` at "app" and "device".
   */
  postClients?: PostClientDisplay;
}

export type PostClientDisplay = "off" | "service" | "app" | "device";
export const POST_CLIENT_DISPLAYS: readonly PostClientDisplay[] = ["off", "service", "app", "device"];

export class ConfigError extends Error {
  override name = "ConfigError";
}

// A hostname: lowercase labels of letters, digits and hyphens, at least two.
const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/**
 * Checks a config and returns it unchanged. Deployment repos call this in
 * their `palm.config.ts`, so a mistake fails the build rather than a request.
 */
export function defineConfig(config: PalmConfig): PalmConfig {
  if (config.domains.length === 0) {
    throw new ConfigError("At least one domain is required.");
  }
  if (!config.instance.name.trim()) {
    throw new ConfigError("instance.name is required.");
  }

  const seen = new Map<string, string>();
  const claim = (host: string, use: string) => {
    if (!HOSTNAME.test(host)) {
      throw new ConfigError(`"${host}" (${use}) is not a valid lowercase hostname.`);
    }
    const previous = seen.get(host);
    if (previous) {
      throw new ConfigError(`"${host}" is used twice: ${previous} and ${use}.`);
    }
    seen.set(host, use);
  };

  for (const { domain, hosts } of config.domains) {
    claim(domain, `domain ${domain}`);
    for (const [kind, host] of Object.entries(hosts ?? {})) {
      if (host !== undefined) claim(host, `${kind} host for ${domain}`);
    }
  }

  if (config.browserRedirect !== undefined) {
    let url: URL;
    try {
      url = new URL(config.browserRedirect);
    } catch {
      throw new ConfigError(`browserRedirect "${config.browserRedirect}" is not a URL.`);
    }
    if (url.protocol !== "https:") {
      throw new ConfigError("browserRedirect must be an https URL.");
    }
  }

  if (config.postClients !== undefined && !POST_CLIENT_DISPLAYS.includes(config.postClients)) {
    throw new ConfigError(`postClients must be one of ${POST_CLIENT_DISPLAYS.join(", ")}.`);
  }

  return config;
}
