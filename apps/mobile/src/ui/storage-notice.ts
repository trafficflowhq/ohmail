/**
 * THE NOTICE THAT OHMAIL EMPTIED LETTER TEXT FOR SPACE — the browser's notice, decided as pure
 * functions; `StorageNotice.tsx` renders it. Due while the access answer reports emptied letters and
 * this phone has not put it away for the account. While the current cap is still emptying text (the
 * trim band), a trial is offered a bigger plan and an active subscription the plan or the storage
 * add-on; past due or grace is offered neither (the operator refuses an add-on then). Below the band
 * the notice says what happened then, without the cap and without an offer. The store face names no
 * plan and offers no press (App Review 3.1.1), and no face promises emptied text back.
 */
import type { AccessFeed, StorageFacts } from "../net/account";
import type { Deck } from "../copy.en";
import { linksOutToBilling, type Distribution } from "../distribution";
import { monthStamp } from "./day-stamp";

export type StoragePlan = "trial" | "active";

/** The trim brings the counter to nine tenths of the cap: at or past this share the cap empties text now. */
export const STORAGE_TRIM_BAND_RATIO = 0.85;

export interface StorageNoticeFacts {
  facts: StorageFacts;
  /** Is the current cap what empties text now? */
  current: boolean;
  /** The plan sentence, or `null`: the store face, a subscription that cannot buy one, or below the band. */
  plan: StoragePlan | null;
  /** The Manage subscription press: everywhere but the store face. */
  manage: boolean;
}

/** The keystore key of the dismissal: per account, once. */
export function storageNoticeKey(owner: string | null): string {
  return `${owner ?? "local"}.emptied`;
}

export function storageNoticeOf(
  entry: AccessFeed | null, putAway: boolean, distribution?: Distribution,
): StorageNoticeFacts | null {
  if (entry === null || !entry.answer.metered || putAway) return null;
  const facts = entry.answer.storage;
  if (facts === undefined || facts.emptiedForSpace <= 0) return null;
  const mayLinkOut = distribution === undefined ? linksOutToBilling() : linksOutToBilling(distribution);
  const current = facts.usedBytes >= facts.limitBytes * STORAGE_TRIM_BAND_RATIO;
  const state = entry.answer.lifecycle?.state;
  const plan = !mayLinkOut || !current ? null : state === "trialing" ? "trial" : state === "active" ? "active" : null;
  return { facts, current, plan, manage: mayLinkOut };
}

/**
 * The notice's sentences in one deck, as the main screen draws them: the oldest letters emptied, then
 * the month text is kept from with the letters that arrived while the storage was full excepted (or
 * those letters alone when no month is recorded).
 */
export function storageNoticeText(n: StorageNoticeFacts, deck: Deck, locale: string): string {
  const arrived = n.facts.withheldOnArrival;
  const oldest = Math.max(0, n.facts.emptiedForSpace - arrived);
  const month = n.facts.keptFrom === null ? null : monthStamp(n.facts.keptFrom, locale);
  return [
    oldest === 0 ? null : n.current
      ? deck.storageNoticeEmptied(capGigabytes(n.facts.limitBytes, locale), oldest)
      : deck.storageNoticeEmptiedBefore(oldest),
    month !== null
      ? (arrived > 0 ? deck.storageNoticeKeptFromExcept(month, arrived) : deck.storageNoticeKeptFrom(month))
      : (arrived > 0 ? deck.storageNoticeOnArrival(arrived) : null),
    deck.storageNoticeSafe,
    n.plan === null ? null : n.plan === "trial" ? deck.storageNoticeTrial : deck.storageNoticeActive,
  ].filter((line): line is string => line !== null).join(" ");
}

/** The cap in decimal gigabytes, the plan card's unit: "2", "1,5" in German. No formatter call. */
export function capGigabytes(bytes: number, locale: string): string {
  const gb = bytes / 1_000_000_000;
  const n = gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10;
  return locale.startsWith("de") ? String(n).replace(".", ",") : String(n);
}
