import { useRef, useState } from "react";
import { clockTime } from "@ohmail/app-logic/calendar";
import type { CalendarNoticeChoices } from "@ohmail/client-engine";
import type { CalendarChoiceSetter } from "@ohmail/app-logic/notices/browser-channels";
import { Menu, MenuItem, Slot } from "@ohmail/ui/base";
import { useLocale } from "../../text/index.js";
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
    readonly choices: CalendarNoticeChoices;
    readonly set: CalendarChoiceSetter;
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
  const showCalendar = live && calendar && (calendarRows.length > 0 || carries.includes("cal_summary"));
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
        <SettingNote>{n("badgeRule")}</SettingNote>
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
      {live && model.showsMailDetails && carries.includes("ohbox") ? (
        <SettingsSheet>
          <SettingLine
            label={n("showMailDetails")}
            toggle={{
              on: channels.showMailDetails === true,
              onChange: (on) => model.set({ ...channels, showMailDetails: on }),
            }}
          />
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
            {carries.includes("cal_summary") ? (
              <SummaryLine choices={calendar.choices} set={calendar.set} />
            ) : null}
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

const SUMMARY_TIMES = [360, 420, 480, 540];

function SummaryLine({ choices, set }: { choices: CalendarNoticeChoices; set: CalendarChoiceSetter }) {
  const t = useText("settingsNotifications");
  const locale = useLocale();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <SettingLine
      label={t("dailySummary")}
      toggle={{
        on: choices.cal_summary,
        onChange: (on) => {
          setOpen(false);
          set("cal_summary", on);
        },
      }}
    >
      {choices.cal_summary ? (
        <>
          <Slot ref={anchor} label={t("summaryTime")} expanded={open} onPress={() => setOpen(true)}>
            {clockTime(choices.summaryAt, locale)}
          </Slot>
          <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} label={t("summaryTime")}>
            {SUMMARY_TIMES.map((minute) => (
              <MenuItem
                key={minute}
                checked={choices.summaryAt === minute}
                onPress={() => {
                  setOpen(false);
                  set("summaryAt", minute);
                }}
              >
                {clockTime(minute, locale)}
              </MenuItem>
            ))}
          </Menu>
        </>
      ) : null}
    </SettingLine>
  );
}
