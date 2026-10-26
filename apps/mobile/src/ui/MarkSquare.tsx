/**
 * ONE OF A CONVERSATION'S SQUARES — the reader's rail and the list row's strip draw the same one:
 * 10dp, solid accent unread, dimmed read, hollow the account's own; its opacity settles with the
 * panel's tint. The ring around the current one is 18dp. Corners follow the theme's control radius
 * at the web's ratios (3/8 the square, 7/8 the ring: paper's soft squares), so they are square under
 * ohmarchy. A finger held on a square shows its sheet (`MarkSheet`): who, when, the first line.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, LayoutAnimation, View, type LayoutChangeEvent, type ViewStyle } from "react-native";
import { squaresWindow, type SquaresWindow } from "@ohmail/client-engine";
import { Copy } from "../copy";
import { activeLocale } from "../i18n/locale";
import { readerZone } from "../state/live";
import { useTheme } from "../theme";
import { Txt } from "./base";
import { Icon } from "./Icon";
import { THREAD_READ_FADE_MS, THREAD_UNREAD_BACK_MS } from "./reader-seen";
import { MARK_HOLD_KEEP_MS, markWhen, type MarkKind, type RailItem } from "./reader-marks";

/** The ring around the current square. */
export const MARK_RING = 18;
/** The square's corner and the ring's, from the control radius (`radius.focus`, the ctl band). */
export const squareRadius = (ctl: number): number => (ctl * 3) / 8;
export const ringRadius = (ctl: number): number => (ctl * 7) / 8;
/** The list row's own 8dp squares: the square's corner scaled to their size. */
export const rowSquareRadius = (ctl: number): number => (ctl * 3) / 10;

const EASE = Easing.bezier(0.22, 0.61, 0.36, 1);

/** `scale`: a tapered square at a window's edge (`useSquaresWindow`), its corner and outline with it. */
export function MarkSquare({ kind, scale = 1 }: { kind: MarkKind; scale?: number }) {
  const t = useTheme();
  const target = kind === "unread" ? 1 : kind === "mine" ? t.c.markMine : t.c.markRead;
  const v = useRef(new Animated.Value(target)).current;
  const was = useRef(target);
  useEffect(() => {
    if (was.current === target) return;
    was.current = target;
    if (t.reduceMotion) { v.setValue(target); return; }
    Animated.timing(v, {
      toValue: target,
      duration: kind === "unread" ? THREAD_UNREAD_BACK_MS : THREAD_READ_FADE_MS,
      easing: EASE,
      useNativeDriver: true,
    }).start();
  }, [target, kind, t.reduceMotion, v]);
  return (
    <Animated.View
      style={{
        width: 10 * scale,
        height: 10 * scale,
        opacity: v,
        backgroundColor: kind === "mine" ? "transparent" : t.c.accent,
        borderWidth: kind === "mine" ? 2 * scale : 0,
        borderColor: t.c.accent,
        borderRadius: squareRadius(t.radius.focus) * scale,
      }}
    />
  );
}

/**
 * THE WINDOW OVER A LINE OF SQUARES longer than its room (the row's strip, the rail; owner 2026-10-26):
 * `squaresWindow` for the ringed square (the last where none is); null while the line is not laid out,
 * every square standing. A step of the window is laid out as motion, 220 ms; at once under reduced motion.
 */
export function useSquaresWindow(n: number, current: number, room: number | null, pitch: number, count: number): SquaresWindow | null {
  const t = useTheme();
  const run = useMemo(
    () => (room === null || room <= 0 ? null : squaresWindow({ n, current, room, pitch, count })),
    [n, current, room, pitch, count],
  );
  const key = run === null ? "" : run.scale.join(" ");
  const last = useRef(key);
  if (last.current !== key) {
    // the commit that carries the step animates its layout: the slots fold and grow, the squares with them
    if (last.current !== "" && key !== "" && !t.reduceMotion) {
      LayoutAnimation.configureNext(LayoutAnimation.create(220, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.scaleXY));
    }
    last.current = key;
  }
  return run;
}

