/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { ComposeAttach } from "../app/components/ComposeAttach";
import { setActiveCatalog } from "../app/shell/locale";
import {
  DEFAULT_IMAGE_QUALITY_LEVEL,
  IMAGE_QUALITY_LEVELS,
  IMAGE_QUALITY_RULES,
  IMAGE_QUALITY_STORAGE_KEY,
  LEGACY_IMAGE_SHRINK_STORAGE_KEY,
  fitWithin,
  imageQualityKeyFor,
  legacyImageShrinkKeyFor,
  readImageQualityLevel,
  compressImage,
  writeImageQualityLevel,
} from "../app/components/image-quality";
import type { ComposeAttachment } from "@ohmail/client-engine";

/**
 * SHRINKING A PICTURE ON THE WAY INTO A MESSAGE.
 *
 * ── WHAT IS REAL HERE AND WHAT IS MODELLED, STATED UP FRONT ──────────────────────────────────
 *
 * There is no JPEG codec in this test environment. jsdom has no `createImageBitmap`, no
 * `OffscreenCanvas`, and a `<canvas>` whose `getContext` returns null — so a test that wanted to
 * watch real pixels go through a real encoder would need a native image library this repository does
 * not depend on, for a browser API it would not be exercising anyway.
 *
 * So the codec is a FAITHFUL MODEL of the browser contract, installed on `globalThis` exactly where
 * the module looks for it, and everything that is actually under test is real:
 *
 *  · The FIXTURES ARE REAL BYTES — a genuine JPEG segment chain with a genuine EXIF APP1 block
 *    carrying a genuine `Orientation` tag, and a genuine PNG signature and IHDR. They are parsed
 *    here by a real segment walker, not by a stub that was told the answer.
 *  · The DECISIONS are the module's: which files are touched at all, which target dimensions, which
 *    quality, which MIME type, and whether the result is kept or thrown away. The model supplies
 *    none of them; it records what it was asked for and the assertions read those records.
 *  · "EXIF IS GONE" IS A REAL ASSERTION, and this is the part worth being precise about. The model
 *    encoder has NO ACCESS to the input file's bytes — it builds its output from the canvas
 *    dimensions and the requested type alone. So an EXIF block can only appear in the output if the
 *    module returned the ORIGINAL FILE. The check "no Exif marker in these bytes" is therefore a
 *    check that the re-encode was taken, and the cases that keep the original (`none`, and a
 *    re-encode that grew) prove the same parser finds the marker when it is there.
 *
 * The one claim that cannot be tested from Node is the browser's own behaviour — that a real canvas
 * drops metadata and that `imageOrientation: "from-image"` rotates the pixels. What IS tested is
 * that the module asks for that option, and that it sizes its output from the bitmap it got back
 * rather than from anything it read before the decode, which is the half that can regress here.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// REAL BYTES: fixture builders and the parsers the assertions read them back with.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A byte buffer over a plain `ArrayBuffer`.
 *
 * Spelled out because bare `Uint8Array` now means `Uint8Array<ArrayBufferLike>`, which admits a
 * `SharedArrayBuffer` and is therefore not a `BlobPart` — and `apps/webapp` typechecks its tests, so
 * this is a compile error rather than a thing discovered later.
 */
type Bytes = Uint8Array<ArrayBuffer>;

const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];

/** A real APP1/Exif block: "Exif\0\0", a big-endian TIFF header, IFD0 with one Orientation entry. */
function exifApp1(orientation: number): number[] {
  const tiff = [
    0x4d, 0x4d, 0x00, 0x2a, // "MM", 42 — big-endian TIFF
    0x00, 0x00, 0x00, 0x08, // IFD0 at offset 8
    0x00, 0x01, // one entry
    0x01, 0x12, // tag 0x0112 = Orientation
    0x00, 0x03, // type SHORT
    0x00, 0x00, 0x00, 0x01, // count 1
    ...u16(orientation), 0x00, 0x00, // the value, left-aligned in its 4-byte field
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ];
  const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]; // "Exif\0\0" + TIFF
  return [0xff, 0xe1, ...u16(body.length + 2), ...body];
}

/** A real SOF0: precision, height, width, one component. This is where a JPEG's size is declared. */
function sof0(width: number, height: number): number[] {
  const body = [0x08, ...u16(height), ...u16(width), 0x01, 0x01, 0x11, 0x00];
  return [0xff, 0xc0, ...u16(body.length + 2), ...body];
}

