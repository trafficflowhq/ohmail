"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { durableSessionSet, durableSet } from "./durable";

/**
 * THE WALL LIFTS ITSELF on the service's fresh word and on nothing else. `lifts` is one fresh
 * read of the account's standing that answers `true` only for `access: "open"`; the host supplies
 * it (the browser tab through its client, the desktop window through its bridge). Asked once on
 * every return to the window, once a minute while shown, and as a bounded poll after a hand-off
 * press (this tab, this half hour) or a `?billing=success` arrival. A spent poll offers one more.
 */

export const LIFT_POLL_MS = 2_000;
export const LIFT_POLL_MAX = 30;
export const WALL_READ_MS = 60_000;
/** A read that has not answered by then is no answer, so a hung request cannot hold the poll. */
export const LIFT_READ_BOUND_MS = 10_000;
/** Focus and visibility fire together on a tab switch; one read answers both. */
const RETURN_DEBOUNCE_MS = 1_500;

/**
 * WHERE THIS DEVICE LAST FOUND THE ACCOUNT — `open` or `closed`, per owner, written on every
 * access answer and every `402`. It decides one thing: whether the first paint may be the mirror
 * (`open`) or must wait for a fresh answer. It never lifts a wall; only the service's own
 * `access: "open"` does. Swept at sign-out (`sign-out.ts`) with the rest of the account's keys.
 */
export const ACCESS_VERDICT_PREFIX = "ohmail.access.";

export type StoredVerdict = "open" | "closed";

const verdictKey = (owner: string): string => `${ACCESS_VERDICT_PREFIX}${owner}`;

export function readStoredVerdict(owner: string | null): StoredVerdict | null {
  if (owner === null) return null;
  try {
    const v = globalThis.localStorage?.getItem(verdictKey(owner));
    return v === "open" || v === "closed" ? v : null;
  } catch {
    return null; // storage refused: no verdict, so the first paint asks
  }
}

export function storeVerdict(owner: string | null, verdict: StoredVerdict): void {
  if (owner !== null) durableSet(verdictKey(owner), verdict, "access.verdict");
}

/** How long the first paint waits for the verdict before it paints the mirror anyway. */
export const FIRST_PAINT_VERDICT_MS = 3_000;

/**
 * HOW LONG A 402 IS DISBELIEVED AFTER AN OPEN VERDICT: the service's own verdict cache
 * (`ACCESS_TTL_MS`, `packages/db/src/entitlements-client.ts`). The open answer is read fresh, but
 * another API instance may hold the old refusal that long; its 402 must not re-raise the wall a
 * person has just watched lift. The drain loop still stands down on it.
 */
export const STALE_REFUSAL_MS = 60_000;

/**
 * A HAND-OFF PRESS IN THIS TAB. The web hand-off leaves in the same tab, so the wall a person comes
 * back to is a new document; this note is how it knows to poll rather than wait for the minute.
 * An account id and a time, per tab; `signOut` removes it.
 */
export const HANDOFF_KEY = "ohmail.accessHandoff";
export const HANDOFF_FRESH_MS = 30 * 60_000;

export function rememberHandoff(owner: string | null, now = Date.now()): void {
  durableSessionSet(HANDOFF_KEY, JSON.stringify({ owner, at: now }), "access.handoff");
}

export function handoffIsRecent(owner: string | null, now = Date.now()): boolean {
  try {
    const raw = globalThis.sessionStorage?.getItem(HANDOFF_KEY);
    if (!raw) return false;
    const kept = JSON.parse(raw) as { owner?: unknown; at?: unknown };
    return kept.owner === owner && typeof kept.at === "number" && now - kept.at >= 0
      && now - kept.at <= HANDOFF_FRESH_MS;
  } catch {
    return false;
  }
}

export type WallCheck = "idle" | "checking" | "pending";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function useWallLift(opts: {
  /** One fresh read; `true` only when the service answered `access: "open"`. */
  lifts: () => Promise<boolean>;
  /** Absent = a wall with no way to lift, which asks nothing. */
  onLifted: (() => void) | undefined;
  owner: string | null;
}): { check: WallCheck; armPoll: () => void; checkAgain: () => void } {
  const [check, setCheck] = useState<WallCheck>("idle");
  const alive = useRef(true);
  const polling = useRef(false);
  const armed = useRef(false);
  const lastRead = useRef(0);
  const latest = useRef(opts);
  useEffect(() => { latest.current = opts; });

  const readOnce = useCallback(async (): Promise<boolean> => {
    lastRead.current = Date.now();
    let bound: ReturnType<typeof setTimeout> | undefined;
    try {
      const open = await Promise.race([
        latest.current.lifts(),
        new Promise<false>((resolve) => { bound = setTimeout(() => resolve(false), LIFT_READ_BOUND_MS); }),
      ]);
      if (open) {
        if (alive.current) latest.current.onLifted?.();
        return true;
      }
    } catch { /* no answer is not an answer: the wall stands and the schedule asks again */ } finally {
      clearTimeout(bound);
    }
    return false;
  }, []);

  const poll = useCallback(async (): Promise<void> => {
    if (polling.current || latest.current.onLifted === undefined) return;
    polling.current = true;
    armed.current = false;
    setCheck("checking");
    for (let i = 0; i < LIFT_POLL_MAX && alive.current; i += 1) {
      if (i > 0) await wait(LIFT_POLL_MS);
      if (!alive.current) break;
      if (await readOnce()) { polling.current = false; return; }
    }
    polling.current = false;
    if (alive.current) setCheck("pending");
  }, [readOnce]);

  const onReturn = useCallback((): void => {
    if (polling.current || latest.current.onLifted === undefined) return;
    if (armed.current) { void poll(); return; }
    if (Date.now() - lastRead.current < RETURN_DEBOUNCE_MS) return;
    void readOnce();
  }, [poll, readOnce]);

  useEffect(() => {
    alive.current = true;
    if (latest.current.onLifted !== undefined) {
      const billed = new URLSearchParams(window.location.search).get("billing") === "success";
      if (billed || handoffIsRecent(latest.current.owner)) void poll();
    }
    const onVisibility = (): void => { if (document.visibilityState === "visible") onReturn(); };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onVisibility);
    const minute = setInterval(() => {
      if (document.visibilityState === "visible" && !polling.current && latest.current.onLifted !== undefined) {
        void readOnce();
      }
    }, WALL_READ_MS);
    return () => {
      alive.current = false;
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(minute);
    };
  }, [onReturn, poll, readOnce]);

  const armPoll = useCallback(() => {
    armed.current = true;
    rememberHandoff(latest.current.owner);
  }, []);
  const checkAgain = useCallback(() => { void poll(); }, [poll]);
  return { check, armPoll, checkAgain };
}
