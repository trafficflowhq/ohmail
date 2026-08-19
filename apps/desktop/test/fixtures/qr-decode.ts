/**
 * A SPEC-DERIVED QR DECODER, FOR TESTS — the independent check on the QR the app renders.
 *
 * Written from ISO/IEC 18004 with its OWN tables (GF(256), the level-M block structure, the
 * BCH format/version checks, the zigzag), so it cannot merely share the encoder's
 * misconceptions. Every departure from the spec THROWS with the violated rule in the message: a
 * decode is a chain of assertions (format copies agree and are BCH-valid, the EC level is M,
 * every Reed–Solomon block's syndromes are zero) before it is a byte stream.
 *
 * The Devices-pane test uses it to decode the pairing QR the pane actually rendered back to the
 * exact link — `${origin}/pair#<token>` — rather than settling for "a QR is present". A test
 * that trusted the encoder to check the encoder would prove nothing about the payload.
 */

// ─── GF(256): poly 0x11d, generator α = 2 ────────────────────────────────────────────────────
const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 510; i++) EXP[i] = EXP[i - 255]!;
}
const gmul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[(LOG[a]! + LOG[b]!) % 255]!);

/** Level-M error-correction structure, by version — this decoder's own copy of the spec table. */
const EC_M: Record<number, { ec: number; blocks: Array<[count: number, dataLen: number]> }> = {
  1: { ec: 10, blocks: [[1, 16]] },
  2: { ec: 16, blocks: [[1, 28]] },
  3: { ec: 26, blocks: [[1, 44]] },
  4: { ec: 18, blocks: [[2, 32]] },
  5: { ec: 24, blocks: [[2, 43]] },
  6: { ec: 16, blocks: [[4, 27]] },
  7: { ec: 18, blocks: [[4, 31]] },
  8: { ec: 22, blocks: [[2, 38], [2, 39]] },
  9: { ec: 22, blocks: [[3, 36], [2, 37]] },
  10: { ec: 26, blocks: [[4, 43], [1, 44]] },
  11: { ec: 30, blocks: [[1, 50], [4, 51]] },
  12: { ec: 22, blocks: [[6, 36], [2, 37]] },
  13: { ec: 22, blocks: [[8, 37], [1, 38]] },
};

/** Alignment-pattern centre coordinates, by version. */
const ALIGN: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62],
};

/** BCH(15,5) remainder over generator 0x537 — zero for a valid format word. */
const bch15 = (v: number): number => {
  let x = v;
  for (let i = 14; i >= 10; i--) if ((x >>> i) & 1) x ^= 0x537 << (i - 10);
  return x;
};

/** BCH(18,6) remainder over generator 0x1F25 — zero for a valid version word. */
const bch18 = (v: number): number => {
  let x = v;
  for (let i = 17; i >= 12; i--) if ((x >>> i) & 1) x ^= 0x1f25 << (i - 12);
  return x;
};

const MASKS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

const fail = (rule: string): never => {
  throw new Error(`qr-decode: ${rule}`);
};

/** Which modules are function/format/version modules (never data), rebuilt from the spec. */
function functionMap(size: number): boolean[][] {
  const version = (size - 17) / 4;
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      // The three corners: finder + separator + format strip (+ the dark module, bottom-left).
      if ((r < 9 && c < 9) || (r < 9 && c >= size - 8) || (r >= size - 8 && c < 9)) fn[r]![c] = true;
      if (r === 6 || c === 6) fn[r]![c] = true; // timing
    }
  }
  const centres = ALIGN[version]!;
  const last = centres[centres.length - 1];
  for (const ar of centres) {
    for (const ac of centres) {
      // The three that would collide with finders do not exist.
      if ((ar === 6 && ac === 6) || (ar === 6 && ac === last) || (ar === last && ac === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) fn[ar + dr]![ac + dc] = true;
    }
  }
  if (version >= 7) {
    for (let j = 0; j < 18; j++) {
      fn[size - 11 + (j % 3)]![Math.floor(j / 3)] = true;
      fn[Math.floor(j / 3)]![size - 11 + (j % 3)] = true;
    }
  }
  return fn;
}

/**
 * Decode a matrix (1 = dark, `matrix[row][col]`) to its byte-mode string. Throws — with the
 * violated rule — on anything out of spec.
 */
