/**
 * RESURFACE: WHEN. The chooser of today's reader in the new design's menu: the time, visible before any choice;
 * Now (a state, not a date); Tomorrow and Next week, each naming the day and the hour it books; Pick a date, a month
 * floored at the first day the time is still ahead; Cancel. Every dated answer is minted AT THE PRESS from the
 * horizons of `@ohmail/app-logic/reader` (the reader's zone, the clocks' two nights said out loud), never from the
 * moment the menu painted. The time starts at the account's stored hour where one is handed, else the product's.
 */
import { useEffect, useState, type RefObject } from "react";
import { Menu, MenuItem, MenuNote } from "@ohmail/ui/base";
import { MiniMonth, type MiniMonthDay } from "@ohmail/ui/calendar";
import {
  dayAtIn,
  dayValueIn,
  DEFAULT_RESURFACE_TIME,
  firstDayAtIn,
  horizonFull,
  horizonStamp,
  readerZone,
  resurfaceClock,
  resurfaceHorizonsIn,
  type ResurfaceHorizon,
} from "@ohmail/app-logic/reader";
import type { MessageAction } from "@ohmail/app-logic/press/actions";
import { useLocale, useText } from "../../text/index.js";

const pad = (n: number) => String(n).padStart(2, "0");

/** The stored or product hour as the field shows it. */
function hhmm(stored: string | null | undefined): string {
  const { hour, minute } = resurfaceClock(stored);
  return `${pad(hour)}:${pad(minute)}`;
}

/** The six weeks of `year`-`month` (1-based), Monday first, as calendar days `YYYY-MM-DD`. */
function sixWeeks(year: number, month: number): { id: string; inMonth: boolean; number: number }[] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(Date.UTC(year, month - 1, 1 - lead + i));
    return {
      id: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
      inMonth: d.getUTCMonth() === month - 1,
      number: d.getUTCDate(),
    };
  });
}

interface ResurfaceMenuProps {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  act: (action: MessageAction) => void;
  /** The account's resurface time (`HH:MM`), where the host hands it. */
  stored?: string | null;
  /** Keeps another hour for next time; null where nothing can be kept. */
  store?: ((hhmm: string) => Promise<unknown>) | null;
}

export function ResurfaceMenu({ open, onClose, anchor, act, stored, store }: ResurfaceMenuProps) {
  const t = useText("reader");
  const locale = useLocale();
  const [at, setAt] = useState(() => hhmm(stored ?? DEFAULT_RESURFACE_TIME));
  const [picking, setPicking] = useState(false);
  const zone = readerZone();
  const now = new Date();
  const floor = dayValueIn(firstDayAtIn(now, at, zone).iso, zone);
  const today = dayValueIn(now.toISOString(), zone);
  useEffect(() => {
    if (open) return;
    setPicking(false);
    setAt(hhmm(stored ?? DEFAULT_RESURFACE_TIME));
  }, [open, stored]);

  const answer = (action: MessageAction) => {
    onClose();
    act(action);
  };
  /*
   * Minted at the press: a menu left open across midnight dispatches the day it is pressed on. Then, and only then,
   * an hour that is not the stored one is kept for next time: the letter was the ask, so a refused write leaves it
   * booked. An untouched time is no decision, and Now is a state the time does not apply to.
   */
  const dated = (mint: () => ResurfaceHorizon) => {
    answer(`resurface:${mint().iso}`);
    if (!store || at === hhmm(stored ?? DEFAULT_RESURFACE_TIME)) return;
    store(at).catch((err: unknown) => console.warn("the resurface time was not stored", err));
  };
  const { tomorrow, nextWeek } = resurfaceHorizonsIn(now, at, zone);
  const note = (h: ResurfaceHorizon) => horizonStamp(h, now, zone, locale);
  const skipped = [
    { name: t("resurface.tomorrow"), horizon: tomorrow },
    ...(nextWeek ? [{ name: t("resurface.nextWeek"), horizon: nextWeek }] : []),
  ].find((x) => x.horizon.verdict === "shifted_forward");

  if (picking)
    return (
      <PickDay
        open={open}
        onClose={onClose}
        anchor={anchor}
        at={at}
        floor={floor}
        today={today}
        onPick={(id) => dated(() => dayAtIn(id, at, zone))}
        onBack={() => setPicking(false)}
      />
    );

  return (
    <Menu
      open={open}
      onClose={onClose}
      anchor={anchor}
      label={t("verb.resurface")}
      title={t("verb.resurface")}
      up
    >
      <label className="rd-resurface-at">
        <span>{t("resurface.time")}</span>
        <input
          className="rd-resurface-time"
          type="time"
          aria-label={t("resurface.time")}
          value={at}
          onChange={(e) => {
            /* Cleared mid-edit is no time: the last real one stands, so the field never disagrees with the days. */
            if (e.target.value !== "") setAt(e.target.value);
          }}
        />
      </label>
      <MenuItem icon="resurface" onPress={() => answer("resurface_now")}>
        {t("resurface.now")}
      </MenuItem>
      <MenuItem
        icon="day"
        note={note(tomorrow)}
        onPress={() => dated(() => resurfaceHorizonsIn(new Date(), at, zone).tomorrow)}
      >
        {t("resurface.tomorrow")}
      </MenuItem>
      {nextWeek ? (
        <MenuItem
          icon="week"
          note={note(nextWeek)}
          onPress={() =>
            dated(() => {
              const h = resurfaceHorizonsIn(new Date(), at, zone);
              return h.nextWeek ?? h.tomorrow;
            })
          }
        >
          {t("resurface.nextWeek")}
        </MenuItem>
      ) : null}
      {skipped ? (
        <MenuNote>
          {t("resurface.skip", { horizon: skipped.name, booked: skipped.horizon.time, asked: at })}
        </MenuNote>
      ) : null}
      <MenuItem icon="calendar" onPress={() => setPicking(true)}>
        {t("resurface.pick")}
      </MenuItem>
      <MenuItem onPress={onClose}>{t("resurface.cancel")}</MenuItem>
    </Menu>
  );
}

