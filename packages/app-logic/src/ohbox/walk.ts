/** The walk j/k and the arrows share, and the zone model's three parts (rail ← list → open message). */
import type { RefObject } from "react";
import type { EngineMessage, OhboxRow as OhboxRowGroup } from "@ohmail/client-engine";
import type { UnreadHold } from "../reading/reader-seen.js";
import type { Translator } from "../text/translator.js";
import type { OhboxListModel, OhboxStep } from "./types.js";

/** Where the cursor stands in the walk, and the walk's stops. */
export interface WalkOrder {
  order: string[];
  at: number;
}

export function walkOrder(
  navRows: OhboxRowGroup[],
  olderRows: OhboxRowGroup[],
  rowIndexOf: (id: string | null) => number,
  selected: EngineMessage | null,
): WalkOrder {
  /**
   * j/k WALK ROWS, NOT MESSAGES. `order` holds each row's OPEN TARGET — for a conversation,
   * its newest letter — so landing on a grouped row selects the message the row leads with,
   * and a folded member is never a keyboard stop. `at` resolves through row MEMBERSHIP, so a
   * selection standing on a member that stopped leading its row (a newer reply arrived) still
   * knows which row it is on.
   */
  const order =
    olderRows.length === 0
      ? navRows.map((g) => g.openTarget.id)
      : [...navRows.map((g) => g.openTarget.id), ...olderRows.map((g) => g.openTarget.id)];
  /**
   * Where the cursor stands in that walk. Row MEMBERSHIP for the three groups — so a selection on
   * a member that stopped leading its row still knows which row it is on — and position for the
   * Older tail, whose rows fold into nothing and are one keyboard stop each. Without the second
   * half a cursor on an Older row read `-1`, which `stepDown` treats as ENTRY: `j` from the tail
   * jumped back to the top of the list.
   */
  const orderIndexOf = (id: string | null): number => {
    const row = rowIndexOf(id);
    if (row >= 0) return row;
    const k = id == null ? -1 : olderRows.findIndex((g) => g.members.some((m) => m.id === id));
    return k < 0 ? -1 : navRows.length + k;
  };
  const at = orderIndexOf(selected?.id ?? null);
  return { order, at };
}

/** What a walk step does: the cursor moved by the person, landed on until rested on. */
export interface WalkParts extends WalkOrder {
  t: Translator;
  selectByUser: (id: string) => void;
  setLandedOn: (id: string | null) => void;
}

export function walkSteps({
  order,
  at,
  t,
  selectByUser,
  setLandedOn,
}: WalkParts): Pick<OhboxListModel, "stepUp" | "stepDown"> {
  const landByKey = (id: string): void => {
    selectByUser(id);
    setLandedOn(id);
  };
  /**
   * ONE WALK, FOUR KEYCAPS. ↓/↑ are `j`/`k` — same steps, same entry moves, same
   * `landByKey`: a preview, which reads nothing while passed and is entered once rested on.
   * Extracted so the letter bindings below and the zone hook's arrow bindings dispatch ONE
   * pair of closures — a second copy is how two keys presented as aliases drift apart.
   */
  const stepDown = {
    // `at < 0` — no cursor, or a cursor on something these rows do not contain — is ENTRY,
    // and this expression already treats it as one: `-1 >= order.length - 1` is false for any
    // non-empty list, so the step comes in at the top. See `stepUp` for the other half.
    disabled: at >= order.length - 1,
    run: () => {
      if (at < order.length - 1) landByKey(order[at + 1]!);
    },
    label: t("keyNext"),
  };
  const stepUp = {
    disabled: order.length === 0 || at === 0,
    run: () => {
      if (at < 0) landByKey(order[order.length - 1]!);
      else if (at > 0) landByKey(order[at - 1]!);
    },
    label: t("keyPrev"),
  };
  return { stepUp, stepDown };
}

/** What the zone model reads. */
export interface ZoneParts {
  stepUp: OhboxStep;
  stepDown: OhboxStep;
  selected: EngineMessage | null;
  engage: (m: EngineMessage) => void;
  open: (m: EngineMessage) => void;
  unreadHold: UnreadHold;
  readColRef: RefObject<HTMLDivElement | null>;
}

export function ohboxZone({
  stepUp,
  stepDown,
  selected,
  engage,
  open,
  unreadHold,
  readColRef,
}: ZoneParts): OhboxListModel["zone"] {
  /**
   * THE ZONE MODEL — rail ← list → open message (`zone-nav.tsx`). ↓/↑ in the list are
   * `stepDown`/`stepUp`, the same closures `j`/`k` dispatch: previews under four keycaps.
   * → into the pane is `engage` (it enters the conversation), and so is ↑/↓ scrolling it unless it
   * shows a message marked unread this visit (`unreadHold`); at widths where the column is hidden →
   * is `open`, the deliberate open the sheet answers.
   */
  const zone = {
    list: { up: stepUp, down: stepDown, followId: selected?.id ?? null },
    reader: {
      disabled: selected == null,
      onEnter: () => selected && engage(selected),
      onScrollKey: () => {
        if (selected && !unreadHold.shows(readColRef.current)) engage(selected);
      },
      onHiddenEnter: () => selected && open(selected),
    },
  };
  return zone;
}
