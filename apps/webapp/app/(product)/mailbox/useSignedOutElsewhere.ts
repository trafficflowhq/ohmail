"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { leaveSignedOutTab, listenBrowserSession, listenLocalSignOut, listenSessionChange, listenSignedOut, postSignedOut, readSessionFamily, thisTabName } from "../../signed-out-signal";
import { retireSessionRenewal } from "../../session-refresh";
import { blockApiOwner, boundApiOwner } from "../../api-client";
import { forgetThisTab, forgetUnsentWordsOf, ownsPendingSignOut, signOutPresses } from "../../sign-out";
import type { OwnerResolver } from "../../shell/engine";
import { readOwner, readOwnerMarker } from "@ohmail/app-logic/storage/owner-cookie";
import { readIsolatedScope } from "../../pending-sign-out-storage";
import { sessionIsDead, subscribeSessionTruth } from "@ohmail/app-logic/session/session-truth";

/**
 * THIS TAB LEAVES WHEN THE BROWSER HAS SIGNED OUT, whichever tab did it. Three halves: another
 * tab's post (`signed-out-signal.ts`) drops the shell in the same task and leaves; a revoke THIS
 * tab learns is posted for the others; and a tab that missed the post checks when it is looked at
 * again (visible, focused, restored, resumed). A jar that named this account and no longer does
 * leaves at once, with no request. A jar that still names it asks the session door once, at once if
 * it changed, else after {@link SESSION_FRESH_MS}; a refused session or a different verified owner ends this tab. The pressing
 * tab keeps its progress while its own sign-out is pending. A replacement session ends that tab too.
 * Visible tabs read the jar every {@link JAR_WATCH_MS} in case they miss the session-change signal.
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
  /** A press in this tab is finishing. Keep the mailbox hidden and show its progress. */
  signingOut: boolean;
  /** The browser changed accounts while this tab still held its previous session. */
  accountChanged: boolean;
  /**
   * The confirm named this account — the channel it listens on. `false`: a sign-out is pending on
   * this jar and the tab is leaving, so nothing may be bound or drawn for that answer.
   */
  confirmed: (accountId: string, familyId?: string) => boolean;
}

