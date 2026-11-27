import { Animated } from "react-native";
import type { ComponentType, ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";

type Motion = { nativeEvent: { offset: number } };
export type Finish = { nativeEvent: { distance: number; cancelled: boolean } };
type SurfaceProps = {
  children: ReactNode;
  enabled: boolean;
  slop: number;
  rate: number;
  maximum: number;
  hold: number;
  style: StyleProp<ViewStyle>;
  onPullClaim: () => void;
  onPullMotion: (event: Motion) => void;
  onPullFinish: (event: Finish) => void;
};

let surface: ComponentType<Animated.AnimatedProps<SurfaceProps>> | undefined;

export function androidPullSurface(): ComponentType<Animated.AnimatedProps<SurfaceProps>> {
  if (!surface) {
    // Only load the native view when an Android mail list mounts.
    const { requireNativeView } = require("expo") as Pick<typeof import("expo"), "requireNativeView">;
    surface = Animated.createAnimatedComponent(requireNativeView<SurfaceProps>("OhmailPull"));
  }
  return surface;
}
