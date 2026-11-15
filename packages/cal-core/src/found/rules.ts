/**
 * Events found in a letter's words, by rules. One pass over the tokens cuts them into sentences;
 * in each, the days and clock times are read as they come, a clock is paired with the day beside it,
 * and the sentence is decided once at its end. Then the letter's sentences are weighed together:
 * one finding at most, or the word for why nothing is offered.
 */
import {
  MAX_FOUND_ASK_CHARS,
  MAX_FOUND_ASKS,
  MAX_FOUND_DAYS_AHEAD,
  MAX_FOUND_GAP_TOKENS,
} from "../limits.js";
import { dateOf, dayNumber, wallIn, wallSeconds, weekdayOf } from "../time/arith.js";
import { addDuration } from "../time/duration.js";
import type { PlainDate, StepsLeft, Wall, ZonedTime, ZoneSource } from "../time/types.js";
import {
  formContextAt,
  readClockAt,
  readDayAt,
  type ClockMatch,
  type DayMatch,
  type FormContext,
} from "./grammar.js";
import { lexiconOf, type HalfWord, type Lexicon } from "./lexicon.js";
import {
  FoundStepsSpent,
  foundLetterText,
  joined,
  look,
  spend,
  tokenize,
  tokenReader,
  type Token,
  type TokenReader,
} from "./text.js";
import {
  DEFAULT_FOUND_LIMITS,
  FOUND_DEFAULT_LENGTH_MINUTES,
  FOUND_LANGUAGES,
  type Finding,
  type FoundAnchor,
  type FoundContext,
  type FoundLanguage,
  type FoundLetter,
  type FoundLimits,
  type FoundReading,
  type NotOffered,
  type NotOfferedWord,
  type WordSpan,
  type WordsKind,
  type WordsLevel,
} from "./types.js";

/** A day the words name, with the clock beside it. */
interface Said {
  readonly day: DayMatch;
  clock: ClockMatch | null;
}

/** A sentence's outcome: a level on a day, or a word for why not. */
type Outcome =
  | { readonly level: WordsLevel; readonly day: PlainDate; readonly said: Said }
  | { readonly why: NotOfferedWord; readonly said: Said };

type Level = Extract<Outcome, { level: WordsLevel }>;
type Refusal = Extract<Outcome, { why: NotOfferedWord }>;

interface Survivor {
  readonly level: WordsLevel;
  readonly day: PlainDate;
  readonly said: Said;
  readonly kind: WordsKind;
}

interface Sentence {
  readonly first: number;
  last: number;
  firstDay: PlainDate | null;
  twoDates: boolean;
  due: boolean;
  past: boolean;
  ticket: boolean;
  delivery: boolean;
  timeSign: boolean;
  hasClock: boolean;
  /** A clock in it named another zone: nothing in it is asked. */
  otherZone: boolean;
  /** German "läuft" stood in it: with "ab" last, a date something is due. */
  dueVerb: boolean;
  /** "was", "war" stood in it: a lone weekday or relative day is asked, never guessed. */
  was: boolean;
  /** German "fällt" stood in it: with "aus" last, a cancelled event. */
  cancelVerb: boolean;
  /** A word that names a half of the day stood in it, away from any clock. */
  halfSeen: boolean;
  lastDayNext: number;
  lastPartialNext: number;
  pending: Said | null;
  spare: ClockMatch | null;
  best: Level | null;
  refusal: Refusal | null;
  spans: WordSpan[];
}

const newSentence = (first: number): Sentence => ({
  first,
  last: first - 1,
  firstDay: null,
  twoDates: false,
  due: false,
  past: false,
  ticket: false,
  delivery: false,
  timeSign: false,
  hasClock: false,
  otherZone: false,
  dueVerb: false,
  cancelVerb: false,
  was: false,
  halfSeen: false,
  lastDayNext: -1_000,
  lastPartialNext: -1_000,
  pending: null,
  spare: null,
  best: null,
  refusal: null,
  spans: [],
});

const sameDay = (a: PlainDate, b: PlainDate): boolean => dayNumber(a) === dayNumber(b);
const isLevel = (o: Outcome): o is Level => "level" in o;
const rank = (level: WordsLevel): number => (level === "dated" ? 2 : 1);
/** Higher level first; at one level a time beside the day before none. */
const better = (a: { level: WordsLevel; said: Said }, b: { level: WordsLevel; said: Said }): boolean =>
  rank(a.level) > rank(b.level) ||
  (rank(a.level) === rank(b.level) && a.said.clock !== null && b.said.clock === null);

