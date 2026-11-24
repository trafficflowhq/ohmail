/**
 * TRASH, LIVE: what Trash's seat calls once (`packages/app/src/trash/Seat.tsx`). It assembles Trash's model input
 * (`TrashInput`) from the frame's side (`args`), the mail ground's consent row, the engine's word on the demo and what
 * only the seat can read (`own`), calls the model once (`useTrashList`) and declares Trash's keys. The Ohbox's
 * `live.ts` is its shape.
 *
 * WHERE EACH INPUT COMES FROM. The one press seam (`args.press`, a {@link TrashSeam}): the restore window's held
 * letters, its press and the restores the server took; of the delete window only how many deletes the server confirmed
 * (a rise reads the first page again); the seam's report of a read-state write. The frame: the letter the address
 * opens, the command that opens one, and how many columns stand (the list's walk). The ground: whether the account
 * uses folders (`useConsent()`), under which alone the mail server's own Trash is read. The engine: the demo, where
 * nothing of it is read. `own`: the host's wire to that Trash, the person's word for a place, the zone the clock runs
 * in, the key sheet's words and where the keyboard's zones stand.
 *
 * THE LIST's WALK (`../place-list/walk.ts`): the first deleted letter stands open on arrival where two columns stand,
 * and `j`, `k`, the arrows and Enter walk the rows. It takes ids and the frame's `open`, and no verb: Trash keeps no
 * read rule, so it enters and lands nothing, and its placer says nothing (no key at Trash rests for want of a cursor).
 *
 * The model is handed two verbs:
 * `restore`, the restore window's press, whose one dispatch is `restoreFromTrash` once its Undo window closes; and
 * `markSeen`, which writes a letter's read state and nothing else. The hook takes the frame's record with its press
 * narrowed to {@link TrashSeam} ({@link TrashLiveArgs}), so that is all a line here can reach of the seam: a delete, a
 * move or a raw dispatch is no member of it, and a line that names one does not compile
 * (`packages/app/test/trash/seat.test.tsx` holds it). The server's own Trash comes through a wire of two reads. ⌫ and
 * ⌦ are declared here inert, with the product's own sentence as their reason, so the key sheet says at Trash why they
 * do nothing.
 */
import { useMemo } from "react";
import type { EngineMutation } from "@ohmail/wire";
import { useConsent } from "../consent/consent-row.js";
import { useDemoMode } from "../engine/context.js";
import { useKeyBindings, type KeyBinding } from "../keys/index.js";
import type { PlaceLiveArgs } from "../lists/place-live.js";
import { useSeedOfferHere } from "../mailboxes/first-run/seed-offer.js";
import { useListWalkKeys, type ListWalkSeat, type ListZones } from "../place-list/walk.js";
import type { ShellDispatch } from "../press/shell-dispatch.js";
import { markSeenOver } from "../reader/mark-seen.js";
import { useDayClock } from "../session/day-clock.js";
import { stampOver } from "../text/format.js";
import type { Translator } from "../text/translator.js";
import type { TrashLiveWire } from "./live-window.js";
import { useTrashList, type TrashModel } from "./model.js";

/**
 * WHAT OF THE ONE PRESS SEAM TRASH READS: the restore window (its held letters, its press, the restores the server
 * took), the delete window's count of confirmed deletes and nothing else of it, and the seam's one mutation door
 * narrowed to a letter's read state (`mark_seen`), which Trash reaches through `markSeenOver`. `ShellDispatch` is one
 * of these; no member here deletes, moves or files a letter.
 */
export interface TrashSeam {
  readonly restoring: Pick<ShellDispatch["restoring"], "held" | "remove" | "landedIds">;
  readonly deleting: Pick<ShellDispatch["deleting"], "landed">;
  readonly mutateAndReport: (
    mutation: Extract<EngineMutation, { kind: "mark_seen" }>,
    okSentence: string | null,
  ) => Promise<boolean>;
}

/**
 * WHAT TRASH'S LIVE HOOK TAKES: the frame's record with its press narrowed to {@link TrashSeam}. The seat hands
 * `usePlaceLiveArgs()` as it is (a `ShellDispatch` is a `TrashSeam`); inside the hook the rest of the seam is out of
 * reach.
 */
export type TrashLiveArgs = Omit<PlaceLiveArgs, "press"> & { readonly press: TrashSeam };

/**
 * What only Trash's seat can read. Its `shortcuts` are the key sheet's words: what ⌫ and ⌦ are listed as, and the
 * names of the keyboard's zones.
 */
export interface TrashLiveOwn extends ListZones {
  readonly readerClosed: boolean;
  /** The zone the reader's clock runs in: a row's stamp falls on the reader's own day. */
  readonly zone: string;
  /** The host's wire to the mail server's own Trash (`wires.trash`), or `none`. */
  readonly wire: TrashLiveWire | "none";
  /** A folder in the person's words: the room's own word for a place, which the restore's sentence says too. */
  readonly placeOf: (folder: string) => string;
  /** The list's walk's keys as the key sheet names them. */
  readonly keys: ListWalkSeat["labels"];
}

/**
 * ⌫ AND ⌦ AT TRASH: listed, inert for good, the product's no-erase sentence their reason (`no_erase`: "ohmail never
 * erases mail"). Declared rather than left out, so the key sheet documents the two keys exactly where a person reaches
 * for them; inert, they fall through, and nothing at Trash takes them.
 */
function noEraseKeys(t: Translator): KeyBinding[] {
  const inert = {
    group: "message",
    label: t("deleteKey"),
    disabled: true,
    disabledReason: "no_erase",
    run: () => undefined,
  } as const;
  return [
    { chord: "Backspace", ...inert },
    { chord: "Delete", ...inert },
    { ...inert, chord: "m", label: t("move"), disabledReason: "restore_only" },
  ];
}

export function useLiveTrashEnabled(): boolean {
  const demo = useDemoMode();
  const { foldersEnabled } = useConsent();
  const seed = useSeedOfferHere();
  return !demo && foldersEnabled && seed?.owed !== true;
}

export function useTrashLive(args: TrashLiveArgs, own: TrashLiveOwn): TrashModel {
  const seam = args.press;
  const liveEnabled = useLiveTrashEnabled();
  const now = useDayClock(null, own.zone);
  /* A row's stamp in the list's own form: the clock today, the weekday this week, the date before. */
  const stamp = useMemo(() => stampOver(now), [now]);
  const markSeen = useMemo(() => markSeenOver(seam), [seam]);
  useKeyBindings(noEraseKeys(own.shortcuts));
  const { restoring, deleting } = seam;
  const model = useTrashList({
    held: restoring.held,
    landed: deleting.landed,
    restored: restoring.landedIds,
    restore: restoring.remove,
    markSeen,
    /* The server's own Trash, read only where the account uses folders and never in the demo: else withheld. */
    wire: liveEnabled ? own.wire : "none",
    openId: args.route.open,
    open: args.commands.open,
    stamp,
    placeOf: own.placeOf,
    walk: {
      columns: args.plan.columns,
      list: "trash/",
      labels: own.keys,
      say: () => undefined,
      readerClosed: own.readerClosed,
    },
    arrival: "first",
  });
  useListWalkKeys(model.walk, own);
  return model;
}
