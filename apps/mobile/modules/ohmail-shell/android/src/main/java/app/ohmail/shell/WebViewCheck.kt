package app.ohmail.shell

import android.content.Context
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * WHETHER THIS PHONE'S WEB VIEW CAN CARRY THE SHELL. Three gates, and no fallback past any: a web
 * view package must be installed (Android says the call can answer null: a device set up wrongly,
 * Wear OS, no updatable web view); it must name a message's origin and frame
 * (`WEB_MESSAGE_LISTENER`), without which the bridge could not tell the shell's page from a frame
 * inside a letter; and it must take the two seals the network block does not give (`sealed`): a
 * proxy for every web view (`PROXY_OVERRIDE`) and a script before the page's own
 * (`DOCUMENT_START_SCRIPT`). The major version is read for the sentence and the log; the oldest one
 * the shell states is a stand-in until phones are read (`OLDEST_WEBVIEW_MAJOR` on the JS side).
 */
object WebViewCheck {
  data class Reading(val installed: Boolean, val major: Int?, val listener: Boolean, val sealed: Boolean) {
    val usable: Boolean get() = installed && listener && sealed
    fun toMap(): Map<String, Any?> = mapOf("installed" to installed, "major" to major, "listener" to listener, "sealed" to sealed)
  }

  fun read(context: Context): Reading {
    val pkg = try { WebViewCompat.getCurrentWebViewPackage(context) } catch (e: Exception) { null }
    if (pkg == null) return Reading(installed = false, major = null, listener = false, sealed = false)
    val major = pkg.versionName?.substringBefore('.')?.toIntOrNull()
    val listener = supports(WebViewFeature.WEB_MESSAGE_LISTENER)
    val sealed = supports(WebViewFeature.PROXY_OVERRIDE) && supports(WebViewFeature.DOCUMENT_START_SCRIPT)
    return Reading(installed = true, major = major, listener = listener, sealed = sealed)
  }

  private fun supports(feature: String): Boolean =
    try { WebViewFeature.isFeatureSupported(feature) } catch (e: Exception) { false }
}
