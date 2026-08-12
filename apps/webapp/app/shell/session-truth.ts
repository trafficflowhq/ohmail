"use client";

/**
 * ═══ IS THIS TAB'S SESSION OVER? — one fact, one owner, read from every surface ═══════════════
 *
 * ── THE DEFECT THIS ENDS ────────────────────────────────────────────────────────────────────
 *
 * When a session died server-side (revocation, expiry of the refresh family), every request
 * 401'd and the app KEPT LOOKING ALIVE: lists rendered from the local mirror, counts froze, and
 * the errors that did surface were mislabeled as content failures — "Couldn't load the full
 * message", "Couldn't load this message's files" — each surface reporting its own symptom of the
 * one fact none of them held. No sign-in prompt, no banner, nothing that said "your session
 * ended". Observed in live use, on five surfaces at once.
 *
 * The fix is a fact with ONE owner. This module is that owner: a tiny external store the session
 * machinery WRITES and any shell surface may READ. It decides nothing itself — it cannot, and
 * that is the design:
 *
 *  · WRITERS are the modules that learn the truth first-hand. `app/session-refresh.ts` marks the
 *    session dead when `POST /auth/refresh` answers a coded 401 — the server's own statement
 *    that the refresh family is gone and the cookie jar has been cleared, which is the one
 *    unambiguous "you are signed out" this product ever receives — and marks it alive again on
 *    every 204, each of which is a freshly minted session.
 *  · READERS are shell surfaces: the re-auth prompt in `engine.tsx`, the body-failure note in
 *    `MessagePane`, the attachments seam. They render the taxonomy ("your session ended" vs.
 *    "this content failed") from the confirmed fact, never from one request's evidence.
 *
 * ── WHY IT LIVES IN `shell/` WITH ZERO IMPORTS ─────────────────────────────────────────────
 *
 * `apps/webapp/app/shell/**` ships in the public desktop mirror, and the desktop tier has no
 * Cloud session, no cookies and no `/auth/refresh` — `scripts/publish-desktop.mjs` DENYs
 * `app/api-client` for exactly that boundary. So this module follows `owner-cookie.ts`'s shape:
 * it imports nothing but React, holds no transport, and its resting answer is "alive". On the
 * desktop nothing ever writes to it, every reader sees the resting value, and every branch that
 * hangs off it is inert — the seam costs that build nothing, which is the same argument
 * `OwnerResolver` makes in `engine.tsx`.
 *
 * ── THE PROBE: ASK, DON'T ANNOUNCE ─────────────────────────────────────────────────────────
 *
 * The sync loop's first coded 401 is evidence, not confirmation — `sync-scheduler.ts` spends
 * sixty seconds confirming before it will say "sign in", because a transient 401 told a
 * signed-in user they were signed out once already. This store keeps that discipline and adds
 * the faster honest move: on that first evidence, ASK the one endpoint whose answer is
 * definitive. `registerSessionProbe` is where the Cloud build plugs `resumeSession` in
 * (registered from `session-refresh.ts` itself, so no shell file imports the transport), and
 * `probeSessionNow` is what a shell surface calls when it holds auth-shaped evidence. A refresh
 * that succeeds heals the tab silently; one that answers 401 confirms the death, and only then
 * does any surface say "signed out". Unregistered — the desktop, the demo, a bare test — the
 * probe is a no-op.
 *
 * ── REVIVALS: THE SIGNAL THAT CLEARS STUCK FAILURES ────────────────────────────────────────
 *
 * A failure recorded while the session was bad outlives the recovery: the engine deliberately
 * never re-asks a server that refused (the render-loop argument in `engine.ts`), so a
 * "Couldn't load this message's files" from a five-minute auth outage stood for the rest of the
 * session. Every `markSessionAlive` is a server-confirmed world change — a real 204 minting a
 * real session — so it is published as a REVIVAL event, and the surfaces holding an auth-shaped
 * failure use it to ask once more. Bounded by construction: revivals happen at most once per
 * successful refresh, and each subscriber re-asks only what it can see is auth-failed.
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
