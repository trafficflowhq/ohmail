/**
 * THE STORAGE NOTICE — the browser's notice, decided as pure functions; `StorageNotice.tsx` renders
 * it. Near the cap it says what will happen, at it what happened; both say what keeps more text. A
 * trial is offered a bigger plan (on the largest plan the add-on once paid), an active subscription
 * the plan or the add-on (on the largest plan the add-on alone); past due or grace is offered neither
 * (the operator refuses an add-on then). Inside the trial's floor it says when the plan's own limit
 * applies and what that empties (`carry`). Text emptied under an earlier cap (`past`) is said without
 * the cap and without an offer. The store face names no plan and offers no press (App Review 3.1.1),
 * and no face promises emptied text back. Put away at a level, it comes back at a worse one or under
 * a new cap.
 */
import type { AccessFeed, StorageFacts } from "../net/account";
import type { Deck } from "../copy.en";
import { linksOutToBilling, type Distribution } from "../distribution";
import { longDayStamp, monthStamp } from "./day-stamp";

export type StoragePlan = "trial" | "active";

/** At or past nine tenths of the cap, the storage is nearly full. */
export const STORAGE_NEAR_CAP_RATIO = 0.9;

/**
 * Least first: emptied under an earlier cap, near the cap, inside the trial's floor near or past the
 * plan's own limit, at the cap or emptying text now.
 */
export const STORAGE_LEVELS = ["past", "near", "carry", "full"] as const;
export type StorageLevel = (typeof STORAGE_LEVELS)[number];

export interface StorageNoticeFacts {
  facts: StorageFacts;
  level: StorageLevel;
  /** Is the current cap what empties text now? */
  current: boolean;
  /** The offer, or `null`: the store face, a subscription that cannot buy one, or `past`. */
  plan: StoragePlan | null;
  /** The Manage subscription press: everywhere but the store face. */
  manage: boolean;
}

/** The keystore key of a dismissal: per account, level and cap. */
export function storageNoticeKey(owner: string | null, level: StorageLevel, cap: number | string): string {
  return `${owner ?? "local"}.storage.${level}.${cap}`;
}

/**
 * The cap a dismissal is kept under: the cap, or inside the trial's floor the plan's own limit and
 * when it applies, so the notice comes back once a payment dates it and again once it applies.
 */
export function storageNoticeCap(facts: StorageFacts): string {
  return facts.planLimitBytes === null ? String(facts.limitBytes) : `${facts.planLimitBytes}-${facts.limitDropsAt ?? "unpaid"}`;
}

export function storageLevelOf(facts: StorageFacts): StorageLevel | null {
  if (facts.usedBytes >= facts.limitBytes || (facts.emptiedForSpace > 0 && facts.emptyingNow)) return "full";
  if (facts.planLimitBytes !== null && facts.usedBytes >= facts.planLimitBytes * STORAGE_NEAR_CAP_RATIO) return "carry";
  if (facts.usedBytes >= facts.limitBytes * STORAGE_NEAR_CAP_RATIO) return "near";
  return facts.emptiedForSpace > 0 ? "past" : null;
}

/** `putAway(level, cap)`: did this phone put the notice away at that level under that cap? */
export function storageNoticeOf(
  entry: AccessFeed | null, putAway: (level: StorageLevel, cap: string) => boolean, distribution?: Distribution,
): StorageNoticeFacts | null {
  if (entry === null || !entry.answer.metered) return null;
  const facts = entry.answer.storage;
  if (facts === undefined) return null;
  const level = storageLevelOf(facts);
  if (level === null) return null;
  const cap = storageNoticeCap(facts);
  if (STORAGE_LEVELS.slice(STORAGE_LEVELS.indexOf(level)).some((l) => putAway(l, cap))) return null;
  const mayLinkOut = distribution === undefined ? linksOutToBilling() : linksOutToBilling(distribution);
  const current = facts.emptyingNow;
  const state = entry.answer.lifecycle?.state;
  const plan = !mayLinkOut || level === "past" ? null : state === "trialing" ? "trial" : state === "active" ? "active" : null;
  return { facts, level, current, plan, manage: mayLinkOut };
}

/**
 * The notice's sentences in one deck, as the main screen draws them. Emptied letters: the oldest
 * letters emptied, then the month text is kept from with the letters that arrived while the storage
 * was full excepted (or those letters alone when no month is recorded). Then near or full (at the cap
 * only when nothing is emptied: the emptied letters say it), inside the trial's floor when the plan's
 * own limit applies, then the offer.
 */
export function storageNoticeText(n: StorageNoticeFacts, deck: Deck, locale: string): string {
  const arrived = n.facts.withheldOnArrival;
  const emptied = n.facts.emptiedForSpace > 0;
  const oldest = Math.max(0, n.facts.emptiedForSpace - arrived);
  const month = n.facts.keptFrom === null ? null : monthStamp(n.facts.keptFrom, locale);
  const top = n.facts.upgrade === "addon";
  const offer = n.plan === null ? null : n.plan === "trial"
    ? (top ? deck.storageOfferTrialTop : deck.storageOfferTrial)
    : (top ? deck.storageOfferActiveTop : deck.storageOfferActive);
  return [
    ...(emptied ? [
      oldest === 0 ? null : n.level === "full"
        ? deck.storageNoticeEmptied(capGigabytes(n.facts.limitBytes, locale), oldest)
        : deck.storageNoticeEmptiedBefore(oldest),
      month !== null
        ? (arrived > 0 ? deck.storageNoticeKeptFromExcept(month, arrived) : deck.storageNoticeKeptFrom(month))
        : (arrived > 0 ? deck.storageNoticeOnArrival(arrived) : null),
      deck.storageNoticeSafe,
    ] : []),
    n.level === "near" ? deck.storageNoticeNear : n.level === "full" && !emptied ? deck.storageNoticeFull : null,
    n.facts.planLimitBytes === null || n.level === "past" ? null : n.facts.limitDropsAt === null
      ? deck.storageNoticeCarryUnpaid(capGigabytes(n.facts.limitBytes, locale), capGigabytes(n.facts.planLimitBytes, locale))
      : deck.storageNoticeCarry(
        longDayStamp(n.facts.limitDropsAt, locale), capGigabytes(n.facts.limitBytes, locale),
        capGigabytes(n.facts.planLimitBytes, locale),
      ),
    offer,
    offer !== null && emptied ? deck.storageNoticeNoRestore : null,
  ].filter((line): line is string => line !== null).join(" ");
}

/** The cap in decimal gigabytes, the plan card's unit: "2", "1,5" in German. No formatter call. */
export function capGigabytes(bytes: number, locale: string): string {
  const gb = bytes / 1_000_000_000;
  const n = gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10;
  return locale.startsWith("de") ? String(n).replace(".", ",") : String(n);
}
