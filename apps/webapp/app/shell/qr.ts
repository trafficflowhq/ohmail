/**
 * A QR ENCODER, WHOLE, IN THIS FILE — byte mode, error-correction level M, versions 1–13.
 *
 * It exists so a phone camera never has to type what a screen can show: the invites pane
 * draws the invite link as a QR, and the pairing flows to come (a device pairing secret, a
 * server address) inherit the same idiom. It is hand-written rather than a dependency on
 * purpose — the published manifests are generated from the import closure and censused field by
 * field, and ~300 lines of ISO/IEC 18004 is a smaller liability than a new supply-chain edge on
 * a surface that renders credentials.
 *
 * What it deliberately does NOT do:
 *
 *  · no mode detection — everything is byte mode (UTF-8). The payloads are URLs carrying
 *    base64url tokens, which the numeric and alphanumeric modes cannot hold anyway (base64url
 *    is case-sensitive; the QR alphanumeric set has no lowercase).
 *  · no error-correction level choice — always M (15%). L would shave a version off long links
 *    at the cost of scan robustness on a phone pointed at a laptop screen; anything above M
 *    buys nothing for a link that is re-mintable in one click.
 *  · versions 1–13 only (334 data bytes at M). The longest realistic payload — a tailnet
 *    MagicDNS origin plus `/join/invite#` plus a 43-character token — is ~120 bytes. A payload
 *    that does not fit is REFUSED, never truncated: a QR of most of a token scans fine and then
 *    fails redeem, which is the worst kind of almost-working.
 *
 * The mask is chosen by the standard four penalty rules, and the choice is honest: the format
 * info written into the matrix names the mask that was actually applied, and the suite's
 * spec-derived decoder (its own tables, plus known-answer matrices minted from a foreign
 * encoder) reads it back out — see `test/qr.test.ts` for what was mutation-checked.
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

/** Reed–Solomon remainder of `data` against the degree-`ec` generator ∏(x − αⁱ). */
function rsRemainder(data: number[], ec: number): number[] {
  let gen = [1];
  for (let i = 0; i < ec; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j]! ^= gmul(gen[j]!, 1);
      next[j + 1]! ^= gmul(gen[j]!, EXP[i]!);
    }
    gen = next;
  }
  const res = [...data, ...new Array<number>(ec).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coef = res[i]!;
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) res[i + j]! ^= gmul(gen[j]!, coef);
  }
  return res.slice(data.length);
}

// ─── The level-M spec tables, versions 1–13 ──────────────────────────────────────────────────
/** Error-correction codewords per block, and the block structure `[count, dataCodewords]`. */
const EC_M: Array<{ ec: number; blocks: Array<[number, number]> }> = [
  { ec: 10, blocks: [[1, 16]] },
  { ec: 16, blocks: [[1, 28]] },
  { ec: 26, blocks: [[1, 44]] },
  { ec: 18, blocks: [[2, 32]] },
  { ec: 24, blocks: [[2, 43]] },
  { ec: 16, blocks: [[4, 27]] },
  { ec: 18, blocks: [[4, 31]] },
  { ec: 22, blocks: [[2, 38], [2, 39]] },
  { ec: 22, blocks: [[3, 36], [2, 37]] },
  { ec: 26, blocks: [[4, 43], [1, 44]] },
  { ec: 30, blocks: [[1, 50], [4, 51]] },
  { ec: 22, blocks: [[6, 36], [2, 37]] },
  { ec: 22, blocks: [[8, 37], [1, 38]] },
];

/** Alignment-pattern centre coordinates, indexed by version (index 0 = version 1). */
const ALIGN: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 52],
  [6, 30, 56], [6, 32, 60], [6, 34, 64],
];

