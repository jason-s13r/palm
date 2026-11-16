import { previewLink } from "@palm/core";
import { hasCard, isBlockedHost, saveCard, type LinkCard, type Post } from "@palm/db";

/** Enough of a page to find its <head>; the rest is never read. */
const MAX_BYTES = 256 * 1024;

async function readHead(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.byteLength;
    if (new TextDecoder().decode(value).includes("</head>")) break;
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** A page's Open Graph (or plain HTML) title, description and picture. */
export async function fetchCard(url: string): Promise<LinkCard> {
  const empty: LinkCard = { url, title: null, description: null, image: null, provider: null };
  const response = await fetch(url, {
    headers: { accept: "text/html", "user-agent": "palm (+https://github.com/jason-s13r/palm; link preview)" },
    redirect: "follow",
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!response?.ok || !(response.headers.get("content-type") ?? "").includes("html")) {
    await response?.body?.cancel().catch(() => undefined);
    return empty;
  }
  const head = await readHead(response);
  const meta: Record<string, string> = {};
  let title = "";
  let inTitle = false;
  await new HTMLRewriter()
    .on("meta", {
      element(e) {
        const key = (e.getAttribute("property") ?? e.getAttribute("name") ?? "").toLowerCase();
        const content = e.getAttribute("content");
        if (key && content && !(key in meta)) meta[key] = content;
      },
    })
    .on("title", {
      element() {
        inTitle = true;
      },
      text(t) {
        if (inTitle) title += t.text;
        if (t.lastInTextNode) inTitle = false;
      },
    })
    .transform(new Response(head))
    .text();
  const decode = (s: string | undefined) =>
    s?.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() || null;
  const image = decode(meta["og:image"] ?? meta["twitter:image"]);
  return {
    url,
    title: decode(meta["og:title"] ?? meta["twitter:title"] ?? title)?.slice(0, 300) ?? null,
    description: decode(meta["og:description"] ?? meta["twitter:description"] ?? meta.description)?.slice(0, 500) ?? null,
    image: image ? new URL(image, response.url || url).href : null,
    provider: decode(meta["og:site_name"]) ?? new URL(response.url || url).host,
  };
}

/** Fetches and keeps the preview for a post's link, once per link. */
export async function cardForPost(db: D1Database, post: Pick<Post, "linkUrl" | "contentHtml">): Promise<void> {
  const link = previewLink(post);
  if (!link || (await hasCard(db, link))) return;
  if (await isBlockedHost(db, new URL(link).host)) return;
  // Images and video are their own preview.
  if (/\.(jpe?g|png|gif|webp|avif|mp4|webm|mov)(\?|$)/i.test(link)) return;
  await saveCard(db, await fetchCard(link).catch(() => ({ url: link, title: null, description: null, image: null, provider: null })));
}
