package app.ohmail.appswitch

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** The door the other app opens, `<its identifier>.SwitchOpen`: an alias of its main activity, guarded by the pair's permission. */
private fun aliasOf(packageName: String) = "$packageName.SwitchOpen"

/** The payload's fields as extras: each under this prefix, as a string. Nothing of it is in the intent's data. */
private const val EXTRA_PREFIX = "switch."
private val FIELDS = listOf("v", "k", "p", "d", "c", "l")

private const val PLAY_STORE = "com.android.vending"

/** The shortest gap between two opens, and how long an arrival is held for the page to take. */
private const val PRESS_GAP_MS = 2_000L
private const val ARRIVAL_TTL_MS = 60_000L

/**
 * THE SWITCH BETWEEN THE TWO APPS, native's whole on Android. `appId` is the identifier this app was installed under.
 * No call takes a package or an address: the sibling is the one the manifest names, and it is trusted only while it
 * is installed AND signed with this app's own key (`checkSignatures`), read again before every call. An impostor
 * under the sibling's name reads as absent and is asked and sent nothing.
 *
 * Before a press opens the sibling, the sibling's provider is asked about this app's pairing (`askSibling`): only its
 * answer `none` carries a challenge, for which the app may mint the one-use code that rides the opening call. An
 * arrival is read only from an intent whose component is the switch's alias (the launcher's own activity is exported
 * too, and its intents are anyone's), only its known fields and only the opening leg (Android has no other), and its
 * extras are cleared once read: Android hands the launch intent back from the recents list. One arrival is held,
 * handed over once, for a minute at most. The verifier of this app's own pending challenge is handed over once
 * (`takeVerifier`); the app writes its pairings' digests for its provider (`notePairings`). Nothing of a payload is
 * ever logged.
 */
class OhmailSwitchModule : Module() {
  private var held: Map<String, String>? = null
  private var heldAt = 0L
  private var lastOpen = Long.MIN_VALUE / 2
  private var inFront = false

  private val context: Context?
    get() = appContext.reactContext?.applicationContext

  /** The sibling, only while it is installed and signed alike; null otherwise (and when nothing can be read). */
  private fun trustedSibling(): String? {
    val ctx = context ?: return null
    val other = siblingOf(ctx) ?: return null
    return try {
      ctx.packageManager.getPackageInfo(other, 0)
      if (ctx.packageManager.checkSignatures(ctx.packageName, other) == PackageManager.SIGNATURE_MATCH) other else null
    } catch (e: Exception) {
      null
    }
  }

  private fun intake(intent: Intent?) {
    val own = context?.packageName ?: return
    if (intent == null || intent.component?.className != aliasOf(own)) return
    val extras = intent.extras ?: return
    val fields = FIELDS.mapNotNull { key -> extras.getString(EXTRA_PREFIX + key)?.let { key to it } }.toMap()
    // Cleared once read: a launch intent handed back from recents must not arrive twice.
    intent.replaceExtras(Bundle())
    appContext.currentActivity?.intent?.let { if (it.component?.className == aliasOf(own)) it.replaceExtras(Bundle()) }
    if (fields["k"] != "open") return
    held = fields
    heldAt = SystemClock.elapsedRealtime()
    sendEvent("onArrival", emptyMap<String, Any>())
  }

  /**
   * The sibling's provider, asked about this app's pairing by its digest: `{a: same|other}`, or `{a: none, c}` with the
   * challenge it made. Null for an untrusted or absent sibling, a provider owned by another package, and any other
   * answer. Only the trusted sibling is ever asked.
   */
  private fun askSibling(digest: String?): Map<String, String>? {
    val ctx = context ?: return null
    val other = trustedSibling() ?: return null
    val authority = authorityOf(other)
    val owner = try { ctx.packageManager.resolveContentProvider(authority, 0)?.packageName } catch (e: Exception) { null }
    if (owner != other) return null
    val asked = Bundle()
    if (SwitchStore.isDigest(digest)) asked.putString(ASKED_DIGEST, digest)
    val answer = (try {
      ctx.contentResolver.call(Uri.parse("content://$authority"), ASK_METHOD, null, asked)
    } catch (e: Exception) {
      null
    }) ?: return null
    return when (answer.getString(SAID)) {
      "same" -> mapOf("a" to "same")
      "other" -> mapOf("a" to "other")
      "none" -> answer.getString(SAID_CHALLENGE)?.takeIf { SwitchStore.isDigest(it) }?.let { mapOf("a" to "none", "c" to it) }
      else -> null
    }
  }

  /** The verifier of this app's pending challenge, once, as `{verifier}`; null for any other challenge. */
  private fun takeVerifier(challenge: String): Map<String, String>? {
    val ctx = context ?: return null
    return SwitchStore.takeAsk(ctx, challenge)?.let { mapOf("verifier" to it) }
  }

  /** This app's live pairings by their digests, for its provider; false when the file was not written. */
  private fun notePairings(digests: List<String>): Boolean {
    val ctx = context ?: return false
    return SwitchStore.writePairings(ctx, digests)
  }

  override fun definition() = ModuleDefinition {
    Name("OhmailSwitch")

    Constants {
      mapOf("appId" to (appContext.reactContext?.applicationContext?.packageName ?: ""))
    }

    Events("onArrival")

    OnCreate {
      context?.let { SwitchStore.dropStaleAsk(it) }
      intake(appContext.currentActivity?.intent)
    }
    OnNewIntent { intent -> intake(intent) }
    OnActivityEntersForeground {
      inFront = true
      intake(appContext.currentActivity?.intent)
    }
    OnActivityEntersBackground { inFront = false }

    Function("otherState") {
      if (trustedSibling() != null) "here" else "absent"
    }

    AsyncFunction("askSibling") { digest: String? ->
      askSibling(digest)
    }

    AsyncFunction("open") { fields: Map<String, String> ->
      val activity = appContext.currentActivity ?: return@AsyncFunction false
      if (!inFront || fields["k"] != "open") return@AsyncFunction false
      val now = SystemClock.elapsedRealtime()
      if (now - lastOpen < PRESS_GAP_MS) return@AsyncFunction false
      val other = trustedSibling() ?: return@AsyncFunction false
      lastOpen = now
      val intent = Intent().setComponent(ComponentName(other, aliasOf(other))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      for ((key, value) in fields) if (key in FIELDS) intent.putExtra(EXTRA_PREFIX + key, value)
      try {
        activity.startActivity(intent)
        true
      } catch (e: ActivityNotFoundException) {
        false
      } catch (e: SecurityException) {
        false
      }
    }

    AsyncFunction("openStore") {
      val ctx = context ?: return@AsyncFunction false
      val other = siblingOf(ctx) ?: return@AsyncFunction false
      val listing = Uri.parse("https://play.google.com/store/apps/details?id=$other")
      val intent = Intent(Intent.ACTION_VIEW, listing).setPackage(PLAY_STORE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        ctx.startActivity(intent)
        true
      } catch (e: ActivityNotFoundException) {
        false
      }
    }

    AsyncFunction("takeArrival") {
      val fields = held
      held = null
      if (fields == null || SystemClock.elapsedRealtime() - heldAt > ARRIVAL_TTL_MS) null else fields
    }

    AsyncFunction("takeVerifier") { challenge: String ->
      takeVerifier(challenge)
    }

    AsyncFunction("notePairings") { digests: List<String> ->
      notePairings(digests)
    }
  }
}