const dataCodewords = (version: number): number => {
  const { blocks } = EC_M[version - 1]!;
  return blocks.reduce((a, [count, len]) => a + count * len, 0);
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

/** The 15-bit format word for level M and `mask`: BCH(15,5) over 0x537, then the 0x5412 XOR. */
function formatBits(mask: number): number {
  const data = mask; // level M is 0b00, so the five data bits are the mask alone
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18-bit version word (versions ≥ 7): BCH(18,6) over 0x1F25. */
function versionBits(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
  return (version << 12) | rem;
}

/** The standard four penalty rules; the mask with the lowest total wins. */
function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  // N1: runs of five or more same-coloured modules, rows and columns.
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const same = axis === 0 ? m[i]![j] === m[i]![j - 1] : m[j]![i] === m[j - 1]![i];
        if (same) {
          run++;
          if (j === size - 1 && run >= 5) score += run - 2;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
    }
  }
  // N2: every 2×2 block of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r]![c]!;
      if (m[r]![c + 1] === v && m[r + 1]![c] === v && m[r + 1]![c + 1] === v) score += 3;
    }
  }
  // N3: the finder-like pattern 1011101 with four light modules on either side.
  const P1 = [true, false, true, true, true, false, true, false, false, false, false];
  const P2 = [...P1].reverse();
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < size; i++) {
      for (let j = 0; j <= size - 11; j++) {
        let hit1 = true;
        let hit2 = true;
        for (let k = 0; k < 11; k++) {
          const v = axis === 0 ? m[i]![j + k]! : m[j + k]![i]!;
          if (v !== P1[k]) hit1 = false;
          if (v !== P2[k]) hit2 = false;
        }
        if (hit1) score += 40;
        if (hit2) score += 40;
      }
    }
  }
  // N4: dark-module balance, 10 points per 5% step away from 50%.
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  score += 10 * Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5);
  return score;
}

/** Write both copies of the format word for `mask` into `m` (positions per the spec). */
function writeFormat(m: boolean[][], mask: number): void {
  const size = m.length;
  const f = formatBits(mask);
  const bit = (i: number): boolean => ((f >> i) & 1) === 1; // i = 0 (LSB) … 14 (MSB)
  const copy1: Array<[number, number]> = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  const copy2: Array<[number, number]> = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];
  copy1.forEach(([r, c], i) => { m[r]![c] = bit(14 - i); });
  copy2.forEach(([r, c], i) => { m[r]![c] = bit(14 - i); });
}

/**
 * Encode `text` as a QR matrix — `matrix[row][col]`, `true` = dark. Throws when the payload
 * exceeds version 13's 334 data bytes; see the header for why refusal beats truncation.
 */
