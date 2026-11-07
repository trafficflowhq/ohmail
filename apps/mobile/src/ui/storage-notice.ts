/**
 * STORAGE ON THE PHONE, decided as pure functions: the card atop the Ohbox (`StorageNotice.tsx`) and
 * the Storage screen (`app/storage.tsx`). The server decides whether a card is due and keeps its
 * dismissal (`card` on `GET /account/access`); this file only says it. Numbers first, in GB and in
 * letters. The store face (every shipped phone build) names plans and their rooms and nothing more:
 * no amount, no purchase button, no link, only the plain "Manage your plan at ohmail.app". A
 * sideload build draws the Manage subscription press in that line's place. No price is read at all
 * (`offerOf` in `net/account.ts` keeps rooms and names only).
 */
import {
  storageCardCap,
  type AccessFeed, type StorageCardLevel, type StorageFacts, type StorageLimitReason, type StorageOfferFacts,
  type StoragePlanName,
} from "../net/account";
import type { Deck } from "../copy.en";
import { linksOutToBilling, type Distribution } from "../distribution";
import { longDayStamp, monthStamp } from "./day-stamp";

/** The text one letter is taken to hold before the account's own average is measured (the server's default). */
export const DEFAULT_LETTER_BYTES = 25_000;

/** What stands in place of a purchase: the plain line on the store face, the Manage subscription press on a sideload. */
export type StorageManage = "line" | "press";

const decimal = (n: number, locale: string): string =>
  (locale.startsWith("de") ? String(n).replace(".", ",") : String(n));

/** Decimal gigabytes, one place under 100 and whole above: "3.2", "12.5", "15", "3,2" in German. */
export function gigabytes(bytes: number, locale: string): string {
  const gb = bytes / 1_000_000_000;
  return decimal(gb >= 100 ? Math.round(gb) : Math.round(gb * 10) / 10, locale);
}

/** Digits grouped by thousands: "80,000", "80.000" in German. No formatter call (Hermes). */
export function grouped(n: number, locale: string): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, locale.startsWith("de") ? "." : ",");
}

/** An estimated count, rounded as an estimate reads: to the thousand from 10,000, to the hundred from 1,000. */
export function aboutLetters(n: number, locale: string): string {
  const step = n >= 10_000 ? 1_000 : n >= 1_000 ? 100 : 1;
  return grouped(Math.round(n / step) * step, locale);
}

/** The plan's name as sold: the wire's word, capitalised. */
export function planTitle(plan: StoragePlanName): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** A plan with its add-on units, as the card names it: "Plus", "Plus + 10 GB storage". */
export function choiceName(
  deck: Deck, offer: StorageOfferFacts, choice: { plan: StoragePlanName; addonUnits: number }, locale: string,
): string {
  const unit = offer.addon?.unitBytes ?? 0;
  return choice.addonUnits > 0 && unit > 0
    ? deck.storageWithAddon(planTitle(choice.plan), gigabytes(choice.addonUnits * unit, locale))
    : planTitle(choice.plan);
}

/** The share of the cap in use, whole percent, never past 100. */
export function usedPercent(facts: StorageFacts): number {
  return Math.max(0, Math.min(100, Math.floor((facts.usedBytes / facts.limitBytes) * 100)));
}

/** Why the cap is what it is; an older server does not say: a lower plan limit is the trial's until a date holds it. */
function reasonOf(facts: StorageFacts): StorageLimitReason {
  return facts.limitReason ?? (facts.planLimitBytes === null ? "plan" : facts.limitDropsAt === null ? "trial" : "held");
}

/** The used sentence, by why the cap is what it is. A held limit without its date reads as the plan's. */
export function usedSentence(facts: StorageFacts, deck: Deck, locale: string): string {
  const used = gigabytes(facts.usedBytes, locale);
  const limit = gigabytes(facts.limitBytes, locale);
  const reason = reasonOf(facts);
  if (reason === "trial") return deck.storageUsedTrial(used, limit);
  if (reason === "held" && facts.limitDropsAt !== null) {
    return deck.storageUsedHeld(used, limit, longDayStamp(facts.limitDropsAt, locale));
  }
  return deck.storageUsedPlan(used, limit);
}

/** The fitted choice, when the program answered an offer and it is not the plan already held. */
function fitSentence(facts: StorageFacts, deck: Deck, locale: string): string | null {
  const offer = facts.offer;
  if (offer === null) return null;
  const { fit, current } = offer;
  if (fit.plan === current.plan && fit.addonUnits === current.addonUnits) return null;
  const name = choiceName(deck, offer, fit, locale);
  const gb = gigabytes(fit.roomBytes, locale);
  return fit.keepsAll ? deck.storageFitAll(name, gb) : deck.storageFitMost(name, gb);
}