function jpegBytes(o: {
  width: number;
  height: number;
  bytes: number;
  orientation?: number;
}): Bytes {
  const head = [
    0xff, 0xd8, // SOI
    ...(o.orientation === undefined ? [] : exifApp1(o.orientation)),
    ...sof0(o.width, o.height),
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, // SOS
  ];
  const tail = [0xff, 0xd9]; // EOI
  const filler = Math.max(0, o.bytes - head.length - tail.length);
  const out = new Uint8Array(head.length + filler + tail.length);
  out.set(head, 0);
  // 0x5a, so no filler byte can be mistaken for a marker prefix by the walker below.
  out.fill(0x5a, head.length, head.length + filler);
  out.set(tail, head.length + filler);
  return out;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngBytes(o: { width: number; height: number; bytes: number }): Bytes {
  const w = o.width, hh = o.height;
  const head = [
    ...PNG_SIGNATURE,
    0x00, 0x00, 0x00, 0x0d, // IHDR length 13
    0x49, 0x48, 0x44, 0x52, // "IHDR"
    (w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff,
    (hh >>> 24) & 0xff, (hh >>> 16) & 0xff, (hh >>> 8) & 0xff, hh & 0xff,
    0x08, 0x06, 0x00, 0x00, 0x00, // depth 8, RGBA, deflate, adaptive, no interlace
    0x00, 0x00, 0x00, 0x00, // CRC — not checked by anything here
  ];
  const out = new Uint8Array(Math.max(head.length, o.bytes));
  out.set(head, 0);
  out.fill(0x5a, head.length);
  return out;
}

interface Segment {
  marker: number;
  start: number;
}

/** Walk a JPEG's segment chain up to the scan. Real parsing — the assertions depend on it. */
function jpegSegments(bytes: Uint8Array): Segment[] {
  const out: Segment[] = [];
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return out;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1]!;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    out.push({ marker, start: i + 4 });
    if (marker === 0xda) break;
    i += 2 + length;
  }
  return out;
}

function exifSegment(bytes: Uint8Array): Segment | undefined {
  return jpegSegments(bytes).find(
    (s) =>
      s.marker === 0xe1 &&
      bytes[s.start] === 0x45 && // E
      bytes[s.start + 1] === 0x78 && // x
      bytes[s.start + 2] === 0x69 && // i
      bytes[s.start + 3] === 0x66 && // f
      bytes[s.start + 4] === 0x00 &&
      bytes[s.start + 5] === 0x00,
  );
}

const hasExif = (bytes: Uint8Array): boolean => exifSegment(bytes) !== undefined;

/** The Orientation tag, or 1 when there is none. Used by the model decoder, exactly as a real one. */
function exifOrientation(bytes: Uint8Array): number {
  const seg = exifSegment(bytes);
  if (!seg) return 1;
  const tiff = seg.start + 6;
  if (bytes[tiff] !== 0x4d || bytes[tiff + 1] !== 0x4d) return 1; // big-endian only
  const ifd =
    tiff +
    ((bytes[tiff + 4]! << 24) | (bytes[tiff + 5]! << 16) | (bytes[tiff + 6]! << 8) | bytes[tiff + 7]!);
  const count = (bytes[ifd]! << 8) | bytes[ifd + 1]!;
  for (let e = 0; e < count; e += 1) {
    const p = ifd + 2 + e * 12;
    if (((bytes[p]! << 8) | bytes[p + 1]!) === 0x0112) return (bytes[p + 8]! << 8) | bytes[p + 9]!;
  }
  return 1;
}

function jpegDims(bytes: Uint8Array): { width: number; height: number } | null {
  const sof = jpegSegments(bytes).find(
    (s) => s.marker >= 0xc0 && s.marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(s.marker),
  );
  if (!sof) return null;
  return {
    height: (bytes[sof.start + 1]! << 8) | bytes[sof.start + 2]!,
    width: (bytes[sof.start + 3]! << 8) | bytes[sof.start + 4]!,
  };
}

const isJpegBytes = (b: Uint8Array): boolean => b[0] === 0xff && b[1] === 0xd8;
const isPngBytes = (b: Uint8Array): boolean => PNG_SIGNATURE.every((v, i) => b[i] === v);

