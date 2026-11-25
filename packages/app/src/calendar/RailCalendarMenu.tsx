import { useState, type RefObject } from "react";
import { Menu, MenuItem, MenuRule, type Point } from "@ohmail/ui/base";
import { CalendarSquare } from "@ohmail/ui/calendar";
import { hueOf, type CalendarRecord } from "@ohmail/app-logic/calendar";
import type { CalendarChange, CalendarSetupPort } from "@ohmail/app-logic/calendar/setup";
import { useFrame, useReport } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import { CalendarMenu, RemoveCalendarAccountQuestion } from "../calsettings/accounts/AccountLines.js";

const CALENDAR_COLOURS = [
  ["rose", "#b8452e"],
  ["amber", "#b8b82e"],
  ["lime", "#50b82e"],
  ["green", "#2eb873"],
  ["teal", "#2e95b8"],
  ["blue", "#2e2eb8"],
  ["violet", "#952eb8"],
  ["plum", "#b82e73"],
  ["grey", "#737373"],
] as const;

type Props = {
  calendar: CalendarRecord;
  anchor: RefObject<HTMLButtonElement | null>;
  at?: Point | Element;
  close: () => void;
  shownCalendars: readonly CalendarRecord[];
  setCalendar?: Exclude<CalendarSetupPort["setCalendar"], typeof NONE>;
  check: CalendarSetupPort["check"];
  remove?: Exclude<CalendarSetupPort["remove"], typeof NONE>;
  subscription: boolean;
  newEventsHere: { on: boolean; set: () => void } | null;
};

export function RailCalendarMenu({
  calendar,
  anchor: menuAnchor,
  at,
  close: closeMenu,
  shownCalendars,
  setCalendar,
  check,
  remove,
  subscription,
  newEventsHere,
}: Props) {
  const { commands } = useFrame();
  const ts = useText("calsettings");
  const report = useReport();
  const [renaming, setRenaming] = useState(false);
  const [unsubscribe, setUnsubscribe] = useState(false);
  const [colours, setColours] = useState(false);
  const saveCalendar = (id: string, change: CalendarChange) =>
    void setCalendar?.(id, change).catch(() => report(ts("notSaved")));
  const run = (act: () => void) => () => {
    closeMenu();
    act();
  };
  if (unsubscribe && remove)
    return (
      <RemoveCalendarAccountQuestion
        open
        anchor={menuAnchor}
        question={ts("accounts.unsubscribeAsk", { name: calendar.name })}
        label={ts("accounts.unsubscribe")}
        onClose={closeMenu}
        onConfirm={() => void remove(calendar.connectionId).catch(() => report(ts("notRemoved")))}
      />
    );
  if (colours && setCalendar)
    return (
      <Menu
        open
        anchor={at ?? menuAnchor}
        returnFocus={menuAnchor}
        label={ts("accounts.colour")}
        fit="whole"
        onClose={closeMenu}
      >
        {CALENDAR_COLOURS.map(([name, color]) => (
          <MenuItem
            key={name}
            leading={<CalendarSquare tone={hueOf(color)} />}
            checkmark
            checked={calendar.color === color}
            onPress={run(() => saveCalendar(calendar.id, { color }))}
          >
            {ts(`accounts.palette.${name}`)}
          </MenuItem>
        ))}
        <MenuItem icon="pull" onPress={run(() => saveCalendar(calendar.id, { color: null }))}>
          {ts("accounts.providerColour")}
        </MenuItem>
      </Menu>
    );
  return (
    <CalendarMenu
      calendar={calendar}
      anchor={menuAnchor}
      at={at}
      close={closeMenu}
      renaming={renaming}
      rename={subscription ? () => setRenaming(true) : undefined}
      setName={(name) => saveCalendar(calendar.id, { name })}
      newEventsHere={newEventsHere && { ...newEventsHere, label: ts("accounts.useForNewEvents") }}
    >
      {setCalendar && (
        <>
          <MenuItem
            icon={calendar.shown ? "x" : "calendar"}
            onPress={run(() => saveCalendar(calendar.id, { shown: !calendar.shown }))}
          >
            {ts(calendar.shown ? "accounts.hideCalendar" : "accounts.showCalendar")}
          </MenuItem>
          <MenuItem
            icon="pick"
            onPress={run(() => {
              const changes = shownCalendars.filter((item) => item.shown !== (item.id === calendar.id));
              void Promise.all(
                changes.map((item) => setCalendar(item.id, { shown: item.id === calendar.id })),
              ).catch(() => report(ts("notSaved")));
            })}
          >
            {ts("accounts.showOnlyCalendar")}
          </MenuItem>
          <MenuItem icon="tags" onPress={() => setColours(true)}>
            {ts("accounts.colour")}
          </MenuItem>
        </>
      )}
      {check !== NONE && (
        <MenuItem
          icon="pull"
          onPress={run(
            () => void check(calendar.connectionId, calendar.id).catch(() => report(ts("notChecked"))),
          )}
        >
          {ts("accounts.checkNow")}
        </MenuItem>
      )}
      <MenuItem icon="settings" onPress={run(() => commands.go({ place: "calsettings" }))}>
        {ts("accounts.calendarSettings")}
      </MenuItem>
      {subscription && remove && (
        <>
          <MenuRule />
          <MenuItem icon="trash" onPress={() => setUnsubscribe(true)}>
            {ts("accounts.unsubscribe")}
          </MenuItem>
        </>
      )}
    </CalendarMenu>
  );
}