interface Walk {
  readonly r: TokenReader;
  readonly lex: Lexicon;
  readonly anchor: FoundAnchor;
  readonly survivors: Survivor[];
  readonly notOffered: NotOffered[];
  readonly asks: WordSpan[];
  /** Opening hours began ("Öffnungszeiten", "Opening hours"): no weekday is guessed after it. */
  hours: boolean;
}

function spanOf(r: TokenReader, start: number, next: number): WordSpan {
  return { start: r.tokens[start]!.start, end: r.tokens[next - 1]!.end };
}

function saidSpans(r: TokenReader, said: Said): WordSpan[] {
  const day = spanOf(r, said.day.start, said.day.next);
  if (said.clock === null) return [day];
  const clock = spanOf(r, said.clock.start, said.clock.next);
  return clock.start < day.start ? [clock, day] : [day, clock];
}

/**
 * One day and its clock, judged in order: a reading that cannot be settled, a weekday that disagrees,
 * another zone, then the level, then the reading time and the reach ahead.
 */
function judge(w: Walk, said: Said): Outcome {
  const { day, clock } = said;
  if (day.form === "ambiguous_date") return { why: "ambiguous_date", said };
  if (day.form === "next_weekday") return { why: "ambiguous_day", said };
  if (day.form === "whole" && day.written !== null && day.written !== weekdayOf(dayNumber(day.days[0]!)))
    return { why: "weekday_disagrees", said };
  if (clock?.otherZone === true) return { why: "other_zone", said };
  let level: WordsLevel;
  if (day.form === "whole") {
    if (day.written === null && clock === null) return { why: "bare_date", said };
    level = "dated";
  } else {
    if (clock === null) return { why: "weekday_no_time", said };
    level = "guess";
  }
  if (clock?.capGuess === true) level = "guess";
  const on = day.days[0]!;
  const passed =
    clock === null
      ? dayNumber(on) < dayNumber(w.anchor.today)
      : wallSeconds(wallOf(on, clock.at.hour, clock.at.minute)) < wallSeconds(w.anchor.nowWall);
  if (passed) return { why: "passed", said };
  if (dayNumber(on) - dayNumber(w.anchor.letterDay) > MAX_FOUND_DAYS_AHEAD) return { why: "far_ahead", said };
  return { level, day: on, said };
}

const wallOf = (d: PlainDate, hour: number, minute: number): Wall => ({
  year: d.year,
  month: d.month,
  day: d.day,
  hour,
  minute,
  second: 0,
});

function settle(w: Walk, s: Sentence): void {
  if (s.pending === null) return;
  // A range passed over stands where the day's clock would: the day is the whole day, never a later clock.
  const o = judge(w, s.pending.clock?.passed === "range" ? { day: s.pending.day, clock: null } : s.pending);
  s.pending = null;
  if (isLevel(o)) {
    if (s.best === null || better(o, s.best)) s.best = o;
  } else if (s.refusal === null) s.refusal = o;
}

function addDay(w: Walk, s: Sentence, day: DayMatch, dueBefore: boolean): void {
  if (day.form === "nothing") return;
  const near = (next: number) => day.start - next <= MAX_FOUND_GAP_TOKENS;
  if (s.spans.length < 2) s.spans.push(spanOf(w.r, day.start, day.next));
  if (day.form === "partial") {
    if (near(s.lastDayNext)) s.twoDates = true;
    s.lastPartialNext = day.next;
    return;
  }
  if (near(s.lastPartialNext) || day.form === "range") s.twoDates = true;
  if (day.form !== "next_weekday" && day.form !== "ambiguous_date" && day.form !== "range") {
    const on = day.days[0]!;
    if (s.firstDay === null) s.firstDay = on;
    else if (!sameDay(s.firstDay, on)) s.twoDates = true;
  }
  if (dueBefore) s.due = true;
  settle(w, s);
  s.lastDayNext = day.next;
  const spare = s.spare;
  s.pending = { day, clock: spare !== null && day.start - spare.next <= MAX_FOUND_GAP_TOKENS ? spare : null };
  if (s.pending.clock !== null) s.spare = null;
}

