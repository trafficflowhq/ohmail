import { useMirrorReplacing } from "../engine/context.js";
/**
 * THE OHBOX, LIVE: what the Ohbox's seat calls once (`packages/app/src/ohbox/Seat.tsx`). It assembles the list's
 * input (`OhboxListInput`) from the frame's side (`args`), the mail ground's readers and the engine, calls the
 * list's behaviour (`useOhboxList`) once, and binds the list's keys. THE MODEL OF A PLACE'S LIVE HOOK: another
 * place's `live.ts` has this shape and invents none.
 *
 * WHERE EACH INPUT COMES FROM. The frame (`args`): the open letter (the address's), the columns, the commands, the
 * scope every stored choice is kept under, the one press seam. The ground, each reader throwing where none stands:
 * the presented mirror, the partition, the consent row, the mail state. The engine: the row held in New, the tags.
 * The place's own state, kept here and gone with the place: the cursor row, the row's seed for Move, the time's
 * form. What only a file of `packages/app` can read (`own`): the words, the nodes of the document, the Screener's
 * doorbell, the composer's doors.
 *
 * EVERY PRESS LEAVES THROUGH `args.press`: a letter's verbs and the selection's are `useListVerbs` of
 * `../press/`, never spelled here.
 *
 * WHERE ONE COLUMN STANDS THE CURSOR ROW IS THE LIST'S OWN: a selection there moves the cursor and names no letter,
 * so `j` and `k` walk a list that stays drawn, show nothing and read nothing. The letter is named in the address,
 * and so drawn over the list, only once its row is entered (Enter, a press).
 */
import type { EngineMessage, TagEntity as TagDTO } from "@ohmail/wire";
import { useState, type RefObject } from "react";
import { useDemoMode, useEngine } from "../engine/context.js";
import { CURSOR_HINT_MS, cursorPlacementText, useCursorPlacer, useKeyBindings } from "../keys/index.js";
import { useZoneIs, useZoneNav } from "../keys/zone-nav.js";
import type { PlaceLiveArgs } from "../lists/place-live.js";
import { nothingOrganizesOf, type NotOrganizingYet } from "../mail-state/mail-state.js";
import { useMailState } from "../mail-state/mail-state-binding.js";
import { readAfterVerb } from "../press/after-verb.js";
import type { ListVerbs } from "../press/list-verbs.js";
import { useStableCallback } from "../press/stable-callback.js";
import type { ListAnswer } from "../press/verb-context.js";
import { useDayClock } from "../session/day-clock.js";
import { senderName } from "../text/format.js";
import { useSentLabel } from "../text/row-copy.js";
import type { Translator } from "../text/translator.js";
import { cursorRowKeys, type RowAsk } from "./cursor-verbs.js";
export type { RowAsk, RowAskKind } from "./cursor-verbs.js";
import { useOhboxMirror, useThreadFacts } from "./live-mirror.js";
import { useOpenAndCursor } from "./live-open.js";
import { useOhboxVerbs } from "./live-verbs.js";
import { useOhboxList } from "./ohbox-list.js";
import { useReplyDone } from "../writing/reply-done.js";
import type { OhboxListInput, OhboxListModel, TagMenuPoint } from "./types.js";

export type { ListAnswer };

/** What only the Ohbox's seat can read: the words, the document's nodes, and what other features answer there. */
export interface OhboxLiveOwn {
  /** The Ohbox's own words. */
  readonly t: Translator;
  /** The sentences its verbs say, by `namespace.key`: `ohbox`, `screening`, `session`, `tag` and `markAll`. */
  readonly words: Translator;
  /** The names the key sheet lists the keys under. */
  readonly shortcuts: Translator;
  /** The cursor's own sentence: that a first press placed it (`placed`, naming the key pressed). */
  readonly cursor: Translator;
  /** The zone the reader's clock runs in. */
  readonly zone: string;
  /** How a row and its sender's circle are found under the list's scroller, and where a picker opens. */
  readonly rowSelector: string;
  readonly avatarSelector: string | null;
  readonly anchors: OhboxListInput["anchors"];
  /** The reading column's scroller, read when it is asked. */
  readonly readColRef: RefObject<HTMLDivElement | null>;
  /** Where the keyboard's zones stand: the reading column's target, and the list's open row. */
  readonly at: { readonly reading: string; readonly openRow: string };
  /** The Screener's doorbell, off the ground's one model: who waits, how many, and whether both answers are in. */
  readonly doorbell: {
    readonly initials: string[];
    readonly hues: number[];
    readonly count: number;
    readonly settled: boolean;
    readonly storeSettled: boolean;
  };
  /** The host's setup page, where it has one. */
  readonly setupHref: string | undefined;
  /** The one composer's doors for a letter. */
  readonly answer: (how: ListAnswer, m: EngineMessage) => void;
  /** More than one person besides the sender has the letter. */
  readonly replyAll: (m: EngineMessage) => boolean;
  /** The place's tag picker, pointed at a set of letters. */
  readonly pickTags: (ids: string[], anchor: HTMLElement | null, point?: TagMenuPoint) => void;
  /** A row was entered where one column stands: the keyboard goes to the letter over the list. */
  readonly onRowEntered: (id: string) => void;
  /** Stands a cursor row's question (Move's places, Delete's ask) or takes it away: the seat draws it. */
  readonly askRow: (ask: RowAsk | null) => void;
}

