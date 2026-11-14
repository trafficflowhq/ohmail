/**
 * The words the date grammar knows, in English and German, lower case. Each table is a closed list:
 * a word that is not here means nothing to the grammar. Weekdays count from Monday as 0, as
 * `time/arith` does; months from January as 1.
 */
import type { FoundLanguage } from "./types.js";

export interface Lexicon {
  readonly language: FoundLanguage;
  /** Full weekday names: read alone or before a date. */
  readonly weekdays: ReadonlyMap<string, number>;
  /** Short weekday names: read only directly before a whole date. */
  readonly weekdaysShort: ReadonlyMap<string, number>;
  /** Month names, full and three-letter. */
  readonly months: ReadonlyMap<string, number>;
  /** Days counted from the letter's own: today, tomorrow. */
  readonly relative: ReadonlyMap<string, number>;
  /** Words between a weekday and its date that change nothing ("the", "den"). */
  readonly articles: ReadonlySet<string>;
  /** Words before which a bare ordinal is a day of the month ("the 10th", "am 10."). */
  readonly ordinalBefore: ReadonlySet<string>;
  /** "next": before a weekday, a day that could be either of two; before "week", a partial day. */
  readonly next: ReadonlySet<string>;
  /** "übernächsten": before a weekday, the one a week or two after the coming one. */
  readonly afterNext: ReadonlySet<string>;
  /** "week", "weeks": after a weekday ("Saturday week") or a count ("in two weeks"), a day a week off. */
  readonly week: ReadonlySet<string>;
  /** Words that count weeks before `week`: "in two weeks", "in einer Woche". */
  readonly counts: ReadonlySet<string>;
  /** Words that make a sentence about the past: nothing in it is offered. */
  readonly past: ReadonlySet<string>;
  /** Words that open opening hours: after them no weekday is guessed in the rest of the letter. */
  readonly hoursWords: ReadonlySet<string>;
  /** Endings of a compound that opens opening hours: "Ladenöffnungszeiten", "Öffnungszeit". */
  readonly hoursEndings: readonly string[];
  /** Words that open opening hours after a word of `hoursBefore`: "opening hours", "store times". */
  readonly hoursAfter: ReadonlySet<string>;
  /** Words before `hoursAfter` that open opening hours: "opening", "office", "store". */
  readonly hoursBefore: ReadonlySet<string>;
  /** "was", "war": a lone weekday or relative day in their sentence is the last one or the coming one. */
  readonly was: ReadonlySet<string>;
  /** Words that cancel an event: nothing in their sentence is offered, as with `past`. */
  readonly cancel: ReadonlySet<string>;
  /** A cancel word and the word after it that names a new day instead: "postponed to Saturday". */
  readonly cancelNewDay: ReadonlyMap<string, string>;
  /** Verbs whose particle, last in the sentence, cancel an event: German "fällt … aus". */
  readonly cancelVerbs: ReadonlySet<string>;
  readonly cancelParticle: string | null;
  /** A date something is due. */
  readonly dueCues: ReadonlySet<string>;
  /** Endings of a compound that is a date something is due: German "-frist" (Zahlungsfrist). */
  readonly dueEndings: readonly string[];
  /** A verb whose particle, last in the sentence, makes a due date: German "läuft … ab". */
  readonly dueVerbParticle: readonly [string, string] | null;
  /** Words that, within two tokens before a day, make it a date something is due by. */
  readonly dueBefore: ReadonlySet<string>;
  /** Words that carry `dueBefore` on, each right after the last: Swiss "bis und mit Freitag". */
  readonly dueBeforeOn: ReadonlySet<string>;
  readonly ticketCues: ReadonlySet<string>;
  readonly deliveryCues: ReadonlySet<string>;
  /** Words before a bare number that make it a time the rules do not read ("at 12", "um 7"). */
  readonly timeBefore: ReadonlySet<string>;
  /** Words that tell a time the rules do not read ("half", "viertel"). */
  readonly timeWords: ReadonlySet<string>;
  readonly numberWords: ReadonlySet<string>;
  /**
   * Words beside a clock that name its half of the day: `pm` moves an hour up to 11 to the afternoon,
   * `am` keeps it, `night` moves an hour from 6 to 11 and keeps a smaller one.
   */
  readonly halves: ReadonlyMap<string, HalfWord>;
  /** Small words between a clock and the half after it: "in the evening", "am Abend". */
  readonly halfLinks: ReadonlySet<string>;
  /** Words before a half of the day that make it a greeting: "good evening", "guten Abend". */
  readonly greetings: ReadonlySet<string>;
  /** Labels of a line that gives a time under a line that gives the day: "Time: 19:30", "Zeit: 19:30". */
  readonly timeLabels: ReadonlySet<string>;
  /**
   * Words that take a number of their own: "Raum 5", "gate 12". A range after one ("Raum 5 – 17 Uhr")
   * is that number and an hour, not a start and an end: it is passed over whole and gives no clock.
   */
  readonly noHourAfter: ReadonlySet<string>;
  /** "between 2 and 4pm", "zwischen 14 und 16 Uhr": the word before a range's start, and the word that joins its end. */
  readonly betweenAnd: readonly [string, string];
  /** Words before English "to" that make it the end of a range with no start: "up to 5pm", "open to 5pm". */
  readonly toEndAfter: ReadonlySet<string>;
  /** Zone words after a clock in this language only ("IST" is German "ist"); `ZONE_WORDS` holds the rest. */
  readonly zoneWords: ReadonlySet<string>;
  /** Within two words after a clock, a zone said in words: "London time", "Ortszeit". */
  readonly zoneTime: ReadonlySet<string>;
  /** German: a word with this ending before `zeit` names a zone ("New Yorker Zeit", "deutscher Zeit"). */
  readonly zoneEnding: string | null;
  /** Words with that ending that name no zone: "Hast du um 15 Uhr wieder Zeit?". */
  readonly zoneEndingNot: ReadonlySet<string>;
  /** Words after which German `morgen` means morning, not tomorrow. */
  readonly morgenAfter: ReadonlySet<string>;
  /** Words whose stop ends no sentence: abbreviations. */
  readonly abbreviations: ReadonlySet<string>;
  readonly stopWords: ReadonlySet<string>;
}

