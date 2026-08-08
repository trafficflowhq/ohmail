/**
 * THE DOCK ICON'S MARGIN, measured off the shipped `.icns` rather than described.
 *
 * macOS does not scale an app icon to fit the Dock. It draws the 1024-point canvas as it is
 * given, and every system application leaves a transparent border around its artwork so that
 * the visible tiles line up: the Big Sur grid puts a square icon's body at 824 of 1024 points,
 * i.e. a hundred points of nothing on each side. An icon drawn edge to edge is therefore not
 * "the same icon without padding" — it is an icon that measures about a fifth larger than
 * every neighbour it stands beside, which is exactly how it was reported.
 *
 * The margin is a property of the FILE, so this test reads the file. It walks the `.icns`
 * container, pulls the PNG representations out of it and measures where the first non-
 * transparent pixel is, which is the same measurement the eye makes in the Dock.
 *
 * ── AND THE SMALL SIZES ARE ASSERTED TO BE DIFFERENT ────────────────────────────────────
 *
 * 16 and 32 points are full-bleed on purpose, and Apple draws its own small representations
 * that way too: a proportional inset at 16 points is a two-pixel border bought with a fifth of
 * the artwork, in the one place the artwork has the least room to spare. So both halves are
 * pinned — a regeneration that insets everything is as wrong as one that insets nothing.
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ICNS = fileURLToPath(new URL("../src-tauri/icons/icon.icns", import.meta.url));

/** One representation inside an `.icns`: its four-character type and its bytes. */
interface Element {
  type: string;
  data: Buffer;
}

/**
 * Walk the container. `icns` is a header of magic + total length, then a flat sequence of
 * `[4-byte type][4-byte length including these eight][payload]`.
 */
function elements(file: Buffer): Element[] {
  expect(file.subarray(0, 4).toString("latin1")).toBe("icns");
  expect(file.readUInt32BE(4)).toBe(file.length);
  const out: Element[] = [];
  for (let at = 8; at + 8 <= file.length; ) {
    const type = file.subarray(at, at + 4).toString("latin1");
    const length = file.readUInt32BE(at + 4);
    if (length < 8 || at + length > file.length) break;
    out.push({ type, data: file.subarray(at + 8, at + length) });
    at += length;
  }
  return out;
}

const isPng = (b: Buffer): boolean => b.length > 8 && b.readUInt32BE(0) === 0x89504e47;

/**
 * Decode an 8-bit RGBA, non-interlaced PNG to raw pixels.
 *
 * Deliberately narrow: these files come out of one generator and are all that shape, so a
 * decoder that quietly handled palettes and bit depths would be code no test ever runs.
 * Anything else throws, which is the honest outcome — the assertion below cannot be made
 * about a file this cannot read.
 */
function decode(png: Buffer): { size: number; alphaAt: (x: number, y: number) => number } {
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colour] = [data[8], data[9]];
      const interlace = data[12];
      if (depth !== 8 || colour !== 6 || interlace !== 0) {
        throw new Error(`unsupported PNG: depth ${depth}, colour ${colour}, interlace ${interlace}`);
      }
    } else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    at += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(height * stride);
  let read = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[read++]!;
    const line = raw.subarray(read, read + stride);
    read += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? px.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? cur[i - 4]! : 0;
      const b = up[i]!;
      const c = i >= 4 ? up[i - 4]! : 0;
      let v = line[i]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
  }
  expect(width).toBe(height);
  return { size: width, alphaAt: (x, y) => px[(y * stride + x * 4) + 3]! };
}

/** How many fully transparent columns stand between the left edge and the artwork. */
function inset(png: Buffer): { size: number; margin: number } {
  const { size, alphaAt } = decode(png);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      if (alphaAt(x, y) > 8) return { size, margin: x };
    }
  }
  throw new Error("the representation is entirely transparent");
}

describe("the macOS app icon", () => {
  const all = elements(readFileSync(ICNS));
  const reps = all.filter((e) => isPng(e.data)).map((e) => ({ type: e.type, ...inset(e.data) }));

  it("carries a representation at every size the Dock and Finder ask for", () => {
    const sizes = [...new Set(reps.map((r) => r.size))].sort((a, b) => a - b);
    // The 16pt pair is `ic04`/`ic05`, which Apple's packer writes as raw ARGB rather than as
    // PNG — measured below by their presence rather than by their pixels, because a raw
    // representation is a different container and decoding one would be a second decoder
    // written for two files.
    expect(sizes).toEqual([32, 64, 128, 256, 512, 1024]);
    expect(all.map((e) => e.type)).toEqual(expect.arrayContaining(["ic04", "ic05"]));
  });

  /* THE ONE THAT WAS WRONG. The Dock draws the 512 and 1024 representations, and both were
     full-bleed — margin 0 — which is what made the icon stand taller than its neighbours.
     Asserted as a RANGE rather than an exact 100/1024: the generator rounds per size, and a
     border that is a point out at 128 is not a defect. A border that is absent is. */
  it.each([128, 256, 512, 1024])("insets the %ipt artwork onto the Big Sur grid", (size) => {
    const rep = reps.find((r) => r.size === size);
    expect(rep, `no ${size}pt representation`).toBeDefined();
    const ratio = rep!.margin / size;
    expect(ratio).toBeGreaterThan(0.08);
    expect(ratio).toBeLessThan(0.12);
  });

  /* AND THE SMALL ONE IS NOT INSET, deliberately — see the header. */
  it("draws the 32pt representation edge to edge", () => {
    for (const rep of reps.filter((r) => r.size === 32)) expect(rep.margin).toBe(0);
  });
});
