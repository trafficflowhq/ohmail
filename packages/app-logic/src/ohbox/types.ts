/**
 * The Ohbox's shapes: what a host hands the list's behaviour (`OhboxListInput`), what the selection can be asked to
 * do, and the model `useOhboxList` hands back.
 */
import type * as React from "react";
import type { MouseEvent as ReactMouseEvent, MutableRefObject, RefObject } from "react";
import type {
  EngineMessage,
  ListSurface,
  ResurfacedThreadRow,
  TagDTO,
  ThreadMark,
} from "@ohmail/client-engine";
import type { OhboxRow as OhboxRowGroup } from "@ohmail/client-engine";
import type { ThreadReadWiring } from "../reading/reader-seen.js";
import type { ThreadWalkChannel } from "../reading/thread-walk-channel.js";
import type { ActedMarker, AfterVerbChoice } from "../press/after-verb.js";
import type { NotOrganizingYet } from "../mail-state/mail-state.js";
import type { UndoLink } from "../press/shell-dispatch.js";
import type { ListWindow } from "../lists/list-window.js";
import type { BulkAction, MessageAction, MoveTarget } from "../press/actions.js";
import type { DragSource, RailDropTarget } from "../lists/drag-source.js";
import type { ScreeningDest } from "../press/sender-screening.js";
import type { KeyBinding } from "../keys/index.js";
import type { Translator } from "../text/translator.js";
import type { ListVisit } from "../reading/list-meeting.js";

/**
 * What a selection can be asked to do.
 *
 * Four callbacks and not one, because they are not one kind of thing. `run` and `tag` are
 * ordinary, reversible mail operations; `screen` is a consent decision about SENDERS, and
 * `screenPreview` exists so the surface can state what will persist BEFORE committing it.
 * Sharing a bar is right; sharing commit semantics would be the design error.
 */
export interface BulkVerbs {
  /**
   * Run a verb over the ids. `false` means it was REFUSED at the press and nothing was
   * dispatched — a reader's Move, Screening or Delete — so the caller keeps the selection
   * rather than clearing it. A set thrown away by a press that did nothing is a set the
   * person has to rebuild before they can try the verb that would have worked.
   */
  run: (action: BulkAction, ids: string[]) => boolean;
  tag: (ids: string[], anchor: HTMLElement | null) => void;
  screenPreview: (ids: string[], dest: ScreeningDest) => { senders: number; messages: number; rules: number };
  /** Commit the screening. `false` for the refusal, exactly as `run` — see there. */
  screen: (ids: string[], dest: ScreeningDest) => boolean;
}

/**
 * Which sub-row the selection pill is showing; `null` is the resting bar. Mirrors `BarPanel`.
 *
 * `"more"` IS GONE from this union, and that is the shape of the change rather than a detail
 * of it — the message pill made the same move for the same reason. A disclosure and a question
 * are different things: Move, Screening and Delete each ask WHERE, WHICH or WHETHER, and a row
 * that replaces the bar with the possible answers and a Cancel is the right ceremony for a
 * question. "More" asked nothing; it swapped the row for a different row in the same place with
 * no visible connection to the press. That is a menu, and it is `MoreMenu` now.
 */
export type PickPanel = { kind: "move" | "screen" | "delete" } | { kind: "confirm"; dest: MoveTarget };

/**
 * A reply that just landed, for the animate-to-Earlier gesture. The shell
 * sets this from `onSendSettled`: `messageId` is the answered message, `at`
 * is the settle instant so a consumer can ignore a stale value on a later
 * render. Exported so shell and view name one shape. The view's use is
 * narrow: it marks the answered message read — the slide belongs to
 * `slideOut`, which moves any row the selector re-files under "Earlier";
 * answering is one of the things that reads it, not a second gesture.
 */
export interface OhboxReplyDone {
  /** The answered message — the row that moves to Earlier. */
  messageId: string;
  /** ISO-8601 instant the reply settled. */
  at: string;
}

/**
 * Today's inputs of the Ohbox, under today's names and types (the view's props that are no node; `gone` stays the
 * view's, typed by its pane), and what a
 * host answers for the document: the reader of its words, whether the reading column is hidden, how a row and its
 * sender circle are found under the list's scroller, the two anchors a picker opens at, and the reading column's
 * scroller.
 */
