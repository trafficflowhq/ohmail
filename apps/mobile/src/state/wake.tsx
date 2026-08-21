import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from "react";
import { useConnection } from "../net/connection";
import { forgetWake, registerWake, NO_DISTRIBUTOR, type WakeState } from "../net/push";
import {
  chooseDistributor, listDistributors, onWake, savedDistributor, unifiedPushDistributor,
  type DistributorChoice,
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
 * It WAS a hook, and that was a real defect found in review. The `onWake` subscription — the one
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
   * moved on. Found in review; it is the cost of the fix above and it is paid here.
   *
   * One counter, bumped every time the live session changes, plus the session object itself so a
   * delivered wake can be checked against the session it was subscribed for. Refs rather than state
   * because every reader is a callback, and a re-render would be a wasted one.
   */
  const generation = useRef(0);
  const liveSession = useRef<typeof session>(null);

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
      if (!fresh()) return;
      subscriptionId.current = next.k === "on" ? next.id : null;
      setState(next);
    } catch {
      /**
       * A TERMINAL CATCH, even though `registerWake` now maps every failure to a state.
       *
       * This is invoked as `void attempt(…)`, so anything that escapes is an unhandled rejection —
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
    liveSession.current = session;
    readDevice();
    if (!session) {
      setState({ k: "no_distributor" });
      return () => { alive = false; };
    }
    if (savedDistributor() !== null) void attempt(mounted);
    else setState({ k: "no_distributor" });
    return () => { alive = false; };
  }, [session, attempt, readDevice]);

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
      conn.syncNow();
    });
  }, [session, conn]);

  const choose = useCallback((id: string): void => {
    chooseDistributor(id);
    readDevice();
    // `() => true` for the MOUNT question only: a choice made by a tap is one the user is waiting
    // on, so its result is worth writing even if the pane re-rendered underneath it. The generation
    // check inside `attempt` is what still discards it if the SESSION changed — those are different
    // questions and conflating them is what let a superseded registration land.
    void attempt(() => true);
  }, [attempt, readDevice]);

  const turnOff = useCallback((): void => {
    const id = subscriptionId.current;
    subscriptionId.current = null;
    // The SERVER first, then the device — `forgetWake`'s order, for its reason: the row is what
    // causes wakes, so it goes before the endpoint that receives them stops existing.
    if (session) void forgetWake(session, unifiedPushDistributor(), id);
    else void NO_DISTRIBUTOR.unregister();
    chooseDistributor(null);
    readDevice();
    setState({ k: "no_distributor" });
  }, [session, readDevice]);

  return (
    <WakeContext.Provider value={{ state, choices, chosen, busy, choose, turnOff }}>
      {children}
    </WakeContext.Provider>
  );
}
