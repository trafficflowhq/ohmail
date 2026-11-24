package app.ohmail.calendar

import android.content.Context
import java.io.File

/** App-private snapshot and generation files. A revoked or unreadable marker cannot authorize a read. */
internal object CalendarStore {
  private const val DIR_NAME = "ohcal"
  private const val RUNG_FILE = "ohcal-rung"
  /** The most text a record's file may hold: the reader's own bound. */
  private const val RECORD_MOST = ClosedJson.MOST.toLong()
  /** Keep recent deliveries from the previous set as well as those from the current set. */
  private const val RUNG_COUNT = 2 * CalendarSnapshot.AHEAD_MAX
  private const val RUNG_MOST = (RUNG_COUNT * (CalendarSnapshot.AHEAD_ID_MAX + 1)).toLong()

  private val lock = Any()

  fun <T> locked(work: () -> T): T = synchronized(lock) { work() }

  private fun dir(context: Context): File = File(context.filesDir, DIR_NAME)

  private fun folder(context: Context, pairing: String): File? =
    if (LiveInstanceGate.isInstance(pairing)) File(dir(context), pairing) else null

  private const val GENERATION_FILE = "ohcal-widget-generation"
  private const val REVOKED = "revoked"
  private var blocked = false
  private val generationShape = Regex("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")

  data class Generation(val pairing: String, val id: String)
  data class Active(val generation: Generation, val snapshot: Snapshot)

  fun generation(context: Context): Generation? {
    val text = readBounded(File(context.noBackupFilesDir, GENERATION_FILE), 128) ?: return null
    val parts = text.split('\n')
    if (parts.size != 2 || !LiveInstanceGate.isInstance(parts[0]) || !generationShape.matches(parts[1])) return null
    return Generation(parts[0], parts[1])
  }

  fun active(context: Context): Active? = locked {
    if (blocked) return@locked null
    val marker = generation(context) ?: return@locked null
    val snapshot = read(context, marker.pairing) ?: return@locked null
    if (snapshot.hasTitles() || generation(context) != marker) return@locked null
    Active(marker, snapshot)
  }

  fun revoke(context: Context): Boolean {
    blocked = true
    if (mark(context, REVOKED)) return true
    val base = context.noBackupFilesDir
    val contents = base.listFiles() ?: return false
    val previous = contents.firstOrNull { it.name == GENERATION_FILE } ?: return true
    return previous.delete() && base.listFiles()?.none { it.name == GENERATION_FILE } == true
  }

  fun activate(context: Context, marker: Generation): Boolean {
    val saved = mark(context, "${marker.pairing}\n${marker.id}")
    if (saved) blocked = false
    return saved
  }

  private fun mark(context: Context, text: String): Boolean =
    writeWhole(context.noBackupFilesDir, GENERATION_FILE, text) &&
      readBounded(File(context.noBackupFilesDir, GENERATION_FILE), 128) == text

  fun forgetSnapshot(context: Context, pairing: String): Boolean {
    val folder = folder(context, pairing) ?: return false
    if (!folder.exists() && !folder.mkdirs()) return false
    val files = folder.listFiles() ?: return false
    val stale = { file: File -> file.name == CalendarSnapshot.SNAPSHOT_FILE || file.name.endsWith(".part") }
    return files.filter(stale).all { it.delete() } && folder.listFiles()?.none(stale) == true
  }

  fun forgetPairing(context: Context, pairing: String): Boolean {
    val base = dir(context)
    if (!base.exists() && !base.mkdirs()) return false
    val contents = base.listFiles() ?: return false
    val stale = contents.firstOrNull { it.name == pairing } ?: return true
    return stale.deleteRecursively() && base.listFiles()?.none { it.name == pairing } == true
  }

  /** Where `pairing`'s record is kept, its folder made: what the backup claim measures. Empty for no pairing. */
  fun recordPath(context: Context, pairing: String): String = synchronized(lock) {
    val folder = folder(context, pairing) ?: return ""
    folder.mkdirs()
    File(folder, CalendarSnapshot.SNAPSHOT_FILE).path
  }

  /**
   * Write a closed copy before the generation is activated. CalendarLive holds the publication permit.
   */
  fun write(context: Context, pairing: String, snapshot: Snapshot): Boolean = synchronized(lock) {
    if (snapshot.hasTitles()) return false
    val folder = folder(context, pairing) ?: return false
    val text = CalendarSnapshot.write(snapshot)
    if (!writeWhole(folder, CalendarSnapshot.SNAPSHOT_FILE, text)) return false
    read(context, pairing) == snapshot
  }

  /** `pairing`'s record, read closed; null for none, one too long, or one that does not read. */
  fun read(context: Context, pairing: String): Snapshot? = synchronized(lock) {
    val folder = folder(context, pairing) ?: return null
    val text = readBounded(File(folder, CalendarSnapshot.SNAPSHOT_FILE), RECORD_MOST) ?: return null
    CalendarSnapshot.read(text)
  }

  /** What has rung of `pairing`'s set, by id; empty where nothing is kept. */
  fun rung(context: Context, pairing: String): Set<String> = synchronized(lock) {
    val folder = folder(context, pairing) ?: return emptySet()
    val text = readBounded(File(folder, RUNG_FILE), RUNG_MOST) ?: return emptySet()
    text.split('\n').filter { it.isNotEmpty() && it.length <= CalendarSnapshot.AHEAD_ID_MAX }.toSet()
  }

  fun keepRung(context: Context, pairing: String, ids: Set<String>): Boolean = synchronized(lock) {
    val folder = folder(context, pairing) ?: return false
    writeWhole(folder, RUNG_FILE, ids.toList().takeLast(RUNG_COUNT).joinToString("\n"))
  }

  /** Every record but `keep`'s removed (with none kept, every one); true once none of them is left. */
  fun forgetAllBut(context: Context, keep: String?): Boolean = synchronized(lock) {
    val base = dir(context)
    if (!base.exists() && !base.mkdirs()) return false
    val folders = base.listFiles() ?: return false
    var gone = true
    for (f in folders) {
      if (keep != null && f.name == keep && LiveInstanceGate.isInstance(keep)) continue
      f.deleteRecursively()
      if (f.exists()) gone = false
    }
    gone && base.listFiles()?.all { it.name == keep } == true
  }

  private fun readBounded(file: File, most: Long): String? = try {
    if (!file.isFile || file.length() > most) null else file.readText(Charsets.UTF_8)
  } catch (t: Throwable) {
    null
  }

  private fun writeWhole(folder: File, name: String, text: String): Boolean {
    val file = File(folder, name)
    val part = File(folder, "$name.part")
    return try {
      folder.mkdirs()
      part.writeText(text, Charsets.UTF_8)
      if (part.renameTo(file)) true else { part.delete(); false }
    } catch (t: Throwable) {
      part.delete()
      false
    }
  }
}
