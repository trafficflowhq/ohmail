import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Icon } from "../icons.js";
import "./date-picker.css";

/**
 * DATE PICKER — a month grid anchored to the control that opened it.
 *
 * The resurface chooser used a native `<input type="date">`: the
 * operating system drew the calendar in its own look, opened it downward from a control that
 * stands at the foot of the reading column, and let it run off the bottom of the display. This
 * is the same choice — a calendar day — drawn in the product's own tokens, placed where it fits,
 * and operable from the keyboard.
 *
 * THE WORDS COME FROM THE HOST. This package has no catalogue, so every string is a prop
 * (`labels`), the way `SearchBox` and `CommandPalette` take theirs; and the month and weekday
 * names come from `Intl.DateTimeFormat` in the host's locale — the same source the shell's
 * `format.ts` reads its "Fri" and "Sept." from — never from an array written here.
 *
 * DAYS ARE CALENDAR DAYS, "YYYY-MM-DD", never instants. The host decides what "today" is and
 * which zone it is in (the shell's `dayValue` does), and receives the picked day as the same
 * string; every date computed here runs through `Date.UTC` so no zone can move a day.
 *
 * PLACEMENT: below the anchor when the whole card fits there, above it otherwise, and never
 * outside the viewport on either axis — the same order the shell's overlay clamp states for the
 * sender sheet. Measured after render (`useLayoutEffect`) and again on resize.
 *
 * KEYBOARD (the grid roves; one cell holds the tab stop):
 *   ← → ↑ ↓   one day, one week; crossing a month edge shows that month
 *   Home End  first and last day of the week
 *   PgUp PgDn the same day a month earlier or later
 *   ↵ Space   pick the focused day (nothing on a disabled day)
 *   Esc       close — the HOST returns focus to its trigger, as it does for the More menu
 * A key the picker handles reaches nothing else (`stopImmediatePropagation` on the native event,
 * for the reason `MoreMenu` states: the shell's key registry listens on `document` too).
 */

export interface DatePickerLabels {
  /** The dialog's accessible name — what is being picked ("Pick a date"). */
  dialog: string;
  prevMonth: string;
  nextMonth: string;
  /** Spoken after today's date in its cell's label ("today"). */
  today: string;
}

export interface DatePickerProps {
  /** BCP 47 tag for month and weekday names — the host's active locale. */
  locale: string;
  /** Today's calendar day, "YYYY-MM-DD", as the host reckons it. */
  today: string;
  /** Earliest pickable day, inclusive; days before it render disabled. */
  min?: string;
  /** The chosen day, if there is one — rendered selected, and the initial cursor. */
  value?: string | null;
  onPick: (day: string) => void;
  onClose: () => void;
  /** The control that opened the picker: placement is measured from its box. */
  anchor: HTMLElement | null;
  labels: DatePickerLabels;
  /** 1 = Monday … 7 = Sunday. Defaults to the locale's own week start, Monday where unknown. */
  weekStart?: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  className?: string;
}

/* ── calendar arithmetic, all in UTC so a zone can never move a day ─────────────────────────── */

export interface Day { y: number; m: number; d: number }

