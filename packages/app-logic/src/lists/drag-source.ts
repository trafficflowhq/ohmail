/** What a dragged row stands for, and where it may land. */
import type { EngineMessage } from "@ohmail/client-engine";
import type { MoveTarget } from "../press/actions.js";

/**
 * A pile drop's action, in the EXISTING vocabulary: every member is both a `MessageAction`
 * and a `BulkAction`, which is the structural half of "one semantic, new gesture" — there is
 * no drop verb the pill and the bulk bar cannot already say.
 */
export type PileDropAction = "later" | "aside" | "resurface" | `move:${MoveTarget}`;

export type RailDropTarget = { kind: "pile"; action: PileDropAction } | { kind: "tag"; tagId: string };

/** What travels with a drag: the messages it stands for, and what the ghost says. */
export interface DragSource {
  /** The message ids the drop will act on — the whole selection when the row is in it. */
  ids: string[];
  /** The same messages, for legality — folder, triage state, labels. */
  messages: EngineMessage[];
  /** The ghost's two lines — what the ROW shows, so the ghost is the row in hand. */
  label: { from: string; subject: string };
  /** True when `ids` is a live multi-select (the drop then also clears it). */
  selection: boolean;
}
