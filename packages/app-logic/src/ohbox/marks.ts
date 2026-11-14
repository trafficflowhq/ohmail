/** The marks: unread and read in two directions, ⇧I's read of the conversation on screen, and the set it reads. */
import { useCallback, useRef } from "react";
import { isResurfaced } from "@ohmail/client-engine";
import type { EngineMessage } from "@ohmail/client-engine";
import { recordIn, recordOf, type Hold } from "./hold.js";
import { NO_ROWS } from "./placement.js";
import type { OhboxListInput, OhboxListModel } from "./types.js";

/** The model's fields the marks answer. */
export type Marks = Pick<OhboxListModel, "markUnread" | "markConversationRead" | "readSet">;

export function useMarks(
  input: OhboxListInput,
  { visit, heldRead, hold, readSetForRef }: Hold,
  selected: EngineMessage | null,
  returnToNew: (ids: readonly string[]) => void,
): Marks {
  const { onMarkSeen, bulk, resurfacedRows = NO_ROWS, readerId, readSetFor } = input;
  /**
   * Two directions, not one toggle: "invert eleven messages" turns a mixed selection into a
   * different mixed selection — a direction produces the same state from any state. `u` and a
   * panel's ⋯ Mark unread keep the message unread for the rest of the visit (the rule never reads
   * it back), let go of its own hold, and return it to New at its arrival place (`returnToNew`).
   */
  const markUnread = useCallback(
    (m: EngineMessage) => {
      recordIn(visit, m).keepUnread(m.id);
      if (heldRead.current === m.id) hold(null);
      returnToNew([m.id]);
      onMarkSeen([m.id], true);
    },
    [onMarkSeen, returnToNew, hold, heldRead, visit],
  );

  const markRead = useCallback(
    (m: EngineMessage) => {
      recordOf(visit, m)?.release(m.id);
      // An explicit read of the shown message is a read in ohmail: held like an open, so it keeps
      // its place while shown and files at the top of Earlier when left. A resurfaced one keeps arrival.
      if (m.unread && !isResurfaced(m) && heldRead.current !== m.id) hold(m.id);
      onMarkSeen([m.id], false);
    },
    [onMarkSeen, hold, heldRead, visit],
  );

  /**
   * ⇧I AND THE READER'S MARK AS READ — the conversation on screen, read. The set is the one the
   * slot's face was drawn from (`readSetRef`), floored by the mirror at the press, so a sibling that
   * arrived after the face changed is never in it. One member that is the open message is today's
   * single read; more go out as ONE bulk read with its toast and Undo (`bulk.run`, never `runBulk`:
   * no pick is involved). The keeps are let go: this is the person's own read.
   */
  const markConversationRead = useCallback(
    (m: EngineMessage) => {
      const floor = readSetForRef.current(m.id);
      const set = readSetRef.current.filter((id) => floor.includes(id));
      // A resurfaced open message keeps its own key: ⇧I is its deliberate read, the pin's way out,
      // over every pin of its row as the row's Done.
      const pins = isResurfaced(m)
        ? (resurfacedRows.find((r) => r.members.some((x) => x.id === m.id))?.pinned.map((x) => x.id) ?? [])
        : [];
      if (pins.length > 1) {
        bulk.run("done", pins);
        return;
      }
      if (isResurfaced(m) || set.length === 0 || (set.length === 1 && set[0] === m.id)) {
        markRead(m);
        return;
      }
      for (const id of set) recordOf(visit, m)?.release(id);
      // Hold the shown message first, so the whole set is an open read and the row files at the top
      // of Earlier when left.
      if (heldRead.current !== m.id) hold(m.id);
      bulk.run("read", set);
    },
    [markRead, bulk, hold, resurfacedRows, heldRead, readSetForRef, visit],
  );

  /**
   * The read slot's set for the open message — only while a reader SHOWS it (the column, or the
   * sheet over a hidden column): with nothing on screen ⇧I stays the one message's read. A pin is
   * not in it (Done answers it). Written to `readSetRef` at render, so the press reads what was drawn.
   */
  const readSet =
    selected && (!input.columnHidden() || readerId === selected.id) ? readSetFor(selected.id) : [];
  /** The read set the reader last DREW — a press never writes a member drawn after its face changed. */
  const readSetRef = useRef<string[]>([]);
  readSetRef.current = readSet;
  return { markUnread, markConversationRead, readSet };
}
