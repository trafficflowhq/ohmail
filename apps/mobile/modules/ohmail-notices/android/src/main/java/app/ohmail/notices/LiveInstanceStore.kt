package app.ohmail.notices

import android.content.Context
import java.io.File

/**
 * WHICH PAIRING IS SIGNED IN, kept where a closed app's wake can read it: the one reader and writer of that file in
 * this module. The file is the gate's ({@link LiveInstanceGate.FILE}), in the app's no-backup folder (never in a
 * backup, never on another phone): two lines, the head and the pairing's local id, which the gate alone says how to
 * write and how to read. The wake's renderer reads it the same way, in a process that may hold nothing else of the
 * app.
 *
 * Written whole through a part file and a rename, so a reader meets the old file or the new one, never half of one.
 * What is no pairing's id is kept as none: the file goes. It logs nothing.
 */
internal object LiveInstanceStore {
  private val lock = Any()

  /** The pairing the file keeps, or null: no file, one too long to be it, one that cannot be read, or another shape. */
  fun kept(context: Context): String? {
    synchronized(lock) {
      return try {
        val file = File(context.noBackupFilesDir, LiveInstanceGate.FILE)
        if (!file.isFile || file.length() > LiveInstanceGate.MOST) return null
        LiveInstanceGate.keptOf(file.readLines(Charsets.US_ASCII))
      } catch (t: Throwable) {
        null
      }
    }
  }

  /**
   * Keep `instance` as the signed-in pairing, or none. True once the file says exactly that, read back; false where
   * it could not be written or removed (the old file then stands).
   */
  fun keep(context: Context, instance: String?): Boolean {
    synchronized(lock) {
      return try {
        val file = File(context.noBackupFilesDir, LiveInstanceGate.FILE)
        val part = File(file.parentFile, file.name + ".part")
        val lines = LiveInstanceGate.linesOf(instance)
        if (lines == null) {
          part.delete()
          file.delete()
          !file.exists()
        } else {
          writeWhole(file, part, lines) && kept(context) == instance
        }
      } catch (t: Throwable) {
        false
      }
    }
  }

  /** The lines as the file's whole: the part file first, then the rename over it; on any failure the old one stands. */
  private fun writeWhole(file: File, part: File, lines: List<String>): Boolean {
    return try {
      part.writeText(lines.joinToString("\n") + "\n", Charsets.US_ASCII)
      if (part.renameTo(file)) true else { part.delete(); false }
    } catch (t: Throwable) {
      part.delete()
      false
    }
  }
}
