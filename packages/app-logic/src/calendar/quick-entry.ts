import { dayOfIso } from "./grid/days.js";
import { addDays, weekStartOf } from "./spans/days.js";

type Word = { text: string; key: string; from: number; to: number };
type Part<T> = { size: number; value: T; keep?: boolean };
type DatePart = { day: string; endDay?: string };
type ClockPart = { from: number; to?: number };
type Reading = {
  title: string;
  marks: readonly (readonly [number, number])[];
  day?: string;
  endDay?: string;
  from?: number;
  to?: number;
  allDay?: boolean;
  place?: string;
  zone?: string;
  guest?: string;
  alert?: number;
};

const DAY = 1440;
const RELATIVE = new Map([
  ["today", 0],
  ["heute", 0],
  ["tomorrow", 1],
  ["morgen", 1],
  ["übermorgen", 2],
  ["uebermorgen", 2],
]);
const WEEKDAYS = [
  "monday mon montag mo",
  "tuesday tue tues dienstag di",
  "wednesday wed mittwoch mi",
  "thursday thu thur thurs donnerstag do",
  "friday fri freitag fr",
  "saturday sat samstag sa",
  "sunday sun sonntag so",
].map((day) => day.split(" "));
const MONTHS = [
  "january january jan januar",
  "february feb februar",
  "march mar märz maerz mär mrz",
  "april apr",
  "may mai",
  "june jun juni",
  "july jul juli",
  "august aug",
  "september sep sept",
  "october oct oktober okt",
  "november nov",
  "december dec dezember dez",
].map((month) => month.split(" "));
const RANGE = new Set(["-", "–", "—", "to", "bis"]);
const PLACE = new Set(["in", "at", "@", "im", "bei"]);
const NEXT = new Set(["next", "nächsten", "naechsten", "kommenden"]);
const EVERY = new Set(["every", "jeden", "jede", "jedes"]);
const clockWord = (word = ""): boolean => ["am", "pm", "uhr"].includes(word);
const dayNumber = (word = "") => Number(/^\d{1,2}\.?$/.test(word) ? word.replace(".", "") : NaN);
const found = <T>(size: number, value: T, keep = false): Part<T> => ({ size, value, keep });
const keyAt = (words: Word[], index: number): string => words[index]?.key ?? "";

function civil(day: number, month: number, today: string, year?: number): string | undefined {
  const at = (y: number) =>
    [String(y).padStart(4, "0"), String(month).padStart(2, "0"), String(day).padStart(2, "0")].join("-");
  const base = Number(today.slice(0, 4));
  const current = at(year ?? base);
  const first = year === undefined && current < today ? at(base + 1) : current;
  return dayOfIso(first) ? first : undefined;
}

function numericDate(word: string, today: string): string | undefined {
  if (dayOfIso(word)) return word;
  const date = /^(\d{1,2})[/\.](\d{1,2})(?:(?:[/\.])(\d{2}|\d{4})|\.)?$/.exec(word);
  if (!date || (!word.includes("/") && !word.endsWith(".") && !date[3])) return undefined;
  const [, d, m, y] = date;
  return civil(Number(d), Number(m), today, y ? Number(y.length === 2 ? "20" + y : y) : undefined);
}

function namedDate(words: Word[], at: number, today: string): Part<string> | undefined {
  const first = keyAt(words, at);
  const second = keyAt(words, at + 1);
  const startsWithDay = Number.isFinite(dayNumber(first));
  const month = MONTHS.findIndex((names) =>
    names.includes((startsWithDay ? second : first).replace(/\.$/, "")),
  );
  const day = dayNumber(startsWithDay ? first : second.replace(/,$/, ""));
  if (month < 0 || !Number.isFinite(day)) return undefined;
  const yearWord = keyAt(words, at + 2);
  const year = /^\d{4}$/.test(yearWord) ? Number(yearWord) : undefined;
  const read = civil(day, month + 1, today, year);
  return read ? found(year === undefined ? 2 : 3, read) : undefined;
}

function namedRange(words: Word[], at: number, today: string): Part<DatePart> | undefined {
  const short = /^(\d{1,2})\.?[-–—](\d{1,2})\.?$/.exec(keyAt(words, at));
  if (short) {
    const month = MONTHS.findIndex((names) => names.includes(keyAt(words, at + 1).replace(/\.$/, "")));
    const day = civil(Number(short[1]), month + 1, today);
    const endDay = civil(Number(short[2]), month + 1, day ?? today);
    return day && endDay && month >= 0 && Number(short[2]) >= Number(short[1])
      ? found(2, { day, endDay })
      : undefined;
  }
  const first = namedDate(words, at, today);
  if (!first || !RANGE.has(keyAt(words, at + first.size))) return undefined;
  const last = namedDate(words, at + first.size + 1, first.value);
  return last && last.value >= first.value
    ? found(first.size + 1 + last.size, { day: first.value, endDay: last.value })
    : undefined;
}

