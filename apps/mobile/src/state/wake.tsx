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
 * The wake lifecycle — mounted at the root, because that is what the copy promises. One
 * provider owning three things only meaningful together: which distributors this phone has,
 * which is chosen, and what happened when we registered. As a hook inside the Settings screen
 * the `onWake` subscription existed only while that screen was mounted — a launch that never
 * opened Settings had no listener, making "while ohmail is running" false; so its lifetime is
 * the app's (`_layout.tsx`), and Settings consumes {@link useWake}. No transport here — every
 * request goes through `net/push.ts`, the seam the privacy census admits. The registration is
 * re-made on every attempt: the server deduplicates, and asking again heals a stale one.
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
   * The generation — the cost of being a provider, paid here. In the Settings screen, leaving
   * unmounted everything, so a registration for profile A could not outlive a switch to B.
   * Surviving every screen, an in-flight registration can: the connector's `register` has a
   * fifteen-second ceiling, and a switch inside that window let A's late result overwrite B's
   * state and B's `subscriptionId` — turning wakes off then sent A's id to B's server and left
   * A's row live. One counter, bumped on every session change, plus the session object so a
   * delivered wake is checked against the session it was subscribed for. Refs rather than
   * state because every reader is a callback.
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
   * Every wake mutation runs alone — one chain, no overlap. The generation counter discards a
   * stale result; it cannot undo a side effect already landed on the server or the connector.
   * Two races both ended with the pane saying "on" over a phone no wake could reach: off then
   * immediately on (the earlier DELETE arrives last and removes the row just re-adopted), and
   * a superseded registration finishing last (`register(key)` binds the whole app to that
   * server's VAPID key — a late completion rebound the connector while the live server signs
   * wakes this phone will not render). The queue buys the only ordering where the last writes
   * to connector and server row belong to the profile on screen.
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
         * And the connector is re-bound to whoever is live now. The row was this arm's
         * original job; the other half is the distributor: a successful `registerWake` bound
         * the connector to this server's VAPID key, and a completion superseded by a session
         * change with no new registration behind it (a switch to a profile with no distributor
         * chosen, a disconnect and reconnect) would leave the connector on the old key.
         * Re-running for the live session is idempotent by the server's own dedupe.
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
     * The previous server's row goes down before the next one goes up. Leaving profile A's row
     * behind on a switch to B leaves A's server POSTing wakes at this phone until it collects
     * enough refusals to prune. The row and not the distributor: with per-profile endpoints
     * A's instance could be dropped safely, and removing the row is still what discharges the
     * invariant — no server holds a row for a pairing this phone is not using.
     * Fire-and-forget on the outgoing session's own bearer, which is still usable (teardown
     * closes the store, not the credential) — it must not hold the switch open.
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
   * Nothing is paired any more, so nothing may be registered. Forgetting the last server takes
   * its `push_subscriptions` row down server-side, but the distributor registration is this
   * phone's own and no server can reach it: without this the connector keeps holding an
   * endpoint for an app paired with nothing, and the chosen-distributor preference keeps
   * saying wakes are on. Gated on the last pairing precisely because the registration is
   * shared — dropping it while another profile exists would silently turn its wakes off.
   */
  const nothingPaired = conn.profiles.length === 0;
  useEffect(() => {
    if (!nothingPaired) return;
    subscriptionId.current = null;
    /**
     * `chooseDistributor(null)` is the sweep now — the connector's own guarantee: clearing the
     * saved distributor "will clear all instances registered with the distributor".
     * Registrations are per profile, so each forget has already dropped its own instance; this
     * closes the case where one of those drops was refused, without naming an instance (none
     * is left to name). The gate on the last pairing stays because the distributor choice is
     * app-wide — forgetting one of two servers must not un-choose it.
     */
    chooseDistributor(null);
    readDevice();
    setState({ k: "no_distributor" });
  }, [nothingPaired, readDevice, serialize]);

  /**
   * A delivered wake means one thing: pull. This subscription is the reason the whole module
   * is a root provider — it has to outlive every screen, since a wake arriving while the user
   * reads their inbox must sync, and before this it only did with Settings open.
   * `conn.syncNow()` is the same call pull-to-refresh makes: the wake is a trigger for the
   * sync the app already knows how to do, never a source of data — which is what makes a
   * closed fifteen-byte constant sufficient.
   */
  useEffect(() => {
    if (!session) return;
    const subscribedFor = session;
    /* SCOPED TO THIS PROFILE'S INSTANCE. A wake now names the pairing it was delivered for, and
       one for a profile that is not on screen must not start a drain on the one that is — the
       session check below is this module's half of the switch window, and this is the other. */
    return onWake(subscribedFor.profile.id, () => {
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
      /* NO LIVE SESSION MEANS NO INSTANCE TO NAME. `NO_DISTRIBUTOR` answers for both halves and
         has always been the honest no-op here; the argument is the empty string for the same
         reason — there is no pairing this press could be about. */
      void serialize(() => NO_DISTRIBUTOR.unregister(""));
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
