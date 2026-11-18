/**
 * WHERE A LETTER MAY BE MOVED from the reader: the product's places, less the one it stands in, in the order every
 * move menu offers them. Today's action bar's rule, word for word (`MessagePane`'s move strip). A move to a place is a
 * routing press, so the reader runs it on the list's path only (`visit.act`).
 */
import type { EngineMessage } from "@ohmail/wire";
import { FOLDER_OF_VIEW } from "@ohmail/client-engine";
import { MOVE_TARGETS, type MoveTarget } from "../press/actions.js";

export function moveTargetsOf(m: Pick<EngineMessage, "folder">): MoveTarget[] {
  return MOVE_TARGETS.filter((v) => FOLDER_OF_VIEW[v] !== m.folder);
}
