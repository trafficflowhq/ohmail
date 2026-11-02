"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { leaveSignedOutTab, listenSignedOut, postSignedOut, thisTabName } from "../../signed-out-signal";
import { forgetThisTab, signOutPresses } from "../../sign-out";
import type { OwnerResolver } from "../../shell/engine";
import { readOwnerMarker } from "../../shell/owner-cookie";
import { sessionIsDead, subscribeSessionTruth } from "../../shell/session-truth";
import { storageOwner } from "../../shell/storage-owner";

/**
 * THIS TAB LEAVES WHEN THE BROWSER HAS SIGNED OUT, whichever tab did it. Three halves: another
 * tab's post (`signed-out-signal.ts`) drops the shell in the same task and leaves; a revoke THIS
 * tab learns is posted for the others; and a tab that missed the post checks when it is looked at
 * again (visible, focused, restored, resumed). A jar that named this account and no longer does
 * leaves at once, with no request. A jar that still names it asks the session door once, at once if
 * it changed, else after {@link SESSION_FRESH_MS}; only the server's `none` leaves. A mailbox whose
 * page pressed Sign out while it was mounted never leaves by this check: its pane says how that ended.
 */
export const SESSION_FRESH_MS = 60_000;

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

export interface SignedOutElsewhere {
  /** The shell is gone and the tab is leaving; render nothing of the mailbox. */
  gone: boolean;
  /** The confirm named this account — the channel it listens on. */
  confirmed: (accountId: string) => void;
}

export function useSignedOutElsewhere(demo: boolean, resolveOwner: OwnerResolver): SignedOutElsewhere {
  const [owner, setOwner] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const left = useRef(false);
  // This page's name and its presses when this shell mounted: only a press made since stands it down.
  const [mounted] = useState(() => ({ self: thisTabName(), presses: signOutPresses() }));

  // `flushSync`: the rows leave the DOM inside the message's own task, before the navigation. The
  // tab's own notes go first: the signing-out tab's sweep cannot reach another tab's `sessionStorage`.
  const leave = useCallback(() => {
    if (left.current) return;
    left.current = true;
    forgetThisTab();
    flushSync(() => setGone(true));
    leaveSignedOutTab();
  }, []);

  useEffect(() => {
    if (!demo) setOwner((held) => held ?? storageOwner());
  }, [demo]);
  const confirmed = useCallback((accountId: string) => setOwner(accountId), []);

  useEffect(() => {
    if (demo || owner === null) return;
    return listenSignedOut(owner, () => {
      if (!jarNames(owner)) leave();
    });
  }, [demo, owner, leave]);

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
    const pressedHere = (): boolean => signOutPresses(mounted.self) !== mounted.presses;
    const onBack = (): void => {
      if (!live || left.current || document.visibilityState === "hidden" || pressedHere()) return;
      const jar = jarReading();
      // A sign-out (or another account's sign-in) this tab never heard: nothing to ask the server.
      if (askedJar === mine && jar !== mine) {
        leave();
        return;
      }
      if (jar === askedJar && Date.now() - askedAt < SESSION_FRESH_MS) return;
      askedAt = Date.now();
      askedJar = jar;
      void resolveOwner()
        .then((outcome) => { if (live && !pressedHere() && outcome.kind === "none") leave(); })
        .catch(() => { /* a build with no server: nothing to learn here */ });
    };
    document.addEventListener("visibilitychange", onBack);
    // A frozen tab that the browser resumes (the Page Lifecycle API) fires this, not a visibility change.
    document.addEventListener("resume", onBack);
    window.addEventListener("focus", onBack);
    window.addEventListener("pageshow", onBack);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onBack);
      document.removeEventListener("resume", onBack);
      window.removeEventListener("focus", onBack);
      window.removeEventListener("pageshow", onBack);
    };
  }, [demo, owner, resolveOwner, leave, mounted]);

  return { gone, confirmed };
}
