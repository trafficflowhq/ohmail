/**
 * The shape of the list that is coming — and nothing about what will be on it; the mobile port of the webapp's
 * `BootSkeleton`. Bars, never words: zero text nodes, hidden from the screen reader, widths from a fixed table
 * derived from nothing — a placeholder that could be mistaken for the reader's own mail is this product's
 * unforgivable failure, held here by construction. A breath, not a shimmer: one slow opacity pulse
 * (`boot-sk-breathe`, 2 s); reduced motion drops the breath and keeps the shape. The two quietest fills (`tint2`,
 * `tint`), alpha washes that read in light and dark. Below {@link SKELETON_GRACE_MS} nothing is drawn, so a warm boot
 * never strobes a skeleton (the constant is exported for fake timers). Unlike the webapp's approximate silhouette,
 * the row geometry mirrors the real rows, so when content replaces the skeleton, nothing jumps.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, View, type ViewStyle } from "react-native";
import { useTheme } from "../theme";
import { sayArg, type RefusalArg } from "../refusal";
import { Panel, Screen, Txt } from "./base";
import { TopBar } from "./chrome";

/** How long a wait may go unshaped — the webapp's `BOOT_SKELETON_GRACE_MS`, kept equal. */
export const SKELETON_GRACE_MS = 300;

/** The breath's period — the webapp's `boot-sk-breathe`, kept equal. */
const BREATHE_MS = 2000;

/**
 * Show nothing until a wait has lasted `ms` — the webapp shell's `useLoadingGrace`, on RN
 * timers. `active` falling resets the grace, so a surface that finishes and later waits
 * again earns a fresh quiet frame rather than an instant skeleton.
 */
