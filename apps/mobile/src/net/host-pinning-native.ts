/**
 * The REAL pinning registry — the one module in this app that asks for the native pinning module.
 * The `servers-native.ts` idiom: node-side tests drive every rule in `host-pinning.ts` through
 * the same seam and never load this file (importing `expo` pulls the whole Expo runtime, which
 * needs `__DEV__` and is not present under vitest).
 *
 * Through `expo` rather than `expo-modules-core`: the app declares `expo`, which re-exports
 * exactly this (`expo/build/Expo.d.ts`); importing the transitive package would typecheck only
 * while pnpm happened to hoist it.
 *
 * `requireOptionalNativeModule` answers `null` rather than throwing where the native half is
 * absent — iOS today (its half is named, not built: see `host-pinning.ts`) — and `null` is what
 * makes `canPin()` false and a same-network pairing an honest refusal rather than an unpinned
 * connection.
 */
import { requireOptionalNativeModule } from "expo";

import type { PinningNative } from "./host-pinning";

export function nativeHostPinning(): PinningNative | null {
  return requireOptionalNativeModule<PinningNative>("OhmailHostPinning");
}
