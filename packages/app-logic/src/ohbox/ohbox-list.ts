/**
 * The Ohbox's behaviour, apart from what draws it: the session's placement and the slide out of New, the list
 * window's index space, the picks, the read hold and the visit, Undo's answer, the walk, the keys and the drag's
 * semantics. `useOhboxList` takes today's inputs and hands back the locals the list and its reading column draw.
 */
import { useMemo } from "react";
import type { OhboxRow as OhboxRowGroup } from "@ohmail/client-engine";
import { useUnreadTurn } from "../reading/reader-seen.js";
import { groupSenders, groupVoices, useGroupPeople, useOhboxGroups } from "./groups.js";
import { useHold } from "./hold.js";
import { ohboxKeys } from "./keys.js";
import { useAfterVerbLanding } from "./landing.js";
import { useMarks } from "./marks.js";
import { useExtendPick, usePickSet, usePickVerbs } from "./picks.js";
import { useSessionPlacement } from "./placement.js";
import { useOhboxPointer } from "./pointer.js";
import { useReadWiring } from "./read-wiring.js";
import { ohboxDrag, ohboxPressRow } from "./row-press.js";
import { ohboxRowVerbs } from "./row-verbs.js";
import { useReplyDoneRead, useSlide } from "./slide.js";
import type { OhboxListInput, OhboxListModel } from "./types.js";
import { useSuspended, useUndoAnswer } from "./undo.js";
import { useDepartures, useEnter, useVisit } from "./visit.js";
import { ohboxZone, walkOrder, walkSteps } from "./walk.js";
import { useOhboxWindow, useRevealSelection } from "./window.js";

export type {
  BulkVerbs,
  OhboxListInput,
  OhboxListModel,
  OhboxPerson,
  OhboxPointer,
  OhboxReplyDone,
  OhboxStep,
  PickPanel,
} from "./types.js";

/**
 * The one door. Its parts each stand in a file of their own, and they are called in the order their effects ran when
 * they were one body: that order is behaviour (a verb's record is written before a departure reads it).
 */
export function useOhboxList(input: OhboxListInput): OhboxListModel {
  const { selectedId, senderName } = input;
  const t = input.t;
  const placement = useSessionPlacement(input);
  const { returnToNew, unreadHold } = placement;
  const groups = useOhboxGroups(input, placement);
  const { all, shown, navRows, groupedResurfaced, groupedNew, groupedPrev } = groups.model;
  const { rowIndexOf } = groups;
  const view = useOhboxWindow(groupedNew, groupedPrev);
  /**
   * THE OPEN MESSAGE, or `null` — never "the first one, then".
   *
   * This had `?? all[0]` on it, the twin of the one `AppShell` used to carry, and between them
   * an untouched Ohbox opened its newest unread message: the reading column rendered it, the
   * shell fetched its body, and the first `j` or click after that was a departure that marked
   * it read. A resting column is rendered instead (see {@link ReadColumn} below), which is a
   * state the product can be in rather than a message it chose for somebody.
   */
  const selected = shown.find((m) => m.id === selectedId) ?? null;
  /** The open row's own flag turning unread while it stays open (another device's) holds it, as `u` does. */
  useUnreadTurn(unreadHold, selected);
  const held = useHold(input, all);
  const undo = useSuspended(input, held);
  const landing = useAfterVerbLanding(input, all, navRows, undo.suspend, held.setLandedOn);
  useRevealSelection({
    input,
    ...view.model,
    rowIndexOf,
    groupedResurfaced,
    windowIndexOf: view.windowIndexOf,
  });
  const pickSet = usePickSet(navRows, rowIndexOf);
  const pickVerbs = usePickVerbs(input, pickSet, shown, navRows, returnToNew, landing.verbTook);
  const { enter, readByRule } = useEnter(navRows, rowIndexOf, held);
  const visit = useVisit(input, held, pickSet.picked, selected, enter, undo.suspended);
  const { selectByUser, open } = visit;
  useUndoAnswer(input, held, undo, landing.verbAdvance);
  const marks = useMarks(input, held, selected, returnToNew);
  useDepartures(input, held.leaveRead, undo.suspended);
  useSlide(placement);
  useReplyDoneRead(input.replyDone, placement.newOrder, held.allRef, held.markSeenRef);

  const { order, at } = useMemo(
    () => walkOrder(navRows, rowIndexOf, selected),
    [navRows, rowIndexOf, selected],
  );
  const steps = walkSteps({ order, at, t, selectByUser, setLandedOn: held.setLandedOn });
  const { anchor, pickRangeTo } = pickSet;
  const extendPick = useExtendPick({ order, at, selectedId, anchor, selectByUser, pickRangeTo });
  const keys = ohboxKeys({
    ...pickSet,
    ...pickVerbs,
    ...marks,
    ...steps,
    t,
    input,
    bulk: input.bulk,
    selected,
    order,
    open,
    extendPick,
    onAddTag: input.onAddTag,
  });
  /** The reading column's scroller — the thread-read rule observes it. */
  const readColRef = input.readColRef;
  const zone = ohboxZone({ ...steps, selected, engage: visit.engage, open, unreadHold, readColRef });
  const pointer = useOhboxPointer(input, pickSet);
  const reading = useReadWiring(input, held, {
    shown,
    selected,
    enter,
    readByRule,
    open,
    selectByUser,
    markUnread: marks.markUnread,
    returnToNew,
    unreadHold,
  });

  const groupSendersOf = (g: OhboxRowGroup): string => groupSenders(g, senderName);
  const drag = ohboxDrag(input, placement.byId, groups, pickSet, pickVerbs, groupSendersOf);
  const pressRow = ohboxPressRow({ input, ...pickSet, selected, open, selectByUser, enter });
  const verbs = ohboxRowVerbs(input, { selected, ...pickSet, ...pickVerbs, ...marks, ...reading, ...steps });
  const groupPeopleOf = useGroupPeople(input.conversationOf);
  const { picked, pickPanel, setPickPanel, clearPicked, togglePick } = pickSet;
  return {
    ...groups.model,
    ...view.model,
    ...pickVerbs,
    ...marks,
    ...reading,
    ...steps,
    ...verbs,
    selected,
    settling: placement.settling,
    picked,
    pickPanel,
    setPickPanel,
    clearPicked,
    togglePick,
    open,
    enter,
    selectByUser,
    pressRow,
    groupVoices,
    groupSenders: groupSendersOf,
    groupPeople: groupPeopleOf,
    conversationOf: input.conversationOf,
    keys,
    zone,
    pointer,
    drag,
  };
}
