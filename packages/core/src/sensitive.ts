import type { NormalizedMessage } from "./types.js";

/**
 * SENSITIVITY DETECTION — the upstream half of the rule that sensitive mail never reaches a
 * model and is never stored in the clear.
 *
 * `flags.no_ai` is the ONLY thing standing between an authentication mail and the model:
 * `pipeline.ts` opens its AI condition with `!sensitivity.flags.no_ai`, `DraftingService` 422s
 * on it, `ScreenerService` narrows on it (`aiEligible: r.noAi === false && …`), and the workflow
 * runner's pre-flight reads it. Everything downstream — "no metering row at all for
 * sensitive mail", "the raw secret never leaves the process", the redaction that reaches
 * storage — is downstream of THIS function. A false negative here is not a missed nicety; it is
 * a one-time passcode in a prompt, in a stored snippet, and on someone's bill.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE HAS THREE OUTCOMES AND NOT TWO
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Until 2026-08-03 this function ended:
 *
 *     const sensitive = category !== null;
 *     flags: { no_ai: sensitive, … }
 *
 * with `category` set by four finite Latin-script regexes over `subject + "\n" + textBody`.
 * **There was no indeterminate outcome.** "None of my patterns matched" and "this message is
 * ordinary" were the same value, so the boundary failed OPEN by construction — not on an error
 * path, on the normal negative result. A security review established
 * three reachable classes, all critical, all reproduced:
 *
 *   · THE BARE-CODE CASE — a Japanese login-code mail, `Your PIN`, `482913 is your verification
 *            number` — any wording the list did not anticipate.
 *   · THE HTML-ONLY CASE — a valid `multipart/alternative` whose PLAIN part is only
 *            `https://accounts.example.com/session?t=SECRET-LOGIN-TOKEN` and whose HTML part
 *            calls it "Your magic sign-in link". The detector never read `htmlBody`, attachment
 *            filenames, or attached `message/rfc822` — and the plain part is what becomes the
 *            200-character model snippet, so the live bearer URL was serialised into the
 *            Anthropic request. Reproduced end to end through this repo's own MIME normalizer.
 *   · THE ENCODED-CONTENT CASE — reversible encodings and invisible characters: a quoted
 *            `Content-Transfer-Encoding: base64` block, `Your verificati=6Fn c=6Fde is 482913=2E`,
 *            `ver<U+200B>ification`.
 *
 * And there is no second line of defence to fall back on: {@link CODE} redaction is applied
 * ONLY to mail already judged sensitive, so it cannot rescue a false negative. The boolean is
 * the entire boundary.
 *
 * So the rule this file now implements is:
 *
 *     A finite phrase allowlist is authority for the POSITIVE answer only.
 *     The negative answer requires a claim we can actually support:
 *     that we read every human-visible representation, in a script and language
 *     whose vocabulary we hold, with nothing reversibly hidden inside it.
 *     Where we cannot support that claim, the answer is INDETERMINATE — and
 *     indeterminate routes to `no_ai`, never to AI.
 *
 * ── The eight sources of "unknown", and which are handled ───────────────────────────────────
 *
 *  1. `unsupported_script`     ≥ {@link UNSUPPORTED_SCRIPT_MIN} non-Latin letters and no
 *                              positive match. HANDLED. Non-Latin authentication vocabulary is
 *                              matched positively first ({@link WORLD_OTP} etc.), so a Japanese
 *                              or Russian OTP is `sensitive`, not merely withheld; the residue
 *                              is withheld because our NEGATIVE claim is Latin-script-only.
 *  2. `unrecognised_language`  Latin script, ≥ {@link LANG_PROBE_MIN_WORDS} words, and not one
 *                              function word of the five languages we hold vocabulary for.
 *                              HANDLED, PARTIAL — the probe catches languages lexically distant
 *                              from en/de/fr/it/es (Turkish, Polish, Finnish, Vietnamese…) and
 *                              is leaky for close neighbours (Dutch, Portuguese, Scandinavian)
 *                              whose function words collide with ours. Their authentication
 *                              nouns are covered additively in {@link WORLD_OTP}, and the
 *                              credential-shape rules below are the language-independent
 *                              backstop. Stated as a limitation, not a guarantee.
 *  3. `credential_shape`       A credential-shaped token with no recognised framing: an
 *                              imperative next to a bare 4–8 digit run, or a representation that
 *                              is NOTHING BUT a token — a digit run, a split digit run, or a
 *                              MIXED alphanumeric token. HANDLED. Deliberately narrow, and note
 *                              the two shapes are narrow in OPPOSITE directions: {@link
 *                              UNFRAMED_CODE}'s framed path excludes mixed alphanumerics because
 *                              `SPRING20` next to an imperative is a promo code, while {@link
 *                              TOKEN_ONLY} REQUIRES a mixed token, because accepting a pure-alpha
 *                              one there was proved to match ordinary words.
 *  4. `auth_url_token`         A URL whose path or query is authentication-shaped and which
 *                              carries an opaque token ≥ 12 characters. HANDLED. This is the
 *                              HTML-only case's plain part on its own, with no HTML to explain it.
 *  5. `obfuscated_text`        A zero-width or bidi control character between two letters, or a
 *                              single word mixing two scripts. HANDLED — and note the ordering:
 *                              canonicalisation happens BEFORE matching, so the usual outcome of
 *                              an obfuscated OTP is a positive match; this reason exists for the
 *                              residue where hiding is evident but nothing matched.
 *  6. `encoded_block`          A literal `Content-Transfer-Encoding:` block in the inspected
 *                              text whose payload we could not decode to text. HANDLED. Blocks
 *                              we CAN decode are decoded locally and scanned as further
 *                              representations, so the encoded-content case's base64 and
 *                              quoted-printable examples come out `sensitive` rather than merely withheld.
 *  7. `nested_message`         An attached or forwarded `message/rfc822` (or `.eml`/`.msg`).
 *                              **DEFERRED — and the default is `no_ai`.** It cannot be handled
 *                              here: `NormalizedMessage` carries attachment METADATA ONLY (no
 *                              bytes), so the inner message is not in this
 *                              function's input at all. Recursing needs `mime.ts` to surface
 *                              bounded nested text, and `mime.ts` belongs to another workstream.
 *                              Recorded as owed.
 *  8. `no_visible_text` /      Nothing scannable extracted although the message has a
 *     `scan_truncated`         content-bearing surface, or a representation exceeded
 *                              {@link SCAN_CAP_CHARS} and we did not read all of it. HANDLED.
 *
 * ── What failing closed costs, and why it is the designed fallback rather than a defect ─────
 *
 * An indeterminate message is routed by RULES instead of AI. That is the same degradation the
 * free tier and an out-of-credits account already get (the stated behaviour: out of AI actions ⇒
 * graceful rules-only degradation), so the machinery exists and the user-visible result is a message
 * without an AI suggestion — not a broken mailbox. Measured against the seeded test world
 * (a deterministic seeded corpus): **none of its messages are
 * indeterminate** and a handful are positively sensitive. The boundary therefore costs the AI
 * layer nothing on realistic mail, which is the
 * number that makes "fail closed" honest rather than a quiet way of switching the feature off.
 * A corpus test re-measures it and fails if the indeterminate fraction of that corpus ever
 * exceeds {@link SEEDED_INDETERMINATE_CEILING}.
 *
 * **That number used to be measured on a corpus that could not contain the failure.** The
 * same zero rate was reported while `TOKEN_ONLY` was withholding every 6–10 character one-word
 * subject, because the world had no one-word subjects at all and its shared fixture subject is
 * `"Atlas"` — five characters, one below the matching floor. A rate measured on a corpus lacking
 * the failing class is not a rate. The world now seeds 24 ordinary one-word subjects (8%,
 * deliberately above the 5% ceiling so a regression cannot land just under the bar), and reverting
 * the fix takes the measurement to `indeterminate=24 reasons=[["credential_shape",24]]` and the
 * ceiling test red. **That zero rate now means something it did not mean before.**
 *
 * ── Which flags fail closed, and which must not ─────────────────────────────────────────────
 *
 * `no_ai` and `no_kb` follow the fail-closed rule: both answer "may this content leave the
 * process for a model?" — `no_kb` gates the draft/workflow context that is assembled INTO a
 * prompt (`drafting-service.ts`'s `no_kb = false AND no_ai = false` WHERE clause), so an
 * indeterminate message must be out of both.
 *
 * `no_forward` and `priority` follow the POSITIVE match only. Failing those closed would not
 * protect anything a model could read; it would block a user action and mangle the priority
 * signal. Fail-closed is a rule about disclosure to a model, not a licence to damage the product.
 *
 * There is no longer a "store the body redacted" outcome at all. The body the user stores, is
 * served and reads is the FULL original in every case — the mailbox on the IMAP server already
 * holds it unredacted, so redacting the display copy only hid it from the one person entitled to
 * see it. The credential is still stripped before it reaches a MODEL ({@link redactForModel}),
 * which is a separate question asked at the model boundary over the same bytes.
 *
 * ── Detection is local-only, on purpose ─────────────────────────────────────────────────────
 *
 * Nothing in this file calls a model, and nothing in it may. "Ask the classifier whether this is
 * sensitive" is the violation itself: the message would have to be sent in order to find out.
 *
 * ── Precision is still bought deliberately, not thrown away ─────────────────────────────────
 *
 * The one thing that would ruin this is matching bare `sign in` / `log in`, which appear in an
 * enormous amount of ordinary marketing mail ("Sign in to see your order"). Every positive
 * pattern requires a second, authentication-specific token next to it, and every indeterminate
 * rule is shaped to miss ordinary mail: `use code SPRING20` does not fire the unframed-credential
 * rule, `Total CHF 1240.00` does not, `Meeting notes 2026-07-14` does not.
 * The test corpus for this file is three-sided — provider-shaped positives in many languages, an
 * adversarial indeterminate list, and a negative list of ordinary mail that must keep
 * `no_ai: false` — so a widening here that starts eating real mail fails immediately.
 *
 * ── Languages ──────────────────────────────────────────────────────────────────────────────
 *
 * German, French, Italian and Spanish are in scope, not aspiration: the product ships to a Swiss
 * market where a single mailbox routinely receives all four. The lists are the provider
 * vocabulary (`Bestätigungscode`, `code de vérification`, `codice di verifica`, `código de
 * verificación`), not a translation of the English phrasing. {@link WORLD_OTP} adds the same
 * vocabulary for the scripts and languages the review named plus the common remainder; it is ADDITIVE
 * coverage and explicitly not a completeness claim — rules 1 and 2 are what make the negative
 * answer sound.
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
   * ── BODY REDACTION IS GONE — THE FIELDS THAT CARRIED IT ARE REMOVED ──────────────────────────
   *
   * This result once carried `redactedTextBody` / `redactedHtmlBody` / `storeRedactedBody`, and the
   * ingest path stored those in place of the real body whenever a credential was present. That is
   * removed: the mail already sits unredacted on the IMAP server — the master — so redacting the
   * cloud/display copy only hid content from the OWNER of the mailbox, never from anyone else, and
   * it over-fired (a plain calendar invite could surface as "Verification code ······" when a body
   * merely mentioned a code). The user's own stored, served and displayed body is now the FULL
   * original, always.
   *
   * WHAT REMAINS is the disclosure gate to a MODEL, which is a different question asked at a
   * different moment over the same bytes: `flags.no_ai` / `flags.no_kb` keep sensitive and
   * indeterminate mail out of automatic AI, and {@link redactForModel} / {@link screenOutboundText}
   * strip the credential VALUE from any payload a user-pressed AI action sends. Those never touch
   * what the user sees. `flags.no_forward` still holds (sensitive mail is not forwarded), and
   * `sensitive` / `category` remain the LABEL the surfaces show. See {@link redactSensitiveText}:
   * it is now used ONLY by the model gate, never by storage.
   */
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 1. SECURITY CANONICAL FORM — applied BEFORE any matching (the encoded-content case)
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Zero-width, bidi-override and other invisible format characters used to split a word.
 *
 * Written as `\u` escapes and NEVER as the literal characters: a source file that contains the
 * invisible characters it is defending against is a file nobody can review, and a diff that
 * deletes one of them is invisible in a diff too.
 *
 *   200B ZWSP · 200C ZWNJ · 200D ZWJ · 200E/200F LRM/RLM · 202A–202E bidi embedding/override
 *   2060–2064 word joiner & invisible operators · 2066–2069 bidi isolates · FEFF BOM
 *   061C Arabic letter mark · 180E Mongolian vowel separator
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
 * TWO forms, and the split is not cosmetic.
 *
 * `folded` strips `\p{Mn}` so a combining mark wedged into `veri◌fication` cannot break the
 * Latin patterns. That is safe for the five in-scope languages — NFKC composes `e`+U+0301 into a
 * single `é`, leaving no residual mark in Latin text — but it is DESTRUCTIVE for scripts where
 * marks are letters: `รหัสยืนยัน` loses U+0E31 and U+0E37 and stops being Thai. The Thai case in
 * the corpus failed for exactly that reason, which is why the non-Latin vocabulary is matched
 * against `plain` and only the Latin vocabulary against `folded`.
 *
 * The script census also runs on `plain`, before folding, so that folding Cyrillic to Latin can
 * never hide the fact that the message was Cyrillic.
 */
