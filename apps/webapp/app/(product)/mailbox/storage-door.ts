"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Answer, StorageDoor, StorageFigures, StoragePlan, StorageWord } from "@ohmail/app/account";
import { ApiError, account, accessFeedFor, accessStorage, apiConfigured, onAccessFeed } from "../../api-client";
import { SELF_HOST_BUILD } from "../../hello";
import { useMailboxFacts } from "@ohmail/app-logic/mail-state/mail-state-binding";
import {
  estimatedEmails, formatStorageBytes, formatStoragePrice, storageDayName, storageFitExtraBytes, storageFitIsChange,
  storageMonthName, storagePercent, storageRefillOf, storageRoomLine, type StorageFacts, type StorageOffer,
} from "../../shell/storage-state";
import { leaveForManagePage } from "./SubscriptionSection";

/** The account's mailboxes as the shell holds them: their names for the table, and whether the refill runs. */
export type StorageRoster = ReadonlyArray<{
  readonly id: string;
  readonly address?: string;
  readonly displayName?: string | null;
  readonly status: string | null;
  readonly initialImportCompletedAt?: string | null;
  readonly hostedImportCompletedAt?: string | null;
}> | null;

/** What the figures are said with: the reader's language, the mailboxes, and an amount of the offer for its interval. */
export interface StorageSaying {
  readonly locale: string;
  readonly roster: StorageRoster;
  readonly price: (amount: number, offer: StorageOffer) => string;
}

/** The plan's sentence, in the three forms the shipped pane chose between (`StoragePane.tsx`). */
function planLine(facts: StorageFacts, size: (bytes: number) => string, locale: string): StorageFigures["plan"] {
  if (facts.limitReason === "trial" && facts.planLimitBytes !== null && facts.limitDropsAt === null) {
    return { kind: "trial", limit: size(facts.limitBytes), cap: size(facts.planLimitBytes) };
  }
  if (facts.planLimitBytes !== null && facts.limitDropsAt !== null) {
    return {
      kind: "until",
      limit: size(facts.limitBytes),
      cap: size(facts.planLimitBytes),
      date: storageDayName(facts.limitDropsAt, locale),
    };
  }
  return { kind: "keeps", limit: size(facts.limitBytes), plan: facts.offer?.current.plan ?? null };
}

/** The bar to scale: whichever is largest of what is used, the limit and what the mail is expected to need. */
function barOf(facts: StorageFacts, size: (bytes: number) => string): StorageFigures["bar"] {
  const expected = facts.estimate?.expectedBytes ?? 0;
  const scale = Math.max(facts.usedBytes, facts.limitBytes, expected, 1);
  const at = (bytes: number) => Math.min(1, bytes / scale);
  // An answer with no per-mailbox figures still draws what is used, as one part.
  const sources = facts.mailboxes.length > 0 ? facts.mailboxes : [{ id: "all", usedBytes: facts.usedBytes }];
  let left = 0;
  const parts = sources.map((m) => {
    const part = { id: m.id, from: at(left), width: at(m.usedBytes) };
    left += m.usedBytes;
    return part;
  });
  const rest = expected > facts.usedBytes ? expected - facts.usedBytes : 0;
  return {
    parts,
    rest:
      rest > 0
        ? {
            kind: facts.emptiedForSpace > 0 && !facts.importing ? "onServer" : "toCome",
            from: at(facts.usedBytes),
            width: at(rest),
          }
        : null,
    limit: { at: at(facts.limitBytes), said: size(facts.limitBytes) },
    plan: facts.planLimitBytes === null ? null : { at: at(facts.planLimitBytes), said: size(facts.planLimitBytes) },
    expected: expected > facts.limitBytes ? { at: at(expected), said: size(expected) } : null,
    scale: size(scale),
  };
}

/** The plans with their room, the fit and the add-on, each amount said for the offer's interval. */
function plansOf(offer: StorageOffer, size: (bytes: number) => string, say: StorageSaying): StorageFigures["plans"] {
  const fitChanges = storageFitIsChange(offer);
  const price = (amount: number) => say.price(amount, offer);
  return {
    lines: offer.plans.map((p): StoragePlan => {
      const fitted = fitChanges && offer.fit.plan === p.plan;
      const extra = fitted ? storageFitExtraBytes(offer) : null;
      return {
        plan: p.plan,
        room: size(p.roomBytes),
        letters: estimatedEmails(p.roomBytes),
        mailboxes: p.mailboxes,
        price: price(p.amount),
        tag: fitted && offer.fit.keepsAll ? "keepsAll" : p.plan === offer.current.plan ? "yours" : null,
        fit:
          extra === null
            ? null
            : { extra: `+${size(extra)}`, room: size(offer.fit.roomBytes), price: price(offer.fit.amount) },
      };
    }),
    addon:
      offer.addon === null
        ? null
        : {
            unit: `+${size(offer.addon.unitBytes)}`,
            letters: estimatedEmails(offer.addon.unitBytes),
            most: offer.addon.maxUnits,
            price: price(offer.addon.amount),
          },
    mayChange: offer.canChange,
  };
}

/**
 * THE STORAGE BLOCK AS THE PANE DRAWS IT: every size, date and amount said in the reader's language with the
 * product's own formatters (`shell/storage-state.ts`), each choice the shipped pane made between its sentences made
 * the same way. Pure: the same block, mailboxes and language give the same figures.
 */
