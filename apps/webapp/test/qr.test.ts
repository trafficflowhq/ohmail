/**
 * ═══ THE QR ENCODER, PROVEN BY AN INDEPENDENT DECODER ═══════════════════════════════════════
 *
 * `app/shell/qr.ts` is a hand-written QR encoder (byte mode, error-correction level M) — the
 * family-invite pane draws an invite LINK as a QR so a phone camera never types a token, and
 * the flows to come (device pairing, server addresses) inherit the same idiom. No dependency
 * was added for it: the trimmed-manifest census stays exactly as it was, and the encoder is
 * a few hundred lines of spec.
 *
 * A round-trip through the encoder's own tables would prove nothing — shared misconception is
 * the standard failure of encode/decode pairs written by one hand. So the proof has two
 * independent legs:
 *
 *  1. **A spec-derived DECODER with its own tables** (`fixtures/qr-decode.ts`): it reads the
 *     format info off the matrix, verifies its BCH remainder, unmasks, de-interleaves, checks
 *     every Reed–Solomon block's syndromes are zero, and parses the byte stream back to the
 *     exact source string.
 *  2. **Frozen known-answer matrices from a FOREIGN encoder** (`fixtures/qr-known.ts`, minted
 *     once from `toqr@0.1.1`). The decoder must read those too — so it cannot merely mirror
 *     `qr.ts`'s bugs, and once the decoder is anchored to foreign bytes, the encoder passing
 *     the same decoder is evidence about the SPEC, not about self-consistency. The `v8`
 *     fixture is version SEVEN on purpose: versions ≥ 7 carry the 18-bit version-information
 *     blocks, which no smaller code exercises.
 *
 * Mutations run (each watched red, then restored):
 *  · apply mask 0 unconditionally while declaring the penalty-chosen mask in the format info
 *    → every encoder round-trip fails its syndrome check;
 *  · flip one data module after masking → syndrome check red;
 *  · write the format info without the 0x5412 XOR → the decoder's BCH check refuses.
 */
import { describe, expect, it } from "vitest";
import { qrEncode, qrSvgPath } from "@ohmail/app-logic/doors/qr";
import { decodeQr } from "./fixtures/qr-decode";
import { v2, v5, v8, v10 } from "./fixtures/qr-known";

const toMatrix = (rows: boolean[][]): number[][] => rows.map((r) => r.map((b) => (b ? 1 : 0)));

describe("the decoder itself is anchored to a FOREIGN encoder's bytes", () => {
  // `v10` earns its place the hard way: the review found the alignment-centre table wrong for
  // versions 10–13 (the last centre is size − 7, the shared table said size − 5), and every
  // round-trip was green because encoder and decoder shared the mistake. A fixture at the
  // version under test is the only check a shared table cannot satisfy.
  for (const [name, fixture] of Object.entries({ v2, v5, v8, v10 })) {
    it(`reads the frozen ${name} matrix back to its exact source string`, () => {
      expect(decodeQr(fixture.rows.map((r) => [...r].map(Number)))).toBe(fixture.text);
    });
  }
});

describe("qrEncode — every matrix decodes back to its exact input", () => {
  const CASES: Array<[string, string]> = [
    ["a short local link", "https://oh.local/join#Ab"],
    // The real shape this encoder exists for: origin + /join/invite + a 43-char base64url token.
    ["a typical invite link", "https://mail.family.example/join/invite#f3r6oV6bZ3zI7cY2qK0lO4pR9lX5bN7sM4hC4hH3tY8"],
    // A long tailnet MagicDNS origin — the worst realistic case.
    [
      "a long tailnet invite link",
      "https://ohmail-server.tail0abcd12345.ts.net/join/invite#f3r6oV6bZ3zI7cY2qK0lO4pR9lX5bN7sM4hC4hH3tY8",
    ],
    // Past 155 data bytes — proves the 16-bit character-count branch (versions ≥ 10), and with
    // it the version-information blocks on this repository's own output.
    ["a 200-character payload", `https://example.family/join/invite#${"x".repeat(165)}`],
    // Non-ASCII survives as UTF-8 bytes.
    ["an umlauted payload", "https://müller.example/einladung#tökén"],
  ];
  for (const [name, text] of CASES) {
    it(name, () => {
      expect(decodeQr(toMatrix(qrEncode(text)))).toBe(text);
    });
  }

  it("refuses a payload no supported version can hold, rather than truncating one", () => {
    expect(() => qrEncode("x".repeat(400))).toThrow();
  });
});

describe("qrSvgPath — the SVG is the matrix, one crisp square per dark module", () => {
  it("parses back to the same matrix", () => {
    const matrix = qrEncode("https://oh.local/join#Ab");
    const path = qrSvgPath(matrix);
    const rebuilt: boolean[][] = matrix.map((row) => row.map(() => false));
    for (const [, x, y] of path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
      rebuilt[Number(y)]![Number(x)] = true;
    }
    expect(rebuilt).toEqual(matrix);
    // …and nothing else is in the path: rebuilding consumed every command.
    expect(path.replace(/M\d+ \d+h1v1h-1z/g, "")).toBe("");
  });
});
