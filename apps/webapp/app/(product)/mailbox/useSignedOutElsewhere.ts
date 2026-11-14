"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { leaveSignedOutTab, listenSignedOut, postSignedOut, thisTabName } from "../../signed-out-signal";
import { forgetThisTab, forgetUnsentWordsOf, signOutPresses } from "../../sign-out";
import type { OwnerResolver } from "../../shell/engine";
import { readOwnerMarker } from "@ohmail/app-logic/storage/owner-cookie";
import { sessionIsDead, subscribeSessionTruth } from "@ohmail/app-logic/session/session-truth";
import { storageOwner } from "@ohmail/app-logic/storage/storage-owner";

/**
 * THIS TAB LEAVES WHEN THE BROWSER HAS SIGNED OUT, whichever tab did it. Three halves: another
 * tab's post (`signed-out-signal.ts`) drops the shell in the same task and leaves; a revoke THIS
 * tab learns is posted for the others; and a tab that missed the post checks when it is looked at
 * again (visible, focused, restored, resumed). A jar that named this account and no longer does
 * leaves at once, with no request. A jar that still names it asks the session door once, at once if
 * it changed, else after {@link SESSION_FRESH_MS}; a refused session or a different verified owner ends this tab. A mailbox whose
 * page pressed Sign out while it was mounted never leaves by this check: its pane says how that ended.
 * A tab on screen with no `BroadcastChannel` may hear nothing at all (no storage event either, and no
 * return while it stays in view), so it reads the jar every {@link JAR_WATCH_MS}, by the same rule.
 *
 * A TAB BOOTING WHILE A SIGN-OUT IS PENDING reads the jar before it draws any mail: at its first frame
 * (the page may have been served before the press), when its confirm answers, and once its listener is
 * up. Only the reserved word sends it away there; not on the demo, nor from the page that pressed.
 */
export const SESSION_FRESH_MS = 60_000;

export const JAR_WATCH_MS = 1_000;

const useAfterHydration = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** The jar still names this account: a sign-in re-established it, so a signal is stale. */
function jarNames(owner: string): boolean {
  const m = readOwnerMarker();
  return m.kind === "account" && m.id === owner;
}

/** What the jar says, as a value a later reading can be compared with. */
function jarReading(): string {
  const m = readOwnerMarker();
  return m.kind === "account" ? `account:${m.id}` : m.kind;
}

type ExitReason = "signOut" | "accountChange";

export interface SignedOutElsewhere {
  /** The shell is gone and the tab is leaving; render nothing of the mailbox. */
  gone: boolean;
  /**
   * The confirm named this account — the channel it listens on. `false`: a sign-out is pending on
   * this jar and the tab is leaving, so nothing may be bound or drawn for that answer.
   */
  confirmed: (accountId: string) => boolean;
}

