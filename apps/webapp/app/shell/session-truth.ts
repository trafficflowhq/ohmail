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

/**
 * THE BOUNDED WAY BACK. A confirmed death used to leave every surface free to keep asking: a
 * production tab polled three routes about twice a second for eight minutes, and each refusal
 * started a refresh that was refused the same way. So the death arms a SCHEDULE — one refresh
 * attempt per widening step (`SESSION_HEAL_BACKOFF_MS`) — and `sessionMayAsk` closes every other
 * door until the schedule, or a sign-in in another tab, mints a session. The schedule is the
 * engine's (`@ohmail/client-engine`, no transport, inert where nothing registers a probe), so the
 * browser, the desktop and the phone all wait the same way.
 */

import { useSyncExternalStore } from "react";
import { createSessionHeal, type SessionHeal } from "@ohmail/client-engine";

let dead = false;
let revivals = 0;

const deathListeners = new Set<() => void>();
const revivalListeners = new Set<() => void>();

/** The Cloud build's "try to mint a new session" — absent everywhere else. */
let probe: (() => void) | null = null;

/**
 * Built once, lazily, and never rebuilt: a second schedule over one death is the hot loop this
 * exists to end. It calls the probe the Cloud build registered; where none is registered every
 * step is a no-op, which is the desktop's resting behaviour and costs one timer.
 */
let heal: SessionHeal | null = null;
const healSchedule = (): SessionHeal => (heal ??= createSessionHeal(() => probe?.()));

/**
 * CONFIRMED: the server ended this session. Only a writer holding the server's own statement
 * may call it — today that is `resumeSession` on a coded 401 from `POST /auth/refresh`.
 */
export function markSessionDead(): void {
  if (dead) return;
  dead = true;
  // Armed BEFORE the listeners run: a listener that reads the store must find the tab already in
  // its settled dead state, schedule and all, rather than halfway into it.
  healSchedule().arm();
  for (const l of deathListeners) l();
}

/**
 * A session exists again — a 204 from `/auth/refresh` set fresh cookies. Clears the death flag
 * and publishes a revival, EVERY time: an ordinary idle-lapse refresh is also a world change,
 * and the subscribers act only when they hold an auth-shaped failure to heal.
 */
export function markSessionAlive(): void {
  // Disarmed FIRST and unconditionally: an ordinary idle-lapse refresh is also a 204, and a
  // schedule left running behind one would keep asking for a session this tab already holds.
  healSchedule().disarm();
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
  // A CONFIRMED DEATH OWNS ITS OWN ASKING. Every surface holding auth-shaped evidence calls this,
  // and under a dead session every surface holds some — so answering each one with a refresh is
  // the poll storm with a different name on it. The schedule armed by `markSessionDead` is the
  // only thing that asks from here on, and it asks at most once per step.
  if (dead) return;
  probe?.();
}

/**
 * MAY THIS CLIENT ASK THE SERVER ANYTHING? — read by `api()` and handed to the engine's transport.
 *
 * `false` only under a CONFIRMED death, so every ordinary failure, including an unconfirmed 401,
 * leaves every door exactly where it was. The sign-in ceremony and the refresh itself are not
 * asked: they are how the answer changes (`api()` names them by the list it already keeps).
 */
export function sessionMayAsk(): boolean {
  return !dead;
}

/** How many heal attempts the current death has made — exposed for assertions, not for rendering. */
export function sessionHealAttempts(): number {
  return heal?.attempts() ?? 0;
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
  heal?.disarm();
  dead = false;
  revivals = 0;
  probe = null;
}

/** How many sessions have been minted since load — exposed for assertions, not for rendering. */
export function sessionRevivalCount(): number {
  return revivals;
}
