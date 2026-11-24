import type { NormalizedMessage } from "./types.js";
import { CONFUSABLES, CONFUSABLE_RE, INVISIBLE, INVISIBLE_CLASS, SOFT_HYPHEN } from "./text-fold.js";

/** Classify mail locally for sensitivity labels, filing, and forwarding behavior. */
export type SensitivityCategory = "otp" | "verification" | "password_reset" | "security_alert";

/**
 * The genuine third outcome. `sensitive` remains "positively identified", so routing and `no_forward` keep their old meaning; `indeterminate` is "we cannot support the negative
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
   * flags and `sensitivity_category`, and no column records the indeterminate reason, so the
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
   * remains is the local classification and its persisted flags.
   */
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 1. SECURITY CANONICAL FORM — applied BEFORE any matching (the encoded-content case)
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The invisible class, the soft hyphen and the homoglyph table live in the import-free
 * `text-fold.ts` leaf, which the brand check folds with too. The obfuscation SHAPE stays here:
 * an invisible character wedged between two letters.
 */
const INVISIBLE_IN_WORD = new RegExp(`\\p{L}[${INVISIBLE_CLASS}]\\p{L}`, "u");

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

/** The tags that end a line on the screen; any other tag, and any line break in the source, is a space. */
const HTML_LINE_TAG =
  /<\/?(?:address|article|aside|blockquote|br|caption|center|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|tfoot|thead|tr|ul)\b[^>]*>/gi;

/**
 * An HTML part laid out in the lines a reader sees: a block or a table ROW is a line, and the cells
 * of one row share it. {@link visibleTextFromHtml} keeps the source's own line breaks instead, so a
 * label cell and its value on two source lines read there as two lines, and a minified part as one.
 */
function htmlLayoutLines(html: string): string {
  return decodeEntities(html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/\s+/g, " ")
    .replace(HTML_LINE_TAG, "\n")
    .replace(/<[^>]*>/g, " "));
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
      // Undecodable base64 reads as empty; the declared-block arm below still counts the run.
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
    // Account security notices for failed sign-in, failed second factor and a completed password change.
    `\\bfailed\\s+sign[-\\s]?in\\s+attempts\\s+on\\s+your\\b|\\bfehlgeschlagene\\s+anmeldeversuche\\s+bei\\s+deinem\\b`,
    `\\bpassword\\s+was\\s+used,?\\s+and\\s+the\\s+second\\s+step\\s+failed\\b|\\bpasswort\\s+wurde\\s+benutzt,?\\s+und\\s+der\\s+zweite\\s+schritt\\s+schlug\\s+fehl\\b`,
    `\\byour\\s+(?:ohmail\\s+)?password\\s+was\\s+changed\\b|\\bdein\\s+(?:ohmail-)?passwort\\s+wurde\\s+ge[äa]ndert\\b`,
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
  "reward|rewards|loyalty|membership|booking|reservation|reference|invoice|quote|sort|tax";