const UNICODE_DIGIT = /\p{Nd}/gu;
const IS_UNICODE_DIGIT = /\p{Nd}/u;

/**
 * Every Unicode decimal digit folded to its ASCII value; everything else untouched.
 *
 * There is no JavaScript API for a character's numeric value, and neither `Number("٠")` nor
 * `parseInt("٠", 10)` works — both return `NaN`. But `Nd` blocks are contiguous runs of ten, so a
 * digit's value is its offset from the start of its own decade. Counting **all** contiguous `Nd`
 * predecessors and taking `% 10` gets that without a lookup table: each complete adjacent decade
 * contributes exactly ten, so the residue is the offset within the character's own decade.
 *
 * ── THREE WRONG VERSIONS OF THIS FUNCTION, AND WHY THE TEST IS EXHAUSTIVE ─────────────────
 *
 * 1. `String(Number(c))` — `NaN` for every non-ASCII digit, so `٠١٢٣٤٥` became `"NaNNaN…"`.
 * 2. A `for`-loop back-walk that returned `cp - (z + 1)` on leaving the block and **fell through to
 *    `return 0`** when it never left it. ASCII `9` never leaves within ten steps, so every `9` in
 *    every message folded to `0` — corrupting the detector for ALL mail, not just the class under
 *    repair. Caught only because a sanity row contained a price: `€49.90` → `€40.00`.
 * 3. A `while`-loop back-walk **capped at 9 steps**. Correct for ASCII and for every ISOLATED
 *    decade, and wrong wherever two decades are CODEPOINT-ADJACENT, because it stops inside the
 *    neighbour and reports the neighbour's offset. Those exist: the Mathematical Alphanumeric
 *    digits are five contiguous decades (U+1D7CE–U+1D7FF) and Chakma (U+116C0/U+116DA) is another,
 *    so double-struck `𝟛` returned 9. Reachable only if anything ever calls this before NFKC — a
 *    wrong branch masked by an accident of ordering, which is this codebase's most-repeated shape.
 *
 * The exhaustive test names U+116DA and four Mathematical decades when the `% 10` is removed; the
 * ASCII fast path below is therefore **performance only**, since version 3 handled ASCII correctly.
 * Removing it is the one mutation here that legitimately keeps every test green.
 *
 * So the guard is not a handful of examples. A test enumerates **every** `Nd`
 * codepoint, groups them into contiguous runs, and asserts each decade folds to `0123456789` — 76
 * decades across 71 runs today, and it re-verifies automatically when a Node upgrade adds a script.
 * It also asserts `foldDigits(ascii) === ascii`, which is what versions 2 and 3 failed.
 *
 * The ASCII fast path is not an optimisation to be tidied away: ASCII `0-9` ARE `\p{Nd}`, so
 * without it every date, price and order number in a 128 KB body pays a run of regex probes.
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
 * Mostly-printable text, i.e. worth scanning rather than random bytes from a hash.
 *
 * ── THE REPLACEMENT-CHARACTER TEST, AND THE MEASUREMENT THAT FORCED IT ─────────────────────
 *
 * `decodeEmbedded`'s header used to say that a block which is not really text "simply fails
 * {@link looksLikeText} and is discarded". That was false, and it was false in the direction that
 * manufactures false positives.
 *
 * `Buffer.from(run, "base64").toString("utf8")` does not fail on random bytes — it SUBSTITUTES,
 * emitting U+FFFD REPLACEMENT CHARACTER for every byte sequence that is not valid UTF-8. U+FFFD is
 * codepoint 65533, so the printable test below counted every one of them as printable, and a
 * decode of pure noise came back 90–100% "printable". Three consecutive letters then turn up by
 * chance in any long enough run. So a marketing tracking token — which is exactly a long
 * `[A-Za-z0-9+/]` run — decoded to Unicode confetti and was handed back as a representation to
 * scan. That confetti mixes scripts freely, `hasMixedScriptWord` read it as the classic homoglyph
 * signal, and the message became `obfuscated_text` → indeterminate → `no_ai`.
 *
 * Measured over one account's Screener before this line existed: of 371 held representatives
 * flagged `obfuscated_text`, **350 stopped being flagged when base64-shaped runs were removed from
 * the body, and only 21 survived** — so roughly 95% of that signal was manufactured here rather
 * than present in the mail. It is the same shape of defect as the `2Fa` tracker escape: an
 * accidental reading of machine text as human text, decided by a token the sender chose at random.
 *
 * A rejection and not a re-weighting, because the signal is categorical: text that was genuinely
 * base64-encoded decodes to valid UTF-8 with ZERO replacement characters. One U+FFFD means the
 * bytes were not what we guessed they were, and a guess we know to be wrong is not evidence.
 *
 * The narrow arm only. `decodeEmbedded`'s DECLARED case (a body carrying a literal
 * `Content-Transfer-Encoding:` line) still reports `encoded_block` for a payload it cannot read —
 * refusing to call unreadable declared content ordinary is the whole point of that branch, and
 * this does not touch it.
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
 *
 * Top-level `Content-Transfer-Encoding` is already decoded by `mime.ts` before this function
 * sees anything; this is the nested case the review reproduced. Decoding is local and bounded, and
 * a block that will not decode to text is not silently dropped: when the text carries a literal
 * `Content-Transfer-Encoding:` line, an undecodable payload is `encoded_block` — indeterminate.
 *
 * The `CTE_MARKER` requirement on the suspicious arm is what keeps a DKIM signature, a hex
 * digest or a tracking token out of it. Opportunistic decoding has no such requirement because
 * garbage is discarded by {@link looksLikeText} — which is TRUE ONLY SINCE that function learned
 * to reject replacement characters. It used to say "garbage simply fails `looksLikeText`", and
 * that sentence was the load-bearing justification for an arm which was, in fact, admitting the
 * garbage: `toString("utf8")` substitutes U+FFFD instead of failing, and U+FFFD counted as
 * printable. See {@link looksLikeText} for the measurement. Left here as a marker that this
 * paragraph is the claim under test, not evidence for it.
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
 * AUTHENTICATION VOCABULARY IS READ FROM WORDS. A machine token is not words.
 *
 * ── What went wrong, and why `\b` could not have prevented it ────────────────────────────────
 *
 * Bulk senders wrap every link in a click tracker and percent-escape the target inside it: `/`
 * becomes `-2F`, `+` becomes `-2B`. `-` is not a `\w` character, so JavaScript puts a word
 * boundary on each side of the three characters `2Fa` — and `2fa` is in the vocabulary below as a
 * standalone acronym. A newsletter whose random tracking token happens to encode a slash followed
 * by an `a` therefore matched the one-time-code vocabulary, on an accident of base64.
 *
 * The cost is not a stray flag. A message judged sensitive is stored REDACTED and its sender HTML
 * is never written at all, so the reader is left with the text/plain alternative — bracketed URLs
 * and a tracking-pixel line as visible text — and the HTML that was refused is not kept anywhere,
 * so the loss outlives the misclassification.
 *
 * What makes it a defect in the boundary rather than a strict boundary working as intended is
 * that the answer was decided by a random token. Three copies of one usage-billing notice from
 * one sender, two of them sent on the same day, were classified differently: the two whose token
 * happened to contain the escape were withheld and stripped, and the one whose token did not was
 * read normally. Measured on a large live store, dozens of the sensitivity-categorised
 * bodies clear once this mask is applied, every one of them a newsletter, an invoice, a delivery
 * notice or a monitoring alert.
 *
 * ── Why masking, and why only here ───────────────────────────────────────────────────────────
 *
 * Only {@link categoryOf} reads through this. The credential-SHAPE rules, the authentication-URL
 * rule, the language probe, the script census and redaction all keep reading the unmasked text,
 * and that separation is the safety argument: this function can only ever REMOVE a positive, so
 * the shape and URL backstops are exactly as strong as they were.
 *
 * It cannot create one either. Runs are replaced by spaces of the SAME LENGTH rather than
 * deleted, so nothing that was apart is brought together and no `\b` moves; every match that
 * survives is a match that was already there.
 *
 * And a phrase cannot be smuggled through it. Every multi-word entry in the vocabulary contains a
 * space, a run contains none, so at most one glued word can ever be swallowed — a word that no
 * reader of the message could act on either.
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
 * The noun a qualifier may attach to. Two things are deliberately NOT in it, and both were
 * caught by the corpus rather than by reading:
 *
 *  · `word`. `pass` is itself a qualifier, so `(pass)?(code|word)` matches the word `password`
 *    outright — which silently reclassified every `password_reset` and `no password needed`
 *    message as `otp`, changing the category whose redaction matters. "One-time password" is
 *    covered by its own arm below, where the qualifier cannot be `pass`.
 *  · `number`. "Your order confirmation number" is ordinary receipt mail, and matching it would
 *    move a flight confirmation into INBOX and redact its digits. It is admitted only after the
 *    qualifiers that cannot mean anything else — see {@link OTP} arm 2, which is the bare-code
 *    case's `482913 is your verification number`.
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
    // DIGIT-ANCHORED. "Your code is 482913" must be `sensitive`, not merely withheld,
    // because the rule has two halves and the second one is that the stored body is
    // redacted. The digits ARE the qualifier here: article, code-noun, copula, digits, with
    // NOTHING between them. That strictness is the whole safety argument — `"your code is
    // ready"` and `"your code is failing CI"` cannot match, and an intervening word means
    // `"your sort code is 401726"` and `"your order code is 4821"` fall through to the shape
    // layer and are withheld rather than redacted and rerouted.
    // ACCEPTED RESIDUE, recorded rather than chased: a brand-inserted template — "Your Uber
    // code is 482913" — also falls through to the shape layer. Withheld from AI, stored in
    // clear. Chasing it with a positive rule would mean admitting an arbitrary word between
    // the noun and the copula, which is where the commerce family lives.
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
 * NON-LATIN and remaining-Latin authentication vocabulary — matched against the UNFOLDED
 * canonical form, because folding Cyrillic and Greek to Latin would destroy these.
 *
 * The review named Japanese explicitly; Chinese, Korean, Arabic, Hebrew, Cyrillic, Greek, Thai and
 * Hindi are here for the same reason, and the Latin-script remainder (Turkish, Portuguese,
 * Dutch, Polish, Scandinavian, Finnish, Czech, Romanian, Hungarian, Indonesian, Vietnamese) is
 * here because rule 2's function-word probe is leaky for languages close to the five we hold.
 *
 * This list makes those messages POSITIVE — `sensitive: true`, redacted, routed to the user —
 * rather than merely withheld, which is a better outcome. It is not, and must never be read as,
 * a claim that the vocabulary is complete: rules 1–8 are the boundary.
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
 * ── WHY THERE ARE NOW FOUR ARMS, AND WHY THE THIRD IS SHAPED SO TIGHTLY ─────────────────────
 *
 * Measured on a realistic OTP set: **most of them reached the model.** `"Your code is 482913"` —
 * the most common OTP body in English — was `ordinary`, `no_ai: false`, because the framing sat
 * BEFORE the number and matched neither arm: `CODE_CUE` wants an imperative before the code and
 * `CODE_TRAILER` wants a phrase after it. A possessive noun phrase before it fell through both.
 *
 * The near-misses were held by COINCIDENCE, not by these rules: `"Your verification code is …"`
 * survived because that exact phrase is in the vocabulary, so the shape layer was never what
 * caught it. The nonsense-qualifier tests (`"your flurm code is 482913"`) exist to make the shape
 * backstop structural, so a future vocabulary edit cannot become the only thing holding them.
 *
 * **Arm 3's copula-or-colon is mandatory and must sit immediately before the digits.** That is the
 * precision screw, and it is what keeps the ordinary-commerce family out: `"your order code 4821
 * is ready"` has the digits BEFORE the copula, `"the invoice number is 22910"` has the wrong noun,
 * `"code 500 error"` is below `BARE_CODE`'s four-digit floor, and `"barcode is 48213"` has no word
 * boundary inside the word. All four are asserted `ordinary`.
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
 * A representation that is NOTHING BUT a token — a digit run, a split digit run, or a MIXED
 * alphanumeric token.
 *
 * **Read against `canonical.numeric`, never `raw`**: `[0-9]` matches no digit outside ASCII,
 * so reading raw text meant a body of only `٠١٢٣٤٥` was `ordinary` while `123456` was withheld.
 *
 * ── THE THIRD ALTERNATIVE USED TO BE `[A-Za-z0-9]{6,10}`, AND IT MATCHED WORDS ─────────────
 *
 * The comment here used to read "Ordinary mail is never shaped like this." Measured 2026-08-03
 * against a corpus of thirty ordinary one-word subjects: **twenty-five matched** — Question,
 * Invoice, Reminder, Welcome, Receipt, Update, Meeting, Payment, Newsletter, Thanks, Urgent,
 * Report, Refund, Contract, Invite, Ticket and more. Ordinary mail is shaped like this constantly,
 * and `subject` is a representation (see the `reps` array), so the subject alone was enough.
 *
 * It fails CLOSED — those messages were withheld from AI, never leaked — so this was precision,
 * not safety. But it degraded the feature silently, and it is not confined to subjects:
 * `screenOutboundText` JOINS its parts, so an empty subject with a one-word body ("Thanks") was a
 * token-only payload and was refused at the sink too. One narrowing fixes both sites.
 *
 * **What narrowing to a mixed token releases to the model, named so the claim is auditable:** a
 * single PURE-ALPHA 6–10 character token with no framing, no vocabulary in any of the ~40
 * languages, no digits and no URL token (`ABCDEF` as an entire body); and a single 9–10 digit run,
 * which alt1 caps below at 8 — a phone number, a tracking number, an order id. `BARE_CODE` already
 * rules that OTPs are 4–8 digits.
 *
 * That release is acceptable because providers FRAME codes — which is why `CODE_CUE`,
 * `CODE_TRAILER` and the 40-language vocabulary exist at all: a code nobody labels is a code
 * nobody can act on. Every unframed-code fixture in the corpus is a digit run. **If a real
 * provider ever ships a pure-alpha code with zero framing in subject and body, the fix is
 * vocabulary or a framing pattern — never re-widening this shape back onto words.**
 */
