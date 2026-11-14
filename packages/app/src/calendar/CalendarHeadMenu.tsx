import { useRef, useState, type RefObject } from "react";
import { clockTime, dayOfIso, type CalendarPort } from "@ohmail/app-logic/calendar";
import { Button, Field, Menu, MenuItem } from "@ohmail/ui/base";
import { Hours } from "../calsettings/view/Hours.js";
import { useCalendarSettings } from "../calsettings/settings-read.js";
import type { CalendarPlaceId } from "../frame/contract.js";
import { useLocale, useText } from "../text/index.js";
import { CalendarMiniMonth } from "./CalendarMiniMonth.js";
import { useCalendarCheck } from "./check.js";
import type { CalendarViewSettings } from "./view.js";
import type { ViewId, Where } from "./where.js";

export type HeadMenu = "date" | "more" | "views" | "hours";
type ButtonRef = RefObject<HTMLButtonElement | null>;
type Select = (place: CalendarPlaceId) => void;

interface CalendarHeadMenuProps {
  menu: HeadMenu;
  where: Where;
  settings: CalendarViewSettings;
  port: CalendarPort;
  anchors: Readonly<Record<Exclude<HeadMenu, "hours">, ButtonRef>>;
  views: readonly { value: ViewId; label: string; keyHint: string }[];
  dated: boolean;
  toDate: (day: string) => void;
  goToView: (view: ViewId, day: string) => void;
  select: Select;
  search: () => void;
  today: () => void;
  step: (direction: number) => void;
  agenda: () => void;
  invitations: () => void;
  openSettings: () => void;
  onOpen: (menu: HeadMenu) => void;
  onClose: () => void;
}

export function CalendarHeadMenu({
  menu,
  where,
  settings,
  port,
  anchors,
  views,
  dated,
  toDate,
  goToView,
  select,
  search,
  today,
  step,
  agenda,
  invitations,
  openSettings,
  onOpen,
  onClose,
}: CalendarHeadMenuProps) {
  const t = useText("calendar");
  const ts = useText("calsettings");
  const locale = useLocale();
  const check = useCalendarCheck();
  const reading = useCalendarSettings(port, "none");
  const { place } = where;
  const timed = place === "day" || place === "week";
  const run = (act: () => void) => () => {
    onClose();
    act();
  };

  if (menu === "date")
    return (
      <DateMenu
        anchor={anchors.date}
        where={where}
        settings={settings}
        toDate={toDate}
        goToView={goToView}
        onClose={onClose}
      />
    );
  if (menu === "hours")
    return (
      <Menu
        key="hours"
        open
        kind="card"
        label={ts("view.hours")}
        title={ts("view.hours")}
        anchor={anchors.more}
        right
        onClose={onClose}
      >
        <Hours {...reading} step />
      </Menu>
    );

  return (
    <Menu key={menu} open label={t(menu)} anchor={anchors[menu]} right onClose={onClose}>
      {menu === "more" ? (
        <>
          {dated ? (
            <>
              <MenuItem icon="back" keyHint="[" onPress={run(() => step(-1))}>
                {t("before")}
              </MenuItem>
              <MenuItem icon="fwd" keyHint="]" onPress={run(() => step(1))}>
                {t("after")}
              </MenuItem>
              <MenuItem icon="calendar" keyHint="t" onPress={run(today)}>
                {t("today")}
              </MenuItem>
              <MenuItem icon="day" keyHint="g d" onPress={() => onOpen("date")}>
                {t("goToDate")}
              </MenuItem>
            </>
          ) : null}
          <MenuItem icon="search" keyHint="/" onPress={run(search)}>
            {t("search")}
          </MenuItem>
          <MenuItem icon="invite" keyHint="g i" onPress={run(invitations)}>
            {t("invitations")}
          </MenuItem>
          <MenuItem icon="agenda" keyHint="g a" onPress={run(agenda)}>
            {t("agenda")}
          </MenuItem>
          {timed ? (
            <MenuItem
              icon="clock"
              note={ts("view.hourRange", {
                from: clockTime(settings.hours.from, locale),
                to: settings.hours.to === 1440 ? "24:00" : clockTime(settings.hours.to, locale),
              })}
              disabled={reading.said === null || reading.save === "none"}
              onPress={() => onOpen("hours")}
            >
              {ts("view.hours")}
            </MenuItem>
          ) : null}
          {check ? (
            <MenuItem icon="pull" keyHint="p" disabled={check.busy} onPress={run(check.run)}>
              {ts("accounts.checkNow")}
            </MenuItem>
          ) : null}
          <MenuItem icon="settings" keyHint="g ," onPress={run(openSettings)}>
            {t("settings")}
          </MenuItem>
        </>
      ) : null}
      {views.map(({ value, label, keyHint }) => (
        <MenuItem key={value} checked={value === place} keyHint={keyHint} onPress={run(() => select(value))}>
          {label}
        </MenuItem>
      ))}
    </Menu>
  );
}

function DateMenu({
  anchor,
  where,
  settings,
  toDate,
  goToView,
  onClose,
}: {
  anchor: ButtonRef;
  where: Where;
  settings: CalendarViewSettings;
  toDate: (day: string) => void;
  goToView: (view: ViewId, day: string) => void;
  onClose: () => void;
}) {
  const t = useText("calendar");
  const [date, setDate] = useState(where.anchor);
  const dateField = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const pick = (day: string) => {
    onClose();
    toDate(day);
  };
  const go = (view: ViewId, day: string) => {
    onClose();
    goToView(view, day);
  };
  const valid = dayOfIso(date) !== null;
  return (
    <Menu open label={t("goToDate")} kind="card" anchor={anchor} initialFocus={dateField} onClose={onClose}>
      <form
        className="cal-date-jump"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) pick(date);
        }}
      >
        <Field ref={dateField} label={t("date")} type="date" value={date} onChange={setDate} bare />
        <Button kind="ink" size="s" type="submit" disabled={!valid}>
          {t("go")}
        </Button>
      </form>
      <CalendarMiniMonth
        anchor={where.anchor}
        today={where.today}
        weekStart={settings.weekStart}
        weekNumbers={settings.weekNumbers}
        mode="picker"
        onPick={pick}
        onMonth={(day) => go("month", day)}
        onWeek={(day) => go("week", day)}
      />
    </Menu>
  );
}