export function parseDay(s: string): Day | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}
export function dayKey(day: Day): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${String(day.y).padStart(4, "0")}-${p(day.m)}-${p(day.d)}`;
}
function ofUtc(ms: number): Day {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
export function addDays(day: Day, n: number): Day {
  return ofUtc(Date.UTC(day.y, day.m - 1, day.d + n));
}
export function addMonths(day: Day, n: number): Day {
  // Clamp to the target month's length so "the same day a month later" never spills over.
  const last = new Date(Date.UTC(day.y, day.m - 1 + n + 1, 0)).getUTCDate();
  return ofUtc(Date.UTC(day.y, day.m - 1 + n, Math.min(day.d, last)));
}
export function compareDays(a: Day, b: Day): number {
  return Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d);
}
/** ISO weekday of a day, 1 = Monday … 7 = Sunday. */
export function isoWeekday(day: Day): number {
  const w = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
  return w === 0 ? 7 : w;
}
/** The locale's first day of the week, 1 = Monday … 7 = Sunday; Monday where the runtime cannot say. */
export function localeWeekStart(locale: string): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  try {
    const L = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = L.getWeekInfo?.() ?? L.weekInfo;
    const fd = info?.firstDay;
    if (fd && fd >= 1 && fd <= 7) return fd as 1 | 2 | 3 | 4 | 5 | 6 | 7;
  } catch { /* an unknown tag: Monday */ }
  return 1;
}
/**
 * The 42 cells of a month view: six full weeks starting on the week's first day, so the grid
 * keeps one height across months. `outside` marks the days that belong to the neighbours.
 */
export function monthGrid(view: { y: number; m: number }, weekStart: number): Array<Day & { outside: boolean }> {
  const first: Day = { y: view.y, m: view.m, d: 1 };
  const lead = (isoWeekday(first) - weekStart + 7) % 7;
  const start = addDays(first, -lead);
  const out: Array<Day & { outside: boolean }> = [];
  for (let i = 0; i < 42; i++) {
    const day = addDays(start, i);
    out.push({ ...day, outside: day.m !== view.m || day.y !== view.y });
  }
  return out;
}

/* ── placement: below when it fits, else above, always inside the viewport ─────────────────── */

export const DP_GAP = 8;
export const DP_EDGE = 10;

export function placeDatePicker(
  anchor: { top: number; bottom: number; left: number; right: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number; side: "below" | "above" } {
  const below = viewport.height - DP_EDGE - (anchor.bottom + DP_GAP);
  const above = anchor.top - DP_GAP - DP_EDGE;
  let side: "below" | "above" = "below";
  let top: number;
  if (size.height <= below) top = anchor.bottom + DP_GAP;
  else if (size.height <= above) { top = anchor.top - DP_GAP - size.height; side = "above"; }
  else { top = anchor.bottom + DP_GAP; side = below >= above ? "below" : "above"; if (side === "above") top = anchor.top - DP_GAP - size.height; }
  /* Clamp the NEAR edge to the inset, and never past it. The far edge is the card's own
     business: `date-picker.css` caps it to the window (`max-width`/`max-height` with
     `overflow: auto`), so by the time this reads `offsetWidth`/`offsetHeight` the size it is
     given already fits — which is what lets one `Math.max`/`Math.min` pair hold the promise
     instead of two sources disagreeing about who yields. A caller that hands in a size larger
     than the window still gets the near edge pinned rather than a negative coordinate. */
  top = Math.max(DP_EDGE, Math.min(top, viewport.height - DP_EDGE - size.height));
  const left = Math.max(DP_EDGE, Math.min(anchor.left, viewport.width - DP_EDGE - size.width));
  return { top, left, side };
}

/* ── the component ─────────────────────────────────────────────────────────────────────────── */

export function DatePicker({
  locale,
  today,
  min,
  value,
  onPick,
  onClose,
  anchor,
  labels,
  weekStart,
  className,
}: DatePickerProps) {
  const todayDay = parseDay(today) ?? ofUtc(Date.now());
  const minDay = min ? parseDay(min) : null;
  const valueDay = value ? parseDay(value) : null;
  const start = weekStart ?? localeWeekStart(locale);
  const enabled = useCallback((d: Day) => !minDay || compareDays(d, minDay) >= 0, [minDay]);

  /* The cursor: the chosen day, else today — and never before `min` in EITHER branch. A host
     that passes a `value` older than its own floor (a resurface day that has since passed) would
     otherwise open with the tab stop on a disabled cell, where Enter does nothing and says
     nothing about why. */
  const wanted = valueDay ?? todayDay;
  const initial = minDay && compareDays(wanted, minDay) < 0 ? minDay : wanted;
  const [cursor, setCursor] = useState<Day>(initial);
  const [view, setView] = useState<{ y: number; m: number }>({ y: initial.y, m: initial.m });
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; side: "below" | "above" } | null>(null);

  const monthName = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" });
  const weekdayName = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const fullName = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" });
  const ms = (d: Day) => Date.UTC(d.y, d.m - 1, d.d);

  const cells = monthGrid(view, start);
  const weekdays = cells.slice(0, 7).map((d) => weekdayName.format(ms(d)));
  // The previous month is reachable while it still holds a pickable day.
  const prevAllowed = !minDay || compareDays({ y: view.y, m: view.m, d: 1 }, minDay) > 0;

  // Placement, from the anchor's box, after the card has a size; again on resize.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const place = () => {
      const a = anchor?.getBoundingClientRect() ?? { top: 0, bottom: 0, left: DP_EDGE, right: DP_EDGE };
      const next = placeDatePicker(a, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
      setPos((p) => (p && p.top === next.top && p.left === next.left && p.side === next.side ? p : next));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor, view.y, view.m]);

  /**
   * Focus follows the cursor — into the grid once the card is placed (a hidden element cannot
   * take focus, and the card is hidden until its first placement), then onto the new cell after
   * every move.
   *
   * BUT ONLY WHILE THE GRID HAS FOCUS. A press on a month arrow moves the cursor too, and this
   * effect would then yank focus off the arrow and into the new month's grid — so the arrow
   * could be used exactly once from the keyboard and every further step needed a Shift+Tab back.
   * The same applies to a re-place on resize, which changes `pos` and would otherwise pull focus
   * out of whatever the reader had reached. So: if something inside this card already holds
   * focus and it is not a day cell, leave it alone.
   */
  useEffect(() => {
    if (!pos) return;
    const root = rootRef.current;
    if (!root) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && root.contains(active) && !active.hasAttribute("data-day")) return;
    root.querySelector<HTMLButtonElement>(`[data-day="${dayKey(cursor)}"]`)?.focus();
  }, [pos, cursor, view.y, view.m]);

  // An outside press dismisses — `mousedown`, so the press that opened this cannot close it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (anchor && anchor.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [anchor, onClose]);

  const move = (next: Day) => {
    setCursor(next);
    if (next.m !== view.m || next.y !== view.y) setView({ y: next.y, m: next.m });
  };
  const showMonth = (n: number) => {
    const first = addMonths({ y: view.y, m: view.m, d: 1 }, n);
    setView({ y: first.y, m: first.m });
    /* KEEP THE CURSOR IN THE MONTH BEING SHOWN. Stepping it by the same `n` is right only while
       it sits in the month we are leaving; a cursor on a NEIGHBOUR's cell (they are rendered, and
       focusable) would land two months from the new view, where no cell carries it — and then no
       cell has `tabIndex=0` at all and Tab skips the whole calendar. */
    setCursor((cur) => {
      const moved = addMonths(cur, n);
      return moved.y === first.y && moved.m === first.m ? moved : first;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const claim = () => { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); };
    /* Escape closes from anywhere in the dialog — including from a month arrow, which is where a
       reader who has just stepped a month is standing. */
    if (e.key === "Escape") { claim(); onClose(); return; }
    /**
     * EVERY OTHER KEY BELONGS TO THE GRID'S ROVING CURSOR, and this guard is the difference
     * between a working month arrow and a booby-trapped one. This handler sits on the dialog
     * ROOT, so a keydown on `.dp-nav` bubbles to it; without the guard, `claim()` would
     * `preventDefault()` the button's own activation and the `Enter` arm would then pick the
     * cursor's day — so pressing Enter on "Next month" scheduled a resurface for a day the
     * reader never chose, and closed the picker to prove it.
     */
    const target = e.target as HTMLElement | null;
    if (!target || !target.hasAttribute("data-day")) return;
    switch (e.key) {
      case "ArrowLeft": claim(); return move(addDays(cursor, -1));
      case "ArrowRight": claim(); return move(addDays(cursor, 1));
      case "ArrowUp": claim(); return move(addDays(cursor, -7));
      case "ArrowDown": claim(); return move(addDays(cursor, 7));
      case "Home": claim(); return move(addDays(cursor, -((isoWeekday(cursor) - start + 7) % 7)));
      case "End": claim(); return move(addDays(cursor, 6 - ((isoWeekday(cursor) - start + 7) % 7)));
      case "PageUp": claim(); return move(addMonths(cursor, -1));
      case "PageDown": claim(); return move(addMonths(cursor, 1));
      case "Enter":
      case " ": claim(); if (enabled(cursor)) onPick(dayKey(cursor)); return;
      default: return;
    }
  };

  const style: CSSProperties = pos
    ? { top: pos.top, left: pos.left }
    : { top: 0, left: 0, visibility: "hidden" };

  return (
    <div
      ref={rootRef}
      className={className ? `dp ${className}` : "dp"}
      role="dialog"
      aria-label={labels.dialog}
      data-side={pos?.side}
      style={style}
      onKeyDown={onKeyDown}
    >
      <div className="dp-head">
        <button type="button" className="dp-nav dp-nav-prev" aria-label={labels.prevMonth} disabled={!prevAllowed} onClick={() => showMonth(-1)}>
          <Icon name="chev" size={12} />
        </button>
        <div className="dp-month" aria-live="polite">{monthName.format(ms({ y: view.y, m: view.m, d: 1 }))}</div>
        <button type="button" className="dp-nav dp-nav-next" aria-label={labels.nextMonth} onClick={() => showMonth(1)}>
          <Icon name="chev" size={12} />
        </button>
      </div>
      <div className="dp-grid" role="grid" aria-label={monthName.format(ms({ y: view.y, m: view.m, d: 1 }))}>
        <div className="dp-row" role="row">
          {weekdays.map((w, i) => (
            <div key={i} className="dp-wd" role="columnheader">{w}</div>
          ))}
        </div>
        {[0, 1, 2, 3, 4, 5].map((r) => (
          <div key={r} className="dp-row" role="row">
            {cells.slice(r * 7, r * 7 + 7).map((d) => {
              const key = dayKey(d);
              const isToday = compareDays(d, todayDay) === 0;
              const isSel = !!valueDay && compareDays(d, valueDay) === 0;
              const isCursor = compareDays(d, cursor) === 0;
              const ok = enabled(d);
              const label = isToday ? `${fullName.format(ms(d))}, ${labels.today}` : fullName.format(ms(d));
              return (
                <button
                  key={key}
                  type="button"
                  role="gridcell"
                  className="dp-day num"
                  data-day={key}
                  data-today={isToday ? "" : undefined}
                  data-outside={d.outside ? "" : undefined}
                  aria-selected={isSel}
                  aria-disabled={ok ? undefined : true}
                  aria-label={label}
                  tabIndex={isCursor ? 0 : -1}
                  onClick={() => { if (ok) onPick(key); }}
                  /**
                   * `setCursor`, NOT `move` — and this is the second time this line has been
                   * wrong, in opposite directions.
                   *
                   * It cannot change the shown MONTH, because focus arrives before the press
                   * completes: a real pointer press is `mousedown` → focus → `mouseup` → `click`.
                   * Moving the view on focus unmounted the very cell being pressed, so a
                   * neighbouring month's day could be focused and the month would change, but
                   * `onPick` never ran — the day was unselectable by mouse, while a synthetic
                   * `click` with no focus step passed happily.
                   *
                   * The tab-stop problem that made this `move` is instead solved where it
                   * belongs, in `showMonth`: a cursor outside the shown month is clamped into it
                   * when the month steps, so there is always exactly one cell with `tabIndex=0`.
                   */
                  onFocus={() => { if (!isCursor) setCursor(d); }}
                >
                  {d.d}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
