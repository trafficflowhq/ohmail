import type { NormalizedMessage } from "./types.js";

/**
 * Sensitivity detection: the upstream half of "sensitive mail never reaches a model".
 * `flags.no_ai` is the ONLY barrier between an authentication mail and the model; every AI door
 * reads it. Three outcomes, not two: a finite phrase allowlist is authority for the POSITIVE
 * answer only; the negative requires reading every human-visible representation, in a held
 * vocabulary, nothing reversibly hidden — otherwise INDETERMINATE → `no_ai`. A corpus test caps
 * the seeded indeterminate rate at {@link SEEDED_INDETERMINATE_CEILING}. `no_ai`/`no_kb` fail
 * closed; `no_forward`/`priority` follow a positive only. Bodies are stored in full; redaction is
 * model-boundary only. Nothing here calls a model.
 */

export type SensitivityCategory = "otp" | "verification" | "password_reset" | "security_alert";

/**
 * The genuine third outcome. `sensitive` remains "positively identified", so routing, redaction
 * and `no_forward` keep their old meaning; `indeterminate` is "we cannot support the negative
 * claim", and it is the one that also sets `no_ai`.
 */
export type SensitivityVerdict = "sensitive" | "indeterminate" | "ordinary";

/** Why a message is indeterminate. In-process only — see the note on persistence below. */
export type IndeterminateReason =
  | "unsupported_script"
  | "unrecognised_language"
  | "credential_shape"
  | "auth_url_token"
  | "alternatives_disagree"
  | "obfuscated_text"
  | "encoded_block"
  | "nested_message"
  | "no_visible_text"
  | "scan_truncated";

export interface SensitivityResult {
  /** POSITIVE identification. Drives routing to INBOX, the sensitivity LABEL, `no_forward`, `priority`. */
  sensitive: boolean;
  verdict: SensitivityVerdict;
  category: SensitivityCategory | null;
  /**
   * Empty unless `verdict === "indeterminate"`. NOT PERSISTED: `messages` carries the four
   * flags and `sensitivity_category`, and no column records WHY a message was withheld, so the
   * production indeterminate rate is not measurable from the database today. Adding that column
   * needs a schema change and a migration, which belong to another workstream — recorded as owed.
   */
  reasons: IndeterminateReason[];
  flags: { no_ai: boolean; no_forward: boolean; no_kb: boolean; priority: boolean };
  /**
   * Body redaction is gone — the fields that carried it (`redactedTextBody`, `redactedHtmlBody`,
   * `storeRedactedBody`) are removed. The mail already sits unredacted on the IMAP server, the
   * master, so redacting the cloud/display copy only hid content from the mailbox's OWNER, and it
   * over-fired. The stored, served and displayed body is now the FULL original, always. What
   * remains is the disclosure gate to a MODEL: `flags.no_ai`/`no_kb` keep sensitive and
   * indeterminate mail out of automatic AI, and {@link redactForModel} / {@link
   * screenOutboundText} strip the credential VALUE from user-pressed AI payloads. {@link
   * redactSensitiveText} is used ONLY by the model gate, never by storage.
   */
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 1. SECURITY CANONICAL FORM — applied BEFORE any matching (the encoded-content case)
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Zero-width, bidi-override and other invisible format characters used to split a word. Written
 * as `\u` escapes and NEVER as the literal characters: a source file containing the invisible
 * characters it defends against is a file nobody can review, and a diff deleting one is invisible
 * too. 200B ZWSP, 200C ZWNJ, 200D ZWJ, 200E/200F LRM/RLM, 202A–202E bidi embedding/override,
 * 2060–2064 word joiner and invisible operators, 2066–2069 bidi isolates, FEFF BOM, 061C Arabic
 * letter mark, 180E Mongolian vowel separator.
 */
const INVISIBLE_CLASS = "\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C\\u180E";
const INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, "g");
const SOFT_HYPHEN = /\u00AD/g;
/** The obfuscation SHAPE: an invisible character wedged between two letters. */
const INVISIBLE_IN_WORD = new RegExp(`\\p{L}[${INVISIBLE_CLASS}]\\p{L}`, "u");

/**
 * Homoglyph folding. NFKC already handles full-width, mathematical-alphanumeric and circled
 * forms; it does NOT touch Cyrillic/Greek lookalikes or the Latin phonetic small-capital block,
 * which is exactly what `ᴠerification` and `раssword` are built from. Folding can only ADD
 * matches, never remove one, so a wrong entry here costs precision and never safety — and the
 * script census below runs on the UNFOLDED text so that folding Cyrillic to Latin cannot hide
 * the fact that the message was Cyrillic.
 */
const CONFUSABLES: Record<string, string> = {
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
  // Latin phonetic small capitals / letterlike residue NFKC leaves alone
  "ᴀ": "a", "ʙ": "b", "ᴄ": "c", "ᴅ": "d", "ᴇ": "e", "ꜰ": "f", "ғ": "f", "ɢ": "g", "ʜ": "h",
  "ɪ": "i", "ᴊ": "j", "ᴋ": "k", "ʟ": "l", "ᴍ": "m", "ɴ": "n", "ᴏ": "o", "ᴘ": "p", "ǫ": "q",
  "ʀ": "r", "ᴛ": "t", "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ʏ": "y", "ᴢ": "z", "ɩ": "i", "ɭ": "l",
  "ɿ": "r", "ʅ": "s", "ʞ": "k", "ǀ": "l",
  // Armenian lookalikes that show up in real homoglyph attacks
  "օ": "o", "ո": "n", "ս": "u", "ա": "w", "գ": "q", "ђ": "h",
  // Roman-numeral and half/full-width residue
  "ⅼ": "l", "ⅰ": "i", "ⅴ": "v", "ⅹ": "x",
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "gu");

/** A word containing letters from two different scripts — the classic homoglyph signal. */
const NON_LATIN_LETTER = /[^\P{L}\p{Script=Latin}]/u;
const NON_LATIN_LETTER_G = /[^\P{L}\p{Script=Latin}]/gu;
const LATIN_LETTER = /\p{Script=Latin}/u;

function hasMixedScriptWord(s: string): boolean {
  for (const word of s.split(/[^\p{L}]+/u)) {
    if (word.length < 2) continue;
    if (LATIN_LETTER.test(word) && NON_LATIN_LETTER.test(word)) return true;
  }
  return false;
}

interface Canonical {
  /**
   * NFKC + invisibles + soft hyphens removed, lowercased. Combining marks and non-Latin scripts
   * INTACT — this is what {@link WORLD_OTP} matches on.
   */
  plain: string;
  /**
   * `plain` with non-spacing marks removed and homoglyphs folded to Latin — what the
   * Latin-script vocabulary matches on.
   */
  folded: string;
  /**
   * `folded` with every Unicode decimal digit folded to its ASCII value. **The only form
   * the credential-SHAPE rules may read.**
   *
   * `[0-9]` matches no digit outside ASCII, so before this existed a body consisting only of
   * `٠١٢٣٤٥` was `ordinary` and would have been sent to a model, while `123456` was withheld.
   * Same family as the bare-code case — a real one-time code the patterns could not see.
   */
  numeric: string;
  /** Count of non-Latin letters in `plain`. */
  nonLatinLetters: number;
  obfuscated: boolean;
}

/**
 * TWO forms, and the split is not cosmetic. `folded` strips `\p{Mn}` so a combining mark wedged
 * into a word cannot break the Latin patterns — safe for the five in-scope languages (NFKC leaves
 * no residual mark in Latin text), DESTRUCTIVE for scripts where marks are letters: Thai loses
 * U+0E31/U+0E37 and stops being Thai, which is exactly how the corpus's Thai case failed. So the
 * non-Latin vocabulary matches against `plain` and only the Latin vocabulary against `folded`.
 * The script census also runs on `plain`, before folding, so folding Cyrillic to Latin can never
 * hide that the message was Cyrillic.
 */
const UNICODE_DIGIT = /\p{Nd}/gu;
const IS_UNICODE_DIGIT = /\p{Nd}/u;

/**
 * Every Unicode decimal digit folded to its ASCII value; everything else untouched. `Number("٠")`
 * is `NaN`, but `Nd` blocks are contiguous runs of ten, so a digit's value is its offset within
 * its own decade: count ALL contiguous `Nd` predecessors and take `% 10`. The walk must not be
 * capped — the Mathematical Alphanumeric digits are five codepoint-adjacent decades and Chakma is
 * another, so a capped back-walk reports the neighbour's offset. An exhaustive test enumerates
 * every `Nd` codepoint, groups contiguous runs, asserts each decade folds to `0123456789` (76
 * decades across 71 runs today) and asserts `foldDigits(ascii) === ascii`. The ASCII fast path is
 * performance only — without it every date and price pays a run of regex probes.
 */
function digitToAscii(c: string): string {
  const cp = c.codePointAt(0)!;
  if (cp <= 0x39) return c;                      // ASCII digits are already their own value
  let n = 0;
  while (IS_UNICODE_DIGIT.test(String.fromCodePoint(cp - n - 1))) n++;
  return String(n % 10);
}

export function foldDigits(s: string): string {
  return s.replace(UNICODE_DIGIT, digitToAscii);
}

function canonicalise(raw: string): Canonical {
  const nfkc = raw.normalize("NFKC");
  const obfuscated = INVISIBLE_IN_WORD.test(nfkc) || hasMixedScriptWord(nfkc);
  const plain = nfkc
    .replace(INVISIBLE, "")
    .replace(SOFT_HYPHEN, "")
    .toLowerCase();
  const folded = plain.replace(/\p{Mn}/gu, "").replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c);
  // Derived from `folded`, NEVER folded into `plain`/`folded` themselves: `nonLatinLetters`
  // and the non-Latin vocabulary run on `plain`, and the Thai corpus case is the standing proof
  // that applying a fold one layer too early destroys a script.
  const numeric = foldDigits(folded);
  return {
    plain, folded, numeric,
    nonLatinLetters: (plain.match(NON_LATIN_LETTER_G) ?? []).length,
    obfuscated,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 2. HTML → HUMAN-VISIBLE TEXT (the HTML-only case)
 * ════════════════════════════════════════════════════════════════════════════════════════ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "", zwnj: "", zwj: "",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"',
  eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", uuml: "ü", ouml: "ö", auml: "ä",
  szlig: "ß", ntilde: "ñ", oacute: "ó", iacute: "í", aacute: "á", uacute: "ú",
};

/**
 * Entity decoding is not cosmetic: `&#118;erification` and `&#x76;erification` are an evasion
 * class of their own, and a `&#116;oken=` in an href hides the token shape.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]{1,10});/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  try { return String.fromCodePoint(n); } catch { return ""; }
}

/**
 * Extract every human-visible string an HTML part carries, plus the two places a credential
 * actually hides: `href`/`src` targets and `alt`/`title` text. The HTML-only case's bearer URL lives in an
 * `href`, so a text-only extraction that dropped attributes would still have missed it.
 *
 * Deliberately a scanner and not a parser. It runs on adversarial input for a security decision,
 * so the failure mode has to be "extracted too much" rather than "threw, or trusted a tag
 * structure the sender controls". `<script>`/`<style>`/`<head>` are dropped because their content
 * is not what the user reads, and everything else becomes whitespace-separated text.
 */
function visibleTextFromHtml(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const attrs: string[] = [];
  const attrRe = /\b(href|src|alt|title|aria-label|data-url)\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(stripped)) !== null) {
    const v = m[3] ?? m[4] ?? m[5] ?? "";
    if (v) attrs.push(v);
    if (attrs.length > 2_000) break;   // bounded: a hostile part must not make this quadratic
  }
  const text = stripped.replace(/<[^>]*>/g, " ");
  return decodeEntities(`${text}\n${attrs.join("\n")}`).replace(/[ \t ]+/g, " ");
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 3. REVERSIBLE ENCODINGS, DECODED LOCALLY (the encoded-content case)
 * ════════════════════════════════════════════════════════════════════════════════════════ */

