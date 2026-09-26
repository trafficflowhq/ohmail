"use client";

import { useSyncExternalStore } from "react";
import { holdsMirrorOf } from "@ohmail/client-engine";
import { apiOwnerBinding } from "./api-client";
import { forgetThisBrowser } from "./sign-out";
import {
  ERASED_KEY, accountErasedOwner, markAccountErased, registerErasedDoor, subscribeAccountErased,
  type ErasedVerdict,
} from "./shell/account-erased";
import { isOwnerShaped, readOwnerMarker, type OwnerMarker } from "./shell/owner-cookie";

/**
 * THE WEB'S ONE DOOR FOR AN ACCOUNT ERASED ELSEWHERE. The server named the account in its 410;
 * this decides whether the copy it names is this browser's to drop, latches the tab, drops that
 * account's copy and nothing else (`forgetThisBrowser(named, { only })`), and tells every other
 * tab through {@link ERASED_KEY}. The mailbox on the mail server is not touched: nothing here
 * reaches it. Registered on import; `CloudShell` imports it.
 */

interface Capture { marker: OwnerMarker }

/**
 * THE DECIDING LINE. The jar as it stood when the request left names the account: its copy.
 * It names another: not ours (the answer-owner refusal). It names nobody — the refusal's own
 * `Set-Cookie`, a later resume, a second tab — so the named account's copy is dropped only
 * where this browser's mirror registry says it holds one.
 */
export function erasedDecision(named: string, marker: OwnerMarker): "wipe" | "not-ours" | "nothing-here" {
  if (marker.kind === "account") return marker.id === named ? "wipe" : "not-ours";
  return holdsMirrorOf(named) ? "wipe" : "nothing-here";
}

interface WipeOutcome { owner: string; remaining: string[] | null }
let outcome: WipeOutcome | null = null;
const outcomeListeners = new Set<() => void>();
const running = new Map<string, Promise<void>>();
/** What each finished wipe left, so a tab latching after its own trusted wipe reads the answer. */
const results = new Map<string, string[]>();

function setOutcome(next: WipeOutcome): void {
  outcome = next;
  for (const l of [...outcomeListeners]) l();
}

/** The account a tab is FOR: its confirmed or pending binding, `null` on a cold, unnamed load. */
function tabOwner(): string | null {
  const b = apiOwnerBinding();
  return b.kind === "bound" || b.kind === "pending" ? b.owner : null;
}

/**
 * Drop `named`'s copy, once per account per page, and latch this tab when it is for `named`.
 * Idempotent: every transport and every tab may arrive here for the same erasure.
 */
export function eraseHere(named: string, latch: boolean): Promise<void> {
  if (latch) {
    markAccountErased(named);
    setOutcome({ owner: named, remaining: results.get(named) ?? null });
  }
  const inFlight = running.get(named);
  if (inFlight) return inFlight;
  const work = (async () => {
    let remaining: string[] = [];
    try {
      remaining = (await forgetThisBrowser(named, { only: true })).remaining;
    } catch {
      remaining = [named];
    }
    // AFTER the sweep: another tab reading it finds this tab's handles already released.
    try {
      globalThis.localStorage?.setItem(ERASED_KEY, named);
    } catch {
      /* no jar, no other tab to tell */
    }
    results.set(named, remaining);
    if (accountErasedOwner() === named) setOutcome({ owner: named, remaining });
  })();
  running.set(named, work);
  return work;
}

registerErasedDoor({
  capture: (): Capture => ({ marker: readOwnerMarker() }),
  hear(named: string, before: unknown): ErasedVerdict {
    const marker = (before as Capture | null)?.marker ?? readOwnerMarker();
    const decision = erasedDecision(named, marker);
    if (decision !== "wipe") return decision;
    void eraseHere(named, true);
    return "erased";
  },
});

/**
 * ANOTHER TAB'S VERDICT, or one this page finds on load. Trusted — a door wrote it after deciding —
 * so the copy goes; the tab walls only when it is for that account (or for nobody yet).
 */
function heardFromAnotherTab(named: string | null): void {
  if (named === null || !isOwnerShaped(named)) return;
  const mine = tabOwner();
  void eraseHere(named, mine === null || mine === named);
}

/** Listen for other tabs, and read the word once now. Returns the unsubscribe. */
export function watchErasedElsewhere(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (e: StorageEvent): void => {
    if (e.key === ERASED_KEY) heardFromAnotherTab(e.newValue);
  };
  window.addEventListener("storage", onStorage);
  let now: string | null = null;
  try {
    now = window.localStorage.getItem(ERASED_KEY);
  } catch {
    /* unreadable: nothing to act on */
  }
  heardFromAnotherTab(now);
  return () => window.removeEventListener("storage", onStorage);
}

const subscribe = (cb: () => void): (() => void) => {
  outcomeListeners.add(cb);
  const off = subscribeAccountErased(cb);
  return () => { outcomeListeners.delete(cb); off(); };
};
const snapshot = (): WipeOutcome | null => (accountErasedOwner() === null ? null : outcome);
const serverSnapshot = (): WipeOutcome | null => null;

/** The wall's state: `null` while this tab's account stands; `remaining` null while the wipe runs. */
export function useErasedWall(): WipeOutcome | null {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/** Test seam. */
export function resetErasedDoorForTests(): void {
  outcome = null;
  running.clear();
  results.clear();
}
