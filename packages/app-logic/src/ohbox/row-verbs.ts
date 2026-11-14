/** A row's own verbs and words, and what the list hands the reading column for the open letter. */
import { isOwnSent, presentsUnread } from "@ohmail/client-engine";
import type { EngineMessage, OhboxRow as OhboxRowGroup, ThreadMark } from "@ohmail/client-engine";
import type { ListVisit } from "../reading/list-meeting.js";
import type { MessageAction } from "../press/actions.js";
import type { ScreeningDest } from "../press/sender-screening.js";
import type { OhboxListInput, OhboxListModel, OhboxStep } from "./types.js";

/** The model's fields a row's verbs answer. */
export type RowVerbs = Pick<
  OhboxListModel,
  | "doneRow"
  | "doneOffered"
  | "rowUnread"
  | "rowOpen"
  | "subjectOf"
  | "marksOf"
  | "screenPreview"
  | "screenPicked"
  | "markAllRead"
  | "visit"
  | "actOn"
  | "tagRow"
  | "tagPicked"
>;

/** What a row's verbs read beyond the input: the open letter, the picks, the reads, the walk. */
export interface RowVerbParts {
  selected: EngineMessage | null;
  pickedIds: string[];
  clearPicked: () => void;
  setPickPanel: (next: null) => void;
  markConversationRead: (m: EngineMessage) => void;
  markUnread: (m: EngineMessage) => void;
  wiring: OhboxListModel["wiring"];
  readSet: string[];
  stepUp: OhboxStep;
  stepDown: OhboxStep;
}

export function ohboxRowVerbs(
  input: OhboxListInput,
  {
    selected,
    pickedIds,
    clearPicked,
    setPickPanel,
    markConversationRead,
    markUnread,
    wiring,
    readSet,
    stepUp,
    stepDown,
  }: RowVerbParts,
): RowVerbs {
  const { bulk, onMarkSeen, onAction, onAddTag, threadSubject, threadMarksOf, onMarkAllRead } = input;
  /**
   * DONE ON EVERY ROW THAT WAITS. A row carrying pins releases them in one press (the Resurfaced row's own Done).
   * The open row's Done is the reader's Mark as read, over the set its read slot draws. Any other row's reads its
   * waiting letters: one goes as the single read it is, more as one bulk read with one report and one Undo. Our own
   * Sent copy never waits, and a read letter is never in the set.
   */
  const doneRow = (g: OhboxRowGroup): void => {
    const pinned = g.resurfaced?.pinned ?? [];
    if (pinned.length > 0) {
      bulk.run(
        "done",
        pinned.map((m) => m.id),
      );
      return;
    }
    if (selected != null && g.members.some((m) => m.id === selected.id)) {
      markConversationRead(selected);
      return;
    }
    const ids = g.members.filter((m) => m.unread && !isOwnSent(m)).map((m) => m.id);
    if (ids.length === 1) onMarkSeen(ids, false);
    else if (ids.length > 1) bulk.run("read", ids);
  };
  /**
   * WHAT THE LIST HANDS THE READING COLUMN for the open letter: what the view handed its pane, as one object. The
   * letter as its row presents it, the visit's wiring (the same object), the read set, and the pane's verbs: the
   * read slot's press goes through the same two directions the keys take, every other verb to the shell.
   */
  const listVisit: ListVisit | null =
    selected === null || wiring === null
      ? null
      : {
          openId: selected.id,
          unread: presentsUnread(selected),
          wiring,
          readSet,
          act: (a) => {
            if (a === "unread") {
              if (readSet.length > 0) markConversationRead(selected);
              else markUnread(selected);
              return;
            }
            onAction(a, selected);
          },
          step: { up: stepUp, down: stepDown },
        };
  const actOn = (g: OhboxRowGroup, action: MessageAction): void => onAction(action, g.openTarget);
  const tagRow = (g: OhboxRowGroup, anchor: HTMLElement | null): void => onAddTag(g.openTarget.id, anchor);
  const tagPicked = (anchor: HTMLElement | null): void =>
    bulk.tag(pickedIds, anchor ?? input.anchors.pickTag());
  const doneOffered = (g: OhboxRowGroup): boolean =>
    (g.resurfaced?.pinned.length ?? 0) > 0 || g.members.some((m) => m.unread && !isOwnSent(m));
  const rowUnread = (g: OhboxRowGroup): boolean => g.members.some(presentsUnread);
  const rowOpen = (g: OhboxRowGroup): boolean =>
    selected != null && g.members.some((m) => m.id === selected.id);
  const subjectOf = (g: OhboxRowGroup): string =>
    g.members.length > 1 ? (threadSubject?.(g.key) ?? g.face.subject) : g.face.subject;
  const marksOf = (g: OhboxRowGroup): readonly ThreadMark[] | undefined => {
    const threadId = g.members.length > 1 ? g.key : g.face.threadId;
    const marks = threadId && threadMarksOf ? threadMarksOf(threadId) : undefined;
    return marks && marks.length >= 2 ? marks : undefined;
  };

  const screenPreview = (dest: ScreeningDest) => bulk.screenPreview(pickedIds, dest);
  const screenPicked = (dest: ScreeningDest): void => {
    if (bulk.screen(pickedIds, dest)) clearPicked();
    else setPickPanel(null);
  };

  return {
    doneRow,
    doneOffered,
    rowUnread,
    rowOpen,
    subjectOf,
    marksOf,
    screenPreview,
    screenPicked,
    markAllRead: onMarkAllRead ?? null,
    visit: listVisit,
    actOn,
    tagRow,
    tagPicked,
  };
}