function pngDims(b: Uint8Array): { width: number; height: number } {
  const at = (o: number) => (b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!;
  return { width: at(16), height: at(20) };
}

/**
 * Read a blob's bytes.
 *
 * Via `FileReader` because jsdom's `Blob` HAS NO `arrayBuffer()` — the method a browser and Node
 * both provide is the one this environment is missing. `FileReader` is the API the component itself
 * uses, so this reads the bytes by the same route the product does.
 */
function bytesOf(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer().then((b) => new Uint8Array(b));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE MODEL CODEC. Installed where the module looks: `globalThis.createImageBitmap` and
// `globalThis.OffscreenCanvas`. It decides nothing — it records what it was asked for.
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface DecodeCall {
  type: string;
  options: unknown;
}
interface EncodeCall {
  type: string | undefined;
  quality: number | undefined;
  canvas: { width: number; height: number };
  drawn: { width: number; height: number } | null;
  path: "offscreen" | "element";
}

let decodeCalls: DecodeCall[] = [];
let encodeCalls: EncodeCall[] = [];

/**
 * The size a re-encode comes out at.
 *
 * A crude but monotonic model of the two encoders' real characters, and the CHARACTER is the part
 * that matters: JPEG pays for pixels AND for quality, so both dials bite; canvas PNG is lossless and
 * ignores quality entirely, so its only lever is pixels — which is exactly why a PNG that is not
 * downscaled comes back BIGGER and hits the keep-the-original guard.
 */
function modelledSize(type: string, width: number, height: number, quality: number): number {
  return type === "image/png"
    ? Math.round(width * height * 0.5) + 100
    : Math.max(64, Math.round(width * height * quality * 0.25));
}

function encodedBlob(
  type: string | undefined,
  width: number,
  height: number,
  quality: number | undefined,
): Blob {
  const t = type ?? "image/png";
  const q = quality ?? 1;
  const bytes =
    t === "image/png"
      ? pngBytes({ width, height, bytes: modelledSize(t, width, height, q) })
      : // NO `orientation` ARGUMENT — the encoder writes no EXIF, because a canvas has none to
        // write. This is what makes "the output has no Exif marker" evidence that the re-encode
        // was taken rather than a tautology.
        jpegBytes({ width, height, bytes: modelledSize(t, width, height, q) });
  return new Blob([bytes], { type: t });
}

class ModelOffscreenCanvas {
  width: number;
  height: number;
  drawn: { width: number; height: number } | null = null;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext(id: string): { drawImage: (i: unknown, x: number, y: number, w: number, h: number) => void } | null {
    if (id !== "2d") return null;
    return {
      drawImage: (_i, _x, _y, w, hh) => {
        this.drawn = { width: w, height: hh };
      },
    };
  }

  async convertToBlob(options?: { type?: string; quality?: number }): Promise<Blob> {
    encodeCalls.push({
      type: options?.type,
      quality: options?.quality,
      canvas: { width: this.width, height: this.height },
      drawn: this.drawn,
      path: "offscreen",
    });
    return encodedBlob(options?.type, this.width, this.height, options?.quality);
  }
}

/** The decode. Reads the REAL fixture bytes, and applies the orientation the option asked for. */
async function modelCreateImageBitmap(
  blob: Blob,
  options?: { imageOrientation?: string },
): Promise<{ width: number; height: number; close: () => void }> {
  decodeCalls.push({ type: blob.type, options });
  const bytes = await bytesOf(blob);
  let dims = isPngBytes(bytes) ? pngDims(bytes) : jpegDims(bytes);
  if (!dims) throw new Error("not an image this model can decode");
  if (isJpegBytes(bytes) && options?.imageOrientation === "from-image") {
    // 5–8 are the transposed orientations. A real browser hands back a bitmap whose width and
    // height are ALREADY SWAPPED for these, which is the whole reason the module must not size its
    // canvas from anything it read before the decode.
    const orientation = exifOrientation(bytes);
    if (orientation >= 5 && orientation <= 8) dims = { width: dims.height, height: dims.width };
  }
  return { ...dims, close: () => {} };
}

type Mutable = Record<string, unknown>;

function installCodec(opts: { offscreen?: boolean } = {}): void {
  decodeCalls = [];
  encodeCalls = [];
  (globalThis as Mutable).createImageBitmap = modelCreateImageBitmap;
  if (opts.offscreen === false) delete (globalThis as Mutable).OffscreenCanvas;
  else (globalThis as Mutable).OffscreenCanvas = ModelOffscreenCanvas;
}

function uninstallCodec(): void {
  delete (globalThis as Mutable).createImageBitmap;
  delete (globalThis as Mutable).OffscreenCanvas;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// FIXTURES
// ─────────────────────────────────────────────────────────────────────────────────────────────

const PHOTO_BYTES = 2_500_000;
const photo = (o: { orientation?: number } = {}) =>
  new File(
    [jpegBytes({ width: 4000, height: 3000, bytes: PHOTO_BYTES, orientation: o.orientation ?? 1 })],
    "photo.jpg",
    { type: "image/jpeg" },
  );

/** Already small, and small enough that a re-encode at our quality comes out BIGGER. */
const thumbnail = () =>
  new File([jpegBytes({ width: 120, height: 90, bytes: 400, orientation: 1 })], "thumb.jpg", {
    type: "image/jpeg",
  });

const bigPng = () =>
  new File([pngBytes({ width: 4000, height: 3000, bytes: 5_000_000 })], "shot.png", {
    type: "image/png",
  });

const smallPng = () =>
  new File([pngBytes({ width: 200, height: 200, bytes: 1_000 })], "icon.png", {
    type: "image/png",
  });

const gif = () =>
  new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3, 4, 5])], "loop.gif", {
    type: "image/gif",
  });

