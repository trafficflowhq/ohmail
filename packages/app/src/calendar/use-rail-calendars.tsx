import { useRef, useState, type RefObject } from "react";
import { Button, Menu, MenuItem, type Point } from "@ohmail/ui/base";
import type { CalendarRailProps } from "@ohmail/ui/calendar";
import { viewOnlyOf } from "@ohmail/app-logic/calendar";
import {
  accountsOf,
  newEventsCalendarOf,
  writableOf,
  type CalendarChange,
} from "@ohmail/app-logic/calendar/setup";
import { useReport } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import { useCalendarMirror, useSetupPort } from "../calsetup/index.js";
import { useCalendarSettings } from "../calsettings/settings-read.js";
import { RemoveCalendarAccountQuestion } from "../calsettings/accounts/AccountLines.js";
import { useCalendarCheck } from "./check.js";
import { RailCalendarMenu } from "./RailCalendarMenu.js";

type RailCalendar = CalendarRailProps["calendars"]["accounts"][number]["calendars"][number];

export function useRailCalendars() {
  const ts = useText("calsettings");
  const report = useReport();
  const mirror = useCalendarMirror();
  const setup = useSetupPort();
  const { said, save } = useCalendarSettings(mirror?.port ?? null, setup);
  const [expanded, setExpanded] = useState(false);
  const [opened, setOpened] = useState<{ id: string; at?: Point | Element } | null>(null);
  const menuAnchor = useRef<HTMLButtonElement | null>(null);
  const accountAnchor = useRef<HTMLButtonElement | null>(null);
  const [disconnect, setDisconnect] = useState<{ id: string; name: string; confirm: boolean } | null>(null);
  const accounts = accountsOf(mirror?.connections ?? [], mirror?.calendars ?? []);
  const writable = writableOf(mirror?.calendars ?? [], mirror?.connections ?? []);
  const preferred = newEventsCalendarOf(said?.newEventsCalendarId ?? null, writable);
  const setCalendar = setup === NONE || setup.setCalendar === NONE ? undefined : setup.setCalendar;
  const check = useCalendarCheck();
  const calendar = mirror?.calendars.find((item) => item.id === opened?.id);
  const remove = setup === NONE || setup.remove === NONE ? undefined : setup.remove;
  const openMenu = (id: string, opener: HTMLButtonElement, at?: Point | Element) => {
    setDisconnect(null);
    menuAnchor.current = opener;
    setOpened({ id, at });
  };
  const closeMenu = () => setOpened(null);
  const saveCalendar = (id: string, change: CalendarChange) =>
    void setCalendar?.(id, change).catch(() => report(ts("notSaved")));
  const rows = accounts.map(({ connection, way, calendars }) => ({
    id: connection.id,
    name: ts(`way.${way}`),
    action:
      remove && connection.provider !== "ics" ? (
        <Button
          kind="quiet"
          size="s"
          icon="more"
          label={ts(`way.${way}`)}
          opens="menu"
          expanded={disconnect?.id === connection.id}
          onPress={(event) => {
            closeMenu();
            accountAnchor.current = event.currentTarget;
            setDisconnect({ id: connection.id, name: ts(`way.${way}`), confirm: false });
          }}
        />
      ) : undefined,
    calendars: calendars.map((item): RailCalendar => ({
      id: item.id,
      name: item.name,
      shown: item.shown,
      tone: mirror?.tones.get(item.id) ?? "neutral",
      switchLabel: ts("accounts.show", { name: item.name }),
      onToggle: setCalendar && ((shown) => saveCalendar(item.id, { shown })),
      viewOnlyLabel: viewOnlyOf(item, connection) ? ts("accounts.viewOnly") : undefined,
      menuOpen: opened?.id === item.id,
      onMenu: (e) => openMenu(item.id, e.currentTarget),
      onContext: (position, opener) => openMenu(item.id, opener, position),
    })),
  }));
  const all = mirror?.calendars.length ?? 0;
  const shown = mirror?.calendars.filter((item) => item.shown).length ?? 0;
  const menu =
    calendar && opened ? (
      <RailCalendarMenu
        key={calendar.id}
        calendar={calendar}
        anchor={menuAnchor}
        at={opened.at}
        close={closeMenu}
        shownCalendars={mirror?.calendars ?? []}
        setCalendar={setCalendar}
        check={setup === NONE ? NONE : setup.check}
        remove={remove}
        subscription={
          mirror?.connections.some((item) => item.id === calendar.connectionId && item.provider === "ics") ??
          false
        }
        newEventsHere={
          save !== NONE && writable.includes(calendar)
            ? {
                on: calendar.id === preferred?.id,
                set: () =>
                  void save({ newEventsCalendarId: calendar.id }).then(
                    (done) => done || report(ts("notSaved")),
                  ),
              }
            : null
        }
      />
    ) : null;
  const accountMenu = disconnect && remove && (
    <CalendarAccountMenu
      anchor={accountAnchor}
      name={disconnect.name}
      confirming={disconnect.confirm}
      ask={() => setDisconnect({ ...disconnect, confirm: true })}
      close={() => setDisconnect(null)}
      remove={() => void remove(disconnect.id).catch(() => report(ts("notRemoved")))}
    />
  );
  return {
    said,
    expanded,
    setExpanded,
    rows,
    shown,
    all,
    check,
    menu: (
      <>
        {menu}
        {accountMenu}
      </>
    ),
  };
}

function CalendarAccountMenu({
  anchor,
  name,
  confirming,
  ask,
  close,
  remove,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  name: string;
  confirming: boolean;
  ask: () => void;
  close: () => void;
  remove: () => void;
}) {
  const t = useText("calsettings");
  return confirming ? (
    <RemoveCalendarAccountQuestion
      open
      anchor={anchor}
      question={t("accounts.disconnectAsk", { name })}
      label={t("accounts.disconnect")}
      onClose={close}
      onConfirm={remove}
    />
  ) : (
    <Menu open anchor={anchor} label={name} fit="whole" onClose={close}>
      <MenuItem icon="x" onPress={ask}>
        {t("accounts.disconnect")}
      </MenuItem>
    </Menu>
  );
}
