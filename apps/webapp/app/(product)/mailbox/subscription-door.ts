"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ManageOutcome, PlanPick, Standing, SubscriptionDoor, SubscriptionStatus } from "@ohmail/app/account";
import { NONE } from "@ohmail/app/host";
import {
  account, accessFeedFor, accessStorage, apiConfigured, onAccessFeed, type AccountAccess, type AccountLifecycle,
} from "../../api-client";
import { SELF_HOST_BUILD } from "../../hello";
import { dayStamp } from "../../shell/format";
import { formatStorageBytes } from "../../shell/storage-state";
import { leaveForManagePage } from "./SubscriptionSection";

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
  return {
    standing,
    mailboxes: access.mailboxes,
    storage:
      storage === null
        ? null
        : storedOf(formatStorageBytes(storage.usedBytes, locale, true), formatStorageBytes(storage.limitBytes, locale, true)),
  };
}

/**
 * THE WEB'S SUBSCRIPTION DOOR. The standing is the access answer this tab already holds for the account the shell
 * hands in (`host.session.scope`), never one read from the browser's jar, and nothing is asked to draw it. The plans'
 * read is not served yet (`GET /account/plans` is not on this line): this door has none, so no price is asked and
 * none is drawn. The press makes the account page's address (`POST /account/manage-link {lang}`, with the plan and
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
  const manage = useCallback(
    async (pick?: PlanPick): Promise<ManageOutcome> => {
      let url: unknown;
      try {
        url = (await account.manageLink({ lang, ...pick }))?.url;
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
    [lang, withdraw],
  );
  return useMemo(() => ({ status: signal, plans: NONE, manage }), [signal, manage]);
}
