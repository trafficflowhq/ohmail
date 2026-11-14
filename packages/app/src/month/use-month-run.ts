import { useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from "react";
import { addDays, dayNumberOf, firstOfMonth, monthOfDay, weekStartOf } from "@ohmail/app-logic/calendar";
import { motionReduced } from "@ohmail/ui/base";

const DAYS = 7;
const FIT = 6;
const BUFFER = 4;
const HALF_RUN = 520;

export interface MonthRun {
  readonly first: string;
  readonly last: string;
  readonly month: string;
  readonly visibleFirst: string;
  readonly visibleLast: string;
  readonly start: number;
  readonly count: number;
  readonly rowHeight: number;
  readonly height: number;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly onScroll: (event: UIEvent<HTMLDivElement>) => void;
  readonly jump: (day: string) => void;
}

/** The month with the greatest share of the weeks currently in view. */
function monthInView(firstWeek: string, top: number, end: number): string {
  const months = new Map<string, number>();
  for (let row = Math.floor(top); row < end; row += 1) {
    const share = Math.min(end, row + 1) - Math.max(top, row);
    for (let day = 0; day < DAYS; day += 1) {
      const month = monthOfDay(addDays(firstWeek, row * DAYS + day));
      months.set(month, (months.get(month) ?? 0) + share);
    }
  }
  let best = monthOfDay(firstWeek);
  let weight = 0;
  for (const [month, share] of months) {
    if (share > weight) {
      best = month;
      weight = share;
    }
  }
  return best;
}

/** Keep a small window of occurrence rows mounted inside the kit's continuous grid. */
export function useMonthRun(anchor: string | null, weekStart: number): MonthRun | null {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ height: 0, minRow: 0 });
  const [position, setPosition] = useState<{ first: string; row: number } | null>(null);
  const active = anchor !== null;
  const year = Number(anchor?.slice(0, 4) ?? "2000");
  const middle = `${String(Math.min(9999, Math.floor(year / 10) * 10 + 5)).padStart(4, "0")}-01-01`;
  const middleWeek = weekStartOf(middle, weekStart);
  const earliest = weekStartOf("0001-01-07", weekStart);
  const latest = weekStartOf("9999-12-24", weekStart);
  const firstWeek = addDays(middleWeek, -HALF_RUN * DAYS);
  const lastWeek = addDays(middleWeek, HALF_RUN * DAYS);
  const first = dayNumberOf(firstWeek) === null || firstWeek < earliest ? earliest : firstWeek;
  const last = dayNumberOf(lastWeek) === null || lastWeek > latest ? latest : lastWeek;
  const total = (dayNumberOf(last)! - dayNumberOf(first)!) / DAYS + 1;
  const rowOf = (day: string) => (dayNumberOf(weekStartOf(day, weekStart))! - dayNumberOf(first)!) / DAYS;
  const monthStart = (day: string) => rowOf(firstOfMonth(monthOfDay(day)));
  const rowHeight = Math.max(1, room.minRow, Math.ceil(room.height / FIT));
  const roomInRows = room.height > 0 ? room.height / rowHeight : FIT;
  const maxRow = Math.max(0, total - roomInRows);
  const initial = anchor === null ? 0 : Math.max(0, Math.min(maxRow, monthStart(anchor)));
  const picked = anchor === null ? 0 : rowOf(anchor);
  const top = position?.first === first ? position.row : initial;
  const before = useRef<{ first: string; rowHeight: number; anchor: string; row: number } | null>(null);

  useLayoutEffect(() => {
    if (!active) {
      before.current = null;
      setPosition(null);
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const height = el.clientHeight;
      const minRow = parseFloat(getComputedStyle(el).getPropertyValue("--cal-month-week-min")) || 0;
      setRoom((prev) => (prev.height === height && prev.minRow === minRow ? prev : { height, minRow }));
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [active]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !anchor || room.height === 0) return;
    const previous = before.current;
    let row = previous?.first === first ? previous.row : initial;
    const resized = previous?.first !== first || previous.rowHeight !== rowHeight;
    if (!resized && previous.anchor !== anchor) {
      if (picked < row) row = picked;
      else if (picked + 1 > row + roomInRows + 0.01) row = Math.ceil(picked + 1 - roomInRows);
    }
    if (resized || row !== previous.row) {
      el.scrollTop = Math.max(0, Math.min(maxRow, row)) * rowHeight;
      row = el.scrollTop / rowHeight;
      setPosition({ first, row });
    }
    before.current = { first, rowHeight, anchor, row };
  }, [anchor, room.height, first, rowHeight, initial, picked, maxRow, roomInRows]);

  if (anchor === null) return null;
  const end = Math.min(total, top + roomInRows);
  const start = Math.max(0, Math.floor(top / BUFFER) * BUFFER - BUFFER);
  const stop = Math.min(total, Math.ceil(end / BUFFER) * BUFFER + BUFFER);
  const weekAt = (row: number) => addDays(first, row * DAYS);
  return {
    first: weekAt(start),
    last: addDays(weekAt(stop - 1), DAYS - 1),
    month: room.height === 0 ? monthOfDay(anchor) : monthInView(first, top, end),
    visibleFirst: weekAt(Math.floor(top)),
    visibleLast: addDays(weekAt(Math.ceil(end) - 1), DAYS - 1),
    start,
    count: stop - start,
    rowHeight,
    height: total * rowHeight,
    scrollRef,
    onScroll: (event) => {
      const current = before.current;
      if (!current || current.first !== first || current.rowHeight !== rowHeight) return;
      const row = event.currentTarget.scrollTop / rowHeight;
      current.row = row;
      setPosition((prev) => (prev?.first === first && prev.row === row ? prev : { first, row }));
    },
    jump: (day) => {
      const el = scrollRef.current;
      const target = monthStart(day);
      if (!el || room.height === 0 || target < 0 || target >= total) return;
      const row = Math.max(0, Math.min(maxRow, target));
      if (motionReduced(el)) {
        el.scrollTop = row * rowHeight;
        if (before.current) before.current.row = row;
        setPosition({ first, row });
      } else {
        el.scrollTo({ top: row * rowHeight, behavior: "smooth" });
      }
      // The explicit jump owns this scroll. The route change only updates the picked day.
      if (before.current) before.current.anchor = day;
    },
  };
}
