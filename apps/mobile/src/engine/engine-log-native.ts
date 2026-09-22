/**
 * The log sink's one door — the `*-native.ts` twin the node suite never imports (importing `expo`
 * pulls the whole Expo runtime, which needs `__DEV__` and is absent under vitest; every rule is
 * driven through `engine-log.ts` instead). `requireOptionalNativeModule` answers `null` where the
 * native half is absent — an old build, a client without it — and `null` is what leaves the sink
 * on `console` instead of throwing. A bare `require` of a missing native module is fatal and no
 * `catch` around it can fire, which is why the presence question is asked this way.
 */
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import { installEngineLogWriter, type EngineLogWriter } from "./engine-log";

/**
 * The platforms that HAVE a native half, asked before the require: on web there is no module to
 * ask for and no unified log to write to, and `console` is already the browser's own log.
 */
export function nativeEngineLogWriter(): EngineLogWriter | null {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return null;
  return requireOptionalNativeModule<EngineLogWriter>("OhmailEngineLogSink");
}

/**
 * Wire the sink to the platform's log. Called at module scope in the root layout, before the
 * first render: every line written before this goes to `console`, which a Release iOS build
 * drops. Idempotent — installing the same writer twice is the same one writer.
 */
export function installNativeEngineLogWriter(): void {
  installEngineLogWriter(nativeEngineLogWriter());
}