function weekdayPart(words: Word[], at: number, today: string): Part<DatePart> | undefined {
  const word = keyAt(words, at);
  const prefixed = NEXT.has(word) || EVERY.has(word) || ["this", "diesen"].includes(word);
  const i = at + Number(prefixed);
  const name = keyAt(words, i).replace(/\.$/, "");
  const weekday = WEEKDAYS.findIndex((names) => names.includes(name));
  if (weekday < 0 || (!prefixed && name.length === 2 && (i === 0 || !/^[A-Z]/.test(words[i]?.text ?? ""))))
    return undefined;
  const before = keyAt(words, at - 1);
  if ((before === "the" && keyAt(words, i + 1) === "after") || ["first", "erste", "ersten"].includes(before))
    return undefined;
  const monday = weekStartOf(today, 0);
  const inWeek = addDays(monday, weekday);
  const day = NEXT.has(word) || inWeek <= today ? addDays(inWeek, 7) : inWeek;
  return found(prefixed ? 2 : 1, { day }, EVERY.has(word));
}

function dateAt(words: Word[], at: number, today: string): Part<DatePart> | undefined {
  const word = keyAt(words, at);
  const relative = RELATIVE.get(word);
  if (relative !== undefined) return found(1, { day: addDays(today, relative) });
  if (word === "day" && keyAt(words, at + 1) === "after" && keyAt(words, at + 2) === "tomorrow")
    return found(3, { day: addDays(today, 2) });
  if (word === "in") {
    const amount = keyAt(words, at + 1);
    const unit = keyAt(words, at + 2);
    if (/^\d{1,3}$/.test(amount) && /^(?:days?|tag(?:en?)?|weeks?|wochen)$/.test(unit))
      return found(3, { day: addDays(today, Number(amount) * (unit.startsWith("w") ? 7 : 1)) });
  }
  const prefixed = ["on", "am", "den", "vom", "von", "from"].includes(word);
  const i = at + Number(prefixed);
  const range = namedRange(words, i, today);
  if (range) return found(range.size + Number(prefixed), range.value);
  const named = namedDate(words, i, today);
  if (named) return found(named.size + Number(prefixed), { day: named.value });
  const exact = numericDate(keyAt(words, i), today);
  if (exact) return found(1 + Number(prefixed), { day: exact });
  const weekday = weekdayPart(words, i, today);
  return weekday ? found(weekday.size + Number(prefixed), weekday.value, weekday.keep) : undefined;
}

type Clock = { hour: number; minute: number; suffix: string; explicit: boolean };
function clock(word: string, suffix = ""): Clock | undefined {
  const match = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)?$/.exec(word);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const sign = match[3] ?? suffix;
  const max = sign === "am" || sign === "pm" ? 12 : 23;
  if (hour > max || (max === 12 && hour === 0) || minute > 59) return undefined;
  return { hour, minute, suffix: sign, explicit: !!(match[2] || sign) };
}
function clockMinute({ hour, minute, suffix }: Clock): number {
  return (suffix === "am" || suffix === "pm" ? (hour % 12) + (suffix === "pm" ? 12 : 0) : hour) * 60 + minute;
}

function clockAt(words: Word[], at: number): Part<ClockPart> | undefined {
  const prefix = keyAt(words, at);
  const headed = /^(?:at|um|from|von)$/.test(prefix);
  const i = at + Number(headed);
  const word = keyAt(words, i);
  if (["noon", "mittags"].includes(word)) return found(1 + Number(headed), { from: 720 });
  const compact = word.split(/[-–—]/);
  const suffixAt = keyAt(words, i + 1);
  const standalone = clockWord(suffixAt) ? suffixAt : "";
  if (compact.length === 2) {
    const end = clock(compact[1]!, standalone);
    const start = clock(compact[0]!);
    if (!start || !end || (!headed && !start.explicit && !end.explicit)) return undefined;
    if (!start.explicit && /^(am|pm)$/.test(end.suffix) && start.hour >= 1 && start.hour <= 12) {
      start.suffix = start.hour > end.hour && start.hour !== 12 && end.suffix === "pm" ? "am" : end.suffix;
    }
    const from = clockMinute(start);
    const to = clockMinute(end);
    if (from === to) return undefined;
    return found(1 + Number(headed) + Number(!!standalone), { from, to: to < from ? to + DAY : to });
  }
  const one = clock(word, standalone);
  if (!one || (!headed && !one.explicit)) return undefined;
  return found(1 + Number(headed) + Number(!!standalone), { from: clockMinute(one) });
}