const COMMERCE_BEFORE = new RegExp(`\\b(?:${COMMERCE_QUALIFIER})\\s+\\w*$`, "i");
/** The same family where the qualifier FOLLOWS the noun: `codice cliente`, `code client`, `code postal`. */
const COMMERCE_AFTER = /^[\s:-]*(?:cliente|client|fiscale|postale|postal)\b/i;

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
/** A spaced/dashed group of 2–4-digit chunks — the `44 12 90` shape; decimals after it make an amount. */
const GROUPED_LOOSE_RUN = /(?<![\p{L}\d#+])\d{2,4}(?:[ -]\d{2,4}){1,3}(?![.,]?\d)/gu;
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
    const after = numeric.slice(m.index + m[0].length, m.index + m[0].length + 16);
    if (!COMMERCE_BEFORE.test(before) && !COMMERCE_AFTER.test(after)) return true;
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
    if (hasCredentialCue(window, "")) return true;
  }
  // `TAN` is case-sensitive, so it is read on the cased form in that form's OWN windows. Handed the
  // whole of `raw`, one "TAN" anywhere paired with every IBAN group in a bank letter.
  if (!TAN_ACRONYM.test(raw)) return false;
  const cased = foldDigits(raw);
  return codeRunSpans(cased).some(([start, end]) =>
    TAN_ACRONYM.test(cased.slice(Math.max(0, start - CODE_PROXIMITY), end + CODE_PROXIMITY)));
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
 * 8. THE DECISION
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/** One human-visible representation of the message, canonicalised and ready to match. */
interface Representation {
  label: string;
  canonical: Canonical;
  /** The raw (pre-canonical) text, for the shape rules that care about case and layout. */
  raw: string;
  /** The HTML part's markup, laid out only where a rule reads lines ({@link cueBackedByCode}). */
  markup?: string;
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

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 8a. A CUE IS A MENTION UNLESS THE MESSAGE BACKS IT
 * ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Under this many prose words (URLs removed) a notice may NAME a credential without showing it:
 * "Your PIN" / "Keep this to yourself" (every such positive the tests pin is 9–25 words). At any
 * greater length a cue counts only when the message backs it: the subject names it, a code stands
 * beside it or alone on a line ({@link cueBackedByCode}), or an auth link delivers a token. A tax
 * return says "Zugangscode" and "bestätigen Sie Ihre" and backs neither; a bank's code mail under a
 * 300-word footer backs its cue with the code.
 */
const SHORT_NOTICE_WORDS = 40;
const PROSE_URL = /https?:\/\/[^\s<>"')\]]+/gi;

/** Subject plus the longer body alternative: text and HTML carry the same words, counted once. */
function noticeWords(subject: string, text: string, htmlText: string): number {
  const n = (s: string): number => words(s.replace(PROSE_URL, " ")).length;
  return n(subject) + Math.max(n(text), n(htmlText));
}

/** A code-shaped token: a digit run {@link codeRunSpans} admits, or a letters-and-digits token. */
const MIXED_ALNUM_TOKEN =
  /(?<![A-Za-z0-9_])(?=[A-Za-z0-9]{4,12}(?![A-Za-z0-9_]))(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{4,12}/g;

function codeSpans(s: string): Array<[number, number]> {
  const spans = codeRunSpans(s);
  for (const m of s.matchAll(MIXED_ALNUM_TOKEN)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/** The vocabulary again as global matchers, for where each cue STANDS rather than whether it does. */
const CUE_AT = {
  otp: new RegExp(OTP.source, "gi"), world: new RegExp(WORLD_OTP.source, "gi"), pin: /\bPIN\b/g,
  password_reset: new RegExp(RESET.source, "gi"), verification: new RegExp(VERIFY.source, "gi"),
  security_alert: new RegExp(ALERT.source, "gi"),
};

function cueBackedByCode(rep: Representation, category: SensitivityCategory): boolean {
  const numeric = rep.canonical.numeric;
  const lines = rep.markup === undefined ? numeric : canonicalise(htmlLayoutLines(rep.markup)).numeric;
  if (lines.split("\n").some((line) => TOKEN_ONLY.test(line))) return true;
  const forms: Array<[RegExp, string]> = category === "otp"
    ? [[CUE_AT.otp, numeric], [CUE_AT.world, foldDigits(rep.canonical.plain)], [CUE_AT.pin, foldDigits(rep.raw)]]
    : [[CUE_AT[category], numeric]];
  if (category === "otp" && schemeNameNearCode(proseOnly(numeric))) return true;
  for (const [re, form] of forms) {
    const spans = codeSpans(form);
    if (spans.length === 0) continue;
    for (const m of proseOnly(form).matchAll(re)) {
      const from = m.index - CODE_PROXIMITY;
      const to = m.index + m[0].length + CODE_PROXIMITY;
      if (spans.some(([start, end]) => start <= to && end >= from)) return true;
    }
  }
  return false;
}

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
  // The parse's own text: the html's words are read from the html below, and counted once.
  const own = msg.ownText ?? msg.textBody ?? "";
  const text = cap(own, "text");
  const htmlRaw = msg.htmlBody ?? "";
  const markup = htmlRaw ? cap(htmlRaw, "html") : "";
  const htmlText = markup ? cap(visibleTextFromHtml(markup), "html-text") : "";
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
  if (htmlText) reps.push({ label: "html", raw: htmlText, canonical: canonicalise(htmlText), markup });
  if (filenames) reps.push({ label: "attachments", raw: filenames, canonical: canonicalise(filenames) });
  decoded.forEach((d, i) => reps.push({ label: `decoded:${i}`, raw: d, canonical: canonicalise(d) }));

  // Prose density for the auth-URL gate: URL-stripped words across every human-visible field. A
  // message dominated by a link is a credential DELIVERY; a document that merely CONTAINS a link
  // is prose whose incidental login/tracking URL is not a credential. See {@link authCredentialUrlIn}.
  const lowProse =
    words(`${subject}\n${text}\n${htmlText}`.replace(/https?:\/\/[^\s<>"')\]]+/gi, " ")).length
    < AUTH_LOW_PROSE;

  // ── The UNION is the positive answer (the HTML-only case): a match in ANY representation is a
  // match, once the message backs its cue (section 8a) ──────────────────────────────────────
  const short = noticeWords(subject, text, htmlText) < SHORT_NOTICE_WORDS;
  let delivered: boolean | undefined;
  const deliversLink = (): boolean => (delivered ??= reps.some((r) =>
    authCredentialUrlIn(r.raw, lowProse) || authCredentialUrlIn(r.canonical.plain, lowProse)));
  const hits = new Set<SensitivityCategory>();
  for (const rep of reps) {
    const c = categoryOf(rep);
    if (c && (short || rep.label === "subject" || cueBackedByCode(rep, c) || deliversLink())) hits.add(c);
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
    if (!anyScannable && (htmlRaw.length > 0 || (msg.attachments ?? []).length > 0 || own.length > 0)) {
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
  // Persist the sensitivity flags for existing wire and store consumers.
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
