/**
 * SETTINGS › CALENDAR ACCOUNTS: one compact sheet an account, opened in place, read from the mirror on every version.
 * A control stands only where the setup's port has its door: no port, no Add, no Sign in again, no switch.
 */
import { useState } from "react";
import { Empty } from "@ohmail/ui/base";
import {
  AccountRow,
  ActionPanel,
  SettingLine,
  SettingNote,
  SettingsSheet,
  type PanelVerb,
} from "@ohmail/ui/mail";
import {
  accountsOf,
  newEventsCalendarOf,
  writableOf,
  type CalendarAccount,
  type CalendarSetupPort,
} from "@ohmail/app-logic/calendar/setup";
import { useCalendarCheck } from "../../calendar/check.js";
import { useFrame, useReport } from "../../frame/commands.js";
import { NONE } from "../../host/index.js";
import type { PaneBodyProps } from "../../settings/contract.js";
import { useText } from "../../text/index.js";
import { useCalendarMirror, useSetupPort } from "../../calsetup/index.js";
import { useCalendarSettings } from "../settings-read.js";
import { useWhen } from "../when.js";
import { AccountLines } from "./AccountLines.js";

/** The ways a new sign-in can be typed here; the others sign in by their own ceremony, which has no step yet. */
const TYPED = new Set(["icloud", "caldav"]);

/** Where the host hands in no setup port: every door shut, so the lines draw no control. */
export const NO_DOORS: CalendarSetupPort = {
  ways: async () => [],
  connect: "none",
  signInAgain: "none",
  remove: "none",
  check: "none",
  setCalendar: "none",
  saveSettings: "none",
};

export function AccountsPane({ sheet }: PaneBodyProps) {
  const t = useText("calsettings");
  const check = useCalendarCheck();
  const { commands, host } = useFrame();
  const report = useReport();
  const when = useWhen();
  const mirror = useCalendarMirror();
  const given = useSetupPort();
  const doors = given === NONE ? NO_DOORS : given;
  const settings = useCalendarSettings(mirror?.port ?? null, doors);
  const [savingEnabled, setSavingEnabled] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  if (mirror === null) {
    const unavailable = (
      <SettingsSheet>
        <SettingNote>{t("unread")}</SettingNote>
      </SettingsSheet>
    );
    return sheet ? sheet(unavailable) : unavailable;
  }
  const setup = (words: Readonly<Record<string, string>>) =>
    commands.go({ place: "week", stage: { id: "calSetup", words: { ...words, from: "settings" } } });
  const accounts = accountsOf(mirror.connections, mirror.calendars);
  const writable = writableOf(mirror.calendars, mirror.connections);
  const newEvents = newEventsCalendarOf(settings.said?.newEventsCalendarId ?? null, writable)?.id ?? null;
  const save = settings.save;
  const saveNewEvents =
    save === "none"
      ? "none"
      : (id: string) => void save({ newEventsCalendarId: id }).then((done) => done || report(t("notSaved")));
  const enabled = settings.said?.enabledAt !== null;
  const canSwitch = host.features.places.settings !== NONE && save !== NONE && settings.said !== null;
  const useCalendar = canSwitch
    ? calendarToggle(t("accounts.useCalendar"), enabled, savingEnabled, (on) => {
        if (savingEnabled) return;
        setSavingEnabled(true);
        void save({ enabled: on }).then((done) => {
          setSavingEnabled(false);
          if (!done) report(t("notSaved"));
        });
      })
    : null;
  const add =
    !enabled || doors.connect === "none"
      ? undefined
      : { label: t("accounts.add"), icon: "plus" as const, onPress: () => setup({ step: "way" }) };
  if (accounts.length === 0) {
    const empty = (
      <>
        {useCalendar}
        <Empty label={t("accounts.none")} act={add} />
      </>
    );
    return sheet ? sheet(empty) : empty;
  }

  const wayWord = (a: CalendarAccount) => {
    const host = a.way === "caldav" || a.way === "ics" ? a.connection.serverHost : null;
    return host ? `${t(`way.${a.way}`)} · ${host}` : t(`way.${a.way}`);
  };
  const offerOf = (a: CalendarAccount) =>
    a.state === "signedOut" && doors.connect !== "none" && doors.signInAgain !== "none" && TYPED.has(a.way)
      ? {
          label: t("accounts.signInAgain"),
          onPress: () => setup({ step: "signin", way: a.way, again: a.connection.id }),
        }
      : undefined;
  const toggle = (id: string) =>
    setOpened((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const checked = (a: CalendarAccount) => {
    const at = a.state === "inStep" ? when(a.connection.lastSyncedAt) : null;
    return at === null ? [] : [t("accounts.checkedAt", { when: at })];
  };

  const content = (
    <>
      {useCalendar}
      {accounts.map((a) => (
        <AccountRow
          key={a.connection.id}
          name={a.connection.label}
          address={a.connection.serverHost ?? a.connection.label}
          state={t(`accounts.state.${a.state}`)}
          facts={[wayWord(a), t("accounts.calendarCount", { count: a.calendars.length }), ...checked(a)]}
          offer={offerOf(a)}
          expanded={opened.has(a.connection.id)}
          onToggle={() => toggle(a.connection.id)}
        >
          <AccountLines
            account={a}
            port={doors}
            newEvents={newEvents}
            writable={writable}
            wayWord={wayWord(a)}
            saveNewEvents={saveNewEvents}
          />
        </AccountRow>
      ))}
    </>
  );
  const foot =
    add || (enabled && check) ? <AccountsToolbar add={add} check={enabled ? check : null} /> : null;
  return sheet ? (
    sheet(content, foot)
  ) : (
    <>
      {content}
      {foot}
    </>
  );
}

function AccountsToolbar({
  add,
  check,
}: {
  add: Pick<PanelVerb, "label" | "icon" | "onPress"> | undefined;
  check: ReturnType<typeof useCalendarCheck>;
}) {
  const t = useText("calsettings");
  const actions: PanelVerb[] = [];
  if (add) actions.push({ ...add, id: "add-account", kind: "ink", rank: 0 });
  if (check)
    actions.push({
      id: "check-accounts",
      label: t("accounts.checkNow"),
      icon: "pull",
      busy: check.busy,
      disabled: check.busy,
      onPress: check.run,
      rank: 0,
    });
  return actions.length ? <ActionPanel label={t("accounts.title")} items={actions} /> : null;
}

function calendarToggle(label: string, enabled: boolean, saving: boolean, onChange: (on: boolean) => void) {
  return (
    <SettingsSheet>
      <SettingLine label={label} off={saving} toggle={{ on: enabled, onChange }} />
    </SettingsSheet>
  );
}
