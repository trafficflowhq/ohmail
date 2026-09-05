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
import { Spinner } from "@ohmail/ui";
import { useTranslations } from "next-intl";
import { OhmailEngine, type AbandonedMutation, type EntityReader, type MirrorFreshness } from "@ohmail/client-engine";
import { isDemoRequested } from "../demo-mode";
import { CONFIRM_ATTEMPTS, nextConfirmDelay } from "./confirm-schedule";
import { cloudWakeStream, createEngine, EngineUnarmedError, syncsWhileHidden } from "./engine-config";
import { useLoadingGrace } from "./loading-grace";
import { useModalGate } from "./modal-gate";
import { readOwner } from "./owner-cookie";
import {
  markSessionAlive, probeSessionNow, sessionIsDead, subscribeSessionRevival,
  subscribeSessionTruth, useSessionDead,
} from "./session-truth";
import {
  confirmSyncOwner,
  onSyncNeedsConfirm,
  syncIdentityOf,
  sameSyncStatus,
  startSyncScheduler,
  SYNC_BOOTSTRAPPING,
  SYNC_SETTLED,
  type SyncStatus,
} from "./sync-scheduler";

/**
 * ═══ THE ANSWER TO "WHOSE MAILBOX IS THIS?" — THREE-VALUED, AND THAT IS THE FIX ════════════
 *
 * This used to be `Promise<string | null>`, and the `null` was doing two incompatible jobs:
 * "the server says this browser holds no full session" and "the server did not answer". The
 * shell could only render one screen for both, so it rendered the verdict — and a signed-in
 * user meeting one `503 db_busy` on the confirm was told "You are signed out." over a cookie
 * that was still valid a millisecond later. Measured in production, 2.7 s before the report
 * that opened `AUTH-FLICKER-DIAGNOSIS.md`; reproduced eight ways out of eleven injected
 * transients, every one with the cookie re-read as `200 scope=full` immediately afterwards.
 *
 * The three arms are the three things that can actually be true:
 *
 *  · `owner`   — the server named an account. This browser holds a full session.
 *  · `none`    — the server ANSWERED that it does not. A verdict, and rendered as one, at
 *                once, with no retry: an enrollment-scoped session, or the refresh endpoint's
 *                own coded 401. Nothing weaker qualifies.
 *  · `unknown` — no answer. A 5xx, a 429, a gateway with no envelope of ours, a dead socket,
 *                an uncoded 401. The shell RETRIES on a bounded schedule
 *                (`confirm-schedule.ts`) and, if the ladder runs out, says the check did not
 *                finish — which is what happened — rather than making a claim about the
 *                account, which it cannot support.
 *
 * `retryAfterMs` rides on `unknown` because the server sometimes says when to come back
 * (`Retry-After: 5` on `db_busy`). It seeds the backoff; it does not replace it.
 *
 * ── WHY IT IS STILL A PROP ─────────────────────────────────────────────────────────────────
 *
 * Unchanged, and unchanged for the original reason: this file is shared. `apps/desktop`
 * renders the same `AppShell` from a bundle that has no account, no server and no `/auth`
 * client at all (`scripts/publish-desktop.mjs` DENYs `app/api-client`, and `vite.config.ts`
 * aliases the sync adapter to a stub that throws). Importing the Cloud's session client here
 * would drag both into a tier that must not have them. The Cloud client passes its
 * implementation from `(product)/mailbox/CloudShell.tsx` — which classifies through the one
 * shared classifier, `(product)/session-outcome.ts`, so `/login` cannot drift from the shell
 * — and the desktop passes nothing, hands in a built engine, and never runs this path.
 */
export type OwnerOutcome =
  | { kind: "owner"; accountId: string }
  | { kind: "none" }
  | { kind: "unknown"; retryAfterMs: number | null };

export type OwnerResolver = () => Promise<OwnerOutcome>;

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
  /**
   * Live: the confirm did not get an ANSWER and another ask is owed.
   *
   * `attempt` is the number of the ask this state is waiting to make (2, 3, 4 —
   * `CONFIRM_ATTEMPTS` bounds it), and `retryAfterMs` is whatever the last refusal advised.
   * `warm` carries the mirror forward when there is one, and carrying it is the point: the
   * engine object is the SAME object, so `engine`/`live` below do not change, the sync
   * scheduler is not torn down and restarted, and nothing on screen moves. A 503 does not
   * make mail that is already on the device less real than it was a second earlier.
   */
  | { status: "checking"; attempt: number; warm: WarmMirror | null; retryAfterMs: number | null }
  /**
   * Live: the ladder ran out. The check never completed and the shell says exactly that —
   * this is NOT a verdict about the session, and its copy may not read like one.
   */
  | { status: "unconfirmed"; warm: WarmMirror | null }
  /** Live: the API ANSWERED that this browser holds no full session. A verdict. */
  | { status: "unauthenticated" };

