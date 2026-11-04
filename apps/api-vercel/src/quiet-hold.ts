import { AsyncLocalStorage } from "node:async_hooks";
import { waitUntil } from "@vercel/functions";
import { API_MAX_DURATION_MS, POOLED_IDLE_TIMEOUT_S } from "@trafficflow/db/cloud";
import { EVENTS_MAX_DURATION_S } from "./config.js";

/**
 * HOW LONG AN INSTANCE STAYS AWAKE AFTER ITS LAST ANSWER: just past the pool's idle close, so its idle
 * connections end before the platform suspends it. A suspended instance keeps its client connections
 * open at the pooler until it wakes; on 2026-10-26 those of ~160 cold instances filled the pooler's
 * client cap and every route failed for six minutes. No longer than that: the platform bills the
 * instance's whole memory for every second of the hold.
 */
export const QUIET_HOLD_MS = POOLED_IDLE_TIMEOUT_S * 1000 + 250;

/** How far inside its invocation's `maxDuration` a hold ends at the latest. */
const HOLD_MARGIN_MS = 5_000;

/** The hold that ended last. The next one to end releases it, so one invocation lingers per instance. */
let lingering: (() => void) | null = null;

/** The deadline of the invocation the current code runs in. */
const invocation = new AsyncLocalStorage<number>();

/** Release `release` after {@link QUIET_HOLD_MS}, sooner at `deadline` or when a later hold lingers. */
function linger(release: () => void, deadline: number): void {
  lingering?.();
  const timer = setTimeout(release, Math.max(0, Math.min(QUIET_HOLD_MS, deadline - Date.now())));
  (timer as { unref?: () => void }).unref?.();
  lingering = () => { clearTimeout(timer); release(); };
}

/** The ceiling of the invocation serving `url`: `/events` is the one route module with its own. */
function deadlineFor(url: string): number {
  let ceilingMs = API_MAX_DURATION_MS;
  try {
    if (new URL(url).pathname === "/events") ceilingMs = EVENTS_MAX_DURATION_S * 1000;
  } catch { /* the catch-all's ceiling */ }
  return Date.now() + ceilingMs - HOLD_MARGIN_MS;
}

/**
 * Run `answer` for `url` with a hold handed to the platform; `answer` gets the hold's end. Once ended
 * it lasts {@link QUIET_HOLD_MS}, less if a later hold ends or the invocation's ceiling is near: past
 * `maxDuration` the platform kills the invocation. Outside a request context `waitUntil` does nothing.
 */
export function withQuietHold<T>(url: string, answer: (end: () => void) => Promise<T>): Promise<T> {
  const deadline = deadlineFor(url);
  let release!: () => void;
  waitUntil(new Promise<void>((resolve) => { release = resolve; }));
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    linger(release, deadline);
  };
  return invocation.run(deadline, () => answer(end));
}

/**
 * Work handed to the platform after the answer (the entitlements refresh-behind). The instance stays
 * awake until it settles and then for a fresh quiet hold, inside its invocation's ceiling, so a
 * connection the work opened late closes before the instance is suspended.
 */
export function handOff(work: Promise<unknown>): void {
  const deadline = invocation.getStore() ?? Date.now() + API_MAX_DURATION_MS - HOLD_MARGIN_MS;
  waitUntil(new Promise<void>((release) => {
    void work.then(() => undefined, () => undefined).then(() => linger(release, deadline));
  }));
}
