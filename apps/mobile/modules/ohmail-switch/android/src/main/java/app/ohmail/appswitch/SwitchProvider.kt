package app.ohmail.appswitch

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle

/** The one question the sibling may ask, and the words of the ask and its answer. None of them is a stored name. */
internal const val ASK_METHOD = "ask"
internal const val ASKED_DIGEST = "d"
internal const val SAID = "a"
internal const val SAID_CHALLENGE = "c"

/** The authority of an app's switch provider: its identifier and `.switch`, as `variants.json` writes it. */
internal fun authorityOf(packageName: String) = "$packageName.switch"

/** The manifest's line naming this app's sibling (`plugins/app-switch.js`). */
internal const val SIBLING_META = "switch.sibling"

/** The sibling this app's manifest names, or null where nothing can be read. */
internal fun siblingOf(context: Context): String? = try {
  context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA).metaData?.getString(SIBLING_META)
} catch (e: Exception) {
  null
}

/**
 * THE SIBLING'S ONE QUESTION, ANSWERED WITHOUT A WINDOW: before it opens this app, the other app asks whether this app
 * holds a live pairing, naming its own pairing by its digest. Answered `same` (this app holds that pairing), `other`
 * (it holds another), or `none` with a fresh challenge (it holds none, so the sibling may mint a one-use code bound to
 * that challenge and hand it over in the same call that opens this app). Anything else is answered with nothing.
 *
 * The framework checks no permission on `call()`, so the caller is checked here, every time: it must be the sibling
 * this app's manifest names, hold the pair's signature permission (the provider's own), and be signed with this app's
 * key. The answer comes from the file the app writes at each change of its pairings; a file that says nothing, or
 * says this app holds a pairing, never makes a challenge. Nothing is logged.
 */
class SwitchProvider : ContentProvider() {
  override fun onCreate(): Boolean = true

  override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
    val context = context ?: return null
    if (method != ASK_METHOD || !callerIsTheSibling(context)) return null
    SwitchStore.dropStaleAsk(context)
    val held = SwitchStore.readPairings(context) ?: return null
    val digest = extras?.getString(ASKED_DIGEST)?.takeIf { SwitchStore.isDigest(it) }
    val answer = Bundle()
    when {
      held.isNotEmpty() && digest != null && digest in held -> answer.putString(SAID, "same")
      held.isNotEmpty() -> answer.putString(SAID, "other")
      else -> {
        val challenge = SwitchStore.makeAsk(context) ?: return null
        answer.putString(SAID, "none")
        answer.putString(SAID_CHALLENGE, challenge)
      }
    }
    return answer
  }

  /** The caller, as the system vouches for it: the named sibling, holding the pair's permission, signed alike. */
  private fun callerIsTheSibling(context: Context): Boolean {
    val caller = (try { callingPackage } catch (e: SecurityException) { null }) ?: return false
    val sibling = siblingOf(context) ?: return false
    if (caller != sibling) return false
    val pm = context.packageManager
    if (pm.getPackagesForUid(Binder.getCallingUid())?.contains(caller) != true) return false
    val permission = readPermission ?: return false
    if (context.checkCallingPermission(permission) != PackageManager.PERMISSION_GRANTED) return false
    return try {
      pm.checkSignatures(context.packageName, caller) == PackageManager.SIGNATURE_MATCH
    } catch (e: Exception) {
      false
    }
  }

  override fun query(
    uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?,
  ): Cursor? = null

  override fun getType(uri: Uri): String? = null

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
