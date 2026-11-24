package app.ohmail.calendar

/**
 * AN EVENT'S WORDS AS ONE CLEAN LINE: the twin of the page's `cleanNoticeText` (`packages/client-engine`), held to
 * the same table (`packages/client-engine/test/notice-text-dropped.json`) on a JVM. White space becomes one space
 * between words; the control characters, the marks that turn the reading direction, the characters with no width
 * and half of a surrogate pair are dropped; the line is cut at [MOST] code points and never ends on a gap. A title
 * reaches a notice or a widget only through here. It imports nothing.
 */
internal object NoticeText {
  /** The longest title shown, in code points: the page's `NOTICE_TEXT_MAX`. */
  const val MOST = 80

  private fun isSpace(cp: Int): Boolean =
    cp == 0x20 || (cp in 0x09..0x0d) || cp == 0x85 || cp == 0xa0 || cp == 0x1680 || (cp in 0x2000..0x200a) ||
      cp == 0x2028 || cp == 0x2029 || cp == 0x202f || cp == 0x205f || cp == 0x3000

  private fun isDropped(cp: Int): Boolean =
    cp <= 0x1f || (cp in 0x7f..0x9f) ||
      cp == 0x61c || cp == 0x200e || cp == 0x200f || (cp in 0x202a..0x202e) || (cp in 0x2066..0x2069) ||
      cp == 0xad || cp == 0x180e || (cp in 0x200b..0x200d) || (cp in 0x2060..0x2064) || cp == 0xfeff ||
      cp == 0x34f || cp == 0x115f || cp == 0x1160 || cp == 0x3164 || cp == 0xffa0 || cp == 0x2800 ||
      (cp in 0xfe00..0xfe0f) || (cp in 0xe0000..0xe007f) || (cp in 0xe0100..0xe01ef) ||
      (cp in 0xd800..0xdfff)

  /** `raw` as one line of at most [MOST] code points, or null when nothing is left. */
  fun clean(raw: String): String? {
    val out = StringBuilder()
    var kept = 0
    var gap = false
    var i = 0
    while (i < raw.length) {
      val cp = raw.codePointAt(i)
      i += Character.charCount(cp)
      if (isSpace(cp)) { gap = kept > 0; continue }
      if (isDropped(cp)) continue
      val room = MOST - kept - (if (gap) 1 else 0)
      if (room < 1) break
      if (gap) { out.append(' '); kept += 1; gap = false }
      out.appendCodePoint(cp)
      kept += 1
    }
    return if (kept == 0) null else out.toString()
  }
}
