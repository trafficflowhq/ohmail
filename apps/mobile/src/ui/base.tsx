/**
 * The Blanc list language, as React Native primitives.
 *
 * Everything a screen paints comes from here, and everything here reads its
 * values from `useTheme()`. There are no colour literals below the theme
 * module — `test/theme.test.ts` greps for them.
 *
 * The vocabulary is the prototype's, one to one:
 *   Screen    the off-white canvas          (`body`)
 *   Panel     a white surface on the canvas (`.list-col`, radius 20, lift-1)
 *   ViewHead  h1 + meta                     (`.vhead`)
 *   Section   the group label               (`.grouplabel`)
 *   Badge     a small tint capsule          (`.badge`)
 *   TagChip   a tag capsule in its hue      (`.tagchip`)
 *   Chip      a message chip                (`.chip`)
 *   Button    a capsule held up by light    (`.btn`)
 *   Tail      the completeness note         (`.tail-row`)
 *   Waterline the seen/unseen boundary      (`.waterline`)
 */
import type { ReactNode } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, type Theme } from "../theme";
import { Icon, type IconName } from "./Icon";

/* ------------------------------------------------------------------- text */

type Tone = "ink" | "ink2" | "ink3" | "accent" | "onAccent";

export interface TxtProps extends TextProps {
  variant?: keyof Theme["type"];
  tone?: Tone;
  /** Times, counts and amounts line up in columns; text does not. */
  tabular?: boolean;
}

export function Txt({ variant = "body", tone = "ink", tabular, style, ...rest }: TxtProps) {
  const t = useTheme();
  const color =
    tone === "accent" ? t.c.accentInk : tone === "onAccent" ? t.c.onAccent : t.c[tone];
  return (
    <Text
      {...rest}
      style={[
        t.type[variant] as TextStyle,
        { color },
        tabular ? { fontVariant: ["tabular-nums"] } : null,
        style,
      ]}
    />
  );
}

/* ---------------------------------------------------------------- surfaces */

/** The canvas. Every screen sits on it; nothing else paints a background. */
export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[{ flex: 1, backgroundColor: t.c.canvas }, style]}>{children}</View>;
}

/**
 * A white surface floating on the canvas. Carries its own background *and*
 * radius, because RN shapes a shadow from the view's own border box.
 */
export function Panel({
  children,
  level = "l1",
  radius,
  style,
}: {
  children: ReactNode;
  level?: "l0" | "l1" | "l2" | "l3";
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: level === "l1" ? t.c.panel : t.c.float,
          borderRadius: radius ?? t.radius.panel,
        },
        t.lift(level),
        style,
      ]}
    >
      {children}
    </View>
  );
}

/**
 * The scroller every list screen uses. Owns the side gutter and the clearance
 * under the tab bar so a panel's full shadow falloff is never clipped.
 *
 * `refresh` is the standard pull gesture, themed once here so every list that
 * refreshes speaks the same voice: the spinner in the quiet ink (iOS half —
 * `tintColor` on UIRefreshControl), the accent on the material indicator over a
 * floating panel (Android half — `colors`/`progressBackgroundColor` on
 * SwipeRefreshLayout). The screens hand in `usePullToSync()`, whose spinner
 * settles when the sync round actually completes — see `state/pull.ts`.
 */
export function Scroller({
  children,
  contentStyle,
  refresh,
  ...rest
}: React.ComponentProps<typeof ScrollView> & {
  contentStyle?: StyleProp<ViewStyle>;
  refresh?: { refreshing: boolean; onRefresh: () => void };
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      {...rest}
      refreshControl={
        refresh ? (
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            tintColor={t.c.ink3}
            colors={[t.c.accentInk]}
            progressBackgroundColor={t.c.float}
          />
        ) : undefined
      }
      style={{ flex: 1 }}
      contentContainerStyle={[
        {
          paddingHorizontal: t.space.deckCompact,
          paddingBottom: t.space.tabClearance + insets.bottom,
        },
        contentStyle,
      ]}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ chrome */

/** `.vhead` — the view's name and its one factual number. */
export function ViewHead({
  title,
  meta,
  right,
}: {
  title: string;
  meta?: string;
  right?: ReactNode;
}) {
  const t = useTheme();
  return (
    <View style={{ paddingHorizontal: 10, paddingTop: 10, paddingBottom: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 10 }}>
        <Txt variant="h1" style={{ flexShrink: 1 }}>
          {title}
        </Txt>
        {right}
      </View>
      {meta ? (
        <Txt variant="meta" tone="ink3" tabular style={{ marginTop: 4 }}>
          {meta}
        </Txt>
      ) : null}
    </View>
  );
}

/** `.grouplabel` — names a run of rows without drawing a line. */
export function Section({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <View style={[{ paddingHorizontal: t.space.paneXCompact, paddingTop: 16, paddingBottom: 6 }, style]}>
      <Txt variant="sectionLabel" tone="ink3">
        {children}
      </Txt>
    </View>
  );
}

/**
 * `.tail-row` — states that the list is complete. The no-collapse rule in
 * words: it never implies a hidden remainder on this screen.
 */
export function Tail({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ paddingHorizontal: t.space.paneXCompact, paddingTop: 14, paddingBottom: 20 }}>
      <Txt variant="note" tone="ink3">
        {children}
      </Txt>
    </View>
  );
}

/* ------------------------------------------------------------------ chips */

