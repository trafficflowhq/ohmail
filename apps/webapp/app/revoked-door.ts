"use client";

import { useEffect, useSyncExternalStore } from "react";
import { REFRESH_REUSE_CAUSE, mirrorDbName } from "@ohmail/client-engine";
import {
  SETTLE_DEADLINE_MS, mintWitness, mintedSince, registerRevokeDoor, type MintWitness,
} from "./session-refresh";
import { durableRemove, durableSet } from "./shell/durable";
import { isOwnerShaped, readOwner } from "./shell/owner-cookie";
import { subscribeSessionRevival } from "./shell/session-truth";
import { holdSignedOutLeave, leaveSignedOutTab } from "./signed-out-signal";
import {
  REVOKE_OWED_PREFIX, shareSignedOutNote, takeSharedSignedOutNote, type SignedOutReason,
} from "./(product)/resume/signed-out-note";
import type { WipeReach } from "./sign-out";

/**
 * THE WEB'S DOOR FOR A SESSION REVOKED ELSEWHERE (`refresh_revoked`: Devices, Sign out all, sign out
 * everywhere, a credential change, a reuse sweep). The tab drops its mailbox, this browser's copy of
 * that account goes as Sign out takes it, and the tab leaves once the copy is gone. A lapse keeps the
 * scrim and the copy. Registered on import by every product page (`providers.tsx`). A wipe stays owed
 * in storage until the copy is proved gone, so the next page finishes one a closed page left.
 */

interface Capture { owner: string | null }
/** `at`: the jar right after the refusal (`mintWitness`); a session minted since is read off it. */
interface Revoked { owner: string | null; reason: SignedOutReason; at: MintWitness }
/** A wipe's witness; `revivals` is this page's count when this page heard the refusal itself. */
interface Owed extends MintWitness { revivals?: number }

/** The revoke this page heard, until a session is minted again. */
let revoked: Revoked | null = null;
const listeners = new Set<() => void>();
/** The bounded wipe per account while it runs. */
const running = new Map<string, Promise<void>>();
/** The revoke a mailbox already left for: one leave per revoke. */
let leftFor: Revoked | null = null;
/** The account the mounted mailbox is for (`useRevokedHere`); the splash mounts none. */
let tabAccount: (() => string | null) | null = null;
/** Sessions this page saw minted: one minted here counts even where storage keeps no record of it. */
let revivals = 0;
/** The reason this page heard, per wipe: said again once that wipe's sweep has taken the shared note. */
const told = new Map<string, SignedOutReason>();

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

const owedKey = (owner: string | null): string => `${REVOKE_OWED_PREFIX}${owner ?? ""}`;

/**
 * How far `owner`'s wipe may still reach: the whole jar while no session was minted since the refusal,
 * that account's own stores once another session was, nothing once its own is back.
 */
function reachFor(owner: string, at: Owed): WipeReach {
  const minted = (at.revivals !== undefined && at.revivals !== revivals) || mintedSince(at);
  if (!minted) return "jar";
  return readOwner() === owner ? "none" : "account";
}

