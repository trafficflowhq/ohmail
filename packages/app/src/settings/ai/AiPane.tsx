import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import { AI_NAMESPACE } from "./namespace.js";
import type { AiModel } from "./model.js";

export interface AiPaneProps {
  readonly model: AiModel;
  /** The reader's sentence for a server with no model (`aiRefusal.noModel`), said after the switch's own. */
  readonly noModelSaid: string;
}

/**
 * Settings › AI: one switch over the account's flag, what it covers, and what turning it off costs. The switch is
 * drawn before the server answers and cannot be pressed until it has; a failed read or a refused write is said on
 * the sheet, never left out.
 */
export function AiPane({ model, noModelSaid }: AiPaneProps) {
  const t = useText("settings");
  const own = useText(AI_NAMESPACE);
  const covers = model.noModel ? `${t("aiSub")} ${noModelSaid}` : t("aiSub");
  return (
    <SettingsSheet
      wants={
        model.problem
          ? { word: own(model.enabled === null ? "notRead" : "notChanged"), line: model.problem, alert: true }
          : undefined
      }
    >
      <SettingLine
        label={t("aiLabel")}
        toggle={{ on: model.enabled === true, onChange: model.toggle }}
        off={model.enabled === null}
      />
      <SettingNote>{covers}</SettingNote>
      <SettingNote>{t("aiOffNote")}</SettingNote>
    </SettingsSheet>
  );
}
