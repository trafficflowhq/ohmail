/**
 * THE TWO INPUTS OF TODAY'S VIEWS THAT A SIGNAL FEEDS: the paired host's silence and a mail link handed in from
 * outside. The adapter's only subscriber of the two signals. `none` and a null answer are both absent.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { NONE, type HostContract, type LinkedDraft, type Signal } from "@ohmail/app/host";
import type { HostConnection } from "@ohmail/app-logic/doors/host-connection";
import type { ComposePrefill } from "@ohmail/app-logic/writing/compose";

export interface TodaysSignalInputs {
  hostConnection: HostConnection | undefined;
  mailtoDraft: ComposePrefill | null;
  onMailtoDraftSeeded: (() => void) | undefined;
}

const QUIET: Signal<null> = { read: () => null, subscribe: () => () => undefined };

export function useTodaysSignals(signals: HostContract["signals"]): TodaysSignalInputs {
  const quiet = signals.hostConnection === NONE ? QUIET : signals.hostConnection;
  const connection = useSyncExternalStore(quiet.subscribe, quiet.read, quiet.read);

  const linkIn = signals.linkIn;
  const [held, setHeld] = useState<LinkedDraft | null>(null);
  useEffect(() => {
    if (linkIn === NONE) return;
    /* Taken once at mount and again on every arrival; a null answer changes nothing, so a double effect loses none. */
    const take = () => {
      const link = linkIn.take();
      if (link !== null) setHeld(link);
    };
    take();
    return linkIn.subscribe(take);
  }, [linkIn]);
  const seeded = useCallback(() => setHeld(null), []);

  return {
    hostConnection: connection === null ? undefined : (connection as HostConnection),
    mailtoDraft: linkIn === NONE ? null : (held as ComposePrefill | null),
    onMailtoDraftSeeded: linkIn === NONE ? undefined : seeded,
  };
}