const CTE_MARKER = /content-transfer-encoding\s*:\s*(base64|quoted-printable)/i;
const B64_RUN = /[A-Za-z0-9+/]{16,}={0,2}/g;
const QP_HEX = /=[0-9A-Fa-f]{2}/;

const MAX_DECODED_BLOCKS = 8;
const MAX_DECODED_CHARS = 16_384;

/**
 * U+FFFD REPLACEMENT CHARACTER, as an escape and never the literal glyph — the same rule
 * {@link INVISIBLE_CLASS} is written under, for the same reason: a file that contains the
 * characters it defends against is a file nobody can review, and a diff that deletes one is
 * invisible in a diff too.
 */
const REPLACEMENT_CHAR = "\uFFFD";

/**
 * Mostly-printable text, i.e. worth scanning rather than random bytes. `Buffer.from(run,
 * "base64").toString("utf8")` never fails — it SUBSTITUTES U+FFFD for invalid sequences, and
 * U+FFFD counted as printable, so pure noise decoded as "printable": a tracking token became
 * mixed-script confetti, read as homoglyphs, `obfuscated_text` → `no_ai`. Measured: of 371 held
 * representatives flagged `obfuscated_text`, 350 stopped being flagged once base64-shaped runs
 * were removed — roughly 95% of the signal was manufactured here. A rejection, not a
 * re-weighting: genuinely encoded text decodes with ZERO replacement characters. The DECLARED
 * `Content-Transfer-Encoding:` arm still reports `encoded_block` — untouched.
 */
function looksLikeText(s: string): boolean {
  if (s.length < 8) return false;
  // U+FFFD is the decoder telling us it did not understand these bytes. `toString("utf8")`
  // substitutes rather than throwing, so this is the only place that report survives.
  if (s.includes(REPLACEMENT_CHAR)) return false;
  let printable = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127)) printable++;
  }
  return printable / [...s].length >= 0.9 && /[\p{L}]{3}/u.test(s);
}

/**
 * Decode the reversible encodings that survive INSIDE a body — a quoted raw-source block, a
 * forwarded inner part — and hand the plaintext back as further representations to scan.
 * Top-level `Content-Transfer-Encoding` is already decoded by `mime.ts`; this is the nested case.
 * Bounded and local, and a block that will not decode is not dropped silently: with a literal
 * `Content-Transfer-Encoding:` line present, an undecodable payload is `encoded_block` —
 * indeterminate. The `CTE_MARKER` requirement on the suspicious arm keeps a DKIM signature or
 * tracking token out; the opportunistic arm needs none because {@link looksLikeText} rejects
 * garbage — true only since it learned to reject replacement characters.
 */
function decodeEmbedded(text: string): { decoded: string[]; undecodable: boolean } {
  const decoded: string[] = [];
  let undecodable = false;
  let budget = MAX_DECODED_CHARS;

  if (QP_HEX.test(text) || /=\r?\n/.test(text)) {
    const qp = text
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => safeCodePoint(parseInt(h, 16)));
    if (qp !== text && looksLikeText(qp)) decoded.push(qp.slice(0, budget));
  }

  const declared = CTE_MARKER.test(text);
  let blocks = 0;
  for (const run of text.match(B64_RUN) ?? []) {
    if (blocks >= MAX_DECODED_BLOCKS || budget <= 0) break;
    blocks++;
    let out = "";
    try {
      out = Buffer.from(run, "base64").toString("utf8");
    } catch {
      out = "";
    }
    if (looksLikeText(out)) {
      const take = out.slice(0, budget);
      decoded.push(take);
      budget -= take.length;
    } else if (declared && run.length >= 24) {
      // A block the sender labelled as an encoded transfer, which we cannot read. That is
      // precisely the case we must not call "ordinary".
      undecodable = true;
    }
  }
  return { decoded, undecodable };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 3b. WHAT THE VOCABULARY IS ALLOWED TO READ
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * A maximal run of the characters URLs and base64 are built from. Whitespace, `?`, `&`, `<`, `>`,
 * quotes and brackets all end a run, so this is a single unbroken machine-ish stretch and never a
 * sentence.
 */
const TOKEN_RUN = /[A-Za-z0-9._~+/=%:-]+/g;

/**
 * The screw. A stretch of ≥8 alphanumerics carrying BOTH letters and digits is not a word in any
 * language — it is an identifier, a hash or an encoded blob.
 *
 * Length alone would have been the wrong test, and so would "is it inside a URL". `https://acme.
 * example/verification-code/start` is 44 characters of URL and every one of its segments is
 * readable, so it stays readable. `u001.rFcAmKXLOmVjZ0Qb7HsN9pTkW3xY-2Fa` has a 32-character
 * segment mixing letters and digits, so it does not.
 */
const MACHINE_SEGMENT = /[A-Za-z0-9]{8,}/g;

function isMachineToken(run: string): boolean {
  MACHINE_SEGMENT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MACHINE_SEGMENT.exec(run)) !== null) {
    if (/[0-9]/.test(m[0]) && /[A-Za-z]/.test(m[0])) return true;
  }
  return false;
}

/**
 * Authentication vocabulary is read from WORDS; a machine token is not words. Click trackers
 * percent-escape `/` to `-2F`, and `-` is not `\w`, so the three characters `2Fa` sit between
 * word boundaries and matched the standalone `2fa` acronym — a newsletter classified by an
 * accident of its tracking token. Only {@link categoryOf} reads through this mask; the shape
 * rules, the auth-URL rule, the language probe, the script census and redaction read unmasked
 * text, so this can only REMOVE a positive. It cannot create one: runs become spaces of the SAME
 * LENGTH, nothing apart is brought together, no `\b` moves. A phrase cannot be smuggled through —
 * every multi-word entry contains a space, a run contains none.
 */
