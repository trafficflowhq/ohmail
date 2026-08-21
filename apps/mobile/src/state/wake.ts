import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection } from "../net/connection";
import { forgetWake, registerWake, NO_DISTRIBUTOR, type WakeState } from "../net/push";
import {
  chooseDistributor, listDistributors, onWake, savedDistributor, unifiedPushDistributor,
  type DistributorChoice,
} from "../net/unified-push";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE WAKE, AS THE SETTINGS PANE SEES IT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * One hook, because the pane needs three things that are only meaningful together: which
 * distributors this phone has, which one is chosen, and what happened when we tried to register
 * with the server. Splitting them would let the screen render a chosen distributor beside a
 * registration made against a different one.
 *
 * ── WHAT LIVES HERE AND WHAT DELIBERATELY DOES NOT ────────────────────────────────────────────
 *
 * NO transport. Every request goes through `net/push.ts`, which is the file the app's privacy
 * census admits to the network seam and which holds no origin of its own; this module holds React
 * state and calls it. That is why this file is in `state/` and not in `net/`: the census's rule is
 * that a file outside the seam may not make a request, and this one does not.
 *
 * ── THE REGISTRATION IS RE-MADE ON EVERY ATTEMPT, NOT CACHED ──────────────────────────────────
 *
 * The connector's own guidance is to call register on every app start, because that is also how it
 * confirms the distributor connection is alive. The server side deduplicates: one endpoint is one
 * row, and a re-registration re-stamps the device and the keys rather than accumulating. So there
 * is nothing to be clever about here — asking again is cheap and is the thing that heals a stale
 * registration.
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

export function useWake(): Wake {
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

  /** Re-read the device's own answer. Cheap, synchronous, and the source of truth for the list. */
  const readDevice = useCallback((): void => {
    setChoices(listDistributors());
    setChosen(savedDistributor());
  }, []);

  /**
   * Attempt a registration and land on whatever it answers.
   *
   * `mounted` guards the state writes, because a Settings pane can be closed mid-request and the
   * connector's register has a fifteen-second ceiling — a setState after unmount is a warning
   * nobody can act on and, worse, a value written into a screen that no longer exists.
   */
  const attempt = useCallback(async (mounted: () => boolean): Promise<void> => {
    if (!session) return;
    setBusy(true);
    try {
      const next = await registerWake(session, unifiedPushDistributor());
      if (!mounted()) return;
      subscriptionId.current = next.k === "on" ? next.id : null;
      setState(next);
    } finally {
      if (mounted()) setBusy(false);
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
   * A DELIVERED wake means one thing: pull. Subscribed here rather than in the pane because it must
   * hold for as long as the app is running, not for as long as Settings is open.
   *
   * `conn.syncNow()` is the same call pull-to-refresh makes — the wake is a trigger for the sync
   * the app already knows how to do, never a source of data. That is what makes a wake carrying a
   * closed constant sufficient.
   */
  useEffect(() => {
    if (!session) return;
    return onWake(() => { conn.syncNow(); });
  }, [session, conn]);

  const choose = useCallback((id: string): void => {
    chooseDistributor(id);
    readDevice();
    // `() => true`: a choice made by a tap is one the user is waiting on, so its result is worth
    // writing even if the pane re-renders underneath it. The unmount case is covered by the effect
    // above, whose own attempt is guarded.
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

  return { state, choices, chosen, busy, choose, turnOff };
}