export function useSignedOutElsewhere(demo: boolean, resolveOwner: OwnerResolver): SignedOutElsewhere {
  const [owner, setOwner] = useState<string | null>(null);
  const [exitReason, setExitReason] = useState<ExitReason | null>(null);
  const left = useRef(false);
  const family = useRef(readSessionFamily());
  const isolated = useRef<string | undefined>(undefined);
  const sawNamedJar = useRef(false);
  // Only a pending press from this mount can keep its progress visible.
  const [mounted] = useState(() => ({ self: thisTabName(), presses: signOutPresses() }));
  const pendingPressHere = useCallback(() => ownsPendingSignOut(mounted.self, mounted.presses), [mounted]);
  const awaitingRevoke = useSyncExternalStore(listenBrowserSession, pendingPressHere, () => false);

  /* The account this tab's mailbox was drawn for, as the sweep of its unsent words reads it when the tab leaves. */
  const ownerNow = useRef<string | null>(null);
  ownerNow.current = owner;
  /* THE ACCOUNT'S UNSENT WORDS go as its own sign-out takes them, once the mailbox has left: the composer's leaving
     save writes as it goes, after the signing tab's sweep ran (`forgetUnsentWordsOf`). */
  const forgetWords = useCallback((): void => {
    const departed = ownerNow.current;
    if (departed === null) return;
    const mayRemove = () => {
      const current = readSessionFamily();
      return readOwner() !== departed && (current === null || current === family.current);
    };
    forgetUnsentWordsOf(departed, mayRemove);
    if (isolated.current !== undefined) forgetUnsentWordsOf(isolated.current, mayRemove);
  }, []);

  // `flushSync`: the rows leave the DOM inside the message's own task, before the navigation; the composer's leaving
  // save has run when it returns. A sign-out sweeps those words; a different signed-in account leaves them scoped.
  // The tab's own notes go first: the
  // signing-out tab's sweep cannot reach another tab's `sessionStorage`. From a layout effect React refuses
  // `flushSync`; a plain update there commits before the next paint, and the words go once it has (below).
  const leave = useCallback((reason: ExitReason = "signOut", inEffect = false, navigate = true) => {
    if (left.current) return;
    left.current = true;
    if (ownerNow.current !== null && boundApiOwner() === ownerNow.current) blockApiOwner();
    retireSessionRenewal();
    forgetThisTab();
    if (inEffect) setExitReason(reason);
    else {
      flushSync(() => setExitReason(reason));
      if (reason === "signOut") forgetWords();
    }
    if (navigate) leaveSignedOutTab();
  }, [forgetWords]);
  /* After the mailbox's own effects have let go (its composer's leaving save among them): a leave from an effect. */
  useEffect(() => {
    if (exitReason === "signOut") forgetWords();
  }, [exitReason, forgetWords]);

  /** A sign-out pending on this jar that this page did not press. */
  const pendingHere = useCallback(
    (): boolean => !demo && !pendingPressHere() && readOwnerMarker().kind === "signed-out",
    [demo, pendingPressHere],
  );

  // The first frame stays the server's; the page may have been served before the press marked the jar.
  useAfterHydration(() => {
    if (pendingHere()) leave("signOut", true);
  }, [pendingHere, leave]);

  useEffect(() => {
    if (!demo) setOwner((held) => held ?? readOwner());
  }, [demo]);
  const confirmed = useCallback((accountId: string, familyId?: string): boolean => {
    if (left.current) return false;
    const currentFamily = readSessionFamily();
    const expected = familyId ?? currentFamily;
    if ((ownerNow.current !== null && accountId !== ownerNow.current)
      || (family.current !== null && expected !== family.current)
      || (currentFamily !== null && currentFamily !== expected)) {
      leave("accountChange", true);
      return false;
    }
    if (pendingHere()) {
      leave();
      return false;
    }
    family.current = expected;
    isolated.current = readIsolatedScope(accountId, expected);
    setOwner(accountId);
    return true;
  }, [pendingHere, leave]);

  const exitForJar = useCallback((jar: string): ExitReason | null => {
    if (owner === null) return null;
    const currentFamily = readSessionFamily();
    if (currentFamily !== null && currentFamily !== family.current) return "accountChange";
    if (jar === "signed-out") return pendingPressHere() ? null : "signOut";
    const mine = `account:${owner}`;
    if (jar === mine) {
      sawNamedJar.current = true;
      return null;
    }
    if (jar.startsWith("account:")) return "accountChange";
    // Local renewal already owns expiry and revoke. Other tabs still check the jar and leave.
    return sawNamedJar.current && !sessionIsDead() ? "signOut" : null;
  }, [owner, pendingPressHere]);

  // Subscribe, then read the jar once in case a signal preceded the listener.
  useAfterHydration(() => {
    if (demo || owner === null || exitReason !== null) return;
    const check = (inEffect = false): void => {
      const reason = exitForJar(jarReading());
      if (reason !== null) leave(reason, inEffect);
    };
    const stopSignOut = listenSignedOut(owner, () => {
      const reason = exitForJar(jarReading());
      if (reason !== null || (!pendingPressHere() && !jarNames(owner))) leave(reason ?? "signOut");
    });
    const stopChange = listenSessionChange(() => check());
    const stopLocal = listenLocalSignOut(() => {
      if (exitForJar(jarReading()) === "signOut") leave("signOut", false, false);
    });
    check(true);
    return () => {
      stopLocal();
      stopChange();
      stopSignOut();
    };
  }, [demo, owner, leave, exitForJar, pendingPressHere, exitReason]);

  // A death is posted only once the jar has stopped naming the account (the refusal cleared it).
  useEffect(() => {
    if (demo || owner === null || exitReason !== null) return;
    return subscribeSessionTruth(() => {
      if (sessionIsDead() && !jarNames(owner)) postSignedOut(owner);
    });
  }, [demo, owner, exitReason]);

  useEffect(() => {
    if (demo || owner === null || exitReason !== null) return;
    let live = true;
    let askedAt = Date.now();
    let askedJar = jarReading();
    const onBack = (): void => {
      if (!live || left.current || document.visibilityState === "hidden") return;
      const jar = jarReading();
      const reason = exitForJar(jar);
      if (reason !== null) {
        leave(reason);
        return;
      }
      if (pendingPressHere()) return;
      if (jar === askedJar && Date.now() - askedAt < SESSION_FRESH_MS) return;
      askedAt = Date.now();
      askedJar = jar;
      void resolveOwner()
        .then((outcome) => {
          if (!live || left.current) return;
          const reason = exitForJar(jarReading());
          if (reason !== null) leave(reason);
          else if (outcome.kind === "owner" && (
            outcome.accountId !== owner || (outcome.familyId !== undefined && outcome.familyId !== family.current)
          )) leave("accountChange");
          else if (outcome.kind === "none" && !pendingPressHere()) leave();
        })
        .catch(() => { /* a build with no server: nothing to learn here */ });
    };
    // Visible tabs check the jar even if the browser delivered no signal.
    let watch: ReturnType<typeof setInterval> | null = null;
    const arm = (): void => {
      const on = live && !left.current && document.visibilityState === "visible";
      if (on && watch === null) {
        watch = setInterval(() => {
          if (!live || left.current) return;
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
  }, [demo, owner, resolveOwner, leave, pendingPressHere, exitForJar, exitReason]);

  const signingOut = !demo && (awaitingRevoke ||
    (exitReason === "signOut" && signOutPresses(mounted.self) > mounted.presses));
  return { gone: exitReason !== null, signingOut, accountChanged: exitReason === "accountChange", confirmed };
}
