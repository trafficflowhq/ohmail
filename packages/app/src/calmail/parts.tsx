/**
 * THE CALENDAR INSIDE MAIL, as parts mail's places mount: Today, the rest of the day under the Ohbox's empty reading
 * column, and Coming up, the next events with one person on their card. Each row opens its event in the calendar.
 * Both draw nothing where this host has no calendar or nothing is left to list.
 */
import { TodayList, type TodayListRow } from "@ohmail/ui/calendar";
import { clockTime, dayShort } from "@ohmail/app-logic/calendar";
import { comingUpOf, todayRowsOf, type TodayRow } from "@ohmail/app-logic/calendar/beside";
import { useFrame } from "../frame/commands.js";
import { useLocale, useText } from "../text/index.js";
import { useOccurrencesAhead } from "./use-occurrences.js";

/** How many rows Today shows before it says how many more there are. */
export const TODAY_ROWS = 5;
/** How far ahead Coming up looks, in days, and how many it lists. */
export const COMING_DAYS = 60;
export const COMING_ROWS = 3;

export function useRowOf(): (row: TodayRow, withDay: boolean) => TodayListRow {
  const t = useText("calmail");
  const locale = useLocale();
  const { commands } = useFrame();
  return (row, withDay) => {
    const hour = row.allDay
      ? t("allDay")
      : row.startMinute === null
        ? t("now")
        : clockTime(row.startMinute, locale);
    return {
      id: row.id,
      mark: { kind: "calendar", tone: row.hue },
      time: row.now ? t("now") : withDay ? `${dayShort(row.day, locale)} ${hour}` : hour,
      title: row.title ?? t("busy"),
      now: row.now,
      tag: row.toAnswer ? { text: t("toAnswer"), hot: true } : undefined,
      onPress: () => commands.event(row.ref),
    };
  };
}

/** The rest of today, for the Ohbox's empty reading column. */
export function TodayBeside() {
  const t = useText("calmail");
  const locale = useLocale();
  const around = useOccurrencesAhead(0);
  const rowOf = useRowOf();
  if (around === null) return null;
  const rows = todayRowsOf(around.shown, around.now);
  if (rows.length === 0) return null;
  const more = rows.length - TODAY_ROWS;
  return (
    <TodayList
      kind="today"
      label={t("today")}
      heading={{ title: t("today"), date: dayShort(around.now.day, locale) }}
      rows={rows.slice(0, TODAY_ROWS).map((row) => rowOf(row, false))}
      more={more > 0 ? t("more", { count: more }) : undefined}
    />
  );
}

/** The next events with one person, for their card. */
export function ComingUp({ address, name }: { readonly address: string; readonly name: string }) {
  const t = useText("calmail");
  const around = useOccurrencesAhead(COMING_DAYS);
  const rowOf = useRowOf();
  if (around === null) return null;
  const rows = comingUpOf(around.shown, address, COMING_ROWS, around.now);
  if (rows.length === 0) return null;
  return <TodayList kind="coming" label={t("coming", { name })} rows={rows.map((row) => rowOf(row, true))} />;
}
