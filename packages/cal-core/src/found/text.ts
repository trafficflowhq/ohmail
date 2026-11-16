/**
 * The text a letter is read in, and its tokens. One text for the rules and the model alike: the
 * subject unless it is an earlier letter's, then the letter's own lines up to the first quoted one.
 * Tokens are cut by one loop over character codes; no pattern runs.
 */
import { MAX_FOUND_SUBJECT_CHARS, MAX_FOUND_TOKEN_CHARS } from "../limits.js";
import type { StepsLeft } from "../time/types.js";
import { DEFAULT_FOUND_LIMITS, type FoundLetter, type FoundLimits } from "./types.js";

/** Thrown when a reading's steps are spent; caught only where the reading began. */
export class FoundStepsSpent extends Error {
  constructor() {
    super("found: the reading's steps are spent");
  }
}

/** Takes one step, or ends the reading when none is left or a zone source left its work unpaid. */
export function spend(left: StepsLeft): void {
  left.steps -= 1;
  if (left.steps < 0 || left.unpaid === true) throw new FoundStepsSpent();
}

const REPLY_PREFIXES = ["re:", "aw:", "fwd:", "fw:", "wg:", "antw:"];

const replyPrefixOf = (subject: string): number => {
  const head = subject.slice(0, 6).toLowerCase();
  for (const prefix of REPLY_PREFIXES) if (head.startsWith(prefix)) return prefix.length;
  return 0;
};

/** Is this subject an earlier letter's, as a reply or a forward carries it? */
export const isReplySubject = (subject: string): boolean => replyPrefixOf(subject.trimStart()) > 0;

/** The subject without its reply and forward prefixes, as a title. */
export function subjectTitle(subject: string, maxChars: number): string {
  let rest = subject.slice(0, maxChars + 64).trim();
  // Each turn takes three characters or more off, so the loop ends.
  for (let cut = replyPrefixOf(rest); cut > 0; cut = replyPrefixOf(rest)) rest = rest.slice(cut).trimStart();
  return cutWhole(rest, maxChars).trimEnd();
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * At most `maxChars` UTF-16 units of a text that a store can hold: a pair cut by the ceiling loses its
 * first half, and a half that stands alone in the text becomes U+FFFD. A JSON column refuses a lone half.
 */
export function cutWhole(s: string, maxChars: number): string {
  const cut =
    s.length > maxChars ? s.slice(0, isHigh(s.charCodeAt(maxChars - 1)) ? maxChars - 1 : maxChars) : s;
  let out = "";
  let from = 0;
  for (let i = 0; i < cut.length; i += 1) {
    const c = cut.charCodeAt(i);
    if (isHigh(c) && i + 1 < cut.length && isLow(cut.charCodeAt(i + 1))) i += 1;
    else if (isHigh(c) || isLow(c)) {
      out += `${cut.slice(from, i)}\ufffd`;
      from = i + 1;
    }
  }
  return from === 0 ? cut : out + cut.slice(from);
}

const QUOTE_HEAD_STARTS = ["sent:", "gesendet:"];
const FROM_STARTS = ["from:", "von:"];
const HEAD_FIELDS = ["sent:", "date:", "to:", "gesendet:", "datum:", "an:"];

const startsWithAny = (line: string, starts: readonly string[]): boolean => {
  const head = line.trimStart().slice(0, 10).toLowerCase();
  return starts.some((s) => head.startsWith(s));
};

/** Has this text an ASCII letter? */
function hasLetter(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i) | 32;
    if (c >= 97 && c <= 122) return true;
  }
  return false;
}

/**
 * A line that begins a quoted letter: "… wrote:", "Am … schrieb Lea:", "-----Original Message-----",
 * "Von: Lea …". A rule of dashes alone, or "From: 10:00" in an event's own lines, is none.
 */
function isQuoteHead(line: string, nextLine: string): boolean {
  const lead = line.trimStart();
  if (lead.startsWith("-----")) return hasLetter(lead);
  if (startsWithAny(lead, QUOTE_HEAD_STARTS)) return true;
  if (startsWithAny(lead, FROM_STARTS)) {
    const rest = lead.slice(lead.indexOf(":") + 1).trimStart();
    const digit = rest.charCodeAt(0) >= 48 && rest.charCodeAt(0) <= 57;
    return !digit || startsWithAny(nextLine, HEAD_FIELDS);
  }
  const tail = lead.trimEnd();
  if (!tail.endsWith(":")) return false;
  const low = tail.toLowerCase();
  if (low.endsWith("wrote:") || low.endsWith("schrieb:")) return true;
  // A head wrapped by its mail program: "Am … schrieb Lea Brunner <lea@…>:", "<lea@…>:" on a line of its own.
  if (low.includes(" schrieb ") || low.includes(" wrote") || low.startsWith("schrieb ")) return true;
  return low.startsWith("<") && low.endsWith(">:");
}

