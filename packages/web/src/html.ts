import { escapeHtml } from "@palm/core";

/**
 * HTML as strings, escaped by default. `html` escapes every interpolated
 * value unless it's already Html (made by `html` or `raw`), so a page is
 * safe unless something calls raw() on text that isn't.
 */
export class Html {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

type Part = Html | string | number | null | undefined | false | Part[];

const render = (part: Part): string => {
  if (part === null || part === undefined || part === false) return "";
  if (Array.isArray(part)) return part.map(render).join("");
  if (part instanceof Html) return part.value;
  return escapeHtml(String(part));
};

export function html(strings: TemplateStringsArray, ...parts: Part[]): Html {
  let out = strings[0]!;
  parts.forEach((part, i) => (out += render(part) + strings[i + 1]!));
  return new Html(out);
}

/** Markup palm already made safe: post HTML is sanitized when it's stored. */
export const raw = (value: string) => new Html(value);

/** What a page tells link previews and search engines about itself. */
export interface Meta {
  title: string;
  description?: string | undefined;
  /** og:type: "article" for a post, "profile" for a person, "website" otherwise. */
  type?: "article" | "profile" | "website";
  image?: string | null | undefined;
  /** A large picture makes a large preview card. */
  largeImage?: boolean;
  url: string;
  /** Where the original lives, for something fetched from another server. */
  canonical?: string | null | undefined;
  /** The ActivityPub object or actor this page shows. */
  activityPub?: string | null | undefined;
  author?: string | undefined;
  published?: number | undefined;
  /** Kept out of search: other servers' content, shown here because someone follows it. */
  noindex?: boolean;
}

// Barely any styling, on purpose: readable text, a narrow column, quiet meta.
const STYLE = `
body{max-width:46rem;margin:0 auto;padding:1rem;font:16px/1.5 system-ui,sans-serif;color:#222;background:#fff}
a{color:#2255aa}header,footer{font-size:.9em;color:#666}header{border-bottom:1px solid #ddd;padding-bottom:.5rem}
footer{border-top:1px solid #ddd;margin-top:2rem;padding-top:.5rem}.meta{font-size:.85em;color:#666}
img,video{max-width:100%;height:auto}.avatar{width:48px;height:48px;border-radius:4px;vertical-align:middle;margin-right:.5rem}
ol.posts{padding-left:1.5rem}ol.posts li{margin:.6rem 0}.thread{list-style:none;padding-left:1rem;border-left:1px solid #ddd}
.thread>li{margin:.75rem 0}.content p{margin:.4rem 0}blockquote{margin:.5rem 0;padding-left:.75rem;border-left:3px solid #ddd;color:#555}
pre{overflow-x:auto;background:#f6f6f6;padding:.5rem}h1{font-size:1.4em;margin:.5rem 0}
@media(prefers-color-scheme:dark){body{background:#151515;color:#ddd}a{color:#8ab4f8}header,footer,.meta{color:#999}pre{background:#222}}
`;

export interface Site {
  name: string;
  domain: string;
  /** palm's version, shown in the footer. */
  version: string;
}

export function page(site: Site, meta: Meta, body: Html): Response {
  const description = meta.description ? meta.description.slice(0, 300) : undefined;
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${meta.title} · ${site.name}</title>
${description ? html`<meta name="description" content="${description}">` : ""}
<meta property="og:site_name" content="${site.name}">
<meta property="og:title" content="${meta.title}">
<meta property="og:type" content="${meta.type ?? "website"}">
<meta property="og:url" content="${meta.url}">
${description ? html`<meta property="og:description" content="${description}">` : ""}
${meta.image ? html`<meta property="og:image" content="${meta.image}">` : ""}
${meta.published ? html`<meta property="article:published_time" content="${new Date(meta.published * 1000).toISOString()}">` : ""}
${meta.author ? html`<meta property="article:author" content="${meta.author}">` : ""}
<meta name="twitter:card" content="${meta.image && meta.largeImage ? "summary_large_image" : "summary"}">
<link rel="canonical" href="${meta.canonical ?? meta.url}">
${meta.activityPub ? html`<link rel="alternate" type="application/activity+json" href="${meta.activityPub}">` : ""}
${meta.noindex ? html`<meta name="robots" content="noindex">` : ""}
<style>${raw(STYLE)}</style>
</head>
<body>
<header><a href="/">${site.name}</a> · ${site.domain}</header>
<main>
${body}
</main>
<footer>Read and reply from any Lemmy, Mastodon, Pixelfed or PeerTube app. Powered by <a href="https://github.com/jason-s13r/palm">palm</a> ${site.version}.</footer>
</body>
</html>`;
  return new Response(doc.value, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // No scripts at all; pictures and video from anywhere posts link to.
      "content-security-policy": "default-src 'none'; img-src * data:; media-src *; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      "cache-control": "public, max-age=60",
      vary: "accept",
    },
  });
}

export function notFound(site: Site, url: string): Response {
  const response = page(site, { title: "Not found", url, noindex: true }, html`<h1>Not found</h1><p>Nothing here, or it isn't public.</p>`);
  return new Response(response.body, { status: 404, headers: response.headers });
}

export const time = (seconds: number) => {
  const date = new Date(seconds * 1000);
  return html`<time datetime="${date.toISOString()}">${date.toISOString().slice(0, 16).replace("T", " ")} UTC</time>`;
};
