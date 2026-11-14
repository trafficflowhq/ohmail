import { useState } from "react";
import {
  addDays,
  dayLong,
  dayShort,
  firstOfMonth,
  monthName,
  monthOfDay,
  monthWeeks,
  readerZones,
  shiftMonth,
  weekdayNames,
  weekStartOf,
  yearOf,
} from "@ohmail/app-logic/calendar";
import { MiniMonth } from "@ohmail/ui/calendar";
import { useLocale, useText, useTimeZone } from "../text/index.js";
import { NONE } from "../host/index.js";
import { useFrame } from "../frame/commands.js";
import { useFaces, useSources } from "./where.js";

export function CalendarMiniMonth({
  anchor,
  today,
  weekStart,
  weekNumbers,
  mode,
  visibleMonth,
  onPick,
  onMonth,
  onWeek,
}: {
  anchor: string;
  today: string;
  weekStart: number;
  weekNumbers?: boolean;
  mode: "rail" | "strip" | "picker";
  visibleMonth?: string;
  onPick: (day: string) => void;
  onMonth?: (day: string) => void;
  onWeek?: (day: string) => void;
}) {
  const t = useText("calendar");
  const locale = useLocale();
  const zone = useTimeZone();
  const { host, route } = useFrame();
  const [browse, setBrowse] = useState<{ anchor: string; month: string } | null>(null);
  const baseMonth = visibleMonth ?? monthOfDay(anchor);
  const position = `${anchor}/${baseMonth}`;
  const month = browse?.anchor === position ? browse.month : baseMonth;
  const first = weekStartOf(firstOfMonth(month), weekStart);
  const span = { first, last: addDays(first, 41) };
  const port = host.wires.calendar;
  const marked = useCalendarMarks(port, span, today, zone);
  const grid = monthWeeks({
    month,
    weekStart,
    today,
    picked: anchor,
    zone,
    zones: readerZones(),
    weekNumbers: weekNumbers ?? false,
    items: marked,
    keyOf: (event) => event.id,
    open: null,
  });
  const start = weekStartOf(anchor, weekStart);
  const strip = mode === "strip";
  const bands = route.place === "week" && !strip;
  const weeks = strip ? grid.weeks.filter((week) => week.id === start) : grid.weeks;
  const name = monthName(month, locale, yearOf(today));
  return (
    <MiniMonth
      size={strip ? "strip" : "rail"}
      label={strip ? t("weekOf", { date: dayShort(start, locale) }) : name}
      head={
        strip
          ? undefined
          : {
              title: name,
              hot: month === monthOfDay(today),
              before: {
                label: t("mini.before"),
                onPress: () => setBrowse({ anchor: position, month: shiftMonth(month, -1) }),
              },
              after: {
                label: t("mini.after"),
                onPress: () => setBrowse({ anchor: position, month: shiftMonth(month, 1) }),
              },
              open: onMonth && { onPress: () => onMonth(firstOfMonth(month)) },
            }
      }
      weekdays={weekdayNames(locale, weekStart, "narrow")}
      days={weeks.flatMap((week) =>
        week.days.map((d, index) => ({
          id: d.id,
          number: String(d.day),
          label: dayLong(d.id, locale, yearOf(today)),
          today: d.today,
          picked: d.picked,
          outside: !strip && d.outside,
          busy: d.more > 0 || week.pieces.some((piece) => piece.from <= index && index <= piece.to),
          band: bands && week.id === start ? (index === 0 ? "start" : index === 6 ? "end" : "in") : undefined,
        })),
      )}
      weekNumbers={
        weekNumbers
          ? weeks.map((week) =>
              week.number === null
                ? null
                : {
                    number: week.number.week,
                    label: t("weekNumber", { number: week.number.week }),
                  },
            )
          : undefined
      }
      onWeekPress={onWeek && ((row) => onWeek(weeks[row]!.id))}
      onDayPress={onPick}
      takesKeys={mode === "picker"}
    />
  );
}

function useCalendarMarks(
  port: ReturnType<typeof useFrame>["host"]["wires"]["calendar"],
  span: { first: string; last: string },
  today: string,
  zone: string,
) {
  const sources = useSources(port);
  return useFaces(port, sources, port === NONE ? null : span, today, zone, readerZones())?.events ?? [];
}
