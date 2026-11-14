/**
 * Every ceiling of the calendar core, in one place, each with the reading it rests on. Calendar text
 * is a stranger's (an invitation, a subscribed feed), so every walk in this package ends by a count
 * and never by elapsed time. Past a ceiling a reader refuses with a word; it never returns half a
 * calendar, and an expansion that stopped at its ceiling says so.
 */

/**
 * Calendar text, in UTF-16 code units. A public holiday feed of ten years read 120,663 characters
 * (2026-11); 8 MiB is about seventy of those, so a league's or a school's timetable still reads.
 * The cap on what is fetched is the fetcher's own and may be lower.
 */
export const MAX_CALENDAR_TEXT_CHARS = 8 * 1024 * 1024;

/** Components in one text, nested ones included. A bare event is about 80 characters, so 8 MiB holds no more. */
export const MAX_COMPONENTS = 100_000;

/** Nesting of BEGIN blocks. A real file nests three deep (calendar, event, alarm). */
export const MAX_NESTING_DEPTH = 16;

/** One unfolded line. An inline picture is the only thing that makes a line long. */
export const MAX_LINE_CHARS = 2 * 1024 * 1024;

/**
 * Content lines in one text, unfolded. The test corpus has 1,292 lines in 32,788 characters, 25 a
 * line; at that rate 8 MiB is 330,000 lines. A text of two-character lines would be four million,
 * each held as an object many times its size.
 */
export const MAX_CONTENT_LINES = 500_000;

/**
 * Parameters on one line, and the values they list, together. The busiest line of the test corpus,
 * an invitee as Google writes one, has six. A megabyte of semicolons would be a million empty
 * parameters, each an object.
 */
export const MAX_PARAMS_PER_LINE = 256;

/**
 * The parts of one text, counted together: every content line, every parameter of a line and every
 * further value a parameter lists. Each becomes an object or a string of its own, about a hundred
 * bytes, so it is this count and not the size of the text that the tree made from it weighs. The
 * test corpus has 1,571 parts in 35,149 characters, 22 a part; at that rate 8 MiB is 375,000.
 *
 * What a text holds once it is read, beside the text itself (Node 22, 2026-11, the heap in use
 * after a collection): an honest calendar 12 bytes for each character, 47 MiB for 5,000 events with
 * their invitees in 3.8 MiB. The costliest text these ceilings admit holds 25 bytes for each
 * character, 200 MiB at the ceiling of text: a hundred thousand events of three invitee lines each,
 * the parts that are left as bare parameters, the rest of the text as listed dates. A text of
 * nothing but parameters, every line at its own ceiling, held 99 bytes for each character before
 * the parts of a whole text were counted, 800 MiB.
 *
 * The words of a text are not what weighs. A value with an escape in it is held once more,
 * unescaped, as one string (read by whole slices, joined once): text values as long as lines may
 * be, in letters outside Latin-1, hold 4 bytes for each character, and a feed of 6,900 events in
 * kana 9. Put together a character at a time they held 58 and 40.
 */
export const MAX_TEXT_PARTS = 600_000;

/**
 * Times the expansion of one series works out with the zone's rules: the occurrences it hands back,
 * and the excluded dates and changed occurrences it had to place to do so. A daily event over
 * fifty-four years is 20,000.
 */
export const MAX_OCCURRENCES_PER_EXPANSION = 20_000;

/**
 * Times one call works out over every series it is handed (`expandAll`): what a view of a whole
 * calendar may show at once. Two thousand weekly series over a year are 106,000 (53 a series: the
 * year's 52 and one in the slack before the window); six series may each reach their own ceiling.
 * A time in a named zone is about eleven questions to the zone source: with the platform's zone
 * data 35 microseconds on a desktop (2026-11), so a call at this ceiling takes about four seconds.
 * A time written in UTC costs a tenth of that. The platform source makes a formatter for a zone
 * once and keeps it (`PLATFORM_ZONES_HELD`); a name the platform does not know costs a refusal,
 * about as much as a time, each time it is not in the source's memory of such names.
 */
export const MAX_OCCURRENCES_PER_CALL = 120_000;

