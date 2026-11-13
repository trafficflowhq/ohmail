/**
 * ONE ACCOUNT'S LINES, opened in place: its calendars, when it was last checked, and the acts the port has a door
 * for (Check now, Remove). A calendar's menu offers only what can be done here: its name here, where new events go.
 */
import { useRef, useState, type RefObject } from "react";
import { Button, Field, Menu, MenuItem } from "@ohmail/ui/base";
import { SettingLine, SettingNote } from "@ohmail/ui/mail";
import type { CalendarRecord } from "@ohmail/app-logic/calendar";
import {
  connectFaultKeyOf,
  type CalendarAccount,
  type CalendarSetupPort,
} from "@ohmail/app-logic/calendar/setup";
import { useReport } from "../../frame/commands.js";
import { useText } from "../../text/index.js";
import { CalendarLine } from "../../calsetup/index.js";
import { useWhen } from "../when.js";

export interface AccountLinesProps {
  readonly account: CalendarAccount;
  readonly port: CalendarSetupPort;
  /** Where new events go now, and the calendars they may go to. */
  readonly newEvents: string | null;
  readonly writable: readonly CalendarRecord[];
  /** How it is connected, as a person reads it: "iCloud", "CalDAV · dav.example.org". */
  readonly wayWord: string;
  /** Makes a calendar the one new events go to; `none` where settings cannot be saved here. */
  readonly saveNewEvents: ((calendarId: string) => void) | "none";
}

/** A calendar's menu and its rename, one open at a time. */
type Open = { readonly id: string; readonly as: "menu" | "rename" } | null;

export function AccountLines({
  account,
  port,
  newEvents,
  writable,
  wayWord,
  saveNewEvents,
}: AccountLinesProps) {
  const t = useText("calsettings");
  const faults = useText("calsetup");
  const report = useReport();
  const when = useWhen();
  const [open, setOpen] = useState<Open>(null);
  const [asking, setAsking] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const removeAnchor = useRef<HTMLButtonElement>(null);
  const { connection } = account;
  const { setCalendar, check, remove } = port;
  const said = (done: Promise<unknown>, failed: string) => done.catch(() => report(t(failed)));
  const opened = open === null ? null : (account.calendars.find((k) => k.id === open.id) ?? null);

  return (
    <>
      {account.fault ? <SettingNote warn>{faults(connectFaultKeyOf(account.fault))}</SettingNote> : null}
      <div role="group" aria-label={t("accounts.calendars")}>
        {account.calendars.map((k) => (
          <CalendarLine
            key={k.id}
            calendar={k}
            switchLabel={t("accounts.show", { name: k.name })}
            onToggle={
              setCalendar === "none"
                ? undefined
                : (shown) => void said(setCalendar(k.id, { shown }), "notSaved")
            }
            onMenu={
              setCalendar === "none"
                ? undefined
                : (event) => {
                    anchor.current = event.currentTarget;
                    setOpen({ id: k.id, as: "menu" });
                  }
            }
            menuOpen={open?.id === k.id && open.as === "menu"}
            defaultLabel={k.id === newEvents ? t("accounts.newEventsHere") : undefined}
            viewOnlyLabel={writable.includes(k) ? undefined : t("accounts.viewOnly")}
          />
        ))}
      </div>
      <SettingLine label={t("accounts.checked")} value={when(connection.lastSyncedAt) ?? t("accounts.never")}>
        {check === "none" ? null : (
          <Button kind="quiet" size="s" onPress={() => void said(check(connection.id), "notChecked")}>
            {t("accounts.checkNow")}
          </Button>
        )}
      </SettingLine>
      <SettingLine label={t("accounts.connectedWith")} value={wayWord}>
        {remove === "none" ? null : (
          <Button
            kind="quiet"
            size="s"
            ref={removeAnchor}
            opens="menu"
            expanded={asking}
            onPress={() => setAsking(true)}
          >
            {t("accounts.remove")}
          </Button>
        )}
      </SettingLine>
      {remove === "none" ? null : (
        <Menu
          open={asking}
          onClose={() => setAsking(false)}
          anchor={removeAnchor}
          kind="ask"
          label={t("accounts.removeAsk", { name: connection.label })}
          title={t("accounts.removeAsk", { name: connection.label })}
        >
          <MenuItem
            onPress={() => {
              setAsking(false);
              void said(remove(connection.id), "notRemoved");
            }}
          >
            {t("accounts.remove")}
          </MenuItem>
        </Menu>
      )}
      {opened && setCalendar !== "none" ? (
        <CalendarMenu
          calendar={opened}
          anchor={anchor}
          renaming={open?.as === "rename"}
          rename={() => setOpen({ id: opened.id, as: "rename" })}
          close={() => setOpen(null)}
          setName={(name) => void said(setCalendar(opened.id, { name }), "notSaved")}
          newEventsHere={
            saveNewEvents === "none" || !writable.includes(opened)
              ? null
              : { on: opened.id === newEvents, set: () => saveNewEvents(opened.id) }
          }
        />
      ) : null}
    </>
  );
}

interface CalendarMenuProps {
  readonly calendar: CalendarRecord;
  readonly anchor: RefObject<HTMLButtonElement | null>;
  readonly renaming: boolean;
  readonly rename: () => void;
  readonly close: () => void;
  readonly setName: (name: string) => void;
  /** Where new events go; null where it cannot be set here. */
  readonly newEventsHere: { readonly on: boolean; readonly set: () => void } | null;
}

/** A calendar's menu: its name here, where new events go; and its rename as a card in the same place. */
function CalendarMenu({
  calendar,
  anchor,
  renaming,
  rename,
  close,
  setName,
  newEventsHere,
}: CalendarMenuProps) {
  const t = useText("calsettings");
  const [name, setTyped] = useState(calendar.name);
  return (
    <Menu
      open
      onClose={close}
      anchor={anchor}
      label={calendar.name}
      title={calendar.name}
      kind={renaming ? "card" : undefined}
    >
      {renaming ? (
        <>
          <Field label={t("accounts.nameHere")} value={name} onChange={setTyped} row />
          <Button
            kind="ink"
            size="s"
            onPress={() => {
              const typed = name.trim();
              close();
              if (typed !== "" && typed !== calendar.name) setName(typed);
            }}
          >
            {t("accounts.save")}
          </Button>
        </>
      ) : (
        <>
          <MenuItem onPress={rename}>{t("accounts.rename")}</MenuItem>
          {newEventsHere === null ? null : (
            <MenuItem
              checked={newEventsHere.on}
              onPress={() => {
                close();
                newEventsHere.set();
              }}
            >
              {t("accounts.newEventsHere")}
            </MenuItem>
          )}
        </>
      )}
    </Menu>
  );
}
