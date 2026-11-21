import { useState } from "react";
import { Button } from "@ohmail/ui/base";
import { SettingActs, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";

export interface DiagnosticFileActions {
  readonly write: () => Promise<string | null>;
  readonly share: () => Promise<boolean>;
}

type Status =
  | { readonly kind: "ready" | "writing" | "writeFailed" }
  | { readonly kind: "written" | "sharing" | "shareFailed"; readonly file: string };

export function DiagnosticFileSheet({ actions }: { readonly actions: DiagnosticFileActions }) {
  const t = useText("phoneSettings");
  const [status, setStatus] = useState<Status>({ kind: "ready" });
  const writing = status.kind === "writing";
  const busy = writing || status.kind === "sharing";
  const failed = status.kind === "writeFailed" || status.kind === "shareFailed";

  async function write() {
    setStatus({ kind: "writing" });
    const file = await actions.write().catch(() => null);
    setStatus(file ? { kind: "written", file } : { kind: "writeFailed" });
  }

  async function share(file: string) {
    setStatus({ kind: "sharing", file });
    const opened = await actions.share().catch(() => false);
    setStatus({ kind: opened ? "written" : "shareFailed", file });
  }

  return (
    <SettingsSheet
      title={t("diagnostics.title")}
      hot={failed}
      aside={
        <Button kind="quiet" size="s" disabled={busy} onPress={() => void write()}>
          {t(writing ? "diagnostics.writing" : "diagnostics.write")}
        </Button>
      }
    >
      <SettingNote>{t("diagnostics.about")}</SettingNote>
      {status.kind === "writeFailed" ? <SettingNote warn>{t("diagnostics.failed")}</SettingNote> : null}
      {"file" in status ? (
        <>
          {status.kind === "shareFailed" ? (
            <SettingNote warn>{t("diagnostics.shareFailed")}</SettingNote>
          ) : (
            <SettingNote said>{t("diagnostics.written", { file: status.file })}</SettingNote>
          )}
          <SettingActs label={t("diagnostics.title")}>
            <Button kind="two" size="s" disabled={busy} onPress={() => void share(status.file)}>
              {t("diagnostics.share")}
            </Button>
          </SettingActs>
        </>
      ) : null}
    </SettingsSheet>
  );
}