const svg = () =>
  new File([new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')], "logo.svg", {
    type: "image/svg+xml",
  });

beforeEach(() => {
  installCodec();
  window.localStorage.clear();
});

afterEach(() => {
  uninstallCodec();
  window.localStorage.clear();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("the level table — one place, and these are the numbers", () => {
  it("names four levels ascending by quality, with `original` last", () => {
    expect(IMAGE_QUALITY_LEVELS).toEqual(["low", "medium", "high", "original"]);
  });

  /**
   * THE DEFAULT IS `medium`, AND THIS GUARD IS WRITTEN NOT TO PASS BY ACCIDENT.
   *
   * `toBe("medium")` alone would still hold if somebody renamed the levels and left the dial
   * pointing at the hardest squeeze, so the three assertions under it pin the CONSEQUENCE: the
   * default resolves to a rule (never `original`), that rule is 2048px at 0.82, and it is neither
   * end of the scale. Mutating `DEFAULT_IMAGE_QUALITY_LEVEL` to any of the other three levels
   * fails at least two of these lines.
   */
  it("defaults to `medium` — a rule, 2048px at 0.82, and neither end of the scale", () => {
    expect(DEFAULT_IMAGE_QUALITY_LEVEL).toBe("medium");

    const rule = IMAGE_QUALITY_RULES[DEFAULT_IMAGE_QUALITY_LEVEL];
    expect(rule).not.toBeNull();
    expect(rule).toEqual({ maxEdge: 2048, quality: 0.82 });

    const at = IMAGE_QUALITY_LEVELS.indexOf(DEFAULT_IMAGE_QUALITY_LEVEL);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(IMAGE_QUALITY_LEVELS.length - 1);
  });

  it("pins each level's longest edge and JPEG quality", () => {
    expect(IMAGE_QUALITY_RULES).toEqual({
      low: { maxEdge: 1600, quality: 0.72 },
      medium: { maxEdge: 2048, quality: 0.82 },
      high: { maxEdge: 3200, quality: 0.92 },
      original: null,
    });
  });

  it("every level in the list has an entry, and only `original` opts out", () => {
    for (const level of IMAGE_QUALITY_LEVELS) {
      expect(IMAGE_QUALITY_RULES).toHaveProperty(level);
    }
    expect(IMAGE_QUALITY_RULES.original).toBeNull();
  });

  it("fits the longest edge and never enlarges", () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });
});

describe("a JPEG at the default level", () => {
  it("comes back smaller, still a JPEG, with the EXIF gone — the acceptance check", async () => {
    const file = photo();
    const result = await compressImage(file, "low");

    expect(result.compressed).toBe(true);
    expect(result.bytes).toBeLessThan(PHOTO_BYTES);
    expect(result.originalBytes).toBe(PHOTO_BYTES);
    expect(result.contentType).toBe("image/jpeg");

    const out = await bytesOf(result.blob);
    expect(isJpegBytes(out)).toBe(true);
    // The input carried a real Exif block — the same parser finds it there.
    expect(hasExif(await bytesOf(file))).toBe(true);
    // …and does not find one here, which it could only do if the ORIGINAL bytes had been returned.
    expect(hasExif(out)).toBe(false);

    // Fitted to the level's longest edge, at the level's quality, as a JPEG.
    expect(jpegDims(out)).toEqual({ width: 1600, height: 1200 });
    expect(encodeCalls).toHaveLength(1);
    expect(encodeCalls[0]!.type).toBe("image/jpeg");
    expect(encodeCalls[0]!.quality).toBe(IMAGE_QUALITY_RULES.low!.quality);
  });

  it("each level applies its own edge and quality", async () => {
    for (const level of ["low", "medium", "high"] as const) {
      installCodec();
      const rule = IMAGE_QUALITY_RULES[level]!;
      const result = await compressImage(photo(), level);
      expect(result.compressed).toBe(true);
      expect(encodeCalls[0]!.quality).toBe(rule.quality);
      expect(Math.max(...Object.values(jpegDims(await bytesOf(result.blob))!))).toBe(rule.maxEdge);
    }
  });

  it("draws at the canvas's own size — no crop, no letterbox", async () => {
    await compressImage(photo(), "low");
    expect(encodeCalls[0]!.canvas).toEqual({ width: 1600, height: 1200 });
    expect(encodeCalls[0]!.drawn).toEqual({ width: 1600, height: 1200 });
  });
});

describe("orientation is baked into the pixels", () => {
  it("asks the decoder for the rotation", async () => {
    await compressImage(photo(), "low");
    expect(decodeCalls).toHaveLength(1);
    expect(decodeCalls[0]!.options).toEqual({ imageOrientation: "from-image" });
  });

  it("a portrait photo tagged Orientation 6 comes out PORTRAIT, not squashed into a landscape box", async () => {
    // 4000×3000 in the file, tagged as needing a quarter turn: upright it is 3000×4000. A module
    // that sized its canvas from the stored dimensions would write 1600×1200 here and hand the
    // recipient a picture on its side — which is exactly what dropping the EXIF would otherwise
    // cause, since the Orientation tag was the only thing holding it up.
    const file = photo({ orientation: 6 });
    expect(exifOrientation(await bytesOf(file))).toBe(6);

    const result = await compressImage(file, "low");
    expect(result.compressed).toBe(true);
    expect(jpegDims(await bytesOf(result.blob))).toEqual({ width: 1200, height: 1600 });
    // …and the tag that used to carry the rotation is gone, because the pixels carry it now.
    expect(hasExif(await bytesOf(result.blob))).toBe(false);
  });
});

describe("PNG stays PNG", () => {
  it("a large screenshot is downscaled and comes back as a PNG — mime and magic bytes", async () => {
    const result = await compressImage(bigPng(), "low");

    expect(result.compressed).toBe(true);
    expect(result.contentType).toBe("image/png");
    expect(encodeCalls[0]!.type).toBe("image/png");

    const out = await bytesOf(result.blob);
    expect(isPngBytes(out)).toBe(true);
    expect(isJpegBytes(out)).toBe(false);
    expect(result.blob.type).toBe("image/png");
    expect(pngDims(out)).toEqual({ width: 1600, height: 1200 });
  });

  it("a small PNG is kept — canvas PNG is lossless, so there is nothing to win", async () => {
    // THE NAMED FOLLOW-UP lives here: palette quantisation is what would actually shrink this file,
    // and it is not in this phase. Until it is, the keep-the-original guard is what stops the
    // feature making a 1 KB icon into a 20 KB one.
    const file = smallPng();
    const result = await compressImage(file, "low");
    expect(result.compressed).toBe(false);
    expect(result.blob).toBe(file);
  });
});

describe("formats that are never touched", () => {
  it("a GIF comes through byte-identical at every level", async () => {
    const file = gif();
    const before = await bytesOf(file);
    for (const level of IMAGE_QUALITY_LEVELS) {
      const result = await compressImage(file, level);
      expect(result.compressed).toBe(false);
      expect(result.blob).toBe(file);
      expect(result.contentType).toBe("image/gif");
      expect(Array.from(await bytesOf(result.blob))).toEqual(Array.from(before));
    }
    // Never decoded at all — an animated GIF through a canvas is its first frame and nothing else.
    expect(decodeCalls).toHaveLength(0);
  });

  it("an SVG comes through byte-identical, and is never rasterised", async () => {
    const file = svg();
    const before = await bytesOf(file);
    const result = await compressImage(file, "low");
    expect(result.compressed).toBe(false);
    expect(result.blob).toBe(file);
    expect(Array.from(await bytesOf(result.blob))).toEqual(Array.from(before));
    expect(decodeCalls).toHaveLength(0);
  });

  it("a PDF, and a file with no type at all, come through untouched", async () => {
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "a.pdf", {
      type: "application/pdf",
    });
    expect((await compressImage(pdf, "low")).blob).toBe(pdf);

    const unknown = new File([new Uint8Array([1, 2, 3])], "mystery");
    const result = await compressImage(unknown, "low");
    expect(result.blob).toBe(unknown);
    expect(result.contentType).toBe("application/octet-stream");
    expect(decodeCalls).toHaveLength(0);
  });
});

