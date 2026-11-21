import { Button, Tag } from "@ohmail/ui/base";
import { SettingLine, SettingsSheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import { AI_NAMESPACE } from "./namespace.js";
import "./ai-credits.css";
import type { AiModel } from "./model.js";

export interface AiPaneProps {
  readonly model: AiModel;
  /** The reader's sentence for a server with no model (`aiRefusal.noModel`), said after the switch's own. */
  readonly noModelSaid: string;
  readonly cloudModel?: boolean;
  readonly credits?: { remaining: number; total?: number } | null;
  readonly toPlans?: () => void;
  readonly draftReplies?: { enabled: boolean; toggle(next: boolean): void };
}

/**
 * Settings › AI: one switch over the account's flag, what it covers, and what turning it off costs. The switch is
 * drawn before the server answers and cannot be pressed until it has; a failed read or a refused write is said on
 * the sheet, never left out.
 */
export function AiPane({ model, noModelSaid, cloudModel, draftReplies, credits, toPlans }: AiPaneProps) {
  const t = useText("settings");
  const own = useText(AI_NAMESPACE);
  return (
    <>
      <SettingsSheet
        wants={
          model.problem
            ? {
                word: own(model.enabled === null ? "notRead" : "notChanged"),
                line: model.problem,
                alert: true,
              }
            : credits?.remaining === 0
              ? {
                  word: own("creditsEmpty"),
                  acts: toPlans && (
                    <Button kind="two" size="s" onPress={toPlans}>
                      {own("plans")}
                    </Button>
                  ),
                }
              : model.noModel
                ? { word: own("notSetUp"), line: noModelSaid }
                : undefined
        }
      >
        <SettingLine
          label={t("aiLabel")}
          toggle={{ on: model.enabled === true, onChange: model.toggle }}
          off={model.enabled === null}
        />
        {draftReplies ? (
          <SettingLine
            label={own("draftReply")}
            sub
            off={model.enabled !== true || model.noModel}
            toggle={{ on: draftReplies.enabled, onChange: draftReplies.toggle }}
          />
        ) : null}
        {credits ? (
          <>
            <SettingLine
              label={own("budget")}
              value={own(credits.total === undefined ? "creditsBalance" : "creditsLeft", credits)}
              off={model.enabled === false}
            />
            {credits.total !== undefined && credits.total > 0 ? (
              <progress
                className="ai-credits-meter"
                aria-hidden="true"
                value={Math.min(credits.remaining, credits.total)}
                max={credits.total}
              />
            ) : null}
          </>
        ) : null}
      </SettingsSheet>
      {cloudModel ? (
        <SettingsSheet title={own("model")} aside={<Tag>{own("working")}</Tag>}>
          <SettingLine label={own("where")} value={own("cloud")} />
        </SettingsSheet>
      ) : null}
    </>
  );
}
