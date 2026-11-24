package app.ohmail.notices

/**
 * WHAT LEAVING A PAIRING CLOSES. A notice drawn for a pairing carries that pairing's local id as its tag, from the
 * wake's renderer and from the poster alike, so signing out or switching closes exactly what was drawn for anyone
 * but the pairing now kept. Of the notices this app shows, by tag and id, it chooses:
 *
 *  · every notice tagged with a pairing's id that is not the one kept now (with none kept, every such notice);
 *  · and, when the kept pairing changed, new mail's notice with no tag: one an earlier build drew belongs to nobody
 *    that can be named.
 *
 * Nothing else is chosen: the organizing notice and every notice not tagged by a pairing stay. It imports nothing and
 * keeps nothing; what is shown is handed in.
 */
internal object NoticeTakeBack {
  fun closing(shown: List<Pair<String?, Int>>, was: String?, now: String?): List<Pair<String?, Int>> {
    val changed = was != now
    return shown.filter { (tag, id) ->
      if (tag != null && LiveInstanceGate.isInstance(tag)) tag != now else tag == null && id == NoticePoster.NEW_MAIL_ID && changed
    }
  }
}
