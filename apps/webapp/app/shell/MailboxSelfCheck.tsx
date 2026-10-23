/**
 * SETTINGS → MAILBOXES → CHECK AGAINST THE MAIL SERVER — one press per mailbox, one sentence
 * back. The press asks the door the host supplies (`check`); the reading is the engine's, narrowed
 * by `readSelfCheck`, and the sentence states what was counted — never a promise, never a repair.
 * Shared by the desktop's local door and the web; each host hands in its own transport.
 */
import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, SettingsNote, SettingsRow, SettingsSection, SettingsSubhead } from "@ohmail/ui";
import {
  readSelfCheck, selfCheckSaid, type SelfCheck, type SelfCheckDiffer, type SelfCheckUnreadable,
} from "@trafficflow/core/diagnostics";

import { useMailboxFacts } from "./MailStateProvider";
import type { MailboxFacts } from "./mail-state";

/** What one press answered. `failed` is the request itself — nothing was read. */
export type SelfCheckPress = { k: "rest" } | { k: "busy" } | { k: "read"; check: SelfCheck } | { k: "failed" };

type Say = (key: string, values?: Record<string, string | number>) => string;

/** The mailbox-level refusal's sentence per class; any other class says the server was not read. */
const UNREACHED: Partial<Record<SelfCheckUnreadable, string>> = {
  timeout: "selfCheckUnreached_timeout", auth: "selfCheckUnreached_auth",
  connect: "selfCheckUnreached_connect", tls: "selfCheckUnreached_tls",
  busy: "selfCheckUnreached_busy", no_login: "selfCheckUnreached_no_login",
};

function item(t: Say, d: SelfCheckDiffer): string {
  if (d.k === "server_more") return t("selfCheckServerMore", { folder: d.folder, count: d.n });
  if (d.k === "mirror_more") return t("selfCheckMirrorMore", { folder: d.folder, count: d.n });
  return t("selfCheckRenumbered", { folder: d.folder });
}

function listOf(t: Say, items: string[], total: number): string {
  const shown = items.join(", ");
  return total > items.length ? t("selfCheckAndMore", { list: shown, count: total - items.length }) : shown;
}

/** The one sentence a reading says. Pure over the catalogue, so a test drives every arm. */
export function selfCheckSentence(t: Say, check: SelfCheck): string {
  const said = selfCheckSaid(check);
  switch (said.k) {
    case "in_step": return t("selfCheckInStep");
    case "empty": return t("selfCheckEmpty");
    case "unreached": return t(UNREACHED[said.error] ?? "selfCheckUnreached_other");
    case "differs": {
      const unreadList = listOf(t, said.unread, said.unreadCount);
      if (said.differCount === 0) return t("selfCheckOnlyUnread", { unread: said.unreadCount, unreadList });
      const list = listOf(t, said.differ.map((d) => item(t, d)), said.differCount);
      return said.unreadCount === 0
        ? t("selfCheckDiffers", { count: said.differCount, list })
        : t("selfCheckDiffersAndUnread", { count: said.differCount, list, unread: said.unreadCount, unreadList });
    }
  }
}

/**
 * The press's sentence — the reading's, or the lead while nothing has been asked. A reading counts
 * folders, not filings, so the filings still waiting on the mail server are said beside it.
 */
export function selfCheckPressSentence(t: Say, p: SelfCheckPress, waiting = 0): string | null {
  if (p.k === "read") {
    const said = selfCheckSentence(t, p.check);
    return waiting > 0 ? `${said} ${t("selfCheckWaiting", { count: waiting })}` : said;
  }
  if (p.k === "failed") return t("selfCheckFailed");
  return null;
}

/** This mailbox's filings that wait on the mail server, from the facts the page polls. */
const waitingOf = (m: MailboxFacts): number =>
  m.filing ? m.filing.due + m.filing.deferred : (m.pendingMoves ?? 0);

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
    <SettingsSection className="mbx-selfcheck">
      <SettingsSubhead>{t("selfCheckTitle")}</SettingsSubhead>
      {rows.map((m) => {
        const p = press[m.id] ?? { k: "rest" };
        const sentence = selfCheckPressSentence(t, p, waitingOf(m));
        return (
          <SettingsRow
            key={m.id}
            label={m.displayName || m.address}
            {...(sentence === null ? {} : { description: sentence })}
            control={(
              <Button variant="ghost" disabled={p.k === "busy"} onClick={() => { void run(m.id); }}>
                {p.k === "busy" ? t("selfCheckChecking") : t("selfCheckAction")}
              </Button>
            )}
          />
        );
      })}
      <SettingsNote icon="shield">{t("selfCheckWhy")}</SettingsNote>
    </SettingsSection>
  );
}
