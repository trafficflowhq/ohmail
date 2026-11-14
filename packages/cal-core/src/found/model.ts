/**
 * A model asked about what the rules left as a guess. Here are the port it is asked through (no
 * transport, key or call), the fixed instruction, the closed answer schema, the one input that may
 * leave, and the check that turns an answer into a finding or drops it. An answer is never more than
 * a guess: its words must stand in the letter, and its day and time must follow from them.
 */
import { MAX_FOUND_DAYS_AHEAD, MAX_FOUND_SOURCE_WORDS_CHARS, MAX_FOUND_STEPS } from "../limits.js";
import { dayNumber, isValidDate, wallSeconds, weekdayOf } from "../time/arith.js";
import type { PlainDate, ZonedTime } from "../time/types.js";
import { formContextAt, readClockAt, readDayAt, type Clock } from "./grammar.js";
import { lexiconOf, type HalfWord } from "./lexicon.js";
import { clockKey, dayKey, lengthOf, timedEnd } from "./rules.js";
import { look, tokenize, tokenReader, type Token } from "./text.js";
import type {
  FoundAnchor,
  FoundAnswerCheck,
  FoundContext,
  FoundDropWord,
  FoundLanguage,
  FoundModelAnswer,
  FoundModelInput,
  FoundReading,
  WordSpan,
} from "./types.js";

/** The label the door's screen names this input by. */
export const FOUND_MODEL_LABEL = "found_event";

/** The instruction, the same for every account and letter. */
export const FOUND_EVENT_INSTRUCTION = /* @__PURE__ */ [
  "You read sentences from one email and find the one event its reader is asked to be at, if there is one.",
  "The user turn is JSON: letterDay (YYYY-MM-DD) and letterWeekday are the day the email was sent,",
  "language is the email's language, and text holds the sentences.",
  "Answer with JSON that matches the schema:",
  "- found: true for one event the reader is invited or asked to be at; false otherwise.",
  "- words: the words that give the event's day and time, copied from text character for character,",
  "  as one unbroken piece of it. Never change, add, drop or translate a character.",
  "- day: the event's day as YYYY-MM-DD, worked out from those words and from letterDay and letterWeekday.",
  "- start: the start on a 24-hour clock as HH:MM.",
  '- end: the end as HH:MM, or "" when the words give none.',
  "Answer found: false for a date something is due by (a payment, a renewal, a form), for two or more",
  "days or times to choose from, for anything in the past, and whenever you are not sure.",
  'When found is false, words, day, start and end are "".',
].join("\n");

/** The answer's schema: closed, every property required, nothing nullable. It holds no level: an answer is a guess. */
export const FOUND_EVENT_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["found", "words", "day", "start", "end"],
  properties: {
    found: { type: "boolean" },
    words: { type: "string" },
    day: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
  },
} as const;

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** The askable sentences joined: the one text that may leave, and the one the door screens. `null`: nothing to ask. */
export function foundModelText(reading: FoundReading): string | null {
  if (reading.anchor === null || reading.stoppedBy !== null || reading.askable.length === 0) return null;
  return reading.askable.map((s) => reading.text.slice(s.start, s.end)).join("\n");
}

/** The model's input, which exists only behind a screen that admitted `foundModelText`. */
export function foundModelInput(
  reading: FoundReading,
  screen: { readonly admitted: true },
): FoundModelInput | null {
  const admitted = (screen as { readonly admitted?: unknown } | null | undefined)?.admitted;
  if (admitted !== true) return null;
  const text = foundModelText(reading);
  if (text === null || reading.anchor === null) return null;
  const { letterDay, language } = reading.anchor;
  return {
    text,
    letterDay: dayKey(letterDay),
    letterWeekday: WEEKDAY_NAMES[weekdayOf(dayNumber(letterDay))]!,
    language,
  };
}

/** The user turn every transport sends: one JSON object, its keys in one order. */
export function foundModelUserTurn(input: FoundModelInput): string {
  return JSON.stringify({
    letterDay: input.letterDay,
    letterWeekday: input.letterWeekday,
    language: input.language,
    text: input.text,
  });
}

/* ── the check ──────────────────────────────────────────────────────────────────────────────────── */

const ANSWER_KEYS = ["found", "words", "day", "start", "end"];

function isAnswer(a: unknown): a is FoundModelAnswer {
  if (typeof a !== "object" || a === null || Array.isArray(a)) return false;
  const keys = Object.keys(a);
  if (keys.length !== ANSWER_KEYS.length || !ANSWER_KEYS.every((k) => keys.includes(k))) return false;
  const o = a as Record<string, unknown>;
  return typeof o.found === "boolean" && ANSWER_KEYS.slice(1).every((k) => typeof o[k] === "string");
}

const digitAt = (s: string, i: number): number => {
  const c = s.charCodeAt(i) - 48;
  return c >= 0 && c <= 9 ? c : NaN;
};

/** `YYYY-MM-DD` as a real date, or `null`. */
function dayOf(s: string): PlainDate | null {
  if (s.length !== 10 || s[4] !== "-" || s[7] !== "-") return null;
  const n = (from: number, to: number) => {
    let v = 0;
    for (let i = from; i < to; i += 1) v = v * 10 + digitAt(s, i);
    return v;
  };
  const year = n(0, 4);
  const month = n(5, 7);
  const day = n(8, 10);
  return isValidDate(year, month, day) ? { kind: "date", year, month, day } : null;
}

