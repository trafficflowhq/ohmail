package app.ohmail.notices

/**
 * FOR WHOM A NOTICE MAY BE DRAWN: only for the pairing kept as the signed-in one.
 *
 * ONE TEXT, TWO PACKAGES. apps/mobile/plugins/wake-push-renderer.js writes this file into the app
 * at prebuild, and the notices' module carries the same text under its own package; a test holds
 * the two equal. Change it in the plugin, never here.
 *
 * It imports nothing and keeps nothing: what the file says is handed in as lines, a wake's or a
 * notice's pairing as a string. Everything that is not exactly right draws nothing.
 */
object LiveInstanceGate {
  /** The file that says which pairing is signed in, in the app's no-backup folder. */
  const val FILE = "ohmail-notices-live"

  /** The most characters the file may hold: two short lines. Anything longer is not read. */
  const val MOST = 64

  private const val HEAD = "v1"
  private const val SHORTEST = 7
  private const val LONGEST = 31

  /** A pairing's local id as the app mints it: p, then 6 to 30 of 0-9 and a-z. */
  @JvmStatic
  fun isInstance(text: String?): Boolean {
    if (text == null || text.length < SHORTEST || text.length > LONGEST || text[0] != 'p') return false
    for (i in 1 until text.length) {
      val c = text[i]
      if (!((c in '0'..'9') || (c in 'a'..'z'))) return false
    }
    return true
  }

  /** The pairing the file's lines name, or null where they name none. */
  @JvmStatic
  fun keptOf(lines: List<String>?): String? {
    if (lines == null || lines.size != 2 || lines[0] != HEAD) return null
    return if (isInstance(lines[1])) lines[1] else null
  }

  /** The lines that keep a pairing, or null for what is no pairing's id: then nothing is written. */
  @JvmStatic
  fun linesOf(instance: String?): List<String>? =
    if (instance != null && isInstance(instance)) listOf(HEAD, instance) else null

  /** A notice for a pairing may be drawn only while the kept one is that same pairing. */
  @JvmStatic
  fun mayDraw(kept: String?, instance: String?): Boolean =
    kept != null && instance != null && isInstance(kept) && isInstance(instance) && kept == instance
}
