/**
 * THE LOCK SCREEN IN THE WINDOW — what an account the service has refused sees instead of its mail.
 *
 * The browser tab's `AccessLock.tsx`, mirrored and not imported (that file signs out through
 * `app/sign-out.ts`, aliased here to the refusing api-client stub): the same `accessLock` sentences,
 * this window's chrome and door. Two doors stay open, because a lock with no way out is a trap:
 * signing out, and the way back, which MINTS AT THE PRESS — the 402's `manageUrl` only says a page
 * exists. It lifts on the account's fresh `access: "open"` read (`useWallLift`) and on nothing
 * else, and deletes and wipes nothing itself.
 */

import { useCallback, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button, Spinner } from "@ohmail/ui";

import {
  ACCOUNT_ACCESS_PATH, bridgeFetch, engineLogout,
  type AccessRefusedFacts, type AccountLifecycle, type EngineStatus, type SignOutPress,
} from "./bridge-fetch.js";
import { useWallLift } from "../../webapp/app/shell/wall-lift.js";
import { linksOutToBilling } from "./distribution.js";
import { MANAGE_LINK_PATH, leaveForAccountPage } from "./DesktopSubscription.js";
import { dayStamp } from "../../webapp/app/shell/format.js";
import { DOOR_COPY } from "./door-copy.js";

/**
 * What the headline says, and the date it carries — the browser tab's rule, mirrored.
 *
 * ERASED IS NOT A SCREEN: erasure deletes the users, the sessions and the credentials, so nobody
 * signs in to read an "erased on" sentence. A closure with no date falls to the sentence that has
 * never claimed one rather than to a guess from this machine's clock.
 */
function headlineOf(
  lifecycle: AccountLifecycle | undefined,
  suspended: boolean,
): { key: "title" | "suspendedTitle" | "trialEnded" | "canceled" | "unpaid"; date?: string } {
  const plain = { key: (suspended ? "suspendedTitle" : "title") as "title" | "suspendedTitle" };
  if (lifecycle === undefined || lifecycle.state !== "closed") return plain;
  if (lifecycle.closedReason === "suspended") return { key: "suspendedTitle" };
  const date = lifecycle.closedAt;
  if (date === null || date === undefined) return plain;
  if (lifecycle.closedReason === "trial_ended") return { key: "trialEnded", date };
  if (lifecycle.closedReason === "canceled") return { key: "canceled", date };
  if (lifecycle.closedReason === "unpaid") return { key: "unpaid", date };
  return plain;
}

/** One fresh read of the account through the door: `true` only for its own `access: "open"`. */
async function accountOpens(): Promise<boolean> {
  const res = await bridgeFetch(ACCOUNT_ACCESS_PATH);
  if (!res.ok) return false;
  const body = (await res.json().catch(() => null)) as { metered?: unknown; access?: unknown } | null;
  return body?.metered === true && body.access === "open";
}