/**
 * Where a line's ONE ring stands: at the ringed square's rest place (its slot once a step's layout
 * animation ends), `lead` after the line's start. A ring on the square would ride its slot mid-step,
 * a slot ahead, and ease back on every step; this one lets the squares flow past it. Null where the
 * ringed square stands in no slot.
 */
export function ringRest(slots: readonly number[], at: number, lead: number): number | null {
  if (at < 0 || !((slots[at] ?? 0) > 0)) return null;
  let pos = lead;
  for (let i = 0; i < at; i++) pos += slots[i]!;
  return pos + slots[at]! / 2 - MARK_RING / 2;
}

/** The ring, out of the line's flow: `along` the line at `at`, `cross` into it. */
export function MarkRing({ testID, along, at, cross }: { testID: string; along: "top" | "left"; at: number; cross: number }) {
  const t = useTheme();
  const box = { width: MARK_RING, height: MARK_RING, borderWidth: 1.5, borderColor: t.c.ink3, borderRadius: ringRadius(t.radius.focus) };
  return (
    <View
      testID={testID}
      pointerEvents="none"
      style={{ position: "absolute", ...(along === "top" ? { top: at, left: cross } : { left: at, top: cross }), ...box }}
    />
  );
}

export interface MarkHold {
  held: string | null;
  hold: (id: string) => void;
  release: () => void;
  /** The sheet goes at once: a press on a square, or a drag of the squares or the reader. */
  drop: () => void;
}

/** The square a finger holds: shown from the long press, kept a moment after the finger lifts. */
export function useMarkHold(): MarkHold {
  const [held, setHeld] = useState<string | null>(null);
  const keep = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (keep.current !== null) clearTimeout(keep.current); }, []);
  const hold = useCallback((id: string) => {
    if (keep.current !== null) clearTimeout(keep.current);
    keep.current = null;
    setHeld(id);
  }, []);
  const release = useCallback(() => {
    if (keep.current !== null) clearTimeout(keep.current);
    keep.current = setTimeout(() => { keep.current = null; setHeld(null); }, MARK_HOLD_KEEP_MS);
  }, []);
  const drop = useCallback(() => {
    if (keep.current !== null) clearTimeout(keep.current);
    keep.current = null;
    setHeld(null);
  }, []);
  return useMemo(() => ({ held, hold, release, drop }), [held, hold, release, drop]);
}

/**
 * A HELD SQUARE'S SHEET (the web's chip, as a sheet): the sender bold ("you" for the account's own)
 * and a friendly date, a clip where the message has a file; under them its first line. Drawn beside
 * or under the squares, never on one; the square's own label is what a screen reader hears.
 */
export function MarkSheet({ item, style, onLayout }: { item: RailItem; style?: ViewStyle; onLayout?: (e: LayoutChangeEvent) => void }) {
  const t = useTheme();
  const when = markWhen(item.at, new Date(), readerZone(), activeLocale(), { today: Copy.today, yesterday: Copy.readerMarkYesterday });
  return (
    <View
      testID="mark-sheet"
      onLayout={onLayout}
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{
        backgroundColor: t.c.float, borderRadius: t.radius.rowDense, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 11,
        ...t.lift("l3"), ...style,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Txt variant="caption" numberOfLines={1} style={{ fontWeight: "600", flexShrink: 1 }}>
          {item.kind === "mine" ? Copy.readerMarkYou : item.sender}
        </Txt>
        {when === "" ? null : <Txt variant="caption" tone="ink3" tabular>{when}</Txt>}
        {item.file ? <Icon name="clip" size={12} color={t.c.ink3} /> : null}
      </View>
      {item.line ? <Txt variant="caption" tone="ink3">{item.line}</Txt> : null}
    </View>
  );
}