/** What the seat stands above the Ohbox's columns: the model, and the facts the words beside the list are said from. */
export interface OhboxLive {
  readonly model: OhboxListModel;
  readonly replacing: boolean;
  readonly now: Date;
  readonly absoluteTime: boolean;
  readonly flipTime: () => void;
  readonly tags: TagDTO[];
  readonly toggleTag: ListVerbs["toggleTag"];
  readonly bulkToggleTag: ListVerbs["bulkToggleTag"];
  readonly mail: { mailboxes: number | null; screenerCandidate: boolean; arrived: number };
  readonly notOrganizing: NotOrganizingYet | null;
  readonly sentLabelOf: (m: EngineMessage) => { label: string } | null;
  /** The Ohbox is on screen as its own answer: rows in it, or the mail state settled (an empty Ohbox that is so). */
  readonly onScreen: boolean;
}

/**
 * THE KEYS, one layer: the list's own, then the cursor row's verbs where one column stands and no letter is over the
 * list (`cursor-verbs.ts`). And the keyboard's two zones, the list and the reading column.
 */
function useOhboxKeys(
  args: PlaceLiveArgs,
  own: OhboxLiveOwn,
  model: OhboxListModel,
  act: ListVerbs["onMessageAction"],
  replacing: boolean,
): void {
  const engine = useEngine();
  const cursorRow = args.plan.columns === 1 && args.route.open === null;
  const readerFocused = useZoneIs("reader");
  const selected = model.selected;
  useKeyBindings(
    replacing
      ? []
      : [
          ...model.keys.filter((binding) => !readerFocused || binding.chord !== "t"),
          ...(cursorRow
            ? cursorRowKeys({
                t: own.shortcuts,
                row: selected,
                replyAll: selected !== null && own.replyAll(selected),
                deletable:
                  selected !== null && engine.verbRead().get<EngineMessage>("message", selected.id) != null,
                act,
                ask: (kind, m) => own.askRow({ kind, letter: m, act: (action) => act(action, m) }),
              })
            : []),
        ],
  );
  useZoneNav(own.shortcuts, {
    list: model.zone.list,
    reader: {
      selector: own.at.reading,
      focusSelector: `${own.at.reading}, [data-read-stop]`,
      ...model.zone.reader,
    },
    listFocusSelector: own.at.openRow,
  });
}

/**
 * THE PLACER: a letter's verb pressed while the list holds no cursor places the cursor on the first row, says so in
 * the frame's report, and does nothing else (`../keys/keymap.ts`, `CursorPlacer`): the second press acts. The placed
 * row is a selection as a person's own: beside the list its letter is shown, a preview that reads nothing; on one
 * column the cursor row alone moves. It declines where there is nothing to place on or a press would take a letter
 * away: a cursor that stands, a letter the address names, a list with no row, a first row the list has not mounted.
 */
function useOhboxPlacer(
  args: PlaceLiveArgs,
  own: OhboxLiveOwn,
  model: OhboxListModel,
  replacing: boolean,
): void {
  useCursorPlacer((label) => {
    if (replacing) return false;
    const first = model.firstRow;
    if (model.selected !== null || args.route.open !== null) return false;
    const row = first === null ? null : own.anchors.row(first);
    if (first === null || row === null) return false;
    model.selectByUser(first);
    /* The nudge a pressed row's selection gets: the placed row is on screen when the sentence names it. */
    row.scrollIntoView?.({ block: "nearest" });
    args.report(cursorPlacementText(own.cursor, label), { duration: CURSOR_HINT_MS });
    return true;
  }, "view");
}

