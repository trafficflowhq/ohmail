import { useEffect, useState } from "react";
import { Button, Dialog, Tag } from "@ohmail/ui/base";
import { SettingActs, SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";

type ClaimTag =
  | "organizing"
  | "starting"
  | "stopping"
  | "stopPending"
  | "handedBack"
  | "paused"
  | "notOrganized"
  | "reader";

export interface ThisPhoneModel {
  readonly scope: string;
  readonly mailboxId: string;
  readonly address: string;
  readonly tag: ClaimTag | null;
  readonly note?: string;
  readonly warning?: boolean;
  readonly details?: readonly { readonly text: string; readonly warn?: boolean }[];
  readonly startWithoutPrompt?: () => void;
  readonly explainBackground?: boolean;
  readonly start?: () => void;
  readonly stop?: () => void;
  readonly openNotifications?: () => void;
}

export function ThisPhoneSheet({ model }: { readonly model: ThisPhoneModel }) {
  return <PhoneClaimSheet key={JSON.stringify([model.scope, model.mailboxId])} model={model} />;
}

function PhoneClaimSheet({ model }: { readonly model: ThisPhoneModel }) {
  const t = useText("phoneSettings");
  const [question, setQuestion] = useState<"background" | "stopAsk" | null>(null);
  const start = model.start;
  const stop = model.stop;
  const background = question === "background";
  const confirm = background ? start : stop;
  const activeQuestion =
    question !== null && confirm !== undefined && (!background || model.explainBackground);
  useEffect(() => {
    if (question !== null && !activeQuestion) setQuestion(null);
  }, [activeQuestion, question]);

  const stopButton = stop && (
    <Button kind="quiet" size="s" onPress={() => setQuestion("stopAsk")}>
      {t("thisPhone.stop")}
    </Button>
  );

  return (
    <SettingsSheet
      title={t("thisPhone.title")}
      sign="phone"
      hot={model.warning || model.details?.some((line) => line.warn)}
      aside={model.tag === null ? undefined : <Tag>{t(`thisPhone.tag.${model.tag}`)}</Tag>}
    >
      <SettingLine label={model.address} narrow="under">
        {start ? (
          <Button
            kind="two"
            size="s"
            onPress={() => (model.explainBackground ? setQuestion("background") : start())}
          >
            {t("thisPhone.start")}
          </Button>
        ) : model.openNotifications ? null : (
          stopButton
        )}
      </SettingLine>
      {model.note ? <SettingNote warn={model.warning}>{model.note}</SettingNote> : null}
      {model.details?.map(({ text, warn }) => (
        <SettingNote key={text} warn={warn}>
          {text}
        </SettingNote>
      ))}
      {model.openNotifications ? (
        <SettingActs label={t("thisPhone.title")}>
          <Button kind="two" size="s" onPress={model.openNotifications}>
            {t("thisPhone.openNotifications")}
          </Button>
          {stopButton}
        </SettingActs>
      ) : null}
      {question && activeQuestion ? (
        <Dialog
          open
          onClose={() => {
            setQuestion(null);
            if (background) model.startWithoutPrompt?.();
          }}
          title={t(`thisPhone.${question}.title`)}
          line={t(`thisPhone.${question}.${background ? "why" : "what"}`)}
          confirm={{
            label: t(`thisPhone.${question}.${background ? "continue" : "confirm"}`),
            onPress: () => {
              setQuestion(null);
              confirm();
            },
          }}
          cancel={{ label: t(`thisPhone.${question}.${background ? "notNow" : "cancel"}`) }}
        >
          {background ? null : <SettingNote>{t("thisPhone.stopAsk.after")}</SettingNote>}
        </Dialog>
      ) : null}
    </SettingsSheet>
  );
}
