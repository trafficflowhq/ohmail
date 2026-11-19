/**
 * THE OHBOX'S UNREAD COUNT, OFF THE MAIL GROUND ALONE. A rail's count is drawn for the frame's life (in the rail, the
 * dock and behind More), while the Ohbox's own model stands only with its columns: so the count reads the presented
 * mirror and the mail state, never that model. The same set the list counts (`ohboxUnreadIds`), stated under the
 * same rule (`countWhen`): withheld until the mirror has settled and nothing is outstanding.
 */
import { useMemo } from "react";
import { countWhen, ohboxUnreadIds, ohboxView, resurfacedThreads } from "@ohmail/client-engine";
import { useDerivedVersion, useEngine } from "../engine/context.js";
import { useMailState } from "../mail-state/mail-state-binding.js";
import { usePresented } from "../reading/presented-mirror.js";

/**
 * How many unread letters the Ohbox lists; null while it may not be stated. `storeSettled`: the Screener's own
 * answer, which the list's emptiness waits for too (mail of senders the store does not list joins the Ohbox on it).
 */
export function useOhboxUnread(storeSettled: boolean): number | null {
  const engine = useEngine();
  const presented = usePresented(); // throws where no ground stands above
  const derived = useDerivedVersion();
  const { state } = useMailState();
  /* The row being read keeps its conversation in New: the held id is a key of the memo itself. */
  const openHeld = engine.openRowHeld();
  const counted = useMemo(() => {
    const view = ohboxView(presented, openHeld);
    const rows = resurfacedThreads(presented);
    const shown = view.resurfaced.length + view.newForYou.length + view.previouslySeen.length;
    /* Read at the mirror's stamp: made again when the mirror moves under one reader. */
    return { at: derived, unread: ohboxUnreadIds(rows, view).length, shown };
  }, [presented, derived, openHeld]);
  const input = { settled: state.settled && storeSettled, count: counted.shown, pending: state.owed };
  return countWhen(input, counted.unread) ?? null;
}
