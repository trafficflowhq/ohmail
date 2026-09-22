package app.ohmail.backupexclusion

import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * THE ANDROID HALF, AND IT IS THE SAME FUNCTION AS THE OTHER PLATFORM'S.
 *
 * There is nothing to set here — the exclusion is declared in the manifest's ruleset and read by
 * the platform's backup agent — so `excludeFromBackup` is the same reading as `isExcluded`. One
 * function, one answer on both platforms, which is what lets the app's sentence come from one
 * place instead of from a per-platform literal somebody has to keep true by hand.
 */
class BackupExclusionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OhmailBackupExclusion")

    AsyncFunction("excludeFromBackup") { path: String ->
      BackupRules.isExcluded(appContext.reactContext ?: throw Exceptions.ReactContextLost(), path)
    }

    AsyncFunction("isExcluded") { path: String ->
      BackupRules.isExcluded(appContext.reactContext ?: throw Exceptions.ReactContextLost(), path)
    }
  }
}
