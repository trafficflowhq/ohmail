/**
 * `usePosture()` — one posture in context, derived by `derive.ts` from what this file collects:
 * the window's dimensions, the native fold reading where the module answers, and the
 * OHMAIL_POSTURE override through its three doors (provider prop, `EXPO_PUBLIC_OHMAIL_POSTURE`,
 * the native launch env) so a test run can drive every pose on any simulator. The provider only
 * collects; every decision is in `derive.ts`. A posture change re-renders, never remounts, so
 * the open message, scroll and focus survive. Beside it: the status cluster the closed Duo's
 * rail starts below, and the `@canvas` door that renders the app root at a pose's own size.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Dimensions, Platform, View, useWindowDimensions } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import {
  derivePosture,
  parsePostureOverride,
  statusClusterOf,
  type FoldFeature,
  type PlatformName,
  type Posture,
  type PostureOverride,
} from "./derive";
import { nativePosture } from "./posture-native";

export * from "./derive";

const PostureContext = createContext<Posture | null>(null);

export function usePosture(): Posture {
  const p = useContext(PostureContext);
  if (!p) throw new Error("usePosture() outside <PostureProvider>");
  return p;
}

const platformName: PlatformName = Platform.OS === "ios" ? "ios" : "android";

/** The launch-time override, resolved once — the env doors are stable for the process's life. */
let launchResolved: PostureOverride | null | undefined;
function launchOverride(): PostureOverride | null {
  if (launchResolved !== undefined) return launchResolved;
  const env = process.env.EXPO_PUBLIC_OHMAIL_POSTURE ?? null;
  launchResolved = parsePostureOverride(env) ?? parsePostureOverride(nativePosture()?.getLaunchOverride() ?? null);
  return launchResolved;
}

export function PostureProvider({
  override,
  children,
}: {
  /** Tests and tools force a pose here; the launch doors answer beneath it. */
  override?: PostureOverride | null;
  children: ReactNode;
}) {
  const dims = useWindowDimensions();
  /* undefined = no native answer collected yet; null = the module said the API is absent. */
  const [folds, setFolds] = useState<FoldFeature[] | null>(null);
  const [hasFold, setHasFold] = useState(false);

  useEffect(() => {
    const native = nativePosture();
    if (native === null) return;
    setFolds(native.getFolds());
    setHasFold(native.getHasFold());
    const sub = native.addListener?.("onFoldsChanged", (payload) => setFolds(payload.folds));
    return () => sub?.remove();
  }, []);

  const value = useMemo<Posture>(() => {
    const forced = override ?? launchOverride();
    if (forced) {
      return derivePosture({
        platform: forced.platform ?? platformName,
        width: forced.width,
        height: forced.height,
        folds: forced.folds ?? null,
        hasFold: forced.hasFold,
        isPad: forced.isPad,
        windowBounds: forced.windowBounds ?? null,
      });
    }
    /* Split detection without a native window position: the window narrower than the screen is
       a split; the side is unknown from JS alone, and 'left' is the harmless default until the
       native half reports bounds — Android keeps its dock in a split anyway. */
    const screen = Dimensions.get("screen");
    const windowBounds =
      screen.width - dims.width > 40 ? { x: 0, w: dims.width, screenW: screen.width } : null;
    return derivePosture({
      platform: platformName,
      width: dims.width,
      height: dims.height,
      folds,
      hasFold,
      isPad: Platform.OS === "ios" && Platform.isPad === true,
      windowBounds,
    });
  }, [override, dims.width, dims.height, folds, hasFold]);

  return <PostureContext.Provider value={value}>{children}</PostureContext.Provider>;
}

/* ─────────────────────────────────── the canvas door ────────────────────────────────────── */

const CanvasContext = createContext<{ width: number; height: number } | null>(null);

/** The window the layout is laid in — the canvas's size under `@canvas`, else the device's. */
export function useAppWindow(): { width: number; height: number } {
  const canvas = useContext(CanvasContext);
  const dims = useWindowDimensions();
  return canvas ?? { width: dims.width, height: dims.height };
}

/** The pose's own safe areas inside a canvas: the prototype's device table (Duo t14 · b34). */
const CANVAS_INSETS: Record<PlatformName, { top: number; right: number; bottom: number; left: number }> = {
  ios: { top: 14, right: 0, bottom: 34, left: 0 },
  android: { top: 0, right: 0, bottom: 24, left: 0 },
};

/**
 * `<pose>@canvas`: the app root at the pose's width × height, scaled to fit the real window and
 * centred on black, with the pose's safe areas in place of the device's. Sheets are Modals and
 * keep the window; everything laid out by `useAppWindow()` and the safe areas follows the pose.
 * Without the flag this renders its children alone.
 */
export function PostureCanvas({ children }: { children: ReactNode }) {
  const dims = useWindowDimensions();
  const forced = launchOverride();
  if (forced === null || forced.canvas !== true) return <>{children}</>;
  const w = forced.width;
  const h = forced.height;
  const scale = Math.min(dims.width / w, dims.height / h, 1);
  const insets = forced.insets ?? CANVAS_INSETS[forced.platform ?? platformName];
  return (
    <View style={{ flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: w, height: h, overflow: "hidden", transform: [{ scale }] }}>
        <CanvasContext.Provider value={{ width: w, height: h }}>
          <SafeAreaInsetsContext.Provider value={insets}>
            <>{children}</>
          </SafeAreaInsetsContext.Provider>
        </CanvasContext.Provider>
      </View>
    </View>
  );
}

/* ────────────────────────────────── the status cluster ──────────────────────────────────── */

let clusterResolved: { bottom: number } | null | undefined;

/**
 * The closed Duo's status cluster — the status bar's frame read once from the module and kept
 * only where it is a right-strip cluster, not a top bar (`statusClusterOf`). Null inside a
 * canvas (the simulated face has none) and wherever the module or the shape says no.
 */
export function useStatusCluster(): { bottom: number } | null {
  const canvas = useContext(CanvasContext);
  const dims = useWindowDimensions();
  const [cluster, setCluster] = useState<{ bottom: number } | null>(clusterResolved ?? null);
  useEffect(() => {
    if (canvas !== null || clusterResolved !== undefined) return;
    const read = nativePosture()?.getStatusCluster?.();
    if (read === undefined) {
      clusterResolved = null;
      return;
    }
    let live = true;
    read
      .then((frame) => {
        clusterResolved = statusClusterOf(frame, dims.width);
        if (live) setCluster(clusterResolved);
      })
      .catch(() => {
        clusterResolved = null;
      });
    return () => {
      live = false;
    };
  }, [canvas, dims.width]);
  return canvas !== null ? null : cluster;
}
