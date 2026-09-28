"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { markWallLifted } from "./access-window";
import { durableSessionSet, durableSet } from "./durable";

/**
 * WHEN THE ACCOUNT'S STANDING IS ASKED — one schedule, two users. {@link useAccessSchedule} asks on
 * every return to the window, on its `minute` while shown (`null`: never on a clock), and as a
 * bounded poll after a hand-off press (this tab, this half hour) or a `?billing=success` arrival.
 * The wall ({@link useWallLift}) lifts itself on the service's fresh `access: "open"` and nothing
 * else; the account strip reads the same schedule with no lift and no minute. A spent poll offers
 * one more.
 */

export const LIFT_POLL_MS = 2_000;
export const LIFT_POLL_MAX = 30;
export const WALL_READ_MS = 60_000;
/** A read that has not answered by then is no answer, so a hung request cannot hold the poll. */
export const LIFT_READ_BOUND_MS = 10_000;
/** Focus and visibility fire together on a tab switch; one read answers both. The access door joins inside it too. */
export const RETURN_DEBOUNCE_MS = 1_500;

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

export function useAccessSchedule(opts: {
  /** One fresh read; `true` ends a poll. Absent = a schedule that asks nothing. */
  read: (() => Promise<boolean>) | undefined;
  /** What a `true` answer does, beyond ending the poll. */
  onOpen?: () => void;
  /** A read this often while the tab is in front, or `null` for none. */
  minute: number | null;
  owner: string | null;
  /** How soon after the last read a return asks again. Default {@link RETURN_DEBOUNCE_MS}. */
  returnFloor?: () => number;
  /** When this client last had an answer, by any reader; the floor counts from the later of it and this schedule's own read. */
  lastAsked?: () => number;
}): { check: WallCheck; armPoll: () => void; checkAgain: () => void } {
  const [check, setCheck] = useState<WallCheck>("idle");
  const alive = useRef(true);
  const polling = useRef(false);
  const armed = useRef(false);
  const lastRead = useRef(0);
  const latest = useRef(opts);
  useEffect(() => { latest.current = opts; });
  const minute = opts.minute;

  const readOnce = useCallback(async (): Promise<boolean> => {
    const read = latest.current.read;
    if (read === undefined) return false;
    lastRead.current = Date.now();
    let bound: ReturnType<typeof setTimeout> | undefined;
    try {
      const open = await Promise.race([
        read(),
        new Promise<false>((resolve) => { bound = setTimeout(() => resolve(false), LIFT_READ_BOUND_MS); }),
      ]);
      if (open) {
        if (alive.current) latest.current.onOpen?.();
        return true;
      }
    } catch { /* no answer is not an answer: the schedule asks again */ } finally {
      clearTimeout(bound);
    }
    return false;
  }, []);

  const poll = useCallback(async (): Promise<void> => {
    if (polling.current || latest.current.read === undefined) return;
    polling.current = true;
    armed.current = false;
    setCheck("checking");
    for (let i = 0; i < LIFT_POLL_MAX && alive.current; i += 1) {
      if (i > 0) await wait(LIFT_POLL_MS);
      if (!alive.current) break;
      if (await readOnce()) { polling.current = false; if (alive.current) setCheck("idle"); return; }
    }
    polling.current = false;
    if (alive.current) setCheck("pending");
  }, [readOnce]);

  const onReturn = useCallback((): void => {
    if (polling.current || latest.current.read === undefined) return;
    if (armed.current) { void poll(); return; }
    const floor = latest.current.returnFloor?.() ?? RETURN_DEBOUNCE_MS;
    const last = Math.max(lastRead.current, latest.current.lastAsked?.() ?? 0);
    if (Date.now() - last < floor) return;
    void readOnce();
  }, [poll, readOnce]);

  useEffect(() => {
    alive.current = true;
    if (latest.current.read !== undefined) {
      const billed = new URLSearchParams(window.location.search).get("billing") === "success";
      if (billed || handoffIsRecent(latest.current.owner)) void poll();
    }
    const onVisibility = (): void => { if (document.visibilityState === "visible") onReturn(); };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onVisibility);
    const clock = minute === null ? undefined : setInterval(() => {
      if (document.visibilityState === "visible" && !polling.current && latest.current.read !== undefined) {
        void readOnce();
      }
    }, minute);
    return () => {
      alive.current = false;
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onVisibility);
      if (clock !== undefined) clearInterval(clock);
    };
  }, [onReturn, poll, readOnce, minute]);

  const armPoll = useCallback(() => {
    armed.current = true;
    rememberHandoff(latest.current.owner);
  }, []);
  const checkAgain = useCallback(() => { void poll(); }, [poll]);
  return { check, armPoll, checkAgain };
}

/** THE WALL'S SCHEDULE: a minute clock, and a `true` answer is the lift. */
export function useWallLift(opts: {
  /** One fresh read; `true` only when the service answered `access: "open"`. */
  lifts: () => Promise<boolean>;
  /** Absent = a wall with no way to lift, which asks nothing. */
  onLifted: (() => void) | undefined;
  owner: string | null;
}): { check: WallCheck; armPoll: () => void; checkAgain: () => void } {
  const { lifts, onLifted, owner } = opts;
  return useAccessSchedule({
    read: onLifted === undefined ? undefined : lifts,
    onOpen: onLifted === undefined ? undefined : () => { markWallLifted(); onLifted(); },
    minute: WALL_READ_MS,
    owner,
  });
}
