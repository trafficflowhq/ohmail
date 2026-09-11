"use client";

/**
 * Is this tab's session over? — one fact, one owner, read from every surface. When a session died server-side, every
 * request 401'd and the app kept looking alive: lists rendered from the mirror, counts froze, and the surfaced errors
 * were mislabeled as content failures — each surface reporting its own symptom of the one fact none of them held
 * (observed live, five surfaces at once).
 */

/**
 * This module owns the truth: a tiny external store the session machinery WRITES and any surface may READ. Writers
 * learn the truth first-hand: `session-refresh.ts` marks the session dead when `POST /auth/refresh` answers a coded
 * 401 (the one unambiguous "signed out" this product receives) and alive on every 204. Readers render the taxonomy
 * from the confirmed fact, never one request's evidence.
 */

/**
 * It lives in `shell/` with zero imports because the shell ships in the public desktop mirror, whose tier has no
 * Cloud session — `owner-cookie.ts`'s shape: no transport, resting answer "alive", every branch inert on that build.
 */

/**
 * The probe: ask, don't announce — the sync loop's first coded 401 is evidence, not confirmation, so on that evidence
 * a surface calls `probeSessionNow`, which asks the one endpoint whose answer is definitive (`registerSessionProbe`
 * plugs `resumeSession` in from `session-refresh.ts`, so no shell file imports the transport); a refresh that
 * succeeds heals silently, one that 401s confirms, and only then does any surface say "signed out". Revivals: every
 * `markSessionAlive` is a server-confirmed world change, published as an event so surfaces holding an auth-shaped
 * failure ask once more — bounded, at most once per successful refresh.
 */

import { useSyncExternalStore } from "react";

let dead = false;
let revivals = 0;

const deathListeners = new Set<() => void>();
const revivalListeners = new Set<() => void>();

/** The Cloud build's "try to mint a new session" — absent everywhere else. */
let probe: (() => void) | null = null;

/**
 * CONFIRMED: the server ended this session. Only a writer holding the server's own statement
 * may call it — today that is `resumeSession` on a coded 401 from `POST /auth/refresh`.
 */
export function markSessionDead(): void {
  if (dead) return;
  dead = true;
  for (const l of deathListeners) l();
}

/**
 * A session exists again — a 204 from `/auth/refresh` set fresh cookies. Clears the death flag
 * and publishes a revival, EVERY time: an ordinary idle-lapse refresh is also a world change,
 * and the subscribers act only when they hold an auth-shaped failure to heal.
 */
export function markSessionAlive(): void {
  if (dead) {
    dead = false;
    for (const l of deathListeners) l();
  }
  revivals += 1;
  for (const l of revivalListeners) l();
}

/** The confirmed fact. `false` is the resting answer on every build without a session client. */
export function sessionIsDead(): boolean {
  return dead;
}

export function subscribeSessionTruth(cb: () => void): () => void {
  deathListeners.add(cb);
  return () => deathListeners.delete(cb);
}

/**
 * Hear about every freshly minted session. Returns the unsubscribe; see the header for why the
 * event fires on every 204 rather than only on a dead→alive transition.
 */
export function subscribeSessionRevival(cb: () => void): () => void {
  revivalListeners.add(cb);
  return () => revivalListeners.delete(cb);
}

/** Cloud wiring: `session-refresh.ts` registers its single-flight `resumeSession` here. */
export function registerSessionProbe(fn: (() => void) | null): void {
  probe = fn;
}

/**
 * Ask the registered probe to settle the question NOW. Called by a surface that just received
 * auth-shaped evidence (a coded 401 on a read, the sync loop's unconfirmed refusal). A no-op
 * where nothing is registered, and safe to call repeatedly — the Cloud probe is single-flight.
 */
export function probeSessionNow(): void {
  probe?.();
}

const getDead = (): boolean => dead;
/** The server snapshot: a server render can never have observed a death. */
const getServerDead = (): boolean => false;

/** The confirmed fact, as a subscription — re-renders exactly when it changes. */
export function useSessionDead(): boolean {
  return useSyncExternalStore(subscribeSessionTruth, getDead, getServerDead);
}

/** Test seam: put the store back to its resting state between cases. */
export function resetSessionTruthForTests(): void {
  dead = false;
  revivals = 0;
  probe = null;
}

/** How many sessions have been minted since load — exposed for assertions, not for rendering. */
export function sessionRevivalCount(): number {
  return revivals;
}