export function useSignedOutElsewhere(demo: boolean, resolveOwner: OwnerResolver): SignedOutElsewhere {
  const [owner, setOwner] = useState<string | null>(null);
  const [exitReason, setExitReason] = useState<ExitReason | null>(null);
  const left = useRef(false);
  // This page's name and its presses when this shell mounted: only a press made since stands it down.
  const [mounted] = useState(() => ({ self: thisTabName(), presses: signOutPresses() }));
  const pressedHere = useCallback((): boolean => signOutPresses(mounted.self) !== mounted.presses, [mounted]);

  /* The account this tab's mailbox was drawn for, as the sweep of its unsent words reads it when the tab leaves. */
  const ownerNow = useRef<string | null>(null);
  ownerNow.current = owner;
  /* THE ACCOUNT'S UNSENT WORDS go as its own sign-out takes them, once the mailbox has left: the composer's leaving
     save writes as it goes, after the signing tab's sweep ran (`forgetUnsentWordsOf`). */
  const forgetWords = useCallback((): void => {
    if (ownerNow.current !== null) forgetUnsentWordsOf(ownerNow.current);
  }, []);

  // `flushSync`: the rows leave the DOM inside the message's own task, before the navigation; the composer's leaving
  // save has run when it returns. A sign-out sweeps those words; a different signed-in account leaves them scoped.
  // The tab's own notes go first: the
  // signing-out tab's sweep cannot reach another tab's `sessionStorage`. From a layout effect React refuses
  // `flushSync`; a plain update there commits before the next paint, and the words go once it has (below).
  const leave = useCallback((reason: ExitReason = "signOut", inEffect = false) => {
    if (left.current) return;
    left.current = true;
    forgetThisTab();
    if (inEffect) setExitReason(reason);
    else {
      flushSync(() => setExitReason(reason));
      if (reason === "signOut") forgetWords();
    }
    leaveSignedOutTab();
  }, [forgetWords]);
  /* After the mailbox's own effects have let go (its composer's leaving save among them): a leave from an effect. */
  useEffect(() => {
    if (exitReason === "signOut") forgetWords();
  }, [exitReason, forgetWords]);

  /** A sign-out pending on this jar that this page did not press. */
  const pendingHere = useCallback(
    (): boolean => !demo && !pressedHere() && readOwnerMarker().kind === "signed-out",
    [demo, pressedHere],
  );

  // The first frame stays the server's; the page may have been served before the press marked the jar.
  useAfterHydration(() => {
    if (pendingHere()) leave("signOut", true);
  }, [pendingHere, leave]);

  useEffect(() => {
    if (!demo) setOwner((held) => held ?? storageOwner());
  }, [demo]);
  const confirmed = useCallback((accountId: string): boolean => {
    if (left.current || pendingHere()) {
      leave();
      return false;
    }
    setOwner(accountId);
    return true;
  }, [pendingHere, leave]);

  // Subscribe, then read the jar once: a post sent before this listener existed was missed.
  useAfterHydration(() => {
    if (demo || owner === null) return;
    const stop = listenSignedOut(owner, () => {
      if (!jarNames(owner)) leave();
    });
    if (pendingHere()) leave("signOut", true);
    return stop;
  }, [demo, owner, leave, pendingHere]);

  // A death is posted only once the jar has stopped naming the account (the refusal cleared it).
  useEffect(() => {
    if (demo || owner === null) return;
    return subscribeSessionTruth(() => {
      if (sessionIsDead() && !jarNames(owner)) postSignedOut(owner);
    });
  }, [demo, owner]);

  useEffect(() => {
    if (demo || owner === null) return;
    let live = true;
    let askedAt = Date.now();
    let askedJar = jarReading();
    const mine = `account:${owner}`;
    // An account change hides the old mailbox immediately. Its scoped drafts still belong to that account.
    const exitForJar = (jar: string): ExitReason | null => {
      if (jar === mine) return null;
      if (jar.startsWith("account:")) return "accountChange";
      return askedJar === mine ? "signOut" : null;
    };
    const onBack = (): void => {
      if (!live || left.current || document.visibilityState === "hidden" || pressedHere()) return;
      const jar = jarReading();
      const reason = exitForJar(jar);
      if (reason !== null) {
        leave(reason);
        return;
      }
      if (jar === askedJar && Date.now() - askedAt < SESSION_FRESH_MS) return;
      askedAt = Date.now();
      askedJar = jar;
      void resolveOwner()
        .then((outcome) => {
          if (!live || left.current || pressedHere()) return;
          if (pendingHere()) leave();
          else if (outcome.kind === "none") leave(exitForJar(jarReading()) ?? "signOut");
          else if (outcome.kind === "owner" && outcome.accountId !== owner) leave("accountChange");
        })
        .catch(() => { /* a build with no server: nothing to learn here */ });
    };
    // Reads the jar only, never the server; a tab with a channel or out of view runs none.
    let watch: ReturnType<typeof setInterval> | null = null;
    const arm = (): void => {
      const on = live && !left.current && typeof BroadcastChannel === "undefined" && document.visibilityState === "visible";
      if (on && watch === null) {
        watch = setInterval(() => {
          if (!live || left.current || pressedHere()) return;
          const reason = exitForJar(jarReading());
          if (reason !== null) leave(reason);
        }, JAR_WATCH_MS);
      } else if (!on && watch !== null) {
        clearInterval(watch);
        watch = null;
      }
    };
    const onVisibility = (): void => {
      onBack();
      arm();
    };
    arm();
    document.addEventListener("visibilitychange", onVisibility);
    // A frozen tab that the browser resumes (the Page Lifecycle API) fires this, not a visibility change.
    document.addEventListener("resume", onBack);
    window.addEventListener("focus", onBack);
    window.addEventListener("pageshow", onBack);
    return () => {
      live = false;
      if (watch !== null) clearInterval(watch);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("resume", onBack);
      window.removeEventListener("focus", onBack);
      window.removeEventListener("pageshow", onBack);
    };
  }, [demo, owner, resolveOwner, leave, pendingHere, pressedHere]);

  return { gone: exitReason !== null, confirmed };
}
