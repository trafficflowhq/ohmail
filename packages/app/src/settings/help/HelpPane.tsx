import { Button } from "@ohmail/ui/base";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import type { HelpModel } from "./model.js";

/** How many characters of the commit the version line shows, as the shipped pane does. */
const COMMIT_SHOWN = 9;

/**
 * Settings › Help & contact: Write to us, the version this is, and what the diagnostics block holds. Nothing is sent
 * from here: every way out is the person's own mail.
 */
export function HelpPane({ model }: { readonly model: HelpModel }) {
  const t = useText("help");
  const { write } = model;
  const version = `${model.version ?? t("dNone")}${model.commit !== null ? ` · ${t("dBuild")} ${model.commit.slice(0, COMMIT_SHOWN)}` : ""}`;
  const why =
    write.kind === "compose"
      ? t("writeWhy")
      : write.kind === "mailto"
        ? t("writeWhyMailto")
        : t("writeWhyCopy");
  return (
    <SettingsSheet>
      <SettingLine label={t("write")} narrow="under">
        {write.kind === "compose" ? (
          <Button kind="ink" size="s" onPress={() => write.write()}>
            {t("write")}
          </Button>
        ) : write.kind === "mailto" ? (
          <Button kind="ink" size="s" href={write.href}>
            {t("write")}
          </Button>
        ) : (
          <>
            <Button kind="ink" size="s" onPress={() => write.copy("address")}>
              {write.copied === "address" ? t("copied") : t("copyAddress")}
            </Button>
            <Button kind="quiet" size="s" onPress={() => write.copy("diag")}>
              {write.copied === "diag" ? t("copied") : t("copyDiag")}
            </Button>
          </>
        )}
      </SettingLine>
      <SettingNote>{why}</SettingNote>
      <SettingLine label={t("versionLabel")} value={version} />
      <SettingNote>{t("diagWhat")}</SettingNote>
      <SettingNote>{t("note")}</SettingNote>
    </SettingsSheet>
  );
}