function proseOnly(s: string): string {
  return s.replace(TOKEN_RUN, (run) => (isMachineToken(run) ? " ".repeat(run.length) : run));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 4. THE POSITIVE VOCABULARY
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/** The qualifiers that turn the very common word "code" into a credential. */
const CODE_QUALIFIER =
  "one[-\\s]?time|single[-\\s]?use|verification|verify|confirmation|confirm|security|" +
  "authentication|auth|sign[-\\s]?in|signin|log[-\\s]?in|login|access|recovery|backup|" +
  "activation|pass|otp|2fa|two[-\\s]?factor";

/**
 * The noun a qualifier may attach to. Two things are deliberately NOT in it, both caught by the
 * corpus: `word` — `pass` is itself a qualifier, so `(pass)?(code|word)` matches `password`
 * outright, silently reclassifying every `password_reset` as `otp`; "one-time password" has its
 * own arm where the qualifier cannot be `pass`. And `number` — "your order confirmation number"
 * is ordinary receipt mail; it is admitted only after qualifiers that cannot mean anything else
 * (see {@link OTP} arm 2, the bare-code case's `482913 is your verification number`).
 */
const CODE_NOUN = "(pass)?code";

/**
 * A CREDENTIAL code, in any of the shapes providers actually send.
 *
 * `code` alone is never enough — "discount code", "promo code" and "area code" are ordinary
 * mail. Every arm carries a second authentication-specific token.
 */
/**
 * A bare code, deliberately WITHOUT the mixed-alphanumeric shape.
 *
 * `SPRING20`, `SAVE10` and `AB1234` are a promo code, a promo code and a flight number, and all
 * three appear in the negative corpus. Admitting `[A-Z0-9]{6,10}` here would withhold AI from
 * every marketing mail in the mailbox — which is how a fail-closed boundary quietly becomes an
 * off switch. The digit-run and grouped shapes carry the risk that is worth taking.
 */
const BARE_CODE = "\\d{4,8}|\\d{3,4}[-\\s]\\d{3,4}";

const OTP = new RegExp(
  [
    // "your sign-in code", "one-time passcode", "verification code", "2FA code"…
    `\\b(${CODE_QUALIFIER})[-\\s]?${CODE_NOUN}\\b`,
    // The bare-code case: "482913 is your verification number" — only the qualifiers that cannot mean an
    // order reference are allowed to reach `number`.
    `\\b(verification|authentication|one[-\\s]?time|single[-\\s]?use|otp|2fa|two[-\\s]?factor)[-\\s]?number\\b`,
    // "your code to sign in", "code to log in", "code to verify your account"
    `\\bcode\\s+(to|for)\\s+(sign|log)[-\\s]?in\\b`,
    // DIGIT-ANCHORED. "Your code is 482913" must be `sensitive`, not merely withheld. The digits
    // ARE the qualifier: article, code-noun, copula, digits, NOTHING between them — so "your code
    // is ready" cannot match, and an intervening word ("your sort code is 401726", "your order
    // code is 4821") falls through to the shape layer and is withheld rather than redacted and
    // rerouted. Accepted residue: a brand-inserted template ("Your Uber code is 482913") also
    // falls through — withheld from AI, stored in clear; chasing it would mean admitting an
    // arbitrary word between noun and copula, which is where the commerce family lives.
    `\\b(your|the|ihr|dein|votre|ton|il\\s+tuo|tuo|tu|el)\\s+${CODE_NOUN}\\s+(is|lautet|ist|est|è|es)[\\s:]*\\**(${BARE_CODE})\\b`,
    `\\bcode\\s+(to|for)\\s+(verify|confirm|access|authenticate)\\b`,
    // "use 482913 to sign in" / "enter 991122 to log in" — the code carries its own purpose.
    `\\b(use|enter|type)\\s+\\**[0-9A-Z-]{4,10}\\**\\s+to\\s+(sign|log)[-\\s]?in\\b`,
    // Unambiguous on its own — these NAME THE CREDENTIAL ITSELF. "Here is the passcode you asked
    // for" carries one; there is no reading of `passcode` or `one-time password` that is merely a
    // topic. The four SCHEME names that used to sit in this arm — `otp`, `2fa`, `two-factor`,
    // `multi-factor` — do have such a reading, and they moved to {@link schemeNameNearCode}.
    `\\b(one[-\\s]?time (pass)?(code|word)|passcode)\\b`,
    // The bare-code case: `Your PIN`. Bare lowercase "pin" is "pin the tab" and is excluded; a framed PIN,
    // a PIN with a noun, and the uppercase acronym are all credentials.
    `\\b(your|the|a|new|temporary|one[-\\s]?time|single[-\\s]?use|security|access|secret)\\s+pin\\b`,
    `\\bpin[-\\s]?(code|number)\\b|\\bcode\\s+pin\\b`,
    // A password that was ISSUED to you, as opposed to one you choose (that is RESET).
    `\\b(temporary|provisional|initial|one[-\\s]?time|single[-\\s]?use)\\s+(pass)?word\\b`,
    // de / fr / it / es provider vocabulary.
    `\\b(einmal(pass)?code|best[äa]tigungscode|sicherheitscode|anmeldecode|verifizierungscode|zugangscode|verifikationscode)\\b`,
    // NOTE the `(?!\\w)` terminators rather than `\\b`: JavaScript's `\\b` is defined on
    // `[A-Za-z0-9_]`, so it does NOT fire after an accented letter — `code de sécurité` at end
    // of line failed to match for exactly that reason, which is the kind of bug a
    // five-language detector exists to have caught once and never again.
    `\\bcode\\s+(de\\s+)?(v[ée]rification|s[ée]curit[ée]|connexion|confirmation|acc[èe]s|authentification)(?!\\w)`,
    `\\bcode\\s+([àa]\\s+usage\\s+unique|unique|secret)(?!\\w)`,
    `\\bcodice\\s+(di\\s+)?(verifica|sicurezza|accesso|conferma|autenticazione|monouso)(?!\\w)`,
    `\\bc[óo]digo\\s+(de\\s+)?(verificaci[óo]n|seguridad|acceso|confirmaci[óo]n|autenticaci[óo]n|[úu]nico)(?!\\w)`,
  ].join("|"),
  "i",
);

/** The uppercase acronym, which a case-insensitive `\bpin\b` could not have without eating "pin it". */
const PIN_ACRONYM = /\bPIN\b/;

/** Password RESET / change flows — the mail that carries the keys to the account. */
const RESET = new RegExp(
  [
    `\\b(reset|change|update|choose|create|set)\\s+(your\\s+|a\\s+|the\\s+)?(new\\s+)?password\\b`,
    `\\bpassword\\s+(reset|change|recovery|assistance)\\b`,
    `\\b(forgot|forgotten)\\s+(your\\s+)?password\\b`,
    `\\breset\\s+request\\b`,
    `\\bpasswort\\s+(zur[üu]cksetzen|[äa]ndern)\\b|\\bpasswort[-\\s]?(zur[üu]cksetzung|wiederherstellung)\\b`,
    `\\b(r[ée]initialis\\w*|modifier|changer)\\s+(votre\\s+|le\\s+|un\\s+)?mot\\s+de\\s+passe\\b`,
    `\\b(reimposta\\w*|modifica\\w*|reimpostazione)\\s+(la\\s+)?password\\b`,
    `\\b(restablece\\w*|cambia\\w*|restablecimiento)\\s+(tu\\s+|la\\s+)?contrase[ñn]a\\b`,
  ].join("|"),
  "i",
);

/**
 * VERIFICATION and passwordless links — the "click this and you are logged in" class.
 *
 * A link that authenticates is exactly as sensitive as a code that authenticates, and it is the
 * one an AI summary is most likely to helpfully repeat. `sign in` is only matched next to
 * `link`, or after an explicit `click`/`tap`/`follow` on the same line, so "sign in to see your
 * statement" stays ordinary mail.
 */
const VERIFY = new RegExp(
  [
    `\\b(verify|confirm)\\s+(your|this)\\s+(e-?mail|account|address|identity|phone|number)\\b`,
    `\\b(verification|confirmation|activation)\\s+link\\b`,
    `\\bmagic\\s+link\\b|\\bpasswordless\\b|\\bone[-\\s]?click\\s+(sign|log)[-\\s]?in\\b`,
    `\\b(sign[-\\s]?in|signin|log[-\\s]?in|login)\\s+link\\b`,
    `\\blink\\s+to\\s+(sign|log)[-\\s]?in\\b`,
    `\\b(click|tap|follow|use)\\b[^.\\n]{0,60}?\\bto\\s+(sign|log)[-\\s]?in\\b`,
    `\\b(best[äa]tigen\\s+sie\\s+ihre|e-?mail[-\\s]?best[äa]tigung|anmeldelink|best[äa]tigungslink)\\b`,
    `\\b(lien\\s+de\\s+(connexion|v[ée]rification|confirmation)|confirmez\\s+votre)\\b`,
    `\\b(link\\s+di\\s+(accesso|verifica|conferma)|conferma\\s+il\\s+tuo)\\b`,
    `\\b(enlace\\s+de\\s+(acceso|verificaci[óo]n|confirmaci[óo]n)|confirma\\s+tu)\\b`,
  ].join("|"),
  "i",
);

/** Security ALERTS — not credentials themselves, but never material for a model either. */
const ALERT = new RegExp(
  [
    `\\bnew\\s+(sign[-\\s]?in|signin|log[-\\s]?in|login|device)\\b`,
    `\\b(sign[-\\s]?in|log[-\\s]?in|login)\\s+(attempt|alert|notification|from)\\b`,
    `\\bunusual\\s+(sign[-\\s]?in|log[-\\s]?in|activity|access)\\b`,
    `\\b(security|account)\\s+alert\\b|\\bsuspicious\\s+(activity|sign[-\\s]?in|login)\\b`,
    `\\b(was\\s+this\\s+you|verify\\s+it'?s\\s+you|did\\s+you\\s+(just\\s+)?(sign|log)\\s?in)\\b`,
    `\\b(neue[rs]?\\s+anmeldung|sicherheitswarnung|ungew[öo]hnliche\\s+aktivit[äa]t)\\b`,
    `\\b(nouvelle\\s+connexion|alerte\\s+de\\s+s[ée]curit[ée]|activit[ée]\\s+inhabituelle)\\b`,
    `\\b(nuovo\\s+accesso|avviso\\s+di\\s+sicurezza|attivit[àa]\\s+insolita)\\b`,
    `\\b(nuevo\\s+inicio\\s+de\\s+sesi[óo]n|alerta\\s+de\\s+seguridad|actividad\\s+inusual)\\b`,
    // pt — a Portuguese sign-in alert carries no code for a numeric backstop to catch, so the
    // NEGATIVE answer has to be denied by vocabulary or it reaches the model as ordinary mail.
    `\\b(novo\\s+in[íi]cio\\s+de\\s+sess[ãa]o|novo\\s+(acesso|dispositivo|in[íi]cio\\s+de\\s+sess[ãa]o)|alerta\\s+de\\s+seguran[çc]a|atividade\\s+(incomum|suspeita)|foi\\s+voc[êe]\\b)\\b`,
  ].join("|"),
  "i",
);

/**
 * Non-Latin and remaining-Latin authentication vocabulary, matched against the UNFOLDED canonical
 * form — folding Cyrillic and Greek to Latin would destroy these. Japanese, Chinese, Korean,
 * Arabic, Hebrew, Cyrillic, Greek, Thai and Hindi are covered; the Latin-script remainder
 * (Turkish, Portuguese, Dutch, Polish, Scandinavian, Finnish, Czech, Romanian, Hungarian,
 * Indonesian, Vietnamese) is here because rule 2's function-word probe is leaky for languages
 * close to the five we hold. The list makes those messages POSITIVE — redacted, routed to the
 * user — rather than merely withheld. It is not a completeness claim: rules 1–8 are the boundary.
 */
const WORLD_OTP = new RegExp(
  [
    // Japanese
    "認証コード", "確認コード", "認証番号", "確認番号", "ワンタイムパスワード", "ワンタイムコード",
    "セキュリティコード", "ログインコード", "二段階認証", "二要素認証", "本人確認", "パスワードの再設定",
    "パスワードのリセット", "パスワードを変更", "サインインリンク", "ログインリンク",
    // Chinese (simplified + traditional)
    "验证码", "驗證碼", "校验码", "校驗碼", "动态密码", "動態密碼", "一次性密码", "一次性密碼",
    "安全码", "安全碼", "登录码", "登入碼", "短信验证码", "手机验证码", "重置密码", "重設密碼",
    "修改密码", "密码重置", "登录验证", "登入驗證",
    // Korean
    "인증번호", "인증 ?코드", "확인 ?코드", "보안 ?코드", "로그인 ?코드", "일회용 ?비밀번호",
    "비밀번호 ?재설정", "비밀번호 ?찾기",
    // Cyrillic (ru / uk)
    "код подтверждения", "проверочный код", "код безопасности", "код доступа", "одноразовый код",
    "одноразовый пароль", "код для входа", "сброс пароля", "восстановление пароля",
    "смена пароля", "код авторизации", "код підтвердження", "одноразовий код",
    // Arabic
    "رمز التحقق", "رمز التأكيد", "رمز الأمان", "رمز الدخول", "رمز الدخول لمرة واحدة",
    "كلمة المرور المؤقتة", "إعادة تعيين كلمة المرور", "رمز لمرة واحدة",
    // Hebrew
    "קוד אימות", "קוד אבטחה", "קוד התחברות", "איפוס סיסמה", "סיסמה חד[- ]?פעמית",
    // Greek
    "κωδικ[όο]ς επαλ[ήη]θευσης", "κωδικ[όο]ς ασφαλε[ίι]ας", "κωδικ[όο]ς σ[ύυ]νδεσης",
    "επαναφορ[άα] κωδικο[ύυ]", "κωδικ[όο]ς μ[ίι]ας χρ[ήη]σης",
    // Thai / Hindi
    "รหัสยืนยัน", "รหัสความปลอดภัย", "รหัสผ่านชั่วคราว", "सत्यापन कोड", "ओटीपी", "सुरक्षा कोड",
    // Latin-script remainder
    "do[ğg]rulama kodu", "g[üu]venlik kodu", "giri[şs] kodu", "[şs]ifre s[ıi]f[ıi]rlama", "tek kullan[ıi]ml[ıi]k",
    "c[óo]digo de verifica[çc][ãa]o", "c[óo]digo de seguran[çc]a", "senha tempor[áa]ria",
    "redefinir (a )?senha", "alterar (a )?senha", "palavra-passe",
    "verificatiecode", "beveiligingscode", "inlogcode", "bevestigingscode", "eenmalige code",
    "wachtwoord (herstellen|wijzigen|opnieuw instellen)",
    "kod weryfikacyjny", "kod bezpiecze[ńn]stwa", "kod logowania", "has[łl]o jednorazowe",
    "zresetuj has[łl]o", "resetowanie has[łl]a",
    "verifieringskod", "s[äa]kerhetskod", "inloggningskod", "eng[åa]ngskod", "[åa]terst[äa]ll l[öo]senord",
    "bekr[æa]ftelseskode", "adgangskode", "engangskode", "verifiseringskode", "tilbakestill passord",
    "vahvistuskoodi", "kertak[äa]ytt[öo]koodi", "turvakoodi", "salasanan palautus",
    "verifika[čc]n[íi] k[óo]d", "ov[ěe][řr]ovac[íi] k[óo]d", "bezpe[čc]nostn[íi] k[óo]d",
    "jednor[áa]zov[ýy] k[óo]d", "obnovit heslo",
    "cod de verificare", "cod de securitate", "resetare parol[ăa]",
    "ellen[őo]rz[őo] k[óo]d", "biztons[áa]gi k[óo]d", "jelsz[óo][- ]?visszaáll[íi]t[áa]s",
    "kode verifikasi", "kode keamanan", "kata sandi sekali pakai", "atur ulang kata sandi",
    "m[ãa] x[áa]c minh", "m[ãa] x[áa]c th[ự]?c", "m[ãa] b[ảa]o m[ậa]t", "[đd][ặa]t l[ạa]i m[ậa]t kh[ẩa]u",
    "m[ậa]t kh[ẩa]u m[ộo]t l[ầa]n",
  ].join("|"),
  "i",
);

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 5. CREDENTIAL SHAPES WITH NO FRAMING (the bare-code and HTML-only cases)
 * ════════════════════════════════════════════════════════════════════════════════════════ */

// `BARE_CODE` is declared above `OTP`, which now uses it.

/** An imperative that turns a nearby bare number into something you are meant to type in. */
const CODE_CUE =
  "enter|type|input|paste|use|key\\s+in|eingeben|geben\\s+sie|saisissez|entrez|tapez|" +
  "inserisci|digita|introduce|ingresa|escribe";

/** Framing that follows the token instead of preceding it. */
/**
 * The share-prohibition subset, split out because it is the ONLY part of the trailer
 * vocabulary that is genuinely position-independent in real mail.
 *
 * "Do not share 482913" has no ordinary-commerce reading. The rest of the trailer set does:
 * reversing `is\s+your` matches *"here **is your** invoice **22910**"* and the whole
 * `here is your X NNNN` family, and reversing `expires? in` / `valid for` matches
 * *"offer valid for 2026"* — every marketing mail with a year within 24 characters. That is
 * exactly the false-positive shape, and it is why the position-independent-everything version is FORBIDDEN.
 */
const CODE_PROHIBITION =
  "do\\s+not\\s+share|don'?t\\s+share|never\\s+share|nicht\\s+weitergeben|" +
  "ne\\s+(le\\s+)?partagez|non\\s+condividere|no\\s+compartas";

const CODE_TRAILER =
  "is\\s+your|expires?\\s+in|expires?\\s+at|valid\\s+for|" + CODE_PROHIBITION;

/**
 * Four arms, and the third is shaped tightly. Measured on a realistic OTP set, most reached the
 * model: "Your code is 482913" matched neither old arm — `CODE_CUE` wants an imperative before
 * the code, `CODE_TRAILER` a phrase after it — and near-misses were held only by exact
 * vocabulary, so the nonsense-qualifier tests ("your flurm code is 482913") make the shape
 * backstop structural. Arm 3's copula-or-colon must sit immediately before the digits — the
 * precision screw keeping commerce out: "your order code 4821 is ready", "the invoice number is
 * 22910", "code 500 error" and "barcode is 48213" are all asserted `ordinary`.
 */
const UNFRAMED_CODE = new RegExp(
  [
    `\\b(${CODE_CUE})\\b[^\\n]{0,24}?\\b(${BARE_CODE})\\b`,
    `\\b(${BARE_CODE})\\b[^\\n]{0,24}?\\b(${CODE_TRAILER})\\b`,
    // Arm 3 — noun, then a MANDATORY copula-or-colon, then the digits, adjacently.
    `\\b(${CODE_NOUN}|codice|c[óo]digo)\\s*(is|lautet|ist|est|è|es|:)[\\s:]*\\**(${BARE_CODE})\\b`,
    // Arm 4 — the prohibition subset only, in EITHER position.
    `\\b(${CODE_PROHIBITION})\\b[^\\n]{0,24}?\\b(${BARE_CODE})\\b`,
  ].join("|"),
  "i",
);

/**
 * A representation that is NOTHING BUT a token: a digit run, a split digit run, or a MIXED
 * alphanumeric token. Read against `canonical.numeric`, never `raw` — `[0-9]` matches no digit
 * outside ASCII, so a body of only `٠١٢٣٤٥` was `ordinary`. The third alternative was once
 * `[A-Za-z0-9]{6,10}` and matched words: 25 of 30 ordinary one-word subjects — fail-closed, so
 * precision not safety, but `screenOutboundText` JOINS its parts, so a one-word body was refused
 * at the sink too. What the MIXED narrowing releases: a single pure-alpha 6–10 character unframed
 * token, and a single 9–10 digit run (OTPs are 4–8). Providers FRAME codes — if one ever ships a
 * pure-alpha unframed code, the fix is vocabulary or framing, never re-widening onto words.
 */
const TOKEN_ONLY =
  /^[\s*]*([0-9]{4,8}|[0-9]{3,4}[-\s][0-9]{3,4}|(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{6,10})[\s*.]*$/;

/**
 * 5b. The language-independent numeric backstop. `UNFRAMED_CODE` and `TOKEN_ONLY` fire only on
 * English-recognised framing or a token-only body; `Ihre TAN lautet 481920.` and `Ihr Code: 44 12
 * 90` were both `ordinary`. What survives translation is SHAPE: a credential-noun cue within a
 * short window of a bare 4–8-digit run, landing in fail-closed `credential_shape`. A CUE, not "a
 * short message with a number": broader shapes broke the 5% indeterminate ceiling — a CREDENTIAL
 * NOUN discriminates, a possessive does not, and "code" is admitted only when not
 * commerce-qualified. The digit run excludes #-orders, prices, ISO dates, years, and runs inside
 * longer numbers or tokens.
 */

/** How close (chars) a credential-noun cue must sit to a code-shaped run for the backstop to fire. */
const CODE_PROXIMITY = 40;

/**
 * Commerce words that turn the generic noun "code" into an order reference rather than a
 * credential. `order code 4821` is the seeded canary; `tracking code`, `promo code`, `area code`
 * are the rest of the family.
 */
const COMMERCE_QUALIFIER =
  "order|tracking|track|promo|promotional|promotion|discount|coupon|voucher|gift|referral|" +
  "refer|area|zip|postal|dialling|dialing|country|bar|product|store|shop|redemption|redeem|" +
  "reward|rewards|loyalty|membership|booking|reservation|reference|invoice|quote";
const COMMERCE_BEFORE = new RegExp(`\\b(?:${COMMERCE_QUALIFIER})\\s+\\w*$`, "i");

/**
 * Credential nouns with NO commerce reading, matched as SUBSTRINGS because in the wild they arrive
 * as compounds — einmalKENNWORT, sicherheitsSCHLÜSSEL, toegangsCODE — and a boundaried match would
 * miss the very compound that carries them. Each is distinctive enough that appearing inside an
 * ordinary word is not a real risk.
 */
const CRED_NOUN_SUBSTR =
  /kennwort|passwort|passphrase|passcode|wachtwoord|schl[üu]ssel|geheimzahl|geheimnummer|geheimcode|toegangscode|inlogcode|zugangscode|anmeldecode|jednorazow|tek\s+seferlik|tek\s+kullan/iu;

/**
 * The generic code / password / OTP family across languages, matched with a word boundary (so
 * "barcode", "unicode", "qr code" fragments do not) and then rejected when a commerce qualifier
 * sits immediately before it.
 */
// `[oó]` and a trailing `\w*` because agglutinative and accented languages inflect the noun:
// Hungarian `kódja`, Romanian `codul`, Turkish `kodunuz`, Finnish `salasanasi` all carry a
// suffix, and `kód`/`código` carry an accented `o` that is not an ASCII `o`.
const CRED_NOUN_GENERIC =
  /\b(k[oó]d\w*|c[oó]d\w*|password\w*|senha\w*|contrase[ñn]a\w*|parola\w*|l[öo]senord\w*|salasana\w*|heslo\w*|has[łl]o\w*|[şs]ifre\w*|adgangskode\w*|otp|mfa|2fa)\b/giu;

/** German banking acronym, read from RAW so the lowercased "tan" (suntan) cannot masquerade as it. */
const TAN_ACRONYM = /\bTANs?\b/;

/** A bare 4–8 digit run that is not part of a longer number, a price, a #-order-no, or a currency. */
const BARE_LOOSE_RUN = /(?<![\p{L}\d#€$£])\d{4,8}(?![.,]?\d)/gu;
/** A spaced/dashed group of 2–4-digit chunks — the `44 12 90` shape. */
const GROUPED_LOOSE_RUN = /(?<![\p{L}\d#+])\d{2,4}(?:[ -]\d{2,4}){1,3}(?!\d)/gu;
/** An ISO-ish date wearing the grouped-run shape (`2026-08-30`, `2026 08 30`): not a code. */
const GROUPED_ISO_DATE = /^\d{4}[- ]\d{2}[- ]\d{2}$/;
/** A four-digit year, the one bare-run shape that collides with a real code. */
const FOUR_DIGIT_YEAR = /^(19|20)\d{2}$/;

/** Is there a credential-noun cue in this (windowed) text? */
function hasCredentialCue(numeric: string, raw: string): boolean {
  if (CRED_NOUN_SUBSTR.test(numeric)) return true;
  if (TAN_ACRONYM.test(raw)) return true;
  CRED_NOUN_GENERIC.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CRED_NOUN_GENERIC.exec(numeric)) !== null) {
    const before = numeric.slice(Math.max(0, m.index - 24), m.index);
    if (!COMMERCE_BEFORE.test(before)) return true;
  }
  return false;
}

/** The [start,end) of every code-shaped digit run in `numeric`, dates / years / prices excluded. */
function codeRunSpans(numeric: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  BARE_LOOSE_RUN.lastIndex = 0;
  while ((m = BARE_LOOSE_RUN.exec(numeric)) !== null) {
    if (m[0].length === 4 && FOUR_DIGIT_YEAR.test(m[0])) continue;
    spans.push([m.index, m.index + m[0].length]);
  }
  GROUPED_LOOSE_RUN.lastIndex = 0;
  while ((m = GROUPED_LOOSE_RUN.exec(numeric)) !== null) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 4 || digits.length > 8) continue;   // phone / tracking numbers are longer
    if (GROUPED_ISO_DATE.test(m[0])) continue;
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/**
 * The language-independent backstop, read from `numeric` (so a non-ASCII code counts) with `raw` only for the
 * case-sensitive `TAN` acronym. Fires when a credential-noun cue sits within {@link CODE_PROXIMITY}
 * of a code-shaped run. Shared by both call sites through {@link credentialShapeIn}.
 */
function looseNumericCode(numeric: string, raw: string): boolean {
  for (const [start, end] of codeRunSpans(numeric)) {
    const window = numeric.slice(Math.max(0, start - CODE_PROXIMITY), end + CODE_PROXIMITY);
    if (hasCredentialCue(window, raw)) return true;
  }
  return false;
}

/**
 * The name of a scheme is not a credential: `otp`, `2fa`, `two-factor`, `multi-factor`. These sat
 * in {@link OTP}'s standalone arm, so any message containing the word was `sensitive` — but they
 * name a METHOD people write to each other about: vendor announcements and newsletters. A seventh
 * of one store's `otp` verdicts rested on these words alone. The word now needs a code-shaped run
 * within {@link CODE_PROXIMITY} — same {@link codeRunSpans} exclusions, same {@link proseOnly}
 * mask — and `Your OTP is 482913` stays positive. Safe because {@link CRED_NOUN_GENERIC} carries
 * `otp|mfa|2fa`, so a scheme name near a code already raised `credential_shape` via {@link
 * looseNumericCode}; with no code present, neither layer fires.
 */
const SCHEME_NAME = /\b(otp|2fa|two[-\s]?factor|multi[-\s]?factor)\b/gi;

function schemeNameNearCode(numeric: string): boolean {
  // The acronym test FIRST and the span scan second. `categoryOf` is the hot path — it runs for
  // every representation of every message, and now for every model payload through
  // `screenOutboundText` too — while {@link codeRunSpans} walks the whole text with two global
  // regexes. Almost no message names one of these four schemes, so the cheap test is the one
  // that should decide. `SCHEME_NAME` is global, hence the reset before each use.
  SCHEME_NAME.lastIndex = 0;
  if (!SCHEME_NAME.test(numeric)) return false;
  const spans = codeRunSpans(numeric);
  if (spans.length === 0) return false;
  SCHEME_NAME.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCHEME_NAME.exec(numeric)) !== null) {
    const from = m.index - CODE_PROXIMITY;
    const to = m.index + m[0].length + CODE_PROXIMITY;
    for (const [start, end] of spans) if (start <= to && end >= from) return true;
  }
  return false;
}

/**
 * The two-clause credential-shape test, in ONE place because it has two call sites with
 * deliberately different semantics: `classifySensitivity` asks it per REPRESENTATION, and
 * `screenOutboundText` asks it of the JOINED payload about to be serialised for a model. The defect
 * was present at both, and a fix applied to one would have left the other refusing ordinary snippets.
 */
function credentialShapeIn(rep: Representation): boolean {
  // Both rules read `numeric`, and neither reads `raw` any more. `TOKEN_ONLY` used to read
  // `rep.raw.trim()`, so no non-ASCII digit could match `[0-9]` and a body of only `٠١٢٣٤٥` came
  // out `ordinary`. Moving off `raw` loses nothing: alt3's character class covers both cases, the
  // pattern's own anchors absorb the missing trim, and NFKC plus invisible-character stripping
  // now catches a zero-width-spaced code. The numeric backstop is the third term; because this
  // predicate is the one the two call sites share, `screenOutboundText` inherits it for free. The
  // backstop reads the PROSE-MASKED form, like {@link categoryOf}: a tracking token encoding
  // `-2Fa` carries the acronym `2fa`, and unmasked that cue would pair with an unrelated digit
  // run and withhold an ordinary newsletter. Same-length spaces preserve proximity; pure digit
  // codes survive the mask.
  return UNFRAMED_CODE.test(rep.canonical.numeric)
    || TOKEN_ONLY.test(rep.canonical.numeric)
    || looseNumericCode(proseOnly(rep.canonical.numeric), proseOnly(rep.raw));
}

/**
 * An authentication-shaped URL carrying an opaque token — the HTML-only case's plain part with no HTML to
 * explain it, and every magic link whose surrounding words we did not recognise.
 *
 * BOTH halves are required, and that is what keeps newsletter click-tracking out of it: an
 * `/issues/42` or `/u/1234` link has no authentication marker, and a `/verify` page link with no
 * token is a page, not a credential.
 */
const AUTH_URL_MARKER = new RegExp(
  "https?://[^\\s<>\"')\\]]*(?:" +
    "/(?:session|sessions|login|log-in|signin|sign-in|auth|authorize|authorise|authenticate|" +
    "verify|verification|confirm|confirmation|activate|activation|magic|passwordless|" +
    "reset|recover|recovery|token|otp|2fa|mfa|invite|invitation|onetime|one-time)\\b" +
    "|[?&](?:t|tk|token|code|key|otp|auth|session|sso|magic|nonce|secret|access_token|id_token|" +
    "confirmation_token|reset_token|verification_token|login_token|auth_token|invitation_token)=" +
  // THE TAIL, CAPTURED. Everything after the marker and nothing before it — see `hasAuthUrlToken`.
  ")([^\\s<>\"')\\]]*)",
  "gi",
);
/**
 * ONE candidate value out of a URL tail — a run between the separators that delimit path segments
 * and query values. `/` and `=` and `&` and `?` are the delimiters, so they are NOT in the class:
 * a token is a single value, and a run that spans them is a sentence of URL, not a secret.
 */
const TOKEN_SEGMENT = /[A-Za-z0-9_\-.~+%]+/g;
/**
 * The REDACTION pattern, used only by {@link redactAuthUrls} — deliberately broader than
 * {@link looksLikeOpaqueToken} and deliberately not shared with it.
 *
 * Detection and redaction want opposite errors. Detection decides whether a message is withheld
 * from a model and stored redacted, so over-matching costs the user a feature (it cost 31% of one
 * account's Screener). Redaction runs only on a message ALREADY judged to carry a credential, and
 * its only error is blanking a few characters of a URL nobody will read. Broad is correct there.
 */
const OPAQUE_TOKEN = /[A-Za-z0-9_\-.~+/=%]{12,}/;
/**
 * The shape of a secret rather than of a word: long, AND carrying what words in URLs do not — a
 * digit or a case change. A DIGIT OR ANY UPPERCASE LETTER, not "mixed case": the corpus pins
 * `…/session?t=SECRET-LOGIN-TOKEN`, an all-caps bearer token with no digit, which a mixed-case
 * test let reach the model — the exact hole this rule closes. The weaker test fails CLOSED:
 * `confirmation-page` and `manage-preferences` stay ordinary because URL prose is lower-case,
 * while `SECRET-LOGIN-TOKEN`, `8f3a9b2c1d4e5f6a` and `eyJhbGciOiJIUzI1NiIs` are all withheld. The
 * residue: a ≥16-character camel-cased path segment reads as a token — far narrower than the
 * marker alone sufficing.
 */
const TOKEN_MIN = 16;
function looksLikeOpaqueToken(seg: string): boolean {
  if (seg.length < TOKEN_MIN) return false;
  return /[\dA-Z]/.test(seg);
}

/**
 * The token is looked for AFTER the marker — that is the whole of this function. It once sliced
 * at the first `/`, `?` or `&` anywhere, which for any `https://…` URL is the scheme's own `/`,
 * so the search included the HOSTNAME: `OPAQUE_TOKEN`'s alphabet holds `.` and `/`, every
 * hostname satisfied the token half, and the predicate degenerated to "does this URL contain an
 * auth-shaped word" — flagging every `/login` or `?code=` link in ordinary mail. The fix searches
 * the CAPTURED TAIL: `/verify` alone is a page; `/verify?token=<32 opaque characters>` is a
 * credential. Deliberately left: a genuine token under an unlisted path (`/click/<token>`) still
 * passes — a separate tightening.
 */
function hasAuthUrlToken(s: string): boolean {
  AUTH_URL_MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AUTH_URL_MARKER.exec(s)) !== null) {
    const tail = m[1] ?? "";
    for (const seg of tail.match(TOKEN_SEGMENT) ?? []) {
      if (looksLikeOpaqueToken(seg)) return true;
    }
  }
  return false;
}

