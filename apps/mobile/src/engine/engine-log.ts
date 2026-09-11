/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  WHERE THE ENGINE'S DIAGNOSTIC LINES GO ON A PHONE — `console.log`, and nothing else
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The engine writes one JSON object per event. On the desktop those bytes go to stderr and to
 * `engine.log`; on a phone there is no stderr and no file this app may hand out, so they go to
 * the platform's own log — `console.log`, which React Native forwards to `__android_log_print`
 * under the tag `ReactNativeJS` at INFO. `adb logcat -s ReactNativeJS` is then the whole reader.
 *
 * ── THIS IS A SINK AND DELIBERATELY NOT A LOGGER ───────────────────────────────────────────
 *
 * A {@link EngineLogSink} takes a finished LINE. Everything that decides what may be in that
 * line — the field allowlist, the redaction keyed on field names, the value grammars, the string
 * bounds, `err` becoming a class and a code with the message discarded — lives in the engine's
 * own `createLogger`, inside the artifact. An app that assembled `detail` objects of its own
 * would be a second logger outside every one of those controls, which is the defect
 * `apps/sidecar/src/log.ts` was written to end. So this app supplies the destination and has no
 * say in the contents.
 *
 * ── AND IT CANNOT TAKE A DIAL DOWN ─────────────────────────────────────────────────────────
 *
 * The engine calls this from inside a dial, a drain and a gate. A sink that threw would turn a
 * diagnostic into a mail failure, so the write is guarded and a lost line is the correct outcome
 * — the same rule the desktop's stderr sink states for EPIPE.
 *
 * `console` is read at CALL time rather than captured, for `log.ts`'s reason: a module-scope read
 * would bind whatever `console` was at import, and this module is imported before the app
 * composes.
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
