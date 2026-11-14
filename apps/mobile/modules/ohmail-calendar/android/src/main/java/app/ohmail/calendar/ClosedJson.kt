package app.ohmail.calendar

/**
 * JSON, READ STRICTLY AND WRITTEN IN ONE FORM. What a page hands native and what native keeps in its file are read
 * here before anything holds them: one value and nothing after it, at most [MOST] characters and [DEPTH] levels, a
 * name at most once in an object, a string with its escapes and no raw control character. A number is read as the
 * page's own JSON reads it, as one double, so that a whole number means the same on both sides. Anything else is
 * no value at all. It imports nothing and keeps nothing.
 */
internal object ClosedJson {
  /** The longest text read: far past the largest record a page writes. */
  const val MOST = 262_144

  /** The deepest nesting read. */
  const val DEPTH = 12

  /** JSON's null, as a value: a Kotlin null is "nothing could be read". */
  object Null

  /** The value `text` holds, or null where it is not exactly one well-formed JSON value. */
  fun read(text: String): Any? {
    if (text.length > MOST) return null
    return try {
      val reader = Reader(text)
      val value = reader.value(0)
      reader.blank()
      if (reader.at != text.length) null else value
    } catch (e: Refused) {
      null
    }
  }

  /** `value` (a map, a list, a string, a whole number, a boolean or [Null]) in the one form native writes. */
  fun write(value: Any?): String = StringBuilder().also { put(it, value) }.toString()

  private fun put(out: StringBuilder, value: Any?) {
    when (value) {
      Null, null -> out.append("null")
      is Boolean -> out.append(if (value) "true" else "false")
      is Long -> out.append(value.toString())
      is Int -> out.append(value.toString())
      // A number as read: whole within a double's exact range, written as its digits; anything else is not written.
      is Double -> {
        if (value.isNaN() || value.isInfinite() || value != Math.floor(value) || Math.abs(value) > 9.007199254740991E15) {
          throw IllegalArgumentException("not a whole number this writer writes")
        }
        out.append(value.toLong().toString())
      }
      is String -> string(out, value)
      is List<*> -> {
        out.append('[')
        value.forEachIndexed { i, item -> if (i > 0) out.append(','); put(out, item) }
        out.append(']')
      }
      is Map<*, *> -> {
        out.append('{')
        var first = true
        for ((k, v) in value) {
          if (!first) out.append(',')
          first = false
          string(out, k as String)
          out.append(':')
          put(out, v)
        }
        out.append('}')
      }
      else -> throw IllegalArgumentException("not a value this writer writes")
    }
  }

  private fun string(out: StringBuilder, s: String) {
    out.append('"')
    for (c in s) {
      when {
        c == '"' -> out.append("\\\"")
        c == '\\' -> out.append("\\\\")
        c == '\n' -> out.append("\\n")
        c == '\r' -> out.append("\\r")
        c == '\t' -> out.append("\\t")
        c == '\b' -> out.append("\\b")
        c == '\u000c' -> out.append("\\f")
        c < ' ' -> out.append("\\u").append(String.format("%04x", c.code))
        else -> out.append(c)
      }
    }
    out.append('"')
  }

  private class Refused : RuntimeException() {
    override fun fillInStackTrace(): Throwable = this
  }

  private class Reader(private val text: String) {
    var at = 0

    fun blank() {
      while (at < text.length && (text[at] == ' ' || text[at] == '\t' || text[at] == '\n' || text[at] == '\r')) at += 1
    }

    fun value(depth: Int): Any {
      if (depth > DEPTH) throw Refused()
      blank()
      if (at >= text.length) throw Refused()
      return when (text[at]) {
        '{' -> obj(depth)
        '[' -> list(depth)
        '"' -> string()
        't' -> word("true", true)
        'f' -> word("false", false)
        'n' -> word("null", Null)
        else -> number()
      }
    }

    private fun word(w: String, v: Any): Any {
      if (!text.startsWith(w, at)) throw Refused()
      at += w.length
      return v
    }

    private fun obj(depth: Int): Map<String, Any> {
      at += 1
      val out = LinkedHashMap<String, Any>()
      blank()
      if (at < text.length && text[at] == '}') { at += 1; return out }
      while (true) {
        blank()
        if (at >= text.length || text[at] != '"') throw Refused()
        val name = string()
        if (out.containsKey(name)) throw Refused()
        blank()
        if (at >= text.length || text[at] != ':') throw Refused()
        at += 1
        out[name] = value(depth + 1)
        blank()
        if (at >= text.length) throw Refused()
        if (text[at] == ',') { at += 1; continue }
        if (text[at] == '}') { at += 1; return out }
        throw Refused()
      }
    }

    private fun list(depth: Int): List<Any> {
      at += 1
      val out = ArrayList<Any>()
      blank()
      if (at < text.length && text[at] == ']') { at += 1; return out }
      while (true) {
        out.add(value(depth + 1))
        blank()
        if (at >= text.length) throw Refused()
        if (text[at] == ',') { at += 1; continue }
        if (text[at] == ']') { at += 1; return out }
        throw Refused()
      }
    }

    fun string(): String {
      at += 1
      val out = StringBuilder()
      while (true) {
        if (at >= text.length) throw Refused()
        val c = text[at]
        at += 1
        when {
          c == '"' -> return out.toString()
          c < ' ' -> throw Refused()
          c != '\\' -> out.append(c)
          else -> {
            if (at >= text.length) throw Refused()
            val e = text[at]
            at += 1
            when (e) {
              '"' -> out.append('"')
              '\\' -> out.append('\\')
              '/' -> out.append('/')
              'b' -> out.append('\b')
              'f' -> out.append('\u000c')
              'n' -> out.append('\n')
              'r' -> out.append('\r')
              't' -> out.append('\t')
              'u' -> {
                if (at + 4 > text.length) throw Refused()
                var code = 0
                for (i in 0 until 4) {
                  val d = Character.digit(text[at + i], 16)
                  if (d < 0) throw Refused()
                  code = code * 16 + d
                }
                at += 4
                out.append(code.toChar())
              }
              else -> throw Refused()
            }
          }
        }
      }
    }

    /** JSON's number grammar, read as one double as a page's JSON reads it. */
    private fun number(): Double {
      val start = at
      if (at < text.length && text[at] == '-') at += 1
      if (at >= text.length) throw Refused()
      if (text[at] == '0') at += 1
      else if (text[at] in '1'..'9') { while (at < text.length && text[at] in '0'..'9') at += 1 }
      else throw Refused()
      if (at < text.length && text[at] == '.') {
        at += 1
        if (at >= text.length || text[at] !in '0'..'9') throw Refused()
        while (at < text.length && text[at] in '0'..'9') at += 1
      }
      if (at < text.length && (text[at] == 'e' || text[at] == 'E')) {
        at += 1
        if (at < text.length && (text[at] == '+' || text[at] == '-')) at += 1
        if (at >= text.length || text[at] !in '0'..'9') throw Refused()
        while (at < text.length && text[at] in '0'..'9') at += 1
      }
      val n = text.substring(start, at).toDouble()
      if (n.isNaN() || n.isInfinite()) throw Refused()
      return n
    }
  }
}
