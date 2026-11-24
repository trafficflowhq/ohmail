/**
 * WHEN A LETTER WAS WRITTEN, as its head prints it, on the reader's own calendar and through the engine's one stamp
 * rule (`stamp.ts`; nothing here formats a date itself): the clock today, "yesterday" and the clock, the day and the
 * clock this year, the year added before that. The full form is the stamp's other face.
 */
import {
  appointmentStamp,
  clock,
  dateClock,
  fullDateTime,
  isOwnOutbound,
  messageStamp,
  shownDateOf,
  VIEW_OF_FOLDER,
  weekdayClock,
  weekdayDateClock,
  zonedDayNumber,
  zonedFields,
} from "@ohmail/client-engine";
import type { EngineMessage } from "@ohmail/wire";

export interface StampWords {
  /** "yesterday {time}" in the reader's language. */
  readonly yesterday: (time: string) => string;
}

/** The zone the reader's clock shows: the window's own, as every stamp of the product reads it. */
export function readerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const DAY = 86_400_000;
/** The weekday a stamp of the rule leads with. */
const weekdayOf = (at: Date, zone: string, locale: string): string =>
  weekdayClock(at, zone, locale).split(" ")[0] ?? "";
/** The year the rule's full form ends its date with. */
const yearOf = (at: Date, zone: string, locale: string): string =>
  /\b(\d{4}),/.exec(fullDateTime(at, zone, locale))?.[1] ?? "";

/** The day and the month of the rule's dated form ("4 Nov"): its `dateClock` with the clock's part left off. */
const dayMonthOf = (at: Date, zone: string, locale: string, time: string): string =>
  dateClock(at, zone, locale).slice(0, -(time.length + 2));

/** The instant on the letter's stamp, using arrival when a copy has no sort instant. */
export function letterStampInstant(
  message: Pick<EngineMessage, "date" | "sortAt" | "arrivedAt">,
): string | null {
  return shownDateOf({ date: message.date, sortAt: message.sortAt ?? message.arrivedAt });
}

/**
 * The head's stamp: `when` as it stands, `full` for its title and its pressed face, `short` for a narrow head (the
 * clock today, the day and the month before it). This year the weekday, the day and the month, then the clock, two
 * parts and one space. Empty without a date.
 */
export function headStamp(
  iso: string | null | undefined,
  now: Date,
  zone: string,
  locale: string,
  words: StampWords,
): { readonly when: string; readonly full: string; readonly short: string } {
  const at = iso ? new Date(iso) : null;
  if (at === null || Number.isNaN(at.getTime())) return { when: "", full: "", short: "" };
  const time = clock(at, zone);
  const full = fullDateTime(at, zone, locale);
  const near = appointmentStamp(at, now, zone, locale);
  if (near === time) return { when: time, full, short: time };
  const short = dayMonthOf(at, zone, locale, time);
  /* Inside the week the rule names the weekday alone: the one it shares with the day before today is yesterday. */
  const inWeek = near === weekdayClock(at, zone, locale);
  if (
    inWeek &&
    at < now &&
    weekdayOf(at, zone, locale) === weekdayOf(new Date(now.getTime() - DAY), zone, locale)
  )
    return { when: words.yesterday(time), full, short: words.yesterday(time) };
  const year = yearOf(at, zone, locale);
  const day = `${weekdayOf(at, zone, locale)} ${short}`;
  return {
    when: year === yearOf(now, zone, locale) ? `${day} ${time}` : `${day} ${year} ${time}`,
    full,
    short,
  };
}

/** The brief date beside the sender on a conversation square's tip. */
export function squareStamp(
  message: EngineMessage,
  now: Date,
  zone: string,
  locale: string,
  words: StampWords & { today: (time: string) => string },
): string {
  const iso = letterStampInstant(message);
  if (iso === null) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const ago = zonedDayNumber(now, zone) - zonedDayNumber(at, zone);
  if (ago === 0) return words.today(clock(at, zone));
  if (ago === 1) return words.yesterday(clock(at, zone));
  return zonedFields(at, zone).year === zonedFields(now, zone).year
    ? weekdayDateClock(at, zone, locale)
    : fullDateTime(at, zone, locale);
}

/** The responder's time belongs to the original letter. An unreadable time leaves the fact alone. */
export function awayAnswerStamp(
  message: EngineMessage,
  now: Date,
  zone: string,
  locale: string,
): { when: string; full: string } | null {
  const date = message.awayRepliedAt;
  if (!date || message.autoReplyByUs || isOwnOutbound(message)) return null;
  const when = messageStamp({ date }, now, zone, locale);
  return { when, full: when ? fullDateTime(new Date(date), zone, locale) : "" };
}

/** The place a letter's folder is shown in (`ohbox`, `reads`, …), or null for a folder no place shows. */
export function placeOfFolder(folder: string | null | undefined): string | null {
  return folder == null ? null : ((VIEW_OF_FOLDER as Record<string, string | undefined>)[folder] ?? null);
}
