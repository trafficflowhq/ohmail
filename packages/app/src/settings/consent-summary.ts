import { useConsent } from "@ohmail/app-logic/consent";
import { useDemoMode } from "@ohmail/app-logic/engine";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { liveMailboxes } from "@ohmail/app-logic/mail-state/mail-state";
import { useLocale, useText } from "../text/index.js";
import { mailboxUsesFolders } from "./folders/model.js";
import type { PaneSummary } from "./contract.js";

/** The same stored folder choices the rail and pane share. */
export function useFoldersSummary(): PaneSummary | null {
  const consent = useConsent();
  const { mailboxes } = useMailState();
  const t = useText("settingsMenu");
  if (!consent.folderMailboxesKnown) return null;
  const live = liveMailboxes(mailboxes);
  const count = live?.filter((m) => mailboxUsesFolders(consent.folderMailboxesOff, m.id)).length;
  return {
    value: t(consent.foldersEnabled ? "on" : "off"),
    detail: consent.foldersEnabled && count !== undefined ? t("folderMailboxes", { count }) : undefined,
  };
}

/** Signatures are shown only after their live read, as in the signature editor. */
export function useSignaturesSummary(): PaneSummary | null {
  const consent = useConsent();
  const { mailboxes } = useMailState();
  const demo = useDemoMode();
  const locale = useLocale();
  const t = useText("settingsMenu");
  const live = liveMailboxes(mailboxes);
  if (demo || !consent.signaturesKnown || !live) return null;
  const signatures = live.map((m) => consent.signatures[m.id] ?? "").filter((s) => s.trim());
  if (!signatures.length) return { value: t("none") };
  const [value, detail] = signatures[0]!.split(/\r?\n/, 2);
  return { count: new Intl.NumberFormat(locale).format(signatures.length), value, detail };
}
