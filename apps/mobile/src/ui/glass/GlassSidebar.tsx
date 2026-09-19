/**
 * The drawer behind the list pane's toggle — where the destinations live once the rail is
 * icons-only or the pane header carries a sidebar toggle (the unfolded Duo, the iPad). It
 * mounts INSIDE the pane the toggle belongs to, absolutely, so it can never cross a hinge
 * (Apple moves "alerts and menus … away from the bend"); the caller owns that placement. The
 * prototype's `.drawer`: min(268, 82%) wide, scrim behind, slid in on the spring curve.
 */
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, SlideInLeft, SlideInRight, SlideOutLeft, SlideOutRight } from "react-native-reanimated";
import { useTheme } from "../../theme";
import { Copy } from "../../copy";

export function GlassSidebar({
  open,
  onClose,
  side = "left",
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** A split mirrors the drawer to the app's own edge, like every other control. */
  side?: "left" | "right";
  label: string;
  children: ReactNode;
}) {
  const t = useTheme();
  if (!open) return null;
  const ms = t.ms("drawer");
  const slideIn = side === "left" ? SlideInLeft.duration(ms) : SlideInRight.duration(ms);
  const slideOut = side === "left" ? SlideOutLeft.duration(ms) : SlideOutRight.duration(ms);
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: t.zLayer.sheet }]} pointerEvents="box-none">
      <Animated.View entering={FadeIn.duration(ms)} exiting={FadeOut.duration(ms)} style={StyleSheet.absoluteFill}>
        <Pressable
          accessibilityLabel={Copy.moveCancel}
          onPress={onClose}
          style={{ flex: 1, backgroundColor: t.c.scrim }}
        />
      </Animated.View>
      <Animated.View
        entering={slideIn}
        exiting={slideOut}
        accessibilityViewIsModal
        accessibilityLabel={label}
        style={[
          {
            position: "absolute",
            top: 0,
            bottom: 0,
            left: side === "left" ? 0 : undefined,
            right: side === "right" ? 0 : undefined,
            width: "82%",
            maxWidth: 268,
            backgroundColor: t.c.panel,
            borderTopRightRadius: side === "left" ? t.radius.overlay : 0,
            borderBottomRightRadius: side === "left" ? t.radius.overlay : 0,
            borderTopLeftRadius: side === "right" ? t.radius.overlay : 0,
            borderBottomLeftRadius: side === "right" ? t.radius.overlay : 0,
          },
          t.lift("l3"),
        ]}
      >
        {children}
      </Animated.View>
    </View>
  );
}
