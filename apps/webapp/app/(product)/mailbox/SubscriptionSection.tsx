"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { SettingsRow, SettingsSection } from "@ohmail/ui";
import { account, accessFeedFor, apiConfigured, onAccessFeed } from "../../api-client";
import { SELF_HOST_BUILD } from "../../hello";
import { readOwner } from "../../shell/owner-cookie";

/**
 * The subscription pane — one control, and nothing else. Whoever operates this service holds the plan,
 * the balance and the payment method; this app holds none of them and states none of them. What it can
 * do is take the customer to the page that does. THE ADDRESS IS MINTED BY THE PRESS: it used to be
 * minted by the MOUNT, so every shell mount and every settings visit minted a link for an account that
 * was only reading its mail. {@link useManageOffer} answers whether to offer the pane; the address is
 * asked for here, when somebody asks to go there. `settings` keys and not a namespace of its own,
 * because whole namespaces travel into the desktop binary and `DesktopSubscription` reads the same two.
 */
export function SubscriptionSection({ onNowhere }: { onNowhere: () => void }) {
  const t = useTranslations("settings");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  /** The pane can be left mid-press; nothing may set state after that. */
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const press = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    try {
      const link = await account.manageLink();
      const url = link?.url;
      // A URL is a non-empty STRING or it is nothing. `{ url: "" }`, a 200 with no `url` at all
      // and the `null` of a 404 say the same thing — there is no page — and the answer to that is
      // to take the pane away, never to leave a control standing that goes nowhere.
      if (typeof url === "string" && url.length > 0) { leaveForManagePage(url); return; }
      onNowhere();
    } catch {
      // A refused mint — an unverified address, a server that did not answer. On a MOUNT that was
      // nothing a person could act on and was swallowed; on a PRESS it is the one thing they are
      // owed, because they asked and something has to be said.
      if (alive.current) setFailed(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [onNowhere]);

  return (
    <SettingsSection>
      {failed ? <p className="acct-warn" role="alert">{t("subscriptionManageFailed")}</p> : null}
      <SettingsRow
        label={t("subscription")}
        control={
          /* A BUTTON, not the anchor this row used to be: there is no address until the press has
             been answered, and an anchor with nowhere to point is the control this pane exists to
             avoid. */
          <button type="button" className="btn" disabled={busy} onClick={() => { void press(); }}>
            {t("subscriptionManage")}
          </button>
        }
      />
    </SettingsSection>
  );
}

/**
 * Leave for the address the mint answered.
 *
 * SAME TAB, where the old anchor opened a new one: a mint is a round trip, and `window.open`
 * after it is what a popup blocker eats — silently, which is the outcome this pane may not have.
 * A detached anchor and not `location.assign` so the referrer stays off: `rel="noreferrer"` is the
 * only way to say it for a scripted navigation, and the address is minted for one account.
 */
export function leaveForManagePage(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * DOES THIS DEPLOYMENT OPERATE A SUBSCRIPTION PAGE FOR THIS ACCOUNT — the offer, not the address.
 * It FOLLOWS THE ACCESS FEED (`api-client.ts`): every answer this tab receives, whoever asked, so
 * a read that failed at mount is healed by the next one — the account strip asks on every return
 * to the tab — and a failed read, which publishes nothing, can never take the pane away. `false`
 * for a self-hosted or unmetered install, a demo, and before the first answer: DO NOT OFFER THE
 * PANE, since the alternative is a nav entry above an empty pane. `withdraw` is the press's other
 * outcome: a mint with nowhere to go takes the pane with it for this mount.
 */
export function useManageOffer(demo: boolean): { manageOffered: boolean; withdrawManage: () => void } {
  const entry = useSyncExternalStore(onAccessFeed, () => accessFeedFor(readOwner()), () => null);
  const [asking, setAsking] = useState(false);
  const [withdrawn, setWithdrawn] = useState(false);
  useEffect(() => {
    // The landing page's mailbox reaches no server and has no account to ask about.
    // SELF_HOST_BUILD: `metered` stopped meaning "subscription page exists" the day the
    // self-host table declared its explicit mailbox allowance (`routes/self-host.ts`) —
    // `accessFor` answers non-null there, so this read would offer a Manage control on a
    // box with nothing to manage. Billing UI never reaches a self-host surface;
    // compiled away on managed builds like every other SELF_HOST_BUILD branch.
    if (SELF_HOST_BUILD || demo || !apiConfigured()) return;
    setAsking(true);
    // The first paint joins the shell's own read, or asks it; the feed carries the answer here.
    void account.access().catch(() => { /* no answer is no offer; the next one brings it */ });
    return () => { setAsking(false); };
  }, [demo]);
  const withdrawManage = useCallback(() => { setWithdrawn(true); }, []);
  return { manageOffered: asking && entry !== null && entry.answer.metered && !withdrawn, withdrawManage };
}
