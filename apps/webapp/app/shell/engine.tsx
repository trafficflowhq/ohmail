"use client";

/**
 * Engine wiring: ONE OhmailEngine per tab, boots in an effect, and the
 * UI reads it through useSyncExternalStore so every selector recomputes
 * exactly when the mirror (or the optimistic overlay) changes.
 *
 * Demo mode: FixturesAdapter + in-memory mirror — boots instantly, zero
 * network. Stage 2: HttpAdapter + IndexedDB mirror behind
 * NEXT_PUBLIC_API_BASE, same engine, same UI.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import { OhmailEngine, type EntityReader } from "@ohmail/client-engine";
import { isDemoRequested } from "../demo-mode";
import { cloudWakeStream, createEngine, EngineUnarmedError, syncsWhileHidden } from "./engine-config";
import { useLoadingGrace } from "./loading-grace";
import { readOwner } from "./owner-cookie";
import { markSessionAlive, probeSessionNow, useSessionDead } from "./session-truth";
import {
  sameSyncStatus,
  startSyncScheduler,
  SYNC_BOOTSTRAPPING,
  SYNC_SETTLED,
  type SyncStatus,
} from "./sync-scheduler";

/**
 * "Whose mailbox is this?", as a function the SHELL does not know how to answer.
 *
 * Resolves to a server-verified account id, or `null` for every refusal — expired,
 * revoked, enrollment-scoped, unreachable. It is a PROP rather than an import because this
 * file is shared: `apps/desktop` renders the same `AppShell` from a bundle that has no
 * account, no server and no `/auth` client at all (`scripts/publish-desktop.mjs` DENYs
 * `app/api-client`, and `vite.config.ts` aliases the sync adapter to a stub that throws).
 * Importing the Cloud's session client here would drag both into a tier that must not have
 * them. The Cloud client passes its implementation from `(product)/mailbox/CloudShell.tsx`;
 * the desktop passes nothing and never leaves the demo.
 */
export type OwnerResolver = () => Promise<string | null>;

/**
 * AN ENGINE THE HOST ALREADY OWNS — the third way this provider can get one, and the only one
 * that does not involve a decision taken here.
 *
 * Two of the three are decisions: the demo builds a fixtures engine, and a Cloud tab builds a
 * network engine once it knows whose mailbox it holds. The desktop app is neither. Its mail comes
 * from a process on the same machine, reached over a channel that is not `fetch` and that this
 * shared file must never learn about — so the app builds the engine where the channel is, and
 * hands the finished object in.
 *
 * What that buys is the same thing {@link OwnerResolver} buys: the desktop keeps rendering this
 * exact shell, with no fork and no second copy of the wiring, while the two builds keep their
 * own transports. What it does NOT buy is a way to turn the demo off — see the initializer, where
 * `demo` is still checked first and still returns.
 */
export type ProvidedEngine = OhmailEngine;

interface EngineBinding {
  engine: OhmailEngine;
  /** The mode the ENGINE was actually built in — client truth, never the server's guess. */
  demo: boolean;
  /** What the server rendered with, so hydration has a snapshot that matches the markup. */
  serverDemo: boolean;
  /** What the sync loop is doing, for the views that must say so. Always settled in demo. */
  sync: SyncStatus;
}

/**
 * WHAT THIS TAB HAS, and the states that are not yet a confirmed mailbox.
 *
 * The live engine's mirror persists into IndexedDB, and a persistent mirror has to be NAMED for
 * the account it holds — `engine-config.ts` explains the cross-account leak that a single
 * un-owned database produced. The id has to be one the SERVER issued, so for a while the shell
 * could not build a live engine at first render at all: it asked `GET /auth/session`, and until
 * that answered there was no engine and nothing honest to render.
 *
 * ── `warm` IS HOW THAT WAIT WENT AWAY WITHOUT THE CHECK GOING AWAY ──────────────────────────
 *
 * The browser already knows the answer from last time, in a cookie the API sets beside the
 * session and the client may read (`owner-cookie.ts`). That is enough to OPEN the mirror — which
 * is a local read, of mail this browser already holds — but it is not enough to BELIEVE, because
 * a cookie is not a session and this browser's may have been revoked an hour ago.
 *
 * So the two are separated. `warm` builds the engine and paints from the device immediately,
 * while the same `GET /auth/session` runs in parallel and decides what happens next. The check
 * is not weakened by one step: an answer that does not match, or does not come, tears the engine
 * down and lands on the same refusal surface as before.
 *
 * "Immediately" means the first frame the browser paints, and NOT the first render — the server
 * rendered this page without that cookie, so the render that hydrates its markup has to say what
 * the server said. See `browserPass` below for the one render of difference and why it costs
 * nothing.
 *
 * `resolving` is still the honest state for a browser with no remembered account, and it is the
 * only state the desktop client ever takes here.
 */