function minutesAt(words: Word[], at: number): Part<number> | undefined {
  const amount = keyAt(words, at + 1);
  const unit = keyAt(words, at + 2);
  if (!/^\d{1,4}$/.test(amount)) return undefined;
  const factor = /^(?:min|minute[ns]?)$/.test(unit)
    ? 1
    : /^(?:h|hrs?|hours?|std|stunden?)$/.test(unit)
      ? 60
      : /^(?:days?|tage?)$/.test(unit)
        ? DAY
        : undefined;
  const minutes = factor === undefined ? undefined : Number(amount) * factor;
  return minutes !== undefined && minutes <= 7 * DAY ? found(3, minutes) : undefined;
}

/** Reads dates, times and a few explicit fields. A proposed guest is a word until the form accepts it. */
export function readQuickEntry(
  line: string,
  { today, zoneOf }: { today: string; zoneOf?: (city: string) => string | undefined },
): Reading | null {
  const words = [...line.matchAll(/\S+/gu)].map(({ 0: text, index }) => ({
    text,
    key: text.toLowerCase(),
    from: index,
    to: index + text.length,
  }));
  const used = new Set<number>();
  const marks: [number, number][] = [];
  const claim = (at: number, size: number) => {
    marks.push([words[at]!.from, words[at + size - 1]!.to]);
    for (let i = at; i < at + size; i++) used.add(i);
  };
  let date: DatePart | undefined;
  let time: ClockPart | undefined;
  let zone: string | undefined;
  let duration: Part<number> | undefined;
  let durationAt = 0;
  let alert: number | undefined;
  let guest: string | undefined;
  for (let i = 0; i < words.length; i++) {
    if (used.has(i)) continue;
    const day = date === undefined ? dateAt(words, i, today) : undefined;
    if (day) {
      date = day.value;
      if (!day.keep) claim(i, day.size);
      i += day.size - 1;
      continue;
    }
    const when = time === undefined ? clockAt(words, i) : undefined;
    if (when) {
      time = when.value;
      claim(i, when.size);
      i += when.size - 1;
      for (const size of [2, 1]) {
        const city = words.slice(i + 1, i + 1 + size);
        zone = city.length === size ? zoneOf?.(city.map(({ text }) => text).join(" ")) : undefined;
        if (zone) {
          claim(i + 1, size);
          i += size;
          break;
        }
      }
      continue;
    }
    const word = keyAt(words, i);
    if (alert === undefined && ["alert", "erinnerung"].includes(word)) {
      const read = minutesAt(words, i);
      if (read) {
        alert = read.value;
        claim(i, read.size);
        i += read.size - 1;
      }
    } else if (duration === undefined && ["for", "für", "fuer"].includes(word)) {
      const read = minutesAt(words, i);
      if (read && read.value > 0) {
        duration = read;
        durationAt = i;
        i += read.size - 1;
      }
    } else if (guest === undefined && ["with", "mit"].includes(word)) {
      const next = words[i + 1]?.text;
      if (next && /^\p{L}[\p{L}'’-]*$/u.test(next)) guest = next;
    }
  }
  if (time && time.to === undefined && duration) claim(durationAt, duration.size);
  const place = placeAt(words, used);
  if (place) claim(place.at, place.size);
  const title = words
    .filter((_, i) => !used.has(i))
    .map(({ text }) => text)
    .join(" ");
  if (!title || (!date && !time && !place && alert === undefined && !guest)) return null;
  return {
    title: title[0]!.toUpperCase() + title.slice(1),
    marks: marks.sort(([a], [b]) => a - b),
    ...date,
    ...(time
      ? { from: time.from, to: time.to ?? time.from + (duration?.value ?? 60), allDay: false }
      : date
        ? { allDay: true }
        : {}),
    ...(zone ? { zone } : {}),
    ...(place ? { place: place.value } : {}),
    ...(guest ? { guest } : {}),
    ...(alert !== undefined ? { alert } : {}),
  };
}

function placeAt(words: Word[], used: ReadonlySet<number>) {
  for (let at = 0; at < words.length; at++) {
    const word = words[at]!;
    const attached = word.key.startsWith("@") && word.key.length > 1;
    if (used.has(at) || (!attached && !PLACE.has(word.key))) continue;
    const from = at + Number(!attached);
    const first = keyAt(words, from);
    if (
      !first ||
      used.has(from) ||
      /^\d/u.test(first) ||
      ["the", "der", "morning", "evening"].includes(first)
    )
      continue;
    let end = from;
    while (
      end < words.length &&
      !used.has(end) &&
      !["with", "mit", "after", "nach", "halb"].includes(keyAt(words, end))
    )
      end++;
    const value = words
      .slice(from, end)
      .map(({ text }) => text)
      .join(" ")
      .replace(/^@/, "");
    if (value) return { at, size: end - at, value };
  }
  return undefined;
}
