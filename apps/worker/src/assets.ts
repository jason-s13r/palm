// A 96 px placeholder avatar (a circle on a soft green ground), served at
// /palm/avatar.png on every host until accounts can upload their own.
const AVATAR_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABBUlEQVR42u3cwRHCMAwEQFVEQfRCd3zpgVJoAPLAlmMpO3MV7CsT3Tme75ccJBAAAgQIECBAgAAJIECAAAECBAiQAKoFdHvcv+a6QL9EjnMJoP9oTmSKQjSnMEU5msVMUZRmGVNU18k2igY6qUbRQyfPKNroJBlFJ50Mo2imM90o+unMNQK0BGg3nYlGgPKB9tSZZQQoGWhnnSlGgDKB9tcZNwIECBCgmkBVdAaNAAECBAgQIECAfCgCAgQIUDEgv1wBOfsAcnp2m28ApP4CSAVPiVMNuEINWJHcFMGYxRzKoM4ks9kk06jXLNzDAgIIECBAgAABAiSAAAECBAgQIEACCNB4PtYEbAhiqGrbAAAAAElFTkSuQmCC";

export function avatarResponse(): Response {
  const bytes = Uint8Array.from(atob(AVATAR_PNG_BASE64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
  });
}

// Placeholder avatars: a 5×5 mirrored pattern in one colour on a pale tint of
// it, drawn from the eight hex digits in the URL (`urls.avatar`). The pattern
// sits well inside the square so apps' circular crops leave it whole.
const SIZE = 120;
const CELL = 16;
const MARGIN = (SIZE - CELL * 5) / 2;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** An 8-bit PNG: `raw` is the filtered scanlines (a 0 filter byte, then the row). */
async function png(width: number, height: number, raw: Uint8Array, palette?: number[]): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, palette ? 3 : 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(palette ? [chunk("PLTE", new Uint8Array(palette))] : []),
    chunk("IDAT", await deflate(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function hsl(h: number, s: number, l: number): number[] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** The picture for a seed of eight hex digits. */
export function identiconPng(seed: string): Promise<Uint8Array> {
  const n = parseInt(seed, 16) >>> 0;
  // 15 bits fill the left three columns, mirrored to five; sparse ones are flipped.
  let bits = n & 0x7fff;
  let count = 0;
  for (let b = bits; b; b >>= 1) count += b & 1;
  if (count < 5) bits ^= 0x7fff;
  const hue = (n >>> 15) % 360;

  // One byte a pixel: 0 is the ground, 1 the pattern.
  const raw = new Uint8Array(SIZE * (SIZE + 1));
  for (let y = 0; y < SIZE; y++) {
    const cy = Math.floor((y - MARGIN) / CELL);
    if (cy < 0 || cy > 4) continue;
    for (let x = 0; x < SIZE; x++) {
      const cx = Math.floor((x - MARGIN) / CELL);
      if (cx < 0 || cx > 4) continue;
      const col = cx > 2 ? 4 - cx : cx;
      if ((bits >> (col * 5 + cy)) & 1) raw[y * (SIZE + 1) + 1 + x] = 1;
    }
  }
  return png(SIZE, SIZE, raw, [...hsl(hue, 0.45, 0.9), ...hsl(hue, 0.6, 0.42)]);
}

/** `/palm/avatar/{seed}.png`. A seed always draws the same picture. */
export async function identiconResponse(seed: string): Promise<Response> {
  return new Response(await identiconPng(seed), {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" },
  });
}

/** `/palm/header.png`: one neutral grey pixel, which apps stretch over the header. */
export async function headerResponse(): Promise<Response> {
  return new Response(await png(1, 1, new Uint8Array([0, 0x3a, 0x3a, 0x3c])), {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
  });
}
