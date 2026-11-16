/**
 * The shell's one door to its native module, the `*-native.ts` twin the node suite never imports
 * (importing `expo` pulls the whole Expo runtime). `requireOptionalNativeModule` answers null where
 * the native half is absent, an older build: the shell is then never offered.
 */
import { requireNativeView, requireOptionalNativeModule } from "expo";

import type { ShellNative, ShellViewComponent } from "./shell-port";

export function shellNative(): ShellNative | null {
  return requireOptionalNativeModule<ShellNative>("OhmailShell");
}

let view: ShellViewComponent | null = null;

/** The native view. Asked for only once the module is known to be present. */
export function shellView(): ShellViewComponent {
  return (view ??= requireNativeView("OhmailShell") as unknown as ShellViewComponent);
}
