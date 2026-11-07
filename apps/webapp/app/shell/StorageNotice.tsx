"use client";

import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useOptionalToast } from "@ohmail/ui";
import { STORAGE_PANE_HREF } from "./EmptiedLetter";
import {
  formatStorageBytes, formatStoragePrice, storageDayName, storageFitExtraBytes, storageFitIsChange, storageMonthName,
  storagePercent, type StorageCard, type StorageFacts, type StorageOffer,
} from "./storage-state";

/** What a press of Change plan or Add storage does on this host, and what it has to say. */
export interface StorageChange {
  press: () => void;
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
 * THE STORAGE CARD atop the Ohbox, compact: one head row (the level, the figure, Dismiss), a bar, one
 * line, one row of small buttons. Which card is due is the server's word (`card`, its dismissal
 * applied); this draws it. Prices only from the program's offer, and only where `linksOut`: a store
 * build names the fitted plan and says where to manage it, with no amount, no purchase button and
 * no link.
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
  const toast = useOptionalToast();
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
    toast?.(t(DISMISSED[level]));
  };
  return (
    <section className="scard" data-level={level} aria-label={t("storage")} data-storage-card={level}>
      <div className="scard-head">
        <b>{head}</b>
        <span className="scard-fig">{t("storageOf", { used: size(facts.usedBytes), limit: size(facts.limitBytes) })}</span>
        <button type="button" className="scard-x" aria-label={t("storageDismiss")} title={t("storageDismiss")} onClick={dismiss}>
          ×
        </button>
      </div>
      <div className="scard-meter" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div>
      {lines.length > 0 ? (
        <p className="scard-line">{lines.map((line, i) => <span key={i}>{i > 0 ? " " : null}{line}</span>)}</p>
      ) : null}
      {linksOut ? (
        <div className="scard-acts">
          {changes && offer!.addon !== null ? (
            <button type="button" className="btn primary" disabled={change!.busy} onClick={change!.press}>
              {t("storageAddStorage")}
            </button>
          ) : null}
          {changes ? (
            <button type="button" className={offer!.addon !== null ? "btn" : "btn primary"} disabled={change!.busy} onClick={change!.press}>
              {t("storageChangePlan")}
            </button>
          ) : null}
          <a className="scard-why" href={STORAGE_PANE_HREF}>{t("storageWhatCounts")}</a>
        </div>
      ) : (
        <p className="scard-line scard-manage">{t("storageManageAtSite")}</p>
      )}
      {changes ? change!.note : null}
    </section>
  );
}