describe("a re-encode that came out bigger is thrown away", () => {
  it("keeps the ORIGINAL bytes, with its EXIF, and reports nothing shrunk", async () => {
    const file = thumbnail();
    // The model was asked and did answer — this is a discarded result, not a skipped encode.
    const result = await compressImage(file, "low");
    expect(encodeCalls).toHaveLength(1);
    expect(encodeCalls[0]!.canvas).toEqual({ width: 120, height: 90 });

    expect(result.compressed).toBe(false);
    expect(result.blob).toBe(file);
    expect(result.bytes).toBe(400);
    expect(result.originalBytes).toBe(400);
    // The original's metadata rides along, because the original does. The setting's copy says so
    // rather than promising a strip with an exception nobody reads.
    expect(hasExif(await bytesOf(result.blob))).toBe(true);
  });

  it("holds even when the encoder returns exactly the same size — `>=`, not `>`", async () => {
    // A re-encode that saves nothing has still thrown fidelity away, so there is no size at which
    // taking it is the better trade.
    (globalThis as Mutable).OffscreenCanvas = class extends ModelOffscreenCanvas {
      override async convertToBlob(options?: { type?: string; quality?: number }): Promise<Blob> {
        await super.convertToBlob(options);
        return new Blob([jpegBytes({ width: 1600, height: 1200, bytes: PHOTO_BYTES })], {
          type: "image/jpeg",
        });
      }
    };
    const file = photo();
    const result = await compressImage(file, "low");
    expect(result.compressed).toBe(false);
    expect(result.blob).toBe(file);
  });
});

