/**
 * THE TOP PADDING OF A STRIP THAT DRAWS UNDER THE STATUS BAR — the OS inset plus the design's
 * own gap, and never the gap alone.
 *
 * `Screen` is a plain view and `Scroller` pays only the BOTTOM inset, so a strip at the top of a
 * route owes its own top inset. The door chooser did not pay it: a fixed `paddingTop: 28` put the
 * wordmark on an iPhone's clock at every launch, while the signed-in bars had always added
 * `insets.top`. One function, so a route cannot express the wrong arithmetic; the hook over the
 * live inset is `useTopPad` in `base.tsx`, and `test/safe-area-census.test.ts` refuses a route
 * that spells the padding itself.
 *
 * Dependency-free on purpose — the suite drives it at a real inset, and a module importing
 * react-native is a module a node test cannot load.
 */
export function topPad(insetTop: number, gap: number): number {
  return insetTop + gap;
}
