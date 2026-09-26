"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Spinner } from "@ohmail/ui";
import { apiConfigured } from "../../api-client";
import { resolveOwnerOutcome } from "../session-outcome";

/**
 * One `GET /auth/session` (through the shared classifier, so a lapsed-but-resumable session is
 * renewed rather than read as absent). A full session continues to `/` at once; anything else is
 * the one sentence and the way to the app, whose own gate signs the person in if it has to.
 */
export function SubscribedScreen() {
  const t = useTranslations("subscribed");
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
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
          window.location.replace("/");
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