type Binding =
  | { status: "ready"; demo: boolean; engine: OhmailEngine }
  /**
   * Live: the mirror is open and painting from a REMEMBERED account id, and the server has not
   * yet said whether that is the account it agrees this browser holds.
   */
  | { status: "warm"; owner: string; engine: OhmailEngine }
  /** Live: the account id has been asked for and has not come back. */
  | { status: "resolving" }
  /** Live: the API would not confirm a full session for this browser. */
  | { status: "unauthenticated" };

const EngineContext = createContext<EngineBinding | null>(null);

/**
 * THE mode decision, taken where the real URL is guaranteed to exist.
 *
 * `serverDemo` is a floor, never a ceiling: the client may turn the demo ON (the server
 * cannot see a query string it was never rendered with — see `app/demo-mode.ts`) and may
 * never turn it OFF (a URL must not be able to downgrade a `NEXT_PUBLIC_DEMO` build into a
 * network client). On the server `window` is absent and the answer is simply `serverDemo`.
 */
function resolveDemo(serverDemo: boolean): boolean {
  if (serverDemo) return true;
  if (typeof window === "undefined") return false;
  return isDemoRequested(window.location.search);
}

/**
 * `useLayoutEffect` in a browser; `useEffect` where there is nothing to lay out.
 *
 * The choice is made ONCE, at module scope, because React requires the hooks a component calls to
 * be the same on every render — a condition inside the component would be a different hook on the
 * server and in the browser. Rendering `useLayoutEffect` on a server is also a warning in its own
 * right ("it does nothing there"), and it is a fair one: there is no commit and no paint, so the
 * effect that runs is neither.
 *
 * What the browser branch buys is the ORDER. A layout effect runs inside the commit, before the
 * browser paints and before passive effects, so a state flip made there is on screen in the same
 * frame — which is the whole reason the warm open can be moved off the hydration render without
 * anybody seeing an extra one.
 */
