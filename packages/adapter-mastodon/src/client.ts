import type { RequestContext } from "@palm/core";
import type { Account, OAuthApp, PostClient } from "@palm/db";
import type { Context } from "hono";

type Env = { Bindings: RequestContext; Variables: { account: Account | null; app: OAuthApp | null } };
type C = Context<Env, any, any>;

/** Whether a request comes from a Pixelfed app: `_pe=1`, its header, or an app named for it. */
export function isPixelfed(c: C): boolean {
  return c.req.query("_pe") !== undefined || c.req.header("x-pixelfed-app") !== undefined || /pixelfed/i.test(c.get("app")?.name ?? "");
}

/** Which kind of app made a post, and the app's own name, for the post to keep. */
export function clientOf(c: C): { client: PostClient; clientApp: string | null } {
  return { client: isPixelfed(c) ? "pixelfed" : "mastodon", clientApp: c.get("app")?.name?.trim() || null };
}
