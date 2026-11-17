package app.ohmail.appswitch

import android.content.Context
import android.os.Process
import android.os.SystemClock
import android.util.Base64
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * WHAT THE SWITCH KEEPS ON ANDROID, two small files in the app's no-backup folder (never in a backup, never on another
 * phone), each written whole through a part file and a rename:
 *
 *  - the digests of this app's live pairings, one a line (SHA-256 over a server's origin, a newline and the account,
 *    base64url). The app writes it at its launch and at each change of its pairings; its provider reads it to answer
 *    the sibling. A file that is missing, unreadable or of another shape says nothing.
 *  - the one pending ask: a verifier of 32 random bytes (the platform's own source) made when the sibling asked and
 *    this app held no live pairing, with its challenge (SHA-256 of the verifier, base64url), when it was made and the
 *    process that made it. One at a time; handed over once, only for its own challenge, only within two minutes and
 *    only to the process that made it, and gone after any taking. One no arrival can take any more is dropped at the
 *    app's launch and at its provider's next call.
 *
 * Nothing of either is ever logged.
 */
internal object SwitchStore {
  const val PAIRINGS_FILE = "ohmail-switch-pairings"
  const val ASK_FILE = "ohmail-switch-ask"
  const val ASK_TTL_MS = 120_000L

  private const val HEAD = "v1"
  private const val MOST = 64
  private val SHAPE = Regex("^[A-Za-z0-9_-]{43}$")
  private val lock = Any()
  private val random = SecureRandom()

  /** A digest or a challenge as the switch carries them: 32 bytes, base64url, no padding. */
  fun isDigest(text: String?): Boolean = text != null && SHAPE.matches(text)

  /** The digests the file says, or null where it says nothing. */
  fun readPairings(context: Context): Set<String>? {
    synchronized(lock) {
      return try {
        val file = File(context.noBackupFilesDir, PAIRINGS_FILE)
        if (!file.isFile) return null
        val lines = file.readLines(Charsets.US_ASCII)
        if (lines.firstOrNull() != HEAD) return null
        val digests = lines.drop(1).filter { it.isNotEmpty() }
        if (digests.size > MOST || !digests.all { isDigest(it) }) return null
        digests.toSet()
      } catch (e: Exception) {
        null
      }
    }
  }

  /** The app's live pairings, by their digests; an empty list says this app holds none. False when not written. */
  fun writePairings(context: Context, digests: List<String>): Boolean {
    if (digests.size > MOST || !digests.all { isDigest(it) }) return false
    synchronized(lock) {
      return writeWhole(File(context.noBackupFilesDir, PAIRINGS_FILE), listOf(HEAD) + digests)
    }
  }

  /** A fresh verifier for the sibling's ask, in place of any other: its challenge, or null when it was not kept. */
  fun makeAsk(context: Context): String? {
    val bytes = ByteArray(32)
    random.nextBytes(bytes)
    val verifier = base64url(bytes)
    val challenge = challengeOf(verifier)
    synchronized(lock) {
      val made = listOf(
        HEAD, verifier, challenge, SystemClock.elapsedRealtime().toString(), Process.getStartElapsedRealtime().toString(),
      )
      return if (writeWhole(File(context.noBackupFilesDir, ASK_FILE), made)) challenge else null
    }
  }

  /** The pending ask's verifier, once and only for `challenge`; null for anything else. Any taking clears it. */
  fun takeAsk(context: Context, challenge: String): String? {
    synchronized(lock) {
      val file = File(context.noBackupFilesDir, ASK_FILE)
      return try {
        if (!file.isFile) return null
        val lines = file.readLines(Charsets.US_ASCII)
        file.delete()
        if (!isDigest(challenge) || !takeable(lines)) return null
        if (!MessageDigest.isEqual(lines[2].toByteArray(Charsets.US_ASCII), challenge.toByteArray(Charsets.US_ASCII))) return null
        lines[1]
      } catch (e: Exception) {
        file.delete()
        null
      }
    }
  }

  /** A pending ask no arrival can take any more, dropped: at the app's launch and at its provider's next call. */
  fun dropStaleAsk(context: Context) {
    synchronized(lock) {
      val file = File(context.noBackupFilesDir, ASK_FILE)
      try {
        if (file.isFile && !takeable(file.readLines(Charsets.US_ASCII))) file.delete()
      } catch (e: Exception) {
        file.delete()
      }
    }
  }

  /** An ask's lines as `makeAsk` wrote them, within two minutes, made by this very process. */
  private fun takeable(lines: List<String>): Boolean {
    if (lines.size < 5 || lines[0] != HEAD) return false
    val madeAt = lines[3].toLongOrNull() ?: return false
    val age = SystemClock.elapsedRealtime() - madeAt
    // A process death between the sibling's ask and its arrival ends the ask: the app opens at its own door.
    return lines[4].toLongOrNull() == Process.getStartElapsedRealtime() && age >= 0 && age <= ASK_TTL_MS
  }

  /** SHA-256 of the verifier's characters, base64url without padding: what the server derives from it too. */
  fun challengeOf(verifier: String): String =
    base64url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

  private fun base64url(bytes: ByteArray): String =
    Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

  /** The lines as the file's whole: a part file first, then the rename over it; the old file stands on any failure. */
  private fun writeWhole(file: File, lines: List<String>): Boolean {
    val part = File(file.parentFile, file.name + ".part")
    return try {
      part.writeText(lines.joinToString("\n", postfix = "\n"), Charsets.US_ASCII)
      if (part.renameTo(file)) true else { part.delete(); false }
    } catch (e: Exception) {
      part.delete()
      false
    }
  }
}