const useAfterHydration = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function EngineProvider({
  demo: serverDemo,
  engine: provided,
  resolveOwner,
  children,
}: {
  demo: boolean;
  /** See {@link ProvidedEngine}. Absent everywhere but the desktop app. */
  engine?: ProvidedEngine;
  resolveOwner?: OwnerResolver;
  children: ReactNode;
}) {
  // A mode change after mount (a client-side navigation from `/` to `/?demo=1`, or the
  // reverse) must REPLACE the engine, not keep the one built for the other mode. Capturing
  // it once was how a live→demo navigation kept the network engine alive behind a page that
  // says "nothing leaves this tab". Turning the demo OFF drops back to `"resolving"` rather
  // than to a live engine, because the account id has to be re-established before anything
  // may touch persistence again.
  const desired = resolveDemo(serverDemo);

  /**
   * The initializer runs during the FIRST render on each side — which on the client is the
   * hydration render, where `window.location` is already the user's real URL. So the DEMO
   * engine is built from the resolved mode before a single effect (and therefore before a
   * single request) can run: there is no window in which a `?demo=1` page holds an
   * HttpAdapter, and the demo still paints without waiting for anything.
   *
   * `"resolving"` is what everything else starts as, INCLUDING a browser that remembers whose
   * mailbox this is. The warm open is one render later and {@link browserPass} is why.
   */
  const [binding, setBinding] = useState<Binding>(() => {
    const demo = resolveDemo(serverDemo);
    if (demo) return { status: "ready", demo, engine: createEngine(demo) };
    /**
     * A HOST-BUILT ENGINE IS ALREADY THE ANSWER, and it is checked here — after the demo and
     * before everything else.
     *
     * After the demo, because the ordering above is the safety property: nothing may make a
     * `demo: true` render run against a non-fixtures engine, and an argument is not an
     * exception to that. Before everything else, because the two questions the branches below
     * ask — is there a remembered account, can this build confirm one — are questions about a
     * mailbox reached over the network. This engine was built by the process that holds the
     * mailbox; there is no owner to look up and no session to confirm.
     */
    if (provided) return { status: "ready", demo: false, engine: provided };
    return { status: "resolving" };
  });

  /**
   * ═══ THE HYDRATION RENDER BELONGS TO THE SERVER, AND EXACTLY ONE THING HERE FORGOT ═══════
   *
   * `false` on the first render on each side, `true` from the second on the client — a
   * deliberate boundary between "what both sides can know" and "what only a browser knows".
   *
   * ── WHAT IT FIXES ────────────────────────────────────────────────────────────────────────
   *
   * The warm open used to happen in the initializer above: `readOwner()` in the first render,
   * which on the client is the HYDRATION render. The server cannot read that cookie and so had
   * rendered the near-empty session gate, while the client's first render produced the entire
   * mail client. React compares the two, finds a different tree at every level, and reports it —
   * eight hydration mismatches and one "the whole root is switching to client rendering" per
   * signed-in load. That last one is not a warning: it THROWS AWAY the server's markup and
   * re-renders everything from scratch, which is a real cost paid on the exact load the warm
   * open exists to make fast.
   *
   * ── WHY IT IS NOT A SUPPRESSED WARNING ───────────────────────────────────────────────────
   *
   * `suppressHydrationWarning` silences the report and keeps the mismatch, which here is the
   * whole application: React would still discard and re-render. The divergence has to be moved,
   * not muted, and the place to move it to is the boundary below — the first render matches
   * because it makes the same claim the server made, and the browser's own knowledge is applied
   * on the render after it.
   *
   * ── AND WHY IT COSTS NOTHING THE WARM OPEN WAS BUYING ────────────────────────────────────
   *
   * A LAYOUT effect, not a passive one. It runs in the same commit, before the browser paints,
   * so the extra render is not a frame anybody sees: hydration commits the gate, this flips, the
   * mail renders, and the first paint of the page is the mail. What the warm open promised was
   * "paint from the device rather than wait for a round trip", and no round trip has moved.
   */
  const [browserPass, setBrowserPass] = useState(false);
  useAfterHydration(() => {
    setBrowserPass(true);
  }, []);

  /**
   * THE WARM OPEN, one render after hydration.
   *
   * `readOwner()` is a synchronous cookie read with no side effects, which is what makes it
   * legal in a render, and this is React's own "adjusting state when a prop changes" shape — the
   * component re-renders before anything is committed, so nothing paints in between.
   *
   * Three conditions gate it, and every one is load-bearing:
   *
   *  · past the hydration render. See {@link browserPass}.
   *  · a remembered id. Without one there is no name for the mirror, and guessing one is the
   *    bug this whole seam exists to prevent. `"resolving"` is that fact, spelled.
   *  · a `resolveOwner`. A build with no way to ASK cannot be allowed to open a mailbox on a
   *    cookie alone — the confirmation is what makes the optimism safe, so a client that cannot
   *    confirm does not get to be optimistic. This is also what keeps the desktop client, which
   *    passes no resolver and has no cookie either, on exactly the path it was on.
   */
  if (browserPass && binding.status === "resolving" && !desired && !provided && resolveOwner) {
    const remembered = readOwner();
    if (remembered !== null) {
      setBinding({ status: "warm", owner: remembered, engine: createEngine(false, undefined, remembered) });
    }
  }

  useEffect(() => {
    /**
     * A HOST THAT HANDS IN A DIFFERENT ENGINE IS SAYING "THIS IS A DIFFERENT MAILBOX NOW", and
     * the binding has to follow it. The desktop builds one engine per mailbox its shell reports
     * serving, so a person who switches to another mailbox gets a new object — and a provider
     * that kept the first one would go on rendering the previous mailbox's mail under the new
     * mailbox's name. Adopting it here rather than asking every caller to remember a `key` keeps
     * the failure out of the wiring: forgetting a prop is silent, and this is not.
     *
     * The demo still wins, checked first, exactly as it is in the initializer.
     */
    if (!desired && provided && !(binding.status === "ready" && binding.engine === provided)) {
      setBinding({ status: "ready", demo: false, engine: provided });
      return;
    }
    if (binding.status === "ready" ? desired === binding.demo : !desired) return;
    // TWO TEARDOWNS, and only one of them is this line's.
    //
    // The engine owns no TIMERS — nothing schedules a drain from inside it, and
    // `attachWakeSignal()` is a hook this app does not use. It can nevertheless be BUSY: a
    // drain pages until `hasMore` is false, which on a cold account is ~37 requests over ten
    // seconds or more. So "replacing the reference is safe because there is nothing running
    // inside the object being dropped" — which is what stood here — was false, and it is
    // exactly how a live→demo navigation kept issuing live `/sync` calls from behind a page
    // that promises zero egress, which a self-contained surface has to mean literally.
    //
    // The SCHEDULER is where the timer and the two window listeners live, and it is torn down
    // by the effect below rather than by this assignment. Its dependency is `engine`, so React
    // runs that cleanup before the new engine's scheduler starts — and that cleanup now closes
    // the engine's per-page abort gate (`sync-scheduler.ts`), so the in-flight drain stops at
    // its next page boundary. A live→demo navigation cancels the poll AND the drain on the way
    // out; it does not merely stop caring about them.
    setBinding(
      desired ? { status: "ready", demo: true, engine: createEngine(true) } : { status: "resolving" },
    );
  }, [desired, binding, provided]);

  /**
   * ASK WHOSE MAILBOX THIS IS, then build the engine that persists it.
   *
   * {@link OwnerResolver} asks the same question `middleware.ts` already answered before
   * this route was served, and asking it again from the browser is not redundant: the
   * middleware proved a session existed at request time and told the shell nothing about
   * WHO, and the account id is what names the mirror. It is also the honest re-check — a
   * session revoked between the two is a session this tab must not open a mailbox for.
   *
   * Every refusal, and every failure, lands on `"unauthenticated"`. That is a rendered
   * explanation and a link, NOT an automatic redirect: middleware and this call reach the
   * API by different routes (edge → `api.ohmail.app` directly, browser → the `/api` rewrite),
   * so a disagreement between them is possible, and a redirect on disagreement is an
   * infinite loop between `/` and `/`.
   */
  useEffect(() => {
    if (binding.status !== "resolving" && binding.status !== "warm") return;
    /**
     * NOT ON THE HYDRATION COMMIT — and this line is what keeps the check to ONE request.
     *
     * The warm open is decided on the render after hydration ({@link browserPass}), so on the
     * commit before it every browser looks like a browser with no remembered account. Asking
     * there would spend a session check against `"resolving"` and then, a moment later, another
     * one against the `"warm"` binding this effect's own dependency list would have re-run it
     * for. Waiting one commit costs nothing — the flip is a layout effect, so it happens before
     * the browser has painted — and it means the question is asked once, against the binding
     * that is actually on screen.
     */
    if (!browserPass) return;
    // No resolver ⇒ this build cannot establish an owner, so it cannot open a persistent
    // mailbox. Refusing is the only correct answer; guessing an owner is the bug.
    if (!resolveOwner) {
      setBinding({ status: "unauthenticated" });
      return;
    }
    /**
     * THE ENGINE ALREADY PAINTING, if there is one. Captured here rather than rebuilt below,
     * and that is the difference between a warm open and a flicker: confirming a mirror that is
     * already on screen must not replace it. A second `createEngine` for the same account would
     * open the same database again, hydrate it again, and restart the drain from the same
     * cursor — a visible re-mount of the whole shell as a reward for being right.
     */
    const warm = binding.status === "warm" ? binding : null;
    let cancelled = false;
    void resolveOwner()
      .then((owner) => {
        if (cancelled) return;
        if (typeof owner !== "string" || owner === "") {
          setBinding({ status: "unauthenticated" });
          return;
        }
        /**
         * A CONFIRMED OWNER DISPROVES A HELD SESSION DEATH — and the latch has to be told,
         * because the death store is module state and a sign-in is a CLIENT-SIDE navigation.
         * Found in live verification: visiting `/login` signed out runs `auth.session()`,
         * whose 401 sends `api()` through the refresh, whose own coded 401 (no refresh
         * cookie is a session death, truthfully) latches the store — and `router.push("/")`
         * then carried that latch into the freshly signed-in shell, which rendered the
         * "signed out" prompt over a session the server had just confirmed. This resolver's
         * answer IS the server's own "this browser holds a full session", read at exactly
         * the boundary every sign-in re-crosses, so it is where the claim is withdrawn.
         * A mid-use death is untouched: nothing re-runs this resolver on a live binding.
         */
        markSessionAlive();
        if (warm) {
          /**
           * THE SHARED-BROWSER CASE, AND THE ONLY REASON THE CHECK IS A COMPARISON RATHER THAN
           * A PRESENCE TEST.
           *
           * "The server confirmed a session" is not the question. The question is whether it
           * confirmed THIS one — the account whose mirror is on screen. A browser can hold a
           * remembered id for one account and a live session for another (somebody signed in
           * again elsewhere in the same profile, a restored cookie jar, a hand-edited value),
           * and in that state the rows already painted belong to neither the session nor the
           * person looking at them.
           *
           * A mismatch therefore ends the tab rather than swapping the engine underneath it.
           * That is deliberately the harsher branch: the sign-in link on the refusal surface
           * re-mints the cookie and the next load opens the right mirror, so the cost is one
           * screen and the alternative is a mailbox that changes identity mid-session.
           */
          setBinding(
            owner === warm.owner
              ? { status: "ready", demo: false, engine: warm.engine }
              : { status: "unauthenticated" },
          );
          return;
        }
        setBinding({ status: "ready", demo: false, engine: createEngine(false, undefined, owner) });
      })
      .catch((err: unknown) => {
        // A build with no API base is NOT "we could not prove who you are" — it is a broken
        // deployment, and rendering the session screen for it would be the same silent lie
        // `EngineUnarmedError` exists to end: a signed-in user told their session expired
        // when the truth is that this bundle was never wired to a server. Let it escape to
        // the error boundary and the console instead of dressing it as an auth outcome.
        if (err instanceof EngineUnarmedError) throw err;
        if (!cancelled) setBinding({ status: "unauthenticated" });
      });
    return () => {
      cancelled = true;
    };
    // `binding` and not `binding.status`: the warm branch reads the remembered account id and
    // the engine off it, and a dependency on the status alone would let this effect close over a
    // stale one. The early return above is what keeps that cheap — every binding that is not
    // `resolving` or `warm` re-runs the effect and leaves immediately.
  }, [binding, browserPass, resolveOwner]);

  /**
   * What the sync loop is doing. Only a LIVE engine ever moves it off its resting value —
   * the demo drains once, from fixtures, and has nothing to report.
   *
   * The updater returns `prev` when nothing changed, which is a bail-out rather than a
   * micro-optimisation: a healthy tab settles a drain every eight seconds forever, and
   * without it every one of those would re-render the whole shell to publish a value
   * identical to the one already on screen.
   *
   * ALL FOUR FIELDS ARE COMPARED, through {@link sameSyncStatus}. Two of them — `terminal` and
   * `refused` — were once left out of an inline comparison here and survived only by luck: the
   * scheduler happens to move `failures` in the same publish that changes either. Nothing
   * enforced that coincidence, and both fields exist precisely so a surface can render "this
   * session has stopped" or "still retrying, briefly" differently from a healthy tick — a dedup
   * blind to one of them is one refactor away from swallowing the transition. The comparator
   * names all four, and `sync-liveness.test.ts` guards it.
   */
  const [sync, setSync] = useState<SyncStatus>(SYNC_BOOTSTRAPPING);
  const onSyncStatus = useCallback((next: SyncStatus) => {
    setSync((prev) => (sameSyncStatus(prev, next) ? prev : next));
  }, []);

  /**
   * `warm` IS A RENDERING, SYNCING ENGINE — the whole point — so both derivations include it,
   * and both must produce the SAME values before and after the confirmation lands. They do:
   * `warm` carries the same engine object it hands to `ready`, and both are live.
   *
   * That identity is what makes the confirmation invisible. The effect below depends on
   * `[engine, live]`, so a warm → ready transition that changed either one would tear the
   * scheduler down and start a second bootstrap over a mirror that was already draining.
   *
   * The teardown that IS wanted still happens: a refusal or a mismatch sets a binding with no
   * engine, this reads `null`, and React runs the cleanup — which closes the engine's per-page
   * gate, so an in-flight drain stops at its next page boundary rather than running on behind a
   * screen that says the session ended.
   */
  const engine = binding.status === "ready" || binding.status === "warm" ? binding.engine : null;
  const live = binding.status === "warm" || (binding.status === "ready" && binding.demo === false);
  useEffect(() => {
    if (!engine) return;
    /**
     * THE WAKE SIGNAL, AND WHY IT IS HERE RATHER THAN IN A PROP.
     *
     * This was one `engine.start()` and nothing else — the only drain the tab would ever
     * perform. The comment that stood here reported a failed first drain to the console and
     * called that "deliberately only the first half", on the reasoning that the HTTP path
     * would retry on the next wake signal. There was no next wake signal: no EventSource, no
     * interval, no `visibilitychange`, nothing. So one throw produced a permanently empty
     * mailbox, new mail never arrived without a manual reload, and a thirty-seven page
     * bootstrap rendered "0 unread of 0" for twelve to fifteen seconds. All three shipped.
     *
     * `sync-scheduler.ts` is the second half: a serialized poll while the tab is visible,
     * an immediate drain when it comes back or the network does, and jittered exponential
     * backoff on failure. Read that file for the poll-versus-SSE decision and the cost
     * argument behind the visibility gate.
     *
     * It is wired HERE, inside the provider, and not passed down from
     * `(product)/mailbox/CloudShell.tsx` the way `resolveOwner` is. That seam exists to keep
     * `app/api-client` out of the offline desktop bundle; a scheduler imports nothing but
     * `setTimeout`, `document` and the engine it was handed, so it costs the desktop build
     * nothing. A prop would buy only a silent-omission mode — a shell that forgets to pass
     * one loads fine and then never syncs again, which is this exact bug re-created as a
     * wiring bug.
     *
     * The demo keeps the single `start()`. It has fixtures, no server and no cursor to
     * advance, and polling it would be a timer that can only ever find the same world
     * (the demo is fixtures: nothing leaves this tab, and nothing needs to).
     */
    if (!live) {
      void engine.start().catch((err: unknown) => {
        console.error("ohmail: the mailbox sync engine failed to start", err);
      });
      return;
    }
    // A DESKTOP build keeps its full cadence while its window is occluded or unfocused; a browser
    // tab drops to the hidden cadence (one drain a minute, no stream — `sync-scheduler.ts`).
    // `visibility: null` is the scheduler's "no visibility model" seam, and it is passed ONLY
    // under the desktop build flag (`engine-config.ts` → `syncsWhileHidden`) — never
    // unconditionally, or the web build would stop respecting a hidden tab. A web-side guard
    // (grep `syncsWhileHidden`) fails on a leak.
    //
    // `wake` is the push half: an `EventSource` on `/events` whose `sync` frames drain through
    // this same scheduler. `cloudWakeStream()` decides WHICH builds hold one (web live only —
    // the desktop's API is the local sidecar, whose Cloud door wakes inside the sidecar); the
    // scheduler decides WHEN (visible only) and survives the stream's absence byte-identically
    // to the poll-only behaviour — the server's flag being off costs one refused request per
    // session and nothing else.
    return startSyncScheduler(engine, {
      onStatus: onSyncStatus,
      ...(syncsWhileHidden() ? { visibility: null } : {}),
      wake: cloudWakeStream(),
    });
  }, [engine, live, onSyncStatus]);

  if (binding.status === "resolving" || binding.status === "unauthenticated") {
    return <SessionScreen status={binding.status} />;
  }

  return (
    <EngineContext.Provider
      value={{
        engine: binding.engine,
        // A warm binding is a LIVE engine by construction — `createEngine(false, …)` built it —
        // so the mode it publishes is the mode it was built in, exactly as the field's contract
        // says. There is no window in which the demo chrome renders over a warm mailbox.
        demo: binding.status === "warm" ? false : binding.demo,
        serverDemo,
        sync: live ? sync : SYNC_SETTLED,
      }}
    >
      {children}
      {/* The re-auth surface, LIVE ENGINES ONLY. The demo has no session and the desktop's
          store never leaves its resting value, so on both this renders nothing, forever. */}
      {live ? <SessionEnded sync={sync} /> : null}
    </EngineContext.Provider>
  );
}