/**
 * A link in a document is not a credential delivered. {@link hasAuthUrlToken} stays broad for the
 * SINK; it is the wrong question for the indeterminate arm, which withholds the whole message — a
 * footer login link or an unsubscribe token was enough. A URL is a credential DELIVERY when the
 * token is the operative payload: a NAMED query parameter ({@link AUTH_STRONG_PARAM}), the
 * segment after a delivery-path marker ({@link AUTH_DELIVERY_PATH}), or a link-dominated message
 * ({@link AUTH_LOW_PROSE}); {@link AUTH_UTILITY_URL} and {@link inQuotedReply} links never are.
 * The sink still screens the exact bytes leaving; every genuine fixture stays withheld; both
 * forced mutations fail.
 */
// Each endpoint word names an action that is NOT a login. `derefer` is an archive's
// link-dereference wrapper (the SAME static token rides every message from one sender — it is the
// archive's key, not the reader's); `notification(s)`, `profile[_-]photo`, `user_profile`,
// `log_view` and `/inbox` are an application's own settings, avatar and click-tracking links;
// `download_file` is a file-download link. None appears in a genuine
// magic-link/reset/verify/activate/invite URL, so adding them only ever over-withholds less.
const AUTH_UTILITY_URL =
  /unsubscribe|unsub\b|mailing[_-]?preferences|manage[_-]?preferences|\/preferences\b|\bpreferences\b|\/subscriptions?\b|\/manage\b|attachments?|opt[_-]?out|list-manage|derefer|notifications?|profile[_-]?photo|user_profile|log_view|\/inbox\b|download[_-]?file/i;