/**
 * Steps one expansion may take, over every rule line, every listed date and every series it is
 * handed. A step is one piece of work and no more: a day asked of a rule (for a rule of hours,
 * minutes or seconds, a period), a reading a rule hands back, a place BYSETPOS names looked for in
 * a period, a series, a listed date or a changed occurrence looked at, an onset of a file's zone
 * definition laid out, a rule of such a definition set up (one for the rule, one for each member of
 * its lists). A rule that matches nothing ends by this count or with the window, whichever comes
 * first. What an expansion does outside this count is bounded by the size of the series it is
 * handed: each rule line of an event is set up once (every member of its lists looked at once), the
 * days a provider reports as cancelled are gathered, and what was found is put in order.
 *
 * What it buys, for one series over a window of one year, in steps and in times worked out with the
 * zone's rules (`Expansion.spent`, `Expansion.resolved`):
 *
 *     an event that does not repeat            1          1
 *     yearly                                  97          1
 *     monthly                                442         12
 *     weekly                                 441         53
 *     three days a week                      549        159
 *     every weekday                          657        265
 *     daily                                  747        371
 *     hourly                              17,823      8,911
 *     every minute                     1,069,203    534,601    more than a call has, of either
 *
 * A weekly series is 55 weeks of seven days asked, an instance a week handed back and the series
 * itself. Two thousand of them, a large calendar, are 882,000 steps and 106,000 times: inside both
 * ceilings. A million plain steps took a tenth of a second on a desktop (2026-11).
 */
export const MAX_STEPS_PER_EXPANSION = 1_000_000;

/** RRULE lines of one event that are walked. The standard says an event should not have more than one. */
export const MAX_RULES_PER_EVENT = 8;

/**
 * Clock readings one rule line may name for a day by its own lists: the members of BYHOUR, BYMINUTE
 * and BYSECOND, multiplied (a list the line does not write counts as one, and a start that is a
 * date has no clock). An event every minute, written as a daily rule with all 24 hours and all 60
 * minutes, is 1,440 and is walked; with a list of seconds as well a line names up to 86,400, which
 * is nobody's calendar. A line past the ceiling is not walked: its event still shows its start, and
 * the expansion says `rule_too_dense`.
 */
export const MAX_CLOCK_READINGS_PER_DAY = 1_440;

/**
 * Onsets one zone definition may hold: its blocks' own starts, the dates they list and what their
 * rules that end make. A definition written with one block a change for ten years (as this package
 * writes them) has about twenty. A definition past the ceiling is no definition: the zone is not
 * known from it.
 */
export const MAX_ZONE_ONSETS = 2_000;

/** How far a written zone definition is sampled around an event: ten years, about twenty changes. */
export const VTIMEZONE_SPAN_MAX_DAYS = 3_660;

/*
 * ── a stranger's strings, by kind ──────────────────────────────────────────────────────────────────
 *
 * Every string a stranger wrote has a ceiling by what it is, and the reader (`parseComponents`) holds
 * each before anything is made of the string: past the reader no name, no parameter value, no zone
 * name and no UID is longer than its ceiling, so a key, a comparison or a pattern over one costs no
 * more than that. What the reader does with a string past its ceiling goes by the kind, and the
 * least is lost that can be:
 *
 *   a line's own name, a parameter's name   the line is no content line: kept as it stands, like a
 *                                           line with no colon. Nothing has a word for such a name.
 *   a parameter's text                      kept as written, and read as nothing (`Param.values`).
 *   a component's name, a UID, a zone name  the component is spoilt: its event (the calendar's child
 *                                           it stands in) is dropped and the read says so by word
 *                                           (`dropped`); in a calendar's own lines the text is refused.
 *   a value                                 its line's ceiling: the text is refused (`line_too_long`).
 *
 * These are not part of `Limits`: nobody has a reason to raise one, and the zone sources hold the
 * zone name's at their own door, where a name also arrives from a caller.
 */

/**
 * A name: a property's, a parameter's, a component's. The standard gives none a length. The longest
 * in the test corpus has 32 characters (X-APPLE-TRAVEL-ADVISORY-BEHAVIOR), the longest a vendor is
 * known to write about forty. A feed that breaks its descriptions over raw lines has prose lines
 * with a colon far in; their heads are longer than this and are no names.
 */
export const MAX_NAME_CHARS = 128;

/**
 * One parameter's text, every value it lists together. What a reader here has a use for is a word, a
 * person's name, a zone's name or a few addresses (254 characters each at the most); the longest in
 * the test corpus has 46 characters. Longer ones exist, and no reader here has a word for them:
 * Thunderbird writes a whole description in HTML into ALTREP as a data URI.
 */
export const MAX_PARAM_VALUE_CHARS = 4_096;

/**
 * A zone's name, as a time or a definition writes it. The longest IANA name has 32 characters; with
 * a vendor's prefix before it 72 (the test corpus has one of 46); Exchange's own names for a zone
 * run to about sixty ("(UTC+01:00) Belgrade, Bratislava, Budapest, Ljubljana, Prague").
 */
export const MAX_ZONE_NAME_CHARS = 255;

