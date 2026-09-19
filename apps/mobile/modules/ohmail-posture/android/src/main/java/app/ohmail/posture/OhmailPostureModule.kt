package app.ohmail.posture

import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * The Android fold reading — Jetpack WindowManager's FoldingFeatures, mapped verbatim to the
 * JS `FoldFeature` shape (`src/ui/posture/derive.ts`): bounds in dp, HALF_OPENED -> "half",
 * FLAT -> "flat", occlusionType FULL -> "full" (a hard hinge, the Surface Duo 2). The
 * collector runs while an activity is foregrounded and every change is an `onFoldsChanged`
 * event; `getFolds` answers the last reading synchronously, `getHasFold` whether this device
 * ever reported a fold, and `getLaunchOverride` a test run's intent extra
 * (`adb shell am start … --es OHMAIL_POSTURE <pose>`) or process env.
 */
class OhmailPostureModule : Module() {
  private var job: Job? = null
  private var lastFolds: List<Map<String, Any?>> = emptyList()
  private var sawAnyFold = false

  private fun featureMap(f: FoldingFeature, density: Float): Map<String, Any?> = mapOf(
    "bounds" to mapOf(
      "x" to f.bounds.left / density,
      "y" to f.bounds.top / density,
      "w" to f.bounds.width() / density,
      "h" to f.bounds.height() / density,
    ),
    "state" to if (f.state == FoldingFeature.State.HALF_OPENED) "half" else "flat",
    "orientation" to if (f.orientation == FoldingFeature.Orientation.VERTICAL) "vertical" else "horizontal",
    "occlusion" to if (f.occlusionType == FoldingFeature.OcclusionType.FULL) "full" else "none",
  )

  override fun definition() = ModuleDefinition {
    Name("OhmailPosture")
    Events("onFoldsChanged")

    Function("getFolds") { lastFolds }
    Function("getHasFold") { sawAnyFold }
    Function("getLaunchOverride") {
      appContext.currentActivity?.intent?.getStringExtra("OHMAIL_POSTURE")
        ?: System.getenv("OHMAIL_POSTURE")
    }

    OnActivityEntersForeground {
      val activity = appContext.currentActivity ?: return@OnActivityEntersForeground
      if (job != null) return@OnActivityEntersForeground
      val density = activity.resources.displayMetrics.density
      job = CoroutineScope(Dispatchers.Main).launch {
        WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity).collect { info ->
          val folds = info.displayFeatures.filterIsInstance<FoldingFeature>()
          if (folds.isNotEmpty()) sawAnyFold = true
          lastFolds = folds.map { featureMap(it, density) }
          sendEvent("onFoldsChanged", mapOf("folds" to lastFolds))
        }
      }
    }

    OnActivityDestroys {
      job?.cancel()
      job = null
    }
  }
}
