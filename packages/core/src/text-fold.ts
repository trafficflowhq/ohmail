/**
 * ONE FOLD FOR TEXT A SENDER WROTE AND A MATCHER COMPARES. Import-free, so a browser, a phone
 * bundle and a Node consumer all load it from source. `sensitive.ts` reads the invisible class,
 * the soft hyphen and the homoglyph table from here and keeps its own two-form split; the brand
 * check (`sender-check.ts`) reads {@link foldForMatch}. The tables are written as escapes or as
 * the lookalike letters themselves, never as invisible characters a reviewer cannot see.
 */

/**
 * Zero-width, bidi-override and other invisible format characters used to split a word. 200B
 * ZWSP, 200C ZWNJ, 200D ZWJ, 200E/200F LRM/RLM, 202A-202E bidi embedding/override, 2060-2064 word
 * joiner and invisible operators, 2066-2069 bidi isolates, FEFF BOM, 061C Arabic letter mark,
 * 180E Mongolian vowel separator.
 */
export const INVISIBLE_CLASS = "\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C\\u180E";
export const INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, "g");
export const SOFT_HYPHEN = /­/g;

/**
 * Homoglyph folding. NFKC handles full-width, mathematical-alphanumeric and circled forms; it
 * does NOT touch Cyrillic/Greek lookalikes or the Latin phonetic small capitals. Folding can only
 * ADD matches, never remove one, so a wrong entry costs precision and never safety.
 */
export const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic → Latin
  "а": "a", "б": "b", "в": "b", "г": "r", "д": "d", "е": "e", "ё": "e", "ж": "x", "з": "3",
  "и": "u", "й": "u", "к": "k", "л": "n", "м": "m", "н": "h", "о": "o", "п": "n", "р": "p",
  "с": "c", "т": "t", "у": "y", "ф": "o", "х": "x", "ц": "u", "ч": "y", "ш": "w", "щ": "w",
  "ъ": "b", "ы": "bi", "ь": "b", "э": "e", "ю": "o", "я": "r", "і": "i", "ї": "i", "ј": "j",
  "ѕ": "s", "ѐ": "e", "ӏ": "l", "ԁ": "d", "ԛ": "q", "ԝ": "w", "һ": "h", "ѵ": "v",
  // Greek → Latin
  "α": "a", "β": "b", "γ": "y", "δ": "d", "ε": "e", "ζ": "z", "η": "n", "θ": "o", "ι": "i",
  "κ": "k", "λ": "l", "μ": "u", "ν": "v", "ξ": "e", "ο": "o", "π": "n", "ρ": "p", "ς": "s",
  "σ": "o", "τ": "t", "υ": "y", "φ": "o", "χ": "x", "ψ": "w", "ω": "w",
  // Latin phonetic small capitals / letterlike residue NFKC leaves alone; U+0131 dotless i
  "ᴀ": "a", "ʙ": "b", "ᴄ": "c", "ᴅ": "d", "ᴇ": "e", "ꜰ": "f", "ғ": "f", "ɢ": "g", "ʜ": "h",
  "ɪ": "i", "ᴊ": "j", "ᴋ": "k", "ʟ": "l", "ᴍ": "m", "ɴ": "n", "ᴏ": "o", "ᴘ": "p", "ǫ": "q",
  "ʀ": "r", "ᴛ": "t", "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ʏ": "y", "ᴢ": "z", "ɩ": "i", "ɭ": "l",
  "ɿ": "r", "ʅ": "s", "ʞ": "k", "ǀ": "l", "ı": "i",
  // Armenian lookalikes that show up in real homoglyph attacks
  "օ": "o", "ո": "n", "ս": "u", "ա": "w", "գ": "q", "ђ": "h",
  // Roman-numeral and half/full-width residue
  "ⅼ": "l", "ⅰ": "i", "ⅴ": "v", "ⅹ": "x",
};
export const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "gu");

/**
 * The matcher's form: NFKC, invisibles and soft hyphens removed, lower case, combining marks
 * stripped, homoglyphs folded, whitespace collapsed. The marks are stripped from the canonical
 * DECOMPOSITION: after NFKC a precomposed letter carries no mark to strip, so `PöstFinance`
 * would keep its umlaut and miss the needle it imitates.
 */
export function foldForMatch(s: string): string {
  return s.normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(SOFT_HYPHEN, "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c)
    .replace(/\s+/g, " ")
    .trim();
}
