"use client";

import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  formatStorageBytes, storageDayName, storageKeptLine, storageOfferKey, storageOldestEmptied, type StorageFacts, type StorageLevel,
  type StoragePlan,
} from "./storage-state";

/**
 * THE STORAGE NOTICE, drawn in the shell's account slot: near the cap, what will happen; at it, what
 * happened (how many of the oldest letters, from which month text is kept); inside the trial's floor,
 * when the plan's own limit applies and what it empties then. All say that the letters
 * stay complete on the mail server and what keeps more text from now on, never that an upgrade brings
 * emptied text back. At `past` (emptied under an earlier cap) it says what happened then, without the
 * current cap and without an offer. `plan` null leaves the offer out (a build that may not point at a
 * purchase, a subscription that cannot buy one). The host decides the level it is due at and how it is
 * put away (`storage-state.ts#storageNoticeDue`); `manage` is the host's own control or null.
 */
export function StorageNotice({ facts, level, plan, manage, onDismiss }: {
  facts: StorageFacts;
  level: StorageLevel;
  plan: StoragePlan | null;
  manage: ReactNode;
  onDismiss: () => void;
}) {
  const t = useTranslations("settings");
  const locale = useLocale();
  const emptied = facts.emptiedForSpace > 0;
  // The oldest letters emptied, then the month text is kept from with the arrivals it does not cover.
  const oldest = storageOldestEmptied(facts);
  const kept = emptied ? storageKeptLine(facts, locale) : null;
  const lines: (string | null)[] = emptied ? [
    oldest === 0 ? null : level === "full"
      ? t("storageNoticeEmptied", { cap: formatStorageBytes(facts.limitBytes, locale), count: oldest })
      : t("storageNoticeEmptiedBefore", { count: oldest }),
    kept === null ? null : t(kept.key, kept.values),
    t("storageNoticeSafe"),
  ] : [];
  if (level === "near" || (level === "full" && !emptied)) lines.push(t(level === "full" ? "webStorageFull" : "webStorageNear"));
  if (facts.planLimitBytes !== null && level !== "past") {
    const sizes = { limit: formatStorageBytes(facts.limitBytes, locale), cap: formatStorageBytes(facts.planLimitBytes, locale) };
    lines.push(facts.limitDropsAt === null
      ? t("storageNoticeCarryUnpaid", sizes)
      : t("storageNoticeCarry", { ...sizes, date: storageDayName(facts.limitDropsAt, locale) }));
  }
  if (level !== "past" && plan !== null) {
    lines.push(t(storageOfferKey(plan, facts.upgrade)));
    if (emptied) lines.push(t("storageNoticeNoRestore"));
  }
  return (
    <div className="acct-note" role="status" data-storage-notice={level}>
      <p className="acct-note-line">{lines.filter((line) => line !== null).join(" ")}</p>
      {manage}
      <button type="button" className="acct-later" onClick={onDismiss}>{t("storageNoticeDismiss")}</button>
    </div>
  );
}
