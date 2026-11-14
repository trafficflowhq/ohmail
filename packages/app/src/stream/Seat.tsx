/**
 * A STREAM'S SEAT (News, Receipts): what stands above a stream place's two columns, and the value of its
 * registration's `Above`. It hands the frame's side and what only this package can read to the stream's live hook
 * (`useStreamLive`, called here once), and stands the model for the list and the stream. Mounted with the place's
 * columns and unmounted with them. It reads the ground through the live hook's readers and mounts no piece of it.
 *
 * THE TAB GOING AWAY is a leave of the stream, as leaving the place is: the seat listens for the page's own hide on
 * the window the stream is drawn in (read off the stream's scroller once it stands: shared code touches no global),
 * and tells whoever the live hook subscribed.
 */
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";
import { useSwitchEnded } from "@ohmail/app-logic/session/ui-vitals";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  StreamModelContext,
  useStreamLive,
  useStreamMove,
  type StreamLiveOwn,
  type StreamPlace,
} from "@ohmail/app-logic/streams";
import { wordsOver } from "@ohmail/app-logic/reader";
import { ListMoveContext } from "@ohmail/app-logic/reading";
import { usePlaceLiveArgs } from "../frame/place-live.js";
import { useText, useTimeZone } from "../text/index.js";
import { useStreamText } from "./words.js";

/** Who is told when the tab goes away, and the way to be told. */
function usePageLeaves(): {
  readonly leaves: { readonly current: Set<() => void> };
  readonly subscribe: (leave: () => void) => () => void;
} {
  const leaves = useRef(new Set<() => void>());
  const subscribe = useStableCallback((leave: () => void) => {
    leaves.current.add(leave);
    return () => {
      leaves.current.delete(leave);
    };
  });
  return { leaves, subscribe };
}

/** The page's own hide, heard on the window `node` is drawn in, told to every leave subscribed. */
function useLeavesOnHide(leaves: { readonly current: Set<() => void> }, node: Element | null): void {
  useEffect(() => {
    const win = node?.ownerDocument.defaultView;
    if (!win) return;
    const hide = (): void => {
      for (const leave of [...leaves.current]) leave();
    };
    win.addEventListener("pagehide", hide);
    return () => win.removeEventListener("pagehide", hide);
  }, [leaves, node]);
}

export function StreamSeat({
  place,
  children,
}: {
  readonly place: StreamPlace;
  readonly children: ReactNode;
}) {
  const t = useStreamText(place);
  const zone = useTimeZone();
  const { leaves, subscribe } = usePageLeaves();
  const own: StreamLiveOwn = useMemo(() => ({ t, zone, onPageHide: subscribe }), [t, zone, subscribe]);
  const args = usePlaceLiveArgs();
  const model = useStreamLive(place, args, own);
  useSwitchEnded(args.route, model.items.length > 0 || model.mayState);
  const ohbox = useText("ohbox");
  const screening = useText("screening");
  const session = useText("session");
  const words = useMemo(() => wordsOver({ ohbox, screening, session }), [ohbox, screening, session]);
  const move = useStreamMove(args, model.items, model.toolbar, words);
  useLeavesOnHide(leaves, model.scroller);
  return (
    <ListMoveContext.Provider value={move}>
      <StreamModelContext.Provider value={model}>{children}</StreamModelContext.Provider>
    </ListMoveContext.Provider>
  );
}

/** News's seat: the stream over News's pile. */
export function NewsSeat({ children }: { readonly children: ReactNode }) {
  return <StreamSeat place="news">{children}</StreamSeat>;
}

/** Receipts' seat: the stream over Receipts' pile. */
export function ReceiptsSeat({ children }: { readonly children: ReactNode }) {
  return <StreamSeat place="receipts">{children}</StreamSeat>;
}
