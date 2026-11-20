import { userAgentClient } from "@palm/core";
import type { PostClient } from "@palm/db";

/**
 * A Lemmy app's post: Lemmy's API has no app identity, so the name and the
 * device come from the User-Agent, when it gives them.
 */
export function lemmyClient(c: { req: { header(name: string): string | undefined } }): {
  client: PostClient;
  clientApp: string | null;
  clientDevice: string | null;
} {
  const agent = userAgentClient(c.req.header("user-agent"));
  return { client: "lemmy", clientApp: agent.app, clientDevice: agent.device };
}
