/**
 * THE LOCK SCREEN IN THE WINDOW — what an account the service has refused sees instead of its mail.
 *
 * The browser tab's `AccessLock.tsx`, mirrored the way `DesktopSubscription` mirrors the
 * Subscription pane: the same `accessLock` sentences, this window's own chrome and door. A mirror
 * and NOT an import, because that file signs out through `app/sign-out.ts` — which this build
 * aliases to the refusing api-client stub, so the one control on the screen would throw.
 *
 * Two doors stay open because a lock with no way out is a trap: signing out (this may be a shared
 * machine) and the way back, where the service supplied one. It deletes and wipes nothing itself.
 */

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";

import { engineLogout, type AccessRefusedFacts, type EngineStatus } from "./bridge-fetch.js";

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

  return (
    <div className="gate">
      <div className="gate-card">
        <span className="wordmark"><b>ohmail</b><em>.</em></span>
        <h1>{facts.reason === "suspended" ? t("suspendedTitle") : t("title")}</h1>
        <p>{t("kept")}</p>
        <div className="gate-actions">
          {/* Rendered ONLY when the service supplied an address, and it is the service's own —
              this app holds no plan, no balance and no page of its own to send anybody to. An
              anchor, so the window's link interceptor hands it to the browser where the person
              is already signed in; a button that goes nowhere is worse than no button. */}
          {facts.manageUrl
            ? (
              <a
                className="btn primary"
                href={facts.manageUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("manage")}
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
