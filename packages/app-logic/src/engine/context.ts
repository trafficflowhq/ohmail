"use client";

/**
 * The engine's context and the hooks that read it, cut out of `engine.tsx` as they stood. The
 * provider stays with the shell: what mounts an engine is a shell's, what reads one is behaviour.
 */
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import { NOT_DERIVED_FROM, type AbandonedMutation, type EntityReader, type MirrorFreshness, type OhmailEngine } from "@ohmail/client-engine";
import type { SyncStatus } from "../session/sync-scheduler.js";

/**
 * Whose mailbox is this? Three-valued, and that is the fix: a single `null` once meant both "the server says no full
 * session" and "the server did not answer", so one 503 on the confirm told a signed-in user "You are signed out."
 * (measured in production; AUTH-FLICKER-DIAGNOSIS.md). `owner` — the server named an account. `none` — the server
 * ANSWERED that there is none (enrollment-scoped session, the refresh endpoint's coded 401); rendered at once, no
 * retry. `unknown` — no answer (5xx, 429, dead socket, uncoded 401); retried on `confirm-schedule.ts`, then reported
 * as a check that did not finish — never a claim about the account. `retryAfterMs` seeds the backoff. Still a prop:
 * this file ships in the desktop bundle, which has no session client; CloudShell passes the implementation,
 * classified through `(product)/session-outcome.ts`.
 */
export type OwnerOutcome =
  | { kind: "owner"; accountId: string }
  | { kind: "none" }
  | { kind: "unknown"; retryAfterMs: number | null };

export type OwnerResolver = () => Promise<OwnerOutcome>;

/**
 * An engine the host already owns — the third way this provider can get
 * one, and the only one that involves no decision here. The demo builds a
 * fixtures engine; a Cloud tab builds a network engine once it knows whose
 * mailbox it holds; the desktop is neither — its mail comes from a process
 * on the same machine over a channel this shared file must never learn
 * about, so the app builds the engine where the channel is and hands the
 * finished object in. Same shell, no fork. It does NOT buy a way to turn
 * the demo off: the initializer checks `demo` first and returns.
 */
export type ProvidedEngine = OhmailEngine;

export interface EngineBinding {
  engine: OhmailEngine;
  /** The mode the ENGINE was actually built in — client truth, never the server's guess. */
  demo: boolean;
  /** What the server rendered with, so hydration has a snapshot that matches the markup. */
  serverDemo: boolean;
  /** What the sync loop is doing, for the views that must say so. Always settled in demo. */
  sync: SyncStatus;
}

export const EngineContext = createContext<EngineBinding | null>(null);

function useBinding(): EngineBinding {
  const binding = useContext(EngineContext);
  if (!binding) throw new Error("useEngine must be used inside <EngineProvider>");
  return binding;
}

export function useEngine(): OhmailEngine {
  return useBinding().engine;
}

/**
 * The engine if this tree has one — {@link useEngine}'s non-throwing sibling, and the same
 * carve-out `useMailboxFacts` makes for the same reason. `MessagePane` and `MessageCard` are
 * published to the desktop mirror and mounted with no provider in several harnesses; they take
 * their body subscription through this (`body-slice.ts`), and a throw there would take a reading
 * surface down over a subscription it can simply not have. `null` means exactly one thing:
 * nothing here will ever publish, so there is nothing to wait for.
 */
export function useEngineOrNull(): OhmailEngine | null {
  return useContext(EngineContext)?.engine ?? null;
}

/**
 * What the sync loop is doing, for the surfaces that have to say so.
 *
 * A hook rather than a prop threaded through `AppShell` for the same reason the scheduler is
 * not a prop: passing this down four levels would make forgetting it the default. Two
 * consumers now — `SyncBar`, which reports a failing loop above the deck in every view, and
 * the Ohbox's empty state, which uses it to stop counting. The demo and the desktop read a
 * permanently settled value, so neither renders anything new.
 */
export function useSyncStatus(): SyncStatus {
  return useBinding().sync;
}

/** Nothing to subscribe to — the mode is decided once per engine, at construction. */
const NEVER_CHANGES = (): (() => void) => () => {};

/**
 * The mode the UI should render, hydration-safe.
 *
 * `useSyncExternalStore`'s third argument is the SERVER snapshot: React renders that during
 * hydration (so the markup matches byte for byte, no mismatch warning) and switches to the
 * client snapshot in the very next render. The engine is already the client's, so the only
 * thing this defers by one render is chrome — the demo ribbon and the frozen demo clock.
 */
/**
 * The client's own answer, without the hydration snapshot — for effects, never for render.
 * {@link useDemoMode} returns `serverDemo` on the hydration render so the markup matches the
 * server, and the client answer after. Right for anything drawn; wrong for anything an effect
 * DOES: a prerendered route bakes `searchParams = {}`, so `serverDemo` is false while
 * `resolveDemo` turns the demo on from `window.location.search` — an effect gated on the
 * hydration value fired once, on a demo page, believing it was not one (real network calls from
 * a fixtures-only page). Reading this in render output would reintroduce the mismatch.
 */
export function useResolvedDemoMode(): boolean {
  return useBinding().demo;
}

export function useDemoMode(): boolean {
  const { demo, serverDemo } = useBinding();
  return useSyncExternalStore(NEVER_CHANGES, () => demo, () => serverDemo);
}

/**
 * The server snapshot for {@link useFreshness}: hydration renders "unknown" — which paints
 * nothing — and the client's own answer takes over in the very next render, the same bargain
 * {@link useDemoMode} strikes. One module-level identity, because `useSyncExternalStore`
 * requires a stable snapshot while nothing changed.
 */
