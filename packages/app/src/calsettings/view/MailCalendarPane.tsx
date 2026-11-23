import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@ohmail/ui/base";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { NONE } from "../../host/index.js";
import { useCalendarDevice } from "../device.js";
import { useFrame } from "../../frame/commands.js";
import { useFound } from "../../frommail/index.js";
import type { PaneSummary } from "../../settings/contract.js";
import { useLocale, useText } from "../../text/index.js";

export function useMailCalendarSummary(): PaneSummary | null {
  const { host } = useFrame();
  const pending = useFound(host.wires.calendar)?.pending;
  const locale = useLocale();
  const t = useText("calsettings");
  const device = useCalendarDevice();
  return pending || device
    ? {
        count: pending ? new Intl.NumberFormat(locale).format(pending) : undefined,
        value: device ? t(device.settings.mailOffers ? "view.on" : "view.off") : undefined,
        detail: device?.settings.mailOffers ? t("mail.offered") : undefined,
      }
    : null;
}

export function MailCalendarPane() {
  const { commands } = useFrame();
  const t = useText("calsettings");
  const device = useCalendarDevice();
  const open = (
    <Button kind={device ? "quiet" : "two"} size="s" onPress={() => commands.go({ place: "frommail" })}>
      {t("mail.open")}
    </Button>
  );
  return device ? (
    <MailOfferChoices device={device} open={open} />
  ) : (
    <SettingsSheet>
      <SettingLine label={t("mail.fromMail")}>{open}</SettingLine>
    </SettingsSheet>
  );
}

type Source = { id: string; address: string; status?: string };
const sourceOf = (value: unknown): value is Source =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Source).id === "string" &&
  typeof (value as Source).address === "string";

function MailOfferChoices({
  device,
  open,
}: {
  device: NonNullable<ReturnType<typeof useCalendarDevice>>;
  open: ReactNode;
}) {
  const { host } = useFrame();
  const t = useText("calsettings");
  const [mailboxes, setMailboxes] = useState<Source[] | null>(null);
  const read = host.reads.mailboxes;
  useEffect(() => {
    if (read === NONE) return;
    let live = true;
    void read().then(
      (rows) => {
        if (live) setMailboxes(rows.filter(sourceOf).filter((row) => row.status === "connected"));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [read]);
  const { calendarMailboxesOff, mailEvidenceOff, mailOffers } = device.settings;
  const toggle = (off: readonly string[], key: string, on: boolean) =>
    on ? off.filter((id) => id !== key) : [...off, key];
  return (
    <>
      <SettingsSheet title={t("mail.readForEvents")}>
        {mailboxes?.map(({ id, address }) => (
          <SettingLine
            key={id}
            label={address}
            toggle={{
              on: !calendarMailboxesOff.includes(id),
              onChange: (on) => device.change({ calendarMailboxesOff: toggle(calendarMailboxesOff, id, on) }),
            }}
          />
        ))}
        {mailboxes?.length === 0 ? <SettingNote>{t("mail.noMailbox")}</SettingNote> : null}
        <SettingNote>{t("mail.phoneOfferNote")}</SettingNote>
      </SettingsSheet>
      <SettingsSheet title={t("mail.offered")}>
        {(["calendar", "data"] as const).map((key) => (
          <SettingLine
            key={key}
            label={t(`mail.evidence.${key}`)}
            toggle={{
              on: !mailEvidenceOff.includes(key),
              onChange: (on) => device.change({ mailEvidenceOff: toggle(mailEvidenceOff, key, on) }),
            }}
          />
        ))}
      </SettingsSheet>
      <SettingsSheet title={t("mail.onCalendar")}>
        <SettingLine
          label={t("mail.fromMail")}
          icon="frommail"
          toggle={{ on: mailOffers, onChange: (on) => device.change({ mailOffers: on }) }}
        >
          {open}
        </SettingLine>
      </SettingsSheet>
    </>
  );
}