/**
 * ═══ THE RE-AUTH PROMPT — what a dead session shows instead of a quietly wrong mailbox ═══════
 *
 * When a session died mid-use the app used to keep rendering the mirror as though it were
 * live: rows painted, counts frozen, every failure dressed as a content failure, and no
 * surface anywhere offering the one act that fixes it. This is that surface. It renders over
 * the shell — the mail stays visible underneath, because it is real mail this browser really
 * holds — but dimmed behind a scrim and blocked from interaction, so nothing on screen can be
 * mistaken for a live mailbox, and the prompt offers sign-in.
 *
 * ── IT SPEAKS ONLY ON THE CONFIRMED FACT ────────────────────────────────────────────────────
 *
 * The trigger is `useSessionDead()` — set exclusively by a coded 401 from `POST /auth/refresh`
 * (`session-refresh.ts`), which is the server stating the refresh family is revoked and the
 * cookie jar cleared. Never by one failed request: the sync scheduler's whole confirmation
 * ladder exists because a transient 401 once told a signed-in user to sign in, and this surface
 * — the loudest in the product — holds that discipline hardest.
 *
 * ── AND IT HURRIES THE QUESTION RATHER THAN THE ANSWER ─────────────────────────────────────
 *
 * The scheduler confirms a refusal by waiting sixty seconds and asking the same endpoint again.
 * That is correct for the sync loop and slow for a person mid-task, so on the FIRST evidence —
 * `sync.refused` or `sync.terminal` appearing — this probes the session through
 * `probeSessionNow()`: one single-flight `POST /auth/refresh`, whose answer is definitive in
 * both directions. A lapsed-but-resumable session is silently healed (the refresh mints new
 * cookies and the confirm drain then succeeds); a revoked one is confirmed within one round
 * trip instead of one minute. Rising-edge gated so a refusal episode costs one probe, not one
 * per publish. On builds with no probe registered (desktop, demo, bare tests) the call is a
 * no-op.
 *
 * ── `role="alertdialog"`, and focus moves to the remedy ────────────────────────────────────
 *
 * The session ending is the one mid-use fact worth interrupting for — the same judgement
 * `SyncBar` makes with `role="alert"` for its `stopped` line — and the dialog carries the one
 * action that exists. Focus is moved to the sign-in link when the prompt appears so a keyboard
 * or screen-reader user is standing on the remedy, not somewhere in a mailbox that no longer
 * answers.
 */
