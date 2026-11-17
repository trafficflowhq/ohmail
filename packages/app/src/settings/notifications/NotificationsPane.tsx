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
 * while nothing can be drawn, and a refusing platform leaves it unpressable. The events' switches stand only while
 * the master is live, and only for the events something delivers.
 */
export function NotificationsPane({ model }: NotificationsPaneProps) {
  const t = useText("settings");
  const n = useText(NOTIFICATIONS_NAMESPACE);
  const { channels, permission, live, deliverable, osHolds, delivery } = model;
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
      {live ? (
        <>
          <SettingsSheet title={n("about")}>
            {NOTIFY_ROWS.filter((row) => deliverable.includes(row.key)).map((row) => (
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
          <SettingsSheet>
            <SettingLine
              label={t("notifyIdentify")}
              toggle={{
                on: channels.showSenderAndSubject,
                onChange: (on) => model.set({ ...channels, showSenderAndSubject: on }),
              }}
            />
            <SettingNote>{t("notifyIdentifyWhy")}</SettingNote>
          </SettingsSheet>
        </>
      ) : null}
      <SettingsSheet>
        <SettingNote>{t("notifyReach")}</SettingNote>
        <SettingNote>{t("notificationPrivacy")}</SettingNote>
        <SettingNote>{t("badgeRule")}</SettingNote>
      </SettingsSheet>
    </>
  );
}
