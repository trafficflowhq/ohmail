package app.ohmail.shell

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * THE KEEPER. A person's unsent words and intent, and the queue's rows, kept natively: one SQLite
 * database per scope, named by the scope (never by an address), in expo-sqlite's directory beside
 * the engine's store and the install marker, which the backup rules leave out.
 *
 * The page writes here BEFORE its own storage, so where the two differ this copy is the newer one
 * and wins. A web view's storage can be emptied by the system and its process ended while the app
 * lives; this file is what a person's words outlive that by.
 *
 * Every call runs on one thread, in the order it was made, and each write is a transaction
 * committed at synchronous EXTRA (read back at open: a level that did not take refuses the keeper
 * rather than keeping words that a power cut could take). Only the families the native side was
 * given are kept, and only the queue's carried row types; anything else is refused, never kept by
 * accident. Bounds refuse; nothing is ever evicted to make room.
 *
 * A word it refuses is remembered for its scope by name, with the digest of what it was asked to
 * keep, until a later keep of that word lands ([refused]): the page's next start keeps its own copy
 * only when it is that very one, since any page of the web view's one origin can write the page's
 * storage. The names live in the scope's file, and for this process alone while the file cannot take
 * them; at most [REFUSED_MAX] per scope, past which a new name is not remembered, only counted.
 */
class Keeper(private val context: Context) {
  data class Row(val type: String, val id: String, val json: String)