export function useOhboxLive(
  args: PlaceLiveArgs,
  own: OhboxLiveOwn,
  initialSquare: string | null = null,
): OhboxLive {
  const engine = useEngine();
  const demo = useDemoMode();
  const { state: mail, mailboxes: facts } = useMailState();
  const { press, commands, scope } = args;
  const now = useDayClock(null, own.zone);
  const mirror = useOhboxMirror();
  const threads = useThreadFacts();
  const where = useOpenAndCursor(args, { onRowEntered: own.onRowEntered, row: own.anchors.row });
  const [absoluteTime, setAbsoluteTime] = useState(false);
  const flipTime = useStableCallback(() => setAbsoluteTime((v) => !v));
  const sentLabelOf = useSentLabel(own.t);
  const notOrganizing = demo ? null : nothingOrganizesOf(facts);
  const { verbs, markSeen, readSetFor, markAllRead } = useOhboxVerbs({
    args,
    mirror,
    words: own.words,
    zone: own.zone,
    answer: own.answer,
    pickTags: own.pickTags,
    ownFaceFor: where.ownFaceFor,
    forwardTargetFor: where.forwardTargetFor,
  });

  const model = useOhboxList({
    demo,
    /* The reply that last settled, as the one composer holds it: its letter is marked read and slides to Earlier. */
    replyDone: useReplyDone(),
    ...(own.setupHref === undefined ? {} : { setupHref: own.setupHref }),
    resurfacedRows: mirror.resurfacedRows,
    newForYou: mirror.ohbox.newForYou,
    previouslySeen: mirror.ohbox.previouslySeen,
    ...threads,
    absoluteTime,
    initialSquare,
    onToggleTime: flipTime,
    tags: mirror.tags,
    now,
    selectedId: where.selectedId,
    lastActed: verbs.lastActed,
    onSelect: where.onSelect,
    onEnterReader: where.onEnterReader,
    /* A hit opened INTO the Ohbox as entered (the frame's one-shot): its row is entered once it is shown. */
    enterId: args.entered.letter,
    onEntered: args.entered.taken,
    onMarkSeen: markSeen,
    /* The row being read, held in New by the engine; an Undo re-takes the hold it had at the press. */
    onHoldRow: useStableCallback((id: string | null) => {
      if (id === null) engine.releaseOpenRow();
      else engine.holdOpenRow(id);
    }),
    readerId: where.readerId,
    readSetFor,
    undoLink: press.undoLink,
    onRestoreHold: useStableCallback((id: string) => engine.restoreOpenRow(id)),
    doorbellInitials: own.doorbell.initials,
    doorbellHues: own.doorbell.hues,
    doorbellCount: own.doorbell.count,
    doorbellSettled: own.doorbell.settled,
    notOrganizingYet: notOrganizing,
    /* May the list state its emptiness as a fact yet? The mail state's answer, and the Screener's store's. */
    settled: mail.settled && own.doorbell.storeSettled,
    owed: mail.owed,
    onDoorbell: useStableCallback(() => commands.go({ place: "screener" })),
    onAction: verbs.onMessageAction,
    onAddTag: useStableCallback((id: string, anchor: HTMLElement | null, point?: TagMenuPoint) =>
      own.pickTags([id], anchor, point),
    ),
    onDropTag: verbs.dropTag,
    bulk: verbs.bulkVerbs,
    onMarkAllRead: markAllRead,
    t: own.t,
    columnHidden: useStableCallback(() => args.plan.columns === 1),
    afterVerb: useStableCallback(() => readAfterVerb(scope)),
    rowSelector: own.rowSelector,
    avatarSelector: own.avatarSelector,
    anchors: own.anchors,
    readColRef: own.readColRef,
    senderName,
    sentLabelOf,
  });
  const replacing = useMirrorReplacing();
  useOhboxKeys(args, own, model, verbs.onMessageAction, replacing);
  useOhboxPlacer(args, own, model, replacing);

  return {
    model,
    replacing,
    now,
    absoluteTime,
    flipTime,
    tags: mirror.tags,
    toggleTag: verbs.toggleTag,
    bulkToggleTag: verbs.bulkToggleTag,
    mail: {
      mailboxes: facts === null ? null : facts.length,
      screenerCandidate: mail.screenerCandidate,
      arrived: mail.count,
    },
    notOrganizing,
    sentLabelOf,
    /* Today's rule for the switch mark's end at the Ohbox, word for word. */
    onScreen:
      mail.settled ||
      mirror.resurfacedRows.length + mirror.ohbox.newForYou.length + mirror.ohbox.previouslySeen.length > 0,
  };
}
