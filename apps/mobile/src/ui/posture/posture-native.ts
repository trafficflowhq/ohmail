/**
 * The fold API's one door — the `*-native.ts` twin the node suite never imports (importing
 * `expo` needs `__DEV__`; every rule is driven through `derive.ts` instead). The native half is
 * `modules/ohmail-posture`: Android maps Jetpack WindowManager's FoldingFeatures, iOS the Duo
 * SDK's division reserved regions + hinge status, both to `FoldFeature`'s shape.
 * `requireOptionalNativeModule` answers null where the native half is absent (Expo Go, an old
 * build) — null is the honest "API absent" the JS fallback in `derive.ts` expects.
 */
import { requireOptionalNativeModule } from "expo";

import type { FoldFeature } from "./derive";

export interface PostureNative {
  /** The current folds crossing the app's window, or null where the platform has no reading. */
  getFolds(): FoldFeature[] | null;
  /** Does the hardware have a fold at all (inactive divisions included)? */
  getHasFold(): boolean;
  /** The launch override: SIMCTL_CHILD_OHMAIL_POSTURE / the intent extra, read once at launch. */
  getLaunchOverride(): string | null;
  addListener?(event: string, listener: (payload: { folds: FoldFeature[] }) => void): { remove(): void };
}

export function nativePosture(): PostureNative | null {
  return requireOptionalNativeModule<PostureNative>("OhmailPosture");
}