function SessionEnded({ sync }: { sync: SyncStatus }) {
  const t = useTranslations("session");
  const dead = useSessionDead();
  const signInRef = useRef<HTMLAnchorElement | null>(null);

  // One probe per refusal episode: fire when evidence APPEARS, stand down when it clears.
  const evidence = sync.refused || sync.terminal;
  const probed = useRef(false);
  useEffect(() => {
    if (!evidence) {
      probed.current = false;
      return;
    }
    if (probed.current) return;
    probed.current = true;
    probeSessionNow();
  }, [evidence]);

  useEffect(() => {
    if (dead) signInRef.current?.focus();
  }, [dead]);

  if (!dead) return null;
  return (
    <div
      className="session-end"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-end-title"
      aria-describedby="session-end-body"
    >
      <div className="gate-card">
        <span className="wordmark">
          <b>
            <em>oh</em>mail
          </b>
        </span>
        <h1 id="session-end-title">{t("endedTitle")}</h1>
        <p id="session-end-body">{t("endedMidUse")}</p>
        <div className="gate-actions">
          <a ref={signInRef} className="btn primary" href="/login">
            {t("signIn")}
          </a>
        </div>
      </div>
    </div>
  );
}

/**
 * The two states that are not a mailbox.
 *
 * Same markup as `mailbox/page.tsx`'s honest gate — `.gate` / `.gate-card` in `app.css` —
 * so a visitor who lands here sees the product's own furniture rather than a stray spinner
 * in an unstyled page.
 *
 * ── `resolving` USED TO CARRY NO TEXT AT ALL, AND MOSTLY STILL DOES ─────────────────────
 *
 * The argument for silence was "it is normally two or three hundred milliseconds, and a
 * sentence that flashes is worse than a quiet frame", and that is still true — of a normal
 * connection. A slow one is not: `GET /auth/session` is the FIRST of two serial round trips
 * before a single row can paint, and over a slow link the whole of it was a blank page
 * followed by "Nothing in your Ohbox.".
 *
 * `useLoadingGrace` keeps both promises rather than picking one. Below the grace this renders
 * exactly what it always did — an empty, busy, live region. Above it, the region gains a
 * sentence, and because it is the SAME `aria-live="polite"` node the text was never in, its
 * late arrival is announced rather than silently present.
 *
 * It says the app is opening the mailbox and nothing about what is in it. At this point this
 * component has not been told whose mailbox it is, let alone what is in it, and a gate is not
 * a place to start guessing.
 */
