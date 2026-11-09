/**
 * THE SEGMENTS ARE LAID OUT BY THE FACE THEY CHOSE. The pure law (`segment-face.ts`) picks a face;
 * this reads the Taps the component renders for it: EQUAL shares by `flex`, PROPORTIONAL and
 * STACKED size by their basis alone — a `flex` beside the basis overrides it on the device, which
 * laid three Screener segments out equal at 277 dp and cut "Screened out". Rendered the way
 * `auto-act-panel.test.ts` renders, with the component's measurements handed in through its state.
 */
import { describe, expect, it, vi } from "vitest";

const shims = vi.hoisted(() => {
  const colour = new Proxy({}, { get: () => "#000000" });
  const number = new Proxy({}, { get: () => 8 });
  const style = new Proxy({}, { get: () => ({}) });
  return { theme: { c: colour, radius: number, type: style, lift: (_l: string): unknown => null } as Record<string, unknown>, states: [] as unknown[] };
});
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return { ...real, useState: (v: unknown) => [shims.states.length > 0 ? shims.states.shift() : v, () => {}] };
});
vi.mock("react-native", () => ({
  Pressable: "Pressable", Text: "Text", View: "View", StyleSheet: { hairlineWidth: 1 }, Platform: { OS: "android" },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }));
vi.mock("../src/ui/posture", () => ({ usePosture: () => ({}) }));
vi.mock("../src/ui/Icon", () => ({ Icon: "Icon" }));
vi.mock("../src/theme", () => ({ useTheme: () => shims.theme }));

import { Segmented } from "../src/ui/Segmented";
import { Tap } from "../src/ui/base";

type El = { type: unknown; props: Record<string, unknown> };
function walk(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if (node && typeof node === "object" && "props" in node) { out.push(node as El); walk((node as El).props.children, out); }
  return out;
}
const flat = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean).map(flat)) : ((style as Record<string, unknown>) ?? {});

/** The segment Taps' flattened styles, the component handed a width and its labels' measured widths. */
function tapsOf(width: number, sizes: Record<string, number>) {
  shims.states.push(width, sizes);
  const tree = walk(Segmented({
    segments: [{ value: "a", label: "Waiting", count: 983 }, { value: "b", label: "Screened out", count: 0 }, { value: "c", label: "Spam", count: 0 }],
    value: "a", onChange: () => {},
  }));
  return tree.filter((e) => e.type === Tap) as Array<El & { key?: string | null }>;
}
const tapsAt = (width: number, sizes: Record<string, number>) => tapsOf(width, sizes).map((e) => flat(e.props.style));

describe("each face lays the segments out by its own rule", () => {
  // The 560-dpi cover: 277 dp, labels measured 60 / 82 / 40 dp with counts of 21 / 9 / 9.
  const sizes = { l0: 60, c0: 21, l1: 82, c1: 9, l2: 40, c2: 9 };
  it("stacked: each segment is at least its label and its padding, with no flex to share it out equal", () => {
    const taps = tapsAt(277, sizes);
    expect(taps).toHaveLength(3);
    for (const [i, t] of taps.entries()) {
      expect(t.flex, `segment ${i} still shares by flex`).toBeUndefined();
      expect(t.flexShrink).toBe(0);
      expect(t.flexBasis).toBe([60, 82, 40][i]! + 16);
    }
  });
  it("proportional: the basis is the label and its count", () => {
    const taps = tapsAt(300, { l0: 40, c0: 10, l1: 82, c1: 9, l2: 40, c2: 9 });
    expect(taps.map((t) => t.flexBasis)).toEqual([40 + 15 + 16, 82 + 14 + 16, 40 + 14 + 16]);
    expect(taps.every((t) => t.flex === undefined)).toBe(true);
  });
  /* at 313 dp with font 1.3 the selected segment read "Waiti… 12". Its basis is its
     label and the 16 of padding, and the light scheme's 1 dp ring was a BORDER inside that box,
     two dp short of the label. The ring is paint over the padding, never room taken from it. */
  it("the selected segment's ring takes no room: every label keeps its whole measured width", () => {
    const large = { l0: 63, c0: 22, l1: 107, c1: 9, l2: 42, c2: 9 };
    const taps = tapsOf(273, large);
    for (const [i, e] of taps.entries()) {
      const t = flat(e.props.style);
      const border = ((t.borderWidth as number | undefined) ?? 0) * 2;
      const room = (t.flexBasis as number) - 2 * (t.paddingHorizontal as number) - border;
      expect(room, `segment ${i}: the label's room inside the box`).toBeGreaterThanOrEqual([63, 107, 42][i]!);
    }
  });
  it("control: the light scheme still draws the ring on the selected segment, and only there", () => {
    const rings = tapsOf(273, { l0: 63, c0: 22, l1: 107, c1: 9, l2: 42, c2: 9 }).map((e) =>
      walk(e.props.children).filter((c) => flat(c.props.style).borderWidth === 1).length);
    expect(rings).toEqual([1, 0, 0]);
  });
  it("a face whose lift is a ring (ohmarchy light): the selected segment keeps its lift and draws no second ring", () => {
    const lifted: unknown[] = [];
    Object.assign(shims.theme, { scheme: "light", ringed: true, lift: (l: string) => { lifted.push(l); return { lift: l }; } });
    try {
      const taps = tapsOf(273, { l0: 63, c0: 22, l1: 107, c1: 9, l2: 42, c2: 9 });
      const rings = taps.map((e) => walk(e.props.children).filter((c) => flat(c.props.style).borderWidth === 1).length);
      expect({ rings, lift: flat(taps[0]!.props.style).lift }).toEqual({ rings: [0, 0, 0], lift: "l1" });
    } finally {
      Object.assign(shims.theme, { scheme: undefined, ringed: undefined, lift: () => null });
    }
  });
  it("a face change mounts the segments afresh: a removed `flex` stays on a native view (measured on Android)", () => {
    const measured = { l0: 48, c0: 21, l1: 84, c1: 7, l2: 37, c2: 7 };
    const before = tapsOf(0, {}).map((e) => e.key);
    const after = tapsOf(263, measured).map((e) => e.key);
    for (const [i, k] of after.entries()) expect(k, `segment ${i} kept its native view across the face change`).not.toBe(before[i]);
  });
  it("equal (and unmeasured): the segments share by flex", () => {
    for (const t of tapsAt(0, {})) expect(t.flex).toBe(1);
    for (const t of tapsAt(600, sizes)) expect(t.flex).toBe(1);
  });
});
