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
 * What this tab has, and the states that are not yet a confirmed mailbox. The persistent mirror must be NAMED for a
 * server-issued account id (`engine-config.ts` records the cross-account leak), so the shell once had nothing to
 * render until `GET /auth/session` answered. `warm` removes the wait without removing the check: the `tf_owner` cookie
 * (`owner-cookie.ts`) is enough to OPEN the mirror — a local read of mail this browser holds — but not to BELIEVE,
 * so the same `GET /auth/session` runs in parallel and a mismatching or missing answer tears the engine down onto
 * the same refusal surface. "Immediately" means the first frame painted, not the first render — the hydration render
 * must say what the server said (`browserPass`). `resolving` remains the honest state for a browser with no
 * remembered account, and the only desktop state here.
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
 * `useLayoutEffect` in a browser; `useEffect` where there is nothing to lay
 * out. Chosen once, at module scope: React requires the same hooks every
 * render, so a condition inside the component would be a different hook on
 * server and client — and rendering `useLayoutEffect` on a server is its
 * own warning (no commit, no paint). The browser branch buys ORDER: a
 * layout effect runs inside the commit, before paint and passive effects,
 * so a state flip there is on screen in the same frame — which is what lets
 * the warm open move off the hydration render with no visible extra one.
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
   * The account this tab has decided it is for — called once, in the arm that has already
   * believed the answer, never from the classifier that produced it. Binding in
   * `resolveOwnerOutcome` was a sequence bug: it runs for every ladder attempt, including
   * cancelled ones, and BEFORE the comparison that decides whether the answer is about this
   * mirror — binding there mutated shared state in-flight requests are judged against, so a
   * request that left as A could be re-judged as B. A prop, not an import: `app/shell/**` ships
   * in the desktop program, which has no session client. Absent on the desktop and the demo.
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
     * A host-built engine is already the answer — checked after the demo,
     * before everything else. After the demo because that ordering is the
     * safety property: nothing may make a `demo: true` render run against a
     * non-fixtures engine, and an argument is not an exception. Before
     * everything else because the branches below ask about a mailbox
     * reached over the network, and this engine was built by the process
     * that holds the mailbox — no owner to look up, no session to confirm.
     */
    if (provided) return { status: "ready", demo: false, engine: provided };
    return { status: "resolving" };
  });

  /**
   * The hydration render belongs to the server. `false` on the first render on each side, `true` from the
   * second on the client. The warm open used to happen in the initializer — the client's first render
   * produced the whole mail client over the server's near-empty gate, and React threw the server markup away
   * and re-rendered everything ("the whole root is switching to client rendering"), a real cost on the exact
   * load the warm open exists to make fast. Not a suppressed warning: `suppressHydrationWarning` keeps the
   * mismatch and the re-render — the divergence has to move, not mute. And it costs nothing the warm open was
   * buying: the flip is a LAYOUT effect, in the same commit, before paint — hydration commits the gate, this
   * flips, the first paint is the mail. No round trip moved.
   */
  const [browserPass, setBrowserPass] = useState(false);
  useAfterHydration(() => {
    setBrowserPass(true);
  }, []);

  /**
   * The warm open, one render after hydration. `readOwner()` is a synchronous cookie read with
   * no side effects — legal in render; this is React's own "adjusting state when a prop
   * changes" shape, so nothing paints in between. Three load-bearing gates: past the hydration
   * render ({@link browserPass}); a remembered id (without one there is no name for the mirror,
   * and guessing one is the bug this seam prevents); and a `resolveOwner` — a build with no way
   * to ASK cannot open a mailbox on a cookie alone; the confirmation is what makes the optimism
   * safe, which also keeps the desktop client (no resolver, no cookie) on its old path.
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
    // Two teardowns, and only one of them is this line's. The engine owns
    // no timers, but it can be BUSY: a drain pages until `hasMore` is false
    // (~37 requests on a cold account), so "replacing the reference is safe
    // because nothing runs inside it" was false — a live→demo navigation
    // kept issuing live `/sync` calls behind a page that promises zero
    // egress. The SCHEDULER owns the timer and the window listeners and is
    // torn down by the effect below (dependency: `engine`); that cleanup
    // also closes the engine's per-page abort gate (`sync-scheduler.ts`),
    // so the in-flight drain stops at its next page boundary. A live→demo
    // navigation cancels the poll AND the drain — not merely stops caring.
    setBinding(
      desired ? { status: "ready", demo: true, engine: createEngine(true) } : { status: "resolving" },
    );
  }, [desired, binding, provided]);

  /**
   * Ask whose mailbox this is, then build the engine that persists it. The middleware proved a session existed and
   * said nothing about WHO; the account id names the mirror, and the re-ask is the honest re-check (a session
   * revoked between the two must not open a mailbox). An ANSWERED refusal lands on `"unauthenticated"` — a rendered
   * explanation and a link, never an automatic redirect: middleware and this call reach the API by different
   * routes, and a redirect on disagreement is an infinite loop. A FAILURE to answer lands elsewhere:
   * `{kind:"unknown"}` is retried — {@link CONFIRM_ATTEMPTS} asks on {@link nextConfirmDelay}'s backoff — then
   * reported as a check that did not finish. The retry is a re-render into `"checking"`, not a loop in this effect:
   * the delay is testable state and the timer dies with the effect's own cleanup.
   */
  useEffect(() => {
    if (binding.status !== "resolving" && binding.status !== "warm" && binding.status !== "checking") return;
    /**
     * Not on the hydration commit — this line keeps the check to ONE
     * request. The warm open is decided on the render after hydration
     * ({@link browserPass}), so on the commit before it every browser looks
     * like one with no remembered account: asking there would spend a check
     * against `"resolving"` and then another against the `"warm"` binding
     * this effect's own dependency list would re-run it for. Waiting one
     * commit costs nothing (the flip is a layout effect, before paint) and
     * the question is asked once, against the binding actually on screen.
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
         * A confirmed owner disproves a held session death — and the latch must be told,
         * because the death store is module state and a sign-in is a client-side navigation.
         * Found live: /login signed out runs `auth.session()`, whose 401 sends `api()` through
         * the refresh, whose own coded 401 latches the store — and `router.push("/")` carried
         * that latch into the freshly signed-in shell, rendering "signed out" over a session
         * the server had just confirmed. This answer IS the server's "full session", read at
         * the boundary every sign-in re-crosses, so the claim is withdrawn here. A mid-use
         * death is untouched.
         */
        markSessionAlive();
        if (warm) {
          /**
           * The shared-browser case — the reason the check is a COMPARISON, not a presence
           * test. The question is not "did the server confirm a session" but whether it
           * confirmed THIS one: a browser can hold a remembered id for one account and a live
           * session for another (a second sign-in in the same profile, a restored cookie jar),
           * and then the painted rows belong to neither. A mismatch ends the tab rather than
           * swapping the engine — the harsher branch on purpose: the sign-in link re-mints the
           * cookie and the next load opens the right mirror; the alternative is a mailbox that
           * changes identity mid-session.
           */
          /*
           * The mirror's sync gate opens HERE, once the comparison has passed and before the
           * binding changes. A scheduled engine is not a merging engine: the warm engine has been
           * painting since hydration with its gate closed — no `/sync`, no snapshot, no mutation —
           * because nobody had told it whose mailbox it holds. `confirmSyncOwner` is that telling,
           * inside the MATCH arm (the mismatch arm opens nothing, so A's engine never merges under
           * B's session), and before `setBinding` so the scheduler's first tick sees an open gate
           * rather than racing it.
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
         * A broken deployment reaches the error boundary — by being re-thrown in a RENDER.
         * `EngineUnarmedError` and the rethrown `ApiError(0, "api_unconfigured")` mean "never wired
         * to a server", not an auth outcome. A `throw` here is a detached `.catch` — an unhandled
         * rejection, which boundaries never see — so the promised error screen never appeared; a
         * tab wedged on `resolving` did. Held and rethrown from the render instead. `fatal` is
         * written once and never cleared: no recovery exists for a bundle with no server, and "Try
         * again" over it is the same false promise.
         */
        if (err instanceof EngineUnarmedError || isApiUnconfigured(err)) {
          if (!cancelled) setFatal(err);
          return;
        }
        /**
         * Every other throw is also not an auth outcome — and this branch
         * used to say it was. `resolveOwner` answers rather than rejects,
         * so what reaches here blew up on OUR side: `createEngine` refused
         * (IndexedDB unavailable in a hardened profile or private window),
         * or the classifier rethrew an unarmed build. None of that is
         * evidence about the session, and `unauthenticated` claimed it was.
         * It reports and lands on `unconfirmed`, whose copy is true of all
         * of them. A dedicated storage-refusal screen is a follow-up gap.
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
   * A fresh session clears an unconfirmed check — the one automatic escape from `unconfirmed`, which
   * is the end of the ladder. A `204` from `POST /auth/refresh` is a server-confirmed world change
   * that can arrive from somewhere this tree is not watching (the sync loop's probe, a body fetch);
   * `session-truth.ts` publishes exactly that event. Bounded by construction: at most one revival per
   * successful refresh, returning the binding to its FIRST attempt, so a revival cannot compound;
   * only `unconfirmed` subscribes. SAME TAB ONLY — the store is module state with no BroadcastChannel
   * and no storage event, so a second tab keeps its notice until someone presses Try again, which is
   * why that button is the primary action.
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
   * What the sync loop is doing. Only a live engine moves it off its resting value — the demo
   * drains once from fixtures. The updater returns `prev` when nothing changed, a bail-out
   * rather than a micro-optimisation: a healthy tab settles a drain every eight seconds
   * forever, and each would re-render the whole shell to publish an identical value. ALL FOUR
   * fields are compared ({@link sameSyncStatus}): `terminal` and `refused` were once left out
   * and survived only because the scheduler happened to move `failures` in the same publish — a
   * dedup blind to one field is one refactor from swallowing the transition.
   * `test/sync-liveness.test.ts` guards the comparator.
   */
  const [sync, setSync] = useState<SyncStatus>(SYNC_BOOTSTRAPPING);
  const onSyncStatus = useCallback((next: SyncStatus) => {
    setSync((prev) => (sameSyncStatus(prev, next) ? prev : next));
  }, []);

  /**
   * `warm` is a rendering, syncing engine — so both derivations include it and must produce the SAME values
   * before and after the confirmation lands (they do: `warm` carries the same engine object it hands to
   * `ready`). That identity makes the confirmation invisible: the effect below depends on `[engine, live]`,
   * and a warm → ready transition that changed either would tear the scheduler down and re-bootstrap a mirror
   * already draining. `checking`/`unconfirmed` carry their mirror for the same continuity (`warmOf` returns
   * the very object), so a 503 on the confirm never costs the tab its sync loop; a cold one has no mirror and
   * runs nothing. Being scheduled is NOT being allowed to merge: the mirror's own sync gate decides what a
   * scheduled engine may DO (`createSyncGate`/`confirmSyncOwner`).
   */
  const warmMirror = warmOf(binding);
  const engine = binding.status === "ready" ? binding.engine : warmMirror?.engine ?? null;
  const live = warmMirror !== null || (binding.status === "ready" && binding.demo === false);

  /**
   * A death confirmed DURING THIS MOUNT — a different fact from the latch itself. Gating
   * `SessionEnded` on `ready` closed the stale-latch defect and opened a smaller one: a session
   * revoked while a warm binding sat in `checking`/`unconfirmed` could not be reported at all —
   * the user kept "the check did not finish" over a session that had genuinely ended. What
   * matters is not "is the latch set" but "did this tab watch it get set": a latch inherited
   * from the page before this mount is somebody else's evidence, so the subscription records
   * the false → true transition and an already-true store at mount is not counted.
   */
  const [deathSeenHere, setDeathSeenHere] = useState(false);
  useEffect(() => {
    if (!live) return;
    return subscribeSessionTruth(() => {
      if (sessionIsDead()) setDeathSeenHere(true);
    });
  }, [live]);


  /**
   * Ask again, by hand — the primary action on the unconfirmed surface. It
   * puts the binding back where the ladder started (attempt one, no delay):
   * `warm` when there is a mirror, so nothing on screen moves and the same
   * engine keeps draining; `resolving` when there is not. Deliberately not
   * `location.reload()` — the fragment is the view, the mirror is open, and
   * re-downloading the document to re-ask one question throws away both.
   * Depends on `warmMirror`, not `binding`, so pressing it cannot resurrect
   * a mirror from a binding that has moved on.
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
   * A revoked mirror asks to be confirmed again. Revocation is monotonic on purpose — only a
   * fresh server answer reopens the gate — which left one state with no way out: on a `ready`
   * binding the confirm effect finished long ago, so when the marker came back to naming this
   * mirror the tab cleared its terminal strip and then sat with reads, sync, mutations and the
   * wake stream all disabled, looking well. The gate now says when it could plausibly be
   * re-asked (`onNeedsConfirm`, once per revocation), and this puts the binding back to `warm`
   * so the ladder runs again with the SAME engine — nothing re-mounts; the answer reopens the
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
     * The wake signal, and why it is here rather than in a prop. This was one `engine.start()` and nothing else
     * — no EventSource, no interval, no `visibilitychange` — so one throw produced a permanently empty mailbox
     * and new mail never arrived without a reload (all shipped). `sync-scheduler.ts` is the second half: a
     * serialized poll while visible, an immediate drain on return or reconnect, jittered backoff on failure.
     * Wired HERE, not passed down like `resolveOwner`: that seam keeps `app/api-client` out of the desktop
     * bundle, while a scheduler imports nothing but `setTimeout`, `document` and the engine — a prop would only
     * buy a silent-omission mode (a shell that forgets one never syncs again, this bug re-created as wiring).
     * The demo keeps the single `start()`: fixtures, no server, no cursor.
     */
    if (!live) {
      void engine.start().catch((err: unknown) => {
        console.error("ohmail: the mailbox sync engine failed to start", err);
      });
      return;
    }
    // A desktop build keeps its full cadence while occluded; a browser tab
    // drops to the hidden cadence (one drain a minute, no stream).
    // `visibility: null` is the scheduler's "no visibility model" seam,
    // passed ONLY under the desktop build flag (`engine-config.ts` →
    // `syncsWhileHidden`) — never unconditionally, or the web build would
    // stop respecting a hidden tab (a web-side grep guards the leak).
    // `wake` is the push half: an EventSource on `/events` whose `sync`
    // frames drain through this same scheduler. `cloudWakeStream()` decides
    // WHICH builds hold one (web live only); the scheduler decides WHEN
    // (visible only) and survives the stream's absence byte-identically.
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
      {/* The re-auth surface, live engines only — the demo has no session
          and the desktop's store never leaves its resting value. And only
          once this mount has confirmed something: `ready`, never `warm`,
          `checking` or `unconfirmed`. The death latch is module state that
          survives a client-side navigation, so a freshly signed-in shell
          can inherit a truthful `true` from the /login page before it —
          rendered on a `warm` binding that stale latch puts "This session
          ended" over a live mailbox, and a 503 on the confirm would never
          withdraw it. The gate is the BINDING rather than `live`: a latch
          observed before this mount is not evidence about this mount. */}
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
 * Make the background inert while a modal surface is up, and take it back on the way out.
 * `role="alertdialog"` with `aria-modal="true"` is a CLAIM that nothing behind the dialog can be
 * reached, and a scrimmed layer only blocks pointer hits: the mailbox stayed in the tab order and
 * the shell's document-level keymap kept dispatching — `e` parked the focused message and two `d`
 * presses could run the delete ceremony behind the screen. `inert` closes all three at once (focus,
 * hit-testing, event dispatch), applied to the app root rather than `document.body` so the dialog —
 * a sibling of the root — stays live. Applied by BOTH dialogs: a modal honest on one screen and a
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
 * The re-auth prompt — what a dead session shows instead of a quietly wrong mailbox: rows painted, counts frozen,
 * every failure dressed as a content failure, no surface offering the one act that fixes it. It renders over the shell
 * — the mail stays visible, dimmed behind a scrim and inert — and offers sign-in. It speaks only on the confirmed
 * fact: `useSessionDead()`, set exclusively by a coded 401 from `POST /auth/refresh` — never one failed request. And
 * it hurries the QUESTION, not the answer: on first evidence (`sync.refused`/`sync.terminal`) it probes via
 * `probeSessionNow()` — one single-flight refresh, definitive both ways: a lapsed-but-resumable session heals
 * silently; a revoked one is confirmed in one round trip instead of one minute. Rising-edge gated; a no-op where no
 * probe is registered. `role="alertdialog"`; focus moves to the remedy.
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
     * …and not when the evidence is somebody else's session. `sync.terminal` has two causes and
     * this probe fits one: a server refusal asks about THIS account; a CONTRADICTED mirror stopped
     * because the jar names a different account, so the refresh would rotate somebody else's token
     * — and in a bad interleaving present a token their own tab is about to present. `!== "holds"`,
     * not `=== "contradicted"`: a REVOKED gate has as little business renewing a session, and the
     * narrower test let a failed sign-out's session be refreshed. Read at EFFECT time: the jar can
     * change render-to-effect.
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
 * "The check did not finish" — the end of the ladder. Four asks over one to thirty seconds got no ANSWER out
 * of `GET /auth/session` (`confirm-schedule.ts`; `OwnerOutcome`). The one thing this surface may not do is
 * report that as a session ending — the cookie may be, and in the measured case was, perfectly live; what
 * failed was the question. The copy names the failure (`session.unconfirmedTitle`/`unconfirmedBodyWarm`);
 * neither string contains "signed out", and a source guard keeps it so. The primary is Try again — it re-asks
 * the question that failed; Sign in is a demoted exit (occasionally right, and a one-button screen is a
 * trap). It yields to the real verdict: if `useSessionDead()` latches while this is up, `SessionEnded` is the
 * truthful surface and this gets out of the way.
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
 * The two states that are not a mailbox. `unauthenticated` now means what its copy says: reached only when the SERVER answered
 * that there is no full session (enrollment-scoped, the refresh's coded 401, or a confirmed owner that is not the remembered
 * account). A 5xx or dead socket used to land here too, making the sentence false in the one case people met it; those go to
 * `unconfirmed` now, held by `test/session-verdict-guard.test.ts`. Same markup as the mailbox page's gate, so a visitor sees
 * the product's own furniture. `resolving` is mostly silent — a sentence that flashes is worse than a quiet frame — but over a
 * slow link the blank page was followed by "Nothing in your Ohbox"; `useLoadingGrace` keeps both promises: below the grace,
 * the empty live region; above it, a sentence in the SAME `aria-live` node, so its late arrival is announced. It says the app
 * is opening the mailbox — nothing about what is in it.
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

/** The overlay-merged reader (stable object; version() tracks change). */
export function useReader(): EntityReader {
  return useEngine().read();
}
