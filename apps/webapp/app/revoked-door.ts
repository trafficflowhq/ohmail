"use client";

import { useEffect, useSyncExternalStore } from "react";
import { REFRESH_REUSE_CAUSE, mirrorDbName } from "@ohmail/client-engine";
import { SETTLE_DEADLINE_MS, registerRevokeDoor } from "./session-refresh";
import { isOwnerShaped, readOwner } from "./shell/owner-cookie";
import { subscribeSessionRevival } from "./shell/session-truth";
import { holdSignedOutLeave, leaveSignedOutTab } from "./signed-out-signal";
import {
  shareSignedOutNote, takeSharedSignedOutNote, type SignedOutReason,
} from "./(product)/resume/signed-out-note";

/**
 * THE WEB'S DOOR FOR A SESSION REVOKED ELSEWHERE (`refresh_revoked`: Devices, Sign out all, sign out
 * everywhere, a credential change, a reuse sweep). The tab drops its mailbox, this browser's copy of
 * that account goes as Sign out takes it, and the tab leaves once the copy is gone. A lapse keeps the
 * scrim and the copy. Registered on import: `CloudShell` and the resume splash import it.
 */

interface Capture { owner: string | null }
interface Revoked { owner: string | null; reason: SignedOutReason }

/** The revoke this page heard, until a session is minted again. */
let revoked: Revoked | null = null;
const listeners = new Set<() => void>();
/** The bounded wipe per account while it runs. */
const running = new Map<string, Promise<void>>();
/** The revoke a mailbox already left for: one leave per revoke. */
let leftFor: Revoked | null = null;
/** The account the mounted mailbox is for (`useRevokedHere`); the splash mounts none. */
let tabAccount: (() => string | null) | null = null;

function setRevoked(next: Revoked | null): void {
  revoked = next;
  for (const l of [...listeners]) l();
}

/** The one account whose copy this browser holds, or `null`: none, several, or a browser that will not list them. */
async function onlyCopyHere(): Promise<string | null> {
  const factory = typeof indexedDB === "undefined" ? undefined : indexedDB;
  if (typeof factory?.databases !== "function") return null;
  const prefix = mirrorDbName("");
  const owners = new Set<string>();
  for (const { name } of await factory.databases()) {
    const owner = name?.startsWith(prefix) ? name.slice(prefix.length) : "";
    if (isOwnerShaped(owner)) owners.add(owner);
  }
  return owners.size === 1 ? [...owners][0]! : null;
}

function wipe(named: string | null, reason: SignedOutReason): Promise<void> {
  const key = named ?? "";
  const out = running.get(key);
  if (out) return out;
  const work = (async () => {
    try {
      const owner = named ?? await onlyCopyHere();
      // Nobody named: the one copy here, and not once a session came back while the copies were counted.
      if (owner === null || (named === null && (revoked === null || readOwner() !== null))) return;
      // Loaded here, not with the splash: the wipe and the engine behind it are not the splash's to carry.
      const { forgetThisBrowser } = await import("./sign-out");
      await forgetThisBrowser(owner, { only: true });
    } catch {
      /* what could not be removed stays; the tab leaves all the same */
    }
    // The sweep took the shared note with the session's keys: told again, unless a session came back.
    if (revoked !== null && readOwner() === null) shareSignedOutNote(reason);
  })().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded: Promise<void> = Promise.race([
    work,
    new Promise<void>((resolve) => { timer = setTimeout(resolve, SETTLE_DEADLINE_MS); }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (running.get(key) === bounded) running.delete(key);
  });
  running.set(key, bounded);
  holdSignedOutLeave(bounded);
  return bounded;
}

registerRevokeDoor({
  // Safari keeps a script-written cookie seven days, and each renewal writes `tf_owner` from script: the tab's account.
  capture: (): Capture => ({ owner: readOwner() ?? tabAccount?.() ?? null }),
  hear(refusal, before) {
    if (refusal.code !== "refresh_revoked") return;
    const reason: SignedOutReason = refusal.cause === REFRESH_REUSE_CAUSE ? "reused" : "revoked";
    const owner = (before as Capture | null)?.owner ?? null;
    setRevoked({ owner, reason });
    // A sign-in landed during the round trip: the jar is that session's, and nothing of it is ended here.
    const now = readOwner();
    if (now !== null && now !== owner) return;
    void wipe(owner, reason);
    // Inside the lock, for a tab queued behind this one; the splash's refusal hook may have told it already.
    if (takeSharedSignedOutNote() !== reason) shareSignedOutNote(reason);
  },
});

// A minted session (a sign-in, a renewal's 204) ends the revoke.
subscribeSessionRevival(() => {
  if (revoked !== null) setRevoked(null);
});

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
};
const snapshot = (): boolean => revoked !== null;
const serverSnapshot = (): boolean => false;

/**
 * True while this page's session stands revoked: the mailbox is not drawn. The first mount leaves.
 * `forTab` names the account the mounted mailbox is for, read when the jar names nobody.
 */
export function useRevokedHere(demo: boolean, forTab?: () => string | null): boolean {
  const here = useSyncExternalStore(subscribe, snapshot, serverSnapshot) && !demo;
  useEffect(() => {
    if (demo || forTab === undefined) return;
    tabAccount = forTab;
    return () => { if (tabAccount === forTab) tabAccount = null; };
  }, [demo, forTab]);
  useEffect(() => {
    if (!here || revoked === null || leftFor === revoked) return;
    leftFor = revoked;
    leaveSignedOutTab();
  }, [here]);
  return here;
}

/** Every wipe this page started, ended or out of time; at once when none runs. */
export function revokedWipeSettled(): Promise<void> {
  if (running.size === 0) return Promise.resolve();
  return Promise.all([...running.values()]).then(() => undefined);
}

/** Test seam. */
export function resetRevokedDoorForTests(): void {
  revoked = null;
  leftFor = null;
  tabAccount = null;
  running.clear();
  holdSignedOutLeave(null);
}
