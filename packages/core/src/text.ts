const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/**
 * Plain text, as apps send it, to the HTML ActivityPub carries: escaped,
 * blank lines become paragraphs, line breaks become <br>, and links are
 * linked. Lemmy's Markdown reads as plain text here until palm renders it.
 */
export function textToHtml(text: string, mentions: ReadonlyMap<string, string> = new Map()): string {
  const linkify = (line: string) =>
    escapeHtml(line)
      .replace(MENTION, (match, before: string, handle: string) => {
        // A mention palm resolved links to the person's profile, as Mastodon writes it.
        const url = mentions.get(handle.toLowerCase());
        if (!url) return match;
        const name = handle.split("@")[0];
        return `${before}<span class="h-card"><a href="${escapeHtml(url)}" class="u-url mention" rel="nofollow noopener" target="_blank">@<span>${name}</span></a></span>`;
      })
      .replace(/(?<!href=")https?:\/\/[^\s<"]+/g, (match) => {
      // Trailing punctuation usually ends the sentence, not the link.
      const url = match.replace(/[.,;:!?)\]'"]+$/, "");
      const rest = match.slice(url.length);
      const shown = url.replace(/^https?:\/\//, "");
      return `<a href="${url}" rel="nofollow noopener" target="_blank">${shown}</a>${rest}`;
    });
  return text
    .replaceAll("\r\n", "\n")
    .trim()
    .split(/\n{2,}/)
    .filter((para) => para.trim() !== "")
    .map((para) => `<p>${para.split("\n").map(linkify).join("<br>")}</p>`)
    .join("");
}

export { escapeHtml };

/** "@name" or "@name@host" in text, not inside an email address or a word. */
const MENTION = /(^|[^\w@\/])@([a-z0-9_]+(?:[.-][a-z0-9_]+)*(?:@[a-z0-9-]+(?:\.[a-z0-9-]+)+)?)/gi;

/** The handles a text mentions, lowercased: "name" for local, "name@host" for remote. */
export function mentionsIn(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION)].map((m) => m[2]!.toLowerCase()))];
}

const ALLOWED_TAGS = new Set(["p", "br", "a", "span", "strong", "b", "em", "i", "u", "s", "del", "code", "pre", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "sup", "sub", "img"]);
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "rel", "class", "target", "title"]),
  span: new Set(["class"]),
  img: new Set(["src", "alt", "title"]),
};

/**
 * Remote HTML, made safe to hand to apps: only formatting tags survive, with
 * only harmless attributes, and links and images only over http(s). Scripts,
 * styles and their contents go entirely.
 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|template)[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, (tag, rawName: string, rawAttrs: string) => {
      const name = rawName.toLowerCase();
      if (!ALLOWED_TAGS.has(name)) return "";
      if (tag.startsWith("</")) return `</${name}>`;
      const allowed = ALLOWED_ATTRS[name];
      const attrs: string[] = [];
      if (allowed) {
        for (const m of rawAttrs.matchAll(/([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
          const attr = m[1]!.toLowerCase();
          const value = m[3] ?? m[4] ?? m[5] ?? "";
          if (!allowed.has(attr)) continue;
          if ((attr === "href" || attr === "src") && !/^https?:\/\//i.test(value.trim())) continue;
          attrs.push(`${attr}="${value.replaceAll('"', "&quot;")}"`);
        }
      }
      const selfClosing = name === "br" || name === "img";
      return `<${name}${attrs.length ? " " + attrs.join(" ") : ""}${selfClosing ? " /" : ""}>`;
    });
}

const decodeEntities = (text: string) =>
  text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");

/**
 * HTML as Markdown-ish plain text, for Lemmy apps showing a post that came
 * without Markdown source: paragraphs and line breaks kept, links as
 * [text](url), everything else as its text.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|iframe|object|embed|template)[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
      .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => {
        const label = text.replace(/<[^>]+>/g, "").trim();
        // Mentions and hashtags read better as their text alone.
        return label.startsWith("@") || label.startsWith("#") || label === href.replace(/^https?:\/\//, "") ? label : `[${label}](${href})`;
      })
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<\/(h[1-6]|blockquote|pre|ul|ol)>/gi, "\n\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
