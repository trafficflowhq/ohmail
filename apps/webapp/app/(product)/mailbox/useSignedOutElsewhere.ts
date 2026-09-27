"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { leaveSignedOutTab, listenSignedOut, postSignedOut } from "../../signed-out-signal";
import type { OwnerResolver } from "../../shell/engine";
import { readOwnerMarker } from "../../shell/owner-cookie";
import { sessionIsDead, subscribeSessionTruth } from "../../shell/session-truth";
import { storageOwner } from "../../shell/storage-owner";

/**
 * THIS TAB LEAVES WHEN THE BROWSER HAS SIGNED OUT, whichever tab did it. Three halves: another
 * tab's post (`signed-out-signal.ts`) drops the shell in the same task and leaves; a revoke THIS
 * tab learns is posted for the others; and a tab that missed the post asks the session door once
 * when it is looked at again (visible, focused, restored), at once if the jar changed under it,
 * else after {@link SESSION_FRESH_MS}. Only the server's `none` leaves: no answer is not a verdict.
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

  // `flushSync`: the rows leave the DOM inside the message's own task, before the navigation.
  const leave = useCallback(() => {
    if (left.current) return;
    left.current = true;
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
    const onBack = (): void => {
      if (!live || left.current || document.visibilityState === "hidden") return;
      const jar = jarReading();
      if (jar === askedJar && Date.now() - askedAt < SESSION_FRESH_MS) return;
      askedAt = Date.now();
      askedJar = jar;
      void resolveOwner()
        .then((outcome) => { if (live && outcome.kind === "none") leave(); })
        .catch(() => { /* a build with no server: nothing to learn here */ });
    };
    document.addEventListener("visibilitychange", onBack);
    window.addEventListener("focus", onBack);
    window.addEventListener("pageshow", onBack);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onBack);
      window.removeEventListener("focus", onBack);
      window.removeEventListener("pageshow", onBack);
    };
  }, [demo, owner, resolveOwner, leave]);

  return { gone, confirmed };
}
