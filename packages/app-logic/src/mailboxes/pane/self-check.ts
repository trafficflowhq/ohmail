/**
 * CHECK A MAILBOX AGAINST ITS MAIL SERVER: the one sentence a press answers (moved out of the web shell's
 * `MailboxSelfCheck.tsx` as it stood). The reading is the engine's, narrowed by `readSelfCheck`; the sentence states
 * what was counted, never a promise and never a repair. Pure over the catalogue, so every arm is driven by a test.
 */
import {
  selfCheckSaid,
  type SelfCheck,
  type SelfCheckDiffer,
  type SelfCheckUnreadable,
} from "@trafficflow/core/diagnostics";
import type { MailboxFacts } from "../../mail-state/mail-state.js";

/** What one press answered. `failed` is the request itself — nothing was read. */
export type SelfCheckPress =
  { k: "rest" } | { k: "busy" } | { k: "read"; check: SelfCheck } | { k: "failed" };

type Say = (key: string, values?: Record<string, string | number>) => string;

/** The mailbox-level refusal's sentence per class; any other class says the server was not read. */
const UNREACHED: Partial<Record<SelfCheckUnreadable, string>> = {
  timeout: "selfCheckUnreached_timeout",
  auth: "selfCheckUnreached_auth",
  connect: "selfCheckUnreached_connect",
  tls: "selfCheckUnreached_tls",
  busy: "selfCheckUnreached_busy",
  no_login: "selfCheckUnreached_no_login",
};

function item(t: Say, d: SelfCheckDiffer): string {
  // News' folder before the rename: say where the letters are; the organizer folds them in.
  if (d.predecessorOf !== undefined) return t("selfCheckPredecessor", { folder: d.folder, count: d.n });
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
    case "in_step":
      return t("selfCheckInStep");
    case "empty":
      return t("selfCheckEmpty");
    case "unreached":
      return t(UNREACHED[said.error] ?? "selfCheckUnreached_other");
    case "differs": {
      const unreadList = listOf(t, said.unread, said.unreadCount);
      if (said.differCount === 0) return t("selfCheckOnlyUnread", { unread: said.unreadCount, unreadList });
      const list = listOf(
        t,
        said.differ.map((d) => item(t, d)),
        said.differCount,
      );
      return said.unreadCount === 0
        ? t("selfCheckDiffers", { count: said.differCount, list })
        : t("selfCheckDiffersAndUnread", {
            count: said.differCount,
            list,
            unread: said.unreadCount,
            unreadList,
          });
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
export const selfCheckWaiting = (m: Pick<MailboxFacts, "filing" | "pendingMoves">): number =>
  m.filing ? m.filing.due + m.filing.deferred : (m.pendingMoves ?? 0);
