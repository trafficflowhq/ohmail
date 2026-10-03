/**
 * WHAT WAITS ON THE ORGANIZER, ON THE PHONE — one line ("N changes wait on <holder>") over the
 * Ohbox and in Settings, opening a sheet that lists each request. The engine's merged list
 * (`waitingOnOrganizer()`, the server's record plus this session's own) is read on the engine's
 * subscription, so a request the organizer carries out leaves the line as its change lands.
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import type { WaitingOnOrganizerView } from "../state/live";
import { Copy } from "../copy";
import { useConnection } from "../net/connection";
import { Button, Panel, Txt } from "./base";
import { Sheet } from "./Sheet";
import { waitingRowLines, waitingStripLine } from "./waiting-lines";

const NONE: readonly WaitingOnOrganizerView[] = [];

/** The list, re-read when the engine moves; a stable empty list while there is no session. */
export function useWaitingOnOrganizer(): readonly WaitingOnOrganizerView[] {
  const conn = useConnection();
  const engine = conn.state.k === "live" ? conn.state.session.engine : null;
  const key = useSyncExternalStore(
    useCallback((cb: () => void) => (engine ? engine.subscribe(cb) : () => undefined), [engine]),
    () => (engine ? JSON.stringify(engine.waitingOnOrganizer()) : "[]"),
  );
  return useMemo(() => (key === "[]" ? NONE : JSON.parse(key) as WaitingOnOrganizerView[]), [key]);
}

export function WaitingStrip() {
  const list = useWaitingOnOrganizer();
  const [open, setOpen] = useState(false);
  const line = waitingStripLine(list);
  if (line === null) return null;
  return (
    <>
      <Panel style={{ marginHorizontal: 6, marginBottom: 12, padding: 14, gap: 6 }}>
        <Txt variant="body" accessibilityRole="summary">{line}</Txt>
        <Button label={Copy.waitingStripOpen} variant="quiet" style={{ alignSelf: "flex-start" }} onPress={() => setOpen(true)} />
      </Panel>
      <Sheet open={open} onClose={() => setOpen(false)} label={Copy.waitingSheetTitle}>
        <View style={{ paddingHorizontal: 20, paddingVertical: 14, gap: 12 }}>
          <Txt variant="h2" accessibilityRole="header">{Copy.waitingSheetTitle}</Txt>
          {list.map((w, i) => {
            const { what, state } = waitingRowLines(w);
            return (
              <View key={w.requestId ?? `w-${i}`} style={{ gap: 2 }} accessibilityRole="text">
                <Txt variant="body">{what}</Txt>
                {state === null ? null : <Txt variant="note" tone="ink2">{state}</Txt>}
              </View>
            );
          })}
        </View>
      </Sheet>
    </>
  );
}