/** A kept line that a wrapped quote head began: "On Tue, 10 Nov 2026 at 15:05 Lea …", "Am … um 15:05". */
const beganHead = (line: string): boolean => {
  const lead = line.trimStart();
  return lead.startsWith("On ") || lead.startsWith("Am ");
};

/** The one text a letter is read in, rules and model alike. Offsets of a reading index this text. */
export function foundLetterText(letter: FoundLetter, limits: FoundLimits = DEFAULT_FOUND_LIMITS): string {
  const subject = letter.subject.slice(0, MAX_FOUND_SUBJECT_CHARS);
  const kept: string[] = [isReplySubject(subject) ? "" : subject.trim()];
  const body = letter.body.slice(0, limits.maxTextChars);
  const lineAt = (from: number): { line: string; next: number } => {
    const cut = body.indexOf("\n", from);
    const end = cut === -1 ? body.length : cut;
    const line = body.charCodeAt(end - 1) === 13 ? body.slice(from, end - 1) : body.slice(from, end);
    return { line, next: end + 1 };
  };
  let at: { line: string; next: number } | null = lineAt(0);
  while (at !== null) {
    const after: { line: string; next: number } | null = at.next <= body.length ? lineAt(at.next) : null;
    if (isQuoteHead(at.line, after?.line ?? "")) {
      if (kept.length > 1 && beganHead(kept[kept.length - 1]!)) kept.pop();
      break;
    }
    if (!at.line.trimStart().startsWith(">")) kept.push(at.line);
    at = after;
  }
  return kept.join("\n");
}

/* ── tokens ─────────────────────────────────────────────────────────────────────────────────────── */

export type TokenKind = "word" | "num" | "mark" | "break" | "opaque";

export interface Token {
  readonly kind: TokenKind;
  readonly start: number;
  readonly end: number;
  /** Lower case for a word, the digits of a number, the character of a mark; for lookup only. */
  readonly low: string;
  /** A number's value; `NaN` for the rest. */
  readonly value: number;
  /** A word that begins with a capital letter. */
  readonly capital: boolean;
}

const SPACE = 0;
const LETTER = 1;
const DIGIT = 2;
const BREAK = 3;
const MARK = 4;

function classOf(c: number): number {
  if (c >= 48 && c <= 57) return DIGIT;
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return LETTER;
  if (c === 10 || c === 0x2028 || c === 0x2029) return BREAK;
  if (c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0xfeff || c === 0x3000) return SPACE;
  if ((c >= 0x2000 && c <= 0x200d) || c === 0x202f || c === 0x205f) return SPACE;
  if (c < 0xc0 || c === 0xd7 || c === 0xf7) return MARK;
  if (c >= 0x2000 && c <= 0x2bff) return MARK; // punctuation, currency, arrows, symbols
  if (c >= 0xd800 && c <= 0xdfff) return MARK; // a pictograph's halves
  return LETTER; // Latin letters with marks, combining marks, other scripts
}

/** The tokens of a text, each character passed once and paid for. */
export function tokenize(text: string, left: StepsLeft): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const cls = classOf(text.charCodeAt(i));
    const start = i;
    spend(left);
    i += 1;
    if (cls === SPACE) continue;
    if (cls === BREAK || cls === MARK) {
      tokens.push({
        kind: cls === BREAK ? "break" : "mark",
        start,
        end: i,
        low: text[start]!,
        value: NaN,
        capital: false,
      });
      continue;
    }
    while (i < text.length && classOf(text.charCodeAt(i)) === cls) {
      spend(left);
      i += 1;
    }
    if (i - start > MAX_FOUND_TOKEN_CHARS)
      tokens.push({ kind: "opaque", start, end: i, low: "", value: NaN, capital: false });
    else if (cls === DIGIT) {
      const digits = text.slice(start, i);
      tokens.push({ kind: "num", start, end: i, low: digits, value: Number(digits), capital: false });
    } else {
      const first = text[start]!;
      tokens.push({
        kind: "word",
        start,
        end: i,
        low: text.slice(start, i).normalize("NFC").toLowerCase(),
        value: NaN,
        capital: first !== first.toLowerCase(),
      });
    }
  }
  return tokens;
}

/**
 * The tokens a reading walks. Every look at a token is a step, ahead of the walk or behind it, so the
 * count of steps bounds the work a reading does, whatever a form reads.
 */
export interface TokenReader {
  readonly tokens: readonly Token[];
  readonly left: StepsLeft;
}

export const tokenReader = (tokens: readonly Token[], left: StepsLeft): TokenReader => ({ tokens, left });

export function look(r: TokenReader, i: number): Token | undefined {
  spend(r.left);
  return i < 0 || i >= r.tokens.length ? undefined : r.tokens[i];
}

/** Two tokens with nothing between them: "21" and "st" in "21st". */
export const joined = (a: Token | undefined, b: Token | undefined): boolean =>
  a !== undefined && b !== undefined && a.end === b.start;