export interface StorageCardSaid {
  level: StorageCardLevel;
  head: string;
  /** Used of the cap, 0 to 1, for the bar. */
  ratio: number;
  /** The numbers, then what happened or will. */
  lines: string[];
  /** The fitted plan, named with its room; no amount. */
  fit: string | null;
  manage: StorageManage;
}

/** The face this build draws: a store copy may not send anybody to a purchase page. */
export function storageManageOf(distribution?: Distribution): StorageManage {
  return (distribution === undefined ? linksOutToBilling() : linksOutToBilling(distribution)) ? "press" : "line";
}

/** From this share of the cap an older server's account is nearly full, as the server decides it now. */
export const STORAGE_NEAR_RATIO = 0.8;

/** Least first: a dismissal at one level hides it and the ones below. */
const LEVELS: readonly StorageCardLevel[] = ["near", "drop", "full"];

/** The level an older server's numbers call for: it sends no card, and the person still needs the notice. */
export function storageLevelOf(f: StorageFacts): StorageCardLevel | null {
  if (f.usedBytes >= f.limitBytes || (f.emptiedForSpace > 0 && f.emptyingNow)) return "full";
  if (f.planLimitBytes !== null && f.usedBytes >= f.planLimitBytes) return "drop";
  if (f.usedBytes >= f.limitBytes * STORAGE_NEAR_RATIO) return "near";
  return null;
}

/**
 * The card the server decided, said; null when none is due or on an unmetered host. An older server
 * decides none: the level comes from its numbers, and `putAway` is this run's dismissal of it.
 */
export function storageCardOf(
  entry: AccessFeed | null, deck: Deck, locale: string, distribution?: Distribution,
  putAway: (level: StorageCardLevel, cap: string) => boolean = () => false,
): StorageCardSaid | null {
  if (entry === null || !entry.answer.metered) return null;
  const facts = entry.answer.storage;
  if (facts === undefined || facts.card === null) return null;
  const level = facts.card ?? storageLevelOf(facts);
  if (level === null) return null;
  const cap = storageCardCap(facts);
  if (facts.card === undefined && LEVELS.slice(LEVELS.indexOf(level)).some((l) => putAway(l, cap))) return null;
  const est = facts.estimate;
  const expected = est === null || est.expectedBytes <= 0 ? null
    : facts.importing ? deck.storageExpectedImporting(gigabytes(est.expectedBytes, locale))
      : est.expectedBytes > facts.limitBytes ? deck.storageExpectedNeeds(gigabytes(est.expectedBytes, locale)) : null;
  const plan = facts.planLimitBytes === null ? null : gigabytes(facts.planLimitBytes, locale);
  const happened = level === "full"
    ? (facts.keptFrom !== null ? deck.storageKeptFrom(monthStamp(facts.keptFrom, locale))
      : facts.emptiedForSpace > 0 ? deck.storageKeptOldest : null)
    : level === "drop" && plan !== null
      ? (facts.limitDropsAt !== null ? deck.storageDropDated(longDayStamp(facts.limitDropsAt, locale), plan) : deck.storageDropUnpaid(plan))
      : null;
  return {
    level,
    head: level === "full" ? deck.storageCardFull
      : level === "drop" ? deck.storageCardDrop(plan ?? gigabytes(facts.limitBytes, locale))
        : deck.storageCardNear(deck.storagePercent(usedPercent(facts))),
    ratio: Math.min(1, facts.usedBytes / facts.limitBytes),
    lines: [[usedSentence(facts, deck, locale), expected].filter((s) => s !== null).join(" "), happened]
      .filter((s): s is string => s !== null),
    fit: fitSentence(facts, deck, locale),
    manage: storageManageOf(distribution),
  };
}

/** One stretch of the Storage screen's bar: a mailbox's share of what is stored. */
export interface StorageBarPart {
  id: string;
  bytes: number;
}

export interface StoragePlanRow {
  name: string;
  room: string;
  /** The fitted choice: it keeps all the mail, or the most any choice keeps. */
  fitted: "all" | "most" | null;
}

export interface StoragePaneSaid {
  figure: string;
  /** "80%" below the cap, "Full" at it, or null well below it. */
  tag: string | null;
  sub: string;
  bar: { scaleBytes: number; parts: StorageBarPart[]; limitBytes: number; expectedBytes: number | null };
  /** Per mailbox: what it stores of what it is expected to need. */
  mailboxes: { id: string; said: string }[];
  /** The estimate, the import's progress, whether it may still grow, the average. */
  estimate: string[];
  kept: string | null;
  /** The plan and its room, with the trial's or a held limit's date; null without an offer to name it. */
  plan: string | null;
  /** The plans with their rooms, the add-on and the fitted choice; empty without an offer. */
  plans: StoragePlanRow[];
  manage: StorageManage;
  mail: boolean | null;
}

