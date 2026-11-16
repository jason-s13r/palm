const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/**
 * Plain text, as apps send it, to the HTML ActivityPub carries: escaped,
 * blank lines become paragraphs, line breaks become <br>, and links are
 * linked. Lemmy's Markdown reads as plain text here until palm renders it.
 */
export function textToHtml(text: string): string {
  const linkify = (line: string) =>
    escapeHtml(line).replace(/https?:\/\/[^\s<]+/g, (match) => {
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
