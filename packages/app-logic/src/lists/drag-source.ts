/** What a dragged row stands for, and where it may land. */
import type { EngineMessage } from "@ohmail/wire";
import { FOLDER_OF_VIEW } from "@ohmail/client-engine";
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

/** The triage state each horizon rests in: the pill's own mapping. */
const TRIAGE_STATE_OF_ACTION: Record<"later" | "aside" | "resurface", string> = {
  later: "reply_later",
  aside: "set_aside",
  resurface: "bubbled_up",
};

/**
 * Would this drop change anything? The existing controls' enablement, over a set.
 *
 * `some` and not `every`, because that is what the controls themselves do with a mixed set:
 * the bulk move dispatches for the members whose folder differs and skips the rest, and
 * `bulkToggleTag` applies to the members that lack the tag. A target where at least one
 * member would change is a real offer; one where none would is not.
 */
export function dropLegal(
  target: RailDropTarget,
  messages: ReadonlyArray<Pick<EngineMessage, "folder" | "triage" | "labels">>,
): boolean {
  if (messages.length === 0) return false;
  if (target.kind === "tag") {
    return messages.some((m) => !m.labels.includes(target.tagId));
  }
  const action = target.action;
  if (action.startsWith("move:")) {
    const folder = FOLDER_OF_VIEW[action.slice("move:".length) as MoveTarget];
    return folder != null && messages.some((m) => m.folder !== folder);
  }
  const state = TRIAGE_STATE_OF_ACTION[action as "later" | "aside" | "resurface"];
  return messages.some((m) => (m.triage?.state ?? null) !== state);
}
