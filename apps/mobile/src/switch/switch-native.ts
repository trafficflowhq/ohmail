/**
 * The switch's one door to its native module, the `*-native.ts` twin the node suite never imports. Every app carries
 * the module (a build without it stops at load, `variant.ts`); where a test gives none, the switch is never offered.
 */
import { requireOptionalNativeModule } from "expo";

import type { SwitchNative } from "./switch-port";

export function switchNative(): SwitchNative | null {
  return requireOptionalNativeModule<SwitchNative>("OhmailSwitch");
}