const TOKEN_ONLY =
  /^[\s*]*([0-9]{4,8}|[0-9]{3,4}[-\s][0-9]{3,4}|(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{6,10})[\s*.]*$/;

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 5b. THE LANGUAGE-INDEPENDENT NUMERIC BACKSTOP
 *
 * `UNFRAMED_CODE` and `TOKEN_ONLY` above only fire on English-recognised framing or a body that is
 * NOTHING but a token. A German `Ihre TAN lautet 481920.`, a Polish `Twój kod jednorazowy to
 * 559214`, a Dutch `Uw toegangscode is 220417` and a spaced `Ihr Code: 44 12 90` all carry a live
 * code inside ordinary prose whose framing is in a language the vocabulary does not reach — and all
 * of them were `ordinary`: sent to the classifier via `bodySnippet`, and stored raw. German is a
 * primary market for this product.
 *
 * The signal that survives translation is SHAPE, not vocabulary: a credential-shaped digit run
 * sitting next to a word that NAMES a secret. So the backstop is `<credential-noun cue> within a
 * short window of <a bare 4–8-digit run>`, in any language, landing in the fail-closed
 * `credential_shape` bucket (→ `no_ai`).
 *
 * ── Why a CUE, and not merely "a short message with a number in it" ─────────────────────────
 *
 * A verification pass named two candidate shapes: (a) a digit run next to any possessive /
 * second-person / imperative context, and (b) a short message with an unframed digit run. Both are
 * too broad to sit under the 5% indeterminate ceiling: "your order 482913", "your booking reference
 * is 84213" and every receipt in the seeded world carry a possessive next to a 4–8-digit run, and a
 * bare short message with a number is most of a mailbox. A possessive is not a discriminator; a
 * CREDENTIAL NOUN is. No ordinary receipt says `Kennwort`, `TAN`, `Schlüssel`, `kod jednorazowy` or
 * `toegangscode`. The one generic word that DOES cross into commerce — "code" — is admitted only
 * when it is not commerce-qualified: `order code 4821` is out, `Ihr Code:` is in. This is the
 * tightening the verification pass sanctioned when the broad shapes broke the ceiling.
 *
 * ── And the digit run itself excludes the shapes that collide ───────────────────────────────
 *
 * A #-prefixed order number, a price (currency-led or with a decimal tail), an ISO date, a 4-digit
 * year, and any run that is part of a longer number or an alphanumeric token, are all NOT codes.
 * Those exclusions are what keep `Invoice 100245 due 2026-08-30`, `Total: 129.99`, a tracking
 * number and `See you in 2026` ordinary even where a cue happens to be nearby.
 * ════════════════════════════════════════════════════════════════════════════════════════ */

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
 * THE NAME OF A SCHEME IS NOT A CREDENTIAL. `otp`, `2fa`, `two-factor`, `multi-factor`.
 *
 * ── What went wrong, measured ────────────────────────────────────────────────────────────────
 *
 * These four sat in {@link OTP}'s "unambiguous on its own" arm, so ANY message containing the
 * word was `sensitive` — stored REDACTED, its sender HTML never written, withheld from the model
 * and force-routed. But unlike `passcode` or `one-time password`, which name the credential
 * object, these name a METHOD, and a method is a thing people write to each other about.
 *
 * The shape that found it is a long reply thread in which colleagues discuss enabling two-factor
 * sign-in — many paragraphs of ordinary prose whose only contact with this vocabulary is one
 * sentence containing `2FA`. Blank that one acronym and the classifier returns `ordinary`: the
 * word was the whole of the evidence. The message carried no code, and its reader was shown a
 * redacted body for mail about nothing secret at all.
 *
 * On a large mail store the class is dominated by mail that DISCUSSES authentication rather than
 * carrying it: vendor security announcements, developer newsletters, "multi-factor will become
 * mandatory" policy notices, a password manager's own marketing, and human threads about rolling
 * the scheme out. A seventh of one store's `otp` verdicts rested on one of these four words
 * alone, and most of those messages contained no code-shaped token anywhere.
 *
 * ── The gate, and why it cannot weaken the boundary ──────────────────────────────────────────
 *
 * The word now needs a code-shaped run within {@link CODE_PROXIMITY} of it — the same distance,
 * the same {@link codeRunSpans} (so the same exclusions: a year, a price, a `#`-order number, an
 * ISO date and a phone-length run are still not codes), and the same {@link proseOnly} mask the
 * rest of {@link categoryOf} reads through. `Your OTP is 482913` and `2FA code: 448 213` are
 * exactly as positive as they were.
 *
 * The safety argument is that this predicate is a NEAR-DUPLICATE of a test the classifier already
 * ran. {@link CRED_NOUN_GENERIC} carries `otp|mfa|2fa`, so a scheme name sitting near a code run
 * ALREADY raised `credential_shape` through {@link looseNumericCode} — which withholds the
 * message from the model AND stores it redacted. The two layers therefore agree by construction:
 * where a code is present this rule promotes that same finding to a positive category, and where
 * no code is present neither layer fires, because there is no credential in the text for either
 * of them to be protecting. What is given up is a positive on messages that provably contain no
 * code-shaped token — where redaction had nothing to redact.
 *
 * Read from `numeric` rather than `folded` so a non-ASCII code counts, for the reason
 * {@link Canonical.numeric} gives; the acronyms themselves are unaffected by the digit fold.
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
  // BOTH rules read `numeric`, and neither reads `raw` any more.
  //
  // `TOKEN_ONLY` used to read `rep.raw.trim()` while `UNFRAMED_CODE` read the canonical form. That
  // asymmetry was the defect: the token rule never saw normalised text, so no non-ASCII digit could
  // match `[0-9]`, and a body that was nothing but `٠١٢٣٤٥` came out `ordinary`.
  //
  // Moving off `raw` loses nothing and gains an evasion class. Lowercasing is irrelevant here
  // (alt3's character class covers both cases, and the case-SENSITIVE shape rule still reads `raw`,
  // so that field keeps its consumer); the pattern's own `^[\s*]*` / `[\s*.]*$` absorb the missing
  // trim; and NFKC plus invisible-character stripping means a zero-width-spaced code, which evades
  // `raw` entirely, is now caught.
  //
  // The language-independent numeric backstop is added as a third term. Because this predicate is
  // the ONE the two call sites share, `screenOutboundText` inherits it for free — a payload the
  // upstream detector let through on unfamiliar framing is now refused at the sink too.
  //
  // The backstop reads the PROSE-MASKED form, exactly like {@link categoryOf}: a click-tracking
  // token that happens to encode `-2Fa` carries the acronym `2fa`, and without the mask that
  // accidental cue would pair with an unrelated digit run — an address ZIP, an order total — and
  // withhold an ordinary newsletter. Masking machine tokens to spaces (same length, so proximity
  // is preserved) removes the cue that was never a word. Pure digit codes are NOT machine tokens
  // and survive the mask.
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
 * The shape of a secret rather than of a word: long, AND carrying something words in URLs do not
 * — a digit or a case change.
 *
 * Length alone was not enough once the search was correctly confined to the tail. `?cloudRoute=alerts`
 * and `/confirmation-page` are both long enough, and the old entropy test passed anything holding a
 * `-` or an `=`, so ordinary readable URLs still read as credentials.
 *
 * **A DIGIT OR ANY UPPERCASE LETTER, not "mixed case".** Mixed case was the first thing tried here
 * and the corpus caught it: a pinned case in the redaction corpus is
 * `…/session?t=SECRET-LOGIN-TOKEN`, an all-caps bearer token with no digit in it. Under a
 * mixed-case test that reached the model, which is the exact hole this rule exists to close. So
 * the test is the weaker one, and it is weaker in the fail-CLOSED direction: `confirmation-page`
 * and `manage-preferences` stay ordinary because URL prose is lower-case, while `SECRET-LOGIN-TOKEN`,
 * `8f3a9b2c1d4e5f6a` and `eyJhbGciOiJIUzI1NiIs` are all withheld.
 *
 * What it still costs: a ≥16-character camel-cased path segment reads as a token. That is the
 * residue of a rule that must not miss a credential, and it is a far narrower cost than the one
 * being removed — the marker alone used to be enough.
 */
const TOKEN_MIN = 16;
function looksLikeOpaqueToken(seg: string): boolean {
  if (seg.length < TOKEN_MIN) return false;
  return /[\dA-Z]/.test(seg);
}

/**
 * ── THE TOKEN IS LOOKED FOR AFTER THE MARKER, AND THAT IS THE WHOLE OF THIS FUNCTION ─────────
 *
 * The docblock above states that BOTH halves are required. For a long time the code did not
 * implement that, and the gap is worth writing down because it read as correct.
 *
 * It sliced the token search at `url.search(/[?&/]/) + 1` — the first `/`, `?` or `&` anywhere in
 * the match. For any `https://…` URL the first of those is the `/` at index 6, so the slice began
 * inside the scheme and **included the hostname**. `OPAQUE_TOKEN`'s alphabet contains `.` and `/`,
 * so a hostname like `app.netdata.cloud/sign-in` is itself a ≥12-character run, and the `.`
 * satisfies the entropy test on the next line. The token half was therefore satisfied by every
 * URL that reached it, and the predicate degenerated to "does this URL contain an auth-shaped
 * word" — no token required anywhere.
 *
 * What that cost: `no_ai` is set on any message containing a `/login`, `/signin`, `/confirm`,
 * `/verify`, `/reset` or `/invite` link, or a `?t=` / `?code=` parameter — which is ordinary bulk
 * marketing mail, footer unsubscribe links and discount codes. It reaches through HTML `href`
 * attributes too, so an invisible "Log in" button in a template was enough. A sender whose every
 * message carries such a link — a monitoring service that signs each mail `…/sign-in`, say — is
 * withheld from the model wholesale: it can never be suggested for, never drafted against, and its
 * bodies are stored redacted, none of which the message needed.
 *
 * The fix is to search the CAPTURED TAIL — what follows the marker — which is what "an
 * authentication-shaped URL carrying a token" meant all along. `/verify` with nothing after it is
 * a page; `/verify?token=<32 opaque characters>` is a credential.
 *
 * Deliberately NOT fixed here: the converse half, a genuine opaque token under a path this list
 * does not name (`/click/<token>`), still passes. That is a tightening rather than a correction,
 * it needs its own corpus evidence, and doing it in the same change would make this one's
 * before/after unreadable.
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
 * ── A LINK IN A DOCUMENT IS NOT A CREDENTIAL DELIVERED — THE INDETERMINATE ARM, GATED ────────
 *
 * {@link hasAuthUrlToken} answers "does an authentication-shaped URL carry an opaque token". That
 * is the right question for the outbound SINK — the last check before bytes leave for a model,
 * where over-refusing costs one redacted URL tail and under-refusing leaks a secret, so it must
 * stay as broad as it is and this function does NOT touch it. It is the WRONG question for
 * `classifySensitivity`'s indeterminate arm, which withholds the whole message from every model,
 * stores its body redacted, and (when it also matched a stale category) hides the rich body.
 *
 * ── WHAT WENT WRONG ──────────────────────────────────────────────────────────────────────────
 *
 * The token search runs over the whole visible text, so ANY authentication-shaped URL anywhere in
 * a message — a `Log in to manage your account` link in a receipt footer, an `unsubscribe?token=`
 * in a newsletter, a `/verify-email` tracker quoted three replies deep in a business thread — was
 * enough to route the message to the fail-closed bucket. Most mail that trips this carries no
 * credential the recipient could act on, and it falls into three classes the rule below tells apart:
 *   · a link to a LOGIN PAGE — `billing.stripe.com/p/login/<id>`, `track.toggl.com/login/?…`,
 *     `notion.so/login?utm_campaign=…`. You bring your OWN password to a login page; nothing
 *     secret is carried in the URL, and the opaque run after `/login` is a session id, a
 *     `returnTo` path or a campaign name.
 *   · a UTILITY endpoint — `/unsubscribe?token=…`, `/mailing_preferences?token=…`,
 *     `zendesk.com/attachments/token/<id>`, a MailStore archive `…/derefer/?url=…&token=<static>`
 *     (the same token rides every message from that sender — the archive's key, not the reader's),
 *     and an app's own `…/confirm_change_notification_category_setting?key=…`,
 *     `…/domain_user_profile_photo?key=…` and `…/log_view?dest=…` settings, avatar and click
 *     links. The token authorises unsubscribing, dereferencing an archived link, changing a
 *     setting or loading an avatar — never a login.
 *   · a QUOTED link — a reply thread whose firing URL sits in the HTML the reply quotes, below a
 *     `Von:`/`schrieb:` reply header, rather than in anything the reply itself delivers.
 *
 * ── THE GATE, AND WHY IT CANNOT WEAKEN THE BOUNDARY ──────────────────────────────────────────
 *
 * This is the same move as {@link schemeNameNearCode}: a signal that names a TOPIC or a
 * NAVIGATION target ("go to the login page", "manage your subscription") is not a credential and
 * fires only on real credential evidence. A URL is a credential DELIVERY when the token is the
 * operative payload — a credential NAMED as a query parameter ({@link AUTH_STRONG_PARAM}: `token`,
 * `key`, `code`, `magic`, `*_token`, … — never the tracking `t`/`tk`/`session`/`sso`), or the
 * segment following a credential-DELIVERY path marker ({@link AUTH_DELIVERY_PATH}: `verify`,
 * `reset`, `activate`, `confirm`, `auth`, … — never the `login`/`signin`/`session` PAGE markers).
 * A message that is short and link-dominated ({@link AUTH_LOW_PROSE}) is a delivery too, whatever
 * the marker — a bare magic/bearer link IS the message. A {@link AUTH_UTILITY_URL} endpoint and a
 * {@link inQuotedReply} link are never deliveries.
 *
 * It cannot open the hole this rule closes, and that is proven three ways rather than asserted:
 *   · the SINK is untouched. `screenOutboundText` still calls {@link hasAuthUrlToken} over the
 *     exact bytes about to reach a model, so a credential this arm now lets past — always a URL
 *     buried in a long document, never the short subject+snippet the sink screens — is still
 *     redacted out of the payload. This arm decides ROUTING and storage; the sink decides
 *     disclosure, and disclosure did not move.
 *   · every genuine fixture stays withheld. The fail-closed corpus's bare bearer link
 *     (`/session?t=SECRET-LOGIN-TOKEN`, body = the URL alone) fires via {@link AUTH_LOW_PROSE};
 *     the auth-URL corpus's magic-link/JWT/reset/`login_token` cases fire via delivery-path or
 *     strong-param. Both suites stay green, unmodified.
 *   · nothing with a delivery-shaped, non-utility, non-quoted URL flips to ordinary. What flips is
 *     login-page, utility or quoted; what stays withheld is a genuine credential delivery
 *     (verify/reset/activate/magic/invite/order-authenticate), with a small conservative tail (a
 *     community-invite link with a campaign token, a survey) left withheld rather than hand-excluded.
 *
 * Both mutations were watched to fail: forcing this predicate always-true reinstates the false
 * positives (the flip fixtures go red); forcing it always-false drops the genuine
 * deliveries (the keep fixtures go red).
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
 * ── THE SECOND BRANCH, AND WHY IT CANNOT USE `\b` ──────────────────────────────────────────
 *
 * The rule has two halves — never sent to a model, **and stored redacted.** A
 * vocabulary-framed Arabic-Indic code (`رمز التحقق ٠١٢٣٤٥`) has always classified `sensitive`
 * correctly, and then stored its code **in the clear**, because every alternative above is
 * ASCII-only.
 *
 * **`\b` cannot fix that, and fails SILENTLY.** `\b` is defined against `\w`, which is
 * `[A-Za-z0-9_]` even under the `u` flag — non-ASCII `\p{Nd}` are not `\w`, so the obvious
 * `\b(\p{Nd}{4,8})\b` matches **nothing at all** on a pure Arabic-digit run. Measured, not
 * assumed: it leaves `٠١٢٣٤٥` untouched. That is a guard reporting success while doing nothing,
 * which is this repo's most expensive recurring shape, so the boundary is written as explicit
 * lookarounds instead.
 *
 * The ASCII alternatives are **kept verbatim, with their original `\b`**, and the new branch is
 * purely ADDITIVE. Replacing the outer boundaries wholesale would have been stricter than `\b` in
 * one direction — `é123456` is redacted by `\b` and would not be by `(?<![\p{L}…])` — i.e. a
 * silent redaction regression in exchange for a tidier pattern. Verified byte-identical on twelve
 * ASCII cases including `é123456`, `x_123456`, `AB12 34CD` and `2026-08-03`.
 *
 * The `[A-Z0-9]` mixed-token alternatives stay ASCII deliberately: a mixed-script token is
 * `obfuscated`/`unsupported_script` territory upstream, not a redaction shape.
 */
const CODE =
  /\b([0-9]{4,8}|[A-Z0-9]{6,10}|[0-9]{3,4}[-\s][0-9]{3,4}|[A-Z0-9]{3,4}[-\s][A-Z0-9]{3,4})\b|(?<![\p{L}\p{Nd}_])(\p{Nd}{4,8}|\p{Nd}{3,4}[-\s]\p{Nd}{3,4})(?![\p{L}\p{Nd}_])/gu;

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
 * THE REDACTION, AS ONE FUNCTION — the transform that strips a credential VALUE out of a payload
 * bound for a MODEL. It is no longer applied to anything the user stores or reads.
 *
 * It was once used for BOTH the stored body and the model payload — one function so the two could
 * not drift. Storage redaction is gone (the mailbox already holds the mail unredacted, so hiding
 * the display copy only hid it from the user), so the ONLY callers now are the model gate:
 * {@link redactForModel} and the user-requested AI path. The credential a user sees is never
 * blanked; the credential a model sees always is.
 *
 * The order is load-bearing. {@link redactAuthUrls} runs FIRST, because it rewrites whole URL
 * tails; running {@link CODE} first would blank a digit run inside a token and leave the rest of
 * the token intact, which is a partially-redacted secret rather than a redacted one.
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
 * The LAST check before a payload is serialised for a model, called by the classifier's
 * parameter builder.
 *
 * The classifier is clean only under a CORRECT upstream decision: it carries no sensitivity flag
 * of its own, so it cannot catch an upstream false negative. This function is that flag. It
 * re-reads the payload that is about to leave, with the same local detector, and refuses.
 *
 * It screens on CONTENT ONLY — recognised authentication vocabulary, an unframed credential
 * shape, an authentication URL bearing a token — and NOT on `unsupported_script` or
 * `unrecognised_language`. Those are upstream routing decisions: a Japanese newsletter is
 * withheld from AI by `classifySensitivity`, and making the sink throw on any non-Latin payload
 * would break `ScreenerService` for every non-Latin sender without protecting anything. The
 * asymmetry is deliberate — the sink refuses what must never be sent, the upstream decides what
 * we are not sure about.
 */
/** What {@link redactForModel} hands back: the two fields to send, and whether it changed them. */
export interface ModelSafeText {
  subject: string;
  snippet: string;
  /** True ⇒ the screen fired and both fields were run through {@link redactSensitiveText}. */
  redacted: boolean;
}

/**
 * ── MAKE A PAYLOAD SENDABLE, FOR A CALLER WHOSE USER ASKED ───────────────────────────────────
 *
 * The AI-OPEN half of the sensitivity rule, as amended on 2026-08-08.
 * {@link screenOutboundText} answers "does this carry credential material"; this answers "then
 * what do I send", and the answer on a path a person pressed a button on is: the same bytes with
 * the credential VALUE removed. What is withheld from a model is the value, never the subject
 * matter — that a message concerns a password reset is not a secret, and it is exactly what the
 * user is paying the model to notice.
 *
 * ## It is CONDITIONAL, and that is the whole reason it is a function rather than two calls
 *
 * {@link CODE} contains `[A-Z0-9]{6,10}`, which matches `URGENT`, `WELCOME`, `REMINDER` and
 * `NEWSLETTER`, and any 4–8 digit run — an order number, a year range, a price. Its own docblock
 * says it is "only ever applied to mail already judged sensitive, so its breadth costs nothing on
 * ordinary mail", and that sentence is load-bearing: running it over every Screener row would
 * blank ordinary subjects and quietly degrade every suggestion in the product, for the 83% of
 * senders this ruling was never about. So the screen decides, per payload, whether the redactor
 * runs at all.
 *
 * ## It reads the BYTES, never `messages.no_ai`
 *
 * Two reasons, and the second is the stronger. The stored flag is known-wrong for historical rows
 * — an earlier version of this detector flagged mail it should not have, and a one-off repair pass
 * had to be written and run to correct thousands of them. And `messages.subject` is stored RAW even
 * for rows whose body was stored redacted, so a
 * decision keyed off the stored redaction state would miss the field the code is usually in. The
 * subject stays raw on disk deliberately: "Your code is 482913" is the single most useful subject
 * line in a mailbox and the message list must show it. Redaction for a model is a different
 * question from redaction for storage, asked at a different moment, over the same bytes.
 *
 * ## There is no residue check
 *
 * Redaction removes code-shaped and token-shaped runs. The detector also fires on authentication
 * VOCABULARY, which redaction cannot remove because words are not values. A "did it come out
 * clean" test would therefore refuse every password reset and every "verify your email" — the
 * exception the ruling removed, reinstated under a new name — so `redacted` is reported as a fact
 * and never used as a veto.
 */
export function redactForModel(subject: string, snippet: string): ModelSafeText {
  if (screenOutboundText(subject, snippet).safe) return { subject, snippet, redacted: false };
  const clean = (t: string): string => redactUrlTails(redactSensitiveText(t));
  return { subject: clean(subject), snippet: clean(snippet), redacted: true };
}

/**
 * ── THE CLICK-TRACKER HOLE, AND WHY THE MODEL PATH REDACTS MORE THAN STORAGE ─────────────────
 *
 * {@link redactAuthUrls} only rewrites a URL whose OWN path or query names an authentication
 * marker. Measured against the live account on 2026-08-08, before this shipped: a password-reset
 * mail from `app@thechosen.tv` carried its reset link as
 * `http://url7965.thechosen.tv/ls/click?upn=<base64 of the real URL>` — an ESP click-tracking
 * wrapper. `/ls/click` is not an authentication marker and `upn` is not an authentication
 * parameter, so the marker missed, the token survived, and the magic link would have gone to the
 * model intact. Ten of the previously-withheld senders had a run like this.
 *
 * It never mattered before because the old policy withheld the whole message on the VOCABULARY
 * match ("Reset password"), so nothing about the URL was reachable. Opening the path is what makes
 * the wrapper load-bearing, and a privacy page that says "the credential is removed before any AI
 * request is built" is only true if this is closed too.
 *
 * So on a payload the screen has ALREADY flagged, every opaque-looking run in the TAIL of every
 * URL is blanked, marker or no marker. The cost is stated rather than waved at: a long readable
 * path segment in a credential-bearing mail reads as a token and is blanked. That is the trade the
 * `OPAQUE_TOKEN` docblock already argues for — *"redaction runs only on a message ALREADY judged
 * to carry a credential, and its only error is blanking a few characters of a URL nobody will
 * read"*.
 *
 * **The HOST is kept**, deliberately. `thechosen.tv` is the single most useful routing signal in
 * the payload and it is not a secret; blanking it would protect nothing and make the suggestion
 * worse. Only what follows the authority is rewritten.
 *
 * **It is NOT applied to storage**, and that asymmetry is the conservative choice rather than an
 * oversight. `classifySensitivity`'s output is pinned by a corpus and is what a person reads in
 * their own client; widening it is a separate decision with its own before/after evidence. The
 * model path is allowed to be strictly more redacted than the stored one — never less.
 */
const URL_RUN = /https?:\/\/[^\s<>"')\]]+/gi;
/** Everything after the authority: the first `/`, `?` or `#` and onward. */
const URL_TAIL = /^(https?:\/\/[^/?#\s]*)([\s\S]*)$/i;
const TAIL_SEGMENT = /[A-Za-z0-9_\-.~+%=]{16,}/g;

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
    const c = categoryOf({ label: "outbound:decoded", raw: d, canonical: canonicalise(d) });
    if (c) return { safe: false, category: c, reason: "vocabulary" };
  }
  if (credentialShapeIn(rep)) {
    return { safe: false, category: null, reason: "credential_shape" };
  }
  if (hasAuthUrlToken(raw) || hasAuthUrlToken(canonical.plain)) {
    return { safe: false, category: null, reason: "auth_url_token" };
  }
  return { safe: true, category: null, reason: null };
}