export function DesktopAccessLock(
  { facts, press = null, onSignedOut, onLifted }: {
    facts: AccessRefusedFacts;
    /** The door and session the gate reads, so the sign-out can end that session at its server. */
    press?: SignOutPress | null;
    onSignedOut: (status: EngineStatus, stillListedFrom?: EngineStatus | null) => void;
    onLifted?: () => void;
  },
) {
  const t = useTranslations("accessLock");
  const { check, armPoll, checkAgain } = useWallLift({ lifts: accountOpens, onLifted, owner: null });
  const [signingOut, setSigningOut] = useState(false);
  /** The shell's reason when the last sign-out was refused, said under the button. */
  const [signOutRefused, setSignOutRefused] = useState<string | null>(null);
  const lang = useLocale() === "de" ? "de" : "en";
  const [minting, setMinting] = useState(false);
  const [mintRefusal, setMintRefusal] = useState<"failed" | "unverified" | null>(null);

  const doMint = useCallback(async () => {
    if (minting) return;
    setMintRefusal(null);
    setMinting(true);
    try {
      const res = await bridgeFetch(MANAGE_LINK_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lang }),
      });
      const body = (await res.json().catch(() => null)) as
        { url?: unknown; error?: { code?: unknown } } | null;
      if (res.ok && typeof body?.url === "string" && body.url.length > 0) {
        armPoll();
        leaveForAccountPage(body.url);
        return;
      }
      setMintRefusal(res.status === 403 && body?.error?.code === "email_unverified" ? "unverified" : "failed");
    } catch {
      setMintRefusal("failed");
    } finally {
      setMinting(false);
    }
  }, [armPoll, lang, minting]);

  const doSignOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutRefused(null);
    try {
      /* The gate hears the new engine state and leaves this screen; nothing here navigates. */
      const out = await engineLogout(press);
      onSignedOut(out.status, out.stillListedFrom);
    } catch (err) {
      /* A refusal leaves the session live and the button available again, and says so. */
      setSignOutRefused(err instanceof Error ? err.message : String(err));
      setSigningOut(false);
    }
  }, [onSignedOut, press, signingOut]);

  const lifecycle = facts.lifecycle;
  const headline = headlineOf(lifecycle, facts.reason === "suspended");
  const erasureAt = lifecycle?.erasureAt ?? null;
  const held = lifecycle !== undefined && lifecycle.closedReason === "suspended";
  /* THE STORE BUILD LINKS OUT TO NOTHING (App Review 3.1.1), so it loses the button and gains the
     one sentence that replaces it: where to go instead. A screen that simply dropped its only
     control would leave a person with nowhere, which is the trap this lock may never be. */
  const mayLinkOut = linksOutToBilling();

  return (
    <div className="gate">
      <div className="gate-card">
        <span className="wordmark"><b>ohmail</b><em>.</em></span>
        <h1>
          {headline.date !== undefined
            ? t(headline.key, { date: dayStamp(headline.date) })
            : t(headline.key)}
        </h1>
        {/* A server that says nothing about the lifecycle gets the sentence this window has always
            shown. With one, the window says the thing that matters on a machine holding a copy of
            somebody's mail: the mailbox is untouched, and here is when the rest goes. */}
        {lifecycle !== undefined
          ? (
            <>
              {/* The one sentence a person has to believe wears the browser wall's own emphasis
                  (`.gate-card .wall-master`, full ink) and the erasure clock its quiet
                  (`.wall-fine`, ink3) — same stylesheet, same three-level hierarchy, so the
                  window and the tab weigh the promise identically. */}
              <p className="wall-master">{t("mailboxUntouched")}</p>
              <p className="wall-fine">
                {held
                  ? t("erasureHeld")
                  : erasureAt !== null
                    ? t("erasure", { date: dayStamp(erasureAt) })
                    : t("erasureUnknown")}
              </p>
            </>
          )
          : <p>{t("kept")}</p>}
        {facts.manageUrl && !mayLinkOut ? <p>{t("openInBrowser")}</p> : null}
        {check === "checking"
          ? (
            <div className="wall-check" role="status" aria-busy="true">
              <Spinner className="mbx-spin" />
              <span>{t("checking")}</span>
            </div>
          )
          : null}
        {check === "pending" ? <p className="wall-note" role="status">{t("pending")}</p> : null}
        {mintRefusal !== null
          ? <p className="wall-warn" role="alert">{t(mintRefusal === "unverified" ? "mintUnverified" : "mintFailed")}</p>
          : null}
        <div className="gate-actions">
          {check === "pending" ? <Button onClick={checkAgain}>{t("checkAgain")}</Button> : null}
          {/* Rendered ONLY where the service operates a page — this app holds no plan, no balance
              and no page of its own. The minted address leaves by an anchor click, so the window's
              link interceptor hands it to the browser where the person is already signed in. */}
          {facts.manageUrl && mayLinkOut && check !== "checking"
            ? (
              <Button
                variant="primary"
                data-run={minting ? "working" : undefined}
                aria-busy={minting || undefined}
                onClick={() => { void doMint(); }}
              >
                {lifecycle !== undefined ? t("openAccount") : t("manage")}
              </Button>
            )
            : null}
          <Button onClick={() => { void doSignOut(); }} disabled={signingOut}>
            {t("signOut")}
          </Button>
        </div>
        {signOutRefused !== null
          ? <p className="wall-warn" role="alert">{DOOR_COPY.accessLockSignOutRefused(signOutRefused)}</p>
          : null}
      </div>
    </div>
  );
}
