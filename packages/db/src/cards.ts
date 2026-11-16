/** Link previews: a page's title, description and picture, fetched once. */
export interface LinkCard {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  provider: string | null;
}

export async function cardsFor(db: D1Database, urls: string[]): Promise<Map<string, LinkCard>> {
  const unique = [...new Set(urls)];
  const out = new Map<string, LinkCard>();
  if (!unique.length) return out;
  const { results } = await db
    .prepare(`SELECT url, title, description, image, provider FROM link_cards WHERE url IN (${unique.map(() => "?").join(", ")})`)
    .bind(...unique)
    .all<LinkCard>();
  for (const r of results) if (r.title || r.image) out.set(r.url, r);
  return out;
}

export async function hasCard(db: D1Database, url: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM link_cards WHERE url = ?").bind(url).first()) !== null;
}

/** Stores a card; an empty one marks the page as tried, so it isn't fetched again. */
export async function saveCard(db: D1Database, card: LinkCard): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO link_cards (url, title, description, image, provider, fetched_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(card.url, card.title, card.description, card.image, card.provider, Math.floor(Date.now() / 1000))
    .run();
}