/**
 * A UID. RFC 5545 section 3.8.4.7 asks a reader to take at least 255 octets. Exchange writes 112
 * characters (the longest in the test corpus), a UUID is 36.
 */
export const MAX_UID_CHARS = 1_024;

/*
 * ── what is remembered, and how much ───────────────────────────────────────────────────────────────
 *
 * Every memory keyed by something a stranger wrote has a ceiling and one spelling of its key; at the
 * ceiling what was used longest ago goes first.
 */

/**
 * Zones one platform source holds a formatter for, each under its name in lower case (the platform
 * takes a zone's name in any letter case, so every spelling of one name is one entry). A formatter
 * that has been used weighs about 50 kB outside the heap (Node 22, 2026-11), and a calendar names a
 * handful of zones.
 *
 * The ceiling is above the number of names the platform has (about 600 that begin with a letter;
 * the thousands of bare offsets it also takes, `+01:00`, are no calendar's zone and are not asked),
 * on purpose: a formatter that is let go is not given back at once, because the engine does not
 * count what it weighs outside the heap. With 64 held, 30,000 events in 300 real zones in rotation
 * made a formatter for every event and left 1.8 GiB behind. So a formatter once made is kept, and
 * what a text can make a source hold is one for every zone there is: 25 MiB for the 418 of the
 * platform's own list, held and used.
 */
export const PLATFORM_ZONES_HELD = 1_024;

/**
 * Names the platform does not know that one platform source remembers, as they were asked. A zone
 * only its file defines is asked of the platform first, every time, and the platform's "no" is a
 * thrown error each time it is not remembered.
 */
export const UNKNOWN_ZONE_NAMES_HELD = 256;

/**
 * Onsets one source of a file's zones holds, over every definition it has read and every year it
 * has looked at: sixteen definitions as full as a definition may be, or some four hundred as a real
 * one is (two yearly rules looked at over eight years are about seventy). Past it the zone asked
 * longest ago is forgotten and read again when it is next asked for, on the asker's steps. One zone
 * alone stays under it: its own 2,000, and eight looks of what 4,500 steps buy.
 */
export const ZONE_ONSETS_HELD = 16 * MAX_ZONE_ONSETS;

/*
 * ── what a text costs to read, and a call to answer ────────────────────────────────────────────────
 *
 * No work here grows faster than the text it is done on, and nothing is put together a character at
 * a time: text is unescaped, cut and folded by whole slices joined once.
 *
 * Reading (`readCalendar`): every character is looked at a fixed number of times. Twice to count the
 * lines and the parts, three times to unfold (two patterns and the cut into lines), once where its
 * line is scanned to the colon, and where it stands in a parameter or in a value that is read (a
 * time, a list of times, a rule, a text) no more than four times more. A line is asked for its name
 * once for an event's whole view; a zone definition's block asks its lines six times, the calendar
 * its own lines ten (`calendarInfo`), and an invitee's line its parameters ten times, each time
 * comparing names no longer than `MAX_NAME_CHARS`.
 *
 * Answering (`expandAll`, `seriesOf`, `replyFor`, `applyReply`): the count of steps and of times
 * worked out, above. Outside it, and bounded by what the call is handed: a series' rule lines are
 * set up once each, an event is put with its series by its UID, and what was found is put in order,
 * some seventeen comparisons an occurrence at the call's ceiling, each over a UID and a key no
 * longer than their kinds' ceilings.
 */

export interface Limits {
  readonly maxTextChars: number;
  readonly maxComponents: number;
  readonly maxDepth: number;
  readonly maxLineChars: number;
  readonly maxLines: number;
  readonly maxParams: number;
  readonly maxParts: number;
  readonly maxOccurrences: number;
  readonly maxOccurrencesPerCall: number;
  readonly maxSteps: number;
  readonly maxRules: number;
  readonly maxPerDay: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxTextChars: MAX_CALENDAR_TEXT_CHARS,
  maxComponents: MAX_COMPONENTS,
  maxDepth: MAX_NESTING_DEPTH,
  maxLineChars: MAX_LINE_CHARS,
  maxLines: MAX_CONTENT_LINES,
  maxParams: MAX_PARAMS_PER_LINE,
  maxParts: MAX_TEXT_PARTS,
  maxOccurrences: MAX_OCCURRENCES_PER_EXPANSION,
  maxOccurrencesPerCall: MAX_OCCURRENCES_PER_CALL,
  maxSteps: MAX_STEPS_PER_EXPANSION,
  maxRules: MAX_RULES_PER_EVENT,
  maxPerDay: MAX_CLOCK_READINGS_PER_DAY,
};
