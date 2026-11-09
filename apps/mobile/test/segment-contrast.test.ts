/**
 * ═══ THE SELECTED SEGMENT STANDS OUT OF ITS TRACK ═════════════════════════════════════════
 *
 * The selected segment was a white pill on a near-white track (fill contrast 1.13:1 light, 1.14:1
 * dark), carried by its shadow and bold label. Light: the float pill keeps an l1 lift and gains a
 * 1 dp hair ring. Dark: a float pill over a light wash cannot stand out on the dark grounds, so the
 * track is `tint` and the selected segment a `hair` wash, at least 6 OKLCH lightness points above
 * the track on each ground the control sits on (canvas, panel, the decision bar's float).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { authored } from "../src/theme/palette";
import { srgb255, type Oklch } from "../src/theme/oklch";
import { liftIsRing, ringOnLift } from "../src/theme/lift";
import { segmentPaint } from "../src/ui/segment-face";

/** sRGB 8-bit → OKLab L, Björn Ottosson's forward matrix. */
const lightnessOf = (rgb: readonly number[]): number => {
  const lin = rgb.map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const [r, g, b] = lin as [number, number, number];
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  return 0.2104542553 * Math.cbrt(l) + 0.793617785 * Math.cbrt(m) - 0.0040720468 * Math.cbrt(s);
};
/** A token painted over a ground, as the compositor blends it (gamma-encoded channels). */
const over = (fg: Oklch, ground: readonly number[]): number[] => srgb255(fg).map((c, i) => c * fg.a + ground[i]! * (1 - fg.a));

describe("dark: the selected segment over its track", () => {
  const D = authored.dark;
  const paint = segmentPaint("dark");
  for (const ground of ["canvas", "panel", "float"] as const) {
    it(`on the ${ground}: ΔL ≥ 6`, () => {
      const g = srgb255(D[ground]!);
      const track = over(D[paint.track]!, g);
      const selected = over(D[paint.selected]!, track);
      expect((lightnessOf(selected) - lightnessOf(track)) * 100).toBeGreaterThanOrEqual(6);
    });
  }
  it("the old paint is the defect this reads: float over tint2 on the canvas is under 1 point", () => {
    const g = srgb255(D.canvas!);
    const track = over(D.tint2!, g);
    expect(Math.abs(lightnessOf(srgb255(D.float!)) - lightnessOf(track)) * 100).toBeLessThan(1);
  });
});

describe("light: a lifted float with a hair ring", () => {
  it("keeps the float pill on the tint2 track and adds the ring", () => {
    expect(segmentPaint("light")).toEqual({ track: "tint2", selected: "float", ring: true });
  });
  it("the control paints what segmentPaint says", () => {
    const seg = withoutComments(readFileSync(fileURLToPath(new URL("../src/ui/Segmented.tsx", import.meta.url)), "utf8"));
    expect(seg).toContain("const paint = segmentPaint(t.scheme, t.ringed);");
    expect(seg).toContain("backgroundColor: t.c[paint.track],");
    expect(seg).toContain('backgroundColor: on ? t.c[paint.selected] : "transparent",');
    expect(seg).toContain('on ? t.lift("l1") : null,');
    // The ring is an overlay over the padding, not a border inside the basis.
    expect(seg).toContain("{on && paint.ring ? (");
    expect(seg).toContain("borderRadius: t.radius.pill, borderWidth: 1, borderColor: t.c.hair }}");
  });
});

/* Ohmarchy lifts by flat rings: l1 is a 2 px ring, so the hair ring over it drew a 3 px frame, heavier than the
   panel's own ring. A face whose lift is a ring keeps the lift alone; paper's blurred lift keeps the hair ring. */
describe("a face that lifts by rings wears one ring", () => {
  it("ohmarchy's l1 is a ring in both schemes, paper's is not", () => {
    expect(["light", "dark"].map((s) => liftIsRing(s as "light" | "dark", "l1", "ohmarchy"))).toEqual([true, true]);
    expect(["light", "dark"].map((s) => liftIsRing(s as "light" | "dark", "l1", "paper"))).toEqual([false, false]);
  });
  it("light over a ringed face: no hair ring on the selected segment", () => {
    expect(segmentPaint("light", true)).toEqual({ track: "tint2", selected: "float", ring: false });
    expect(segmentPaint("light", false).ring).toBe(true);
    expect(segmentPaint("dark", true)).toEqual(segmentPaint("dark", false));
  });
  const ai = { offsetX: 0, offsetY: 0, blurRadius: 0, spreadDistance: 1.5, color: "#000000" };
  const layers = (scheme: "light" | "dark", face: "paper" | "ohmarchy") => {
    const l0 = { boxShadow: [{ offsetX: 0, offsetY: 0, blurRadius: 0, spreadDistance: 1, color: "#111111" }, { offsetX: 0, offsetY: 1, blurRadius: 2, spreadDistance: 0, color: "#222222" }] };
    return { l0, out: ringOnLift(l0, ai, liftIsRing(scheme, "l0", face)).boxShadow };
  };
  it("the AI capsule's ring is added to paper's lift, the accent ring on top", () => {
    const { l0, out } = layers("light", "paper");
    expect(out).toEqual([ai, ...l0.boxShadow]);
  });
  it("on a ringed face the AI ring takes the l0 ring's place instead of framing it twice", () => {
    expect(layers("light", "ohmarchy").out).toEqual([ai]);
    expect(layers("dark", "ohmarchy").out).toEqual([ai]);
  });
});
