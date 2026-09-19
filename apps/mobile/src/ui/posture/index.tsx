/**
 * `usePosture()` — one posture in context, derived by `derive.ts` from what this file collects:
 * the window's dimensions (always), the native fold reading where the module answers
 * (`modules/ohmail-posture`), and the OHMAIL_POSTURE debug override through its three doors —
 * the provider prop (tests), `EXPO_PUBLIC_OHMAIL_POSTURE` at bundle time, the native launch
 * env/intent extra — so a test run can drive every pose on any simulator. The provider only
 * collects; every decision is in `derive.ts`, where the suite measures it. Continuity is
 * structural: a posture change re-renders with new numbers, it never remounts — the open
 * message, the scroll position and focus stay where they were.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Dimensions, Platform, useWindowDimensions } from "react-native";
import {
  derivePosture,
  parsePostureOverride,
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