/** The mirror a `checking`/`unconfirmed` binding is keeping on screen, when there is one. */
interface WarmMirror {
  owner: string;
  engine: OhmailEngine;
}

/**
 * Is this the classifier's "this build has no server" rethrow?
 *
 * Matched STRUCTURALLY rather than with `instanceof ApiError`: `app/shell/**` is published to
 * the desktop mirror, where `app/api-client` is aliased away entirely, so importing the class
 * here would be an unresolved import in that bundle. The same reason `session-truth.ts` holds
 * no transport. The shape is the contract `api-client.ts` states for an unarmed build.
 */
function isApiUnconfigured(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; code?: unknown };
  return e.status === 0 && e.code === "api_unconfigured";
}

/** The mirror this binding is painting from while unconfirmed, or `null` for a cold browser. */
function warmOf(binding: Binding): WarmMirror | null {
  if (binding.status === "warm") return { owner: binding.owner, engine: binding.engine };
  if (binding.status === "checking" || binding.status === "unconfirmed") return binding.warm;
  return null;
}

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
  onConfirmed,
  children,
}: {
  demo: boolean;
  /** See {@link ProvidedEngine}. Absent everywhere but the desktop app. */
  engine?: ProvidedEngine;
  resolveOwner?: OwnerResolver;
  /**
   * THE ACCOUNT THIS TAB HAS DECIDED IT IS FOR — called once, in the arm that has already
   * believed the answer, and never from the classifier that produced it.
   *
   * The Cloud client is bound here (`CloudShell` supplies `bindApiOwner`). It cannot be done in
   * `resolveOwnerOutcome`, and the reason is a sequence rather than a preference: that function
   * runs for every attempt of the ladder, including attempts whose effect has since been
   * cancelled, and it runs BEFORE the comparison that decides whether the answer is even about
   * this mirror. Binding there mutated shared state that in-flight requests are judged against,
   * so a request that left as A could be re-judged as B and allowed to recover under it.
   *
   * A prop rather than an import, for the reason `resolveOwner` is one: `app/shell/**` ships
   * inside the desktop program, which has no session client. Absent on the desktop and the demo.
   */
  onConfirmed?: (accountId: string) => void;
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
  /**
   * A DEPLOYMENT ERROR, HELD UNTIL A RENDER CAN THROW IT. `null` in every healthy tab, for the
   * life of the tab. Written only by the confirm's `.catch`, and only for the two errors that
   * mean "this bundle has no server"; read once, below the hooks. See both sites for why the
   * throw cannot happen where the error is caught.
   */
  const [fatal, setFatal] = useState<unknown>(null);
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
   * An ANSWERED refusal lands on `"unauthenticated"`. That is a rendered explanation and a
   * link, NOT an automatic redirect: middleware and this call reach the API by different
   * routes (edge → `api.ohmail.app` directly, browser → the `/api` rewrite), so a
   * disagreement between them is possible, and a redirect on disagreement is an infinite loop
   * between `/` and `/`.
   *
   * ── AND A FAILURE TO ANSWER LANDS SOMEWHERE ELSE ENTIRELY ─────────────────────────────────
   *
   * That paragraph used to read "every refusal, AND EVERY FAILURE, lands on
   * `unauthenticated`", and it was accurate about the code and wrong about the world. The two
   * are not one outcome: `{kind:"none"}` is the server's own answer and is rendered at once,
   * while `{kind:"unknown"}` is the absence of one and is retried — up to
   * {@link CONFIRM_ATTEMPTS} asks on {@link nextConfirmDelay}'s backoff — and then reported as
   * a check that did not finish. `OwnerOutcome` carries the whole argument and
   * `AUTH-FLICKER-DIAGNOSIS.md` carries the production request that forced it.
   *
   * The retry is a re-render into `"checking"` rather than a loop inside this effect, on
   * purpose: the delay is then a state the tree can be tested against and the timer is owned
   * by the effect's own cleanup, so a teardown mid-ladder cancels it rather than resolving
   * into an unmounted tree.
   */
  useEffect(() => {
    if (binding.status !== "resolving" && binding.status !== "warm" && binding.status !== "checking") return;
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
    const warm = warmOf(binding);
    /**
     * WHICH ASK THIS IS, and how long to wait before making it.
     *
     * `resolving` and `warm` are the first ask and wait for nothing — the confirm still runs
     * on the same commit it always did, so a healthy load is byte-for-byte the load it was.
     * Only a `checking` binding has a delay, and it is computed from the attempt it is about
     * to make and from whatever the last refusal advised.
     */
    const attempt = binding.status === "checking" ? binding.attempt : 1;
    const delay = binding.status === "checking"
      ? nextConfirmDelay(attempt - 1, binding.retryAfterMs)
      : 0;

    let cancelled = false;
    const ask = () => void resolveOwner()
      .then((outcome) => {
        if (cancelled) return;
        /**
         * NO ANSWER. Retry, or — once the ladder is spent — say so.
         *
         * Ordered FIRST among the non-owner arms so that reading this branch cannot be
         * mistaken for reading a refusal: `unknown` never reaches `unauthenticated`, on any
         * attempt, for any status. That is the invariant the source guard in
         * `test/session-verdict-guard.test.ts` pins.
         */
        if (outcome.kind === "unknown") {
          setBinding(
            attempt >= CONFIRM_ATTEMPTS
              ? { status: "unconfirmed", warm }
              : { status: "checking", attempt: attempt + 1, warm, retryAfterMs: outcome.retryAfterMs },
          );
          return;
        }
        /**
         * THE SERVER ANSWERED THAT THERE IS NO FULL SESSION. A verdict, immediately, with no
         * retry and no delay — exactly the speed this screen had before the ladder existed.
         * `session-outcome.ts` holds the two facts that qualify and nothing else does.
         */
        if (outcome.kind === "none") {
          setBinding({ status: "unauthenticated" });
          return;
        }
        const owner = outcome.accountId;
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
          /*
           * AND THE MIRROR'S SYNC GATE OPENS HERE, once the comparison has passed and BEFORE
           * the binding changes.
           *
           * A scheduled engine is not a merging engine. The warm engine has been hydrating and
           * painting since the render after hydration, and its gate has been closed the whole
           * time — no `/sync`, no snapshot, no mutation — because until this line nobody had
           * told it whose mailbox it holds. `confirmSyncOwner` is that telling, and it is
           * inside the MATCH arm on purpose: the mismatch arm below opens nothing, so A's
           * engine never merges under B's session even if this comparison were ever softened
           * into an engine swap. Before `setBinding` so the scheduler's first tick after the
           * transition already sees an open gate rather than racing it.
           */
          if (owner === warm.owner) {
            confirmSyncOwner(warm.engine, owner);
            // AFTER the comparison and the cancellation check above: the client is bound to the account
            // this tab has decided it is for, not to whatever the last resolver happened to see.
            onConfirmed?.(owner);
          }
          setBinding(
            owner === warm.owner
              ? { status: "ready", demo: false, engine: warm.engine }
              : { status: "unauthenticated" },
          );
          return;
        }
        // The cold path builds the engine for the account the server just named, so the gate
        // opens with no comparison to make — but it still has to be OPENED, and before the
        // binding, for the same first-tick reason as the warm arm above.
        const built = createEngine(false, undefined, owner);
        confirmSyncOwner(built, owner);
        onConfirmed?.(owner);
        setBinding({ status: "ready", demo: false, engine: built });
      })
      .catch((err: unknown) => {
        /*
         * ═══ A BROKEN DEPLOYMENT REACHES THE ERROR BOUNDARY — BY BEING RE-THROWN IN A RENDER ═
         *
         * Two errors mean "this bundle was never wired to a server", and neither is an auth
         * outcome: `EngineUnarmedError`, and the `ApiError(0, "api_unconfigured")` that
         * `session-outcome.ts` deliberately rethrows. Rendering the session screen for either
         * would be the silent lie `EngineUnarmedError` exists to end — a signed-in person told
         * their session expired when the truth is that nobody finished the deploy.
         *
         * `throw err` HERE DOES NOT DO THAT, and the two lines that used to stand here said it
         * did. This is a detached `.catch` on a promise nothing awaits: a throw from it is an
         * unhandled rejection, which React error boundaries do not see (they catch throws from
         * render, from lifecycles and from `useEffect` bodies — never from a callback that runs
         * later on the microtask queue). So the promised deployment-error screen never appeared;
         * what appeared was a tab wedged on `resolving`, or a warm mirror that never resolved,
         * with a rejection in the console and no boundary anywhere.
         *
         * Held and rethrown from the RENDER instead — the one place a boundary is watching. The
         * `fatal` state below is written once and never cleared: there is no recovery from a
         * bundle with no server, and a Try again over it would be the same false promise in a
         * different shape.
         */
        if (err instanceof EngineUnarmedError || isApiUnconfigured(err)) {
          if (!cancelled) setFatal(err);
          return;
        }
        /**
         * EVERY OTHER THROW IS ALSO NOT AN AUTH OUTCOME, and this branch used to say it was.
         *
         * `resolveOwner` answers rather than rejects, so what reaches here is something that
         * blew up on OUR side of the answer: `createEngine` refused (IndexedDB is unavailable
         * in a hardened profile or a private window), or the classifier rethrew an unarmed
         * build. None of that is evidence about the session, and `unauthenticated` claimed it
         * was. It reports and lands on `unconfirmed`, whose copy is true of all of them.
         *
         * A dedicated screen for a storage refusal — which deserves its own sentence, because
         * "try again" will not fix it — is a follow-up gap, not this slice.
         */
        console.error("ohmail: the session confirm could not be completed", err);
        if (!cancelled) setBinding({ status: "unconfirmed", warm });
      });
    if (delay <= 0) {
      ask();
      return () => {
        cancelled = true;
      };
    }
    const timer = setTimeout(ask, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `binding` and not `binding.status`: the warm branch reads the remembered account id and
    // the engine off it, and a dependency on the status alone would let this effect close over a
    // stale one. The early return above is what keeps that cheap — every binding that is not
    // `resolving`, `warm` or `checking` re-runs the effect and leaves immediately.
  }, [binding, browserPass, resolveOwner]);

  /**
   * A FRESH SESSION CLEARS AN UNCONFIRMED CHECK — the one automatic escape from `unconfirmed`.
   *
   * `unconfirmed` is the end of the ladder, so without this it stands until somebody presses
   * Try again. But a `204` from `POST /auth/refresh` is a server-confirmed world change, and it
   * can arrive from somewhere this tree is not watching — the sync loop's own probe, a body
   * fetch, the attachments seam. `session-truth.ts` already publishes exactly that event for
   * exactly this shape of stuck state, so the confirm joins them.
   *
   * (An earlier version of this paragraph also named "another tab whose refresh rotated the
   * shared jar". It cannot: see the same-tab note below, which is the correction rather than a
   * caveat on it.)
   *
   * Bounded by construction: at most one revival per successful refresh, and this returns the
   * binding to its FIRST attempt rather than resuming a ladder, so a revival cannot compound
   * into a burst. Only `unconfirmed` subscribes; a `checking` binding already has a timer
   * running and does not need a second door.
   *
   * **SAME TAB ONLY, and the earlier version of this comment claimed otherwise.** It said the
   * signal could arrive "from another tab whose refresh rotated the shared jar". It cannot:
   * `session-truth.ts` is module state with no `BroadcastChannel` and no storage event, so a
   * revival is only ever published to the tab that performed the refresh. A second tab sitting
   * at `unconfirmed` while this one recovers keeps its notice until somebody presses Try
   * again — which is why that button is the primary action and not a footnote. Making the
   * store cross-tab is a change to a file this slice deliberately does not touch.
   */
  useEffect(() => {
    if (binding.status !== "unconfirmed") return;
    const warm = binding.warm;
    return subscribeSessionRevival(() => {
      setBinding(
        warm ? { status: "warm", owner: warm.owner, engine: warm.engine } : { status: "resolving" },
      );
    });
  }, [binding]);

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
   * names all four, and `test/sync-liveness.test.ts` guards it.
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
   *
   * `checking` and `unconfirmed` are here for the same CONTINUITY reason `warm` is, and it is
   * why they carry their mirror rather than a boolean: `warmOf` returns the very object the
   * warm binding held, so `engine` does not change identity across warm → checking → warm →
   * ready and the scheduler below is never torn down and restarted by a transient. A 503 on
   * the confirm must not cost the tab its sync loop and a second bootstrap over a mirror that
   * was already draining. A COLD `checking`/`unconfirmed` has no mirror, reads `null`, and
   * correctly runs nothing.
   *
   * **BEING SCHEDULED IS NOT BEING ALLOWED TO MERGE, and that distinction is newer than these
   * lines.** They used to be the whole story, and they were not: a scheduled engine drains
   * into a mirror NAMED for the remembered account under whatever session the cookie jar
   * holds, so keeping the loop alive through a failing confirm kept it merging too. The
   * derivations are unchanged — the engine object and `live` are what they always were — and
   * the mirror's own sync gate decides what a scheduled engine may DO
   * (`createSyncGate`/`confirmSyncOwner`). Withholding the drain is invisible: the mirror was
   * already on screen.
   */
  const warmMirror = warmOf(binding);
  const engine = binding.status === "ready" ? binding.engine : warmMirror?.engine ?? null;
  const live = warmMirror !== null || (binding.status === "ready" && binding.demo === false);

  /**
   * A DEATH CONFIRMED **DURING THIS MOUNT** — which is a different fact from the latch itself.
   *
   * Gating `SessionEnded` on `ready` closed the stale-latch defect and opened a smaller one:
   * a session revoked while a warm binding sat in `checking` or `unconfirmed` could not be
   * reported at all, because the prompt was not mounted and the notice does not read the
   * store. The user kept "the check did not finish" over a session that had genuinely ended.
   *
   * The distinction that matters is not "is the latch set" but "did this tab watch it get
   * set". A latch inherited from the page before this mount is somebody else's evidence; a
   * false → true transition observed here is ours. So the subscription records the transition
   * and nothing else: an already-`true` store at mount time is deliberately not counted.
   */
  const [deathSeenHere, setDeathSeenHere] = useState(false);
  useEffect(() => {
    if (!live) return;
    return subscribeSessionTruth(() => {
      if (sessionIsDead()) setDeathSeenHere(true);
    });
  }, [live]);


  /**
   * ASK AGAIN, BY HAND — the primary action on the unconfirmed surface.
   *
   * It puts the binding back where the ladder started, which restarts it at attempt one with
   * no delay: back to `warm` when there is a mirror (so nothing on screen moves and the same
   * engine keeps draining), and to `resolving` when there is not. Deliberately NOT a
   * `location.reload()` — the fragment is the view (`shell/routing.ts`), the mirror is already
   * open, and re-downloading the document to re-ask one question would throw away both.
   *
   * Depends on `warmMirror` rather than on `binding`, so pressing it cannot resurrect a mirror
   * from a binding that has since moved on.
   */
  // The two FIELDS, not the wrapper: `warmOf` builds a fresh object for a `warm` binding, so a
  // dependency on it would rebuild this callback every render for no change in meaning.
  const warmOwner = warmMirror?.owner ?? null;
  const warmEngine = warmMirror?.engine ?? null;
  const retryConfirm = useCallback(() => {
    setBinding(
      warmOwner !== null && warmEngine !== null
        ? { status: "warm", owner: warmOwner, engine: warmEngine }
        : { status: "resolving" },
    );
  }, [warmOwner, warmEngine]);
  /**
   * ═══ A REVOKED MIRROR ASKS TO BE CONFIRMED AGAIN ══════════════════════════════════════════
   *
   * Revocation is monotonic on purpose: once the marker has changed, only a fresh server answer
   * reopens the gate, and it must not oscillate. That left one state with no way out. On a
   * `ready` binding the confirm effect finished long ago and `ready` carries no owner to
   * re-compare, so when the marker came back to naming this mirror the tab cleared its terminal
   * strip — the contradiction really was gone — and then sat there with reads, sync, mutations
   * and the wake stream all disabled, and nothing on screen saying so. It looked well.
   *
   * The gate now says when it could plausibly be asked about (`onNeedsConfirm`, once per
   * revocation), and this puts the binding back to `warm` so the confirm ladder runs again with
   * the SAME engine — nothing re-mounts, nothing re-hydrates, and the answer either reopens the
   * gate or ends the tab honestly.
   */
  useEffect(() => {
    if (!engine || !live) return;
    let cancelled = false;
    onSyncNeedsConfirm(engine, () => {
      if (cancelled) return;
      const named = readOwner();
      if (named === null) return;
      setBinding({ status: "warm", owner: named, engine });
    });
    return () => { cancelled = true; };
  }, [engine, live]);

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

  /**
   * THE ONE PLACE A BOUNDARY IS WATCHING. See the confirm's `.catch`: a throw from a detached
   * promise callback is an unhandled rejection and reaches no error boundary, so a bundle wired
   * to no server has to be re-thrown from a render to produce the deployment-error screen both
   * this file and `session-outcome.ts` promise it will.
   *
   * After every hook, so the hook order is identical on the render that throws and the one
   * before it. Never cleared: there is no recovery from a build with no API.
   */
  if (fatal !== null) throw fatal;

  if (binding.status === "resolving" || binding.status === "unauthenticated") {
    return <SessionScreen status={binding.status} />;
  }

  /**
   * A COLD BROWSER STILL CHECKING LOOKS EXACTLY LIKE ONE STILL RESOLVING — because it is.
   *
   * There is no mirror to show and no answer yet, which is the state `resolving` already
   * renders: an empty live region that grows one muted line past `useLoadingGrace`. A second,
   * different waiting screen for the second ask would be a visible transition announcing that
   * something went wrong, on a load that may yet succeed 600 ms later. Nothing has gone wrong
   * that the person can act on, so nothing is said.
   */
  if (binding.status === "checking" && binding.warm === null) {
    return <SessionScreen status="resolving" />;
  }

  /** No mirror and no answer after the whole ladder: the honest card, on its own. */
  if (binding.status === "unconfirmed" && binding.warm === null) {
    return <UnconfirmedGate onRetry={retryConfirm} />;
  }

  if (engine === null) {
    /* Unreachable: every status still standing is `ready` or carries a warm mirror, so
       `warmOf` gave one. Written as a wait rather than a throw because a wait is the harmless
       answer if a future arm forgets to carry its engine, and a blank frame is a bug report
       while a crashed root is a lost session. */
    return <SessionScreen status="resolving" />;
  }

  return (
    <EngineContext.Provider
      value={{
        engine,
        // A warm binding is a LIVE engine by construction — `createEngine(false, …)` built it —
        // so the mode it publishes is the mode it was built in, exactly as the field's contract
        // says. There is no window in which the demo chrome renders over a warm mailbox. The
        // two unconfirmed states inherit that: they carry the warm engine itself.
        demo: binding.status === "ready" ? binding.demo : false,
        serverDemo,
        sync: live ? sync : SYNC_SETTLED,
      }}
    >
      {children}
      {/* The re-auth surface, LIVE ENGINES ONLY. The demo has no session and the desktop's
          store never leaves its resting value, so on both this renders nothing, forever.

          AND ONLY ONCE THIS MOUNT HAS CONFIRMED SOMETHING — `ready`, never `warm`, `checking`
          or `unconfirmed`. The death latch is module state that deliberately SURVIVES a
          client-side navigation (see the withdrawal note in the confirm effect), so on a
          freshly signed-in shell it can still be holding a truthful `true` from the `/login`
          page that preceded it. Rendered on a `warm` binding, that stale latch puts "This
          session ended" over a live mailbox before this tab has asked anybody anything — and
          if the confirm then meets a 503 the latch is never withdrawn, because only a
          confirmed owner withdraws it. That is the reported defect reached through a second
          door, and it is why the gate is the BINDING rather than `live`: a latch observed
          before this mount is not evidence about this mount, and one round trip settles it. */}
      {live && (binding.status === "ready" || deathSeenHere) ? <SessionEnded sync={sync} engine={engine} /> : null}
      {/* THE CHECK-DID-NOT-FINISH OVERLAY, and note what is NOT here: `checking` renders
          nothing at all. A tab whose confirm is being retried keeps painting its mirror
          exactly as `warm` does — no scrim, no dimming, no message. `warm` already paints
          unconfirmed for a whole round trip and always has; a 503 does not make the mail on
          this device less trustworthy than it was a second earlier, and dimming the screen for
          600 ms is the flicker this slice removes wearing a different hat. Only the END of the
          ladder is worth interrupting for. */}
      {binding.status === "unconfirmed" && binding.warm !== null && !deathSeenHere
        ? <UnconfirmedOverlay onRetry={retryConfirm} />
        : null}
    </EngineContext.Provider>
  );
}

