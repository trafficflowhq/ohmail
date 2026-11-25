/**
 * ONE ACCOUNT'S LINES, opened in place: its calendars, when it was last checked, and the acts the port has a door
 * for (Check now, Remove). A calendar's menu offers only what can be done here: its name here, where new events go.
 */
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Button, Field, Menu, MenuItem, type Point } from "@ohmail/ui/base";
import { SettingLine, SettingNote } from "@ohmail/ui/mail";
import type { CalendarRecord } from "@ohmail/app-logic/calendar";
import {
  connectFaultKeyOf,
  type CalendarAccount,
  type CalendarSetupPort,
} from "@ohmail/app-logic/calendar/setup";
import { useReport } from "../../frame/commands.js";
import { useText } from "../../text/index.js";
import type { CalendarTones } from "../../calendar/tones.js";
import { calendarCheckDeadline } from "../../calendar/connection-notice.js";
import { CalendarLine } from "../../calsetup/index.js";
import { useWhen } from "../when.js";

export interface AccountLinesProps {
  readonly account: CalendarAccount;
  readonly tones: CalendarTones;
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

function AccountCheck({ check }: { check: () => Promise<unknown> }) {
  const t = useText("calsettings");
  const [state, setState] = useState<"checking" | "current" | "failed">();
  return (
    <Button
      kind="quiet"
      size="s"
      disabled={state === "checking"}
      onPress={() => {
        setState("checking");
        void check().then(
          () => setState("current"),
          () => setState("failed"),
        );
      }}
    >
      {t(state ? `accounts.checkState.${state}` : "accounts.checkNow")}
    </Button>
  );
}

export function AccountLines({
  account,
  tones,
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
  const overdue = calendarCheckDeadline(connection) <= Date.now();
  const { setCalendar, check, remove } = port;
  const said = (done: Promise<unknown>, failed: string) => done.catch(() => report(t(failed)));
  const opened = open === null ? null : (account.calendars.find((k) => k.id === open.id) ?? null);

  return (
    <>
      {account.fault ? (
        <>
          <SettingNote warn>{faults(connectFaultKeyOf(account.fault))}</SettingNote>
          <SettingLine label={t("accounts.errorSince")} value={when(connection.updatedAt) ?? undefined} />
        </>
      ) : null}
      {overdue ? (
        <>
          <SettingNote warn>{t("accounts.overdueDetail")}</SettingNote>
          <SettingLine
            label={t("accounts.scheduledCheck")}
            value={when(connection.nextPollAt ?? null) ?? undefined}
          />
        </>
      ) : null}
      <div role="group" aria-label={t("accounts.calendars")}>
        {account.calendars.map((k) => (
          <CalendarLine
            key={k.id}
            calendar={k}
            tone={tones.get(k.id) ?? "neutral"}
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
        {check === "none" ? null : <AccountCheck check={() => check(connection.id)} />}
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
        <RemoveCalendarAccountQuestion
          open={asking}
          anchor={removeAnchor}
          question={t("accounts.removeAsk", { name: connection.label })}
          label={t("accounts.remove")}
          onClose={() => setAsking(false)}
          onConfirm={() => void said(remove(connection.id), "notRemoved")}
        />
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

export function RemoveCalendarAccountQuestion({
  open,
  anchor,
  question,
  label,
  onClose,
  onConfirm,
}: {
  open: boolean;
  anchor: RefObject<HTMLButtonElement | null>;
  question: string;
  label: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Menu open={open} onClose={onClose} anchor={anchor} kind="ask" label={question} title={question}>
      <MenuItem
        onPress={() => {
          onClose();
          onConfirm();
        }}
      >
        {label}
      </MenuItem>
    </Menu>
  );
}

interface CalendarMenuProps {
  readonly calendar: CalendarRecord;
  readonly anchor: RefObject<HTMLButtonElement | null>;
  readonly at?: Point | Element;
  readonly children?: ReactNode;
  readonly renaming: boolean;
  readonly rename?: () => void;
  readonly close: () => void;
  readonly setName: (name: string) => void;
  /** Where new events go; null where it cannot be set here. */
  readonly newEventsHere: { readonly on: boolean; readonly label?: string; readonly set: () => void } | null;
}

/** A calendar's menu: its name here, where new events go; and its rename as a card in the same place. */
export function CalendarMenu({
  calendar,
  anchor,
  at,
  children,
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
      anchor={at ?? anchor}
      returnFocus={anchor.current ?? undefined}
      label={calendar.name}
      title={calendar.name}
      fit="whole"
      kind={renaming ? "card" : at ? "context" : undefined}
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
          {children}
          {rename ? (
            <MenuItem icon="write" onPress={rename}>
              {t("accounts.rename")}
            </MenuItem>
          ) : null}
          {newEventsHere === null ? null : (
            <MenuItem
              icon="plus"
              checkmark
              checked={newEventsHere.on}
              onPress={() => {
                close();
                newEventsHere.set();
              }}
            >
              {newEventsHere.label ?? t("accounts.newEventsHere")}
            </MenuItem>
          )}
        </>
      )}
    </Menu>
  );
}