describe("level None ships the original bytes", () => {
  it("byte-identical, EXIF intact, and never even decoded", async () => {
    const file = photo();
    const before = await bytesOf(file);
    const result = await compressImage(file, "original");

    expect(result.compressed).toBe(false);
    expect(result.blob).toBe(file);
    expect(result.bytes).toBe(PHOTO_BYTES);
    expect(Array.from(await bytesOf(result.blob))).toEqual(Array.from(before));
    expect(hasExif(await bytesOf(result.blob))).toBe(true);
    expect(decodeCalls).toHaveLength(0);
    expect(encodeCalls).toHaveLength(0);
    // No wait of its own: 1.0 s as a rule, 2.6 s once on a loaded CI VM, 23 s under 10% of a CPU.
  }, 60_000);
});

describe("a browser that cannot do it sends the original — never an error", () => {
  it("no `createImageBitmap` at all (WKWebView before iOS 15)", async () => {
    delete (globalThis as Mutable).createImageBitmap;
    const file = photo();
    const result = await compressImage(file, "low");
    expect(result.compressed).toBe(false);
    expect(result.blob).toBe(file);
  });

  it("a decoder that rejects on a corrupt file", async () => {
    (globalThis as Mutable).createImageBitmap = () => Promise.reject(new Error("decode failed"));
    const file = photo();
    expect((await compressImage(file, "low")).blob).toBe(file);
  });

  it("falls back to the <canvas> element when there is no OffscreenCanvas (WKWebView < 16.4)", async () => {
    installCodec({ offscreen: false });
    const proto = window.HTMLCanvasElement.prototype as unknown as Mutable;
    const realGetContext = proto.getContext;
    const realToBlob = proto.toBlob;
    proto.getContext = function (this: HTMLCanvasElement, id: string) {
      return id === "2d"
        ? {
            drawImage: (_i: unknown, _x: number, _y: number, w: number, hh: number) => {
              (this as unknown as Mutable).__drawn = { width: w, height: hh };
            },
          }
        : null;
    };
    proto.toBlob = function (
      this: HTMLCanvasElement,
      cb: (b: Blob | null) => void,
      type?: string,
      quality?: number,
    ) {
      encodeCalls.push({
        type,
        quality,
        canvas: { width: this.width, height: this.height },
        drawn: ((this as unknown as Mutable).__drawn as EncodeCall["drawn"]) ?? null,
        path: "element",
      });
      cb(encodedBlob(type, this.width, this.height, quality));
    };
    try {
      const result = await compressImage(photo(), "low");
      expect(result.compressed).toBe(true);
      expect(encodeCalls).toHaveLength(1);
      expect(encodeCalls[0]!.path).toBe("element");
      expect(encodeCalls[0]!.canvas).toEqual({ width: 1600, height: 1200 });
      expect(encodeCalls[0]!.quality).toBe(IMAGE_QUALITY_RULES.low!.quality);
      expect(jpegDims(await bytesOf(result.blob))).toEqual({ width: 1600, height: 1200 });
    } finally {
      proto.getContext = realGetContext;
      proto.toBlob = realToBlob;
    }
  });

  it("an OffscreenCanvas whose convertToBlob throws falls through rather than giving up", async () => {
    // The partial-implementation shape: the constructor exists, the encode does not.
    (globalThis as Mutable).OffscreenCanvas = class extends ModelOffscreenCanvas {
      override convertToBlob(): Promise<Blob> {
        throw new Error("not implemented");
      }
    };
    const proto = window.HTMLCanvasElement.prototype as unknown as Mutable;
    const realGetContext = proto.getContext;
    const realToBlob = proto.toBlob;
    proto.getContext = () => ({ drawImage: () => {} });
    proto.toBlob = function (this: HTMLCanvasElement, cb: (b: Blob | null) => void, type?: string, quality?: number) {
      cb(encodedBlob(type, this.width, this.height, quality));
    };
    try {
      expect((await compressImage(photo(), "low")).compressed).toBe(true);
    } finally {
      proto.getContext = realGetContext;
      proto.toBlob = realToBlob;
    }
  });

  it("and with no canvas of either kind, the original goes as it is", async () => {
    // No OffscreenCanvas, and jsdom's own `<canvas>` has no 2d context — the shape of a browser
    // that decoded the file and then could not draw it.
    installCodec({ offscreen: false });
    const file = photo();
    const result = await compressImage(file, "low");
    expect(result.compressed).toBe(false);
    expect(result.blob).toBe(file);
    expect(result.bytes).toBe(PHOTO_BYTES);
  });
});

