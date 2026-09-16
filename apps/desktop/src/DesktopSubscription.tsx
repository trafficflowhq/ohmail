/**
 * THE SUBSCRIPTION PANE ON THE CLOUD DOOR — the same one row the browser tab shows. This window used to
 * render the plan, the renewal date, a storage meter and a managed-AI switch; none of that is this
 * program's business, and the entitlements port answers where the operator's own page is. A pane and not
 * an omission, for `DesktopWebSection`'s reason: an absent entry reads as "this product does not have
 * that". Absent when there is no page to link to — see {@link useDesktopManageOffer} for why that
 * decision is the GATE's. THE ADDRESS IS MINTED BY THE PRESS: it used to be minted by the MOUNT, so
 * every launch asked for a link nobody had asked to follow. The offer is read without minting; the
 * address is asked for on the press.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SettingsRow, SettingsSection } from "@ohmail/ui";

import { ACCESS_REFUSED_STATUS, ACCOUNT_ACCESS_PATH, bridgeFetch } from "./bridge-fetch.js";

/**
 * The hosted route this pane addresses, root-relative like every path in this window.
 *
 * Exported for the reason the pane it replaces exported its own: the engine must FORWARD it on
 * this door rather than answer it from the mirror, which knows nothing about an account's
 * standing. `desktop-settings-census.test.ts` reads it.
 */
export const MANAGE_LINK_PATH = "/account/manage-link";

/**
 * The read the OFFER is made of — forwarded on the same door, and it mints nothing.
 *
 * `metered: false` is a host that operates no such program, which is exactly the condition
 * {@link MANAGE_LINK_PATH} answers 404 on. Nothing this window already holds answers it: the
 * status frame carries the door's KIND (`flavor`), and a server somebody runs themselves can
 * operate a program while a managed door whose program is absent answers `metered: false`; the
 * engine's own `/health` is about the session; `/hello`'s wire shape is frozen. DEFINED ON THE
 * DOOR and re-exported here — the suggest transport asks it too, and one route spelled twice drifts.
 */
export { ACCOUNT_ACCESS_PATH };

/** What the entitlements lock answers a refused account. See {@link useDesktopManageOffer}. */
const ACCESS_REFUSED = ACCESS_REFUSED_STATUS;

/** What the mint answers where no such page is served, or for an account nobody knows. */
const NO_MANAGE_SURFACE = 404;

export interface ManageOffer {
  /** Whether to build the pane at all — the GATE reads this and hands in the node. */
  manageOffered: boolean;
  /** Take the pane away for the rest of this session: the press found nowhere to go. */
  withdrawManage: () => void;
}

/**
 * DOES THIS ACCOUNT'S DOOR SERVE A SUBSCRIPTION PAGE — the offer, not the address, and A HOOK THE GATE
 * CALLS rather than a `return null` inside the pane: `SettingsView` grows the nav entry from the PROP
 * being present, so a node that renders nothing still puts "Subscription" in the nav above an empty
 * pane. Only withholding the node withholds the entry, which is `invitesSection`'s rule, and the desktop
 * census asserts the entry is gone where no page is served. `false` covers every "nowhere": no hosted
 * account, an offline install, a server without the route, a refused read, the moment before the first
 * answer. A 402 is the one non-2xx meaning YES — a program exists and refused this account, and the mint
 * is the route the lock leaves open.
 */
export function useDesktopManageOffer(accountDoor: boolean): ManageOffer {
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    /* NO ACCOUNT DOOR, NO ASK. A standalone install and one paired to another computer have no
       hosted account and no server holding this state, so asking would put a route on the wire
       that nothing behind this door serves. Any offer an earlier door made goes with it. */
    if (!accountDoor) {
      setOffered(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await bridgeFetch(ACCOUNT_ACCESS_PATH);
        if (cancelled) return;
        if (res.status === ACCESS_REFUSED) {
          setOffered(true);
          return;
        }
        if (!res.ok) return;
        const body = (await res.json()) as { metered?: unknown };
        if (!cancelled) setOffered(body.metered === true);
      } catch {
        /* A read that failed is not evidence a page exists, and settings is not where somebody
           acts on it. */
      }
    })();
    return () => { cancelled = true; };
  }, [accountDoor]);
  const withdrawManage = useCallback(() => { setOffered(false); }, []);
  return { manageOffered: offered, withdrawManage };
}

/**
 * Leave for the address the mint answered — the same exit the anchor this replaces had.
 *
 * An anchor IN the document and clicked, not `window.open` and not a navigation: the desktop's
 * link interceptor is one capture-phase listener on the document, and it hands an http address
 * to the platform's opener — the browser where the person is already signed in. The attributes
 * are the ones the rendered anchor carried, so the build without that interceptor (the preview,
 * which is granted no command) does what it did before: nothing, rather than taking the app's
 * own window to a page it cannot come back from.
 */
function leaveFor(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function DesktopSubscription({ onNowhere }: { onNowhere: () => void }) {
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
      const res = await bridgeFetch(MANAGE_LINK_PATH, { method: "POST" });
      // A 404 is the one refusal that is an ANSWER: there is no such page, so the pane goes.
      // Everything else — the proxy's offline 503, a server that broke, a refused mint — is a
      // sentence, because the page may well exist and the person asked for it.
      if (!res.ok) {
        if (!alive.current) return;
        if (res.status === NO_MANAGE_SURFACE) onNowhere();
        else setFailed(true);
        return;
      }
      const body = (await res.json()) as { url?: unknown };
      // A URL is a non-empty STRING or it is nothing, and nothing is the 404 by another route.
      if (typeof body.url === "string" && body.url.length > 0) { leaveFor(body.url); return; }
      if (alive.current) onNowhere();
    } catch {
      // On a MOUNT this was nothing a person could act on and was swallowed; on a PRESS it is
      // the one thing they are owed, because they asked and something has to be said.
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
          /* A BUTTON, not the anchor this row used to be: there is no address until the press
             has been answered, and an anchor with nowhere to point is the control this pane
             exists to avoid. `leaveFor` makes the anchor once there is somewhere to go. */
          <button type="button" className="btn" disabled={busy} onClick={() => { void press(); }}>
            {t("subscriptionManage")}
          </button>
        }
      />
    </SettingsSection>
  );
}
