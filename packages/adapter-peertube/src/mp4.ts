/**
 * What palm needs to know about an uploaded video without ffmpeg: its length,
 * its picture's size and frame rate, and its codecs, read from the MP4's
 * `moov` box. Only box headers and a few small boxes are read, from R2 by
 * range, so a long video costs a handful of reads and little CPU.
 */
export interface Probe {
  /** Seconds. */
  duration: number;
  /** As shown, after the rotation phones record (a portrait clip is taller than wide). */
  width: number;
  height: number;
  fps: number;
  /** The video track's sample format: avc1 (H.264), hvc1/hev1 (HEVC), vp09, av01... */
  videoCodec: string | null;
  audioCodec: string | null;
}

/** Codecs every browser and phone plays in an MP4. */
export const PLAYS_EVERYWHERE = new Set(["avc1", "avc3"]);

const MAX_MOOV = 16 * 1024 * 1024;

type Reader = (offset: number, length: number) => Promise<Uint8Array | null>;

export function r2Reader(bucket: R2Bucket, key: string): Reader {
  return async (offset, length) => {
    const object = await bucket.get(key, { range: { offset, length } });
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  };
}

const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

/** Finds the top-level moov box by walking box headers, wherever it is in the file. */
async function findMoov(read: Reader, size: number): Promise<Uint8Array | null> {
  let offset = 0;
  for (let i = 0; i < 64 && offset + 8 <= size; i++) {
    const head = await read(offset, 16);
    if (!head || head.length < 8) return null;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let boxSize = view.getUint32(0);
    const type = fourcc(head, 4);
    let header = 8;
    if (boxSize === 1 && head.length >= 16) {
      boxSize = Number(view.getBigUint64(8));
      header = 16;
    } else if (boxSize === 0) {
      boxSize = size - offset;
    }
    if (boxSize < header) return null;
    if (type === "moov") {
      if (boxSize > MAX_MOOV) return null;
      const moov = await read(offset, boxSize);
      return moov ? moov.subarray(header) : null;
    }
    offset += boxSize;
  }
  return null;
}

interface Box {
  type: string;
  body: Uint8Array;
}

function* boxes(data: Uint8Array): Generator<Box> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 0;
  while (at + 8 <= data.length) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1 && at + 16 <= data.length) {
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = data.length - at;
    if (size < header || at + size > data.length) return;
    yield { type: fourcc(data, at + 4), body: data.subarray(at + header, at + size) };
    at += size;
  }
}

const child = (data: Uint8Array, type: string) => {
  for (const box of boxes(data)) if (box.type === type) return box.body;
  return null;
};

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Reads an MP4's moov box. Null when it isn't an MP4 palm can read. */
export function parseMoov(moov: Uint8Array): Probe | null {
  const mvhd = child(moov, "mvhd");
  if (!mvhd) return null;
  const mv = dv(mvhd);
  const v1 = mvhd[0] === 1;
  const timescale = mv.getUint32(v1 ? 20 : 12);
  const rawDuration = v1 ? Number(mv.getBigUint64(24)) : mv.getUint32(16);
  const probe: Probe = { duration: timescale ? rawDuration / timescale : 0, width: 0, height: 0, fps: 0, videoCodec: null, audioCodec: null };
  for (const box of boxes(moov)) {
    if (box.type !== "trak") continue;
    const mdia = child(box.body, "mdia");
    const hdlr = mdia && child(mdia, "hdlr");
    if (!mdia || !hdlr || hdlr.length < 12) continue;
    const handler = fourcc(hdlr, 8);
    const stbl = child(child(mdia, "minf") ?? new Uint8Array(), "stbl");
    const stsd = stbl && child(stbl, "stsd");
    const codec = stsd && stsd.length >= 16 ? fourcc(stsd, 12) : null;
    if (handler === "soun") {
      probe.audioCodec ??= codec;
      continue;
    }
    if (handler !== "vide" || probe.videoCodec) continue;
    probe.videoCodec = codec;
    const tkhd = child(box.body, "tkhd");
    if (tkhd) {
      const t = dv(tkhd);
      const base = tkhd[0] === 1 ? 52 : 40;
      if (tkhd.length >= base + 44) {
        const a = t.getInt32(base);
        const b = t.getInt32(base + 4);
        let width = t.getUint32(base + 36) >>> 16;
        let height = t.getUint32(base + 40) >>> 16;
        // A 90° or 270° rotation (a = 0, b = ±1): shown the other way round.
        if (a === 0 && Math.abs(b) === 0x10000) [width, height] = [height, width];
        probe.width = width;
        probe.height = height;
      }
    }
    // Frame rate: the track's timescale over its usual sample duration.
    const mdhd = child(mdia, "mdhd");
    const stts = stbl && child(stbl, "stts");
    if (mdhd && stts && stts.length >= 16) {
      const md = dv(mdhd);
      const trackScale = mdhd[0] === 1 ? md.getUint32(20) : md.getUint32(12);
      const s = dv(stts);
      const entries = s.getUint32(4);
      let best = 0;
      let bestCount = 0;
      for (let i = 0; i < Math.min(entries, 64) && 8 + i * 8 + 8 <= stts.length; i++) {
        const count = s.getUint32(8 + i * 8);
        const delta = s.getUint32(12 + i * 8);
        if (count > bestCount) [best, bestCount] = [delta, count];
      }
      if (best && trackScale) probe.fps = Math.round(trackScale / best);
    }
  }
  return probe.videoCodec || probe.audioCodec ? probe : null;
}

export async function probeMp4(read: Reader, size: number): Promise<Probe | null> {
  try {
    const moov = await findMoov(read, size);
    return moov ? parseMoov(moov) : null;
  } catch {
    return null;
  }
}
