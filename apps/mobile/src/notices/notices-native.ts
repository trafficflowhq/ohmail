/**
 * The notices' one door to their native module, the `*-native.ts` twin the node suite never imports. The platform
 * is asked BEFORE the module: the iPhone draws no mail notice and keeps no signed-in pairing for one, so no module
 * is looked for there, whatever a build carries. Null where the module is absent: nothing is kept, nothing is drawn.
 */
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import type { NoticesNative } from "./notices-port";

export function noticesNative(): NoticesNative | null {
  if (Platform.OS !== "android") return null;
  return requireOptionalNativeModule<NoticesNative>("OhmailNotices");
}
