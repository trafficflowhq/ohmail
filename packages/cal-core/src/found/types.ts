/**
 * Events found in letters: what goes in, what comes out, and the doors that turn one into the other.
 * A letter's words give a finding at one of three levels, or a word for why nothing is offered. The
 * rules read the words; a model is asked only for what the rules leave as a guess, and its answer is
 * checked against the words before it becomes a finding. Nothing here reads a clock, a store or a
 * network: the letter's date, the reading time and the zone rules are handed in.
 */
import { MAX_FOUND_STEPS, MAX_FOUND_TEXT_CHARS } from "../limits.js";
import type { Instant, PlainDate, Wall, ZonedTime, ZoneSource } from "../time/types.js";

/** How sure a finding is. `exact` is the event's own data (a calendar part, a booking); words never give it. */
export const FOUND_LEVELS = ["exact", "dated", "guess"] as const;
export type FoundLevel = (typeof FOUND_LEVELS)[number];
/** The levels a letter's words can give. */
export type WordsLevel = Exclude<FoundLevel, "exact">;

/** What a finding is. A `booking` is read from the booking's own data, never from sentences. */
export const FOUND_KINDS = ["ticket", "booking", "delivery", "appointment", "proposal"] as const;
export type FoundKind = (typeof FOUND_KINDS)[number];
/** The kinds a letter's words can tell. */
export type WordsKind = Exclude<FoundKind, "booking">;

/**
 * Where a finding came from, as `cal_suggestions.evidence` stores it. The rules write `sentence`, a
 * checked model answer `sentence_model`; `calendar` and `data` belong to the readers of a letter's
 * calendar part and a booking's data.
 */
export const FOUND_EVIDENCE = ["calendar", "data", "sentence", "sentence_model"] as const;
export type FoundEvidence = (typeof FOUND_EVIDENCE)[number];

export const FOUND_LANGUAGES = ["en", "de"] as const;
export type FoundLanguage = (typeof FOUND_LANGUAGES)[number];

/** The places a letter is read in. Every other place is never handed in, and anything else is refused. */
export const FOUND_PLACES = ["ohbox", "receipts", "news"] as const;
export type FoundPlace = (typeof FOUND_PLACES)[number];

/** Why words were not offered. Kept with the reading for those who build and judge it, never shown. */
export const NOT_OFFERED = [
  "place",
  "in_news",
  "language",
  "zone_unknown",
  "letter_date",
  "passed",
  "far_ahead",
  "due",
  "two_dates",
  "weekday_no_time",
  "bare_date",
  "weekday_disagrees",
  "ambiguous_date",
  "ambiguous_day",
  "other_zone",
] as const;
export type NotOfferedWord = (typeof NOT_OFFERED)[number];

/** Why a model's answer was dropped. */
export const FOUND_DROPS = [
  "malformed",
  "none_found",
  "not_asked",
  "words_not_in_letter",
  "day_not_in_words",
  "no_time",
  "time_not_in_words",
  "passed",
  "far_ahead",
] as const;
export type FoundDropWord = (typeof FOUND_DROPS)[number];

/** The length of an event whose letter gives no end. */
export const FOUND_DEFAULT_LENGTH_MINUTES = 60;

/** A letter as the door hands it in: received mail, its stored date, and the place it is filed in. */
export interface FoundLetter {
  readonly subject: string;
  readonly body: string;
  readonly sentAt: Instant;
  /** The letter's language when the door knows it; `null` lets the words decide. */
  readonly language: FoundLanguage | null;
  readonly place: FoundPlace;
}

/** The person's side of a reading: their zone, the reading time and the zone rules. */
export interface FoundContext {
  readonly zone: string;
  readonly now: Instant;
  readonly zones: ZoneSource;
  readonly defaultLengthMinutes?: number;
}

export interface FoundLimits {
  readonly maxTextChars: number;
  readonly maxSteps: number;
}

export const DEFAULT_FOUND_LIMITS: FoundLimits = {
  maxTextChars: MAX_FOUND_TEXT_CHARS,
  maxSteps: MAX_FOUND_STEPS,
};