/** Pick a date: a month to find the day in, floored at the first day the time is still ahead; the keys open on that day. */
function PickDay({
  open,
  onClose,
  anchor,
  at,
  floor,
  today,
  onPick,
  onBack,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  at: string;
  /** The first day (`YYYY-MM-DD`) the time is still ahead. */
  floor: string;
  today: string;
  onPick: (day: string) => void;
  onBack: () => void;
}) {
  const t = useText("reader");
  const locale = useLocale();
  const zone = readerZone();
  const [shown, setShown] = useState(() => ({
    year: Number(today.slice(0, 4)),
    month: Number(today.slice(5, 7)),
  }));
  const noon = (id: string) => new Date(dayAtIn(id, "12:00", zone).iso);
  const cells = sixWeeks(shown.year, shown.month);
  const days: MiniMonthDay[] = cells.map((c) => ({
    id: c.id,
    number: String(c.number),
    label: horizonFull(dayAtIn(c.id, at, zone), zone, locale),
    today: c.id === today,
    outside: !c.inMonth,
    /* A day before the floor books a moment already past: the kit's unavailable day, said so and answering no press. */
    disabled: c.id < floor,
  }));
  const shownMonth = `${shown.year}-${pad(shown.month)}`;
  const step = (by: number) => () =>
    setShown((s) => {
      const m = s.month - 1 + by;
      return { year: s.year + Math.floor(m / 12), month: (((m % 12) + 12) % 12) + 1 };
    });
  return (
    <Menu open={open} onClose={onClose} anchor={anchor} label={t("resurface.pick")} up>
      <MiniMonth
        takesKeys
        size="widget"
        head={{
          title: t("resurface.month", { month: noon(`${shown.year}-${pad(shown.month)}-15`) }),
          hot: today.slice(0, 7) === shownMonth,
          /* No way back into a month that holds no day that can still be booked: today's picker had none either. */
          before: {
            label: t("resurface.prevMonth"),
            onPress: shownMonth > floor.slice(0, 7) ? step(-1) : undefined,
          },
          after: { label: t("resurface.nextMonth"), onPress: step(1) },
        }}
        weekdays={cells.slice(0, 7).map((c) => t("resurface.weekday", { day: noon(c.id) }))}
        days={days}
        onDayPress={(id) => {
          /* A day before the floor books a moment already past: it is not an answer. */
          if (id >= floor) onPick(id);
        }}
      />
      <MenuItem icon="back" onPress={onBack}>
        {t("resurface.back")}
      </MenuItem>
    </Menu>
  );
}
