package app.ohmail.enginelog

import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * THE ANDROID HALF — the same one function, under a tag of this app's own.
 *
 * Android was never the defect (RN's console reaches logcat under `ReactNativeJS` in every
 * configuration), so this is not a rescue: it is the same surface on both platforms and a tag
 * that does not depend on how RN binds its console hook next release.
 *
 * `d` and `v` are absent by design, not by oversight: `plugins/release-minification.js` declares
 * `-assumenosideeffects` on `android.util.Log.d` and `.v`, so a release build strips them — a
 * level that disappears from the shipped binary is not a sink. `debug` therefore takes the level
 * the rule KEEPS, which is the same reasoning `engine-log.ts` already applies to `console.log`.
 */
class EngineLogSinkModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OhmailEngineLogSink")

    Function("write") { level: String, line: String ->
      when (level) {
        "error" -> Log.e(TAG, line)
        "warn" -> Log.w(TAG, line)
        else -> Log.i(TAG, line)
      }
    }
  }

  private companion object {
    const val TAG = "ohmail.engine"
  }
}
