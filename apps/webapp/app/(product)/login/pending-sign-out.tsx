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
import { readOwnerMarker } from "@ohmail/app-logic/storage/owner-cookie";
import { cleanupNoticeShown, markCleanupNoticeShown, readPendingSignOut } from "../../pending-sign-out-storage";
import type { SignOutTrouble } from "../../sign-out-trouble";
import { finishPendingSignOut, pendingSignOutSettled, type Finish } from "./finish-sign-out";

type Notice = SignOutTrouble | { key: "localCacheUnverified" };
type FinishWithPress = Finish & { press?: string };
type DisplayedNotice = { said: Notice; press?: string };

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
  said: Notice | null;
  signingOut: boolean;
}

export function usePendingSignOut(): PendingSignOut {
  const ts = useTranslations("session");
  /* The callbacks stay the same for the page's life: its effects run them, and a translator in their
     dependencies would re-run those. */
  const tsRef = useRef(ts);
  tsRef.current = ts;
  const [notice, setNotice] = useState<DisplayedNotice | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const mounted = useRef(true);
  const pageActive = useRef(true);
  const shownHere = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    const hide = () => { pageActive.current = false; };
    const show = () => { pageActive.current = true; };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
  }, []);

  useEffect(() => {
    if (!pageActive.current || notice?.press === undefined || readPendingSignOut()?.press !== notice.press) return;
    const { key } = notice.said;
    if (key === "signOutUnverified" || key === "signOutBlocked" || key === "localCacheUnverified") {
      markCleanupNoticeShown(notice.press);
      shownHere.current = notice.press;
    }
  }, [notice]);

  /** The finisher, with a sign-out module that cannot be loaded (no network) read as the door unanswered. */
  const ladder = useCallback(async (opts: Parameters<typeof finishPendingSignOut>[0]): Promise<FinishWithPress> => {
    const press = readPendingSignOut()?.press;
    const end = await finishPendingSignOut(opts).catch((): Finish => ({
      outcome: "refused", said: { key: "signOutServerRefused", reason: tsRef.current("refusedOffline") },
    }));
    return { ...end, press: press ?? readPendingSignOut()?.press };
  }, []);
  const say = useCallback((end: FinishWithPress, manual = false): void => {
    if (end.outcome !== "stopped") {
      setNotice(end.outcome === "refused" && end.said !== null ? { said: end.said } : null);
      return;
    }
    const { press } = end;
    const show = (trouble: SignOutTrouble | null): DisplayedNotice | null => {
      if (!pageActive.current || trouble === null) return null;
      const current = readPendingSignOut();
      if (press !== undefined) {
        if (current?.press !== press || readOwnerMarker().kind === "account") return null;
        if (!manual && shownHere.current !== press && cleanupNoticeShown(press)) return null;
      }
      const said = trouble.key === "signOutUnverified" && current?.cachePending === true
        ? { key: "localCacheUnverified" } as const : trouble;
      return { said, press };
    };
    const initial = show(end.said);
    setNotice(initial);
    void end.cleanup?.then((updated) => {
      if (!mounted.current) return;
      const next = show(updated);
      setNotice((current) => current === initial ? next : current);
    });
  }, []);

  const retryCache = useCallback((manual = false): void => {
    const operation = readPendingSignOut();
    if (operation?.cachePending !== true) return;
    const incomplete = { key: "signOutUnverified" } as const;
    const cleanup = import("../../sign-out").then(({ retryPendingCacheCleanup }) => retryPendingCacheCleanup())
      .then((clean) => clean === false ? incomplete : null, () => incomplete);
    say({ outcome: "stopped", press: operation.press, said: { key: "signOutCleanupPending" }, cleanup }, manual);
  }, [say]);

  useEffect(() => {
    if (readOwnerMarker().kind === "absent") retryCache();
  }, [retryCache]);

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
    return end.outcome === "confirmed" || end.outcome === "stopped" || end.outcome === "moved";
  }, [ladder, say]);

  /* A door that answered with the wipe blocked has already cleared the marker, and the wipe is what is
     asked again then. A jar another tab signed in to is left alone. */
  const again = useCallback((): void => {
    if (readOwnerMarker().kind === "absent") {
      retryCache(true);
      return;
    }
    setSigningOut(true);
    void ladder({
      isCancelled: () => !mounted.current,
      mayEnd: () => readOwnerMarker().kind !== "account",
    }).then((end) => {
      if (!mounted.current) return;
      setSigningOut(false);
      say(end, true);
    });
  }, [ladder, retryCache, say]);

  return { finish, settle, again, said: notice?.said ?? null, signingOut };
}
