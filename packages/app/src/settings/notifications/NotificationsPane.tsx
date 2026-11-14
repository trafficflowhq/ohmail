import { Fragment } from "react";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import { DELIVERY_SENTENCE, NOTIFY_ROWS, type NotificationsModel } from "./model.js";
import { NOTIFICATIONS_NAMESPACE } from "./namespace.js";

export interface NotificationsPaneProps {
  readonly model: NotificationsModel;
}

/**
 * Notifications on this device. The master says the stored choice AND the platform's answer: no switch claims on
 * while nothing can be drawn, and a refusing platform leaves it unpressable. A kind's switch stands only while the
 * master is live, and only for a kind this surface's emitter draws: a switch that could change nothing is none.
 */
export function NotificationsPane({ model }: NotificationsPaneProps) {
  const t = useText("settings");
  const n = useText(NOTIFICATIONS_NAMESPACE);
  const { channels, permission, live, carries, osHolds, delivery } = model;
  const rows = NOTIFY_ROWS.filter((row) => carries.includes(row.key));
  const blocked = permission === "denied";
  return (
    <>
      <SettingsSheet wants={blocked ? { word: n("blocked"), line: t("notifyDenied") } : undefined}>
        <SettingLine
          label={t("notifyMaster")}
          off={blocked || permission === "unsupported"}
          toggle={{
            on: channels.master && permission === "granted",
            onChange: (want) => model.pressMaster(want),
          }}
        />
        <SettingNote>{t("notifyMasterWhy")}</SettingNote>
        {permission === "unsupported" ? <SettingNote>{t("notifyUnsupported")}</SettingNote> : null}
        {permission === "default" && !osHolds ? <SettingNote>{t("notifyAskFirst")}</SettingNote> : null}
        {osHolds ? <SettingNote>{t("notifyOsHeld")}</SettingNote> : null}
        {delivery ? <SettingNote warn>{t(DELIVERY_SENTENCE[delivery])}</SettingNote> : null}
      </SettingsSheet>
      {live && rows.length > 0 ? (
        <SettingsSheet title={n("about")}>
          {rows.map((row) => (
            <Fragment key={row.key}>
              <SettingLine
                label={t(row.label)}
                toggle={{
                  on: channels[row.key],
                  onChange: (on) => model.set({ ...channels, [row.key]: on }),
                }}
              />
              <SettingNote>{t(row.why)}</SettingNote>
            </Fragment>
          ))}
        </SettingsSheet>
      ) : null}
      <SettingsSheet>
        <SettingNote>{t("notifyReach")}</SettingNote>
        <SettingNote>{t("notificationPrivacy")}</SettingNote>
        <SettingNote>{t("badgeRule")}</SettingNote>
      </SettingsSheet>
    </>
  );
}
