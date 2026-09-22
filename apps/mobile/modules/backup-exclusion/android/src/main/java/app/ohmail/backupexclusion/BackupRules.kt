package app.ohmail.backupexclusion

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.res.XmlResourceParser
import org.xmlpull.v1.XmlPullParser
import java.io.File

/** One `<include>` or `<exclude>` line of a backup ruleset. */
internal data class BackupRule(val domain: String, val path: String)

/**
 * IS THIS FILE OUTSIDE THE DEVICE BACKUP — read from the rules the build actually ships.
 *
 * Android's exclusion is declarative, so there is nothing to set at run time and the honest
 * answer is a reading. `allowBackup` is `true` on this app's generated manifest; what keeps the
 * mirror out is the INCLUDE-ONLY ruleset `plugins/backup-exclusions.js` writes, which names
 * `sharedpref` and nothing else. An arm that answered `allowBackup` would therefore report the
 * mirror as backed up on a build where it is not. This reads the ruleset instead, so widening it
 * with an `<include>` for a mail-bearing domain flips the answer — and the app's own sentence
 * with it. The manifest POINTER at these resources is the build-time half, asserted by
 * `test/backup-exclusions.test.ts`; their content is the half read here, on the device.
 */
internal object BackupRules {
  private const val DATA_EXTRACTION_RULES = "ohmail_data_extraction_rules"
  private const val FULL_BACKUP_RULES = "ohmail_backup_rules"

  fun isExcluded(context: Context, target: String): Boolean {
    if (target.isEmpty()) return false
    if (context.applicationInfo.flags and ApplicationInfo.FLAG_ALLOW_BACKUP == 0) return true
    val placed = place(context, target) ?: return false
    val rules = read(context) ?: return false
    return decide(rules.first, rules.second, placed.first, placed.second)
  }

  /**
   * The backup DOMAIN this file belongs to and its path within that domain, or null where no
   * domain names it — an unplaceable file is never reported as excluded, because nothing here
   * measured it.
   */
  internal fun place(context: Context, target: String): Pair<String, String>? {
    val file = try { File(target).canonicalFile } catch (_: Throwable) { File(target).absoluteFile }
    val candidates = listOf(
      "database" to context.getDatabasePath("probe.db").parentFile,
      "sharedpref" to File(context.applicationInfo.dataDir, "shared_prefs"),
      "file" to context.filesDir,
      "external" to context.getExternalFilesDir(null),
      "root" to File(context.applicationInfo.dataDir),
    )
    for ((domain, dir) in candidates) {
      val within = relative(dir, file) ?: continue
      return domain to within
    }
    return null
  }

  private fun relative(dir: File?, file: File): String? {
    if (dir == null) return null
    val root = try { dir.canonicalPath } catch (_: Throwable) { dir.absolutePath }
    val path = file.path
    if (path == root) return ""
    if (!path.startsWith("$root/")) return null
    return path.substring(root.length + 1)
  }

  /**
   * Android's own rule: an `<exclude>` wins; with at least one `<include>` present the ruleset is
   * include-only and everything it does not name is outside the backup; with none, everything is
   * inside it but the excludes.
   */
  internal fun decide(
    includes: List<BackupRule>,
    excludes: List<BackupRule>,
    domain: String,
    within: String,
  ): Boolean {
    if (excludes.any { it.domain == domain && covers(it.path, within) }) return true
    if (includes.isEmpty()) return false
    return includes.none { it.domain == domain && covers(it.path, within) }
  }

  internal fun covers(rulePath: String, within: String): Boolean {
    val p = rulePath.trim().trimEnd('/')
    if (p.isEmpty() || p == ".") return true
    return within == p || within.startsWith("$p/")
  }

  private fun read(context: Context): Pair<List<BackupRule>, List<BackupRule>>? {
    return try {
      val res = context.resources
      val pkg = context.packageName
      val id = res.getIdentifier(DATA_EXTRACTION_RULES, "xml", pkg).takeIf { it != 0 }
        ?: res.getIdentifier(FULL_BACKUP_RULES, "xml", pkg).takeIf { it != 0 }
        ?: return null
      parse(res.getXml(id))
    } catch (_: Throwable) {
      null
    }
  }

  /**
   * `<device-transfer>` is skipped: it governs a direct phone-to-phone handover, not the cloud
   * and computer backups the app's sentence is about, and folding it in would answer a different
   * question with the same word.
   */
  internal fun parse(parser: XmlResourceParser): Pair<List<BackupRule>, List<BackupRule>> {
    val includes = mutableListOf<BackupRule>()
    val excludes = mutableListOf<BackupRule>()
    var inTransfer = false
    var event = parser.eventType
    while (event != XmlPullParser.END_DOCUMENT) {
      if (event == XmlPullParser.START_TAG) {
        when (parser.name) {
          "device-transfer" -> inTransfer = true
          "include" -> if (!inTransfer) includes += rule(parser)
          "exclude" -> if (!inTransfer) excludes += rule(parser)
        }
      } else if (event == XmlPullParser.END_TAG && parser.name == "device-transfer") {
        inTransfer = false
      }
      event = parser.next()
    }
    parser.close()
    return includes to excludes
  }

  private fun rule(parser: XmlResourceParser): BackupRule = BackupRule(
    parser.getAttributeValue(null, "domain") ?: "",
    parser.getAttributeValue(null, "path") ?: "",
  )
}