export function storageFiguresOf(facts: StorageFacts, say: StorageSaying): StorageFigures {
  const { locale, roster } = say;
  const size = (bytes: number) => formatStorageBytes(bytes, locale, true);
  const number = new Intl.NumberFormat(locale);
  const estimate = facts.estimate;
  const expected = estimate?.expectedBytes ?? 0;
  const full = facts.card === "full" || facts.usedBytes >= facts.limitBytes;
  const percent = storagePercent(facts);
  const mailboxOf = (id: string): string =>
    roster?.find((m) => m.id === id)?.address ?? roster?.find((m) => m.id === id)?.displayName ?? id;
  const room = storageRoomLine(facts, locale);
  return {
    used: size(facts.usedBytes),
    limit: size(facts.limitBytes),
    room:
      room.key === "storageRoomHeld"
        ? { kind: "held", limit: room.values.limit, until: room.values.date }
        : { kind: room.key === "storageRoomTrial" ? "trial" : "plan", limit: room.values.limit },
    tag: full ? { kind: "full" } : percent >= 80 ? { kind: "percent", percent } : null,
    bar: barOf(facts, size),
    rows: facts.mailboxes.map((m) => ({
      id: m.id,
      mailbox: mailboxOf(m.id),
      letters: number.format(m.expectedLetters),
      kept: size(m.usedBytes),
      expected: size(m.expectedBytes),
    })),
    total:
      facts.mailboxes.length > 0 && estimate !== null
        ? {
            letters: number.format(estimate.expectedLetters),
            kept: size(facts.usedBytes),
            expected: size(estimate.expectedBytes),
          }
        : null,
    needs:
      estimate === null
        ? null
        : {
            importing: facts.importing ? { stored: estimate.storedLetters } : null,
            letters: estimate.expectedLetters,
            size: size(expected),
            average: { size: size(estimate.avgLetterBytes), measured: estimate.avgMeasured },
            complete: estimate.complete,
          },
    kept:
      facts.emptiedForSpace === 0
        ? null
        : facts.keptFrom !== null
          ? { kind: "from", month: storageMonthName(facts.keptFrom, locale), refills: storageRefillOf(roster) === "runs" }
          : { kind: "some", count: facts.emptiedForSpace, refills: storageRefillOf(roster) === "runs" },
    plan: planLine(facts, size, locale),
    plans: facts.offer === null ? null : plansOf(facts.offer, size, say),
    mail: facts.mail,
  };
}

/** The change's answer from the server's: an address leaves; none, or any refusal but the two read here, is "failed". */
async function changeOver(lang: "de" | "en"): Promise<Answer<"left", StorageWord>> {
  try {
    const url = (await account.manageLinkChange({ lang }))?.url;
    if (typeof url === "string" && url.length > 0) {
      leaveForManagePage(url);
      return { ok: true, value: "left" };
    }
    return { ok: false, word: "failed" };
  } catch (err) {
    const code = err instanceof ApiError && err.status === 403 ? err.code : null;
    // Every `step_up_required` asks the factor: the group's machine says a second one as the refusal it is.
    if (code === "step_up_required") return { ok: false, word: "factor" };
    return { ok: false, word: code === "email_unverified" ? "unverified" : "failed" };
  }
}

/**
 * THE WEB'S STORAGE DOOR. The figures are the access answer this tab already holds for the account the shell hands
 * in (`host.session.scope`), never one read from the browser's jar, and nothing is asked to draw them. The switch
 * writes `PATCH /account/storage {mail}` and, once taken, asks the access answer fresh. The change mints the page
 * that may change the plan (`POST /account/manage-link/change {lang}`) and leaves for it in this tab with no
 * referrer: the address never leaves this file.
 */
export function useStorageDoor(scope: string | null): StorageDoor {
  const t = useTranslations("settings");
  const locale = useLocale();
  const lang = locale === "de" ? "de" : "en";
  const roster = useMailboxFacts();
  const entry = useSyncExternalStore(onAccessFeed, () => accessFeedFor(scope), () => null);
  const facts = useMemo(
    () => (SELF_HOST_BUILD || !apiConfigured() ? null : accessStorage(entry?.answer)),
    [entry],
  );
  const figures = useMemo(() => {
    if (facts === null) return null;
    const price = (amount: number, offer: StorageOffer) =>
      t(offer.interval === "year" ? "storagePriceYear" : "storagePriceMonth", {
        price: formatStoragePrice(amount, offer.currency, locale),
      });
    return storageFiguresOf(facts, { locale, roster, price });
  }, [facts, locale, roster, t]);
  const signal = useMemo(() => ({ read: () => figures, subscribe: () => () => {} }), [figures]);
  const setMail = useCallback(async (on: boolean): Promise<boolean> => {
    try {
      await account.storage({ mail: on });
    } catch {
      return false;
    }
    void account.access({ fresh: true }).catch(() => {
      /* the switch holds what was written */
    });
    return true;
  }, []);
  const change = useCallback(() => changeOver(lang), [lang]);
  return useMemo(() => ({ figures: signal, setMail, change }), [signal, setMail, change]);
}