function addClock(s: Sentence, clock: ClockMatch): void {
  s.hasClock = true;
  if (clock.otherZone) s.otherZone = true;
  const p = s.pending;
  if (p !== null && p.clock === null && clock.start - p.day.next <= MAX_FOUND_GAP_TOKENS) p.clock = clock;
  else s.spare = clock;
}

/**
 * A range passed over beside the day takes the place of its clock, so that no other clock does: after
 * the day, and before it too ("Workshop 9 – 12 Uhr am Samstag, …, Apéro 17 Uhr" is the whole day, never
 * 17:00), where it waits for the day as a clock would.
 */
function passClock(s: Sentence, clock: ClockMatch): void {
  const p = s.pending;
  if (p !== null && p.clock === null && clock.start - p.day.next <= MAX_FOUND_GAP_TOKENS) p.clock = clock;
  else s.spare = clock;
}

function kindOf(s: Sentence, level: WordsLevel): WordsKind {
  if (level === "guess") return "proposal";
  if (s.delivery) return "delivery";
  return s.ticket ? "ticket" : "appointment";
}

/** Decides a sentence, once, at its end. */
function close(w: Walk, s: Sentence): void {
  spend(w.r.left);
  settle(w, s);
  // "Breakfast is at 8:30 and the evening is free": an hour a half-of-day word could move, with such a
  // word elsewhere in the sentence, is read neither way. The day stands; the time is not read.
  const unsure = s.best?.said.clock;
  if (s.halfSeen && unsure?.shiftable === true) {
    const o = judge(w, { day: s.best!.said.day, clock: null });
    s.best = isLevel(o) ? o : null;
    if (!isLevel(o) && s.refusal === null) s.refusal = o;
    s.timeSign = true;
  }
  // "Opening hours\nSaturday: 10:00 - 16:00": no event, in every letter from that sender.
  if (w.hours && s.best?.level === "guess" && s.best.said.day.form === "weekday") s.best = null;
  // "It was lovely to see you on Saturday at 7pm": the last Saturday or the coming one? A lone weekday
  // or relative day beside "was" is asked, never guessed; a whole date's own day decides.
  const lone = s.best?.said.day.form;
  if (s.was && (lone === "weekday" || lone === "relative")) {
    s.refusal = { why: "ambiguous_day", said: s.best!.said };
    s.best = null;
  }
  const particle = w.lex.dueVerbParticle;
  if (s.dueVerb && particle !== null && s.last >= s.first && look(w.r, s.last)?.low === particle[1])
    s.due = true;
  const cancelled = w.lex.cancelParticle;
  if (s.cancelVerb && cancelled !== null && s.last >= s.first && look(w.r, s.last)?.low === cancelled)
    s.past = true;
  if (s.past || (s.best === null && s.refusal === null && !s.twoDates)) return;
  const words = s.spans;
  if (s.twoDates) return void w.notOffered.push({ why: "two_dates", words });
  if (s.due) return void w.notOffered.push({ why: "due", words });
  const best = s.best;
  // A whole day on the letter's own day with nothing to say what it is: the letter's date line, an
  // order or invoice date. It is never offered and never counts as a second day.
  const ownDay =
    best !== null &&
    best.said.clock === null &&
    !s.ticket &&
    !s.delivery &&
    sameDay(best.day, w.anchor.letterDay);
  if (best !== null && !ownDay) {
    w.survivors.push({
      level: best.level,
      day: best.day,
      said: best.said,
      kind: kindOf(s, best.level),
    });
    return;
  }
  const refusal: Refusal = ownDay ? { why: "bare_date", said: best.said } : s.refusal!;
  w.notOffered.push({ why: refusal.why, words: saidSpans(w.r, refusal.said) });
  const askable = refusal.why === "weekday_no_time" || refusal.why === "ambiguous_day";
  if (askable && !s.otherZone && (s.timeSign || s.hasClock) && w.asks.length < MAX_FOUND_ASKS) {
    const span = spanOf(w.r, s.first, s.last + 1);
    if (span.end - span.start <= MAX_FOUND_ASK_CHARS) w.asks.push(span);
  }
}

