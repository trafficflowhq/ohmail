/**
 * A PICTURE'S SIZE, READ FROM ITS OWN BYTES, for every family the image proxy serves: GIF, PNG
 * and APNG, JPEG, WebP, AVIF, BMP and ICO. The label is never read — a decoder picks the format by
 * its bytes, so a 1×1 is a 1×1 whatever the sender called it. `null` is "this cannot be sized": an
 * unknown family or a header that does not parse. Import-free: the proxy (`packages/services`)
 * reads it, and so can a reader that may not import services. Every read is bounds-checked; the
 * bytes are the sender's.
 */
export interface ImageSize {
  w: number;
  h: number;
}

export function imageDimensions(b: Uint8Array): ImageSize | null {
  if (at(b, 0, [0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return gif(b);
  if (at(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return png(b);
  if (at(b, 0, [0xff, 0xd8, 0xff])) return jpeg(b);
  if (at(b, 0, [0x52, 0x49, 0x46, 0x46]) && at(b, 8, [0x57, 0x45, 0x42, 0x50])) return webp(b);
  if (fourcc(b, 4) === "ftyp") return avif(b);
  if (at(b, 0, [0x42, 0x4d])) return bmp(b);
  if (at(b, 0, [0x00, 0x00]) && (b[2] === 0x01 || b[2] === 0x02) && b[3] === 0x00) return ico(b);
  return null;
}

/** The logical screen, little-endian. */
function gif(b: Uint8Array): ImageSize | null {
  return b.length < 10 ? null : { w: u16le(b, 6), h: u16le(b, 8) };
}

/** IHDR is the first chunk by the format's own rule; anything else is not a PNG we can size. */
function png(b: Uint8Array): ImageSize | null {
  return b.length < 24 || fourcc(b, 12) !== "IHDR" ? null : { w: u32be(b, 16), h: u32be(b, 20) };
}

/**
 * The frame header's size, the header walked as libjpeg walks it: stray bytes before a marker are
 * skipped, fill 0xFF swallowed, and FF00 is stuffed data, not a marker. Each APPn is skipped by its
 * own length, so a thumbnail inside EXIF is never read as the picture. A scan, an EOI or a second
 * SOI before any frame header is a file the decoder refuses, and so is not sized.
 */
function jpeg(b: Uint8Array): ImageSize | null {
  let i = 2;
  while (i < b.length) {
    while (i < b.length && b[i] !== 0xff) i += 1;
    while (i < b.length && b[i] === 0xff) i += 1;
    if (i >= b.length) return null;
    const m = b[i]!;
    i += 1;
    if (m === 0x00 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    if (m === 0xd8 || m === 0xd9 || m === 0xda || i + 1 >= b.length) return null;
    const len = u16be(b, i);
    if (len < 2) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return len < 7 || i + 6 >= b.length ? null : { w: u16be(b, i + 5), h: u16be(b, i + 3) };
    }
    i += len;
  }
  return null;
}

/** VP8's frame header (14-bit fields), VP8L's packed header, VP8X's 24-bit canvas plus one. */
function webp(b: Uint8Array): ImageSize | null {
  const kind = fourcc(b, 12);
  if (kind === "VP8 ") {
    if (b.length < 30 || !at(b, 23, [0x9d, 0x01, 0x2a])) return null;
    return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
  }
  if (kind === "VP8L") {
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8X") {
    if (b.length < 30) return null;
    return { w: u24le(b, 24) + 1, h: u24le(b, 27) + 1 };
  }
  return null;
}

/**
 * An AVIF by its MAJOR brand. `avif` is the primary item even when tracks exist, which is what the
 * browser engines draw. `avis` reads the first colour track, and any other brand that track if there
 * is one, else the primary item: the engines choose more narrowly for both, so a file built to make
 * the two disagree can read as a size it is not drawn at. The primary item's `ispe` is found through
 * `pitm` and `ipma`, never the first `ispe` in the file (a thumbnail's or a grid tile's).
 */
function avif(b: Uint8Array): ImageSize | null {
  const top = boxes(b, 0, b.length);
  const ftyp = top.find((x) => x.type === "ftyp");
  if (!ftyp || ftyp.from + 8 > ftyp.to || !isAvif(b, ftyp)) return null;
  const major = fourcc(b, ftyp.from);
  const meta = top.find((x) => x.type === "meta");
  const item = (): ImageSize | null => (meta ? primarySize(b, meta) : null);
  if (major === "avif") return item();
  const moov = top.find((x) => x.type === "moov");
  const track = moov ? trackSize(b, moov) : null;
  return major === "avis" ? track : track ?? item();
}

interface Box {
  type: string;
  /** Where the payload starts, after the size, the type and any 64-bit size. */
  from: number;
  to: number;
}

/** The boxes in `[from, to)`, in order; a box that does not fit ends the list. */
function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let i = from;
  while (i + 8 <= to && out.length < 4096) {
    let size = u32be(b, i);
    let head = 8;
    if (size === 1) {
      if (i + 16 > to || u32be(b, i + 8) !== 0) break;
      size = u32be(b, i + 12);
      head = 16;
    } else if (size === 0) size = to - i;
    if (size < head || i + size > to) break;
    out.push({ type: fourcc(b, i + 4), from: i + head, to: i + size });
    i += size;
  }
  return out;
}

/** The major brand or a compatible one is `avif` or `avis`, read in place and never collected. */
function isAvif(b: Uint8Array, ftyp: Box): boolean {
  const named = (o: number): boolean => ["avif", "avis"].includes(fourcc(b, o));
  if (named(ftyp.from)) return true;
  for (let i = ftyp.from + 8; i + 4 <= ftyp.to; i += 4) if (named(i)) return true;
  return false;
}

/** The first colour track's `tkhd` size: 16.16 fixed point, at 76 or 88 bytes in by version. */
function trackSize(b: Uint8Array, moov: Box): ImageSize | null {
  for (const trak of boxes(b, moov.from, moov.to).filter((x) => x.type === "trak")) {
    const kids = boxes(b, trak.from, trak.to);
    if (!colourTrack(b, kids)) continue;
    const tkhd = kids.find((x) => x.type === "tkhd");
    const at0 = tkhd ? tkhd.from + (b[tkhd.from] === 1 ? 88 : 76) : -1;
    if (!tkhd || at0 + 8 > tkhd.to) return null;
    const size = { w: u32be(b, at0) >>> 16, h: u32be(b, at0 + 4) >>> 16 };
    return size.w > 0 && size.h > 0 ? size : null;
  }
  return null;
}

/**
 * The track read as a sequence's picture: an `av01` sample entry in `stsd`, and no `auxl` reference,
 * which marks the alpha track. A `trak` with only a `tkhd` names a size nothing decodes. The engines
 * also pass over a track with no chunks, a zero id or a sound handler; this does not.
 */
function colourTrack(b: Uint8Array, trak: Box[]): boolean {
  const tref = trak.find((x) => x.type === "tref");
  if (tref && boxes(b, tref.from, tref.to).some((x) => x.type === "auxl")) return false;
  let at = trak.find((x) => x.type === "mdia");
  for (const type of ["minf", "stbl", "stsd"]) at = at && boxes(b, at.from, at.to).find((x) => x.type === type);
  return at !== undefined && boxes(b, at.from + 8, at.to).some((x) => x.type === "av01");
}

function primarySize(b: Uint8Array, meta: Box): ImageSize | null {
  const kids = boxes(b, meta.from + 4, meta.to);
  const pitm = kids.find((x) => x.type === "pitm");
  const iprp = kids.find((x) => x.type === "iprp");
  const idLen = pitm && b[pitm.from] === 0 ? 2 : 4;
  if (!pitm || !iprp || pitm.from + 4 + idLen > pitm.to) return null;
  const primary = idLen === 2 ? u16be(b, pitm.from + 4) : u32be(b, pitm.from + 4);
  const parts = boxes(b, iprp.from, iprp.to);
  const ipco = parts.find((x) => x.type === "ipco");
  if (!ipco) return null;
  const props = boxes(b, ipco.from, ipco.to);
  for (const ipma of parts.filter((x) => x.type === "ipma")) {
    for (const index of associations(b, ipma, primary)) {
      const p = props[index - 1];
      if (p?.type === "ispe" && p.from + 12 <= p.to) return { w: u32be(b, p.from + 4), h: u32be(b, p.from + 8) };
    }
  }
  return null;
}

/** The 1-based property indices `ipma` associates with one item. */
function associations(b: Uint8Array, ipma: Box, item: number): number[] {
  const version = b[ipma.from]!;
  const wide = (b[ipma.from + 3]! & 1) === 1;
  let i = ipma.from + 4;
  if (i + 4 > ipma.to) return [];
  const count = u32be(b, i);
  i += 4;
  for (let e = 0; e < count && i < ipma.to; e += 1) {
    const idBytes = version < 1 ? 2 : 4;
    if (i + idBytes + 1 > ipma.to) return [];
    const id = version < 1 ? u16be(b, i) : u32be(b, i);
    i += idBytes;
    const n = b[i]!;
    i += 1;
    const found: number[] = [];
    for (let k = 0; k < n; k += 1) {
      if (i + (wide ? 2 : 1) > ipma.to) return [];
      found.push(wide ? u16be(b, i) & 0x7fff : b[i]! & 0x7f);
      i += wide ? 2 : 1;
    }
    if (id === item) return found;
  }
  return [];
}

/** The core header's 16-bit fields, or a later header's 32-bit ones; a top-down BMP's height is negative. */
function bmp(b: Uint8Array): ImageSize | null {
  if (b.length < 18) return null;
  const head = u32le(b, 14);
  if (head === 12) return b.length < 22 ? null : { w: u16le(b, 18), h: u16le(b, 20) };
  if (![16, 40, 52, 56, 64, 108, 124].includes(head) || b.length < 26) return null;
  const w = i32le(b, 18);
  return w < 0 ? null : { w, h: Math.abs(i32le(b, 22)) };
}

/** The largest entry, the one a browser draws; a 0 in the directory is 256. */
function ico(b: Uint8Array): ImageSize | null {
  const n = u16le(b, 4);
  if (n === 0 || 6 + 16 * n > b.length) return null;
  let best: ImageSize | null = null;
  for (let e = 0; e < n; e += 1) {
    const w = b[6 + 16 * e] || 256;
    const h = b[7 + 16 * e] || 256;
    if (!best || w * h > best.w * best.h) best = { w, h };
  }
  return best;
}

function at(b: Uint8Array, o: number, bytes: number[]): boolean {
  return b.length >= o + bytes.length && bytes.every((x, k) => b[o + k] === x);
}
function fourcc(b: Uint8Array, o: number): string {
  return b.length < o + 4 ? "" : String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
}
const u16le = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u16be = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;
const u24le = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32le = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const u32be = (b: Uint8Array, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const i32le = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24);