const AUTH_STRONG_PARAM =
  /[?&](?:token|code|key|otp|magic|nonce|secret|access_token|id_token|[a-z]+_token)=([A-Za-z0-9_\-.~+%]+)/gi;
const AUTH_DELIVERY_PATH =
  /\/(?:auth|authorize|authorise|authenticate|verify|verification|confirm|confirmation|activate|activation|reset|recover|recovery|magic|passwordless|invite|invitation|onetime|one-time|token|otp|2fa|mfa)\b/i;
const REPLY_QUOTE_HEADER =
  /-----\s*(?:Original|Ursprüngliche|Weitergeleitete)|^\s*(?:Am|On|Le)\b.{0,80}?(?:schrieb|wrote|a écrit)\s*:|\bwrote:\s*$|\bschrieb:\s*$|^\s*\*?(?:Von|From|Gesendet|Sent)\s*:/im;
/** Prose word count under which a message is short/link-dominated — a delivery, not a document. */
const AUTH_LOW_PROSE = 40;

/** Does this ONE url deliver a credential (as opposed to linking to a page or a utility action)? */
function urlDeliversCredential(url: string): boolean {
  if (AUTH_UTILITY_URL.test(url)) return false;
  AUTH_STRONG_PARAM.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AUTH_STRONG_PARAM.exec(url)) !== null) {
    if (looksLikeOpaqueToken(m[1] ?? "")) return true;
  }
  return AUTH_DELIVERY_PATH.test(url);
}

/** Is the character at `idx` inside quoted-reply content — a `>` line or below a reply header? */
function inQuotedReply(s: string, idx: number): boolean {
  const lineStart = s.lastIndexOf("\n", Math.max(0, idx - 1)) + 1;
  if (/^\s*>/.test(s.slice(lineStart, idx))) return true;
  return REPLY_QUOTE_HEADER.test(s.slice(Math.max(0, idx - 600), idx));
}

/**
 * The GATED predicate for the indeterminate arm — {@link hasAuthUrlToken}'s token search exactly,
 * then keep only the credential deliveries. `lowProse` is a whole-message property, so it is
 * computed once by the caller and passed in.
 */