describe("the stored level", () => {
  it("defaults to medium, round-trips, and refuses a value that is not a level", () => {
    expect(readImageQualityLevel()).toBe("medium");
    writeImageQualityLevel("medium");
    expect(window.localStorage.getItem(IMAGE_QUALITY_STORAGE_KEY)).toBe("medium");
    expect(readImageQualityLevel()).toBe("medium");
    window.localStorage.setItem(IMAGE_QUALITY_STORAGE_KEY, "enormous");
    expect(readImageQualityLevel()).toBe(DEFAULT_IMAGE_QUALITY_LEVEL);
  });
});

/**
 * ══ THE RENAME'S MIGRATION — AND WHY A NEW KEY WAS NOT OPTIONAL ═══════════════════════════════
 *
 * The dial used to store `none|low|medium|high` on an EFFORT axis. Three of those strings are also
 * level names on the QUALITY axis, and two denote the opposite end of it: old `high` meant "squeeze
 * hardest", which is new `low`. Had the new levels kept the old key, everyone who had ever moved
 * the dial would have had their choice silently inverted — a person who asked for the largest files
 * would start sending the smallest, with nothing on screen to say so.
 *
 * So the key moved and the old one is read as a migration source, mapped. These guards pin the
 * reversal itself, the precedence between the two keys, and the account scoping on both.
 *
 * Mutation that proves the mapping is load-bearing: make `readImageQualityLevel` read the legacy
 * value straight through instead of through `LEGACY_LEVEL_MIGRATION` — the two inverted cases
 * below go red and the `medium` case stays green, which is exactly the shape of the bug.
 */
describe("a level chosen before the rename", () => {
  it("maps the old EFFORT value onto the quality level that means the same thing", () => {
    const cases: [string, string][] = [
      ["high", "low"],        // squeeze hardest  → least quality
      ["medium", "medium"],   // the one fixed point
      ["low", "high"],        // squeeze least    → most quality
      ["none", "original"],   // never touch it   → original
    ];
    for (const [legacy, expected] of cases) {
      window.localStorage.clear();
      window.localStorage.setItem(LEGACY_IMAGE_SHRINK_STORAGE_KEY, legacy);
      expect(readImageQualityLevel(), `legacy "${legacy}"`).toBe(expected);
    }
  });

  it("is overridden the moment the new key holds anything", () => {
    window.localStorage.setItem(LEGACY_IMAGE_SHRINK_STORAGE_KEY, "none");
    expect(readImageQualityLevel()).toBe("original");
    writeImageQualityLevel("low");
    expect(readImageQualityLevel()).toBe("low");
    // …and the write went to the NEW key only. The legacy value is never rewritten.
    expect(window.localStorage.getItem(IMAGE_QUALITY_STORAGE_KEY)).toBe("low");
    expect(window.localStorage.getItem(LEGACY_IMAGE_SHRINK_STORAGE_KEY)).toBe("none");
  });

  it("migrates the ACCOUNT-SCOPED legacy key too, and that key beats the account-less one", () => {
    window.localStorage.setItem(LEGACY_IMAGE_SHRINK_STORAGE_KEY, "none");
    window.localStorage.setItem(legacyImageShrinkKeyFor("acct-1"), "high");
    expect(readImageQualityLevel("acct-1")).toBe("low");
    // A different account on the same browser still gets the account-less value.
    expect(readImageQualityLevel("acct-2")).toBe("original");
  });

  it("a garbage legacy value is the default, not a crash and not a level", () => {
    window.localStorage.setItem(LEGACY_IMAGE_SHRINK_STORAGE_KEY, "enormous");
    expect(readImageQualityLevel()).toBe(DEFAULT_IMAGE_QUALITY_LEVEL);
  });

  it("the new account-scoped key still wins over everything older", () => {
    window.localStorage.setItem(LEGACY_IMAGE_SHRINK_STORAGE_KEY, "none");
    window.localStorage.setItem(legacyImageShrinkKeyFor("acct-1"), "none");
    window.localStorage.setItem(IMAGE_QUALITY_STORAGE_KEY, "low");
    window.localStorage.setItem(imageQualityKeyFor("acct-1"), "high");
    expect(readImageQualityLevel("acct-1")).toBe("high");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ORDER, AT THE SURFACE
// ─────────────────────────────────────────────────────────────────────────────────────────────

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let handed: ComposeAttachment[] = [];

async function mount(maxTotalBytes: number, locale: "en" | "de" = "en"): Promise<void> {
  handed = [];
  const view = h(ComposeAttach as never, {
    attachments: [],
    onChange: (next: ComposeAttachment[]) => {
      handed = next;
    },
    maxTotalBytes,
  } as never);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // The register and the provider together, which is `LocaleShell`'s own contract: the SENTENCE
  // comes from the provider and the NUMBER in it from `activeFormatLocale()`.
  setActiveCatalog(locale, (locale === "de" ? de : messages) as never);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale,
        messages: locale === "de" ? de : messages,
        timeZone: "UTC",
        now: new Date("2026-08-11T09:00:00.000Z"),
        children: view,
      }),
    );
  });
}