export type HalfWord = "am" | "pm" | "night";

const indexed = (names: readonly (readonly string[])[], from: number): ReadonlyMap<string, number> =>
  new Map(names.flatMap((forms, i) => forms.map((form): [string, number] => [form, i + from])));

const EN_WEEKDAYS = indexed(
  [["monday"], ["tuesday"], ["wednesday"], ["thursday"], ["friday"], ["saturday"], ["sunday"]],
  0,
);
const EN_WEEKDAYS_SHORT = indexed(
  [["mon"], ["tue", "tues"], ["wed"], ["thu", "thur", "thurs"], ["fri"], ["sat"], ["sun"]],
  0,
);
const EN_MONTHS = indexed(
  [
    ["january", "jan"],
    ["february", "feb"],
    ["march", "mar"],
    ["april", "apr"],
    ["may"],
    ["june", "jun"],
    ["july", "jul"],
    ["august", "aug"],
    ["september", "sep", "sept"],
    ["october", "oct"],
    ["november", "nov"],
    ["december", "dec"],
  ],
  1,
);
const DE_WEEKDAYS = indexed(
  [
    ["montag"],
    ["dienstag"],
    ["mittwoch"],
    ["donnerstag"],
    ["freitag"],
    ["samstag", "sonnabend"],
    ["sonntag"],
  ],
  0,
);
const DE_WEEKDAYS_SHORT = indexed([["mo"], ["di"], ["mi"], ["do"], ["fr"], ["sa"], ["so"]], 0);
const DE_MONTHS = indexed(
  [
    ["januar", "jänner", "jan"],
    ["februar", "feb"],
    ["märz", "mär", "mrz"],
    ["april", "apr"],
    ["mai"],
    ["juni", "jun"],
    ["juli", "jul"],
    ["august", "aug"],
    ["september", "sep", "sept"],
    ["oktober", "okt"],
    ["november", "nov"],
    ["dezember", "dez"],
  ],
  1,
);

const set = (...words: string[]): ReadonlySet<string> => new Set(words);

/**
 * English words that name a day and its evening at once: a relative day (days after the letter's)
 * that also moves a clock beside it to the afternoon. One row puts such a word in both tables.
 */
const EN_EVENING_DAYS: readonly (readonly [string, number])[] = [];
const shortForms = (...maps: ReadonlyMap<string, number>[]): string[] =>
  maps.flatMap((m) => [...m.keys()].filter((k) => k.length <= 4));

const EN_HALVES: ReadonlyMap<string, HalfWord> = new Map<string, HalfWord>([
  ["morning", "am"],
  ["afternoon", "pm"],
  ["evening", "pm"],
  ["night", "night"],
]);
const DE_HALVES: ReadonlyMap<string, HalfWord> = new Map<string, HalfWord>([
  ["morgens", "am"],
  ["vormittags", "am"],
  ["vormittag", "am"],
  ["nachmittags", "pm"],
  ["nachmittag", "pm"],
  ["abends", "pm"],
  ["abend", "pm"],
]);