function authCredentialUrlIn(s: string, lowProse: boolean): boolean {
  AUTH_URL_MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AUTH_URL_MARKER.exec(s)) !== null) {
    const tail = m[1] ?? "";
    let hasToken = false;
    for (const seg of tail.match(TOKEN_SEGMENT) ?? []) {
      if (looksLikeOpaqueToken(seg)) { hasToken = true; break; }
    }
    if (!hasToken) continue;
    if (inQuotedReply(s, m.index)) continue;
    const run = /https?:\/\/[^\s<>"')\]]+/.exec(s.slice(m.index));
    const url = run ? run[0] : s.slice(m.index, m.index + m[0].length);
    if (urlDeliversCredential(url) || lowProse) return true;
  }
  return false;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 6. THE LANGUAGE PROBE
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Function words of the five languages whose vocabulary above is deep. Their ABSENCE from a
 * substantial Latin-script message is evidence that we are reading a language we do not hold —
 * so the negative answer is not ours to give.
 *
 * Leaky by construction for close neighbours: Dutch and Portuguese share `de`, `en`, `que`,
 * `no`. That is stated rather than papered over; {@link WORLD_OTP} covers their authentication
 * nouns and the credential-shape rules are language-independent.
 */
const STOPWORDS = new Set([
  // en
  "the", "and", "you", "your", "for", "with", "this", "that", "from", "have", "are", "is", "was",
  "will", "not", "but", "our", "please", "thanks", "thank", "we", "to", "of", "in", "on", "it",
  "at", "be", "as", "by", "if", "or", "all", "can", "has", "been", "would", "about", "when",
  // de
  "der", "die", "das", "und", "sie", "ihr", "ihre", "für", "mit", "nicht", "ist", "sind", "wir",
  "haben", "wird", "auf", "ein", "eine", "den", "dem", "zu", "von", "bitte", "danke", "sich",
  // fr
  "le", "la", "les", "et", "vous", "votre", "pour", "avec", "ne", "pas", "est", "sont", "nous",
  "avez", "sur", "un", "une", "des", "du", "de", "que", "qui", "merci", "dans",
  // it
  "il", "lo", "tu", "tuo", "tua", "per", "con", "non", "è", "noi", "abbiamo", "su", "della",
  "del", "che", "grazie", "nel", "sono",
  // es
  "el", "los", "las", "su", "para", "no", "es", "hemos", "sobre", "gracias", "en", "tus",
]);
const LANG_PROBE_MIN_WORDS = 12;

/** ≥ this many non-Latin letters and no positive match ⇒ we do not claim to have read it. */
const UNSUPPORTED_SCRIPT_MIN = 4;

/** Per-representation scan bound. Exceeding it is `scan_truncated`, not a silent short read. */
const SCAN_CAP_CHARS = 128_000;

/** The measured ceiling the seeded-corpus guard holds this design to. */
export const SEEDED_INDETERMINATE_CEILING = 0.05;

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 7. REDACTION
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * A credential-looking token: 4–8 digits, or a 6–10 char UPPER alphanumeric, or a grouped code
 * (`123-456`, `ABC 123`) — the shapes providers use to make a code easy to read back.
 *
 * Only ever applied to mail already judged sensitive, so its breadth costs nothing on ordinary
 * mail. Redaction is best-effort defence in depth and CANNOT rescue a false negative: the flags
 * are what actually keep the message away from the model.
 */
/**
 * The second branch cannot use `\b`. A vocabulary-framed Arabic-Indic code (`رمز التحقق ٠١٢٣٤٥`)
 * classified `sensitive` and still left its code unredacted in the model payload: every
 * alternative above is ASCII-only, and `\b` is defined against `[A-Za-z0-9_]` even under `u`, so
 * `\b(\p{Nd}{4,8})\b` matches NOTHING on a pure Arabic-digit run — measured, a guard reporting
 * success while doing nothing. The boundary is explicit lookarounds instead. The ASCII
 * alternatives keep their original `\b` verbatim; the new branch is purely ADDITIVE — wholesale
 * replacement would silently regress redaction (`é123456` matches `\b`, not the lookaround);
 * verified byte-identical on twelve ASCII cases.
 */
const CODE =
  /\b([0-9]{4,8}|[A-Z0-9]{6,10}|[0-9]{3,4}[-\s][0-9]{3,4}|[A-Z0-9]{3,4}[-\s][A-Z0-9]{3,4})\b|(?<![\p{L}\p{Nd}_])(\p{Nd}{4,8}|\p{Nd}{3,4}[-\s]\p{Nd}{3,4})(?![\p{L}\p{Nd}_])/gu;

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 7a. THE SHORT ONE-TIME CODE — the shapes {@link CODE} and {@link B64_RUN} both step over
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * 7a. The screen usually fires on the SUBJECT's vocabulary, and the redactor is then handed a
 * snippet whose credential is in a form no pass reaches: `482913` base64-encoded is `NDgyOTEz`,
 * half of {@link B64_RUN}'s floor, so `redacted: true` described a transform that removed
 * nothing. Measured on already-flagged payloads: base64, percent-escaped, HTML-entity, mixed-case
 * and lower-hex values all left intact. Not a lower floor — that blanks every six-letter word.
 * Instead: an ENCODED run is DECODED AND LOOKED AT ({@link looksLikeCredentialValue} rejects
 * `Q29uZmlybQ`→`Confirm`); a PLAIN token needs the {@link CODE} shape plus the FRAME (the shared
 * credential-noun lexicon).
 */

/** Latin vowels including the accented ones, and `y`, which carries a syllable in Welsh and in `rhythm`. */
const VOWEL = /[aeiouyàáâãäåèéêëìíîïòóôõöùúûüýÿ]/i;

/**
 * A word has vowels; a randomly drawn code usually does not. `bcpq`, `tsrn`, `KMXQR` are codes;
 * `Confirm`, `ready`, `hello` are not.
 *
 * The threshold is deliberately harsh (**under a quarter**), because German prose is vowel-poor in
 * exactly this range — `nicht` is 1-in-5 and `schritt` is 1-in-7 — and this predicate is only ever
 * consulted in a position a word can occupy. It is therefore paired with {@link STOPWORDS}
 * everywhere it is used, and never used on its own to decide an unframed token.
 */
function looksUnpronounceable(token: string): boolean {
  const letters = token.replace(/[^\p{L}]/gu, "");
  if (letters.length < 4) return false;
  let vowels = 0;
  for (const ch of letters) if (VOWEL.test(ch)) vowels++;
  return vowels / letters.length < 0.25;
}

/**
 * The shape a one-time code occupies: one 4–12 run, or 2–4 hyphen-joined groups of 3–6
 * (`482-913`, `bcp-qts`). A SPACE IS NOT A GROUP SEPARATOR — it was for an hour and the corpus
 * caught it twice in one run: `hello world` satisfied the grouped arm as two five-character
 * groups and a whole German sentence as four, so the standalone-line rule blanked the line. The
 * space-grouped digit shape providers really use (`448 213`) is not lost: {@link CODE} has
 * carried `[0-9]{3,4}[-\s][0-9]{3,4}` since before any of this, and it runs first.
 */
// THE GROUPED ALTERNATIVE COMES FIRST, and that ordering is load-bearing wherever this source is
// used UNANCHORED. Alternation is ordered, so with the single run first, `bcpq-tsrn-mxvl` matched
// `bcpq`, the terminator `(?![-A-Za-z0-9_])` was satisfied by the hyphen, and the payload left as
// `[REDACTED]-tsrn-mxvl` — a PARTIALLY redacted secret, which is the failure mode
// {@link redactSensitiveText}'s ordering comment already names as worse than none. The hyphen is
// in the terminator for the same reason: a run of five groups now matches nothing rather than its
// first four.
const VALUE_SHAPE_SRC = "[A-Za-z0-9]{3,6}(?:-[A-Za-z0-9]{3,6}){1,3}|[A-Za-z0-9]{4,12}";
const VALUE_SHAPE = new RegExp(`^(?:${VALUE_SHAPE_SRC})$`);

/**
 * Is this string a credential VALUE rather than a word?
 *
 * Two arms, and the first carries almost all of the traffic. **A digit inside the run** is the
 * discriminator that separates `a3F9kQ`, `a3f9c1`, `482913` and `bcp-1ts` from every word in every
 * language this product reads — prose does not put digits inside words. The second arm is for the
 * letters-only draws (`KMXQR`, `bcpq-tsrn-mxvl`): unpronounceable AND not a function word, and it
 * is only ever reached from a FRAMED position, never from open text.
 */
function looksLikeCredentialValue(token: string): boolean {
  if (!VALUE_SHAPE.test(token)) return false;
  const compact = token.replace(/[- ]/g, "");
  if (/[0-9]/.test(compact)) return true;
  // A Capitalised word is a NAME, not a code. Measured: `Schmidt` alone on the signature line of a
  // verification mail is 1 vowel in 7 and was blanked. Providers draw codes in one case —
  // `bcpqtsrn`, `KMXQR` — so refusing the `Xxxxx` shape costs the letters-only arm nothing.
  if (/^\p{Lu}\p{Ll}+$/u.test(compact)) return false;
  return looksUnpronounceable(compact) && !STOPWORDS.has(compact.toLowerCase());
}

/**
 * A short base64 run, BELOW {@link B64_RUN}'s floor — where a real one-time code lives.
 *
 * Six characters is the floor because four bytes (`1234`) encode to six plus padding, and four
 * digits is the shortest PIN {@link CODE} recognises. The ceiling is fifteen so this pass and
 * {@link B64_RUN} partition the space instead of overlapping: sixteen and up is already blanked
 * unconditionally, and that rule is untouched — it exists for a different reason (a run that long
 * is machine text whatever it decodes to) and keeps its floor.
 */
const SHORT_B64_RUN = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{6,15}={0,2}(?![A-Za-z0-9+/=])/g;
/** Percent escapes, four or more: `%34%38%32%39%31%33`. Matched by no pass at all before this. */
const PCT_ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2}){4,}/g;
/** Numeric HTML entities, decimal or hex, four or more: `&#52;&#56;…` / `&#x34;&#x38;…`. */
const ENTITY_RUN = /(?:&#(?:[Xx][0-9A-Fa-f]{1,6}|[0-9]{1,7});){4,}/g;

/**
 * Decode one candidate run and answer whether it was carrying a credential.
 *
 * `Buffer.from(…, "base64")` SUBSTITUTES U+FFFD rather than throwing on bytes that are not UTF-8
 * — the measurement {@link looksLikeText} was written under — so the replacement character is the
 * decoder telling us the run was never base64 in the first place. {@link VALUE_SHAPE} then rejects
 * anything that is not ASCII alphanumeric, which is every accidental decode that survives.
 */
function decodesToCredential(decode: () => string): boolean {
  let plain: string;
  try { plain = decode(); } catch { return false; }
  if (!plain || plain.includes(REPLACEMENT_CHAR)) return false;
  return looksLikeCredentialValue(plain.trim());
}

/**
 * Does `text` carry a credential in one of the SHORT reversible encodings {@link
 * redactShortEncodedRuns} can remove? Separate from the redactor because {@link redactForModel}
 * returns text UNCHANGED once {@link screenOutboundText} answers `safe` — so the short-encoding
 * passes were reachable only when another signal had already failed the screen, and could do
 * nothing about their motivating case: a generically framed message whose only sensitive content
 * IS the encoded run. The same three regexes and the same {@link decodesToCredential} test asked
 * as a question — one set of patterns, two consumers, so screen and redactor cannot disagree.
 * Deliberately LAST: decoding is the expensive arm.
 */
function hasShortEncodedCredential(text: string): boolean {
  const decoders: Array<[RegExp, (run: string) => string]> = [
    [SHORT_B64_RUN, (run) => Buffer.from(run, "base64").toString("utf8")],
    [PCT_ESCAPE_RUN, (run) => decodeURIComponent(run)],
    [ENTITY_RUN, (run) => decodeEntities(run)],
  ];
  for (const [re, decode] of decoders) {
    // `lastIndex` is reset because these are module-level /g regexes shared with the redactor;
    // a leftover offset from a previous caller would silently start the scan mid-string.
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (decodesToCredential(() => decode(m[0]))) return true;
    }
  }
  return false;
}

function redactShortEncodedRuns(text: string): string {
  return text
    .replace(SHORT_B64_RUN, (run) =>
      decodesToCredential(() => Buffer.from(run, "base64").toString("utf8")) ? "[REDACTED]" : run)
    .replace(PCT_ESCAPE_RUN, (run) =>
      decodesToCredential(() => decodeURIComponent(run)) ? "[REDACTED]" : run)
    .replace(ENTITY_RUN, (run) =>
      decodesToCredential(() => decodeEntities(run)) ? "[REDACTED]" : run);
}

/**
 * A 4–12 character run carrying BOTH a letter and a digit — `a3F9kQ`, `a3f9c1`, `q3wvsxca`.
 *
 * Unconditional within a code-framed payload, and that is a strictly SMALLER step than the one
 * {@link CODE} already takes: its `[A-Z0-9]{6,10}` arm blanks `NEWSLETTER` and `REMINDER`, which
 * are words, while nothing here matches a word at all. The residue is version-shaped tokens —
 * `SHA256`, `iPhone15` — blanked inside an authentication mail, which is the trade
 * {@link OPAQUE_TOKEN}'s docblock already prices for URL tails.
 */