/** The Storage screen, said from the access answer's storage block. */
export function storagePaneOf(
  facts: StorageFacts, deck: Deck, locale: string, distribution?: Distribution,
): StoragePaneSaid {
  const est = facts.estimate;
  const pct = usedPercent(facts);
  const avg = est !== null && est.avgLetterBytes > 0 ? est.avgLetterBytes : DEFAULT_LETTER_BYTES;
  const letters = (bytes: number) => aboutLetters(bytes / avg, locale);
  const expectedBytes = est !== null && est.expectedBytes > 0 ? est.expectedBytes : null;
  const offer = facts.offer;
  const current = offer === null ? null : planTitle(offer.current.plan);
  const planGb = facts.planLimitBytes === null ? null : gigabytes(facts.planLimitBytes, locale);
  const limit = gigabytes(facts.limitBytes, locale);
  const plan = facts.limitReason === "trial" && planGb !== null && current !== null
    ? deck.storagePlanTrial(limit, current, planGb)
    : planGb !== null && current !== null && facts.limitDropsAt !== null
      ? deck.storagePlanUntil(limit, longDayStamp(facts.limitDropsAt, locale), current, planGb)
      : current !== null ? deck.storagePlanKeeps(current, gigabytes(offer!.current.roomBytes, locale)) : null;
  const plans: StoragePlanRow[] = offer === null ? [] : [
    ...offer.plans.map((p) => ({
      name: p.plan === offer.current.plan ? deck.storagePlanYours(planTitle(p.plan)) : planTitle(p.plan),
      room: deck.storagePlanRoom(gigabytes(p.roomBytes, locale), letters(p.roomBytes)),
      fitted: null,
    })),
    ...(offer.addon === null ? [] : [{
      name: deck.storageAddon,
      room: deck.storageAddonRoom(gigabytes(offer.addon.unitBytes, locale), letters(offer.addon.unitBytes)),
      fitted: null,
    }]),
    ...(offer.fit.plan === offer.current.plan && offer.fit.addonUnits === offer.current.addonUnits ? [] : [{
      name: choiceName(deck, offer, offer.fit, locale),
      room: deck.storagePlanRoom(gigabytes(offer.fit.roomBytes, locale), letters(offer.fit.roomBytes)),
      fitted: offer.fit.keepsAll ? ("all" as const) : ("most" as const),
    }]),
  ];
  return {
    figure: deck.storageOf(gigabytes(facts.usedBytes, locale), limit),
    tag: facts.card === "full" || facts.usedBytes >= facts.limitBytes ? deck.storageStateFull
      : pct >= 80 ? deck.storagePercent(pct) : null,
    sub: reasonOf(facts) === "trial" ? deck.storageUsedSubTrial
      : reasonOf(facts) === "held" && facts.limitDropsAt !== null ? deck.storageUsedSubHeld(longDayStamp(facts.limitDropsAt, locale))
        : deck.storageUsedSubPlan,
    bar: {
      scaleBytes: Math.max(facts.limitBytes, facts.usedBytes, expectedBytes ?? 0),
      parts: facts.mailboxes.filter((m) => m.usedBytes > 0).map((m) => ({ id: m.id, bytes: m.usedBytes })),
      limitBytes: facts.limitBytes,
      expectedBytes,
    },
    mailboxes: facts.mailboxes.map((m) => ({
      id: m.id,
      said: deck.storageOf(gigabytes(m.usedBytes, locale), gigabytes(Math.max(m.expectedBytes, m.usedBytes), locale)),
    })),
    estimate: est === null || expectedBytes === null ? [] : [
      facts.importing
        ? deck.storageExpectedImport(gigabytes(expectedBytes, locale), aboutLetters(est.expectedLetters, locale))
        : deck.storageExpectedAll(gigabytes(expectedBytes, locale), aboutLetters(est.expectedLetters, locale)),
      ...(facts.importing ? [deck.storageImportRunning(grouped(est.storedLetters, locale), aboutLetters(est.expectedLetters, locale))] : []),
      ...(est.complete ? [] : [deck.storageEstimateGrows]),
      deck.storageAverage(grouped(avg / 1_000, locale)),
    ],
    kept: facts.keptFrom === null ? null : deck.storageKeptFromLong(monthStamp(facts.keptFrom, locale)),
    plan,
    plans,
    manage: storageManageOf(distribution),
    mail: facts.mail,
  };
}

/** The Settings row's value: "3.2 of 4 GB". */
export function storageRowValue(facts: StorageFacts, deck: Deck, locale: string): string {
  return deck.storageOf(gigabytes(facts.usedBytes, locale), gigabytes(facts.limitBytes, locale));
}