export interface OhboxListInput {
  replyDone?: OhboxReplyDone | null;
  demo: boolean;
  setupHref?: string;
  resurfacedRows?: ResurfacedThreadRow[];
  newForYou: EngineMessage[];
  previouslySeen: EngineMessage[];
  threadParticipants?: (threadId: string) => { initials: string; hue: number }[];
  threadCountOf?: (threadId: string) => number;
  absoluteTime?: boolean;
  onToggleTime?: () => void;
  threadSubject?: (threadId: string) => string | null;
  tags: TagDTO[];
  now: Date;
  selectedId: string | null;
  lastActed?: React.MutableRefObject<ActedMarker | null>;
  onSelect: (id: string | null) => void;
  onEnterReader: (messageId: string) => void;
  enterId?: string | null;
  onEntered?: () => void;
  onMarkSeen: (ids: string[], unread: boolean, via?: "glance") => void | Promise<boolean>;
  onHoldRow?: (id: string | null) => void;
  onThreadRead?: (wiring: ThreadReadWiring | null) => void;
  threadMarksOf?: (threadId: string) => readonly ThreadMark[] | undefined;
  conversationOf?: (messageId: string) => readonly EngineMessage[];
  readerId: string | null;
  readSetFor: (messageId: string) => string[];
  undoLink?: MutableRefObject<UndoLink | null>;
  onRestoreHold?: (id: string) => boolean;
  doorbellInitials: string[];
  doorbellHues?: number[];
  doorbellCount: number;
  doorbellSettled?: boolean;
  notOrganizingYet?: NotOrganizingYet | null;
  settled: boolean;
  owed: boolean;
  onDoorbell: () => void;
  onAction: (action: MessageAction, message: EngineMessage) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
  onDropTag?: (ids: string[], tagId: string) => void;
  bulk: BulkVerbs;
  onMarkAllRead?: (ids: string[]) => void;

  t: Translator;
  /** Is the reading column hidden at this width? Asked at the moment it matters, never cached. */
  columnHidden: () => boolean;
  /**
   * The after-verb choice the pane obeys once a verb took the open row: asked at that moment, so a change applies
   * to the next verb. The view that mounts the list answers it from its own scope's stored choice.
   */
  afterVerb: () => AfterVerbChoice;
  /** A row in the list's scroller, carrying `data-id` (and `data-ids` for a folded row). */
  rowSelector: string;
  /** A row's sender circle, whose press is its own; `null` where a row draws none. */
  avatarSelector: string | null;
  anchors: { pickTag(): HTMLElement | null; row(id: string): HTMLElement | null };
  readColRef: RefObject<HTMLDivElement | null>;
  /** A sender's name as the row says it, and an own-sent letter's label: the drag's ghost wears the row's words. */
  senderName: (m: EngineMessage) => string;
  sentLabelOf: (m: EngineMessage) => { label: string } | null;
}

/** The pointer handlers the list's section takes in the capture phase: the long press and the modifier clicks. */
export interface OhboxPointer {
  onClickCapture: (e: ReactMouseEvent<HTMLElement>) => void;
  onPointerDownCapture: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMoveCapture: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerUpCapture: () => void;
  onPointerCancelCapture: () => void;
  onContextMenuCapture: (e: ReactMouseEvent<HTMLElement>) => void;
}

/** A walk step: the same pair j/k and the arrows dispatch. */
export interface OhboxStep {
  disabled: boolean;
  run: () => void;
  label: string;
}

/** The locals the list and its reading column draw, under their names of today. */
/** One person of a row's conversation: the newest letter they wrote, and whether it is the account's own. */
export interface OhboxPerson {
  letter: EngineMessage;
  you: boolean;
}

