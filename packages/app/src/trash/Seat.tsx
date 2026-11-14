/**
 * TRASH'S SEAT: what stands above Trash's two columns, and the value of its registration's `Above`. It hands the
 * frame's side and what only a file of this package can read to Trash's live hook (`useTrashLive`, called here once),
 * and stands the model above its list and its own reading column (`TrashAbove`). Mounted with Trash's columns and
 * unmounted with them: the page of what ohmail deleted and the server's own Trash are read on arrival and dropped on
 * leaving. The Ohbox's seat is its shape.
 *
 * It reads the ground through the live hook's readers and mounts none of it. The frame owns the transient rail entry
 * and the move back from the reading column on a phone.
 */
import { useSwitchEnded } from "@ohmail/app-logic/session/ui-vitals";
import { useMemo, type ReactNode } from "react";
import { useTrashLive, type TrashLiveOwn, type TrashLiveWire } from "@ohmail/app-logic/trash";
import { useFrame } from "../frame/commands.js";
import { usePlaceLiveArgs } from "../frame/place-live.js";
import { NONE } from "../host/index.js";
import { AT, usePlaceLabel } from "../place-list/index.js";
import { useText, useTimeZone } from "../text/index.js";
import { TrashAbove } from "./TrashAbove.js";

/** What only this package can read, as the live hook takes it. */
function useOwn(): TrashLiveOwn {
  const { host } = useFrame();
  /* A folder as the room's own seam says it in the restore's sentence: one word for one place. */
  const placeOf = usePlaceLabel();
  /* The list's walk's keys by the names the Ohbox's own walk has in the key sheet, as at every list place. */
  const ohbox = useText("ohbox");
  const keys = useMemo(
    () => ({ next: ohbox("keyNext"), prev: ohbox("keyPrev"), open: ohbox("keyOpen") }),
    [ohbox],
  );
  /* The host's own wire, or none. The one cast: the contract names a wire's answers opaquely, and their one
     declaration is the window's own (as the Screener's mount casts its two). */
  const wire = host.wires.trash;
  return {
    zone: useTimeZone(),
    wire: wire === NONE ? NONE : (wire as unknown as TrashLiveWire),
    placeOf,
    shortcuts: useText("shortcuts"),
    at: AT,
    keys,
    readerClosed: host.device.address.readerClosed?.() === true,
  };
}

export function TrashSeat({ children }: { readonly children: ReactNode }): ReactNode {
  const args = usePlaceLiveArgs();
  const model = useTrashLive(args, useOwn());
  const { page, live } = model;
  const deletedReady = page.items.length > 0 || page.exhausted || page.error !== null;
  const liveReady = live.shown && live.state.state !== "loading";
  useSwitchEnded(args.route, deletedReady || liveReady || (!page.available && !live.shown));
  return <TrashAbove model={model}>{children}</TrashAbove>;
}
