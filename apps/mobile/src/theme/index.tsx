/**
 * Theme resolution: preference + system appearance → one `Theme` in context.
 *
 * `useTheme()` is the only way a screen gets a colour, a shadow or a type
 * preset. No component holds a literal colour; `test/theme.test.ts` greps the
 * screen sources for stray `#rrggbb` / `rgba(` / `oklch(` and fails on a hit —
 * the same audit the retired macOS client ran over its Swift sources.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AccessibilityInfo, useColorScheme, type ViewStyle } from "react-native";
import { lift, liftUp, type LiftLevel } from "./lift";
import { paletteOf, type Palette, type SchemeName } from "./palette";
import { type as typePresets } from "./type";
import { HIT, layout, motion, radius, space, zLayer } from "./tokens";

export * from "./oklch";
export * from "./palette";
export * from "./lift";
export * from "./type";
export * from "./tokens";

export type ThemePref = "system" | "light" | "dark";

export interface Theme {
  scheme: SchemeName;
  c: Palette;
  type: typeof typePresets;
  radius: typeof radius;
  space: typeof space;
  layout: typeof layout;
  motion: typeof motion;
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

export function ThemeProvider({
  pref,
  children,
}: {
  pref: ThemePref;
  children: ReactNode;
}) {
  const system = useColorScheme();
  const reduceMotion = useReduceMotion();
  const scheme: SchemeName = pref === "system" ? (system === "dark" ? "dark" : "light") : pref;

  const value = useMemo<Theme>(
    () => ({
      scheme,
      c: paletteOf(scheme),
      type: typePresets,
      radius,
      space,
      layout,
      motion,
      zLayer,
      hit: HIT,
      lift: (level: LiftLevel) => lift(scheme, level),
      liftUp: (level: LiftLevel) => liftUp(scheme, level),
      reduceMotion,
      ms: (d) => (reduceMotion ? 0 : motion.duration[d]),
    }),
    [scheme, reduceMotion],
  );

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
