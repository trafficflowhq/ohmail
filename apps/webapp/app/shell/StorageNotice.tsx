"use client";

import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  formatStorageBytes, storageEmptyingNow, storageKeptLine, storageOldestEmptied, type StorageFacts, type StoragePlan,
} from "./storage-state";

/**
 * THE ONE-TIME NOTICE THAT OHMAIL EMPTIED LETTER TEXT FOR SPACE, drawn in the shell's account slot.
 * It says what happened, that the letters stay complete on the mail server, and what keeps more text
 * from now on, and never that an upgrade brings emptied text back. Below the current cap's trim band
 * it says what happened then, without the current cap and without an offer. `plan` null leaves the
 * plan sentence out (a build that may not point at a purchase, a subscription that cannot buy one).
 * The host decides when it is due and how it is put away (`storage-state.ts#storageNoticeDue`);
 * `manage` is the host's own control or null.
 */
export function StorageNotice({ facts, plan, manage, onDismiss }: {
  facts: StorageFacts;
  plan: StoragePlan | null;
  manage: ReactNode;
  onDismiss: () => void;
}) {
  const t = useTranslations("settings");
  const locale = useLocale();
  const now = storageEmptyingNow(facts);
  // The oldest letters emptied, then the month text is kept from with the arrivals it does not cover.
  const oldest = storageOldestEmptied(facts);
  const kept = storageKeptLine(facts, locale);
  const lines = [
    oldest === 0 ? null : now
      ? t("storageNoticeEmptied", { cap: formatStorageBytes(facts.limitBytes, locale), count: oldest })
      : t("storageNoticeEmptiedBefore", { count: oldest }),
    kept === null ? null : t(kept.key, kept.values),
    t("storageNoticeSafe"),
    now && plan !== null ? t(plan === "trial" ? "storageNoticeTrial" : "storageNoticeActive") : null,
  ];
  return (
    <div className="acct-note" role="status" data-storage-notice="">
      <p className="acct-note-line">{lines.filter((line) => line !== null).join(" ")}</p>
      {manage}
      <button type="button" className="acct-later" onClick={onDismiss}>{t("storageNoticeDismiss")}</button>
    </div>
  );
}