const EN: Lexicon = {
  language: "en",
  weekdays: EN_WEEKDAYS,
  weekdaysShort: EN_WEEKDAYS_SHORT,
  months: EN_MONTHS,
  relative: new Map([["today", 0], ["tomorrow", 1], ...EN_EVENING_DAYS]),
  articles: set("the", "on"),
  ordinalBefore: set("the", "on"),
  next: set("next"),
  afterNext: set(),
  week: set("week", "weeks"),
  counts: set("a", "one", "two", "three", "four"),
  past: set("last", "yesterday", "since", "ago"),
  hoursWords: set(),
  hoursEndings: [],
  hoursAfter: set("hours", "times"),
  hoursBefore: set("opening", "office", "business", "store", "shop"),
  was: set("was", "were"),
  cancel: set("cancelled", "canceled", "cancellation", "postponed"),
  cancelNewDay: new Map([["postponed", "to"]]),
  cancelVerbs: set(),
  cancelParticle: null,
  dueCues: set(
    "due",
    "overdue",
    "deadline",
    "expires",
    "expire",
    "expiry",
    "renewal",
    "renew",
    "renews",
    "renewed",
    "payable",
    "expiring",
    "expired",
    "ends",
    "closes",
    "close",
    "payment",
    "pay",
    "charged",
    "billed",
    "latest",
  ),
  dueEndings: [],
  dueVerbParticle: null,
  dueBefore: set("by", "until", "till", "before", "than"),
  dueBeforeOn: set(),
  ticketCues: set("ticket", "tickets", "admission", "seat", "seats", "doors"),
  deliveryCues: set("delivery", "delivered", "deliver", "parcel", "package", "shipment", "courier"),
  timeBefore: set("at"),
  timeWords: set("half", "quarter"),
  numberWords: set(
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
  ),
  halves: new Map<string, HalfWord>([
    ...EN_HALVES,
    ...EN_EVENING_DAYS.map(([w]): [string, HalfWord] => [w, "pm"]),
  ]),
  halfLinks: set("in", "the", "at"),
  greetings: set("good"),
  timeLabels: set("time", "from", "start", "starts", "begins", "doors"),
  noHourAfter: set("room", "hall", "gate", "platform", "floor", "level", "no", "group", "table"),
  betweenAnd: ["between", "and"],
  toEndAfter: set("up", "through", "open"),
  zoneWords: set("ist", "eastern", "pacific", "central", "mountain"),
  zoneTime: set("time"),
  zoneEnding: null,
  zoneEndingNot: set(),
  morgenAfter: set(),
  abbreviations: set(
    ...shortForms(EN_WEEKDAYS_SHORT, EN_MONTHS),
    "dr",
    "mr",
    "mrs",
    "ms",
    "st",
    "no",
    "vs",
    "etc",
  ),
  stopWords: set(
    "the",
    "and",
    "you",
    "your",
    "is",
    "are",
    "to",
    "of",
    "at",
    "on",
    "for",
    "we",
    "will",
    "be",
    "it",
    "this",
    "with",
    "have",
    "see",
    "our",
    "from",
    "please",
  ),
};

