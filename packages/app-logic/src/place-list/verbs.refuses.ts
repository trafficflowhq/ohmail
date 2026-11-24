/**
 * WHAT THE COMPILER REFUSES AT THE VERBS RECORD. This file builds to nothing; it exists to fail.
 *
 * Trash has no letter's verbs. Of the frame's one press seam it reads the restore window, how many deletes the
 * server confirmed and one mutation's report, and nothing that deletes, moves or files a letter. The verbs record is
 * fed from the frame's WHOLE seam. So each line below hands `usePlaceVerbs` the frame's side with a lesser seam, and
 * is marked as an error the compiler must report. Widen what the record takes until such a seam fits, and the mark
 * has nothing to stand on, which is itself an error.
 */
import type { PlaceLiveArgs } from "../lists/place-live.js";
import type { ShellDispatch } from "../press/shell-dispatch.js";
import type { usePlaceVerbs } from "./verbs.js";

/** A seam of Trash's shape: these three members and no other (Trash's own type narrows the last one further). */
interface SeamOfTrashsShape {
  readonly restoring: Pick<ShellDispatch["restoring"], "held" | "remove" | "landedIds">;
  readonly deleting: Pick<ShellDispatch["deleting"], "landed">;
  readonly mutateAndReport: ShellDispatch["mutateAndReport"];
}

/** The frame's side of a place, over a seam of its own. */
type SeatOver<Seam> = Omit<PlaceLiveArgs, "press"> & { readonly press: Seam };
type AskedForVerbs<T extends Parameters<typeof usePlaceVerbs>[0]> = T;

// @ts-expect-error Trash's seam feeds no verbs
export type OverTrashsSeam = AskedForVerbs<SeatOver<SeamOfTrashsShape>>;
// @ts-expect-error a seam with no delete window feeds no verbs
export type WithNoDelete = AskedForVerbs<SeatOver<Omit<ShellDispatch, "deleting">>>;
// @ts-expect-error a seam with no routing window feeds no verbs
export type WithNoMove = AskedForVerbs<SeatOver<Omit<ShellDispatch, "routing">>>;
// @ts-expect-error a seam with no raw dispatch feeds no verbs
export type WithNoDispatch = AskedForVerbs<SeatOver<Omit<ShellDispatch, "dispatchPress">>>;

/** The frame's own record is what is asked: the marks above are no errors of something else. */
export type TheFramesOwn = AskedForVerbs<PlaceLiveArgs>;
