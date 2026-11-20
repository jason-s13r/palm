import type { RequestContext } from "@palm/core";
import type { Account } from "@palm/db";
import type { Context } from "hono";

export type Env = { Bindings: RequestContext; Variables: { account: Account | null } };
export type C = Context<Env>;

/** PeerTube's errors: RFC 7807 problem details, with `error` kept for older clients. */
export function fail(c: C, status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 501, detail: string, code?: string) {
  const titles: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 413: "Payload Too Large", 415: "Unsupported Media Type", 422: "Unprocessable Entity", 501: "Not Implemented" };
  return c.json({ type: `https://docs.joinpeertube.org/api-rest-reference.html#section/Errors/${titles[status]?.toLowerCase().replace(/ /g, "_")}`, title: titles[status], detail, status, error: detail, ...(code ? { code } : {}) }, status, {
    "content-type": "application/problem+json; charset=utf-8",
  });
}

/** Query string and body, merged; repeated keys (videoIds=1&videoIds=2) become arrays. */
export async function params(c: C): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, values] of Object.entries(c.req.queries())) out[k.replace(/\[\]$/, "")] = values.length > 1 ? values : values[0];
  if (c.req.method === "GET" || c.req.method === "HEAD") return out;
  const type = c.req.header("content-type") ?? "";
  try {
    if (type.includes("application/json")) Object.assign(out, await c.req.json<Record<string, unknown>>());
    else if (type.includes("form")) {
      for (const [k, v] of Object.entries(await c.req.parseBody({ all: true }))) out[k.replace(/\[\]$/, "")] = v;
    }
  } catch {
    // An unreadable body reads as no parameters.
  }
  return out;
}

