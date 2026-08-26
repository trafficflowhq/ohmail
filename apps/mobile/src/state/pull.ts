/**
 * PULL-TO-REFRESH → A REAL SYNC — the screen-side half of the doorbell.
 *
 * The gesture rings `connection.syncNow()`, which is the SAME ask a delivered wake makes and
 * the Servers screen's "Sync now" button presses: the pull is a trigger for the sync the app
 * already knows how to do, never a source of data. The spinner is honest by construction —
 * it renders on the promise `syncNow` answers, which settles when the engine's own round
 * completes (`net/drain.ts`, the honest-settle contract), so it ends with the sync, not on a
 * timer. A refused round settles the same way, quietly: the failure keeps its one existing
 * sentence (`connection.syncError`, the Servers screen's vocabulary) and the pull adds no
 * toast on top of it.
 *
 * `refreshing` is LOCAL to the pulling screen rather than mirrored from `connection.syncing`
 * on purpose: the background poll and the wake channel run the very same rounds, and a
 * spinner that appeared uninvited on every one of those would turn a quiet background fact
 * into foreground noise. Only a pull shows a pull spinner.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection } from "../net/connection";

export interface PullToSync {
  refreshing: boolean;
  onRefresh: () => void;
}

export function usePullToSync(): PullToSync {
  const conn = useConnection();
  const [refreshing, setRefreshing] = useState(false);
  /** No state write after unmount — the round can outlive the screen that pulled. */
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void conn.syncNow().finally(() => {
      if (alive.current) setRefreshing(false);
    });
  }, [conn]);
  return { refreshing, onRefresh };
}
