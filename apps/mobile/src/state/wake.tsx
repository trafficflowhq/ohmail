import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from "react";
import { useConnection } from "../net/connection";
import { dropWakeRowOrOwe, forgetWake, registerWake, NO_DISTRIBUTOR, type WakeState } from "../net/push";
import type { ConnectedSession } from "../net/pairing";
import { nativeServerProfiles } from "./servers-native";
import {
  chooseDistributor, listDistributors, onWake, requestNotificationPermission, savedDistributor,
  unifiedPushDistributor, type DistributorChoice,
} from "../net/unified-push";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE WAKE LIFECYCLE — MOUNTED AT THE ROOT, because that is what the copy promises
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * One provider owning three things that are only meaningful together: which distributors this
 * phone has, which one is chosen, and what happened when we registered with the server. Splitting
 * them would let the screen render a chosen distributor beside a registration made against a
 * different one.
 *
 * ── WHY THIS IS A PROVIDER AND NOT A HOOK THE SETTINGS SCREEN CALLS ───────────────────────────
 *
 * It WAS a hook, and that was a real defect. The `onWake` subscription — the one
 * that turns a delivered wake into a `/sync` — lived inside it, so it existed only while the
 * pushed Settings screen was mounted. A launch that never opened Settings had no listener at all,
 * and pressing Back after enabling wakes tore down the one there was. The app's own copy says a
 * wake arrives "while ohmail is running — open or in the background", and that sentence was false
 * for every user who was not sitting on the Settings screen.
 *
 * So the lifetime of this is the APP's, mounted beside the connection provider in `_layout.tsx`.
 * Settings consumes it through {@link useWake} and renders; it no longer owns anything.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────────────────────────
 *
 * NO transport. Every request goes through `net/push.ts`, which is the file the privacy census
 * admits to the network seam and which holds no origin of its own; this module holds React state
 * and calls it. That is why it lives in `state/` — the census forbids a file outside the seam from
 * making a request, and this one does not.
 *
 * ── THE REGISTRATION IS RE-MADE ON EVERY ATTEMPT, NOT CACHED ──────────────────────────────────
 *
 * The connector's own guidance is to register on every app start, because that is also how it
 * confirms the distributor connection is alive. The server deduplicates: one endpoint is one row,
 * and a re-registration re-stamps the device and the keys rather than accumulating. So there is
 * nothing to be clever about — asking again is cheap and is what heals a stale registration.
 */

export interface Wake {
  /** The single fact the pane renders its sentence from. */
  state: WakeState;
  /** Distributors installed on this phone. EMPTY on iOS and on a phone with none. */
  choices: DistributorChoice[];
  /** Which one is chosen, or null. */
  chosen: string | null;
  /** True while a registration attempt is in flight — the pane disables the rows. */
  busy: boolean;
  /** Choose a distributor and register with the active profile's server. */
  choose(id: string): void;
  /** Turn it off: drop the server registration, then forget the distributor. */
  turnOff(): void;
}

const WakeContext = createContext<Wake | null>(null);

/**
 * Read the wake state. Throws outside the provider rather than answering a plausible default:
 * a silent "no distributor" would look exactly like a phone that has none, which is the bug this
 * whole file exists to stop being invisible.
 */
export function useWake(): Wake {
  const w = useContext(WakeContext);
  if (w === null) throw new Error("useWake outside WakeProvider");
  return w;
}

