/** What a press and a drag on a row stand for: the open, the select, the pick, and the drop's verbs. */
import type { EngineMessage } from "@ohmail/wire";
import type { OhboxRow as OhboxRowGroup } from "@ohmail/client-engine";
import type { DragSource, RailDropTarget } from "../lists/drag-source.js";
import type { OhboxGroups } from "./groups.js";
import type { PickSet, PickVerbs } from "./picks.js";
import type { OhboxListInput, OhboxListModel } from "./types.js";

/** What a drag reads: the rows, the picks, and the verbs a drop runs. */
export function ohboxDrag(
  input: OhboxListInput,
  byId: Map<string, EngineMessage>,
  { model: { navRows }, rowIndexOf }: OhboxGroups,
  { picked, clearPicked }: PickSet,
  { pickedIds, runBulk }: PickVerbs,
  groupSenders: (g: OhboxRowGroup) => string,
): OhboxListModel["drag"] {
  const { senderName, sentLabelOf, threadSubject, onDropTag, onAction, bulk } = input;
  /**
   * DRAG-TO-FILE — what a row's drag STANDS FOR, and what a drop DISPATCHES: The gesture lives in
   * `shell/drag-file.ts`; these two closures are the semantics, and they are deliberately thin because every arm is
   * an EXISTING verb:
   * · a picked row drags the whole selection and a drop is `runBulk` — the bulk bar's own commit, selection-clear
   *   included;
   * · a lone row is the pill's `onAction`, verbatim;
   * · a folded conversation outside the selection is the bulk fan-out over its members — the row says "⤷ 5", so the
   *   drop acts on five, exactly as a pick of that row would;
   */

  /**
   * · a tag drop is the picker's apply (`onDropTag` → `bulkToggleTag`, apply-direction).
   * Fresh closures each render, read through the hook's ref at use time — nothing here can run stale, and nothing is
   * memoised for a gesture that happens at hand speed.
   */
  /* THE DRAG'S LOOKUP IS the three groups', the list every verb resolves against. */
  const dragRowOf = (id: string): EngineMessage | undefined => byId.get(id);
  const dragSourceFor = (rowId: string): DragSource | null => {
    const idx = rowIndexOf(rowId);
    const g = idx < 0 ? null : navRows[idx]!;
    if (g === null) return null;
    const members = g.members;
    const selection = picked.size > 0 && members.every((m) => picked.has(m.id));
    const ids = selection ? pickedIds : members.map((m) => m.id);
    const messages = ids.map(dragRowOf).filter((m): m is EngineMessage => m != null);
    if (messages.length === 0) return null;
    // The ghost wears what the ROW shows — same sender line, same subject — so what is in
    // hand is recognisably the thing that was picked up.
    const shown = members.length > 1 ? g.face : members[0]!;
    const sent = sentLabelOf(shown);
    const from = members.length > 1 ? groupSenders(g) : sent ? sent.label : senderName(shown);
    const subject = members.length > 1 ? (threadSubject?.(g.key) ?? shown.subject) : shown.subject;
    return { ids: messages.map((m) => m.id), messages, label: { from, subject }, selection };
  };

  const onRailDrop = (target: RailDropTarget, source: DragSource): void => {
    if (target.kind === "tag") {
      onDropTag?.(source.ids, target.tagId);
      if (source.selection) clearPicked();
      return;
    }
    if (source.selection) {
      runBulk(target.action);
      return;
    }
    if (source.ids.length === 1) {
      const m = dragRowOf(source.ids[0]!);
      if (m) onAction(target.action, m);
      return;
    }
    bulk.run(target.action, source.ids);
  };

  return { sourceFor: dragSourceFor, onDrop: onRailDrop };
}

/** What a press reads: the column, the picks, the cursor, and the open. */
export interface PressParts {
  input: OhboxListInput;
  picked: ReadonlySet<string>;
  togglePick: (id: string) => void;
  selected: EngineMessage | null;
  open: (m: EngineMessage) => void;
  selectByUser: (id: string) => void;
  enter: (m: EngineMessage) => void;
}

export function ohboxPressRow({
  input,
  picked,
  togglePick,
  selected,
  open,
  selectByUser,
  enter,
}: PressParts): OhboxListModel["pressRow"] {
  /** A press on a row, singleton or folded: the open target answers, row MEMBERSHIP says whether it is the open one. */
  const pressRow = (g: OhboxRowGroup): void => {
    const target = g.openTarget;
    if (input.columnHidden() && picked.size > 0) {
      // The same contract as the singleton row above — and a folded row toggles all of
      // its members, which is what `togglePick` does with a row id.
      togglePick(target.id);
    } else if (input.columnHidden()) {
      open(target);
    } else if (selected != null && g.members.some((m) => m.id === selected.id)) {
      open(target);
    } else {
      selectByUser(target.id);
      enter(target);
    }
  };
  return pressRow;
}
