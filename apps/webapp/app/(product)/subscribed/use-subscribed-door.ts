"use client";

import { useEffect, useState } from "react";
import { apiConfigured } from "../../api-client";
import { confirmAccountReturn } from "../../account-return";
import { resolveOwnerOutcome } from "../session-outcome";
import { SELF_HOST_BUILD } from "../../hello";
import { revokedWipeSettled } from "../../revoked-door";

/** What the return from the payment page knows: `null` while it asks, then whether this browser holds a session. */
export interface SubscribedCeremony {
  signedIn: boolean | null;
}

/**
 * One `GET /auth/session` (through the shared classifier, so a lapsed-but-resumable session is
 * renewed rather than read as absent). A full session confirms the Checkout it came back from, once
 * and bounded, and continues to `/?billing=success`, which arms the wall's lift poll in whatever tab
 * this is; anything else is the one sentence and the way to the app.
 */
export function useSubscribedDoor(): SubscribedCeremony {
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
      // A revoke this check heard: that account's copy is gone before the page sends anyone on.
      .then(async (outcome) => { await revokedWipeSettled(); return outcome; })
      .then((outcome) => {
        if (!alive) return;
        if (outcome.kind === "owner") {
          setSignedIn(true);
          void confirmAccountReturn(window.location.search)
            .finally(() => { window.location.replace("/?billing=success"); });
          return;
        }
        setSignedIn(false);
      })
      .catch(() => { if (alive) setSignedIn(false); });
    return () => { alive = false; };
  }, []);

  return { signedIn };
}
