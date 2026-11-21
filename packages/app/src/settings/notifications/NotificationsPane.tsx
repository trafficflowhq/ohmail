import type { CalendarNoticeKind, NoticeChoices } from "@ohmail/client-engine";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import { DELIVERY_SENTENCE, NOTIFY_ROWS, type NotificationsModel } from "./model.js";

const CALENDAR_ROWS = [
  ["cal_alert", "alert"],
  ["cal_invitation", "invitation"],
  ["cal_change", "change"],
  ["cal_answer", "answer"],
  ["cal_found", "found"],
] as const;

export interface NotificationsPaneProps {
  readonly model: NotificationsModel;
  readonly calendar?: {
    readonly choices: NoticeChoices;
    set(key: CalendarNoticeKind | "showTitles", value: boolean): void;
  };
}

/**
 * Notifications on this device. The master says the stored choice AND the platform's answer: no switch claims on
 * while nothing can be drawn, and a refusing platform leaves it unpressable. A kind's switch stands only while the
 * master is live, and only for a kind this surface's emitter draws: a switch that could change nothing is none.
 */
export function NotificationsPane({ model, calendar }: NotificationsPaneProps) {
  const t = useText("settings");
  const n = useText("settingsNotifications");
  const { channels, permission, live, carries, osHolds, delivery } = model;
  const rows = NOTIFY_ROWS.filter((row) => carries.includes(row.key));
  const calendarRows = CALENDAR_ROWS.filter(([kind]) => carries.includes(kind));
  const blocked = permission === "denied";
  const showCalendar = live && calendar && calendarRows.length > 0;
  const unsupported = permission === "unsupported";
  const deliveryWord =
    delivery === "no_server_key"
      ? n("onlyWhileOpen")
      : delivery === "not_registered"
        ? n("notRegistered")
        : undefined;
  const wants = blocked
    ? { word: n("blocked"), line: t("notifyDenied") }
    : unsupported
      ? { word: n("noCentre"), line: t("notifyUnsupported") }
      : delivery && deliveryWord
        ? { word: deliveryWord, line: t(DELIVERY_SENTENCE[delivery]) }
        : undefined;
  return (
    <>
      <SettingsSheet wants={wants}>
        <SettingLine
          label={t("notifyMaster")}
          tag={n("thisDevice")}
          off={blocked || permission === "unsupported"}
          toggle={{
            on: channels.master && permission === "granted",
            onChange: (want) => model.pressMaster(want),
          }}
        />
        {permission === "default" && !osHolds ? <SettingNote>{t("notifyAskFirst")}</SettingNote> : null}
        {osHolds ? <SettingNote>{t("notifyOsHeld")}</SettingNote> : null}
        {delivery && (delivery === "row_remains" || (delivery === "unsupported" && !unsupported)) ? (
          <SettingNote warn>{t(DELIVERY_SENTENCE[delivery])}</SettingNote>
        ) : null}
      </SettingsSheet>
      {live && rows.length > 0 ? (
        <SettingsSheet title={n(showCalendar ? "mail" : "about")}>
          {rows.map((row) => (
            <SettingLine
              key={row.key}
              label={t(row.label)}
              toggle={{
                on: channels[row.key],
                onChange: (on) => model.set({ ...channels, [row.key]: on }),
              }}
            />
          ))}
        </SettingsSheet>
      ) : null}
      {showCalendar && (
        <>
          <SettingsSheet title={n("calendar")}>
            {calendarRows.map(([kind, label]) => (
              <SettingLine
                key={kind}
                label={n(label)}
                toggle={{ on: calendar.choices[kind], onChange: (on) => calendar.set(kind, on) }}
              />
            ))}
          </SettingsSheet>
          <SettingsSheet title={n("titles")}>
            <SettingLine
              label={n("showTitles")}
              toggle={{ on: calendar.choices.showTitles, onChange: (on) => calendar.set("showTitles", on) }}
            />
          </SettingsSheet>
        </>
      )}
    </>
  );
}
