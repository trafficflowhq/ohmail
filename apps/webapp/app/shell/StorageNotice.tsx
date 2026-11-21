"use client";

import type { MouseEventHandler, ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useOptionalReport } from "@ohmail/app/frame";
import { Button, Notice, type NoticeProps } from "@ohmail/ui/base";
import { STORAGE_PANE_HREF } from "./storage-state";
import {
  formatStorageBytes, formatStoragePrice, storageDayName, storageFitExtraBytes, storageFitIsChange, storageMonthName,
  storagePercent, type StorageCard, type StorageFacts, type StorageOffer,
} from "./storage-state";

/** What a press of Change plan or Add storage does on this host, and what it has to say. */
export interface StorageChange {
  press: MouseEventHandler<HTMLButtonElement>;
  busy: boolean;
  /** A refusal sentence or the step-up prompt, under the buttons. */
  note: ReactNode;
}

const DISMISSED: Record<StorageCard, string> = {
  near: "storageDismissedNear", full: "storageDismissedFull", drop: "storageDismissedDrop",
};

/** The fitted choice's name, "Plus + 10 GB", in the catalogue's words. */
export function useStorageFitName(): (offer: StorageOffer) => string {
  const t = useTranslations("settings");
  const locale = useLocale();
  return (offer) => {
    const plan = t("storagePlanName", { plan: offer.fit.plan });
    const extra = storageFitExtraBytes(offer);
    return extra === null ? plan : t("storageFitName", { plan, extra: formatStorageBytes(extra, locale) });
  };
}

/**
 * The storage notice in the Ohbox. The server's card and offer decide what is due. A store build
 * names the fitted plan and where it is managed without prices, purchase buttons or links.
 */
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
  const fitName = useStorageFitName();
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
  if (offer !== null && storageFitIsChange(offer)) {
    const b = (chunks: ReactNode) => <b>{chunks}</b>;
    const fit = fitName(offer);
    const price = t(offer.interval === "year" ? "storagePriceYear" : "storagePriceMonth", {
      price: formatStoragePrice(offer.fit.amount, offer.currency, locale),
    });
    const room = size(offer.fit.roomBytes);
    lines.push(offer.fit.keepsAll
      ? linksOut ? t.rich("storageFitAll", { fit, price, b }) : t.rich("storageFitAllStore", { fit, b })
      : linksOut ? t.rich("storageFitMost", { fit, price, room, b }) : t.rich("storageFitMostStore", { fit, room, b }));
  }

  const changes = linksOut && change !== null && offer !== null && offer.canChange;
  const dismiss = () => {
    onDismiss();
    report?.(t(DISMISSED[level]));
  };
  const dismissAct: NonNullable<NoticeProps["acts"]>[number] = { label: t("storageDismiss"), onPress: dismiss, kind: "quiet" };
  const acts: NoticeProps["acts"] = changes
    ? [{
        label: t(offer.addon === null ? "storageChangePlan" : "storageAddStorage"),
        onPress: change.press,
        busy: change.busy,
      }, dismissAct]
    : [dismissAct];
  return (
    <section aria-label={t("storage")} data-storage-card={level}>
      <Notice
        place="rail"
        title={head}
        hot={level !== "near"}
        line={
          <>
            {t("storageOf", { used: size(facts.usedBytes), limit: size(facts.limitBytes) })}
            {lines.map((line, i) => <span key={i}> {line}</span>)}
            {linksOut ? null : <> {t("storageManageAtSite")}</>}
          </>
        }
        acts={acts}
        related={linksOut ? (
          <>
            {changes && offer.addon !== null ? (
              <Button kind="quiet" size="s" busy={change.busy} onPress={change.press}>{t("storageChangePlan")}</Button>
            ) : null}
            <Button kind="quiet" size="s" href={STORAGE_PANE_HREF}>{t("storageWhatCounts")}</Button>
          </>
        ) : null}
      />
      {changes ? change.note : null}
    </section>
  );
}
