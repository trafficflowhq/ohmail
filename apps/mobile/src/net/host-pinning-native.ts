/**
 * The real pinning registry — the one module in this app that asks for the native pinning module
 * (the `servers-native.ts` idiom: node tests drive every rule in `host-pinning.ts` through the
 * seam and never load this file — importing `expo` pulls the whole Expo runtime, which needs
 * `__DEV__` and is absent under vitest). Through `expo` rather than `expo-modules-core`: the app
 * declares `expo`, which re-exports exactly this; the transitive package would typecheck only
 * while pnpm happened to hoist it. `requireOptionalNativeModule` answers `null` where the native
 * half is absent — iOS today — and `null` is what makes `canPin()` false and a same-network
 * pairing an honest refusal, never an unpinned connection.
 */
import { requireOptionalNativeModule } from "expo";

import type { PinningNative } from "./host-pinning";

export function nativeHostPinning(): PinningNative | null {
  return requireOptionalNativeModule<PinningNative>("OhmailHostPinning");
}