const MIXED_ALNUM_TOKEN =
  /(?<![A-Za-z0-9_])(?=[A-Za-z0-9]{4,12}(?![A-Za-z0-9_]))(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{4,12}/g;

/**
 * The value sitting DIRECTLY after a credential noun: `code: bcp-qts`, `Ihr Code lautet …`,
 * `codice di verifica: …`. The noun list is {@link CRED_NOUN_SUBSTR} and {@link
 * CRED_NOUN_GENERIC} spliced in by `.source` — the same lexicon the classifier's numeric backstop
 * reads, so a locale added there is added here and there is no second list to forget. Adjacency
 * is what makes the letters-only arm of {@link looksLikeCredentialValue} safe to consult: `Your
 * code is ready` puts `ready` in this position and `ready` is pronounceable, `nicht` is a {@link
 * STOPWORDS} entry, and `one-time` precedes the noun rather than following it.
 */
// NAMED groups, because {@link CRED_NOUN_GENERIC} carries a capturing group of its own and
// splicing its `.source` in therefore shifts every positional index by one. Read positionally,
// this rule handed `looksLikeCredentialValue` the matched NOUN instead of the value after it and
// redacted nothing — a pass that ran, matched, and did no work.
// The separator between the noun and the value: an optional copula, an optional colon, optional
// emphasis asterisks, each with bounded whitespace around it. **BOUNDED and not `[ \t]*`**, because
// four consecutive unbounded star groups backtrack polynomially on a long run of spaces that ends in
// no match — a subject is not length-capped the way `bodySnippet`'s 200 characters are, and this
// runs on sender-controlled bytes. Eight is generous enough for the aligned `Code:     482913`
// layout templates produce.
const CUE_GAP = "[ \\t]{0,8}(?:(?:is|ist|lautet|est|è|es|sind|são)[ \\t]{0,8})?"
  + "(?:[:=][ \\t]{0,8})?\\*{0,2}[ \\t]{0,8}";
const CUE_ADJACENT_VALUE = new RegExp(
  `(?<cue>(?:${CRED_NOUN_SUBSTR.source}|${CRED_NOUN_GENERIC.source})${CUE_GAP})`
  + `(?<val>${VALUE_SHAPE_SRC})(?![-A-Za-z0-9_])`,
  "giu",
);

/**
 * The colon rule, forced by a transport fact. `Here is the code you need: KMXQR` puts four words
 * between noun and value, so {@link CUE_ADJACENT_VALUE} misses it, and a standalone-line rule
 * would be correct and dead: `bodySnippet` collapses all whitespace before any model payload is
 * built, so no line stands alone. What survives the collapse is the COLON: a value directly after
 * one, with a credential cue within {@link CODE_PROXIMITY} — the same {@link hasCredentialCue}
 * the numeric backstop uses, commerce rejection included, so `order code: 4821` is excluded here
 * exactly as there. The colon keeps this from being "any word near the word code": `Your code is
 * ready` has none.
 */
const COLON_FRAMED_VALUE = new RegExp(`:[ \\t]{0,8}\\*{0,2}[ \\t]{0,8}(${VALUE_SHAPE_SRC})(?![-A-Za-z0-9_])`, "gu");

/**
 * A token standing ALONE on its line — the way a provider presents a code in the BODY, and a
 * position ordinary prose does not occupy. Leading/trailing markup and punctuation are peeled
 * first, because a plain-text rendering of a bold HTML code arrives as `**bcpq-tsrn**`.
 *
 * Kept even though the collapse above means the live Screener payload never contains a newline:
 * `redactForModel` is exported, the snippet's shape is `pipeline.ts`'s decision rather than this
 * module's, and a rule that costs nothing is the wrong thing to remove on the strength of another
 * file's current behaviour.
 */
const STANDALONE_TRIM = /^[\s*_>#|-]+|[\s*_.,:;!|-]+$/g;

function redactFramedCodes(text: string): string {
  const afterLines = text.split("\n").map((line) => {
    const core = line.replace(STANDALONE_TRIM, "");
    if (!core || !looksLikeCredentialValue(core)) return line;
    return line.replace(core, "[REDACTED]");
  }).join("\n");
  const afterCue = afterLines.replace(CUE_ADJACENT_VALUE, (whole: string, ...rest: unknown[]) => {
    const groups = rest[rest.length - 1] as Record<string, string | undefined> | undefined;
    const cue = groups?.cue ?? "";
    const val = groups?.val ?? "";
    return val && looksLikeCredentialValue(val) ? `${cue}[REDACTED]` : whole;
  });
  // `afterCue`, not `afterLines` — the offset a `replace` callback is handed indexes the string
  // being replaced, and the pass above can change its length. Reading the proximity window out of
  // the pre-pass string would slide it by however many characters the cue rule removed.
  const afterColon = afterCue.replace(COLON_FRAMED_VALUE, (whole: string, val: string, at: number) => {
    if (!looksLikeCredentialValue(val)) return whole;
    const window = afterCue.slice(Math.max(0, at - CODE_PROXIMITY), at + 1);
    return hasCredentialCue(window, window) ? whole.replace(val, "[REDACTED]") : whole;
  });
  return afterColon.replace(MIXED_ALNUM_TOKEN, "[REDACTED]");
}

/**
 * Run `f` over everything that is NOT inside a URL.
 *
 * {@link redactUrlTails} owns URLs and deliberately KEEPS THE HOST — an ESP host like
 * `url1234.example.tv` is the
 * single most useful routing signal in a payload and it is not a secret. `url1234` is also a
 * letter-and-digit run, so without this the host rule and the token rule would contradict each
 * other and the newer one would win.
 */
function outsideUrls(text: string, f: (s: string) => string): string {
  URL_RUN.lastIndex = 0;
  const out: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RUN.exec(text)) !== null) {
    out.push(f(text.slice(last, m.index)), m[0]);
    last = m.index + m[0].length;
  }
  out.push(f(text.slice(last)));
  return out.join("");
}

/**
 * Does the screen's own verdict say a CODE is expected in this payload? The gate for the
 * plain-text passes above, read from {@link OutboundScreen} rather than re-derived.
 * `security_alert` is excluded on purpose: "New sign-in from Chrome on macOS" carries no code,
 * and the device and place are exactly what the user is paying the model to read — an alert that
 * DOES frame a code classifies `otp` instead, so nothing is lost. `auth_url_token` is excluded
 * for the same reason: a bare magic link has no code beside it, and {@link redactUrlTails} has
 * already taken the token.
 */
function codeFramed(screen: OutboundScreen): boolean {
  if (screen.reason === "credential_shape") return true;
  return screen.category === "otp" || screen.category === "verification"
    || screen.category === "password_reset";
}

/**
 * A magic link is a credential in URL form, and {@link CODE} does not reach it — `SECRET-LOGIN-
 * TOKEN` is not a digit run and the `?t=` is not a word boundary away from anything. Redacting
 * the token-bearing tail of an authentication URL closes the stored-redacted half for the
 * passwordless class the way `CODE` closes it for the OTP class.
 */
