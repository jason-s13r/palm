import { importJwk } from "@fedify/fedify";

/**
 * Imported keys, kept for the life of the isolate. Importing an RSA private
 * key from its JWK costs a few ms of CPU, and every delivery, signed fetch and
 * actor document needs its sender's keys. Finished keys are kept, never
 * pending promises (see `built` in shared.ts); a key that changes is a new JWK, so
 * a new entry.
 */
const importedKeys = new Map<string, CryptoKey>();

export async function importJwkCached(jwk: JsonWebKey, type: "public" | "private"): Promise<CryptoKey> {
  const id = `${type}:${JSON.stringify(jwk)}`;
  const known = importedKeys.get(id);
  if (known) return known;
  const key = await importJwk(jwk, type);
  if (importedKeys.size >= 500) importedKeys.clear();
  importedKeys.set(id, key);
  return key;
}