function SessionScreen({ status }: { status: "resolving" | "unauthenticated" }) {
  const t = useTranslations("session");
  const slow = useLoadingGrace(status === "resolving");
  if (status === "resolving") {
    return (
      <div className="gate" aria-busy="true" aria-live="polite">
        {/* `.mbx-wait` — the spinner-plus-one-muted-line pairing the Settings rows and the
            sync strip already use. Nothing new is styled for a frame that is normally never
            seen, and the ring's `prefers-reduced-motion` rule comes with it. */}
        {slow ? (
          <span className="mbx-wait">
            <span className="mbx-spin" aria-hidden="true" />
            {t("opening")}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="gate">
      <div className="gate-card">
        <span className="wordmark">
          <b>
            <em>oh</em>mail
          </b>
        </span>
        <h1>{t("endedTitle")}</h1>
        <p>{t("endedBody")}</p>
        <div className="gate-actions">
          <a className="btn primary" href="/login">
            {t("signIn")}
          </a>
          <a className="btn" href="/?demo=1">
            {t("openDemo")}
          </a>
        </div>
      </div>
    </div>
  );
}

function useBinding(): EngineBinding {
  const binding = useContext(EngineContext);
  if (!binding) throw new Error("useEngine must be used inside <EngineProvider>");
  return binding;
}

export function useEngine(): OhmailEngine {
  return useBinding().engine;
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
export function useDemoMode(): boolean {
  const { demo, serverDemo } = useBinding();
  return useSyncExternalStore(NEVER_CHANGES, () => demo, () => serverDemo);
}

/**
 * Subscribe to the engine; returns the overlay-aware mirror version so
 * memoized selectors recompute on every change (and only then).
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

/** The overlay-merged reader (stable object; version() tracks change). */
export function useReader(): EntityReader {
  return useEngine().read();
}
