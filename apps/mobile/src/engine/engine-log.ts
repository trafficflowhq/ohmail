/**
 * Where the engine's diagnostic lines go on a phone — `console.log`, and nothing else. The engine writes one JSON
 * object per event; a phone has no stderr and no file this app may hand out, so the lines go to the platform's log
 * (React Native forwards to `__android_log_print` under `ReactNativeJS`; `adb logcat -s ReactNativeJS` is the
 * reader). A sink, deliberately not a logger: everything that decides what may be in a line — the field allowlist,
 * the redaction, the bounds, `err` becoming class + code — lives in the engine's own `createLogger`; an app
 * assembling `detail` objects would be a second logger outside every control (`apps/sidecar/src/log.ts`'s lesson). It
 * cannot take a dial down: the write is guarded and a lost line is the correct outcome. `console` is read at call
 * time — a module-scope read would bind whatever `console` was at import.
 */

/** What the engine is handed: one finished line, already redacted by its own logger. */
export type EngineLogSink = (line: string) => void;

/**
 * `console.log` and not `console.debug`, and the level is the load-bearing part.
 *
 * `plugins/release-minification.js` declares `-assumenosideeffects` on `android.util.Log.d` and
 * `.v`, so DEBUG and VERBOSE are stripped from the release build — that rule exists to keep a
 * push connector's secrets out of logcat. React Native's console reaches logcat through C++
 * rather than through `android.util.Log`, so it is not the rule's subject either way; taking the
 * level the rule KEEPS is what makes that independent of how RN binds its hook next release.
 */
export function consoleEngineLogSink(): EngineLogSink {
  return (line) => {
    try {
      console.log(line);
    } catch {
      /* A log line is never worth a mailbox. See the banner. */
    }
  };
}
