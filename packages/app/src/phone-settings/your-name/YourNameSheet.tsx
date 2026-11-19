import { useState } from "react";
import { senderNameOf } from "@ohmail/app-logic/mailboxes/connect/sender-name";
import { Button, Field, Tag } from "@ohmail/ui/base";
import { SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";

interface EditorProps {
  readonly name: string | null;
  readonly mailbox?: string;
  readonly save: (name: string | null) => Promise<string | null>;
}

interface YourNameProps extends EditorProps {
  readonly scope: string;
  readonly mailboxId: string;
}

type Phase = "ready" | "invalid" | "saving" | "saved" | "failed";

export function YourNameSheet({ scope, mailboxId, ...editor }: YourNameProps) {
  return <YourNameEditor key={JSON.stringify([scope, mailboxId])} {...editor} />;
}

function YourNameEditor({ name, mailbox, save }: EditorProps) {
  const t = useText("phoneSettings");
  const refusalText = useText("phoneRefusal");
  const [saved, setSaved] = useState(name ?? "");
  const [value, setValue] = useState(saved);
  const [phase, setPhase] = useState<Phase>("ready");
  const disabled = phase === "saving" || value === saved;

  async function submit() {
    if (disabled) return;
    const next = senderNameOf(value);
    if (next === undefined) {
      setPhase("invalid");
      return;
    }
    setPhase("saving");
    try {
      const confirmed = (await save(next)) ?? "";
      setSaved(confirmed);
      setValue(confirmed);
      setPhase("saved");
    } catch {
      setPhase("failed");
    }
  }

  const refusal =
    phase === "invalid"
      ? refusalText("standaloneNameRefused")
      : phase === "failed"
        ? t("yourName.failed")
        : undefined;
  return (
    <SettingsSheet
      title={t("yourName.title")}
      aside={
        phase === "saved" ? (
          <span role="status">
            <Tag>{t("yourName.saved")}</Tag>
          </span>
        ) : (
          <Button kind="two" size="s" disabled={disabled} onPress={() => void submit()}>
            {t("yourName.save")}
          </Button>
        )
      }
    >
      <Field
        label={mailbox ?? t("yourName.label")}
        value={value}
        autoComplete="name"
        disabled={phase === "saving"}
        refusal={refusal}
        onChange={(text) => {
          setValue(text);
          setPhase("ready");
        }}
        onEnter={() => void submit()}
      />
      <SettingNote>{t("yourName.note")}</SettingNote>
    </SettingsSheet>
  );
}
