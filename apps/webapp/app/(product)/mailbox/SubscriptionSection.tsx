"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SettingsRow, SettingsSection } from "@ohmail/ui";
import { account, apiConfigured } from "../../api-client";

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
      if (typeof url === "string" && url.length > 0) { leaveFor(url); return; }
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
function leaveFor(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * DOES THIS DEPLOYMENT OPERATE A SUBSCRIPTION PAGE FOR THIS ACCOUNT — the offer, not the address.
 * `false` for a self-hosted or unmetered install, for a demo, and for the moment before the first
 * answer: all mean DO NOT OFFER THE PANE, and collapsing them is deliberate, since the alternative is a
 * nav entry above an empty pane. Read from `GET /account/access`, which mints nothing — `metered: false`
 * is a host running no such program, exactly what the mint route answers 404 on. `/hello` cannot be
 * asked instead: its wire shape is frozen and says nothing about this. `withdraw` is the press's other
 * outcome — a mint that came back with nowhere to go takes the pane with it for the session.
 */
export function useManageOffer(demo: boolean): { manageOffered: boolean; withdrawManage: () => void } {
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    // The landing page's mailbox reaches no server and has no account to ask about.
    if (demo || !apiConfigured()) return;
    let alive = true;
    void account.access()
      .then((a) => { if (alive) setOffered(a.metered); })
      // A read that failed is not evidence a page exists, and a settings pane is not where
      // somebody acts on it.
      .catch(() => { /* nowhere to send them */ });
    return () => { alive = false; };
  }, [demo]);
  const withdrawManage = useCallback(() => { setOffered(false); }, []);
  return { manageOffered: offered, withdrawManage };
}