export function useLoadingGrace(active: boolean, ms: number = SKELETON_GRACE_MS): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!active) {
      setShow(false);
      return;
    }
    const timer = setTimeout(() => setShow(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return show;
}

/* ── the fixed width tables (percent of the row; content-free by construction) ──────────── */

/** Mail rows: sender, subject, preview — three lines, like `MailRow`'s three. */
const MAIL_BARS = [
  [38, 62, 84],
  [30, 74, 70],
  [44, 58, 88],
  [34, 70, 62],
  [27, 66, 78],
  [40, 54, 72],
] as const;

/** Screener rows: name, address — beside the 34 px initial circle `WaitingRow` draws. */
const SCREENER_BARS = [
  [42, 66],
  [34, 58],
  [46, 72],
  [30, 62],
] as const;

/** Reads cards: title, then three prose lines — the stream card's clamped block. */
const CARD_BARS = [
  [56, 92, 86, 64],
  [44, 88, 94, 52],
] as const;

/* ── the pulse ──────────────────────────────────────────────────────────────────────────── */

/**
 * One shared opacity value per skeleton mount — every bar breathes in phase, exactly as the
 * webapp's bars share one keyframe clock. Driven by the core `Animated` loop (the app's
 * existing motion substrate — see `chrome.tsx`); with reduced motion on, the value simply
 * stays at rest.
 */
function useBreathe(): Animated.Value {
  const t = useTheme();
  const value = useRef(new Animated.Value(1)).current;
  const reduce = t.reduceMotion;
  useEffect(() => {
    if (reduce) {
      value.setValue(1);
      return;
    }
    const [x1, y1, x2, y2] = t.motion.easing.swift;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: 0.5,
          duration: BREATHE_MS / 2,
          easing: Easing.bezier(x1, y1, x2, y2),
          useNativeDriver: true,
        }),
        Animated.timing(value, {
          toValue: 1,
          duration: BREATHE_MS / 2,
          easing: Easing.bezier(x1, y1, x2, y2),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
    // The easing table is a constant; only the reduced-motion answer changes the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduce, value]);
  return value;
}

function Bar({
  width,
  height,
  line,
  color,
}: {
  /** Percent of the row, from the fixed tables above. */
  width: number;
  height: number;
  /** The text line-height this bar stands in for — centers the bar on the real rhythm. */
  line: number;
  color: string;
}) {
  const t = useTheme();
  return (
    <View style={{ height: line, justifyContent: "center" }}>
      <View
        style={{
          width: `${width}%`,
          height,
          borderRadius: t.radius.pill,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

/* ── the rows ───────────────────────────────────────────────────────────────────────────── */

function MailRowShape({ bars }: { bars: readonly [number, number, number] }) {
  const t = useTheme();
  const [sender, subject, preview] = bars;
  return (
    <View style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Bar width={sender} height={10} line={18} color={t.c.tint2} />
        </View>
        {/* The time slot — `MailRow`'s caption column, a fixed short bar. */}
        <View style={{ width: 34 }}>
          <Bar width={100} height={8} line={15} color={t.c.tint} />
        </View>
      </View>
      <View style={{ marginTop: 2 }}>
        <Bar width={subject} height={10} line={19} color={t.c.tint2} />
      </View>
      <View style={{ marginTop: 1 }}>
        <Bar width={preview} height={8} line={17} color={t.c.tint} />
      </View>
    </View>
  );
}

function ScreenerRowShape({ bars }: { bars: readonly [number, number] }) {
  const t = useTheme();
  const [name, address] = bars;
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 12, flexDirection: "row", gap: 12 }}>
      {/* The initial circle `WaitingRow` draws — same 34 px, as a wash instead of a letter. */}
      <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: t.c.tint2 }} />
      <View style={{ flex: 1, minWidth: 0, justifyContent: "center" }}>
        <Bar width={name} height={10} line={18} color={t.c.tint2} />
        <View style={{ marginTop: 2 }}>
          <Bar width={address} height={8} line={16} color={t.c.tint} />
        </View>
      </View>
    </View>
  );
}

function CardShape({ bars }: { bars: readonly [number, number, number, number] }) {
  const t = useTheme();
  const [title, ...prose] = bars;
  return (
    <Panel style={{ marginBottom: 12, paddingHorizontal: 18, paddingVertical: 16 }}>
      <Bar width={title} height={11} line={22} color={t.c.tint2} />
      <View style={{ marginTop: 6, gap: 4 }}>
        {prose.map((w, i) => (
          <Bar key={i} width={w} height={8} line={17} color={t.c.tint} />
        ))}
      </View>
    </Panel>
  );
}

/* ── the surfaces ───────────────────────────────────────────────────────────────────────── */

export type SkeletonKind = "mail" | "screener" | "card";

/**
 * The pulsing silhouette a list screen renders while its mirror is UNKNOWN — the `skeleton`
 * arm of `state/surface.ts#listSurface`. Draws where the rows are about to be, in the rows'
 * own geometry, after the grace; renders nothing below it.
 */
export function SkeletonList({
  kind = "mail",
  rows,
  /** The wait is still on. `false` (content or emptiness arrived) renders nothing. */
  active = true,
  /**
   * The standing sync-failure sentence (`world.boot.syncFailure`), for the one wait that
   * cannot currently resolve — a first-ever launch against a dead network. The sentence is
   * the only thing here that speaks (the webapp's sentence-over-silhouette order); it is
   * status, never mail-shaped content, and it clears the moment a retry round starts.
   */
  stalled,
}: {
  kind?: SkeletonKind;
  rows?: number;
  active?: boolean;
  stalled?: RefusalArg | null;
}) {
  const show = useLoadingGrace(active);
  const opacity = useBreathe();
  if (!show) return null;
  const body: ReactNode =
    kind === "screener" ? (
      SCREENER_BARS.slice(0, rows ?? SCREENER_BARS.length).map((b, i) => <ScreenerRowShape key={i} bars={b} />)
    ) : kind === "card" ? (
      CARD_BARS.slice(0, rows ?? CARD_BARS.length).map((b, i) => <CardShape key={i} bars={b} />)
    ) : (
      MAIL_BARS.slice(0, rows ?? MAIL_BARS.length).map((b, i) => <MailRowShape key={i} bars={b} />)
    );
  return (
    <View>
      {stalled ? (
        <View style={{ paddingHorizontal: 14, paddingTop: 12 }}>
          <Txt variant="caption" tone="ink3">
            {sayArg(stalled)}
          </Txt>
        </View>
      ) : null}
      <Animated.View
        style={{ opacity }}
        // The shape is not information; the sentence above (when there is one) is.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {body}
      </Animated.View>
    </View>
  );
}

/**
 * THE INSTANT SHELL — what the navigation gate paints while the connection layer is still
 * deciding (the keystore read, a local boot, a profile switch). The real chrome (top bar on
 * the canvas), a panel where the list will be, and the mail silhouette inside it after the
 * grace — never a sentence over a blank window: with boot-from-local the wait this covers is
 * tens of milliseconds on a paired phone, so the common case is one quiet canvas frame, and
 * only a genuinely first-ever launch holds the silhouette long enough to breathe.
 */
export function BootShell() {
  const t = useTheme();
  const head: ViewStyle = { paddingHorizontal: 10, paddingTop: 8, paddingBottom: 14 };
  return (
    <Screen>
      <TopBar />
      <View style={{ paddingHorizontal: t.space.deckCompact, flex: 1 }}>
        <View style={head} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {/* The view head's h1 slot, as shape — same rhythm as the screens' own heads. */}
          <SkeletonHead />
        </View>
        <Panel style={{ paddingBottom: 4 }}>
          <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
            <SkeletonList />
          </View>
        </Panel>
      </View>
    </Screen>
  );
}

/** The h1 + meta silhouette the boot shell draws where a view head is about to be. */
function SkeletonHead() {
  const t = useTheme();
  const show = useLoadingGrace(true);
  const opacity = useBreathe();
  if (!show) return null;
  return (
    <Animated.View style={{ opacity }}>
      <Bar width={34} height={14} line={28} color={t.c.tint2} />
      <View style={{ marginTop: 4 }}>
        <Bar width={22} height={8} line={17} color={t.c.tint} />
      </View>
    </Animated.View>
  );
}