function wipe(named: string | null, at: Owed): Promise<void> {
  const key = named ?? "";
  const out = running.get(key);
  if (out) return out;
  const work = (async () => {
    // Whether the sweep may have taken the shared note: not when this wipe took nothing.
    let swept = true;
    try {
      const owner = named ?? await onlyCopyHere();
      // Nobody named and no one copy to name: the door takes none, now or later.
      if (owner === null) {
        swept = false;
        durableRemove(owedKey(null), "revoke.owed");
        return;
      }
      // Loaded here, not with the splash: the wipe and the engine behind it are not the splash's to carry.
      const { forgetThisBrowser } = await import("./sign-out");
      const reach = (): WipeReach => reachFor(owner, at);
      let left = 0;
      if (reach() === "none") swept = false;
      else left = (await forgetThisBrowser(owner, { only: true, reach })).remaining.length;
      // Proved gone, or that account's session is back: nothing is owed. What is left, the next page finishes.
      if (left === 0 || reach() === "none") durableRemove(owedKey(named), "revoke.owed");
    } catch {
      /* what could not be removed stays owed; the tab leaves all the same */
    } finally {
      // The sweep took the shared note with the session's keys: told again, unless a session came back.
      const reason = told.get(key);
      told.delete(key);
      if (swept && reason !== undefined && revoked !== null && readOwner() === null) shareSignedOutNote(reason);
    }
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
    const at = mintWitness();
    setRevoked({ owner, reason, at });
    // A sign-in landed during the round trip: the jar is that session's, and nothing of it is ended here.
    const now = readOwner();
    if (now !== null && now !== owner) return;
    // Owed before it starts: a page closed from here on leaves the wipe to the next one.
    durableSet(owedKey(owner), JSON.stringify(at), "revoke.owed");
    told.set(owner ?? "", reason);
    void wipe(owner, { ...at, revivals });
    // Inside the lock, for a tab queued behind this one; the splash's refusal hook may have told it already.
    if (takeSharedSignedOutNote() !== reason) shareSignedOutNote(reason);
  },
});

// A minted session (a sign-in, a renewal's 204) ends the revoke, and the account it is for owes no wipe:
// a later page that no longer finds the name in the jar (Safari) must not take its live copy.
subscribeSessionRevival(() => {
  revivals += 1;
  if (revoked !== null) setRevoked(null);
  const back = readOwner();
  if (back !== null) durableRemove(owedKey(back), "revoke.owed");
  durableRemove(owedKey(null), "revoke.owed");
});

/** A record's witness, or `null` when it holds none. */
function witnessOf(raw: string | null): MintWitness | null {
  try {
    const w = JSON.parse(raw ?? "null") as Partial<MintWitness> | null;
    if (typeof w !== "object" || w === null || typeof w.mark !== "string") return null;
    return {
      mark: w.mark,
      owner: typeof w.owner === "string" ? w.owner : null,
      minted: typeof w.minted === "number" ? w.minted : null,
    };
  } catch {
    return null;
  }
}

/** Every wipe a closed page left owed, finished here: no sentence and no latch, those were that page's. */
function finishOwed(): void {
  const owed: Array<[string | null, MintWitness]> = [];
  const malformed: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key === null || !key.startsWith(REVOKE_OWED_PREFIX)) continue;
      const name = key.slice(REVOKE_OWED_PREFIX.length);
      const at = witnessOf(window.localStorage.getItem(key));
      if (at !== null && (name === "" || isOwnerShaped(name))) owed.push([name === "" ? null : name, at]);
      else malformed.push(key);
    }
  } catch {
    return;
  }
  for (const key of malformed) durableRemove(key, "revoke.owed");
  for (const [named, at] of owed) void wipe(named, at);
}

if (typeof window !== "undefined") finishOwed();

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

/**
 * The session check a page has out, answered or out of time ({@link SETTLE_DEADLINE_MS}): a revoke it
 * meets has started its wipe before the page acts. Then `ask`, the page's own check, which asks only
 * when no check has answered yet (a busy server, offline, a portal's page): inside the same bound, and
 * aborted at it, so it cannot become a refresh behind the page's ceremony. Never rejects.
 */
export async function checkAnswered(
  check: Promise<unknown> | null | undefined,
  ask?: (signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  if (!check && !ask) return;
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await check?.then(() => undefined, () => undefined);
        if (ask && !stop.signal.aborted) await ask(stop.signal).catch(() => undefined);
      })(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, SETTLE_DEADLINE_MS); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    stop.abort();
  }
}

/** Test seam. */
export function resetRevokedDoorForTests(): void {
  revoked = null;
  leftFor = null;
  tabAccount = null;
  revivals = 0;
  told.clear();
  running.clear();
  holdSignedOutLeave(null);
}