/** Does a word open a sentence after a stop: one with a capital that names no month and labels no time. */
const opens = (lex: Lexicon, stop: Token, after: Token | undefined): boolean =>
  after !== undefined &&
  !joined(stop, after) &&
  after.kind === "word" &&
  after.capital &&
  !lex.months.has(after.low) &&
  !lex.timeLabels.has(after.low);

/**
 * Does the token at `i` end a sentence? A line break does, unless the next line is a labelled time
 * ("Time: 19:30") under the day. A stop after a year does; after another number only before a word
 * that opens a sentence; after an abbreviation never.
 */
function endsSentence(w: Walk, i: number, t: Token, before: Token | undefined): boolean {
  const { r, lex } = w;
  if (t.kind === "break") {
    const label = look(r, i + 1);
    return !(
      label?.kind === "word" &&
      lex.timeLabels.has(label.low) &&
      isStop(look(r, i + 2), ":") &&
      look(r, i + 3)?.kind === "num"
    );
  }
  if (t.kind !== "mark") return false;
  if (t.low === "!" || t.low === "?" || t.low === ";") return true;
  if (t.low !== ".") return false;
  if (before === undefined) return true;
  if (before.kind === "num") {
    const after = look(r, i + 1);
    return (
      before.end - before.start === 4 || after === undefined || after.kind === "break" || opens(lex, t, after)
    );
  }
  return !(before.kind === "word" && (before.low.length === 1 || lex.abbreviations.has(before.low)));
}

const isStop = (t: Token | undefined, m: string): boolean =>
  t !== undefined && t.kind === "mark" && t.low === m;

/** A word that opens opening hours: "Öffnungszeiten", "Ladenöffnungszeiten", "opening hours", "store times". */
const opensHours = (lex: Lexicon, low: string, prev: string): boolean =>
  lex.hoursWords.has(low) ||
  lex.hoursEndings.some((e) => low.endsWith(e)) ||
  (lex.hoursAfter.has(low) && lex.hoursBefore.has(prev));

/**
 * The cancel word at token `i` names a new day: "postponed to Saturday, 28 November", "postponed to
 * the 28th of November". A day form reads right after "to", or one word later; "postponed to a later
 * date", "to next year", "to 20:30" name none, and the cancel stands.
 */
function namesNewDay(c: FormContext, i: number): boolean {
  const after = c.lex.cancelNewDay.get(c.r.tokens[i]!.low);
  if (after === undefined || look(c.r, i + 1)?.low !== after) return false;
  for (const j of [i + 2, i + 3]) {
    const form = readDayAt({ ...c, prev: look(c.r, j - 1)!.low }, j)?.form;
    if (form !== undefined) return form !== "nothing" && form !== "partial";
    if (look(c.r, j)?.kind !== "word") return false;
  }
  return false;
}

/** What a plain word tells the sentence it stands in. */
function noteWord(c: FormContext, s: Sentence, t: Token, prev: string, i: number): void {
  const { lex, r } = c;
  const low = t.low;
  if (t.kind === "num") {
    if (lex.timeBefore.has(prev)) s.timeSign = true;
    return;
  }
  if (t.kind !== "word") return;
  if (lex.past.has(low) || (lex.cancel.has(low) && !namesNewDay(c, i))) s.past = true;
  else if (lex.cancelVerbs.has(low)) s.cancelVerb = true;
  else if (lex.was.has(low)) s.was = true;
  else if (lex.dueCues.has(low) || lex.dueEndings.some((e) => low.endsWith(e))) s.due = true;
  else if (lex.ticketCues.has(low)) s.ticket = true;
  else if (lex.deliveryCues.has(low)) s.delivery = true;
  else if (lex.timeWords.has(low)) s.timeSign = true;
  else if (lex.numberWords.has(low) && lex.timeBefore.has(prev)) s.timeSign = true;
  else if (low === "uhr" && lex.numberWords.has(prev)) s.timeSign = true;
  else if (low === "o" && look(r, i + 1)?.kind === "mark" && look(r, i + 2)?.low === "clock")
    s.timeSign = true;
  else if (lex.dueVerbParticle !== null && low === lex.dueVerbParticle[0]) s.dueVerb = true;
}

