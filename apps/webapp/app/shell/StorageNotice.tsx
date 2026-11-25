"use client";

import type { MouseEvent, ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useOptionalReport } from "@ohmail/app/frame";
import { Button, Notice, type NoticeProps } from "@ohmail/ui/base";
import { STORAGE_PANE_HREF } from "./storage-state";
import {
  formatStorageBytes, storageDayName, storageMonthName,
  storagePercent, type StorageCard, type StorageFacts,
} from "./storage-state";

/** What a press of Change plan or Add storage does on this host, and what it has to say. */
export interface StorageChange {
  press(event: MouseEvent<HTMLButtonElement>, addon?: "storage"): void;
  busy: boolean;
  /** A refusal sentence or the step-up prompt, under the buttons. */
  note: ReactNode;
}

const DISMISSED: Record<StorageCard, string> = {
  near: "storageDismissedNear", full: "storageDismissedFull", drop: "storageDismissedDrop",
};

/** The storage notice in the Ohbox, with the server’s current storage estimate. */
export function StorageNotice({ facts, linksOut, onDismiss, change }: {
  facts: StorageFacts;
  linksOut: boolean;
  onDismiss: () => void;
  /** Absent where the offer cannot be changed from here. */
  change: StorageChange | null;
}) {
  const t = useTranslations("settings");
  const locale = useLocale();
  const report = useOptionalReport();
  const level = facts.card;
  if (level === null) return null;
  const size = (bytes: number) => formatStorageBytes(bytes, locale, true);
  const percent = storagePercent(facts);
  const head = level === "near" ? t("storageCardNear", { percent })
    : level === "full" ? t("storageCardFull")
      : t("storageCardDrop", { cap: size(facts.planLimitBytes ?? facts.limitBytes) });

  const lines: ReactNode[] = [];
  const estimate = facts.estimate;
  if (level === "near" && estimate !== null && estimate.expectedBytes > facts.usedBytes) {
    lines.push(t(facts.importing ? "storageCardExpectedImport" : "storageCardExpected", { size: size(estimate.expectedBytes) }));
  }
  if (level === "full") {
    lines.push(facts.keptFrom !== null
      ? t("storageCardKeptFrom", { month: storageMonthName(facts.keptFrom, locale) })
      : t("storageCardKeptOlder"));
  }
  if (level === "drop") {
    const cap = size(facts.planLimitBytes ?? facts.limitBytes);
    lines.push(facts.limitDropsAt !== null
      ? t("storageCardDropOn", { cap, date: storageDayName(facts.limitDropsAt, locale) })
      : t("storageCardDropPaid", { cap }));
  }
  const offer = facts.offer;
  const changes = linksOut && change !== null && offer !== null && offer.canChange;
  const dismiss = () => {
    onDismiss();
    report?.(t(DISMISSED[level]));
  };
  const dismissAct: NonNullable<NoticeProps["acts"]>[number] = { label: t("storageDismiss"), onPress: dismiss, kind: "quiet" };
  const acts: NoticeProps["acts"] = changes
    ? [{
        label: t(offer.addon === null ? "storageChangePlan" : "storageAddStorage"),
        onPress: (event) => change.press(event, offer.addon === null ? undefined : "storage"),
        busy: change.busy,
      }, dismissAct]
    : [dismissAct];
  return (
    <section aria-label={t("storage")} data-storage-card={level}>
      <Notice
        place="rail"
        title={head}
        hot={level !== "near"}
        line={lines[0]}
        acts={acts}
        related={linksOut ? (
          <>
            {changes && offer.addon !== null ? (
              <Button kind="quiet" size="s" busy={change.busy} onPress={change.press}>{t("storageChangePlan")}</Button>
            ) : null}
            <Button kind="quiet" size="s" href={STORAGE_PANE_HREF}>{t("storage")}</Button>
          </>
        ) : null}
      />
      {changes ? change.note : null}
    </section>
  );
}
