/**
 * SETTINGS › VIEW: the calendar settings our server keeps, each with its control where it can be saved here. Where
 * new events go, the week's numbers, the day's hours, a second time zone. The device's own zone is said as the one
 * zone source names it. What the account's settings do not carry yet is not drawn.
 */
import { useMemo } from "react";
import { clockTime, readerZones, type CalendarSettingsWire } from "@ohmail/app-logic/calendar";
import { newEventsCalendarOf, writableOf, type CalendarSettingsBody } from "@ohmail/app-logic/calendar/setup";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useReport } from "../../frame/commands.js";
import { NONE } from "../../host/index.js";
import type { PaneBodyProps } from "../../settings/contract.js";
import { useLocale, useText, useTimeZone } from "../../text/index.js";
import { useCalendarMirror, useSetupPort } from "../../calsetup/index.js";
import { useCalendarSettings } from "../settings-read.js";
import { Choice, type ChoiceItem } from "./Choice.js";

const DAY = 24 * 60;
/** The zones the platform names and this device can place a time in, read once. */
let known: readonly string[] | null = null;
function knownZones(): readonly string[] {
  if (known) return known;
  const zones = readerZones();
  const listed = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  known = listed.filter((z) => zones.offsetAt(z, Date.now()) !== null);
  return known;
}
const zoneName = (zone: string) => zone.replaceAll("_", " ");

export function ViewPane(_: PaneBodyProps) {
  const t = useText("calsettings");
  const locale = useLocale();
  const zone = useTimeZone();
  const report = useReport();
  const mirror = useCalendarMirror();
  const given = useSetupPort();
  const { said, save } = useCalendarSettings(mirror?.port ?? null, given === NONE ? "none" : given);
  const hours = useMemo(
    () =>
      Array.from({ length: 25 }, (_, h) => ({
        key: String(h * 60),
        label: h === 24 ? t("view.endOfDay") : clockTime(h * 60, locale),
      })),
    [locale, t],
  );
  if (mirror === null) {
    return (
      <SettingsSheet>
        <SettingNote>{t("unread")}</SettingNote>
      </SettingsSheet>
    );
  }
  const saving =
    save === "none"
      ? undefined
      : (body: CalendarSettingsBody) => void save(body).then((done) => done || report(t("notSaved")));
  const writable = writableOf(mirror.calendars, mirror.connections);
  const chosen = said ? newEventsCalendarOf(said.newEventsCalendarId, writable) : null;
  const from = said?.dayFromMinute ?? 0;
  const to = said?.dayToMinute ?? DAY;
  const hour = (m: number) =>
    hours.find((h) => h.key === String(m)) ?? { key: String(m), label: clockTime(m, locale) };
  const none: ChoiceItem = { key: "", label: t("view.noSecondZone") };
  const zones = [
    none,
    ...knownZones()
      .filter((z) => z !== zone)
      .map((z) => ({ key: z, label: zoneName(z) })),
  ];

  return (
    <>
      <SettingsSheet>
        {writable.length === 0 ? (
          <SettingLine label={t("view.newEvents")} value={t("view.noWritable")} />
        ) : (
          <Choice
            label={t("view.newEvents")}
            value={said ? { key: chosen?.id ?? "", label: chosen?.name ?? t("view.noWritable") } : null}
            items={writable.map((k) => ({ key: k.id, label: k.name }))}
            onPick={saving && ((id) => saving({ newEventsCalendarId: id }))}
          />
        )}
      </SettingsSheet>
      <SettingsSheet title={t("view.week")}>
        <WeekNumbers said={said} saving={saving} />
      </SettingsSheet>
      <SettingsSheet title={t("view.hours")}>
        <Choice
          label={t("view.from")}
          value={said ? hour(from) : null}
          items={hours.filter((h) => Number(h.key) < to)}
          onPick={saving && ((m) => saving(dayOf(Number(m), to)))}
        />
        <Choice
          label={t("view.to")}
          value={said ? hour(to) : null}
          items={hours.filter((h) => Number(h.key) > from)}
          onPick={saving && ((m) => saving(dayOf(from, Number(m))))}
        />
      </SettingsSheet>
      <SettingsSheet title={t("view.time")}>
        <SettingLine label={t("view.zone")} value={zoneName(zone)} />
        <SettingNote>{t("view.zoneNote")}</SettingNote>
        <Choice
          label={t("view.secondZone")}
          value={
            said
              ? said.secondZone
                ? { key: said.secondZone, label: zoneName(said.secondZone) }
                : none
              : null
          }
          items={zones}
          find={{ label: t("view.findZone"), most: 8 }}
          onPick={saving && ((z) => saving({ secondZone: z === "" ? null : z }))}
        />
      </SettingsSheet>
    </>
  );
}

/** The whole day is said as neither hour: our server keeps both or neither. */
function dayOf(from: number, to: number): CalendarSettingsBody {
  return from === 0 && to === DAY
    ? { dayFromMinute: null, dayToMinute: null }
    : { dayFromMinute: from, dayToMinute: to };
}

function WeekNumbers({
  said,
  saving,
}: {
  readonly said: CalendarSettingsWire | null;
  readonly saving: ((body: CalendarSettingsBody) => void) | undefined;
}) {
  const t = useText("calsettings");
  if (said === null) return <SettingLine label={t("view.weekNumbers")} />;
  if (saving === undefined)
    return <SettingLine label={t("view.weekNumbers")} value={t(said.weekNumbers ? "view.on" : "view.off")} />;
  return (
    <SettingLine
      label={t("view.weekNumbers")}
      toggle={{ on: said.weekNumbers, onChange: (on) => saving({ weekNumbers: on }) }}
    />
  );
}