/** A day form that ends on a number's stop ("21.11.", "am 10."), before a word that opens a sentence. */
const endsOnStop = (w: Walk, day: DayMatch): boolean => {
  const stop = w.r.tokens[day.next - 1]!;
  const num = w.r.tokens[day.next - 2];
  return isStop(stop, ".") && num?.kind === "num" && opens(w.lex, stop, look(w.r, day.next));
};

/** The walk: every token once, every sentence decided once. */
function walk(w: Walk): void {
  const { r, lex } = w;
  const n = r.tokens.length;
  let s = newSentence(0);
  let prev = "";
  let before: Token | undefined;
  let byAt = -1_000;
  let halfAt = -1_000;
  let half: HalfWord | null = null;
  const restart = (at: number) => {
    close(w, s);
    s = newSentence(at);
    prev = "";
    before = undefined;
    halfAt = -1_000;
  };
  for (let i = 0; i < n;) {
    const t = look(r, i)!;
    if (endsSentence(w, i, t, before)) {
      restart(i + 1);
      i += 1;
      continue;
    }
    const c = formContextAt(r, lex, w.anchor.letterDay, i, before, i - halfAt <= 3 ? half : null);
    const named = t.kind === "word" ? lex.halves.get(t.low) : undefined;
    if (named !== undefined && !lex.greetings.has(prev)) {
      [halfAt, half] = [i, named];
      s.halfSeen = true;
    }
    const day = readDayAt(c, i);
    const clock = day === null ? readClockAt(c, i) : null;
    const next = day?.next ?? clock?.next ?? i + 1;
    if (day !== null) addDay(w, s, day, i - byAt <= 2);
    else if (clock !== null) {
      if (clock.passed === null) addClock(s, clock);
      else if (clock.passed === "range") passClock(s, clock);
    } else {
      noteWord(c, s, t, prev, i);
      if (opensHours(lex, t.low, prev)) w.hours = true;
      if (lex.dueBefore.has(t.low) || (lex.dueBeforeOn.has(t.low) && i - byAt === 1)) byAt = i;
    }
    s.last = next - 1;
    before = r.tokens[next - 1];
    prev = before!.low;
    i = next;
    if (day !== null && endsOnStop(w, day)) restart(next);
  }
  close(w, s);
}

/** The language by its commonest words among the first two hundred, or `null` when they do not tell. */
function languageOf(r: TokenReader): FoundLanguage | null {
  let en = 0;
  let de = 0;
  const enWords = lexiconOf("en").stopWords;
  const deWords = lexiconOf("de").stopWords;
  for (let i = 0, seen = 0; i < r.tokens.length && seen < 200; i += 1) {
    const t = look(r, i)!;
    if (t.kind !== "word") continue;
    seen += 1;
    if (enWords.has(t.low)) en += 1;
    if (deWords.has(t.low)) de += 1;
  }
  if (en >= 3 && en > de) return "en";
  if (de >= 3 && de > en) return "de";
  return null;
}

const refused = (why: NotOfferedWord, text: string, spent: number): FoundReading => ({
  text,
  anchor: null,
  findings: [],
  notOffered: [{ why, words: [] }],
  askable: [],
  spent,
  stoppedBy: null,
});

/** A zone source whose every question is a step of the reading. */
const paidZones = (zones: ZoneSource, left: StepsLeft): ZoneSource => ({
  offsetAt(tzid, epochMs) {
    spend(left);
    const offset = zones.offsetAt(tzid, epochMs, left);
    if (left.unpaid === true) throw new FoundStepsSpent();
    return offset;
  },
});