function redactAuthUrls(text: string): string {
  AUTH_URL_MARKER.lastIndex = 0;
  return text.replace(AUTH_URL_MARKER, (url) => {
    const cut = url.search(/[?#]/);
    const head = cut >= 0 ? url.slice(0, cut) : url;
    return `${head.replace(OPAQUE_TOKEN, "[REDACTED]")}${cut >= 0 ? "?[REDACTED]" : ""}`;
  });
}

/**
 * The redaction, as one function — the transform that strips a credential VALUE out of a payload
 * bound for a MODEL. No longer applied to anything the user stores or reads: storage redaction is
 * gone (the mailbox already holds the mail unredacted, so hiding the display copy only hid it
 * from the user), and the only callers are the model gate — {@link redactForModel} and the
 * user-requested AI path. The credential a user sees is never blanked; the credential a model
 * sees always is. The order is load-bearing: {@link redactAuthUrls} runs FIRST because it
 * rewrites whole URL tails — running {@link CODE} first would blank a digit run inside a token
 * and leave the rest intact, a partially-redacted secret.
 */
export function redactSensitiveText(text: string): string {
  return redactAuthUrls(text).replace(CODE, "[REDACTED]");
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 8. THE DECISION
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/** One human-visible representation of the message, canonicalised and ready to match. */
interface Representation {
  label: string;
  canonical: Canonical;
  /** The raw (pre-canonical) text, for the shape rules that care about case and layout. */
  raw: string;
}

function categoryOf(rep: Representation): SensitivityCategory | null {
  // {@link proseOnly}: the vocabulary reads words, and a click tracker's opaque token is not
  // words. Masking here and nowhere else is what keeps this a precision change — the shape rules
  // and the authentication-URL rule below still read the canonical forms untouched.
  const folded = proseOnly(rep.canonical.folded);
  const plain = proseOnly(rep.canonical.plain);
  const raw = proseOnly(rep.raw);
  const numeric = proseOnly(rep.canonical.numeric);
  // Order is precedence, not priority: a mail matching both OTP and ALERT ("new sign-in — enter
  // this code") is an OTP, because that is the category whose redaction matters.
  if (OTP.test(folded) || schemeNameNearCode(numeric) || PIN_ACRONYM.test(raw) || WORLD_OTP.test(plain)) {
    return "otp";
  }
  if (RESET.test(folded)) return "password_reset";
  if (VERIFY.test(folded)) return "verification";
  if (ALERT.test(folded)) return "security_alert";
  return null;
}

const PRECEDENCE: SensitivityCategory[] = ["otp", "password_reset", "verification", "security_alert"];

/** Words of ≥2 letters, for the language probe and the alternatives-divergence check. */
function words(s: string): string[] {
  return s.match(/\p{L}{2,}/gu) ?? [];
}

/**
 * Do the plain part and the HTML part tell the same story?
 *
 * The HTML-only case does not need this — the union catches it, because the HTML says "magic
 * sign-in link" and a positive from ANY representation is a positive. This exists for the
 * residue: neither part matched, but they are describing different things, so we do not know
 * which one the user is reading. The thresholds are generous on purpose (HTML-to-text extraction
 * is lossy, and footers legitimately differ) — the cost of a false "diverges" is one message
 * routed by rules.
 */
const DIVERGENCE_MIN_WORDS = 25;
const DIVERGENCE_CONTAINMENT = 0.35;

function alternativesDiverge(text: string, htmlText: string): boolean {
  const a = new Set(words(text.toLowerCase()));
  const b = new Set(words(htmlText.toLowerCase()));
  if (a.size < DIVERGENCE_MIN_WORDS || b.size < DIVERGENCE_MIN_WORDS) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const w of small) if (large.has(w)) shared++;
  return shared / small.size < DIVERGENCE_CONTAINMENT;
}

const NESTED_MESSAGE = /^message\/(rfc822|global)/i;
const NESTED_FILENAME = /\.(eml|msg|mht|mhtml)$/i;

export function classifySensitivity(msg: NormalizedMessage): SensitivityResult {
  const reasons = new Set<IndeterminateReason>();

  // ── Gather every human-visible representation ────────────────────────────────────────────
  const cap = (s: string, label: string): string => {
    if (s.length > SCAN_CAP_CHARS) {
      reasons.add("scan_truncated");
      return s.slice(0, SCAN_CAP_CHARS);
    }
    void label;
    return s;
  };

  const subject = cap(msg.subject ?? "", "subject");
  const text = cap(msg.textBody ?? "", "text");
  const htmlRaw = msg.htmlBody ?? "";
  const htmlText = htmlRaw ? cap(visibleTextFromHtml(cap(htmlRaw, "html")), "html-text") : "";
  const filenames = (msg.attachments ?? [])
    .map((a) => a.filename)
    .filter((f): f is string => typeof f === "string" && f.length > 0)
    .join("\n");

  const { decoded, undecodable } = decodeEmbedded(`${text}\n${htmlText}`);
  if (undecodable) reasons.add("encoded_block");

  const reps: Representation[] = [
    { label: "subject", raw: subject, canonical: canonicalise(subject) },
    { label: "text", raw: text, canonical: canonicalise(text) },
  ];
  if (htmlText) reps.push({ label: "html", raw: htmlText, canonical: canonicalise(htmlText) });
  if (filenames) reps.push({ label: "attachments", raw: filenames, canonical: canonicalise(filenames) });
  decoded.forEach((d, i) => reps.push({ label: `decoded:${i}`, raw: d, canonical: canonicalise(d) }));

  // ── The UNION is the positive answer (the HTML-only case): a match in ANY representation is a match ──
  const hits = new Set<SensitivityCategory>();
  for (const rep of reps) {
    const c = categoryOf(rep);
    if (c) hits.add(c);
  }
  const category = PRECEDENCE.find((c) => hits.has(c)) ?? null;

  // ── Everything below decides whether a NEGATIVE is a negative or an "unknown" ───────────
  if (category === null) {
    const scanned = reps.map((r) => r.canonical);
    const nonLatin = scanned.reduce((n, c) => n + c.nonLatinLetters, 0);
    if (nonLatin >= UNSUPPORTED_SCRIPT_MIN) reasons.add("unsupported_script");
    if (scanned.some((c) => c.obfuscated)) reasons.add("obfuscated_text");

    const allWords = words(`${subject}\n${text}\n${htmlText}`.toLowerCase());
    if (allWords.length >= LANG_PROBE_MIN_WORDS && !allWords.some((w) => STOPWORDS.has(w))) {
      reasons.add("unrecognised_language");
    }

    // Prose density for the auth-URL gate: URL-stripped words across every human-visible field. A
    // message dominated by a link is a credential DELIVERY; a document that merely CONTAINS a link
    // is prose whose incidental login/tracking URL is not a credential. See {@link authCredentialUrlIn}.
    const lowProse =
      words(`${subject}\n${text}\n${htmlText}`.replace(/https?:\/\/[^\s<>"')\]]+/gi, " ")).length
      < AUTH_LOW_PROSE;

    for (const rep of reps) {
      if (credentialShapeIn(rep)) {
        reasons.add("credential_shape");
      }
      if (authCredentialUrlIn(rep.raw, lowProse) || authCredentialUrlIn(rep.canonical.plain, lowProse)) {
        reasons.add("auth_url_token");
      }
    }

    // An attached or forwarded message. DEFERRED, and the default is `no_ai` — the bytes are
    // not in `NormalizedMessage` at all (attachment metadata only), so there is
    // nothing here to recurse into. See the header note.
    for (const a of msg.attachments ?? []) {
      if (NESTED_MESSAGE.test(a.contentType ?? "") || NESTED_FILENAME.test(a.filename ?? "")) {
        reasons.add("nested_message");
      }
    }

    if (htmlText && text && alternativesDiverge(text, htmlText)) {
      reasons.add("alternatives_disagree");
    }

    // Nothing scannable, although the message has a surface that should have produced
    // something. We are not judging a message we could not read.
    const anyScannable = reps.some((r) => r.raw.trim().length > 0);
    if (!anyScannable && (htmlRaw.length > 0 || (msg.attachments ?? []).length > 0 || (msg.textBody ?? "").length > 0)) {
      reasons.add("no_visible_text");
    }
    if (!anyScannable && !subject) reasons.add("no_visible_text");
  }

  const sensitive = category !== null;
  const verdict: SensitivityVerdict = sensitive ? "sensitive" : reasons.size > 0 ? "indeterminate" : "ordinary";
  // `no_ai` and `no_kb` fail CLOSED on indeterminate; `no_forward` and `priority` follow the
  // positive match only. See the header: fail-closed is a rule about disclosure to a model, not
  // a licence to block user actions or mangle the priority signal.
  const withheldFromModel = verdict !== "ordinary";

  // BODY REDACTION IS REMOVED. This function no longer decides "store the redacted body" — the
  // ingest path stores the FULL original, always, because the mailbox on the IMAP server already
  // holds it unredacted and hiding the display copy only hid it from the user. What survives is the
  // MODEL gate: `no_ai`/`no_kb` (fail-closed on indeterminate) and, at the model boundary,
  // `redactForModel`. See the `SensitivityResult` note.
  return {
    sensitive,
    verdict,
    category,
    reasons: sensitive ? [] : [...reasons],
    flags: {
      no_ai: withheldFromModel,
      no_kb: withheldFromModel,
      no_forward: sensitive,
      priority: sensitive,
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 9. THE SINK-SIDE SCREEN
 * ════════════════════════════════════════════════════════════════════════════════════════ */

export interface OutboundScreen {
  safe: boolean;
  category: SensitivityCategory | null;
  reason: "vocabulary" | "credential_shape" | "auth_url_token" | null;
}

/**
 * The LAST check before a payload is serialised for a model. The classifier carries no
 * sensitivity flag of its own and cannot catch an upstream false negative; this function is that
 * flag — it re-reads the payload about to leave, with the same local detector, and refuses. It
 * screens on CONTENT ONLY — recognised vocabulary, an unframed credential shape, an
 * authentication URL bearing a token — never on `unsupported_script` or `unrecognised_language`:
 * those are upstream ROUTING decisions, and a sink throwing on any non-Latin payload would break
 * `ScreenerService` for every non-Latin sender without protecting anything. The sink refuses what
 * must never be sent; the upstream decides what we are not sure about.
 */
/** What {@link redactForModel} hands back: the two fields to send, and whether it changed them. */
export interface ModelSafeText {
  subject: string;
  snippet: string;
  /**
   * True ⇒ the screen fired and both fields were rewritten: {@link redactSensitiveText} for
   * plain values, {@link redactUrlTails} for URL tails, and {@link redactEncodedRuns} for
   * base64 / quoted-printable runs the embedded decoder would have read.
   */
  redacted: boolean;
}

/**
 * Make a payload sendable, for a caller whose user asked: the AI-OPEN half of the rule. {@link
 * screenOutboundText} answers "does this carry credential material"; this answers "then what do I
 * send": the same bytes with the credential VALUE removed. CONDITIONAL because {@link CODE}
 * matches `URGENT`, `WELCOME` and any 4–8 digit run: run everywhere it would blank ordinary
 * subjects, so the screen decides per payload whether the redactor runs. It reads the BYTES,
 * never `messages.no_ai`: the stored flag is known-wrong for historical rows, and the RAW-stored
 * subject is where the code usually is. No residue check: vocabulary cannot be redacted — words
 * are not values — so `redacted` is a reported fact, never a veto.
 */
export function redactForModel(subject: string, snippet: string): ModelSafeText {
  // The whole screen, not just `.safe` — {@link codeFramed} reads the category to decide whether
  // the short-code passes may run, and re-screening each field separately would answer a
  // different question from the one the sink asked about the joined payload.
  const screen = screenOutboundText(subject, snippet);
  if (screen.safe) return { subject, snippet, redacted: false };
  const framed = codeFramed(screen);
  // Order: QP soft breaks are unfolded first, so a value wrapped across lines is contiguous when
  // {@link CODE} reads it; then the plain-text passes blank values and URL tails; then {@link
  // redactEncodedRuns} blanks every run the embedded decoder could have read. Encoded-last is
  // load-bearing: whatever the earlier passes leave of a machine run, it removes. {@link
  // redactFramedCodes} sits between the two — AFTER {@link redactSensitiveText} so everything
  // `CODE` reaches is already gone, and OUTSIDE URLs so it cannot contradict {@link
  // redactUrlTails}'s decision to keep the host. {@link redactShortEncodedRuns} runs last of all,
  // on text whose plain values are already `[REDACTED]`, so the only runs left to decode are
  // genuinely encoded ones.
  const clean = (t: string): string => {
    const unfolded = t.replace(QP_SOFT_BREAK, "");
    const plain = redactUrlTails(redactSensitiveText(unfolded));
    const short = framed ? outsideUrls(plain, redactFramedCodes) : plain;
    return redactShortEncodedRuns(redactEncodedRuns(short));
  };
  return { subject: clean(subject), snippet: clean(snippet), redacted: true };
}

/**
 * The click-tracker hole. {@link redactAuthUrls} only rewrites a URL whose OWN path or query
 * names an authentication marker; a measured password-reset mail carried its link as an ESP
 * click-tracking wrapper (`/ls/click?upn=<base64 of the real URL>`) — no marker, token intact.
 * Opening the AI path made the wrapper load-bearing: "the credential is removed before any AI
 * request is built" is only true if this is closed too. So on an already-flagged payload, every
 * opaque-looking run in the TAIL of every URL is blanked, marker or none. The HOST is kept — the
 * sender's domain is the most useful routing signal and not a secret. NOT applied to storage: the
 * model path may be strictly more redacted than the stored one, never less.
 */
const URL_RUN = /https?:\/\/[^\s<>"')\]]+/gi;
/** Everything after the authority: the first `/`, `?` or `#` and onward. */
const URL_TAIL = /^(https?:\/\/[^/?#\s]*)([\s\S]*)$/i;
const TAIL_SEGMENT = /[A-Za-z0-9_\-.~+%=]{16,}/g;

/**
 * The encoded form is redacted like the plain one. {@link screenOutboundText} DECODES embedded
 * base64/QP before judging, but redaction rewrites the ORIGINAL bytes and {@link CODE}'s `\b`
 * never fires inside a contiguous base64 run — so a payload flagged for its encoded credential
 * could leave with it intact. On an already-flagged payload every run the embedded decoder would
 * read is blanked — every {@link B64_RUN}, every {@link QP_HEX_RUN} — QP soft breaks unfolded
 * first. Cost: a ≥16-character unbroken alphanumeric stretch is blanked even when it is words;
 * hosts survive — `.` is not in the base64 alphabet. The sixteen floor stays — that long is
 * machine text; shorter encodings are {@link redactShortEncodedRuns}'s job.
 */
const QP_HEX_RUN = /(?:=[0-9A-Fa-f]{2})+/g;
/** A quoted-printable soft line break: `=` at end of line — "the value continues on the next". */
const QP_SOFT_BREAK = /=\r?\n/g;

function redactEncodedRuns(text: string): string {
  return text.replace(QP_HEX_RUN, "[REDACTED]").replace(B64_RUN, "[REDACTED]");
}

function redactUrlTails(text: string): string {
  URL_RUN.lastIndex = 0;
  return text.replace(URL_RUN, (url) => {
    const m = URL_TAIL.exec(url);
    if (!m) return url;
    const [, authority, tail] = m;
    if (!tail) return url;
    TAIL_SEGMENT.lastIndex = 0;
    // `looksLikeOpaqueToken` is reused rather than restated: it is the same "long, and carrying
    // something words in URLs do not" test, and a second spelling of it here is how the two come
    // to disagree about the next token shape somebody reports.
    return authority + tail.replace(TAIL_SEGMENT, (seg) =>
      looksLikeOpaqueToken(seg) ? "[REDACTED]" : seg);
  });
}

export function screenOutboundText(...parts: Array<string | null | undefined>): OutboundScreen {
  const raw = parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n");
  if (!raw) return { safe: true, category: null, reason: null };
  const canonical = canonicalise(raw);
  const rep: Representation = { label: "outbound", raw, canonical };

  const category = categoryOf(rep);
  if (category) return { safe: false, category, reason: "vocabulary" };
  const { decoded } = decodeEmbedded(raw);
  for (const d of decoded) {
    // VOCABULARY ONLY on a decoded representation, and this asked to be `credentialShapeIn` too.
    // It was written that way, and then removed again, because it changed no outcome on any
    // payload that could be constructed for it: `credentialShapeIn` needs framing or a token
    // SHAPE, and the decoded text that reaches here without either is a bare numeric run, which
    // it does not fire on by design — an order number and a one-time code are the same six
    // digits. Shipping it would have added a branch whose comment claimed a hole was closed while
    // the hole stayed open, which is worse than the hole. The bare-code-without-framing case is a
    // standing limit of the DETECTOR, recorded as such, not something this loop can reach.
    const c = categoryOf({ label: "outbound:decoded", raw: d, canonical: canonicalise(d) });
    if (c) return { safe: false, category: c, reason: "vocabulary" };
  }
  if (credentialShapeIn(rep)) {
    return { safe: false, category: null, reason: "credential_shape" };
  }
  if (hasAuthUrlToken(raw) || hasAuthUrlToken(canonical.plain)) {
    return { safe: false, category: null, reason: "auth_url_token" };
  }
  // LAST, because it decodes: the short reversible runs the redactor can strip but nothing above
  // can see. `decodeEmbedded` covers base64 from sixteen characters up and quoted-printable; it
  // matches no short base64 run, no percent-escape run and no numeric-entity run — the three
  // forms {@link redactShortEncodedRuns} exists for. Without this arm those passes never ran in
  // the case they were written for, because {@link redactForModel} short-circuits on `safe`.
  if (hasShortEncodedCredential(raw) || hasShortEncodedCredential(canonical.plain)) {
    return { safe: false, category: null, reason: "credential_shape" };
  }
  return { safe: true, category: null, reason: null };
}