export function Badge({
  children,
  icon,
  tone = "neutral",
}: {
  children?: ReactNode;
  icon?: IconName;
  tone?: "neutral" | "accent" | "place";
}) {
  const t = useTheme();
  const bg = tone === "accent" ? t.c.accentSoft : tone === "place" ? t.c.tint : t.c.tint2;
  const fg = tone === "accent" ? t.c.accentInk : t.c.ink3;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 3,
        backgroundColor: bg,
        borderRadius: t.radius.pill,
        paddingHorizontal: 7,
        paddingVertical: 2,
      }}
    >
      {icon ? <Icon name={icon} size={10} color={fg} weight={1.5} /> : null}
      {children != null ? (
        <Text style={[t.type.badge, { color: fg, fontVariant: ["tabular-nums"] }]}>{children}</Text>
      ) : null}
    </View>
  );
}

export function TagChip({ name, ink, bg }: { name: string; ink: string; bg: string }) {
  const t = useTheme();
  return (
    <View
      style={{
        backgroundColor: bg,
        borderRadius: t.radius.pill,
        paddingHorizontal: 8,
        paddingVertical: 2,
      }}
    >
      <Text style={[t.type.tagchip, { color: ink }]}>{name}</Text>
    </View>
  );
}

/** `.chip` — a message chip. `pending` is the AI wash; `outline` the affordance. */
export function Chip({
  children,
  icon,
  variant = "neutral",
  onPress,
  style,
}: {
  children: ReactNode;
  icon?: IconName;
  variant?: "neutral" | "pending" | "outline";
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const body = (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          borderRadius: t.radius.pill,
          paddingHorizontal: 12,
          paddingVertical: 6,
          backgroundColor:
            variant === "pending" ? t.c.accentSoft : variant === "outline" ? "transparent" : t.c.tint,
        },
        variant === "outline" ? { borderWidth: StyleSheet.hairlineWidth * 2, borderColor: t.c.hair } : null,
        style,
      ]}
    >
      {icon ? <Icon name={icon} size={12} color={t.c.accentInk} /> : null}
      <Text style={[t.type.chip, { color: t.c.ink2, flexShrink: 1 }]}>{children}</Text>
    </View>
  );
  return onPress ? (
    <Tap onPress={onPress} accessibilityRole="button">
      {body}
    </Tap>
  ) : (
    body
  );
}

/* ---------------------------------------------------------------- controls */

/**
 * A capsule held up by light. `solid` is the one place the accent fills a
 * surface; everything else is white-on-canvas with a lift.
 */
export function Button({
  label,
  icon,
  variant = "plain",
  onPress,
  style,
  accessibilityLabel,
}: {
  label: string;
  icon?: IconName;
  variant?: "plain" | "solid" | "quiet";
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  const solid = variant === "solid";
  const fg = solid ? t.c.onAccent : variant === "quiet" ? t.c.ink2 : t.c.ink;
  return (
    <Tap
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 7,
          minHeight: 38,
          paddingHorizontal: 15,
          paddingVertical: 8,
          borderRadius: t.radius.pill,
          backgroundColor: solid ? t.c.accent : variant === "quiet" ? "transparent" : t.c.panel,
          opacity: pressed ? 0.86 : 1,
        },
        variant === "plain" ? t.lift("l0") : null,
        style,
      ]}
    >
      {icon ? <Icon name={icon} size={13} color={fg} /> : null}
      <Text style={[t.type.button, { color: fg }]}>{label}</Text>
    </Tap>
  );
}

/**
 * The one Pressable in the app. Guarantees the 48pt target Material asks for
 * and HIG's 44pt, and gives every press the same tint feedback.
 */
export function Tap({ style, children, ...rest }: PressableProps) {
  return (
    <Pressable hitSlop={6} {...rest} style={style}>
      {children as ReactNode}
    </Pressable>
  );
}

/** A row-sized press target with the resting tint wash. */
export function TapRow({
  onPress,
  children,
  style,
  selected,
  ...rest
}: PressableProps & { selected?: boolean }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      {...rest}
      style={({ pressed }) => [
        {
          borderRadius: t.radius.row,
          backgroundColor: pressed ? t.c.tint : selected ? t.c.tint : "transparent",
        },
        style as ViewStyle,
      ]}
    >
      {children as ReactNode}
    </Pressable>
  );
}

/* --------------------------------------------------------------- waterline */

/**
 * `.waterline` — the seen/unseen boundary. It *is* a line: two hairlines with
 * the label between them. Kept as the one rule Blanc draws on purpose.
 */
export function Waterline({ label, meta }: { label: string; meta: string }) {
  const t = useTheme();
  const rule: ViewStyle = { flex: 1, height: StyleSheet.hairlineWidth * 2, backgroundColor: t.c.hairSoft };
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: t.space.paneXCompact,
        paddingTop: 20,
        paddingBottom: 16,
      }}
    >
      <View style={rule} />
      <Txt variant="caption" tone="ink2" style={{ fontWeight: t.type.sectionLabel.fontWeight }}>
        {label}
      </Txt>
      <Txt variant="caption" tone="ink3">
        {meta}
      </Txt>
      <View style={rule} />
    </View>
  );
}

/** A hairline divider inside a panel. */
export function Rule({ inset = 0 }: { inset?: number }) {
  const t = useTheme();
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth * 2,
        backgroundColor: t.c.hairSoft,
        marginHorizontal: inset,
      }}
    />
  );
}

/* -------------------------------------------------------------- empty state */

export function Empty({ glyph, title, hint }: { glyph: string; title: string; hint: string }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: "center", paddingHorizontal: 32, paddingVertical: 56, gap: 8 }}>
      <Text style={{ fontSize: 30, opacity: 0.9 }}>{glyph}</Text>
      <Txt variant="cardTitle" style={{ textAlign: "center" }}>
        {title}
      </Txt>
      <Txt variant="note" tone="ink3" style={{ textAlign: "center", maxWidth: 300 }}>
        {hint}
      </Txt>
    </View>
  );
}