/** Words of the reading's text, as UTF-16 offsets into `FoundReading.text`; `end` is exclusive. */
export interface WordSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * The event as words give it. A timed start is a clock time in the person's own zone (the letter
 * names none); a whole day is a date with `end: null`. Never an instant, never a zoneless time.
 */
export interface FoundEvent {
  readonly start: PlainDate | ZonedTime;
  readonly end: PlainDate | ZonedTime | null;
  readonly endGiven: boolean;
}

export interface Finding {
  /** The start as written: `2026-11-21` or `2026-11-21T19:30`. One letter has one finding per key. */
  readonly key: string;
  readonly level: FoundLevel;
  readonly kind: FoundKind;
  readonly evidence: FoundEvidence;
  readonly event: FoundEvent;
  /** Shown as free time: a delivery. */
  readonly free: boolean;
  readonly words: readonly WordSpan[];
}

export interface NotOffered {
  readonly why: NotOfferedWord;
  readonly words: readonly WordSpan[];
}

/** The two days a reading works from: the letter's own, and the reading's, both on the person's clock. */
export interface FoundAnchor {
  readonly letterDay: PlainDate;
  readonly today: PlainDate;
  readonly nowWall: Wall;
  readonly language: FoundLanguage;
}

export interface FoundReading {
  /** The one text the rules read and the offsets index: the subject and the letter's own words. */
  readonly text: string;
  readonly anchor: FoundAnchor | null;
  readonly findings: readonly Finding[];
  readonly notOffered: readonly NotOffered[];
  /** Sentences the rules could not settle that a model may be asked about; empty when anything was found. */
  readonly askable: readonly WordSpan[];
  readonly spent: number;
  readonly stoppedBy: "steps" | null;
}

/** What a model is handed: the askable sentences and the letter's day. */
export interface FoundModelInput {
  readonly text: string;
  readonly letterDay: string;
  readonly letterWeekday: string;
  readonly language: FoundLanguage;
}

/** The answer the closed schema allows. `day` is `YYYY-MM-DD`, `start` and `end` are `HH:MM` or `""`. */
export interface FoundModelAnswer {
  readonly found: boolean;
  readonly words: string;
  readonly day: string;
  readonly start: string;
  readonly end: string;
}

/** A model, as the door binds it: no transport, key or call here. `Call` is the door's own call options. */
export interface FoundModelPort<Call = undefined> {
  ask(input: FoundModelInput, call?: Call): Promise<unknown>;
}

export type FoundAnswerCheck =
  { readonly ok: true; readonly finding: Finding } | { readonly ok: false; readonly dropped: FoundDropWord };

/** `cal_suggestions.proposed`. Versioned: a stored row outlives this shape. */
export interface FoundProposed {
  readonly v: 1;
  readonly level: FoundLevel;
  readonly kind: FoundKind;
  readonly title: string;
  readonly start: PlainDate | ZonedTime;
  readonly end: PlainDate | ZonedTime | null;
  readonly endGiven: boolean;
  readonly free: boolean;
}

/** A finding as the columns of one `cal_suggestions` row. */
export interface FoundSuggestionColumns {
  readonly evidence: FoundEvidence;
  readonly proposed: FoundProposed;
  readonly sourceWords: string | null;
  readonly findingKey: string;
}

/** The doors' shapes, so that a caller can type what it is handed before the doors exist. */
export type ReadFound = (letter: FoundLetter, context: FoundContext, limits?: FoundLimits) => FoundReading;
export type FoundModelTextOf = (reading: FoundReading) => string | null;
export type FoundModelInputOf = (
  reading: FoundReading,
  screen: { readonly admitted: true },
) => FoundModelInput | null;
export type CheckFoundAnswer = (
  answer: unknown,
  reading: FoundReading,
  context: FoundContext,
) => FoundAnswerCheck;
export type SuggestionColumnsOf = (
  finding: Finding,
  reading: FoundReading,
  subject: string,
) => FoundSuggestionColumns;
