import { Button } from "@ohmail/ui/base";
import { SettingLine, SettingsSheet } from "@ohmail/ui/mail";
import { useFrame } from "../../frame/commands.js";
import { useFound } from "../../frommail/index.js";
import type { PaneSummary } from "../../settings/contract.js";
import { useLocale, useText } from "../../text/index.js";

export function useMailCalendarSummary(): PaneSummary | null {
  const { host } = useFrame();
  const pending = useFound(host.wires.calendar)?.pending;
  const locale = useLocale();
  return pending ? { count: new Intl.NumberFormat(locale).format(pending) } : null;
}

export function MailCalendarPane() {
  const { commands } = useFrame();
  const t = useText("calsettings");
  return (
    <SettingsSheet>
      <SettingLine label={t("mail.fromMail")}>
        <Button kind="two" size="s" onPress={() => commands.go({ place: "frommail" })}>
          {t("mail.open")}
        </Button>
      </SettingLine>
    </SettingsSheet>
  );
}
