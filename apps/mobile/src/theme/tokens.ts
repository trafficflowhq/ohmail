/**
 * The non-colour, non-type half of Blanc: radii, spacing, motion, layering.
 *
 * All of it is a straight numeric copy of `packages/tokens/src/tokens.ts` —
 * CSS px are RN density-independent points, so nothing needs converting. The
 * only entries with no CSS twin are the two marked `phone:`, which exist
 * because a phone has hardware the deck never had (a home indicator, a thumb).
 */

/** `radius` — CSS px → RN `borderRadius` points, 1:1. */
export const radius = {
  /** tag dot */ dot: 3,
  /** keycap */ keycap: 6,
  /** focus ring */ focus: 8,
  /** nav items */ item: 10,
  /** menu rows */ menuItem: 11,
  /** palette rows */ paletteItem: 13,
  /** receipts rows, art, hits */ rowDense: 14,
  /** list rows */ row: 16,
  /** inputs, tag picker */ input: 18,
  /** panels, protected block */ panel: 20,
  /** cards, sheets */ card: 22,
  /** overlays */ overlay: 24,
  /** reader — the exhale */ reader: 28,
  /** capsules — buttons, chips, tab pill */ pill: 999,
} as const;

/**
 * `spacing` — the 2px-grained scale Blanc actually uses. Not a strict 4/8 grid:
 * the deck breathes on 16 and the optical offsets in between are deliberate.
 */
export const space = {
  scale: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 26, 30, 34] as const,
  /** shell padding + column gap */ deck: 16,
  /** `.deck{padding:0 10px 10px}` in the ≤900px block — the phone value */ deckCompact: 10,
  /** list-column horizontal padding (desktop) */ paneX: 30,
  /** `.rows{padding-left/right:8px}` + `.grouplabel{padding-left:20px}` on mobile */ paneXCompact: 20,
  /** message column padding */ messageX: 34,
  /** `.msg{padding:20px 20px 40px}` on mobile */ messageXCompact: 20,
  /** phone: room under every scroller for the tab bar + full shadow falloff */
  tabClearance: 96,
} as const;

/** `layout` — the widths that still matter on a phone. */
export const layout = {
  /** the reading column never exceeds this, so a tablet does not run 900px lines */
  proseMax: 620,
  /** `layout.mobileMax` — at or below, the deck is one column. A phone always is. */
  mobileMax: 900,
} as const;

/**
 * `motion` — the two easing voices as cubic-bézier control points, ready for
 * `Easing.bezier(...)`. Durations are seconds in CSS, milliseconds in RN.
 */
export const motion = {
  easing: {
    /** arrivals, entrances, slides */ spring: [0.22, 1, 0.3, 1] as const,
    /** state flips, presses, shadow transitions */ swift: [0.3, 0.9, 0.2, 1] as const,
  },
  /** ms */
  duration: {
    instant: 150,
    fast: 160,
    swift: 200,
    base: 250,
    gentle: 300,
    entrance: 320,
    drawer: 350,
    shell: 400,
    expand: 500,
    /** the seen-dot fade, from macOS `blancSeen` */ seen: 700,
  },
} as const;

/**
 * `zLayer` — semantic, never arbitrary. On a phone most of these are separate
 * routes rather than stacked layers, so only the ones that really overlap the
 * content remain.
 */
export const zLayer = {
  tabBar: 30,
  sheet: 50,
  toast: 90,
} as const;

/** Minimum touch target. HIG 44pt, Material 48dp — take the larger. */
export const HIT = 48;