export function qrEncode(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);

  // The smallest version whose data area holds mode + count + payload (the terminator may
  // truncate, so it does not participate in the fit).
  let version = 0;
  for (let v = 1; v <= 13; v++) {
    if (4 + (v <= 9 ? 8 : 16) + 8 * bytes.length <= 8 * dataCodewords(v)) {
      version = v;
      break;
    }
  }
  if (version === 0) {
    throw new Error(`payload of ${bytes.length} bytes exceeds the 334-byte ceiling (version 13, level M)`);
  }

  // ── The data bit stream: mode, count, payload, terminator, byte padding ───────────────────
  const dc = dataCodewords(version);
  const bits: number[] = [];
  const put = (v: number, n: number): void => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(4, 4); // byte mode
  put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, dc * 8 - bits.length)); // terminator, truncated at capacity
  while (bits.length % 8 !== 0) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!;
    data.push(b);
  }
  for (let i = 0; data.length < dc; i++) data.push(i % 2 === 0 ? 0xec : 0x11);

  // ── Split into blocks, compute EC, interleave ─────────────────────────────────────────────
  const { ec, blocks } = EC_M[version - 1]!;
  const dataBlocks: number[][] = [];
  let cut = 0;
  for (const [count, len] of blocks) {
    for (let i = 0; i < count; i++) {
      dataBlocks.push(data.slice(cut, cut + len));
      cut += len;
    }
  }
  const ecBlocks = dataBlocks.map((b) => rsRemainder(b, ec));
  const interleaved: number[] = [];
  const maxLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxLen; i++) for (const b of dataBlocks) if (i < b.length) interleaved.push(b[i]!);
  for (let i = 0; i < ec; i++) for (const b of ecBlocks) interleaved.push(b[i]!);

  // ── The matrix: function patterns first, then the zigzag fill ─────────────────────────────
  const size = 17 + 4 * version;
  const mod: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  // Finders + separators + the format strips + the dark module: the three 9×9/9×8/8×9 corners
  // are function area WHOLE (every module in them is finder, separator, format or dark), which
  // is what lets the reservation be a region rather than thirty coordinates.
  const finder = (top: number, left: number): void => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        mod[top + r]![left + c] = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if ((r < 9 && c < 9) || (r < 9 && c >= size - 8) || (r >= size - 8 && c < 9)) isFn[r]![c] = true;
    }
  }
  mod[size - 8]![8] = true; // the dark module, always

  // Timing patterns.
  for (let i = 0; i < size; i++) {
    if (!isFn[6]![i]) { mod[6]![i] = i % 2 === 0; isFn[6]![i] = true; }
    if (!isFn[i]![6]) { mod[i]![6] = i % 2 === 0; isFn[i]![6] = true; }
  }

  // Alignment patterns (their rings agree with the timing modules they overlap, by design).
  const centres = ALIGN[version - 1]!;
  const last = centres[centres.length - 1];
  for (const ar of centres) {
    for (const ac of centres) {
      if ((ar === 6 && ac === 6) || (ar === 6 && ac === last) || (ar === last && ac === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc2 = -2; dc2 <= 2; dc2++) {
          mod[ar + dr]![ac + dc2] = Math.max(Math.abs(dr), Math.abs(dc2)) !== 1;
          isFn[ar + dr]![ac + dc2] = true;
        }
      }
    }
  }

  // Version information, both copies, versions ≥ 7. Bit j (LSB first) sits at
  // (size−11 + j%3, ⌊j/3⌋) bottom-left and mirrored top-right — checked against a foreign
  // encoder's output in the suite.
  if (version >= 7) {
    const vb = versionBits(version);
    for (let j = 0; j < 18; j++) {
      const on = ((vb >> j) & 1) === 1;
      mod[size - 11 + (j % 3)]![Math.floor(j / 3)] = on;
      isFn[size - 11 + (j % 3)]![Math.floor(j / 3)] = true;
      mod[Math.floor(j / 3)]![size - 11 + (j % 3)] = on;
      isFn[Math.floor(j / 3)]![size - 11 + (j % 3)] = true;
    }
  }

  // The zigzag: column pairs right to left, alternating up and down, skipping the timing
  // column. Codeword bits are MSB first; the stream running out leaves the remainder modules
  // light, which is exactly what the spec's remainder bits are.
  let at = 0;
  const totalBits = interleaved.length * 8;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (isFn[row]![c]) continue;
        mod[row]![c] = at < totalBits && ((interleaved[at >> 3]! >> (7 - (at & 7))) & 1) === 1;
        at++;
      }
    }
    upward = !upward;
  }

  // ── Choose the mask by penalty; the format info names the one actually applied ────────────
  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = mod.map((row) => [...row]);
    const maskFn = MASKS[mask]!;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFn[r]![c] && maskFn(r, c)) candidate[r]![c] = !candidate[r]![c];
      }
    }
    writeFormat(candidate, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best!;
}

/**
 * The matrix as one SVG path — `M{x} {y}h1v1h-1z` per dark module, drawn in module units so the
 * consumer scales with `viewBox`. One path rather than one `<rect>` per module: an invite QR is
 * ~1,200 dark modules, and a thousand extra DOM nodes inside a settings pane is a cost with no
 * buyer.
 */
export function qrSvgPath(matrix: boolean[][]): string {
  const parts: string[] = [];
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (matrix[r]![c]) parts.push(`M${c} ${r}h1v1h-1z`);
    }
  }
  return parts.join("");
}
