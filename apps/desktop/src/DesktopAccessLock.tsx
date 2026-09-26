/**
 * THE LOCK SCREEN IN THE WINDOW — what an account the service has refused sees instead of its mail.
 *
 * The browser tab's `AccessLock.tsx`, mirrored the way `DesktopSubscription` mirrors the
 * Subscription pane: the same `accessLock` sentences, this window's own chrome and door. A mirror
 * and NOT an import — that file signs out through `app/sign-out.ts`, which this build aliases to
 * the refusing api-client stub, so the one control on the screen would throw. Two doors stay open
 * because a lock with no way out is a trap: signing out (this may be a shared machine) and the way
 * back, where the service supplied one. It deletes and wipes nothing itself. The way back MINTS AT
 * THE PRESS through the door's own route; the 402's `manageUrl` only says a page exists.
 */

import { useCallback, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";

import {
  bridgeFetch, engineLogout, type AccessRefusedFacts, type AccountLifecycle, type EngineStatus,
} from "./bridge-fetch.js";
import { linksOutToBilling } from "./distribution.js";
import { MANAGE_LINK_PATH, leaveForAccountPage } from "./DesktopSubscription.js";
import { dayStamp } from "../../webapp/app/shell/format.js";

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

export function DesktopAccessLock(
  { facts, onSignedOut }: { facts: AccessRefusedFacts; onSignedOut: (status: EngineStatus) => void },
) {
  const t = useTranslations("accessLock");
  const [signingOut, setSigningOut] = useState(false);
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
        leaveForAccountPage(body.url);
        return;
      }
      setMintRefusal(res.status === 403 && body?.error?.code === "email_unverified" ? "unverified" : "failed");
    } catch {
      setMintRefusal("failed");
    } finally {
      setMinting(false);
    }
  }, [lang, minting]);

  const doSignOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      /* The gate hears the new engine state and leaves this screen; nothing here navigates. */
      onSignedOut(await engineLogout());
    } catch {
      /* A refusal leaves the session live and the button available again, which is the honest
         state — this screen has nothing else to fall back to. That it says nothing is filed as
         ACCESS-LOCK-REFUSED-SIGN-OUT-IS-SILENT: the sentence it needs is not written, on either
         surface, and inventing one here would leave the browser tab still silent. */
      setSigningOut(false);
    }
  }, [onSignedOut, signingOut]);

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
        {mintRefusal !== null
          ? <p className="wall-warn" role="alert">{t(mintRefusal === "unverified" ? "mintUnverified" : "mintFailed")}</p>
          : null}
        <div className="gate-actions">
          {/* Rendered ONLY where the service operates a page — this app holds no plan, no balance
              and no page of its own. The minted address leaves by an anchor click, so the window's
              link interceptor hands it to the browser where the person is already signed in. */}
          {facts.manageUrl && mayLinkOut
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
      </div>
    </div>
  );
}