async function pickFiles(files: File[]): Promise<void> {
  const input = host!.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  // `FileReader` delivers its load event as a TASK, not a microtask, so `act`'s drain returns while
  // the base64 is still in flight and the component has not called `onChange` yet. Yielding to the
  // task queue is what waits for it — and it is the difference between this file asserting on the
  // pick and asserting on an empty list, which reads identically until you look at the count.
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const text = (selector: string): string =>
  host!.querySelector<HTMLElement>(selector)?.textContent ?? "";

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  setActiveCatalog("en", null);
});

describe("the compression runs BEFORE the cap check", () => {
  const ONE_MB = 1024 * 1024;

  it("a photo that fits ONLY once it has been shrunk is attached — the acceptance check", async () => {
    // Over the ceiling raw. Checked first, this file is refused and the compressor
    // never sees the one file it existed for; compressed first, it lands at ~645 KB and attaches.
    expect(PHOTO_BYTES).toBeGreaterThan(ONE_MB);
    await mount(ONE_MB);
    await pickFiles([photo()]);

    expect(handed).toHaveLength(1);
    expect(handed[0]!.filename).toBe("photo.jpg");
    expect(handed[0]!.contentType).toBe("image/jpeg");
    expect(text(".compose-attach-error")).toBe("");
  });

  it("says what it did, quietly and in both catalogues", async () => {
    await mount(ONE_MB);
    await pickFiles([photo()]);
    expect(text(".compose-attach-saved")).toBe("Pictures compressed: 2.5 MB → 645 KB");
    // Not the refusal's live region — nothing went wrong.
    expect(host!.querySelector(".compose-attach-saved")!.getAttribute("role")).toBeNull();

    await act(async () => root!.unmount());
    host!.remove();
    root = null;
    await mount(ONE_MB, "de");
    await pickFiles([photo()]);
    // THE SENTENCE AND BOTH NUMBERS. This used to read "… MB → … KB" with a point in the German pane and
    // said so in its own comment: the sizes went through `toFixed`, which knows no locale, and a
    // decimal point in German is a thousands separator. The shared formatter takes the locale, so
    // the guard that was written to fail on the day somebody made that change now pins the change.
    expect(text(".compose-attach-saved")).toBe("Bilder komprimiert: 2,5 MB → 645 KB");
  });

  it("no note when nothing was compressed", async () => {
    await mount(ONE_MB);
    await pickFiles([gif()]);
    expect(handed).toHaveLength(1);
    expect(host!.querySelector(".compose-attach-saved")).toBeNull();
  });

  it("the cap still bites — on the SHRUNK size, which is the number that will be sent", async () => {
    // A 100 KiB ceiling: the compressed photo is ~645 KB and still does not fit, so it is refused
    // and the refusal is stated. Compression moves the line; it does not remove it.
    await mount(100 * 1024);
    await pickFiles([photo()]);
    expect(handed).toHaveLength(0);
    expect(text(".compose-attach-error")).toContain("102 KB");
  });

  it("at quality Original the same photo is refused — the setting reaches the attach control", async () => {
    writeImageQualityLevel("original");
    await mount(ONE_MB);
    await pickFiles([photo()]);
    expect(handed).toHaveLength(0);
    expect(decodeCalls).toHaveLength(0);
    expect(text(".compose-attach-error")).not.toBe("");
  });

  it("the running total counts compressed bytes, so a second picture still fits", async () => {
    // Two photos — over the ceiling raw together — both land, because their compressed size is
    // what is actually being carried, and 5 MB of raw bytes would not have. The ceiling is 2 MiB
    // rather than the 1 MiB the tests above use for exactly that reason: at the `medium` default
    // the pair compresses past that smaller ceiling, so it would refuse the second on its merits and
    // this guard would stop being about the running total at all. TWO NAMES on purpose: the
    // duplicate skip (CMP-F13, compose-attach-quality.test.tsx) rightly refuses the same name with
    // byte-identical content, and this test is about the running total, not about re-picking one
    // file.
    const second = new File(
      [jpegBytes({ width: 4000, height: 3000, bytes: PHOTO_BYTES, orientation: 1 })],
      "photo-2.jpg",
      { type: "image/jpeg" },
    );
    await mount(2 * ONE_MB);
    await pickFiles([photo(), second]);
    expect(handed).toHaveLength(2);
    expect(text(".compose-attach-error")).toBe("");
    expect(text(".compose-attach-saved")).toBe("Pictures compressed: 5 MB → 1.3 MB");
  });
});