export interface OhboxListModel {
  all: EngineMessage[];
  shown: EngineMessage[];
  unreadIds: string[];
  navRows: OhboxRowGroup[];
  groupedResurfaced: OhboxRowGroup[];
  groupedNew: OhboxRowGroup[];
  groupedPrev: OhboxRowGroup[];
  listInput: { settled: boolean; count: number; pending: boolean };
  surface: ListSurface;
  mayState: boolean;
  hasOwnSent: boolean;
  listScrollerRef: RefObject<HTMLDivElement | null>;
  win: ListWindow;
  newBase: number;
  newCount: number;
  prevCount: number;
  prevLabelAt: number;
  prevBase: number;
  newFrom: number;
  newTo: number;
  prevFrom: number;
  prevTo: number;
  showNewLabel: boolean;
  showPrevLabel: boolean;
  selected: EngineMessage | null;
  settling: ReadonlySet<string>;
  picked: ReadonlySet<string>;
  pickedIds: string[];
  pickedRowCount: number;
  pickPanel: PickPanel | null;
  setPickPanel: (next: PickPanel | null) => void;
  clearPicked: () => void;
  togglePick: (id: string) => void;
  pickState: (on: boolean) => boolean | undefined;
  runBulk: (action: BulkAction) => void;
  markPicked: () => void;
  deletePicked: () => void;
  open: (m: EngineMessage) => void;
  enter: (m: EngineMessage) => void;
  selectByUser: (id: string, extend?: boolean) => void;
  /** A press on a row: a pick while picking on a phone, the open where there is no column or on a second press, else select and enter. */
  pressRow: (row: OhboxRowGroup) => void;
  markUnread: (m: EngineMessage) => void;
  markConversationRead: (m: EngineMessage) => void;
  readSet: string[];
  wiring: ThreadReadWiring | null;
  walk: ThreadWalkChannel;
  stripOpen: (target: EngineMessage) => void;
  /** The conversation as it stands, by any of its messages (the shell's), for the walked row's squares. */
  conversationOf?: (messageId: string) => readonly EngineMessage[];
  groupVoices: (g: OhboxRowGroup) => EngineMessage[];
  groupSenders: (g: OhboxRowGroup) => string;
  /** Everybody in the row's conversation: its voices first, the others newest first, the account's own as `you`. */
  groupPeople: (g: OhboxRowGroup) => OhboxPerson[];
  stepUp: OhboxStep;
  stepDown: OhboxStep;
  keys: KeyBinding[];
  zone: {
    list: { up: OhboxStep; down: OhboxStep; followId: string | null };
    reader: { disabled: boolean; onEnter: () => void; onScrollKey: () => void; onHiddenEnter: () => void };
  };
  pointer: OhboxPointer;
  /** Done on a row: its pins released, the open row read as the reader reads it, else its waiting letters read. */
  doneRow: (row: OhboxRowGroup) => void;
  /** Does the row wait for anything Done would answer: an unread letter somebody else wrote, or a pin? */
  doneOffered: (row: OhboxRowGroup) => boolean;
  /** The row as it is presented: unread when a member is, a pinned one included. */
  rowUnread: (row: OhboxRowGroup) => boolean;
  /** Is this the row the open letter is on (by membership)? */
  rowOpen: (row: OhboxRowGroup) => boolean;
  /** The row's subject: a conversation's stored name, else its face's. */
  subjectOf: (row: OhboxRowGroup) => string;
  /** The conversation's squares, where it has two messages or more. */
  marksOf: (row: OhboxRowGroup) => readonly ThreadMark[] | undefined;
  /** What screening the picked rows' senders to a place would move and make, before it is asked. */
  screenPreview: (dest: ScreeningDest) => { senders: number; messages: number; rules: number };
  /** Screen them: the pick clears when it went, and stays when it was refused at the press. */
  screenPicked: (dest: ScreeningDest) => void;
  /** Mark every unread letter of the Ohbox read, where the shell has the verb. */
  markAllRead: ((ids: string[]) => void) | null;
  /** What the list hands the reading column for the open letter; null while nothing is open. */
  visit: ListVisit | null;
  /** A verb of the row's own menu, on the letter the row opens on: the shell's, as a press on that letter. */
  actOn: (row: OhboxRowGroup, action: MessageAction) => void;
  /** The tag picker for the row's letter, at the element it was asked from. */
  tagRow: (row: OhboxRowGroup, anchor: HTMLElement | null) => void;
  /** The tag picker for the picked letters, at the element it was asked from. */
  tagPicked: (anchor: HTMLElement | null) => void;
  drag: {
    sourceFor: (rowId: string) => DragSource | null;
    onDrop: (target: RailDropTarget, source: DragSource) => void;
  };
}
