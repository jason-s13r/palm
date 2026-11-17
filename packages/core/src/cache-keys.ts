/**
 * Keys for copies palm keeps in Cloudflare's cache, shared by the Worker
 * that keeps them and the code that clears them.
 */

/** An upload's cached copy, by its ID (the file name without extension). */
export const uploadCacheKey = (domain: string, id: string) => `https://${domain}/pictrs/image/${id}?_palm=upload`;