/**
 * MAKE THE BACKGROUND INERT WHILE A MODAL SURFACE IS UP, and take it back on the way out.
 *
 * `role="alertdialog"` with `aria-modal="true"` is a CLAIM that nothing behind the dialog can
 * be reached, and a fixed, scrimmed layer does not make it true: it blocks pointer hits and
 * nothing else. Behind both of this file's dialogs the mailbox stays in the tab order, and —
 * the half that actually costs mail — the shell's document-level keymap keeps dispatching, so
 * `e` parks the focused message and two `d` presses can run the delete ceremony behind a
 * screen that says the session is in question.
 *
 * `inert` is the one attribute that closes all three at once: no focus, no hit-testing, no
 * event dispatch into the subtree. It is applied to the app root rather than to `document.body`
 * so the dialog itself — a sibling of the root inside the provider — stays live.
 *
 * Applied by BOTH dialogs. `SessionEnded` had this defect before this slice and shares the fix
 * rather than being left as the inconsistent twin; a modal that is honest on one screen and a
 * pretence on the other is worse than either.
 */
function useInertBackground(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = document.querySelector<HTMLElement>(".app-root");
    if (!root) return;
    // Guarded: `inert` is a property on every browser that ships it, and older engines simply
    // do not reflect it — in which case the scrim is what it always was, rather than a crash.
    const had = root.inert === true;
    root.inert = true;
    return () => {
      root.inert = had;
    };
  }, [active]);
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
function SessionEnded({ sync, engine }: { sync: SyncStatus; engine: OhmailEngine | null }) {
  const t = useTranslations("session");
  const dead = useSessionDead();
  const signInRef = useRef<HTMLAnchorElement | null>(null);
  useInertBackground(dead);
  // `inert` takes the background out of focus and hit-testing; this takes it out of the
  // KEYMAP, which `inert` cannot reach. See `modal-gate.ts`.
  useModalGate(dead);

  // One probe per refusal episode: fire when evidence APPEARS, stand down when it clears.
  const evidence = sync.refused || sync.terminal;
  const probed = useRef(false);
  useEffect(() => {
    if (!evidence) {
      probed.current = false;
      return;
    }
    if (probed.current) return;
    /*
     * …AND NOT WHEN THE EVIDENCE IS SOMEBODY ELSE'S SESSION.
     *
     * `sync.terminal` has two causes, and this probe is right for exactly one of them. A server
     * refusal is a question about THIS account, and one `POST /auth/refresh` answers it in both
     * directions. A CONTRADICTED mirror is not: the loop stopped because the cookie jar now
     * names a different account, so the refresh this would send carries that account's cookies.
     * It cannot heal anything here — this tab's session is not in the jar to be healed — and
     * what it does instead is rotate somebody else's refresh token from a tab that is not
     * theirs, extending a session nobody in this window is signed in to and, in a bad
     * interleaving, presenting a token their own tab is about to present again.
     *
     * `!== "holds"` and not `=== "contradicted"`, which is a correction: a REVOKED gate is one
     * whose confirmation the marker has already outlived, and it has exactly as little business
     * renewing a session as a contradicted one. The narrower test left the absent-marker case —
     * a sign-out whose server call failed, then a refusal — free to refresh the session that
     * sign-out could not revoke.
     *
     * Read at EFFECT time rather than at render time: the jar can be rewritten between the two,
     * which is the whole event this arm is about.
     */
    if (syncIdentityOf(engine) !== "holds") return;
    probed.current = true;
    probeSessionNow();
  }, [evidence, engine]);

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
 * ═══ "THE CHECK DID NOT FINISH" — what the end of the ladder says, and what it refuses to ══
 *
 * Four asks over roughly one to thirty seconds could not get an ANSWER out of
 * `GET /auth/session` (`confirm-schedule.ts` for the arithmetic, `OwnerOutcome` for what
 * counts as an answer). The one thing this surface may not do is what its predecessor did:
 * report that as a session ending. It is not one. The cookie may be — and in the measured
 * production case was — perfectly live; what failed was the question, not the credential.
 *
 * So the copy names the failure, not a consequence: `session.unconfirmedTitle` /
 * `unconfirmedBodyWarm`. Neither string contains "signed out", and a source guard keeps it
 * that way, because the value of the whole slice is exactly that sentence not appearing here.
 *
 * ── THE PRIMARY IS `Try again`, AND `Sign in` IS DEMOTED TO AN EXIT ────────────────────────
 *
 * The old pane's primary was Sign in, which is the wrong act for this state: the session is
 * probably fine, signing in again is a detour through a form, and — as the report that started
 * this and the reproduction both showed — it frequently just bounces straight back into the mailbox,
 * which tells the user the screen was lying. `Try again` re-asks the question that failed.
 * Sign in stays as a plain secondary link because it is occasionally the right move (a
 * session really is gone and the refresh path cannot say so), and because a screen with one
 * button and no way out is its own trap. It is an exit, not a claim.
 *
 * ── IT YIELDS TO THE REAL VERDICT ──────────────────────────────────────────────────────────
 *
 * `useSessionDead()` is the confirmed fact. If it latches while this is on screen — a refresh
 * somewhere in the tab finally got the server's coded 401 — `SessionEnded` is the truthful
 * surface and this one gets out of its way rather than stacking a second dialog over it.
 */
function UnconfirmedOverlay({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations("session");
  const retryRef = useRef<HTMLButtonElement | null>(null);
  useInertBackground(true);
  useModalGate(true);

  // Focus the remedy when the surface appears, exactly as `SessionEnded` does and for the
  // same reason: a keyboard or screen-reader user must be standing on the act that helps,
  // not somewhere in a mailbox whose freshness is in question.
  useEffect(() => {
    retryRef.current?.focus();
  }, []);

  /*
   * IT USED TO STAND ASIDE FOR `useSessionDead()`, AND THAT WAS THE SAME DEFECT AGAIN.
   *
   * The reasoning was "a confirmed death is the truthful surface, so yield to it". But the
   * latch survives a client-side navigation, so on a freshly signed-in shell it can be a
   * STALE `true` — and yielding to it meant the one honest sentence available ("the check did
   * not finish") was suppressed by a claim this tab had never verified. The two surfaces are
   * now disjoint by binding status instead: `SessionEnded` renders only at `ready`, this only
   * at `unconfirmed`, so there is nothing left to yield to.
   */
  return (
    <div
      className="session-end"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-unconfirmed-title"
      aria-describedby="session-unconfirmed-body"
    >
      <div className="gate-card">
        <span className="wordmark">
          <b>
            <em>oh</em>mail
          </b>
        </span>
        <h1 id="session-unconfirmed-title">{t("unconfirmedTitle")}</h1>
        <p id="session-unconfirmed-body">{t("unconfirmedBodyWarm")}</p>
        <div className="gate-actions">
          <button ref={retryRef} type="button" className="btn primary" onClick={onRetry}>
            {t("tryAgain")}
          </button>
          <a className="btn" href="/login">
            {t("signIn")}
          </a>
        </div>
      </div>
    </div>
  );
}

/**
 * The same statement for a browser with NO mirror to stand behind it.
 *
 * Same card, same two acts, one different sentence: there is nothing on screen from this
 * device, so the body may not claim there is. It reuses `.gate` / `.gate-card` — the
 * product's own furniture, as `SessionScreen` does — rather than inventing a third layout for
 * a state a person meets for a few seconds.
 */
function UnconfirmedGate({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations("session");
  const retryRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    retryRef.current?.focus();
  }, []);
  return (
    <div className="gate">
      <div className="gate-card">
        <span className="wordmark">
          <b>
            <em>oh</em>mail
          </b>
        </span>
        <h1>{t("unconfirmedTitle")}</h1>
        <p>{t("unconfirmedBody")}</p>
        <div className="gate-actions">
          <button ref={retryRef} type="button" className="btn primary" onClick={onRetry}>
            {t("tryAgain")}
          </button>
          <a className="btn" href="/login">
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
 * ── `unauthenticated` NOW MEANS WHAT ITS COPY SAYS, WHICH IT DID NOT ALWAYS ────────────────
 *
 * `session.endedBody` — "We could not confirm this session, so nothing has been loaded" — is
 * reached only when the SERVER answered that there is no full session: an enrollment-scoped
 * session, the refresh endpoint's own coded 401, or a confirmed owner that is not the account
 * whose mirror this browser remembered. A 5xx, a gateway, a 429 or a dead socket used to land
 * here too, which made the sentence false in the one case people actually met it in — see
 * `OwnerOutcome` and `AUTH-FLICKER-DIAGNOSIS.md`. Those go to `unconfirmed` now, and the
 * source guard in `test/session-verdict-guard.test.ts` is what keeps them there.
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
            <Spinner className="mbx-spin" />
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
/**
 * THE CLIENT'S OWN ANSWER, WITHOUT THE HYDRATION SNAPSHOT — for effects, never for render.
 *
 * {@link useDemoMode} deliberately returns `serverDemo` on the hydration render so the markup
 * matches what the server sent, and the client answer only on the render after. That is right for
 * anything DRAWN and wrong for anything an effect DOES: a prerendered route bakes
 * `searchParams = {}`, so `serverDemo` is false while `resolveDemo` turns the demo on from
 * `window.location.search` — and an effect gated on the hydration value fires once, on a demo
 * page, believing it is not one. For the boot wake reconcile that meant real network calls from a
 * page whose whole promise is "fixtures only, nothing leaves the tab".
 *
 * Reading this IN RENDER OUTPUT would reintroduce the mismatch `useDemoMode` exists to prevent.
 * It is for effect gates.
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
 * THE CHANGES THIS CLIENT GAVE UP ON — what the "could not be saved" strip and its sheet read.
 *
 * The engine value-caches `abandoned()` for exactly this hook (same bargain `freshness()` strikes),
 * so the snapshot is stable while the set is unchanged and changes identity the moment it is not.
 *
 * **Deliberately NOT folded into the sync bar's speech.** `SyncBar` returns null whenever the sync
 * state has nothing to say, which is the ordinary healthy case — and an abandoned change is most
 * likely precisely THEN: syncing is fine, one verb the server kept refusing is not. Reusing that
 * component would have hidden the notice in the state where it matters most, which is the same
 * shape of defect as a guard that is green because it never ran.
 */
export function useAbandoned(): readonly AbandonedMutation[] {
  const engine = useEngine();
  const subscribe = useCallback((cb: () => void) => engine.subscribe(cb), [engine]);
  return useSyncExternalStore(subscribe, () => engine.abandoned(), () => NO_ABANDONED);
}

/**
 * Subscribe to the engine; returns the overlay-aware mirror version so memoized selectors
 * recompute when an ENTITY changes.
 *
 * "And only then" is what this used to claim, and it was false in the direction that costs: a
 * `/sync` page carrying no rows, and the drain's own completion stamp, both bumped the version, so
 * an idle client rebuilt every whole-mirror derivation on each poll. Both now leave it alone
 * (`store.ts` — `applyResponse` guards on its dirty set, `setMeta` does not touch `ver` at all), and
 * the claim is written as what the number MEANS rather than as a promise about renders.
 *
 * WHAT IT MEANS, exactly: the mirror AS THIS READER SEES IT moved. That is not the same as "a
 * record moved" — this is the OVERLAY-merged version (`OverlayReader.version()` is
 * `store.version() * 1_000_003 + overlayRev`), so registering, retiring or sweeping an optimistic
 * overlay moves it with no stored record touched at all. Which is right: a surface reading through
 * the overlay is looking at different rows either way.
 *
 * It does not say the reverse — a surface can still re-render for its own reasons, and on a large
 * mailbox each such render is a full pass over the mirror.
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
