/**
 * PeerTube's short UUIDs: a UUID's 128 bits written in Flickr's base 58 and
 * padded to 22 characters, as the short-uuid library PeerTube uses does. Apps
 * put them in watch links (/w/{shortUUID}) and in API paths.
 */
const ALPHABET = "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const LENGTH = 22;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export const isUuid = (value: string) => UUID.test(value);

export function toShortUuid(uuid: string): string {
  let n = BigInt(`0x${uuid.replace(/-/g, "")}`);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out.padStart(LENGTH, ALPHABET[0]);
}

export function fromShortUuid(short: string): string | null {
  if (!/^[1-9a-km-zA-HJ-NP-Z]{1,22}$/.test(short)) return null;
  let n = 0n;
  for (const ch of short) n = n * 58n + BigInt(ALPHABET.indexOf(ch));
  if (n >= 1n << 128n) return null;
  const hex = n.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