  private val io: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "shell keeper") }
  private val open = HashMap<String, SQLiteDatabase>()
  /** Refused names the scope's file could not take, with their digests: this process's alone. */
  private val unwritten = HashMap<String, LinkedHashMap<String, String?>>()

  /** The kept families: key prefixes. Set by the native side from one list, never by the page. */
  @Volatile var families: List<String> = emptyList()

  /** Runs `work` on the keeper's thread, in order; a fault answers `failed`, never a crash. */
  fun <T> run(work: () -> T, failed: T, done: (T) -> Unit) {
    io.execute { done(try { work() } catch (e: Throwable) { failed }) }
  }

  private fun dir(): File = File(context.filesDir, "SQLite").apply { mkdirs() }
  private fun fileOf(scope: String): File = File(dir(), "$FILE_PREFIX$scope.db")

  /** The scope's file, as a path; empty for a name that is no scope. */
  fun pathOf(scope: String): String = if (SCOPE.matches(scope)) fileOf(scope).path else ""

  private fun db(scope: String): SQLiteDatabase? {
    if (!SCOPE.matches(scope)) return null
    open[scope]?.let { return it }
    return try {
      val d = SQLiteDatabase.openOrCreateDatabase(fileOf(scope), null)
      d.execSQL("PRAGMA synchronous = EXTRA")
      val level = d.rawQuery("PRAGMA synchronous", null).use { if (it.moveToFirst()) it.getInt(0) else -1 }
      if (level != SYNCHRONOUS_EXTRA) {
        d.close()
        return null
      }
      d.execSQL("CREATE TABLE IF NOT EXISTS words (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
      d.execSQL("CREATE TABLE IF NOT EXISTS rows (type TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (type, id))")
      d.execSQL("CREATE TABLE IF NOT EXISTS refused (key TEXT PRIMARY KEY NOT NULL, digest TEXT)")
      open[scope] = d
      d
    } catch (e: Exception) {
      null
    }
  }

  fun isKeptFamily(key: String): Boolean = key.length <= KEY_MAX && families.any { key.startsWith(it) }

  /**
   * Keep one word, or remove it (`value` null). False: refused or not durable; the page says so, and the word is
   * remembered as refused. Kept: a refusal of it remembered earlier is let go in the same commit.
   */
  fun keep(scope: String, key: String, value: String?): Boolean {
    if (!isKeptFamily(key) || !SCOPE.matches(scope)) return false
    val d = db(scope)
    if (d == null || !write(d, key, value)) {
      remember(scope, d, key, value)
      return false
    }
    unwritten[scope]?.let {
      it.remove(key)
      if (it.isEmpty()) unwritten.remove(scope)
    }
    return true
  }

  private fun write(d: SQLiteDatabase, key: String, value: String?): Boolean {
    if (value != null && value.length > VALUE_MAX) return false
    return try {
      d.beginTransaction()
      try {
        if (value == null) {
          d.execSQL("DELETE FROM words WHERE key = ?", arrayOf(key))
        } else {
          val total = d.rawQuery("SELECT coalesce(sum(length(value)), 0) FROM words WHERE key <> ?", arrayOf(key))
            .use { if (it.moveToFirst()) it.getLong(0) else 0L }
          if (total + value.length > WORDS_MAX) return false
          d.execSQL("INSERT OR REPLACE INTO words (key, value) VALUES (?, ?)", arrayOf(key, value))
        }
        d.execSQL("DELETE FROM refused WHERE key = ?", arrayOf(key))
        d.setTransactionSuccessful()
      } finally {
        d.endTransaction()
      }
      true
    } catch (e: Exception) {
      false
    }
  }

  /**
   * The scope's words it was asked to keep and refused, not kept since: each name with the digest of what was asked
   * (null: a removal). The file's names, and over them those it could not take in this process.
   */
  fun refused(scope: String): List<Pair<String, String?>> {
    val out = LinkedHashMap<String, String?>()
    db(scope)?.let { d ->
      try {
        d.rawQuery("SELECT key, digest FROM refused ORDER BY key", null).use { c ->
          while (c.moveToNext()) out[c.getString(0)] = if (c.isNull(1)) null else c.getString(1)
        }
      } catch (e: Exception) {
        // Unreadable: the page's copies of these words then give way to the native set.
      }
    }
    unwritten[scope]?.let { out.putAll(it) }
    return out.toList()
  }

  /** A refused word, remembered for its scope: in its file when the file takes it, else for this process. */
  private fun remember(scope: String, d: SQLiteDatabase?, key: String, value: String?) {
    val known = refused(scope)
    if (known.size >= REFUSED_MAX && known.none { it.first == key }) {
      ShellRuntime.count("keeperRefusedUnnoted")
      return
    }
    val digest = digestOf(value)
    val stored = d != null && try {
      d.execSQL("INSERT OR REPLACE INTO refused (key, digest) VALUES (?, ?)", arrayOf<Any?>(key, digest))
      true
    } catch (e: Exception) {
      false
    }
    val waiting = unwritten.getOrPut(scope) { LinkedHashMap() }
    if (stored) waiting.remove(key) else waiting[key] = digest
    if (waiting.isEmpty()) unwritten.remove(scope)
  }

  fun kept(scope: String): List<Pair<String, String>>? {
    val d = db(scope) ?: return null
    return try {
      d.rawQuery("SELECT key, value FROM words ORDER BY key", null).use { c ->
        val out = ArrayList<Pair<String, String>>(c.count)
        while (c.moveToNext()) out.add(c.getString(0) to c.getString(1))
        out
      }
    } catch (e: Exception) {
      null
    }
  }

  /** The queue's rows: every put and delete in one transaction, or none of them. */
  fun keepRows(scope: String, puts: List<Row>, deletes: List<Pair<String, String>>): Boolean {
    if (puts.any { it.type !in CARRIED || it.id.length > ID_MAX || it.json.length > ROW_MAX }) return false
    if (deletes.any { it.first !in CARRIED }) return false
    val d = db(scope) ?: return false
    return try {
      d.beginTransaction()
      try {
        for ((type, id) in deletes) d.execSQL("DELETE FROM rows WHERE type = ? AND id = ?", arrayOf(type, id))
        for (r in puts) d.execSQL("INSERT OR REPLACE INTO rows (type, id, json) VALUES (?, ?, ?)", arrayOf(r.type, r.id, r.json))
        val count = d.rawQuery("SELECT count(*) FROM rows", null).use { if (it.moveToFirst()) it.getLong(0) else 0L }
        if (count > ROWS_MAX) return false
        d.setTransactionSuccessful()
      } finally {
        d.endTransaction()
      }
      true
    } catch (e: Exception) {
      false
    }
  }

  fun keptRows(scope: String): List<Row>? {
    val d = db(scope) ?: return null
    return try {
      d.rawQuery("SELECT type, id, json FROM rows ORDER BY type, id", null).use { c ->
        val out = ArrayList<Row>(c.count)
        while (c.moveToNext()) out.add(Row(c.getString(0), c.getString(1), c.getString(2)))
        out
      }
    } catch (e: Exception) {
      null
    }
  }

  /** The scopes this phone keeps anything for, read from the files themselves. */
  fun scopes(): List<String> =
    dir().listFiles()?.mapNotNull { f ->
      f.name.takeIf { it.startsWith(FILE_PREFIX) && it.endsWith(".db") }?.removePrefix(FILE_PREFIX)?.removeSuffix(".db")
    }?.filter { SCOPE.matches(it) }?.sorted() ?: emptyList()

  /** Remove one scope's keeper and read back that none of its files is left. */
  fun forget(scope: String): Boolean {
    if (!SCOPE.matches(scope)) return false
    open.remove(scope)?.let { runCatching { it.close() } }
    unwritten.remove(scope)
    val base = fileOf(scope)
    for (suffix in SUFFIXES) File(base.path + suffix).delete()
    return SUFFIXES.none { File(base.path + it).exists() }
  }

  companion object {
    const val FILE_PREFIX = "ohmail-keeper-"
    const val SYNCHRONOUS_EXTRA = 3
    const val KEY_MAX = 512
    const val VALUE_MAX = 10 * 1024 * 1024
    const val WORDS_MAX = 32L * 1024 * 1024
    const val ID_MAX = 256
    const val ROW_MAX = 64 * 1024 * 1024
    const val ROWS_MAX = 10_000L
    /** Refused words remembered per scope: well above the kept keys a page writes between two starts. */
    const val REFUSED_MAX = 1_000
    private const val DIGEST_CHUNK = 8_192

    /** The bridge's word digest: SHA-256 over the UTF-16 code units, low byte first, as lowercase hex; null: a removal. */
    fun digestOf(value: String?): String? {
      if (value == null) return null
      val sha = MessageDigest.getInstance("SHA-256")
      val units = ByteArray(DIGEST_CHUNK * 2)
      var at = 0
      while (at < value.length) {
        val n = minOf(DIGEST_CHUNK, value.length - at)
        for (i in 0 until n) {
          val unit = value[at + i].code
          units[2 * i] = unit.toByte()
          units[2 * i + 1] = (unit ushr 8).toByte()
        }
        sha.update(units, 0, 2 * n)
        at += n
      }
      return sha.digest().joinToString("") { "%02x".format(it) }
    }
    /** The queue's carried row types: the client engine's `isCarriedLocalType`. */
    val CARRIED = setOf("outbox_entry", "outbox_abandoned", "routing_journal", "compose_letter", "compose_file")
    val SCOPE = Regex("^p[0-9a-f]{32}$")
    private val SUFFIXES = listOf("", "-journal", "-wal", "-shm")
  }
}