export function decodeQr(m: number[][]): string {
  const size = m.length;
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 13) fail(`unsupported size ${size}`);

  // Format info: both copies, equal, BCH-valid, level M.
  const bitsAt = (coords: Array<[number, number]>): number => coords.reduce((a, [r, c]) => (a << 1) | m[r]![c]!, 0);
  const copy1 = bitsAt([
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ]);
  const copy2 = bitsAt([
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ]);
  if (copy1 !== copy2) fail("the two format-info copies disagree");
  const fmt = copy1 ^ 0x5412;
  if (bch15(fmt) !== 0) fail("format info is not BCH-valid");
  if (((fmt >> 13) & 3) !== 0) fail("error-correction level is not M");
  const mask = (fmt >> 10) & 7;

  if (m[size - 8]![8] !== 1) fail("the dark module at (4v+9, 8) is not dark");

  // Version info for v ≥ 7: both copies, equal, BCH-valid, naming this version.
  if (version >= 7) {
    let bl = 0;
    let tr = 0;
    for (let j = 0; j < 18; j++) {
      bl |= m[size - 11 + (j % 3)]![Math.floor(j / 3)]! << j;
      tr |= m[Math.floor(j / 3)]![size - 11 + (j % 3)]! << j;
    }
    if (bl !== tr) fail("the two version-info copies disagree");
    if (bch18(bl) !== 0) fail("version info is not BCH-valid");
    if (bl >> 12 !== version) fail("version info names a different version than the matrix size");
  }

  // Unmask and read the zigzag into codewords.
  const fn = functionMap(size);
  const maskFn = MASKS[mask]!;
  const bits: number[] = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (!fn[row]![c]!) bits.push(m[row]![c]! ^ (maskFn(row, c) ? 1 : 0));
      }
    }
    upward = !upward;
  }
  const { ec, blocks } = EC_M[version]!;
  const dataLens: number[] = [];
  for (const [count, len] of blocks) for (let i = 0; i < count; i++) dataLens.push(len);
  const totalData = dataLens.reduce((a, b) => a + b, 0);
  const totalCw = totalData + dataLens.length * ec;
  if (bits.length < totalCw * 8) fail("not enough data modules for every codeword");
  const cw: number[] = [];
  for (let i = 0; i < totalCw; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j]!;
    cw.push(b);
  }

  // De-interleave into blocks, then check every block's Reed–Solomon syndromes are zero.
  const maxLen = Math.max(...dataLens);
  const data: number[][] = dataLens.map(() => []);
  let at = 0;
  for (let i = 0; i < maxLen; i++) {
    for (let b = 0; b < dataLens.length; b++) if (i < dataLens[b]!) data[b]!.push(cw[at++]!);
  }
  const eccs: number[][] = dataLens.map(() => []);
  for (let i = 0; i < ec; i++) for (let b = 0; b < dataLens.length; b++) eccs[b]!.push(cw[at++]!);
  for (let b = 0; b < dataLens.length; b++) {
    const codeword = [...data[b]!, ...eccs[b]!];
    for (let s = 0; s < ec; s++) {
      let acc = 0;
      for (const byte of codeword) acc = gmul(acc, EXP[s]!) ^ byte;
      if (acc !== 0) fail(`block ${b} syndrome S_${s} is non-zero — the codeword is corrupt`);
    }
  }

  // Parse the byte-mode stream out of the data codewords.
  const stream = data.flat();
  let pos = 0;
  const take = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | ((stream[pos >> 3]! >> (7 - (pos & 7))) & 1);
      pos++;
    }
    return v;
  };
  if (take(4) !== 4) fail("not byte mode (0100)");
  const count = take(version <= 9 ? 8 : 16);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = take(8);
  return new TextDecoder().decode(out);
}

/**
 * Recover the module matrix from a rendered `QrCode` SVG: `size` from the quiet-zone viewBox
 * (`-4 -4 size+8 size+8`), dark modules from the path's `M{x} {y}h1v1h-1z` squares. Throws on
 * a path carrying anything else, so a drawing change cannot silently decode as all-light.
 */
export function matrixFromSvg(svg: SVGSVGElement): number[][] {
  const viewBox = svg.getAttribute("viewBox") ?? fail("no viewBox");
  const [minX, , w] = viewBox.split(" ").map(Number);
  const size = w! + 2 * minX!; // w = size + 2·quiet, minX = −quiet
  const d = svg.querySelector("path")?.getAttribute("d") ?? fail("no path");
  if (d.replace(/M\d+ \d+h1v1h-1z/g, "") !== "") fail("path carries commands the parser does not read");
  const m: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  for (const [, x, y] of d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    m[Number(y)]![Number(x)] = 1;
  }
  return m;
}
