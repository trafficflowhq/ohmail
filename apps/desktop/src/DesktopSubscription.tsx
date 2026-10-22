/**
 * THE SUBSCRIPTION PANE ON THE CLOUD DOOR — the same one row the browser tab shows. This window used to
 * render the plan, the renewal date, a storage meter and a managed-AI switch; none of that is this
 * program's business, and the entitlements port answers where the operator's own page is. A pane and not
 * an omission, for `DesktopWebSection`'s reason: an absent entry reads as "this product does not have
 * that". Absent when there is no page to link to — see {@link useDesktopManageOffer} for why that
 * decision is the GATE's. THE ADDRESS IS MINTED BY THE PRESS: it used to be minted by the MOUNT, so
 * every launch asked for a link nobody had asked to follow. The offer is read without minting; the
 * address is asked for on the press, and drawn as a link the person's own click opens.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslations } from "next-intl";
import { SettingsRow, SettingsSection } from "@ohmail/ui";

import { ACCESS_REFUSED_STATUS, ACCOUNT_ACCESS_PATH, bridgeFetch } from "./bridge-fetch.js";
import { useAccessSchedule } from "../../webapp/app/shell/wall-lift.js";
import { linkHref, useRenderedLinks } from "../../webapp/app/shell/rendered-links";

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

/** What the offer knows: nothing yet (a failed read leaves it here), or an answer's verdict. */
type OfferState = "unknown" | "offered" | "not-offered";

/**
 * DOES THIS ACCOUNT'S DOOR SERVE A SUBSCRIPTION PAGE — the offer, not the address, and A HOOK THE GATE
 * CALLS rather than a `return null` inside the pane: `SettingsView` grows the nav entry from the PROP
 * being present, so a node that renders nothing still puts "Subscription" in the nav above an empty
 * pane. Any ANSWER settles it — `metered`, a 402 (a program that refused this account, whose way back
 * the lock leaves open), `metered:false`, no hosted account — and only a FAILED read leaves it unknown,
 * which is the one state the next return to the window asks again in, through the shell's own schedule.
 */
export function useDesktopManageOffer(accountDoor: boolean): ManageOffer {
  const [state, setState] = useState<OfferState>("unknown");
  /** The account door an answer belongs to: one for an earlier door is dropped. */
  const door = useRef(0);
  const flight = useRef<Promise<boolean> | null>(null);
  const readOffer = useCallback((): Promise<boolean> => {
    // One read at a time: the mount's and a return's join, so a return inside it asks nothing more.
    if (flight.current !== null) return flight.current;
    const asked = door.current;
    const read = (async (): Promise<boolean> => {
      let next: OfferState | null = null;
      try {
        const res = await bridgeFetch(ACCOUNT_ACCESS_PATH);
        if (res.status === ACCESS_REFUSED) next = "offered";
        else if (res.ok) next = ((await res.json()) as { metered?: unknown }).metered === true ? "offered" : "not-offered";
      } catch { /* no answer: still unknown */ }
      if (next === null || asked !== door.current) return false;
      setState(next);
      return true;
    })().finally(() => { if (flight.current === read) flight.current = null; });
    flight.current = read;
    return read;
  }, []);
  useEffect(() => {
    door.current += 1;
    flight.current = null;
    /* NO ACCOUNT DOOR, NO ASK. A standalone install and one paired to another computer have no
       hosted account and no server holding this state, so asking would put a route on the wire
       that nothing behind this door serves. Any offer an earlier door made goes with it. */
    if (!accountDoor) {
      setState("not-offered");
      return;
    }
    setState("unknown");
    void readOffer();
  }, [accountDoor, readOffer]);
  // A return to the window asks while, and only while, no answer has come; never on a clock.
  useAccessSchedule({ read: accountDoor && state === "unknown" ? readOffer : undefined, minute: null, owner: null });
  const withdrawManage = useCallback(() => { setState("not-offered"); }, []);
  return { manageOffered: state === "offered", withdrawManage };
}

/** Nothing drawn yet. */
const NO_LINKS: readonly string[] = [];

/**
 * THE MINTED ACCOUNT PAGE, AS A LINK THE PERSON PRESSES. The shell opens a link only on the
 * person's own click or key press, and the mint answers after a round trip to the engine, past the
 * second or so WebKit still counts a press: so the press draws the address ({@link AccountPageLink})
 * and the person's click or Enter on it is the open. It stays reported until the next mint or the
 * unmount, so the click the shell judges finds it; followed, the control that mints comes back.
 */
export interface MintedPage {
  /** The address drawn as a link, or null: nothing minted, or already followed. */
  href: string | null;
  /** Keep the address a mint answered and draw it; `false` when it is no http(s) address. */
  show: (url: string) => boolean;
  /** The person followed the drawn link. */
  followed: () => void;
}

export function useMintedPage(): MintedPage {
  const [minted, setMinted] = useState<{ href: string; drawn: boolean } | null>(null);
  useRenderedLinks(minted === null ? NO_LINKS : [minted.href]);
  const show = useCallback((url: string): boolean => {
    const href = linkHref(url);
    if (href === null) return false;
    setMinted({ href, drawn: true });
    return true;
  }, []);
  const followed = useCallback(() => {
    setMinted((was) => (was === null ? was : { href: was.href, drawn: false }));
  }, []);
  return { href: minted !== null && minted.drawn ? minted.href : null, show, followed };
}

/** The minted page, drawn: a `_blank` link with the focus, so Enter opens it as a click does. */
export function AccountPageLink(
  { href, label, onFollow }: { href: string; label: string; onFollow: () => void },
): ReactElement {
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => { link.current?.focus(); }, [href]);
  return (
    <a ref={link} className="btn primary" href={href} target="_blank" rel="noopener noreferrer" onClick={onFollow}>
      {label}
    </a>
  );
}

export function DesktopSubscription({ onNowhere }: { onNowhere: () => void }) {
  const t = useTranslations("settings");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const { href, show, followed } = useMintedPage();
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
      if (typeof body.url === "string" && body.url.length > 0) {
        if (alive.current && !show(body.url)) setFailed(true);
        return;
      }
      if (alive.current) onNowhere();
    } catch {
      // On a MOUNT this was nothing a person could act on and was swallowed; on a PRESS it is
      // the one thing they are owed, because they asked and something has to be said.
      if (alive.current) setFailed(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [onNowhere, show]);

  return (
    <SettingsSection>
      {failed ? <p className="acct-warn" role="alert">{t("subscriptionManageFailed")}</p> : null}
      <SettingsRow
        label={t("subscription")}
        control={
          /* A BUTTON until there is an address: an anchor with nowhere to point is the control
             this pane exists to avoid. The answered press draws the address as the link. */
          href !== null
            ? <AccountPageLink href={href} label={t("subscriptionOpen")} onFollow={followed} />
            : (
              <button type="button" className="btn" disabled={busy} onClick={() => { void press(); }}>
                {t("subscriptionManage")}
              </button>
            )
        }
      />
    </SettingsSection>
  );
}
