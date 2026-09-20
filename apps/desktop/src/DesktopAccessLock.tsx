/**
 * THE LOCK SCREEN IN THE WINDOW — what an account the service has refused sees instead of its mail.
 *
 * The browser tab's `AccessLock.tsx`, mirrored the way `DesktopSubscription` mirrors the
 * Subscription pane: the same `accessLock` sentences, this window's own chrome and door. A mirror
 * and NOT an import — that file signs out through `app/sign-out.ts`, which this build aliases to
 * the refusing api-client stub, so the one control on the screen would throw. Two doors stay open
 * because a lock with no way out is a trap: signing out (this may be a shared machine) and the way
 * back, where the service supplied one. It deletes and wipes nothing itself.
 */

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";

import { engineLogout, type AccessRefusedFacts, type AccountLifecycle, type EngineStatus } from "./bridge-fetch.js";
import { linksOutToBilling } from "./distribution.js";
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
              <p>{t("mailboxUntouched")}</p>
              <p>
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
        <div className="gate-actions">
          {/* Rendered ONLY when the service supplied an address, and it is the service's own —
              this app holds no plan, no balance and no page of its own to send anybody to. An
              anchor, so the window's link interceptor hands it to the browser where the person
              is already signed in; a button that goes nowhere is worse than no button. */}
          {facts.manageUrl && mayLinkOut
            ? (
              <a
                className="btn primary"
                href={facts.manageUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {lifecycle !== undefined ? t("openAccount") : t("manage")}
              </a>
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
