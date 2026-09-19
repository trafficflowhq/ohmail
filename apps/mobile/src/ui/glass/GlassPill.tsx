/**
 * The flying menu's material — the one navigation and toolbar surface on every device: a
 * translucent pill the canvas shows through, backdrop-blurred, with a 1px inset border and a
 * lift. Values from the prototype's `.egroup`: `--glass` background (the palette's `glass`
 * pair), `blur(16px)`, inset `--glass-brd`, radius `--r-pill`, padding 4 (border 1 + padding 3
 * here — RN draws the border inside the box), item gap 2. The blur is iOS's (`expo-blur` is
 * UIVisualEffectView there). Android's blur implementations repaint the whole backdrop per
 * frame under a scrolling list — exactly where this pill lives — so Android keeps the
 * translucent wash alone: same tokens, same read, no jank. One decision, in one place, stated.
 */
import type { ReactNode } from "react";
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { useTheme, type LiftLevel } from "../../theme";

export function GlassPill({
  horizontal,
  level = "l1",
  radius,
  style,
  contentStyle,
  children,
}: {
  horizontal?: boolean;
  /** The dock floats high (l3); a rail's pills sit closer to the surface (l1). */
  level?: LiftLevel;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const t = useTheme();
  const r = radius ?? t.radius.pill;
  return (
    <View style={[t.lift(level), { borderRadius: r }, style]}>
      <View
        style={{
          borderRadius: r,
          overflow: "hidden",
          borderWidth: 1,
          borderColor: t.c.glassBrd,
        }}
      >
        {Platform.OS === "ios" ? (
          <BlurView
            intensity={40}
            tint={t.scheme === "dark" ? "dark" : "light"}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        <View
          style={[
            {
              backgroundColor: t.c.glass,
              flexDirection: horizontal ? "row" : "column",
              alignItems: "center",
              gap: 2,
              padding: 3,
            },
            contentStyle,
          ]}
        >
          {children}
        </View>
      </View>
    </View>
  );
}
