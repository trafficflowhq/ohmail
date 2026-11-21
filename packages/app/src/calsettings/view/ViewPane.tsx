/**
 * SETTINGS › VIEW: the calendar settings our server keeps, each with its control where it can be saved here. Where
 * new events go, the week's numbers, the day's hours, a second time zone. The device's own zone is said as the one
 * zone source names it. What the account's settings do not carry yet is not drawn.
 */
import { clockTime, readerZones, type CalendarSettingsWire } from "@ohmail/app-logic/calendar";
import { newEventsCalendarOf, writableOf, type CalendarSettingsBody } from "@ohmail/app-logic/calendar/setup";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useReport } from "../../frame/commands.js";
import { NONE } from "../../host/index.js";
import type { PaneBodyProps, PaneSummary } from "../../settings/contract.js";
import { useLocale, useText, useTimeZone } from "../../text/index.js";
import { useCalendarMirror, useSetupPort } from "../../calsetup/index.js";
import { hoursInView } from "../hours.js";
import { useCalendarSettings } from "../settings-read.js";
import { Choice, type ChoiceItem } from "./Choice.js";
import { Hours } from "./Hours.js";

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

export function useViewSummary(): PaneSummary | null {
  const t = useText("calsettings");
  const locale = useLocale();
  const mirror = useCalendarMirror();
  const { said } = useCalendarSettings(null, "none");
  if (said === null || mirror === null) return null;
  const calendar = newEventsCalendarOf(
    said.newEventsCalendarId,
    writableOf(mirror.calendars, mirror.connections),
  );
  const { from, to } = hoursInView(said);
  const hours = t("view.hourRange", {
    from: clockTime(from, locale),
    to: to === 1440 ? "24:00" : clockTime(to, locale),
  });
  return {
    value: t("view.summary"),
    detail: calendar ? t("view.scheduleSummary", { hours, calendar: calendar.name }) : hours,
  };
}

export function ViewPane(_: PaneBodyProps) {
  const t = useText("calsettings");
  const zone = useTimeZone();
  const report = useReport();
  const mirror = useCalendarMirror();
  const given = useSetupPort();
  const { said, save } = useCalendarSettings(mirror?.port ?? null, given === NONE ? "none" : given);
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
        <Hours said={said} save={save} />
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
