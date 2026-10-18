"use client";

/**
 * A SIGN-OUT THIS BROWSER ASKED FOR AND THE SERVER NEVER CONFIRMED (`tf_owner=signed_out_pending`), on the
 * pages such a browser reaches without the app: the sign-in page the edge sends it to, and the sign-up and
 * address confirmation pages, one link from it or a mail link from another site. The jar still carries the
 * previous person's cookies there. Each page finishes the sign-out behind its form (`finish-sign-out.ts`)
 * INSTEAD of reading the session, which answers for that person and refreshes on a 401; asks the door once
 * more before a ceremony that writes session cookies; and, when it ends unconfirmed, says so in the account
 * pane's words with Sign out to ask again. The marker is read by the caller in its effect, never in render.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";
import { readOwnerMarker } from "../../shell/owner-cookie";
import type { SignOutTrouble } from "../../sign-out-trouble";
import { finishPendingSignOut, pendingSignOutSettled, type Finish } from "./finish-sign-out";

export interface PendingSignOut {
  /**
   * The ladder, behind the page: after an attempt this tab already has out (the page this one replaced)
   * has ended, so the door is asked once at a time. Said when it ends unconfirmed.
   */
  finish: (isCancelled: () => boolean) => Promise<void>;
  /**
   * Before a sign-in, a registration or an address confirmation: an attempt still out ends first, then a
   * sign-out still pending is asked at the door once more. True when the ceremony may start: the sign-out
   * is confirmed, or the jar is no longer this sign-out's.
   */
  settle: () => Promise<boolean>;
  /** Sign out, pressed after it ended unconfirmed: the ladder again, on any jar that names no account. */
  again: () => void;
  /** What did not happen, while it stands; `null` while the ladder runs, once it is done, and when never pending. */
  said: SignOutTrouble | null;
  signingOut: boolean;
}

export function usePendingSignOut(): PendingSignOut {
  const ts = useTranslations("session");
  /* The callbacks stay the same for the page's life: its effects run them, and a translator in their
     dependencies would re-run those. */
  const tsRef = useRef(ts);
  tsRef.current = ts;
  const [said, setSaid] = useState<SignOutTrouble | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /** The finisher, with a sign-out module that cannot be loaded (no network) read as the door unanswered. */
  const ladder = useCallback((opts: Parameters<typeof finishPendingSignOut>[0]): Promise<Finish> =>
    finishPendingSignOut(opts).catch((): Finish => ({
      outcome: "refused", said: { key: "signOutServerRefused", reason: tsRef.current("refusedOffline") },
    })), []);
  const say = useCallback((end: Finish): void => {
    setSaid(end.outcome === "refused" || end.outcome === "stopped" ? end.said : null);
  }, []);

  const finish = useCallback(async (isCancelled: () => boolean): Promise<void> => {
    await pendingSignOutSettled();
    if (isCancelled()) return;
    const end = await ladder({ isCancelled });
    if (!isCancelled() && mounted.current) say(end);
  }, [ladder, say]);

  const settle = useCallback(async (): Promise<boolean> => {
    await pendingSignOutSettled();
    if (readOwnerMarker().kind !== "signed-out") return true;
    const end = await ladder({ isCancelled: () => !mounted.current, attempts: 1 });
    if (!mounted.current) return false;
    say(end);
    return end.outcome === "confirmed" || end.outcome === "moved";
  }, [ladder, say]);

  /* A door that answered with the wipe blocked has already cleared the marker, and the wipe is what is
     asked again then. A jar another tab signed in to is left alone. */
  const again = useCallback((): void => {
    setSigningOut(true);
    void ladder({
      isCancelled: () => !mounted.current,
      mayEnd: () => readOwnerMarker().kind !== "account",
    }).then((end) => {
      if (!mounted.current) return;
      setSigningOut(false);
      say(end);
    });
  }, [ladder, say]);

  return { finish, settle, again, said, signingOut };
}

/** How the pending sign-out ended, when it did not finish, and Sign out to ask again. Nothing otherwise. */
export function PendingSignOutSaid({ pending, busy }: { pending: PendingSignOut; busy: boolean }) {
  const ta = useTranslations("account");
  if (pending.said === null) return null;
  return (
    <div className="join-error-note">
      <p className="join-error" role="alert">
        {pending.said.key === "signOutServerRefused"
          ? ta(pending.said.key, { reason: pending.said.reason })
          : ta(pending.said.key)}
      </p>
      <Button
        variant="ghost" type="button" className="join-error-use"
        onClick={pending.again} disabled={busy || pending.signingOut}
      >
        {pending.signingOut ? ta("signOutBusy") : ta("signOut")}
      </Button>
    </div>
  );
}