export function WakeProvider({ children }: { children: ReactNode }) {
  const conn = useConnection();
  const session = conn.state.k === "live" ? conn.state.session : null;

  const [state, setState] = useState<WakeState>({ k: "no_distributor" });
  const [choices, setChoices] = useState<DistributorChoice[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The id of the registration currently held, for {@link Wake.turnOff}.
   *
   * A ref and not state: nothing renders it, and putting it in state would make every registration
   * a second render for a value only a callback reads.
   */
  const subscriptionId = useRef<string | null>(null);

  /**
   * ── THE GENERATION, AND WHY MAKING THIS A PROVIDER CREATED THE NEED FOR IT ────────────────────
   *
   * While this lived in the Settings screen, leaving the screen unmounted everything, so a
   * registration for profile A could not outlive a switch to profile B. Now that it survives every
   * screen — which is the whole point — an in-flight registration CAN: the connector's `register`
   * has a fifteen-second ceiling, and a profile switch inside that window used to let A's late
   * result overwrite B's state and, worse, B's `subscriptionId`. Turning wakes off then sent A's
   * subscription id to B's server (a 404) and left A's row live, sending wakes to a phone that had
   * moved on. That is the cost of the fix above, and it is paid here.
   *
   * One counter, bumped every time the live session changes, plus the session object itself so a
   * delivered wake can be checked against the session it was subscribed for. Refs rather than state
   * because every reader is a callback, and a re-render would be a wasted one.
   */
  const generation = useRef(0);
  const liveSession = useRef<typeof session>(null);

  /**
   * Take a row down and, if the server refuses, OWE it — see `net/push.ts#dropWakeRowOrOwe`.
   * Both uses below are fire-and-forget by necessity, which is exactly why the verdict has to
   * land somewhere durable rather than in a discarded promise.
   */
  const owedDrop = useCallback(
    (on: ConnectedSession, id: string): Promise<void> =>
      dropWakeRowOrOwe(on, id, nativeServerProfiles()).then(() => undefined),
    [],
  );

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  EVERY WAKE MUTATION RUNS ALONE — one chain, no overlap
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * The generation counter discards a STALE RESULT, and that is all it can do. It cannot undo a
   * SIDE EFFECT that has already happened on the server or, worse, on the one app-wide connector
   * registration this build shares between profiles. Two races followed from that, and both
   * ended with the pane saying "on" over a phone that no wake could reach:
   *
   *  · **off, then immediately on.** `turnOff` fires its DELETE and returns; a new choice
   *    re-registers the SAME endpoint, the server dedupes and answers the SAME id, the pane
   *    lands on `on` — and then the earlier DELETE arrives and removes the row that was just
   *    re-adopted. The verdict was fine at the moment it was read and false a moment later.
   *  · **a superseded registration finishing LAST.** `distributor.register(key)` binds the whole
   *    app to that server's VAPID key. A's call held for its fifteen-second ceiling, B's
   *    completed and reported `on`, and then A's landed and rebound the connector to A's key —
   *    so B's server signs wakes this phone will not render, silently, while Settings says on.
   *    No generation check can reach back and undo a native side effect.
   *
   * So the operations queue instead. Serialization costs a switch the tail of the previous
   * registration — up to that same ceiling — and buys the only ordering in which the last write
   * to the connector and the last write to a server row belong to the profile on screen.
   */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const serialize = useCallback((op: () => Promise<unknown>): Promise<unknown> => {
    // `then(op, op)` — a failed operation must not poison the queue, the same shape the profile
    // store's mutation chain uses.
    const run = chain.current.then(op, op);
    chain.current = run.catch(() => undefined);
    return run;
  }, []);

  /** Re-read the device's own answer. Cheap, synchronous, and the source of truth for the list. */
  const readDevice = useCallback((): void => {
    setChoices(listDistributors());
    setChosen(savedDistributor());
  }, []);

  /**
   * Attempt a registration and land on whatever it answers.
   *
   * `mounted` guards the state writes: the connector's register has a fifteen-second ceiling, and a
   * setState after unmount is a warning nobody can act on and a value written into a tree that no
   * longer exists.
   */
  const attempt = useCallback(async (mounted: () => boolean): Promise<void> => {
    if (!session) return;
    // The generation this attempt belongs to, captured BEFORE the await. Anything that lands after
    // the session changed is a superseded completion and is dropped, state and id together.
    const mine = generation.current;
    const fresh = (): boolean => mounted() && generation.current === mine;
    setBusy(true);
    try {
      const next = await registerWake(session, unifiedPushDistributor());
      if (!fresh()) {
        /**
         * ── A SUPERSEDED REGISTRATION STILL CREATED A ROW ────────────────────────────────────
         *
         * Dropping the RESULT was right and dropping the row with it was the bug. `registerWake`
         * has a fifteen-second ceiling, so a profile switch inside that window lands here — and
         * the POST has already committed a `push_subscriptions` row on the OUTGOING server,
         * against the one endpoint this whole app shares. The session-change effect below cannot
         * clean it up, because at the moment it ran `subscriptionId.current` was still null.
         * So the id is spent here, on the session it was made for, and the row goes down.
         */
        if (next.k === "on") await owedDrop(session, next.id);
        /**
         * ── AND THE CONNECTOR IS RE-BOUND TO WHOEVER IS LIVE NOW ──────────────────────────
         *
         * The row was this arm's original job. The other half is the DISTRIBUTOR: a successful
         * `registerWake` has already bound the app's single connector registration to THIS
         * server's VAPID key, and if a newer profile registered while we were in flight, the
         * chain guarantees we ran first — but a completion that is superseded by a session
         * change with no new registration behind it (a switch to a profile with no distributor
         * chosen yet, a disconnect and reconnect) would still leave the connector on the old
         * key. Re-running for the live session is idempotent by the server's own dedupe.
         */
        const live = liveSession.current;
        if (next.k === "on" && live !== null && live !== session && savedDistributor() !== null) {
          void serialize(() => attemptRef.current(mounted));
        }
        return;
      }
      subscriptionId.current = next.k === "on" ? next.id : null;
      setState(next);
    } catch {
      /**
       * A TERMINAL CATCH, even though `registerWake` now maps every failure to a state.
       *
       * Every caller queues this and drops the promise (`void serialize(() => attempt(…))`), so
       * anything that escapes is an unhandled rejection —
       * and the pane would keep its previous state, which after a successful registration means it
       * says "on" about nothing. `registerWake`'s contract is that it does not throw; this is here
       * so that the contract being wrong is a visible "off" rather than a silent lie plus a console
       * warning. A contract worth having is worth not depending on.
       */
      if (fresh()) {
        subscriptionId.current = null;
        setState({ k: "off", reason: "server_unavailable" });
      }
    } finally {
      if (fresh()) setBusy(false);
    }
  }, [session]);

  /**
   * On mount, and whenever the live session changes: read the device, then register if a
   * distributor is already chosen.
   *
   * The session dependency matters. Switching server profiles means a different VAPID key and a
   * different `push_subscriptions` row, so a registration made against the old profile says nothing
   * about the new one — the state has to be recomputed rather than carried across.
   */
  useEffect(() => {
    let alive = true;
    const mounted = (): boolean => alive;
    // A NEW GENERATION. Every attempt still in the air for the previous session is now superseded
    // and will discard its own result rather than writing it over this one's.
    generation.current += 1;
    /**
     * ── THE PREVIOUS SERVER'S ROW GOES DOWN BEFORE THE NEXT ONE GOES UP ────────────────────
     *
     * This build holds ONE UnifiedPush registration for the whole app, and every paired server
     * stores its own `push_subscriptions` row against that one endpoint. So leaving profile A's
     * row behind on a switch to B does not leave a dormant record — it leaves A's server POSTing
     * wakes to a phone that no longer syncs A, indefinitely, while the app answers each one by
     * syncing B. The file's own header already named this failure for the state-overwrite half
     * ("left A's row live, sending wakes to a phone that had moved on") and fixed only that half.
     *
     * The ROW and not the distributor: unregistering the endpoint would take the next profile's
     * wakes down with it (see `dropWakeRow`). Fire-and-forget on the OUTGOING session's own
     * bearer, which is still usable — the connection layer's teardown closes the store, not the
     * credential — and it must not hold the switch open.
     */
    const previous = liveSession.current;
    const previousId = subscriptionId.current;
    if (previous && previous !== session && previousId !== null) {
      subscriptionId.current = null;
      // QUEUED, like every other wake mutation: the outgoing row's DELETE must not overtake or
      // be overtaken by the incoming profile's registration.
      void serialize(() => owedDrop(previous, previousId));
    }
    liveSession.current = session;
    readDevice();
    if (!session) {
      setState({ k: "no_distributor" });
      return () => { alive = false; };
    }
    if (savedDistributor() !== null) void serialize(() => attempt(mounted));
    else setState({ k: "no_distributor" });
    return () => { alive = false; };
  }, [session, attempt, readDevice, owedDrop, serialize]);

  /**
   * ── NOTHING IS PAIRED ANY MORE, SO NOTHING MAY BE REGISTERED ──────────────────────────────
   *
   * Forgetting the last server takes its `push_subscriptions` row down server-side (the hosted
   * `logout` prunes by device), but the DISTRIBUTOR registration is this phone's own and no
   * server can reach it: without this the connector keeps holding an endpoint for an app that
   * is paired with nothing, and the chosen-distributor preference keeps saying wakes are on.
   *
   * Gated on the LAST pairing precisely because the registration is shared — dropping it while
   * another profile still exists would silently turn that profile's wakes off.
   */
  const nothingPaired = conn.profiles.length === 0;
  useEffect(() => {
    if (!nothingPaired) return;
    subscriptionId.current = null;
    // Queued too — the endpoint is the app's single shared registration, so unregistering it
    // must not overtake a row deletion still in flight against a server that is being forgotten.
    void serialize(() => unifiedPushDistributor().unregister().catch(() => undefined));
    chooseDistributor(null);
    readDevice();
    setState({ k: "no_distributor" });
  }, [nothingPaired, readDevice, serialize]);

  /**
   * A DELIVERED WAKE MEANS ONE THING: PULL.
   *
   * This subscription is the reason the whole module is a root provider. It has to outlive every
   * screen — a wake arriving while the user is reading their inbox must sync, and before this it
   * only did if they happened to have Settings open.
   *
   * `conn.syncNow()` is the same call pull-to-refresh makes: the wake is a TRIGGER for the sync the
   * app already knows how to do, never a source of data. That is what makes a closed fifteen-byte
   * constant sufficient.
   */
  useEffect(() => {
    if (!session) return;
    const subscribedFor = session;
    return onWake(() => {
      /**
       * THE SESSION THIS WAKE WAS SUBSCRIBED FOR MUST STILL BE THE LIVE ONE.
       *
       * `conn.syncNow()` reads the connection's own live ref, and during a profile switch there is a
       * window where teardown has begun and that ref has not caught up — a wake landing in it would
       * start a drain on a session whose store is already scheduled to close. Comparing against the
       * session captured at subscribe time closes this module's half of that without reaching into
       * the connection layer, whose own guard is the other half.
       */
      if (liveSession.current !== subscribedFor) return;
      void conn.syncNow();
    });
  }, [session, conn]);

  /**
   * A stable handle on the newest `attempt`, so the superseded arm above can re-run it without
   * `attempt` having to depend on itself (which is not expressible) or capturing a stale one.
   */
  const attemptRef = useRef(attempt);
  attemptRef.current = attempt;

  const choose = useCallback((id: string): void => {
    chooseDistributor(id);
    // Opting into wakes is the moment to ask for the notification permission the KILLED-APP notice
    // needs (Android 13+ starts it denied). Fire-and-forget: a denial is fine — the wake still syncs
    // on open, and the copy says the closed-app notice depends on it. There is an Activity in the
    // foreground here (a Settings tap), which is where the OS prompt can appear.
    void requestNotificationPermission();
    readDevice();
    // `() => true` for the MOUNT question only: a choice made by a tap is one the user is waiting
    // on, so its result is worth writing even if the pane re-rendered underneath it. The generation
    // check inside `attempt` is what still discards it if the SESSION changed — those are different
    // questions and conflating them is what let a superseded registration land.
    //
    // QUEUED behind any wake mutation still running — in particular a `turnOff` the reader may
    // have tapped a moment ago, whose DELETE would otherwise land after this registration and
    // remove the very row the server just handed back (it dedupes on the endpoint, so the id is
    // often the SAME one).
    void serialize(() => attempt(() => true));
  }, [attempt, readDevice, serialize]);

  const turnOff = useCallback((): void => {
    const id = subscriptionId.current;
    subscriptionId.current = null;
    // The SERVER first, then the device — `forgetWake`'s order, for its reason: the row is what
    // causes wakes, so it goes before the endpoint that receives them stops existing.
    //
    // THE LOCAL STATE CLEARS EITHER WAY, AND THE CLAIM DOES NOT. Turning wakes off is something
    // a person did on purpose and must not fail in their face, so the distributor choice and the
    // pane's state move immediately. But `forgetWake` now answers whether the SERVER row really
    // went, and a refusal replaces "off" with the sentence that says what is still there — this
    // used to render a removal over a 401, a 500 or a dead network alike.
    if (session) {
      void serialize(async () => {
        // Through the SAME durable path as every other row removal: this used to be the one
        // that was not, so a refused delete lived only in this provider and one restart lost the
        // id — while the pane then said nothing wakes this app, over a row still being dialled.
        const dropped = await forgetWake(session, unifiedPushDistributor(), id, nativeServerProfiles());
        if (!dropped.ok && liveSession.current === session) setState({ k: "off", reason: "row_remains" });
      });
    } else {
      void serialize(() => NO_DISTRIBUTOR.unregister());
    }
    chooseDistributor(null);
    readDevice();
    setState({ k: "no_distributor" });
  }, [session, readDevice, serialize]);

  return (
    <WakeContext.Provider value={{ state, choices, chosen, busy, choose, turnOff }}>
      {children}
    </WakeContext.Provider>
  );
}
