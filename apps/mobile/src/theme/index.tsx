/**
 * Theme resolution: preference + system appearance + FACE → one `Theme` in context.
 *
 * `useTheme()` is the only way a screen gets a colour, a shadow or a type
 * preset. No component holds a literal colour; `test/theme.test.ts` greps the
 * screen sources for stray `#rrggbb` / `rgba(` / `oklch(` and fails on a hit —
 * the same audit the retired macOS client ran over its Swift sources.
 *
 * ── THE FACE — paper / ohmarchy (OHMARCHY-PLAN.md §3a) ─────────────────────────────────────
 *
 * A SECOND appearance dimension, orthogonal to light/dark: the scheme picks a palette, the face
 * picks WHICH SET of palettes, radii, lifts and easings the theme is assembled from. Both sets
 * have one shape, and the swap happens here — so every component keeps reading `t.c`, `t.radius`
 * and `t.lift()` exactly as it did, which is the one-UI law expressed structurally rather than
 * policed (OHMARCHY-CONTRACT.md; the webapp's census does not govern this app because this app
 * has its own theming machinery, which is what this file is).
 *
 * The FACE ARRIVES AS A PROP, like `pref`. It is resolved above this provider (`./face.ts`, the
 * pure rules, driven by `test/ohmarchy-face.test.ts`) from the device's pin and the account's
 * synced answer, because the account half is a `GET /consent` field and this module has no wire —
 * the same separation `packages/ui`'s provider keeps for the same reason.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AccessibilityInfo, useColorScheme, type ViewStyle } from "react-native";
import { DEFAULT_FACE, teachOf, type FaceName } from "./face";
import { lift, liftUp, type LiftLevel } from "./lift";
import { ohmarchyEasing, ohmarchyRadius } from "./ohmarchy";
import { paletteOf, type Palette, type SchemeName } from "./palette";
import { type as typePresets } from "./type";
import { HIT, layout, motion, radius, space, zLayer } from "./tokens";

export * from "./face";
export * from "./oklch";
export * from "./ohmarchy";
export * from "./palette";
export * from "./lift";
export * from "./type";
export * from "./tokens";

export type ThemePref = "system" | "light" | "dark";

/**
 * The radius ladder as the THEME exposes it — the same keys, widened from paper's literal
 * numbers, because a face supplies its own values for them (`ohmarchyRadius`). The paper ladder
 * itself keeps its literal types in `./tokens`, where the fidelity test reads them.
 */
export type ThemeRadius = Readonly<Record<keyof typeof radius, number>>;

/**
 * `motion` as the theme exposes it: the easing pair widened for the same reason as the radii (a
 * face moves the curves), the DURATIONS not widened at all — a face changes how a transition
 * eases, never how long the product makes somebody wait.
 */
export interface ThemeMotion {
  readonly easing: {
    readonly spring: readonly [number, number, number, number];
    readonly swift: readonly [number, number, number, number];
  };
  readonly duration: typeof motion.duration;
}

export interface Theme {
  scheme: SchemeName;
  /** The face actually rendered right now. Always concrete — `paper` is the resting value. */
  face: FaceName;
  /**
   * Teaching intensity, the contract's ONE JS-visible switch: 0 (paper, calm) / 1 (ohmarchy,
   * loud). Derived from the face, so the two can never disagree.
   */
  teach: 0 | 1;
  c: Palette;
  type: typeof typePresets;
  radius: ThemeRadius;
  space: typeof space;
  layout: typeof layout;
  motion: ThemeMotion;
  zLayer: typeof zLayer;
  hit: number;
  /** Shadow ladder, pre-bound to the active scheme. */
  lift: (level: LiftLevel) => ViewStyle;
  /** The same ladder, falling upward — the bottom decision bar's occlusion. */
  liftUp: (level: LiftLevel) => ViewStyle;
  /**
   * True when the OS asks for reduced motion. Blanc's policy is verbatim from
   * the prototype: transitions collapse to *instant*, never merely slower.
   */
  reduceMotion: boolean;
  /** ms, already zeroed when `reduceMotion` is on — the one place that decides. */
  ms: (d: keyof typeof motion.duration) => number;
}

const ThemeContext = createContext<Theme | null>(null);

export function useTheme(): Theme {
  const t = useContext(ThemeContext);
  if (!t) throw new Error("useTheme() outside <ThemeProvider>");
  return t;
}

/**
 * The face's non-colour half, assembled once per face.
 *
 * Radius comes from the generated ladder; easing is the two curves ohmarchy really moves, spread
 * over paper's `motion` so the DURATIONS (and `reduceMotion`'s zeroing of them) stay one table —
 * a face changes how a transition eases, never how long the product waits.
 */
function faceTokens(face: FaceName): { radius: ThemeRadius; motion: ThemeMotion } {
  if (face !== "ohmarchy") return { radius, motion };
  return {
    radius: ohmarchyRadius,
    motion: { ...motion, easing: { spring: ohmarchyEasing.spring, swift: ohmarchyEasing.swift } },
  };
}

export function ThemeProvider({
  pref,
  face = DEFAULT_FACE,
  children,
}: {
  pref: ThemePref;
  /** The resolved appearance face — see `./face.ts`. Absent = paper, the resting value. */
  face?: FaceName;
  children: ReactNode;
}) {
  const system = useColorScheme();
  const reduceMotion = useReduceMotion();
  const scheme: SchemeName = pref === "system" ? (system === "dark" ? "dark" : "light") : pref;

  const value = useMemo<Theme>(() => {
    const faced = faceTokens(face);
    return {
      scheme,
      face,
      teach: teachOf(face),
      c: paletteOf(scheme, face),
      type: typePresets,
      radius: faced.radius,
      space,
      layout,
      motion: faced.motion,
      zLayer,
      hit: HIT,
      lift: (level: LiftLevel) => lift(scheme, level, face),
      liftUp: (level: LiftLevel) => liftUp(scheme, level, face),
      reduceMotion,
      // The face's easing, paper's durations — `motion.duration` is deliberately not faced.
      ms: (d) => (reduceMotion ? 0 : motion.duration[d]),
    };
  }, [scheme, face, reduceMotion]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Live `prefers-reduced-motion` equivalent. */
export function useReduceMotion(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (alive) setOn(v);
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setOn);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return on;
}
