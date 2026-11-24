/**
 * SETTINGS → MAILBOXES → CHECK AGAINST THE MAIL SERVER — one press per mailbox, one sentence
 * back. The press asks the door the host supplies (`check`); the reading is the engine's, narrowed
 * by `readSelfCheck`, and the sentence states what was counted — never a promise, never a repair.
 * Shared by the desktop's local door and the web; each host hands in its own transport.
 */
import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui/base";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { readSelfCheck } from "@trafficflow/core/diagnostics";

import { useMailboxFacts } from "@ohmail/app-logic/mail-state/mail-state-binding";
/* The sentences moved beside the Mailboxes pane's rules; re-exported for this file's importers. */
import {
  selfCheckPressSentence, selfCheckSentence, selfCheckWaiting as waitingOf, type SelfCheckPress,
} from "@ohmail/app-logic/mailboxes/moved";
export { selfCheckPressSentence, selfCheckSentence, type SelfCheckPress };

type Say = (key: string, values?: Record<string, string | number>) => string;

export function MailboxSelfCheck({ check }: { check: (mailboxId: string) => Promise<unknown> }) {
  const t = useTranslations("mailboxes") as unknown as Say;
  const mailboxes = useMailboxFacts();
  const [press, setPress] = useState<Record<string, SelfCheckPress>>({});
  const run = useCallback(async (id: string) => {
    setPress((p) => ({ ...p, [id]: { k: "busy" } }));
    let next: SelfCheckPress;
    try {
      const reading = readSelfCheck(await check(id));
      next = reading !== null && reading.mailboxId === id ? { k: "read", check: reading } : { k: "failed" };
    } catch {
      next = { k: "failed" };
    }
    setPress((p) => ({ ...p, [id]: next }));
  }, [check]);
  const rows = (mailboxes ?? []).filter((m) => m.status !== "disabled");
  if (rows.length === 0) return null;
  return (
    <SettingsSheet title={t("selfCheckTitle")}>
      {rows.map((m) => {
        const p = press[m.id] ?? { k: "rest" };
        const sentence = selfCheckPressSentence(t, p, waitingOf(m));
        return (
          <SettingLine
            key={m.id}
            label={m.displayName || m.address}
            {...(sentence === null ? {} : { description: sentence })}
            narrow="detail"
          >
            <Button kind="quiet" disabled={p.k === "busy"} onPress={() => { void run(m.id); }}>
              {p.k === "busy" ? t("selfCheckChecking") : t("selfCheckAction")}
            </Button>
          </SettingLine>
        );
      })}
      <SettingNote>{t("selfCheckWhy")}</SettingNote>
    </SettingsSheet>
  );
}