const DE: Lexicon = {
  language: "de",
  weekdays: DE_WEEKDAYS,
  weekdaysShort: DE_WEEKDAYS_SHORT,
  months: DE_MONTHS,
  relative: new Map([
    ["heute", 0],
    ["morgen", 1],
    ["übermorgen", 2],
  ]),
  articles: set("den", "am", "dem"),
  ordinalBefore: set("am", "den", "vom", "zum", "ab"),
  next: set("nächsten", "nächste", "nächster", "nächstes"),
  afterNext: set("übernächsten", "übernächste", "übernächster", "übernächstes"),
  week: set("woche", "wochen"),
  counts: set("einer", "zwei", "drei", "vier"),
  past: set("letzten", "letzte", "letzter", "letztes", "gestern", "vorgestern", "seit"),
  hoursWords: set(
    "sprechstunde",
    "sprechstunden",
    "sprechzeiten",
    "bürozeiten",
    "geschäftszeiten",
    "telefonzeiten",
  ),
  hoursEndings: ["öffnungszeiten", "öffnungszeit"],
  hoursAfter: set(),
  hoursBefore: set(),
  was: set("war", "waren", "gewesen"),
  cancel: set("abgesagt", "absagen", "absage", "entfällt", "storniert", "annulliert"),
  cancelNewDay: new Map(),
  cancelVerbs: set("fällt", "fallen"),
  cancelParticle: "aus",
  dueCues: set(
    "fällig",
    "fälligkeit",
    "frist",
    "zahlbar",
    "spätestens",
    "ablauf",
    "abgelaufen",
    "verlängerung",
    "deadline",
    "einsendeschluss",
    "anmeldeschluss",
    "annahmeschluss",
    "bestellschluss",
    "buchungsschluss",
    "meldeschluss",
    "redaktionsschluss",
    "abgabetermin",
    "zahlungstermin",
    "einsendetermin",
    "abbuchungstermin",
    "kündigungstermin",
    "stichtag",
    "verlängert",
    "endet",
    "abläuft",
    "abgebucht",
    "kündbar",
  ),
  dueEndings: ["frist"],
  dueVerbParticle: ["läuft", "ab"],
  dueBefore: set("bis", "vor"),
  dueBeforeOn: set("und", "mit"),
  ticketCues: set("ticket", "tickets", "eintrittskarte", "eintrittskarten", "einlass", "sitzplatz"),
  deliveryCues: set(
    "lieferung",
    "geliefert",
    "liefern",
    "zustellung",
    "zugestellt",
    "paket",
    "sendung",
    "liefertermin",
  ),
  timeBefore: set("um", "gegen"),
  timeWords: set("halb", "viertel"),
  numberWords: set(
    "eins",
    "zwei",
    "drei",
    "vier",
    "fünf",
    "sechs",
    "sieben",
    "acht",
    "neun",
    "zehn",
    "elf",
    "zwölf",
  ),
  halves: DE_HALVES,
  halfLinks: set("am", "des"),
  greetings: set("guten"),
  timeLabels: set("zeit", "uhrzeit", "beginn", "von", "ab", "einlass"),
  noHourAfter: set("raum", "zimmer", "saal", "halle", "gleis", "tor", "stock", "nr", "gruppe", "tisch"),
  betweenAnd: ["zwischen", "und"],
  toEndAfter: set(),
  zoneWords: set(),
  zoneTime: set("ortszeit"),
  zoneEnding: "er",
  zoneEndingNot: set("aber", "oder", "wieder", "immer", "sicher", "leider", "eher", "weiter"),
  morgenAfter: set("am", "heute", "gestern", "guten", "jeden", ...DE_WEEKDAYS.keys()),
  abbreviations: set(
    ...shortForms(DE_WEEKDAYS_SHORT, DE_MONTHS),
    "dr",
    "nr",
    "st",
    "ca",
    "bzw",
    "usw",
    "inkl",
    "evtl",
    "str",
  ),
  stopWords: set(
    "der",
    "die",
    "das",
    "und",
    "ist",
    "wir",
    "sie",
    "ich",
    "du",
    "nicht",
    "mit",
    "auf",
    "für",
    "ein",
    "eine",
    "den",
    "dem",
    "zu",
    "es",
    "bitte",
    "uns",
    "ihr",
  ),
};

export const lexiconOf = (language: FoundLanguage): Lexicon => (language === "de" ? DE : EN);

/** Zone words after a clock: the letter's time is not on the person's clock. */
export const ZONE_WORDS: ReadonlySet<string> = set(
  "utc",
  "gmt",
  "cet",
  "cest",
  "mez",
  "mesz",
  "est",
  "edt",
  "pst",
  "pdt",
  "cst",
  "cdt",
  "bst",
  "et",
  "pt",
  "ct",
  "mt",
  "mst",
  "mdt",
  "eet",
  "eest",
  "wet",
  "west",
  "msk",
  "jst",
  "hkt",
  "sgt",
  "aest",
  "aedt",
);

/** After a number, a length of time, not a clock. */
export const DURATION_WORDS: ReadonlySet<string> = set(
  "min",
  "mins",
  "minute",
  "minutes",
  "minuten",
  "h",
  "hr",
  "hrs",
  "hour",
  "hours",
  "std",
  "stunde",
  "stunden",
);

/** Before a number, an amount of money, not a clock. */
export const CURRENCY: ReadonlySet<string> = set("$", "€", "£", "¥", "chf", "eur", "usd", "gbp", "fr");

export const NOON_WORDS: ReadonlySet<string> = set("noon", "midday");
export const ORDINAL_SUFFIXES: ReadonlySet<string> = set("st", "nd", "rd", "th");
export const DASHES: ReadonlySet<string> = set("-", "–", "—");
export const RANGE_WORDS: ReadonlySet<string> = set("to", "till", "until", "bis");
