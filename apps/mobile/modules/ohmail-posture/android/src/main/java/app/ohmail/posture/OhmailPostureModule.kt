package app.ohmail.posture

import android.app.ActivityManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
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
 *
 * The network door's reader (`src/net/network-door.ts`) lives here too, so no second module ships:
 * `getNetwork` answers "online" or "offline" from the default network's INTERNET capability, and a
 * default-network callback sends `onNetworkChanged`. Any failure answers "unknown", never a throw.
 */
class OhmailPostureModule : Module() {
  private var job: Job? = null
  private var lastFolds: List<Map<String, Any?>> = emptyList()
  private var sawAnyFold = false
  private var netCallback: ConnectivityManager.NetworkCallback? = null

  private fun connectivity(): ConnectivityManager? =
    appContext.reactContext?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

  /**
   * The mail frame's length ceiling reads the app's heap here (`src/mail/frame-ceiling.ts`):
   * `getMemoryClass` is `ActivityManager.memoryClass` in MB, `isLowRamDevice` the platform's flag.
   * With no ActivityManager they answer 0 and true, which the JS takes as the floor.
   */
  private fun activityManager(): ActivityManager? =
    appContext.reactContext?.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager

  private fun networkState(): String = try {
    val cm = connectivity()
    if (cm == null) "unknown" else {
      val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
      if (caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true) "online" else "offline"
    }
  } catch (e: Exception) {
    "unknown"
  }

  /** Only a change crosses to JS: capabilities move on every signal-strength step. */
  @Volatile private var lastNetwork: String? = null

  private fun sendNetwork(state: String) {
    if (state == lastNetwork) return
    lastNetwork = state
    sendEvent("onNetworkChanged", mapOf("state" to state))
  }

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
    Events("onFoldsChanged", "onNetworkChanged")

    Function("getNetwork") { networkState() }
    Function("getFolds") { lastFolds }
    Function("getHasFold") { sawAnyFold }
    Function("getMemoryClass") { activityManager()?.memoryClass ?: 0 }
    Function("isLowRamDevice") { activityManager()?.isLowRamDevice ?: true }
    Function("getLaunchOverride") {
      appContext.currentActivity?.intent?.getStringExtra("OHMAIL_POSTURE")
        ?: System.getenv("OHMAIL_POSTURE")
    }

    OnCreate {
      val cm = connectivity() ?: return@OnCreate
      val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { sendNetwork(networkState()) }
        override fun onLost(network: Network) { sendNetwork("offline") }
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
          sendNetwork(if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) "online" else "offline")
        }
      }
      try {
        cm.registerDefaultNetworkCallback(callback)
        netCallback = callback
      } catch (e: Exception) {
        netCallback = null
      }
    }

    OnDestroy {
      val callback = netCallback ?: return@OnDestroy
      try { connectivity()?.unregisterNetworkCallback(callback) } catch (e: Exception) { }
      netCallback = null
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