const FRESHNESS_UNKNOWN: MirrorFreshness = { state: "unknown", asOf: null };

/**
 * THE FRESHNESS CONTRACT'S VERDICT for this engine's mirror (INSTANT-ARCH §6.6) — what the
 * sync line's "as of <time> · catching up" arm keys on. The engine is the one derivation
 * (`OhmailEngine.freshness()`, value-cached for exactly this hook); the drain announces its
 * settle with a notify after stamping, so the label clears here the moment the mirror is
 * current rather than at the next coincidental re-render.
 */
export function useFreshness(): MirrorFreshness {
  const engine = useEngine();
  const subscribe = useCallback((cb: () => void) => engine.subscribe(cb), [engine]);
  return useSyncExternalStore(subscribe, () => engine.freshness(), () => FRESHNESS_UNKNOWN);
}

/**
 * The server-snapshot for {@link useAbandoned} — hydration renders nothing, exactly as
 * {@link FRESHNESS_UNKNOWN} does. One module-level identity because `useSyncExternalStore`
 * compares snapshots by reference and a fresh `[]` per render is an infinite loop.
 */
const NO_ABANDONED: readonly AbandonedMutation[] = Object.freeze([]);

/**
 * The changes this client gave up on — what the "could not be saved" strip
 * and its sheet read. The engine value-caches `abandoned()` for exactly
 * this hook (the `freshness()` bargain), so the snapshot is stable while
 * the set is unchanged. Deliberately NOT folded into the sync bar's
 * speech: `SyncBar` returns null whenever sync has nothing to say — the
 * ordinary healthy case, which is precisely when an abandoned change is
 * most likely (syncing fine, one verb refused). Reusing it would hide the
 * notice in the state where it matters most.
 */
export function useAbandoned(): readonly AbandonedMutation[] {
  const engine = useEngine();
  const subscribe = useCallback((cb: () => void) => engine.subscribe(cb), [engine]);
  return useSyncExternalStore(subscribe, () => engine.abandoned(), () => NO_ABANDONED);
}

/**
 * Subscribe to the engine; returns the overlay-aware mirror version so memoized selectors
 * recompute when an entity changes. "And only then" was false in the costly direction: a
 * rowless `/sync` page and the drain's completion stamp both bumped the version, so an idle
 * client rebuilt every whole-mirror derivation each poll — both closed in `store.ts`. What it
 * means exactly: the mirror AS THIS READER SEES IT moved — the overlay-merged version
 * (`store.version() * 1_000_003 + overlayRev`), so registering or retiring an overlay moves it
 * with no stored record touched, which is right. It does not say the reverse: a surface can
 * still re-render for its own reasons.
 */
export function useEngineVersion(): number {
  const engine = useEngine();
  const subscribe = useCallback((cb: () => void) => engine.subscribe(cb), [engine]);
  return useSyncExternalStore(
    subscribe,
    () => engine.read().version(),
    () => 0,
  );
}

/**
 * TYPES NO WHOLE-MIRROR DERIVATION READS — the deny list {@link useDerivedVersion} asks with, now
 * the engine package's (`derived-stamp.ts`) so the phone keys on the same list. Re-exported here
 * under the name the shell and its census import. `derived-stamp-census.test.ts` refuses an entry
 * the selectors do read.
 */
export { NOT_DERIVED_FROM };

/**
 * THE VERSION OF WHAT THE WINDOW DERIVES FROM — {@link useEngineVersion} minus the bodies.
 *
 * Every whole-mirror pass the shell holds used to key on the global version, which moves for ANY
 * record write, and most writes are bodies: an open writes three and the eager pass one per
 * message. Counted against the real shell, ONE body publish cost 20 whole-mirror passes — against
 * 23 for a `/sync` page of two hundred messages. It does not replace {@link useEngineVersion}: a
 * body must still reach the reader waiting for it, which is a render rather than a derivation
 * (`body-slice.ts` holds that subscription).
 */
export function useDerivedVersion(): number {
  const engine = useEngine();
  const subscribe = useCallback((cb: () => void) => engine.subscribe(cb), [engine]);
  return useSyncExternalStore(
    subscribe,
    // …AND A BODY THAT DECIDES A PLACEMENT: the partition reads the text of a message whose sender
    // a body-term rule names, and the engine moves `placementStamp` for exactly those bodies.
    () => Math.max(engine.read().stampExcept(NOT_DERIVED_FROM), engine.placementStamp()),
    () => 0,
  );
}

/**
 * WHICH SEARCH INDEX ANSWERED — {@link OhmailEngine.searchIndexRevision}, subscribed.
 *
 * The instant index lags the mirror on purpose: rebuilding it on every version bump is a
 * whole-mirror walk per keystroke, which is what froze the window. So a build SETTLING is a
 * change to what search can answer with no record having moved, and the search view keys on this
 * beside {@link useDerivedVersion}. The engine notifies when a build settles, which is what makes
 * this a live value rather than a number read once.
 */
export function useSearchIndexRevision(): number {
  const engine = useEngine();
  const subscribe = useCallback((cb: () => void) => engine.subscribe(cb), [engine]);
  return useSyncExternalStore(
    subscribe,
    () => engine.searchIndexRevision(),
    () => 0,
  );
}

/** The overlay-merged reader (stable object; version() tracks change). */
export function useReader(): EntityReader {
  return useEngine().read();
}
