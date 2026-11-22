"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Answer, ManageOutcome, PlanPick, PlansAnswer, Standing, SubscriptionDoor, SubscriptionStatus, SubscriptionWord } from "@ohmail/app/account";
import { NONE } from "@ohmail/app/host";
import {
  account, accessFeedFor, accessAiCredits, accessStorage, apiConfigured, onAccessFeed, type AccountAccess, type AccountLifecycle,
} from "../../api-client";
import { SELF_HOST_BUILD } from "../../hello";
import { dayStamp } from "../../shell/format";
import { formatStorageBytes, formatStoragePrice, type StorageOffer } from "../../shell/storage-state";
import { leaveForManagePage } from "./manage-navigation";

/** A day as the reader says it, by the product's one day formatter; nothing for a day that cannot be read. */
const dayOf = (iso: string | null | undefined): string | null =>
  typeof iso === "string" && Number.isFinite(Date.parse(iso)) ? dayStamp(iso) : null;

const CLOSED: Readonly<Record<NonNullable<AccountLifecycle["closedReason"]>, Extract<Standing, { state: "closed" }>["why"]>> = {
  trial_ended: "trialEnded",
  canceled: "canceled",
  unpaid: "unpaid",
  suspended: "suspended",
};

/** Where the account stands, from the lifecycle the access answer names; `null` from a server that names none. */
export function standingOf(lifecycle: AccountLifecycle | undefined): Standing | null {
  if (lifecycle === undefined) return null;
  switch (lifecycle.state) {
    case "trialing":
      return { state: "trial", ends: dayOf(lifecycle.trialEndsAt) };
    case "grace":
      return { state: "grace", until: dayOf(lifecycle.graceUntil) };
    case "past_due":
      return { state: "overdue", until: dayOf(lifecycle.graceUntil) };
    case "active":
      return { state: "active" };
    case "closed":
    case "erased":
      return { state: "closed", why: lifecycle.closedReason === null ? null : CLOSED[lifecycle.closedReason] };
  }
}

/**
 * THE STANDING AS THE PANE DRAWS IT, from the access answer alone: the lifecycle, how many mailboxes the account may
 * connect (none said where it is unbounded), and what is stored of the limit in the Storage pane's own words. An
 * unmetered answer, or one from a server that names no lifecycle, has no standing to draw.
 */
export function subscriptionStatusOf(
  access: AccountAccess,
  storedOf: (used: string, limit: string) => string,
  locale: string,
): SubscriptionStatus | null {
  if (!access.metered) return null;
  const standing = standingOf(access.lifecycle);
  if (standing === null) return null;
  const storage = accessStorage(access);
  const progress = access.trialProgress;
  const credits = accessAiCredits(access);
  const showsProgress = standing.state === "trial" && progress &&
    Number.isSafeInteger(progress.day) && Number.isSafeInteger(progress.total) &&
    progress.day >= 1 && progress.day <= progress.total;
  return {
    standing,
    ...(showsProgress ? { trialProgress: progress } : {}),
    mailboxes: access.mailboxes,
    ...(credits ? { aiCredits: credits } : {}),
    storage:
      storage === null
        ? null
        : storedOf(formatStorageBytes(storage.usedBytes, locale, true), formatStorageBytes(storage.limitBytes, locale, true)),
  };
}

function plansOf(offer: StorageOffer, locale: string): PlansAnswer {
  const price = (amount: number) => formatStoragePrice(amount, offer.currency, locale);
  return {
    kind: "plans",
    plans: offer.plans.map((line) => ({
      plan: line.plan,
      mailboxes: line.mailboxes,
      storage: formatStorageBytes(line.roomBytes, locale, true),
      price: {
        month: offer.interval === "month" ? price(line.amount) : null,
        year: offer.interval === "year" ? price(line.amount) : null,
      },
    })),
    current: {
      plan: offer.current.plan,
      interval: offer.interval,
      addonUnits: offer.current.addonUnits,
    },
    addon: null,
  };
}

/**
 * THE WEB'S SUBSCRIPTION DOOR. The standing is the access answer this tab already holds for the account the shell
 * hands in (`host.session.scope`), never one read from the browser's jar. The plans come from that answer's storage
 * offer and display amounts for the quoted interval. The press makes the account page's address (`POST /account/manage-link {lang}`, with the plan and
 * the interval it was handed from their closed sets) and leaves for it in this tab with no referrer: the address
 * never leaves this file. No address, an empty one or a 404 is no page here: `withdraw` takes the pane away for the
 * shell, and the press answers `nowhere`. A mint that threw could not open the page.
 */
export function useSubscriptionDoor(scope: string | null, withdraw: () => void): SubscriptionDoor {
  const t = useTranslations("settings");
  const locale = useLocale();
  const lang = locale === "de" ? "de" : "en";
  const entry = useSyncExternalStore(onAccessFeed, () => accessFeedFor(scope), () => null);
  const status = useMemo(() => {
    if (SELF_HOST_BUILD || !apiConfigured() || entry === null) return null;
    return subscriptionStatusOf(entry.answer, (used, limit) => t("storageOf", { used, limit }), locale);
  }, [entry, locale, t]);
  const signal = useMemo(() => ({ read: () => status, subscribe: () => () => {} }), [status]);
  const plans = useMemo(() => {
    if (SELF_HOST_BUILD || !apiConfigured() || entry === null) return NONE;
    const offer = accessStorage(entry.answer)?.offer;
    const answer: PlansAnswer = offer ? plansOf(offer, locale) : { kind: "unanswered" };
    return async (): Promise<Answer<PlansAnswer, SubscriptionWord>> => ({ ok: true, value: answer });
  }, [entry, locale]);
  const manage = useCallback(
    async (pick?: PlanPick): Promise<ManageOutcome> => {
      let url: unknown;
      try {
        url = (await account.manageLink({ lang, ...pick }, scope ?? undefined))?.url;
      } catch {
        return "failed";
      }
      // A URL is a non-empty string or it is nothing: an empty one, none at all and a 404 say the same thing.
      if (typeof url === "string" && url.length > 0) {
        leaveForManagePage(url);
        return "left";
      }
      withdraw();
      return "nowhere";
    },
    [lang, scope, withdraw],
  );
  return useMemo(() => ({ status: signal, plans, manage }), [signal, plans, manage]);
}
