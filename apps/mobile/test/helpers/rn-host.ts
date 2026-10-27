/**
 * React Native for a MOUNT: the primitives as the host elements a device renders, so
 * `@testing-library/react-native` (over react-test-renderer) queries, presses and reads styles
 * on the phone's real components. A test says `vi.mock("react-native", () => import("./helpers/rn-host"))`.
 * React Native's own source is Flow and cannot load under Node; the testing library asks it only
 * for `StyleSheet.flatten`, so its `require("react-native")` is answered with this module too.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";

type Props = { children?: ReactNode | ((state: { pressed: boolean }) => ReactNode); [k: string]: unknown };

/** The window a test lays the component out in; `useWindowDimensions` reads it on each render. */
export const screen = { width: 400, height: 800, scale: 2, fontScale: 1 };

const host = (name: string) =>
  function Host(props: Props) {
    return createElement(name, props as Record<string, unknown>, props.children as ReactNode);
  };

/* What Pressable gives the device: a responder that refuses while disabled, the press on itself. */
function Pressable({ children, disabled, style, onPress: _press, ...rest }: Props) {
  const off = disabled === true;
  return createElement("View", {
    ...rest,
    accessible: true,
    accessibilityState: { disabled: off },
    onStartShouldSetResponder: () => !off,
    style: typeof style === "function" ? (style as (s: { pressed: boolean }) => unknown)({ pressed: false }) : style,
  }, typeof children === "function" ? children({ pressed: false }) : children);
}

type Style = Record<string, unknown> | null | undefined | false | Style[];
const flatten = (style: Style): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style ? { ...style } : {};

const listener = () => ({ remove: () => undefined });

export const View = host("View");
export const Text = host("Text");
export const TextInput = host("TextInput");
export const Image = host("Image");
export const ScrollView = host("RCTScrollView");
export const RefreshControl = host("RefreshControl");
export const ActivityIndicator = host("ActivityIndicator");
export { Pressable };
export const StyleSheet = {
  create: <T,>(s: T): T => s,
  flatten,
  compose: (a: Style, b: Style) => [a, b],
  hairlineWidth: 1,
  absoluteFill: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
  absoluteFillObject: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
};
export const Platform = {
  OS: "android",
  Version: 35,
  select: <T,>(o: { android?: T; native?: T; default?: T }) => o.android ?? o.native ?? o.default,
};
export const useWindowDimensions = () => ({ ...screen });
export const Dimensions = { get: () => ({ ...screen }), addEventListener: listener };
export const useColorScheme = () => "light";
export const AccessibilityInfo = {
  isReduceMotionEnabled: async () => false,
  isScreenReaderEnabled: async () => false,
  addEventListener: listener,
  announceForAccessibility: () => undefined,
};
export const AppState = { currentState: "active", addEventListener: listener };
export const Keyboard = { addListener: listener, dismiss: () => undefined };
export const Linking = { openURL: async () => undefined, addEventListener: listener };
export const PixelRatio = { get: () => screen.scale, getFontScale: () => screen.fontScale, roundToNearestPixel: (n: number) => n };
export const I18nManager = { isRTL: false };

/* Seeded where Node resolves `react-native` from the app, which is where the testing library resolves it. */
const req = createRequire(join(__dirname, "../../package.json"));
const self = {
  View, Text, TextInput, Image, ScrollView, RefreshControl, ActivityIndicator, Pressable, StyleSheet, Platform,
  useWindowDimensions, Dimensions, useColorScheme, AccessibilityInfo, AppState, Keyboard, Linking, PixelRatio, I18nManager,
};
const path = req.resolve("react-native");
req.cache[path] = { id: path, filename: path, loaded: true, exports: self } as unknown as NodeJS.Module;
