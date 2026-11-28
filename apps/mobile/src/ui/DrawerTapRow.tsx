import type { ReactNode } from "react";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import { GestureDetector, useManualGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useTheme } from "../theme";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Paint the drawer tint on touch down. The Pressable owns the action and accessibility. */
export function DrawerTapRow({ selected, style, children, ...props }:
  Omit<PressableProps, "style" | "children"> & { selected?: boolean; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const t = useTheme();
  const tint = t.c.tint;
  const resting = selected ? tint : "transparent";
  const pressed = useSharedValue(false);
  const gesture = useManualGesture({
    cancelsTouchesInView: false,
    onTouchesDown: () => { "worklet"; pressed.value = true; },
    onTouchesUp: () => { "worklet"; pressed.value = false; },
    onTouchesCancel: () => { "worklet"; pressed.value = false; },
  });
  const feedback = useAnimatedStyle(() => ({ backgroundColor: pressed.value ? tint : resting }));
  return (
    <GestureDetector gesture={gesture}>
      <AnimatedPressable {...props} style={[{ borderRadius: t.radius.row }, style, feedback]}>
        {children}
      </AnimatedPressable>
    </GestureDetector>
  );
}
