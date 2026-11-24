/**
 * The keys of a month to find a day in: one stop of Tab, on the day that holds the keys (the picked
 * day, else today, else the month's first that can be pressed). The arrows move a day and a week,
 * Home and End to the week's ends, PageUp and PageDown a month, over the days that can be pressed;
 * past the days on screen the keys go on by the head's way on, to the same weekday (an arrow) or the
 * same date (a page), as today's picker did. Enter and Space press the day.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { onTouch } from "../../base/Overlays/overlay-focus.js";
import type { MiniMonthDay, MiniMonthProps } from "./MiniMonth.js";

/** The day Tab stops on. */
const toStop = (grid: HTMLElement | null) => grid?.querySelector<HTMLElement>('[tabindex="0"]');

/**
 * Where the keys go past the days on screen: into the month before or after, by its way on, and which of its days
 * they land on: of the days shown that can be pressed, by their place on screen (from 0) and the month they draw.
 */
type Way = {
  to: "before" | "after";
  land: (shown: { day: MiniMonthDay; at: number }[]) => MiniMonthDay | undefined;
};
const first: Way["land"] = (shown) => shown[0]?.day;
const last: Way["land"] = (shown) => shown[shown.length - 1]?.day;
/** The same weekday: the first of the month or its last. */
const column =
  (col: number, end: Way["land"]): Way["land"] =>
  (shown) =>
    end(shown.filter((s) => s.at % 7 === col)) ?? end(shown);
/** The same date, else the next that can be pressed, else the month's last (a month shorter than the 31st). */
const date =
  (n: number): Way["land"] =>
  (shown) =>
    shown.find((s) => Number(s.day.number) >= n)?.day ?? last(shown);

export function useDayKeys(
  days: MiniMonthDay[],
  size: MiniMonthProps["size"],
  takesKeys: boolean | undefined,
  onDayPress: MiniMonthProps["onDayPress"],
) {
  /* A day the keys can rest on: one that can be pressed, and is shown (a small month hides the months beside it). */
  const hidesOutside = size === "widget" || size === "year";
  const rests = (d: MiniMonthDay | undefined) => !!d && !d.disabled && !(hidesOutside && d.outside);
  const [held, setHeld] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement | null>(null);
  const before = useRef<HTMLButtonElement | null>(null);
  const after = useRef<HTMLButtonElement | null>(null);
  /** Counts the grid's own moves: the keys follow the stop after one, never when the app redraws it. */
  const [moved, setMoved] = useState(0);
  /** A way on pressed by the keys, and the first day on screen when it was. */
  const beyond = useRef<(Way & { from: string }) | null>(null);
  const stopId = (
    days.find((d) => d.id === held && rests(d)) ??
    days.find((d) => d.picked && rests(d)) ??
    days.find((d) => d.today && rests(d)) ??
    days.find((d) => !d.outside && rests(d)) ??
    days.find(rests)
  )?.id;
  const firstId = days[0]?.id;

  function moveTo(id: string) {
    setHeld(id);
    setMoved((n) => n + 1);
  }
  /* Once the way on drew its month: its first or its last day that can be pressed. */
  useEffect(() => {
    const b = beyond.current;
    if (!b || b.from === firstId) return;
    beyond.current = null;
    const shown = days.flatMap((day, at) => (!day.outside && rests(day) ? [{ day, at }] : []));
    const to = b.land(shown) ?? days.find(rests);
    if (to) moveTo(to.id);
  });
  useEffect(() => {
    if (moved) toStop(grid.current)?.focus();
  }, [moved]);
  /* As it is drawn, once: a picker that opens with the keys on its day. */
  const takes = useRef(takesKeys);
  useEffect(() => {
    const el = grid.current;
    if (takes.current && el && !onTouch(el)) toStop(el)?.focus({ preventScroll: true });
  }, []);

  const go = (way: Way) => {
    const control = way.to === "before" ? before.current : after.current;
    if (!control || control.disabled || !firstId) return;
    beyond.current = { ...way, from: firstId };
    control.click();
  };
  /* From `from` by `by` until a day the keys can rest on; past the days on screen, the month beside. */
  const walk = (from: number, by: number, past?: Way) => {
    for (let i = from; i >= 0 && i < days.length; i += by) if (rests(days[i])) return moveTo(days[i]!.id);
    if (past) go(past);
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = days.findIndex((d) => d.id === stopId);
    const row = at - (at % 7);
    const n = Number(days[at]?.number);
    const same = Number.isNaN(n) ? first : date(n);
    const moves: Record<string, () => void> = {
      ArrowLeft: () => walk(at - 1, -1, { to: "before", land: last }),
      ArrowRight: () => walk(at + 1, 1, { to: "after", land: first }),
      ArrowUp: () => walk(at - 7, -7, { to: "before", land: column(at % 7, last) }),
      ArrowDown: () => walk(at + 7, 7, { to: "after", land: column(at % 7, first) }),
      Home: () => walk(row, 1),
      End: () => walk(Math.min(row + 6, days.length - 1), -1),
      PageUp: () => go({ to: "before", land: same }),
      PageDown: () => go({ to: "after", land: same }),
      Enter: () => stopId && onDayPress?.(stopId),
      " ": () => stopId && onDayPress?.(stopId),
    };
    const move = moves[e.key];
    if (at < 0 || !move || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    beyond.current = null;
    move();
  };
  return { grid, before, after, stopId, hold: setHeld, keys };
}