export function dayKey(d: PlainDate): string {
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(d.year, 4)}-${pad(d.month, 2)}-${pad(d.day, 2)}`;
}

export function clockKey(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** The length of an event with no end, as the person set it or the default. */
export const lengthOf = (context: FoundContext): number => {
  const m = context.defaultLengthMinutes;
  return m !== undefined && Number.isInteger(m) && m > 0 && m <= 1_440 ? m : FOUND_DEFAULT_LENGTH_MINUTES;
};

/** A timed event's end: the one given, or the start plus the default length on the person's clock. */
export function timedEnd(
  start: ZonedTime,
  end: Wall | null,
  minutes: number,
  zones: ZoneSource,
): ZonedTime | null {
  if (end !== null) return { kind: "zoned", wall: end, tzid: start.tzid };
  const moved = addDuration(
    start,
    { negative: false, weeks: 0, days: 0, hours: 0, minutes, seconds: 0 },
    zones,
  );
  return moved !== null && moved.kind === "zoned" ? moved : null;
}

function findingOf(w: Walk, v: Survivor, context: FoundContext, zones: ZoneSource): Finding {
  const words = saidSpans(w.r, v.said);
  const clock = v.said.clock;
  const free = v.kind === "delivery";
  if (clock === null || free) {
    const event = { start: v.day, end: null, endGiven: false };
    return { key: dayKey(v.day), level: v.level, kind: v.kind, evidence: "sentence", event, free, words };
  }
  const start: ZonedTime = {
    kind: "zoned",
    wall: wallOf(v.day, clock.at.hour, clock.at.minute),
    tzid: context.zone,
  };
  const given = clock.end === null ? null : wallOf(v.day, clock.end.hour, clock.end.minute);
  const end = timedEnd(start, given, lengthOf(context), zones);
  const key = `${dayKey(v.day)}T${clockKey(clock.at.hour, clock.at.minute)}`;
  const event = { start, end, endGiven: given !== null };
  return { key, level: v.level, kind: v.kind, evidence: "sentence", event, free, words };
}

function reading(
  letter: FoundLetter,
  context: FoundContext,
  limits: FoundLimits,
  left: StepsLeft,
): FoundReading {
  const spent = () => limits.maxSteps - left.steps;
  if (!Number.isFinite(letter.sentAt.epochMs) || !Number.isFinite(context.now.epochMs))
    return refused("letter_date", "", spent());
  if (letter.language !== null && !FOUND_LANGUAGES.includes(letter.language))
    return refused("language", "", spent());
  const zones = paidZones(context.zones, left);
  const sent = wallIn(letter.sentAt.epochMs, context.zone, zones);
  const nowWall = sent === null ? null : wallIn(context.now.epochMs, context.zone, zones);
  if (sent === null || nowWall === null) return refused("zone_unknown", "", spent());
  const letterDay = dateOf(sent);
  const today = dateOf(nowWall);
  if (dayNumber(letterDay) > dayNumber(today) + 1) return refused("letter_date", "", spent());
  const text = foundLetterText(letter, limits);
  const r = tokenReader(tokenize(text, left), left);
  const language = letter.language ?? languageOf(r);
  if (language === null) return refused("language", text, spent());
  const anchor: FoundAnchor = { letterDay, today, nowWall, language };
  const w: Walk = {
    r,
    lex: lexiconOf(language),
    anchor,
    survivors: [],
    notOffered: [],
    asks: [],
    hours: false,
  };
  walk(w);
  const base = { text, anchor, stoppedBy: null };
  const days = w.survivors.filter((v) => !sameDay(v.day, w.survivors[0]!.day));
  if (days.length > 0) {
    const words = [...saidSpans(r, w.survivors[0]!.said), ...saidSpans(r, days[0]!.said)];
    const notOffered = [...w.notOffered, { why: "two_dates" as const, words }];
    return { ...base, findings: [], notOffered, askable: [], spent: spent() };
  }
  let pick: Survivor | null = null;
  for (const v of w.survivors) if (pick === null || better(v, pick)) pick = v;
  const findings = pick === null ? [] : [findingOf(w, pick, context, zones)];
  const askable = w.survivors.length === 0 ? w.asks : [];
  return { ...base, findings, notOffered: w.notOffered, askable, spent: spent() };
}

/**
 * Reads a letter for events. News and any place not named is refused before a character is read;
 * a reading that runs out of steps offers nothing and says so.
 */
export function readFound(
  letter: FoundLetter,
  context: FoundContext,
  limits: FoundLimits = DEFAULT_FOUND_LIMITS,
): FoundReading {
  if (letter.place === "news") return refused("in_news", "", 0);
  if (letter.place !== "ohbox" && letter.place !== "receipts") return refused("place", "", 0);
  const left: StepsLeft = { steps: limits.maxSteps };
  try {
    return reading(letter, context, limits, left);
  } catch (e) {
    if (!(e instanceof FoundStepsSpent)) throw e;
    const spent = limits.maxSteps - left.steps;
    return { text: "", anchor: null, findings: [], notOffered: [], askable: [], spent, stoppedBy: "steps" };
  }
}
