/**
 * Pull-to-refresh → a real sync — the screen-side half of the doorbell. The gesture rings
 * `connection.syncNow()`, the same ask a delivered wake makes: the pull is a trigger for the sync the app
 * already knows how to do, never a source of data. The spinner is honest by construction — it renders on the
 * promise `syncNow` answers when the server's request and the engine's own drain settle, so it ends
 * with the sync; a refused round settles the same way, keeping its one existing sentence
 * (`connection.syncError`). A round that hangs releases the spinner at `PULL_SPIN_CAP_MS` and goes on unseen.
 * One pull at a time: a pull while one runs asks nothing more. `refreshing` is local to the pulling screen on purpose: the background poll and
 * the wake channel run the very same rounds, and an uninvited spinner on every one would turn a quiet
 * background fact into foreground noise. Only a pull shows a pull spinner.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection } from "../net/connection";
import { networkNow } from "../net/network-door";
import { lateWho } from "../ui/late-lines";
import { pullRound, spinUntil } from "./pull-round";
import { sayRefusal } from "../refusal";

export interface PullToSync {
  refreshing: boolean;
  onRefresh: () => Promise<void> | void;
  pending?: Promise<void>;
  result?: string;
}

export function usePullToSync(): PullToSync {
  const conn = useConnection();
  const [result, setResult] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  /** No state write after unmount — the round can outlive the screen that pulled. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(undefined), 5_000);
    return () => clearTimeout(timer);
  }, [result]);
  const inFlight = useRef<Promise<void> | undefined>(undefined);
  const onRefresh = useCallback(() => {
    if (inFlight.current) return;
    setResult(undefined);
    setRefreshing(true);
    // With no network the pull says so and asks nothing (`pull-round.ts`); the spinner ends at once.
    // A server that is not fetching is reported as soon as the ring answers.
    const who = lateWho(conn.state.k === "live" ? conn.state.session : null);
    const pending = spinUntil(pullRound(networkNow(), (heard) => conn.syncNow(heard), (answer) => { if (alive.current) setResult(sayRefusal(answer)); }, who)).finally(() => {
      inFlight.current = undefined;
      if (alive.current) setRefreshing(false);
    });
    inFlight.current = pending;
    return pending;
  }, [conn]);
  return { refreshing, onRefresh, result, pending: inFlight.current };
}
