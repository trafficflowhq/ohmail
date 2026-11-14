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
import type { ActedMarker } from "../press/after-verb.js";
import type { NotOrganizingYet } from "../mail-state/mail-state.js";
import type { UndoLink } from "../press/shell-dispatch.js";
import type { ListWindow } from "../lists/list-window.js";
import type { OlderMail } from "../lists/older-mail.js";
import type { BulkAction, MessageAction, MoveTarget } from "../press/actions.js";
import type { DragSource, RailDropTarget } from "../lists/drag-source.js";
import type { ScreeningDest } from "../press/sender-screening.js";
import type { KeyBinding } from "../keys/index.js";
import type { Translator } from "../text/translator.js";

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
  older: OlderMail;
  onMarkAllRead?: (ids: string[]) => void;

  t: Translator;
  /** Is the reading column hidden at this width? Asked at the moment it matters, never cached. */
  columnHidden: () => boolean;
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
export interface OhboxListModel {
  all: EngineMessage[];
  shown: EngineMessage[];
  unreadIds: string[];
  navRows: OhboxRowGroup[];
  groupedResurfaced: OhboxRowGroup[];
  groupedNew: OhboxRowGroup[];
  groupedPrev: OhboxRowGroup[];
  olderRows: OhboxRowGroup[];
  olderShown: EngineMessage[];
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
  groupVoices: (g: OhboxRowGroup) => EngineMessage[];
  groupSenders: (g: OhboxRowGroup) => string;
  stepUp: OhboxStep;
  stepDown: OhboxStep;
  keys: KeyBinding[];
  zone: {
    list: { up: OhboxStep; down: OhboxStep; followId: string | null };
    reader: { disabled: boolean; onEnter: () => void; onScrollKey: () => void; onHiddenEnter: () => void };
  };
  pointer: OhboxPointer;
  drag: {
    sourceFor: (rowId: string) => DragSource | null;
    onDrop: (target: RailDropTarget, source: DragSource) => void;
  };
}
