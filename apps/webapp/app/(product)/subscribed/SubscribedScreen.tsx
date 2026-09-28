"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Spinner } from "@ohmail/ui";
import { apiConfigured } from "../../api-client";
import { confirmCheckoutReturn } from "../../checkout-return";
import { resolveOwnerOutcome } from "../session-outcome";
import { SELF_HOST_BUILD } from "../../hello";

/**
 * One `GET /auth/session` (through the shared classifier, so a lapsed-but-resumable session is
 * renewed rather than read as absent). A full session confirms the Checkout it came back from, once
 * and bounded, and continues to `/?billing=success`, which arms the wall's lift poll in whatever tab
 * this is; anything else is the one sentence and the way to the app.
 */
export function SubscribedScreen() {
  const t = useTranslations("subscribed");
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    // A self-hosted server takes no payment, so nobody is sent back here: go to the app.
    if (SELF_HOST_BUILD) { window.location.replace("/"); return; }
    if (!apiConfigured()) {
      setSignedIn(false);
      return;
    }
    let alive = true;
    void resolveOwnerOutcome()
      .then((outcome) => {
        if (!alive) return;
        if (outcome.kind === "owner") {
          setSignedIn(true);
          void confirmCheckoutReturn(window.location.search)
            .finally(() => { window.location.replace("/?billing=success"); });
          return;
        }
        setSignedIn(false);
      })
      .catch(() => { if (alive) setSignedIn(false); });
    return () => { alive = false; };
  }, []);

  return (
    <main className="gate">
      <div className="gate-card">
        <span className="wordmark"><b><em>oh</em>mail</b></span>
        {signedIn === false
          ? (
            <>
              <h1>{t("title")}</h1>
              <p>{t("body")}</p>
              <div className="gate-actions">
                <a className="btn primary" href="/">{t("open")}</a>
              </div>
            </>
          )
          : (
            <span className="mbx-wait" role="status" aria-busy="true">
              <Spinner className="mbx-spin" />
              {t("continuing")}
            </span>
          )}
      </div>
    </main>
  );
}