/** `HH:MM` on a 24-hour clock, or `null`. */
function clockOf(s: string): Clock | null {
  if (s.length !== 5 || s[2] !== ":") return null;
  const hour = digitAt(s, 0) * 10 + digitAt(s, 1);
  const minute = digitAt(s, 3) * 10 + digitAt(s, 4);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : null;
}

/** What the grammar reads in a quote: its days, the clock times it admits as a start and as an end, and a sign of a time. */
interface Quoted {
  readonly days: PlainDate[];
  readonly starts: Clock[];
  readonly ends: Clock[];
  sign: boolean;
  /** A clock in the quote names another zone: its time is not on the person's clock. */
  otherZone: boolean;
}

function readQuote(words: string, language: FoundLanguage, letterDay: PlainDate): Quoted {
  const left = { steps: MAX_FOUND_STEPS };
  const r = tokenReader(tokenize(words, left), left);
  const lex = lexiconOf(language);
  const q: Quoted = { days: [], starts: [], ends: [], sign: false, otherZone: false };
  let before: Token | undefined;
  let halfAt = -1_000;
  let half: HalfWord | null = null;
  for (let i = 0; i < r.tokens.length;) {
    const t = look(r, i)!;
    const c = formContextAt(r, lex, letterDay, i, before, i - halfAt <= 3 ? half : null);
    const named = t.kind === "word" ? lex.halves.get(t.low) : undefined;
    if (named !== undefined) [halfAt, half] = [i, named];
    const day = readDayAt(c, i);
    const clock = day === null ? readClockAt(c, i) : null;
    if (day !== null) q.days.push(...day.days);
    if (clock?.otherZone === true) q.otherZone = true;
    if (clock !== null && clock.passed === null) {
      const halves = clock.eitherHalf
        ? [clock.at, { hour: (clock.at.hour + 12) % 24, minute: clock.at.minute }]
        : [clock.at];
      q.starts.push(...halves);
      if (clock.end !== null) q.ends.push(clock.end);
    }
    const low = t.low;
    if (
      t.kind === "num" ||
      lex.timeWords.has(low) ||
      lex.numberWords.has(low) ||
      low === "uhr" ||
      low === "clock"
    )
      q.sign = true;
    const next = day?.next ?? clock?.next ?? i + 1;
    before = r.tokens[next - 1];
    i = next;
  }
  q.ends.push(...q.starts);
  return q;
}

const sameClock = (a: Clock, b: Clock): boolean => a.hour === b.hour && a.minute === b.minute;

/** Where the quote stands in an askable sentence, character for character; `null` when it stands in none. */
function placeOf(words: string, reading: FoundReading): WordSpan | null {
  for (const s of reading.askable) {
    const at = reading.text.slice(s.start, s.end).indexOf(words);
    if (at >= 0) return { start: s.start + at, end: s.start + at + words.length };
  }
  return null;
}

const drop = (dropped: FoundDropWord): FoundAnswerCheck => ({ ok: false, dropped });

/**
 * A model's answer, checked against the letter: shape, words, day, time, then the reading time. A
 * finding made from it is a guess and a proposal, whatever the answer says.
 */
export function checkFoundAnswer(
  answer: unknown,
  reading: FoundReading,
  context: FoundContext,
): FoundAnswerCheck {
  if (!isAnswer(answer)) return drop("malformed");
  if (!answer.found) return drop("none_found");
  const words = answer.words;
  if (words.length === 0 || words.length > MAX_FOUND_SOURCE_WORDS_CHARS) return drop("words_not_in_letter");
  const span = placeOf(words, reading);
  const anchor: FoundAnchor | null = reading.anchor;
  if (span === null || anchor === null)
    return drop(reading.text.includes(words) ? "not_asked" : "words_not_in_letter");
  const quoted = readQuote(words, anchor.language, anchor.letterDay);
  const day = dayOf(answer.day);
  if (day === null || !quoted.days.some((d) => dayNumber(d) === dayNumber(day)))
    return drop("day_not_in_words");
  if (answer.start === "") return drop("no_time");
  const start = clockOf(answer.start);
  if (start === null || quoted.otherZone) return drop("time_not_in_words");
  if (quoted.starts.length > 0 ? !quoted.starts.some((c) => sameClock(c, start)) : !quoted.sign)
    return drop("time_not_in_words");
  const wall = {
    year: day.year,
    month: day.month,
    day: day.day,
    hour: start.hour,
    minute: start.minute,
    second: 0,
  };
  if (wallSeconds(wall) < wallSeconds(anchor.nowWall)) return drop("passed");
  if (dayNumber(day) - dayNumber(anchor.letterDay) > MAX_FOUND_DAYS_AHEAD) return drop("far_ahead");
  const given = clockOf(answer.end);
  const endGiven =
    given !== null &&
    given.hour * 60 + given.minute > start.hour * 60 + start.minute &&
    quoted.ends.some((c) => sameClock(c, given));
  const startTime: ZonedTime = { kind: "zoned", wall, tzid: context.zone };
  const end = timedEnd(
    startTime,
    endGiven ? { ...wall, hour: given.hour, minute: given.minute } : null,
    lengthOf(context),
    context.zones,
  );
  return {
    ok: true,
    finding: {
      key: `${dayKey(day)}T${clockKey(start.hour, start.minute)}`,
      level: "guess",
      kind: "proposal",
      evidence: "sentence_model",
      event: { start: startTime, end, endGiven },
      free: false,
      words: [span],
    },
  };
}
