/**
 * SETTINGS › VIEW: the calendar settings our server keeps, each with its control where it can be saved here. Where
 * new events go, the week's numbers, the day's hours, a second time zone. The device's own zone is said as the one
 * zone source names it. What the account's settings do not carry yet is not drawn.
 */
import { clockTime, type CalendarSettingsWire } from "@ohmail/app-logic/calendar";
import { newEventsCalendarOf, writableOf, type CalendarSettingsBody } from "@ohmail/app-logic/calendar/setup";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useReport } from "../../frame/commands.js";
import { NONE } from "../../host/index.js";
import type { PaneBodyProps, PaneSummary } from "../../settings/contract.js";
import { useLocale, useText, useTimeZone } from "../../text/index.js";
import { useCalendarMirror, useSetupPort } from "../../calsetup/index.js";
import { CALENDAR_OPEN_VIEWS, useCalendarDevice, type CalendarDeviceSettings } from "../device.js";
import { hoursInView } from "../hours.js";
import { useCalendarSettings } from "../settings-read.js";
import { Choice, type ChoiceItem } from "./Choice.js";
import { Hours } from "./Hours.js";

import { knownZones, zoneName } from "../../calendar/zone-names.js";

export function useViewSummary(): PaneSummary | null {
  const t = useText("calsettings");
  const locale = useLocale();
  const mirror = useCalendarMirror();
  const { said } = useCalendarSettings(null, "none");
  const device = useCalendarDevice();
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
    value: device
      ? t("view.deviceSummary", {
          view: t(`view.opens.${device.settings.opensIn}`),
          day: t(`view.starts.${device.settings.weekStart}`),
        })
      : t("view.summary"),
    detail: calendar ? t("view.scheduleSummary", { hours, calendar: calendar.name }) : hours,
  };
}

export function ViewPane(_: PaneBodyProps) {
  const t = useText("calsettings");
  const zone = useTimeZone();
  const report = useReport();
  const mirror = useCalendarMirror();
  const given = useSetupPort();
  const device = useCalendarDevice();
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
        {device ? <OpensIn device={device} /> : null}
      </SettingsSheet>
      <SettingsSheet title={t("view.week")}>
        {device ? <WeekChoice device={device} /> : null}
        <WeekNumbers said={said} saving={saving} />
        {device ? <DeviceToggle which="showDeclined" device={device} /> : null}
      </SettingsSheet>
      <SettingsSheet title={t("view.hours")}>
        <Hours said={said} save={save} />
      </SettingsSheet>
      <SettingsSheet title={t("view.time")}>
        {device ? (
          <PrimaryZone device={device} />
        ) : (
          <SettingLine label={t("view.zone")} value={t("view.followsDevice")} />
        )}
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

type Device = NonNullable<ReturnType<typeof useCalendarDevice>>;

function OpensIn({ device }: { device: Device }) {
  const t = useText("calsettings");
  const items = CALENDAR_OPEN_VIEWS.map((key) => ({ key, label: t(`view.opens.${key}`) }));
  return (
    <Choice
      label={t("view.opensIn")}
      items={items}
      value={items.find((item) => item.key === device.settings.opensIn) ?? null}
      onPick={(key) => device.change({ opensIn: key as CalendarDeviceSettings["opensIn"] })}
    />
  );
}

function WeekChoice({ device }: { device: Device }) {
  const t = useText("calsettings");
  const days = [0, 6, 5] as const;
  const items = days.map((key) => ({ key: String(key), label: t(`view.starts.${key}`) }));
  return (
    <>
      <Choice
        label={t("view.startsOn")}
        items={items}
        value={items.find((item) => item.key === String(device.settings.weekStart)) ?? null}
        onPick={(key) => device.change({ weekStart: Number(key) as CalendarDeviceSettings["weekStart"] })}
      />
      <DeviceToggle which="weekends" device={device} />
    </>
  );
}

function DeviceToggle({ which, device }: { which: "weekends" | "showDeclined"; device: Device }) {
  const t = useText("calsettings");
  return (
    <SettingLine
      label={t(`view.${which}`)}
      toggle={{
        on: device.settings[which],
        onChange: (on) => device.change({ [which]: on }),
      }}
    />
  );
}

function PrimaryZone({ device }: { device: Device }) {
  const t = useText("calsettings");
  const auto = { key: "", label: t("view.followsDevice") };
  const value = device.settings.zone
    ? { key: device.settings.zone, label: zoneName(device.settings.zone) }
    : auto;
  return (
    <Choice
      label={t("view.zone")}
      value={value}
      items={[auto, ...knownZones().map((key) => ({ key, label: zoneName(key) }))]}
      find={{ label: t("view.findZone"), most: 8 }}
      onPick={(key) => device.change({ zone: key || null })}
    />
  );
}
