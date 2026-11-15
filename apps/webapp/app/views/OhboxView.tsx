"use client";

/**
 * Ohbox — the two-pane accepted-mail view: grouped list (New / Earlier)
 * against the engine's ohboxView selector, the Screener
 * doorbell, and the reading column. j/k moves, ↵ opens the reader,
 * t opens the tag picker, x picks, u toggles unread.
 */
import * as React from "react";
import { useCallback, useEffect, useId, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useRowBadgeCopy, useSentLabel } from "../shell/row-copy";
import { rowThread, rowThreadOf } from "@ohmail/app-logic/reading/row-thread";
import {
  arrivalMs, countWhen, isOwnSent, isResurfaced, listSurface,
  presentsUnread, saysEmpty,
} from "@ohmail/client-engine";
import type { ListSurface, ThreadMark } from "@ohmail/client-engine";
import type { ThreadReadWiring } from "@ohmail/app-logic/reading/reader-seen";
import { ThreadStrip, useWalkedRow } from "../shell/ThreadStrip";
import type { EngineMessage, ResurfacedThreadRow, TagDTO } from "@ohmail/client-engine";
import {
  Doorbell,
  Icon,
  Kbd,
  ListGroupLabel,
  ListPane,
  ListRows,
  MessageRow,
  ReadColumn,
  Spinner,
  type MessageRowProps,
} from "@ohmail/ui";
import { MarkAllRead } from "../components/MarkAllRead";
import { ShortcutHint } from "../shell/ShortcutHint";
import { readColumnHidden } from "../shell/narrow";
import type { ActedMarker } from "@ohmail/app-logic/press/after-verb";
import { goFirstRun, goSettings } from "../shell/routing";
import { sharedNotOrganizedWhy, type NotOrganizingYet } from "@ohmail/app-logic/mail-state/mail-state";
import { displayAddress } from "../shell/idn";
import type { UndoLink } from "@ohmail/app-logic/press/shell-dispatch";
import type { OhboxRowGroup } from "./ohbox-groups";
import { PLACE_LABEL, avatarOf, resurfaceLabel, rowAddress, rowStamp, senderName, tagsOfMessage, hueOf } from "../shell/format";
import { useSenderCheckWords } from "../shell/sender-check";
import { useKeyBindings } from "../shell/keymap";
import { useZoneNav } from "../shell/zone-nav";
import { BootSkeleton } from "../shell/BootSkeleton";
import { useLoadingGrace } from "@ohmail/app-logic/session/loading-grace";
import { useMailState } from "../shell/MailStateProvider";
import type { OlderMail } from "@ohmail/app-logic/lists/older-mail";
import {
  Key, MessageGone, MessagePane, MOVE_TARGETS,
  type BulkAction, type MessageAction, type MessageGoneProps,
} from "../shell/MessagePane";
import { MoreMenu, type MoreMenuItem } from "../shell/MoreMenu";
import { useBarDensity } from "@ohmail/app-logic/lists/bar-density";
import { useDragToFile } from "../shell/drag-file";
import "../shell/action-bar.css";
import { useOhboxList, type BulkVerbs, type OhboxReplyDone, type PickPanel } from "@ohmail/app-logic/ohbox";

export type { BulkVerbs, OhboxReplyDone } from "@ohmail/app-logic/ohbox";

/** The no-mailbox card's verb where the door has no setup page (the desktop window). */
const SETTINGS_MAILBOXES = "#/settings/mailboxes";

export function OhboxView({
  demo,
  setupHref = SETTINGS_MAILBOXES,
  replyDone,
  noticeSection,
  standingNotice,
  resurfacedRows = [],
  newForYou,
  previouslySeen,
  threadParticipants,
  threadCountOf,
  threadSubject,
  absoluteTime,
  onToggleTime,
  tags,
  now,
  selectedId,
  gone = null,
  lastActed,
  onSelect,
  onEnterReader,
  enterId = null,
  onEntered,
  onMarkSeen,
  onHoldRow,
  onThreadRead,
  threadMarksOf,
  conversationOf,
  readerId,
  readSetFor,
  undoLink,
  onRestoreHold,
  doorbellInitials,
  doorbellHues,
  doorbellCount,
  doorbellSettled = true,
  notOrganizingYet = null,
  settled,
  owed,
  onDoorbell,
  onAction,
  onAddTag,
  onDropTag,
  bulk,
  older,
  onMarkAllRead,
}: {
  /**
   * A reply that just settled, or `null`. The view marks the answered message read; the move to
   * "Earlier" follows from that, through the same slide every other read takes. Optional so
   * every existing caller and test compiles unchanged.
   */
  replyDone?: OhboxReplyDone | null;
  /**
   * A quiet line above the list — the shell's channel for ambient state the
   * Ohbox's owner should see without being interrupted (today: the away
   * responder's "replies are going out for you"). A `ReactNode` slot, not a
   * boolean per notice — a boolean per notice is how a view ends up with
   * five. The view draws what it is given and gates nothing: whether there
   * is anything to say is the shell's call, made where the server state
   * lives. Absent means absent — no placeholder, no reserved height.
   */
  noticeSection?: ReactNode;
  /**
   * The standing notice — the list's FIRST BLOCK, inside the scroller, not
   * the header's last line. `noticeSection` is the header slot, right for
   * the offer and the organizer notice (they ask or report); wrong for the
   * away responder's standing line — pinned above the rows it is a toolbar
   * eating a third of a phone screen, scrolled away on a desktop it is
   * hidden. Here the `Banner` primitive's one media rule pins it at the
   * desktop breakpoint and lets it flow below. Same contract: the view
   * draws what it is given; absent means absent.
   */
  standingNotice?: ReactNode;
  /** Fixture world or a real mailbox — decides the "older mail" tail. See its use below. */
  demo: boolean;
  /** Where the no-mailbox card's verb goes: the door's setup page, else Settings → Mailboxes. */
  setupHref?: string;
  /**
   * RESURFACED CONVERSATIONS, PINNED ABOVE EVERYTHING — one row each, from the engine's
   * `resurfacedThreads`. Rows and not messages: the pin is per message on the wire, and a
   * conversation parked as five came back as five rows. The flat member list this view places and
   * slides is derived below, so there is one source for which messages are up here. Optional and
   * defaulted to `[]`: several tests mount this view without it.
   */
  resurfacedRows?: ResurfacedThreadRow[];
  newForYou: EngineMessage[];
  previouslySeen: EngineMessage[];
  /**
   * THE PEOPLE IN A ROW'S CONVERSATION, for its lead circles — bound to the engine's reader by
   * the shell (this view has none) and mapped to `{initials, hue}`. Called per rendered row that
   * carries a `threadId`; `[]` for a message with no real multi-message thread. A LOOKUP, not a
   * scan: the shell indexes every thread once per engine version, so calling it per row is free.
   * Optional — a view mounted without it leads every row with the one sender's circle.
   */
  threadParticipants?: (threadId: string) => { initials: string; hue: number }[];
  /**
   * HOW LONG THE CONVERSATION IS, from the engine's one index (`AppShell`) — 0 where the mirror
   * knows of no thread, which is a row standing for itself. The view has no reader of its own,
   * exactly as {@link threadParticipants} has none.
   */
  threadCountOf?: (threadId: string) => number;
  /**
   * THE DATE STAMPS — which form they are in, and the press that flips them.
   *
   * One boolean for every row at once: the shell owns it, resets it on a view switch and shares
   * it with the open message, so no two dates on screen are ever in different shapes. `rowStamp`
   * turns the pair into the row's stamp props, and a grouped row's stamp follows its newest
   * member exactly as its relative one does. Optional, and absent leaves the rows exactly as they
   * were — relative dates, the exact instant on hover, nothing to press.
   */
  absoluteTime?: boolean;
  onToggleTime?: () => void;
  /**
   * THE CONVERSATION'S STORED NAME — the mirror's thread row's subject, bound by the shell the
   * way {@link threadParticipants} is. The server names a thread with the reply/forward
   * prefixes already stripped, so a grouped row shows "Webshop" where its members say
   * "Re: Webshop" — and the view does NOT re-clean anything: one definition of that table,
   * server-side. `null` (thread row not yet synced) falls back to the newest member's subject.
   * Optional: a view mounted without it — most tests, the demo — just uses the fallback.
   */
  threadSubject?: (threadId: string) => string | null;
  tags: TagDTO[];
  now: Date;
  selectedId: string | null;
  /**
   * THE COLUMN'S MESSAGE WAS TAKEN AWAY BY ANOTHER MAIL CLIENT — non-null ⇒ render the notice
   * where the pane would be, instead of the resting panel. It cannot be derived here: a tombstone
   * takes the row out of `all`, so this view can only see that nothing is selected, which is also
   * what a resting column looks like. The shell asks the mirror and answers. See
   * {@link MessageGone}.
   */
  gone?: MessageGoneProps | null;
  /**
   * The shell's last-verb marker (`after-verb.ts`): when the row it names leaves `all` while
   * still selected and the marker is fresh, the pane applies the person's after-verb choice —
   * advance, stay or close. A ref, so recording a press costs no render.
   */
  lastActed?: React.MutableRefObject<ActedMarker | null>;
  /** `null` clears the selection — the after-verb `close` choice. */
  onSelect: (id: string | null) => void;
  /**
   * Open the reader ON A MESSAGE.
   *
   * It took no argument while the shell's reader was a boolean over `selectedOhbox`. It
   * takes one now because `open` below calls `onSelect` and this in the same tick, so the
   * shell's own selection has not re-rendered yet — a reader that read it would show the
   * previously selected message.
   */
  onEnterReader: (messageId: string) => void;
  /** A hit the person opened (Search, an address page): entered once its row is shown, as ↵ enters. */
  enterId?: string | null;
  /** The request is spent: entered, or the selection moved on before it was. */
  onEntered?: () => void;
  /**
   * The shell's `mark_seen` mutation — the one read-state writer.
   *
   * `via` says whether the reader ASKED for this or the view decided for them; it travels
   * because a resurfaced pin is answered by being dealt with, and a glance is not dealing with
   * anything. Only the thread-read rule's reads claim `"glance"` (`readByRule`). Omitting it means
   * deliberate, which is what every other caller here is. The shell answers whether the write landed.
   */
  onMarkSeen: (ids: string[], unread: boolean, via?: "glance") => void | Promise<boolean>;
  /**
   * The row being read, reported upward — `id` once its conversation is entered (the engine holds
   * its row in New: `holdOpenRow`), `null` once the reader leaves it or `u` lets it go. Never a
   * writer of read-state. Optional: a harness mounted without it holds no row.
   */
  onHoldRow?: (id: string | null) => void;
  /**
   * THE VISIT'S THREAD-READ WIRING, reported upward for the reader sheet (the shell mounts it, and
   * the sheet is an open): the record, the rule's read and enter report-ups and the panels' Mark
   * unread — the same the reading column is handed. `null` while nothing is open.
   */
  onThreadRead?: (wiring: ThreadReadWiring | null) => void;
  /**
   * THE CONVERSATION'S SQUARES for a row — the engine's `threadMarksIndex`, bound by the shell the
   * way {@link threadParticipants} is. Absent, the rows draw no squares.
   */
  threadMarksOf?: (threadId: string) => readonly ThreadMark[] | undefined;
  /**
   * THE CONVERSATION AS IT STANDS — the shell's `conversationOf`, the reader's own panels. The open
   * row's strip draws its squares from it, so a reply or a read change after the reader closed shows
   * there as on the row's marks. Absent, the strip draws what the reader last published.
   */
  conversationOf?: (messageId: string) => readonly EngineMessage[];
  /**
   * THE READER'S MARK AS READ SET — the shell's `conversationReadSet` over the presented mirror:
   * the unread members of the conversation on screen. Required, no default: the read slot's face
   * and ⇧I's write are this one function, and a default would be an untested arm.
   */
  readSetFor: (messageId: string) => string[];
  /** Where this view answers an Undo (`UndoLink`): the row a verb took from under the cursor comes back as it stood. */
  undoLink?: MutableRefObject<UndoLink | null>;
  /** Re-take the hold an undone act ended (`engine.restoreOpenRow`); `true` when the row is held. */
  onRestoreHold?: (id: string) => boolean;
  /**
   * Which message the reader sheet is showing, or `null` when closed. This
   * view does not open the sheet and renders nothing from it; it needs the
   * value because closing the sheet is one of the four ways of LEAVING a
   * message, and leaving commits reading. The sheet belongs to the shell,
   * so the only way to notice it closing is to be told. Required, no
   * default: the safe-looking default is `null` — "the sheet is never open"
   * — and a mobile reader would then mark nothing read on close, in exactly
   * the surface where closing the sheet is the only way to leave.
   */
  readerId: string | null;
  doorbellInitials: string[];
  /** Per-sender tint hues for the doorbell stack, index-aligned with `doorbellInitials`. */
  doorbellHues?: number[];
  doorbellCount: number;
  /** Has the Screener's queue been read (`ScreenerState.queueSettled`)? Until then no bell, not even "All clear". */
  doorbellSettled?: boolean;
  /** Mailboxes nobody agreed to organize (`notOrganizingYetOf`): where it is every one, "All clear" is not said. */
  notOrganizingYet?: NotOrganizingYet | null;
  /**
   * May this view state its emptiness as a fact? Derived once in
   * `shell/mail-state.ts` ({@link MailState.settled}). Three sentences here
   * are claims about the user's own mail — the meta count, "All clear", the
   * empty pane — and all three were rendered before the first drain over a
   * mailbox that was not empty. A prop, not `useMailState()`: the hook
   * throws without a provider and `test/ohbox-read-state.test.ts` mounts
   * this view bare. Required, no default — the default would be `true`,
   * the lying surface with no error anywhere.
   */
  settled: boolean;
  /**
   * Do the account's own facts say mail is still on its way ({@link MailState.owed})? A drain
   * that completed is not a mailbox that has been read: measured on the managed web, this pane
   * said "Nothing in your Ohbox." and then a partial count as settled fact while the rail was
   * saying "Syncing your mail". The two are asked together through `listSurface`; a prop for
   * `settled`'s reason, and required for it too.
   */
  owed: boolean;
  onDoorbell: () => void;
  onAction: (action: MessageAction, message: EngineMessage) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
  /**
   * APPLY a tag to a set — the rail-drop's dispatch, and only that. The picker path stays
   * `onAddTag` (it anchors a popover); a drop has already named its tag, so it goes straight
   * to the same `tag_assign` fan-out the picker's apply runs (`AppShell.bulkToggleTag`,
   * apply-direction only — a drop must never TOGGLE a tag off). Optional: a harness that
   * mounts this view without it simply has no tag drops, and the shipped shell always
   * passes it.
   */
  onDropTag?: (ids: string[], tagId: string) => void;
  /** The verbs a multi-selection offers. */
  bulk: BulkVerbs;
  /**
   * What lies beyond the end of this device's window, and how to reach it
   * (`app/shell/older-mail.ts`). A prop with no default, for `settled`'s
   * reason: the only safe default would be "there is nothing older", which
   * a windowed client must never say by accident — a caller that forgets it
   * is a type error, not a list that quietly stops at ninety days. From the
   * shell rather than a hook because several tests mount this view with no
   * engine at all — the same seam every other engine fact comes through.
   */
  older: OlderMail;
  /** Mark every unread Ohbox message read, chunked, via the shell. Optional: this view is
   * mounted without a shell in several tests, and a control with nothing behind it must not show. */
  onMarkAllRead?: (ids: string[]) => void;
}) {
  const t = useTranslations("ohbox");
  const { row: senderCheckRow } = useSenderCheckWords();
  const rowBadge = useRowBadgeCopy();
  /* The reading column's region name — shared vocabulary with every split view, so the
     screen-reader landing (`ReadColumn regionLabel`) says the same thing everywhere. */
  const tReader = useTranslations("reader");

  /** The reading column's scroller — the thread-read rule observes it. */
  const readColRef = useRef<HTMLDivElement>(null);
  /** An own-sent row is labelled by its recipient — see `useSentLabel`. */
  const sentLabelOf = useSentLabel();
  const model = useOhboxList({
    replyDone, demo, setupHref, resurfacedRows, newForYou, previouslySeen, threadParticipants, threadCountOf, threadSubject,
    absoluteTime, onToggleTime, tags, now, selectedId, lastActed, onSelect, onEnterReader, enterId, onEntered,
    onMarkSeen, onHoldRow, onThreadRead, threadMarksOf, conversationOf, readerId, readSetFor, undoLink, onRestoreHold,
    doorbellInitials, doorbellHues, doorbellCount, doorbellSettled, notOrganizingYet, settled, owed, onDoorbell,
    onAction, onAddTag, onDropTag, bulk, older, onMarkAllRead,
    t,
    columnHidden: readColumnHidden,
    rowSelector: ".row[data-id]",
    avatarSelector: ".av",
    anchors: {
      pickTag: () => document.querySelector<HTMLElement>(".view-ohbox .list-foot .abar-tag .abar-b"),
      row: (id) => document.querySelector<HTMLElement>(`.view-ohbox .row[data-id="${CSS.escape(id)}"]`),
    },
    readColRef,
    senderName,
    sentLabelOf,
  });
  const {
    all, unreadIds, groupedResurfaced, groupedNew, groupedPrev, olderRows, olderShown,
    listInput, surface, mayState, hasOwnSent,
    listScrollerRef, win, newBase, newCount, prevCount, prevLabelAt, prevBase, newFrom, newTo, prevFrom, prevTo,
    showNewLabel, showPrevLabel,
    selected, settling, picked, pickedIds, pickedRowCount, pickPanel, setPickPanel, clearPicked, runBulk, markPicked,
    deletePicked, pressRow, markUnread, markConversationRead, readSet, wiring, walk, stripOpen, groupVoices, groupSenders,
    pickState, pointer,
  } = model;
  useKeyBindings(model.keys);
  useZoneNav({ list: model.zone.list, reader: { selector: ".view-ohbox .read-col", ...model.zone.reader } });

  /**
   * A message's circle in the participant-stack's shape — the SAME derivation the row's own
   * lead uses ({@link avatarOf}: the display name's initial, the hue keyed on the address), so
   * a person is one letter and one colour whether they lead a row or stand in its stack.
   */
  const circleOf = (m: EngineMessage): { initials: string; hue: number } => {
    const a = avatarOf(m);
    return { initials: a.avatarInitial, hue: a.avatarHue };
  };

  /**
   * THE ROW SAYS WHERE THE MESSAGE STANDS — the triage state, visible where the verbs fire.
   *
   * A queued or parked message rendered identically to its neighbours, so the state existed
   * only on the Triage screen: `a` on something already in the Reply Run queue was pressed in
   * good faith, and a resurface date was silently re-booked (now: cleared — the toggle) by a
   * key whose target looked untouched. One quiet badge on the strip states it. `resurfaced`
   * needs none — the pin group's own position is that statement.
   */
  const stateNoteOf = (m: EngineMessage): string | undefined => {
    const s = m.triage?.state;
    if (s === "reply_later") return t("stateLater");
    if (s === "set_aside") return t("stateAside");
    if (s === "bubbled_up")
      return m.triage?.bubbleUpAt
        ? t("stateResurface", { when: resurfaceLabel(m.triage.bubbleUpAt, now) })
        : t("stateResurfaceBare");
    return undefined;
  };

  /**
   * "Done" on a pinned row — the deliberate release, standing where the eye looks for it. A resurfaced row's one way
   * out (short of answering) was a read verb that never said so: `⇧I`, the bar's "Mark as read", a bulk Read.
   * Reported from real use in exactly those terms, and the question is asked AT THE PIN, so the answer stands on the
   * pinned row itself, in the Screener quick-adjust's reveal grammar (`MessageRow.actions` — hover, focus, selection;
   * always shown where hover does not exist). It dispatches `resurface_done` — the shell's one release arm, shared
   * with the action bar's Done — for THIS row's message, never the selected one, which is why it does not press `⇧I`;
   * the choreography that follows is the existing one (the deliberate `mark_seen` spends the pin first-frame,
   * the row returns to "Earlier" at its arrival slot, `slideOut` draws the descent).
   */

  /**
   * NULL, not absent, once the pin is spent: the slot must survive the 280 ms slide (dropping the prop remounts the
   * button and kills the transition), and offering "Done" on a released row would be a press that does nothing. The
   * other groups' rows never carry the slot at all.
   */
  const doneFor = (m: EngineMessage): ReactNode =>
    isResurfaced(m) ? (
      <button
        type="button"
        className="rsf-done"
        aria-label={t("rowDoneAria")}
        title={t("rowDoneAria")}
        onClick={() => onAction("resurface_done", m)}
      >
        <Icon name="check" size={12} />
        {t("actionDone")}
      </button>
    ) : null;

  /**
   * DONE ON A CONVERSATION — the same release over every member carrying a pin. The row says one
   * conversation, so one press must answer all of it: releasing the lead and leaving two siblings
   * pinned would put the row straight back with a smaller count. `bulk.run("done", ids)` and not a
   * loop over {@link doneFor}: the shell clears the bookings and spends the pins in one batch with
   * one sentence, where N presses would be N toasts for one act. A single-member row goes the same
   * way — one seam, and nothing decides by counting members.
   */
  const doneForRow = (g: OhboxRowGroup): ReactNode => {
    const pinned = g.resurfaced?.pinned ?? [];
    if (pinned.length === 0) return null;
    return (
      <button
        type="button"
        className="rsf-done"
        aria-label={t("rowDoneAria")}
        title={t("rowDoneAria")}
        onClick={() => bulk.run("done", pinned.map((m) => m.id))}
      >
        <Icon name="check" size={12} />
        {t("actionDone")}
      </button>
    );
  };

  const walked = useWalkedRow(walk);
  /**
   * The walked conversation's row carries the strip, in place of its own squares; every other
   * conversation's row an empty follower, so opening never remounts the row's button. The strip's
   * squares are the conversation as it stands (`conversationOf`), asked again when the row's own
   * marks change; only the place comes from the walk.
   */
  const followOf = (members: readonly EngineMessage[], target: EngineMessage, threadId: string | null | undefined): ReactNode =>
    !walked(members.map((m) => m.id)) ? null : <ThreadStrip
      channel={walk}
      members={members.map((m) => m.id)}
      onOpen={() => stripOpen(target)}
      conversationOf={conversationOf}
      marks={marksOf(threadId).marks}
    />;

  /**
   * `actions` and `windowIndex` are threaded only by the mappers that have them. NEVER pass
   * `groupRow` straight to `.map`: the array index would arrive as `windowIndex` and stamp a
   * `data-index` from another list's counting, which the window would then measure as its own.
   * Every call site wraps them in a lambda for that reason.
   */
  /** A row's squares and their words, where its conversation has two or more messages. */
  const marksOf = (threadId: string | null | undefined): Pick<MessageRowProps, "marks" | "marksLabel"> => {
    const marks = threadId && threadMarksOf ? threadMarksOf(threadId) : undefined;
    if (!marks || marks.length < 2) return {};
    return { marks, marksLabel: rowBadge.marks(marks.length, marks.filter((k) => k === "unread").length) };
  };

  const rowWith = (row: OhboxRowGroup, actions?: ReactNode, windowIndex?: number, inSet?: MessageRowProps["inSet"]) => {
    const m = row.members[0]!;
    // the conversation's people, computed by the shell's bound selector and never in the row.
    // Only for a threaded row; `[]` for a single-sender thread or none, and the row then leads
    // with the one full-size circle it always did.
    const participants = m.threadId && threadParticipants ? threadParticipants(m.threadId) : [];
    // see `sentLabelOf`: an own-sent row is labelled by its recipient, circle included; the
    // address slot stays empty (the writer's own address is the fact being replaced).
    const sent = sentLabelOf(m);
    return (
    <MessageRow
      spoken={rowBadge.spoken}
      key={m.id}
      id={m.id}
      windowIndex={windowIndex}
      inSet={inSet}
      from={sent ? sent.label : senderName(m)}
      address={sent ? undefined : rowAddress(m)}
      {...(sent ? {} : senderCheckRow(m))}
      {...(sent ? sent.avatar : avatarOf(m))}
      {...rowStamp(m, now, absoluteTime, onToggleTime)}
      subject={m.subject}
      preview={m.protected ? t("protectedPreview") : m.snippet}
      /* As PRESENTED: a pinned row reads unread whatever its stored flag says (`presentsUnread`). */
      unread={presentsUnread(m)}
      seen={!presentsUnread(m)}
      selected={selected?.id === m.id}
      // the settling class rides the row for the 280 ms it takes to slide down to "Earlier" —
      // read here, answered, or read on another mail client. See `slideOut`.
      className={settling.has(m.id) ? "settling" : undefined}
      {...rowThreadOf(m, threadCountOf, rowBadge.thread)}
      {...marksOf(m.threadId)}
      /* An own-sent row's LEAD is the RECIPIENT's and stays that way: the row is about the
         person it went to. The strip beside the subject is NOT suppressed with it — the faces
         name who the CONVERSATION is between, which the reader's own reply is one voice of.
         Suppressing them under the Me → label meant a thread lost its people the moment the
         reader answered it (reported against a live two-person exchange); the strip rides the
         subject line, so it takes nothing from the lead. `MessageRow` still draws nothing for
         fewer than two, so a sent singleton is untouched. */
      participants={participants}
      hasAttachment={m.hasAttachments}
      protectedLabel={m.protected != null ? rowBadge.protectedLabel : undefined}
      stateNote={stateNoteOf(m)}
      tags={tagsOfMessage(m, tags).map((tag) => ({ name: tag.name, hue: hueOf(tag) }))}
      /* `picked` carries BOTH the styling and the ARIA now — it used to be a
         class name only, so `aria-selected` was set on zero rows and the selection existed
         for sighted mouse users and nobody else. See `MessageRow`. */
      picked={pickState(picked.has(m.id))}
      actions={actions}
      follow={marksOf(m.threadId).marks ? followOf([m], m, m.threadId) : undefined}
      onClick={() => pressRow(row)}
    />
    );
  };


  /**
   * One row for a conversation — and a plain {@link row} for anything that did not fold, so a section of singletons
   * renders byte-for-byte as it always has. The folded row shows the conversation's STORED name (server-cleaned; see
   * `threadSubject`, falling back to the newest member's subject until the thread row syncs), the newest member's
   * snippet and time, the distinct unread senders on the sender line — the same people as the row's lead circles
   * (`participants` below) — and its squares under the preview (`⤷ N` steps back where they are as many). Click and
   * ↵ act on the NEWEST LETTER, read or unread (c3): the ordinary per-message open, so the thread view and held place behave
   * exactly as for a plain row. What turns read is the thread-read rule's, or the reader's Mark as read.
   * `selected` is row MEMBERSHIP, so the highlight survives the lead message changing.
   */

  /**
   * `settling` ONLY WHEN EVERY PLACING MEMBER IS SLIDING: the slide is per MESSAGE, and a conversation leaves New only
   * once none of it is unread — then every member it placed there descends and the row re-files under "Earlier" as
   * one. `placing`, never `members`: a Sent copy absorbed from Earlier is not sliding, and keying on it would take
   * the slide away from exactly the answered row.
   */
  const groupRow = (g: OhboxRowGroup, windowIndex?: number, actions?: ReactNode, inSet?: MessageRowProps["inSet"]) => {
    /* The slot travels through the singleton arm too: a conversation with one message on screen
       is still a conversation the reader asked to see again, and a Done that appeared only once
       a second member arrived would be a control that comes and goes with the mail. */
    if (g.members.length === 1) return rowWith(g, actions, windowIndex, inSet);
    const target = g.openTarget;
    const shown = g.face;
    const voices = groupVoices(g);
    // The lead circle is the sender line's first voice: the newest unread letter's, else the target's.
    const leadOf = g.members.filter((m) => m.unread && !isOwnSent(m))
      .reduce<EngineMessage | null>((a, m) => (a === null || (arrivalMs(m) ?? -Infinity) > (arrivalMs(a) ?? -Infinity) ? m : a), null) ?? target;
    /**
     * THE ROW'S FACES, and they are the SENDER LINE's people whenever there are people on it. Two sources, one
     * precedence, and the order matters. A waiting conversation names its distinct unread senders — so the circles
     * are those senders, from the members the view already holds. A conversation that has all been read names only
     * its newest voice, which is one face and not a conversation, so the row falls back to the mirror's own answer
     * for who is in the thread (`threadParticipants`, newest first) — the whole history, including the members this
     * section is not showing. `MessageRow` draws nothing for fewer than two, which is the same "there is no
     * conversation of people here" both sources already agree on.
     */
    const participants =
      voices.length > 1 ? voices.map(circleOf) : threadParticipants ? threadParticipants(g.key) : [];
    /**
     * THE NEWEST MEMBER IS THE ACCOUNT'S OWN REPLY — the conversation ends, so far, with the reader's own words, and
     * the row says who they went to rather than showing the reader their own name (see `sentLabelOf`). Two arms, one
     * label, never both:
     * · everything read (an answered conversation under "Earlier"): the sender line and the LEAD circle are the
     *   recipient's, exactly as on a singleton sent row — the strip beside the subject keeps the conversation's
     *   people either way;
     */

    /**
     * · unread members present: the distinct unread senders own the sender line, unchanged, and the snippet — which
     *   is the reply's — carries the label as its attribution. A reply with no recipients on the row (pre-recipient
     *   mirror) is `sent == null`, and the row keeps the ordinary sender summary.
     */
    const sent = sentLabelOf(shown);
    const sentLeads = sent !== null && g.unreadCount === 0;
    /* The conversation's length as the SERVER knows it — a windowed mirror holding three of nine
       would otherwise say three. The engine's index answers for every grouped row (`g.key` IS the
       thread id here, since a group of more than one can only come from a shared thread); the
       Resurfaced row's own count is the same number from the same index, and the members in hand
       are the floor for a mirror that has not got the thread row yet. Read once: the badge shows
       it and the row's description says it, and two reads could disagree. */
    const threadCount = Math.max(
      threadCountOf?.(g.key) ?? 0, g.resurfaced?.count ?? 0, g.members.length,
    );
    return (
      <MessageRow
        spoken={rowBadge.spoken}
        key={`t:${g.key}`}
        id={target.id}
        windowIndex={windowIndex}
        inSet={inSet}
        /* The fold SHOWS every member, so anything locating "the row where message X is"
           (the shell's flash after a search jump) must be able to match this row on any of
           them — `data-id` alone named only the lead. See MessageRow.memberIds. */
        memberIds={g.members.map((m) => m.id)}
        stampId={shown.id}
        from={sentLeads ? sent.label : groupSenders(g)}
        {...(sentLeads ? sent.avatar : avatarOf(leadOf))}
        /* The stamp is the newest member's, in whichever form the list is in — the same message
           the relative stamp has always named, so the exact date on hover is that one's too. */
        {...rowStamp(shown, now, absoluteTime, onToggleTime)}
        subject={threadSubject?.(g.key) ?? shown.subject}
        // see the docblock: the conversation slides only when the whole of it is on its way down.
        className={g.placing.every((m) => settling.has(m.id)) ? "settling" : undefined}
        preview={
          shown.protected
            ? t("protectedPreview")
            : sent !== null && !sentLeads
              ? `${sent.label}: ${shown.snippet}`
              : shown.snippet
        }
        /* The fold's own count is true unread (it also picks `openTarget`); the DOT is presented
           state (`presentsUnread`: a pinned member reads unread). */
        unread={g.members.some(presentsUnread)}
        seen={!g.members.some(presentsUnread)}
        selected={selected != null && g.members.some((m) => m.id === selected.id)}
        {...rowThread(threadCount, rowBadge.thread)}
        {...marksOf(g.key)}
        newSinceLabel={
          g.resurfaced && g.resurfaced.newSince > 0
            ? t("newSince", { count: g.resurfaced.newSince })
            : undefined
        }
        newSinceTitle={
          g.resurfaced && g.resurfaced.newSince > 0
            ? t("newSinceTitle", { count: g.resurfaced.newSince })
            : undefined
        }
        /* the Me → recipient rule wins the LEAD circle and the sender line — not the strip,
           which still names the conversation's people: see the singleton row above. */
        participants={participants}
        hasAttachment={g.members.some((m) => m.hasAttachments)}
        protectedLabel={shown.protected != null ? rowBadge.protectedLabel : undefined}
        /* The open target's state and tags, because the target is what the row's click and
           every verb pressed on this row act on — a chip describing some OTHER member would
           promise a toggle the keys cannot deliver. The phone's row draws the same. */
        stateNote={stateNoteOf(target)}
        tags={tagsOfMessage(target, tags).map((tag) => ({ name: tag.name, hue: hueOf(tag) }))}
        picked={pickState(g.members.every((m) => picked.has(m.id)))}
        actions={actions}
        follow={followOf(g.members, target, g.key)}
        onClick={() => pressRow(g)}
      />
    );
  };

  const drag = useDragToFile(model.drag);
  const onHoldPointerDown = pointer.onPointerDownCapture;

  return (
    <section
      className="view split view-ohbox"
      onClickCapture={pointer.onClickCapture}
      /* BESIDE the drag's own handler, not instead of it: `drag-file.ts` returns early for a
         touch pointer and this one returns early for every other kind, so exactly one of the
         two can arm on any given press. */
      onPointerDownCapture={(e) => { drag.onPointerDown(e); onHoldPointerDown(e); }}
      onPointerMoveCapture={pointer.onPointerMoveCapture}
      onPointerUpCapture={pointer.onPointerUpCapture}
      onPointerCancelCapture={pointer.onPointerCancelCapture}
      onContextMenuCapture={pointer.onContextMenuCapture}
    >
      <ListPane
        title={t("title")}
        scrollerRef={listScrollerRef}
        /* "0 unread" is a claim about the mailbox, not a description of the list — and its
           predecessor ("0 unread of 0 messages") was on screen beside "Nothing in your Ohbox."
           over an account that was not empty, for as long as the first drain took. While the
           mirror has not been read there is no count to state, so none is stated: no dash, no
           zero, no substitute — a wrong count is a lie. Any NON-zero total is a real
           observation whatever the drain is doing, so only the empty case is withheld. */

        /* The form is short, and the noun is the point — "{count} unread". This said
           "{count} new" for two releases to match the Reads header; Reads and Receipts count
           the WATERLINE and now say so in full ("12 new since you were here" — `stream.newSince`)
           while THIS number is `unreadIds.length`, the mailbox's own `\Seen` — one word for two
           facts on two adjacent piles is the confusion that change ended, so the noun is here
           rather than only in the rail tooltip. What wrapped the header to three lines was the
           TAIL, not the noun: "of N messages" cost the room, "12 unread" is three characters
           longer than "12 new", and `.vhead .meta` yields before the action does — measured,
           not argued: `scripts/fit-render.mjs` reads this header at 360 and 390 on both faces
           in both languages for self-overflow AND for title, count and action on ONE line. */
        /* Rows on screen while the count may not be stated yet: it says it is counting, never 0 and never nothing. */
        meta={countWhen(listInput, t("meta", { count: unreadIds.length })) ?? (all.length > 0 ? t("metaCounting") : undefined)}
        action={
          onMarkAllRead ? (
            <MarkAllRead
              unreadCount={unreadIds.length}
              onMarkAllRead={() => onMarkAllRead(unreadIds)}
            />
          ) : null
        }
        header={
          <>
            {/* The shell's quiet notice, above everything the header offers: it is ambient
                state, not an affordance, so it must not displace the doorbell's claim or
                scroll away with the rows. See the `noticeSection` prop. */}
            {noticeSection}
            {/* "All clear" is the doorbell's `=0` arm, and it is the same claim in smaller
                type: nobody is waiting at the gate. Before the mirror has been read nobody is
                KNOWN to be waiting, which is a different sentence. The doorbell is withheld
                entirely rather than reworded — it is an affordance for senders who are
                waiting, and there is nothing yet to open it for. It returns with the count. */}
            {/* NOTHING ORGANIZES ANY OF THESE MAILBOXES YET: "All clear" would claim the gate is kept. The same
                slot stands DRAWN, says what is true, and its press opens the organize decision — read off the mailbox
                facts, so it does not wait for the mirror. */}
            {notOrganizingYet && !notOrganizingYet.every && doorbellCount === 0 && notOrganizingYet.mailboxes[0] ? (
            /* A MIXED ACCOUNT: nobody waits for the mailboxes something organizes, and the one nothing
               organizes is named rather than covered by "All clear". Its press is that mailbox's. */
            <Doorbell
              initials={[]}
              hues={[]}
              message={t.rich("doorbellNotOrganizingSome", {
                count: notOrganizingYet.mailboxes.length,
                address: displayAddress(notOrganizingYet.mailboxes[0].address),
                b: (chunks) => <b>{chunks}</b>,
              })}
              actionLabel={(notOrganizingYet.mailboxes[0].why ?? "never_agreed") === "never_agreed"
                ? t("doorbellNotYetAction") : t("doorbellNotOrganizingAction")}
              ariaLabel={t("doorbellNotOrganizingSomeAria", {
                count: notOrganizingYet.mailboxes.length,
                address: displayAddress(notOrganizingYet.mailboxes[0].address),
              })}
              onPress={() => ((notOrganizingYet.mailboxes[0]!.why ?? "never_agreed") === "never_agreed"
                ? goFirstRun({ rerun: true, mailboxId: notOrganizingYet.mailboxes[0]!.id })
                : goSettings("mailboxes"))}
            />
            ) : notOrganizingYet?.every && notOrganizingYet.mailboxes[0] ? (
            /* EVERY MAILBOX, WHATEVER THE COUNT: senders waiting from before have a Screener whose
               decisions nothing carries out, so "N waiting · Screener" would cover strangers that go
               straight to the Ohbox. The rail still counts them. */
            sharedNotOrganizedWhy(notOrganizingYet) === "never_agreed" ? (
            <Doorbell
              initials={[]}
              hues={[]}
              message={t.rich("doorbellNotYet", { b: (chunks) => <b>{chunks}</b> })}
              actionLabel={t("doorbellNotYetAction")}
              ariaLabel={t("doorbellNotYetAria")}
              onPress={() => goFirstRun({ rerun: true, mailboxId: notOrganizingYet.mailboxes[0]!.id })}
            />
            ) : (
            /* HANDED BACK, OR ITS HOLDER STOPPED: a standing state, never "All clear". The press is
               Organize here, which lives in Mailboxes; consent was already given. */
            <Doorbell
              initials={[]}
              hues={[]}
              message={t.rich(sharedNotOrganizedWhy(notOrganizingYet) === "handed_back"
                ? "doorbellHandedBack" : "doorbellNotOrganizing", { b: (chunks) => <b>{chunks}</b> })}
              actionLabel={t("doorbellNotOrganizingAction")}
              ariaLabel={t(sharedNotOrganizedWhy(notOrganizingYet) === "handed_back"
                ? "doorbellHandedBackAria" : "doorbellNotOrganizingAria")}
              onPress={() => goSettings("mailboxes")}
            />
            )
            ) : (!mayState || !doorbellSettled) && doorbellCount === 0 ? null : (
            <Doorbell
              initials={doorbellInitials}
              hues={doorbellHues}
              gone={doorbellCount === 0}
              message={
                <DoorbellMessage count={doorbellCount} />
              }
              actionLabel={t("doorbellAction")}
              ariaLabel={t("doorbellAria", { count: doorbellCount })}
              onPress={onDoorbell}
            />
            )}
          </>
        }
        /* The strip used to spell the whole keymap out ("j k move · ↵ read · t tag …") and,
           being clamped to one line, CLIPPED mid-word whenever this pane shared the window
           with the reading column. One affordance now — the key that opens the generated
           sheet. The bindings themselves are unchanged, declared in `keys` above. */
        hints={<ShortcutHint />}
        /**
         * THE SELECTION'S VERBS, AT THE FOOT — and they TAKE the hints strip's place rather than standing beside it
         * (`ListPane`'s `foot`). It used to be a wash in the HEADER slot above, which was itself a fix for a worse
         * bug: as the scroller's first child, the count scrolled off the moment you picked something forty rows down.
         * The header answered that and cost 105–142px of the list, above the rows it was talking about, in a control
         * shape nothing else in the product uses. The foot answers it too — the strip is outside the scroller either
         * way — and it is where this product puts the verbs for the thing you are looking at. The count is IN the
         * pill now, so there is no separate `role="status"` wrapper here: the capsule carries it (see `rowGroups`),
         * which is also what makes pressing it the way out.
         */
        foot={
          picked.size > 0 ? (
            <SelectionPill
              ids={pickedIds}
              count={pickedIds.length}
              rows={pickedRowCount}
              panel={pickPanel}
              onPanel={setPickPanel}
              onRun={runBulk}
              onMarkSeen={markPicked}
              onDelete={deletePicked}
              bulk={bulk}
              onDone={clearPicked}
              onClear={clearPicked}
            />
          ) : null
        }
      >
        {/* THE STANDING NOTICE IS THE SCROLLER'S FIRST CHILD — see the prop. Nothing may be
            rendered above it here: `banner.css` pins it with `position: sticky` at the top of
            THIS scroller, and a sibling above it would be what the banner sticks under. */}
        {standingNotice}
        {/* TWO listboxes, not one: "New" and "Earlier" are separated by a group label, and
            an option's listbox has to be its actual container. Each is labelled, because an
            unnamed pair of listboxes is worse than none.

            AND A HEADING OVER NOTHING IS A HEADING THAT LIES. Both pairs rendered
            unconditionally, so an empty Ohbox — which is what a real account looks like for
            the whole of its first sync — was two bare words, "New" and "Earlier", with no rows
            under either and (see `SyncState`) nothing else on the pane at all. A section label
            asserts that a section follows. It also left two empty `role="listbox"` regions for
            a screen reader to land in and find nothing. */}
        {/* THE WINDOW, ACROSS TWO GROUPS. Reserved height above, then each group's share of the
            mounted slice inside its own listbox, then reserved height below. A group whose rows
            are entirely outside the window renders neither its label nor an empty listbox — the
            heading-over-nothing rule, kept as the window slides. Each row states its group's true
            size and its place in it (`inSet`), because the listbox holds only the mounted share. */}
        {/* Resurfaced — pinned at the very top under its own quiet label, whole and outside the
            window (a scheduled set is small): not "this arrived" but "you asked to see this
            again now", so it earns its own heading. Every row here is drawn unread whatever its
            stored flag says (owner ruling 2026-08-31 — `presentsUnread`). A DELIBERATE read
            clears the pin server-side (`MessageService.markSeen` without the glance label) and
            the row slides to "Earlier" — once the selector actually files it there, why the slide
            keys on section membership rather than the read flag (see `earlierIds`). A GLANCE —
            the thread-read rule's — records the reading and spends no pin, so the row does not
            move or change. Each row carries "Done" — see `doneFor`. */}
        {groupedResurfaced.length > 0 ? (
          <>
            <ListGroupLabel>{t("resurfacedGroup")}</ListGroupLabel>
            <ListRows multiSelectable ariaLabel={t("resurfacedGroup")}>
              {groupedResurfaced.map((g) => groupRow(g, undefined, doneForRow(g)))}
            </ListRows>
          </>
        ) : null}
        <div aria-hidden data-window-top="" style={{ height: win.padTop }} />
        {/* `group`: the landing demo's callout anchors — see ListGroupLabel */}
        {showNewLabel ? <ListGroupLabel group="new" index={0}>{t("newForYou")}</ListGroupLabel> : null}
        {newTo > newFrom ? (
          <ListRows multiSelectable ariaLabel={t("newForYou")}>
            {groupedNew.slice(newFrom, newTo).map((g, k) =>
              groupRow(g, newBase + newFrom + k, undefined, { size: newCount, position: newFrom + k + 1 }))}
          </ListRows>
        ) : null}
        {showPrevLabel ? (
          <ListGroupLabel group="earlier" index={prevLabelAt}>{t("previouslySeen")}</ListGroupLabel>
        ) : null}
        {prevTo > prevFrom ? (
          <ListRows multiSelectable ariaLabel={t("previouslySeen")}>
            {groupedPrev.slice(prevFrom, prevTo).map((g, k) =>
              groupRow(g, prevBase + prevFrom + k, undefined, { size: prevCount, position: prevFrom + k + 1 }))}
          </ListRows>
        ) : null}
        {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
        {/* the account's own sent mail rides "Earlier" now, but only the most recent slice of
            it (the `DEFAULT_SENT_HISTORY_MESSAGES` ingest window). Say so rather than let the list
            imply it holds every message ever sent — older sent mail is on the server, reachable
            through Search. Shown only when sent mail is actually present in the window below. */}
        {hasOwnSent ? <div className="tail-row">{t("sentNote")}</div> : null}
        {/* The view's own fact — this list is empty — combined with a state derived once, up
            in the shell. `doorbellCount` is the Screener's waiting count, already a prop. */}
        {all.length === 0 ? <SyncState waiting={doorbellCount} surface={surface} setupHref={setupHref} /> : null}
        {/* MAIL FROM BEYOND WHAT THIS DEVICE KEPT.

            Rendered BELOW the local window and under its own group label, because that is what
            it is: rows that came from the server a moment ago and are not in the mirror. They
            are not merged into "Earlier" — a reader who scrolls past the label has been told
            where the boundary is, and a list that hid it would be claiming the device holds
            more than it does.

            They carry the mirror's own row wherever it has one (see `older-mail.ts`), so a
            message somebody files here behaves exactly like one above the line. */}
        {/* `olderShown`, never `older.items`: a fetched row this list already renders above is
            not listed a second time (the shell's verdicts keep the store's copies out; this is
            the view's own belt over what it rendered). */}
        {olderRows.length > 0 ? (
          <>
            <ListGroupLabel>{t("olderTitle")}</ListGroupLabel>
            <ListRows multiSelectable ariaLabel={t("olderTitle")}>{olderRows.map((g) => groupRow(g))}</ListRows>
          </>
        ) : null}
        {/* The tail says three true things by client. The demo keeps its own sentence (no
            server behind Mila's fixtures); a client whose list ends where its mail ends gets
            nothing (`older.available === false`, read from the ENGINE, never guessed from the
            mode — which is why the desktop needed no change here when its mirror became a
            window); a windowed client gets the control and a sentence once shipped
            unconditionally when it was FALSE. Every message is
            a real row — never an "N more" count. `settled` gates the windowed arm: "this device
            keeps your recent mail" has no referent before the first drain (reported on first
            open, for up to a minute), and `olderAction` was a wrong INSTRUCTION, pointing
            backwards past mail still in flight. The cost — a returning tab loses the tail for
            one drain — is cheap: `SyncBar` narrates, and both return with the drained mirror. */}
        {demo ? <div className="tail-row">{t("tail")}</div> : null}
        {!demo && older.available && !older.pending && mayState ? (
          <div className="tail-row" role="status">
            {older.error !== null ? (
              <>
                {t("olderFailed", { reason: older.error })}{" "}
                <button type="button" className="btn ghost" onClick={older.loadMore}>
                  {t("olderRetry")}
                </button>
              </>
            ) : older.loading ? (
              <span className="mbx-wait">
                <Spinner className="mbx-spin" />
                {t("olderLoading")}
              </span>
            ) : (
              <>
                {/* THE HONEST COVERAGE LINE. Three states, and the one that must never be
                    guessed is `exhausted`: "That is everything on your server" is a claim about
                    somebody's whole mailbox, and it is said only because the server answered a
                    page with no cursor after it. An empty page, a refusal and a network failure
                    are all different, and none of them says this. */}
                {olderShown.length > 0 ? <>{t("olderShowing", { count: olderShown.length })}{" "}</> : null}
                {older.exhausted ? (
                  t("olderEnd")
                ) : (
                  <button type="button" className="btn ghost" onClick={older.loadMore}>
                    {t("olderAction")}
                  </button>
                )}
              </>
            )}
          </div>
        ) : null}
      </ListPane>
      {/* NO `onEnterReader` ON THE PANE. `ReadingPane` renders a small
          "Open reading mode" button when it is given one, and this column is the ONE place
          that passed it. Below 700px the column is `display:none`, so that button was
          reachable at exactly the widths where the sheet duplicates the pane it is standing
          on — a control whose only outcome was the defect. The reader is not lost: it is
          what "opened" means where there is no column, which is the shell's `enterReader`.
          THE ✕ is the column's way out under a thumb in the two-pane band (700–1023, no Esc):
          it clears the selection, which is what Esc does at 1024; the stylesheet shows it
          only there. Only while something is open — an empty column has nothing to close. */}
      <ReadColumn
        scrollerRef={readColRef}
        regionLabel={tReader("pane")}
        onClose={selected || gone ? () => onSelect(null) : undefined}
        closeLabel={tReader("closeColumn")}
      >
        {selected ? (
          <MessagePane
            /* The pane derives its read-state verb from `message.unread`, so the open message
               travels with its PRESENTED state: a RESURFACED row offers "Mark as read" whatever
               its stored flag says, because that is what the row beside it is drawing. Pressing
               it is a deliberate read, which spends the pin and releases the row — one of the
               three ways out, beside Done and Send + Done. The shell does the same for the sheet. */
            message={presentsUnread(selected) === selected.unread ? selected : { ...selected, unread: presentsUnread(selected) }}
            tags={tags}
            now={now}
            onAction={(a) => {
              /* The pane's read-state buttons press `u`/`⇧I` and fall back to `onAction("unread")`
                 — a FLIP — only where no keymap answers. A flip resolved ABOVE this view would
                 skip the keep/return/hold machinery. So the fallback is routed
                 through the same two directions the keys take; everything else passes through. */
              if (a === "unread") {
                if (readSet.length > 0) markConversationRead(selected);
                else markUnread(selected);
                return;
              }
              onAction(a, selected);
            }}
            onAddTag={onAddTag}
            readSet={readSet}
            scroller={readColRef}
            threadRead={wiring ?? undefined}
          />
        ) : gone ? (
          /* BEFORE the resting panel, and that order is the whole arm: "nothing open" and "the
             message you had open has been removed elsewhere" were one state, and the second one
             is the one that reads as lost mail. */
          <MessageGone openTrash={gone.openTrash} />
        ) : all.length > 0 ? (
          /**
           * The resting column — what the reading column says when nothing is open, which since the two fallbacks
           * were deleted is what it says on arrival. A blank panel reads as a pane that failed to load; this one
           * names the state and says how to leave it, in the `.empty` shape every other pile's empty state uses
           * (glyph, title, one line). Nothing more: no unread count (the list header beside it states one, and a
           * number restated two panels apart eventually disagrees with itself); no second key legend (the `?` sheet
           * is the one list of bindings, and the pane foot carries the affordance that opens it — one `<kbd>j</kbd>`
           * in the sentence is a pointer, not a copy of the map); no `role="status"` (this is what the region
           * contains at rest, and a live region would read out a panel the reader is not in on every `j`).
           */

          /**
           * And only when there are rows: an empty Ohbox already says it is empty in the list — the Screener's
           * show-once rule — so with no rows the column stays empty. Mobile needs no arm: `app.css` hides this column
           * under 700px, where a tap IS the open.
           */
          <div className="empty">
            <span className="glyph" aria-hidden="true">✉</span>
            <b>{t("emptyRestTitle")}</b>
            {/* Two sentences, one painted: the keycap names `j`, which a coarse-pointer device
                does not have, so `app.css` swaps in the touch twin under `(pointer: coarse)`. */}
            <span className="empty-hint-keys">
              {t.rich("emptyRestHint", { kbd: (chunks) => <Kbd>{chunks}</Kbd> })}
            </span>
            <span className="empty-hint-touch">{t("emptyRestHintTouch")}</span>
          </div>
        ) : null}
      </ReadColumn>
    </section>
  );
}

/**
 * The selection's action bar — which IS the message's action bar. The requirement — a selection must offer more than
 * read, unread and Escape — was first answered with a STRIP: an accent-soft wash in the list head with its own
 * classes and none of the pill's behaviour. That was a THIRD control shape for one job (beside the Screener's pile
 * capsules and the message pill), with its own container rungs derived from label widths in one reference font,
 * English only — it overflowed its box in German by 20px at 390 and 23px at 1440, More chevron cut off, and wrapped
 * to three lines, 142px tall on a phone. So the selection's verbs ARE the message pill now: the same element,
 * `.msg-actions > .abar`, same float, `--lift-3`, grouping, `bar-density` measurement and `MoreMenu` — every rule in
 * `action-bar.css` applies with no branch, and the two mounts cannot drift because there is nothing to drift.
 */

/**
 * Where it stands: the FOOT of the list column (`ListPane`'s `foot` slot), taking the key-hint strip's place while a
 * selection exists — the verbs on the thing you are looking at stand at its foot everywhere else in this product, and
 * on a phone the foot is where the thumb is; on a 1440 split its bottom edge and the reading pill's sit on one line
 * (both 12px off their panel's floor). Not sticky inside the scroller, which was measured: a pill stuck there lands
 * at y 787–798 and the toast band is y 790–828, so a refusal toast raised by the pill's own verb covered its
 * Read/Unread pair.
 */

/**
 * Two deliberate divergences from a message's bar: no Reply, Reply all or Forward — there is no such act over eleven
 * messages, and a pick of ONE is still a pick (the cursor's message keeps those verbs in the reading column); and the
 * leading slot holds the COUNT, where a message holds Reply — pressing it clears the selection (see `rowGroups`).
 */

/**
 * Screening still gets a ceremony the others do not. Everything else here is a mail operation on the messages you
 * picked; screening is a decision about SENDERS — for a sender still at the gate it promotes a rule governing all
 * their future mail and moves every message that sender has in the mirror, not only the selection. So it is two
 * steps: pick a destination, then a row stating the senders, messages and rules before anything is dispatched. There
 * is no undo, and that is why the confirm row exists — `POST /screener/:id` has no inverse, so an Undo would either
 * do nothing or move the mail back while the rule it created stood. Delete is the opposite case and gets the opposite
 * ceremony: reversible for as long as the toast is up (`delete-undo.ts` holds the request rather than sending it), so
 * the ask is cheap and the Undo is real.
 */
function SelectionPill({
  ids,
  count,
  rows,
  panel,
  onPanel,
  onRun,
  onMarkSeen,
  onDelete,
  bulk,
  onDone,
  onClear,
}: {
  ids: string[];
  /** The number of MESSAGES picked — `ids.length`, passed so the caller owns the sentence. */
  count: number;
  /** The ROWS picked: a folded conversation is one, as the person picked it. */
  rows: number;
  panel: PickPanel | null;
  onPanel: (next: PickPanel | null) => void;
  onRun: (action: BulkAction) => void;
  /** Mark-read keeps its own path: ⇧U's handler, so the bar and the key are one call. */
  onMarkSeen: () => void;
  /** The delete press — the window's, never a mutation. Asked for before it is called. */
  onDelete: () => void;
  bulk: BulkVerbs;
  onDone: () => void;
  onClear: () => void;
}) {
  const t = useTranslations("ohbox");
  const tr = useTranslations("screening");
  const density = useBarDensity();
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const deleteNoteId = useId();

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    moreRef.current?.focus();
  }, []);

  /* THE ASK'S SAFE ANSWER TAKES FOCUS, exactly as the message strip's does: the menu item
     that opened this unmounts with the menu, so without the move a keyboard user's focus
     falls to the document and the destructive question is never reliably announced. */
  useEffect(() => {
    if (panel?.kind === "delete") deleteCancelRef.current?.focus();
  }, [panel?.kind]);

  /* A SELECTION THAT EMPTIES TAKES ITS MENU WITH IT. The pill unmounts at zero, but the menu
     is also open across a panel cycle, and a menu left open over a bar that has changed shape
     is a menu pointing at buttons that moved. */
  useEffect(() => {
    if (panel !== null) setMenuOpen(false);
  }, [panel]);

  const defer = (
    <>
      <button type="button" className="abar-b abar-v abar-later" onClick={() => onRun("later")}>
        {t("actionLater")}
        <Key chord="a" />
      </button>
      <button type="button" className="abar-b abar-v abar-aside" onClick={() => onRun("aside")}>
        {t("actionSetAside")}
        <Key chord="e" />
      </button>
      <button type="button" className="abar-b abar-v abar-resurface" onClick={() => onRun("resurface")}>
        {t("actionResurface")}
        <Key chord="b" />
      </button>
    </>
  );

  const file = (
    <>
      <button type="button" className="abar-b abar-v abar-screen" onClick={() => onPanel({ kind: "screen" })}>
        {tr("action")}
        <Key chord="s" />
      </button>
      <button type="button" className="abar-b abar-v abar-move" onClick={() => onPanel({ kind: "move" })}>
        {t("actionMove")}
        <Key chord="m" />
      </button>
    </>
  );

  /* Tag DISPATCHES THROUGH A POPOVER, so it needs the element that was pressed as its anchor —
     which is why it is a function of its own class rather than a shared element: the measure
     row's copy must not become the anchor (React binds a ref to the LAST claimant, and the
     copy mounts after the visible row). Anchoring on `currentTarget` avoids the ref entirely. */
  const tagButton = (
    <button
      type="button"
      className="abar-b abar-solo"
      onClick={(e) => {
        bulk.tag(ids, (e.currentTarget as HTMLElement | null) ?? null);
        onDone();
      }}
    >
      {t("tagChip")}
      <Key chord="t" />
    </button>
  );

  if (panel?.kind === "move" || panel?.kind === "screen") {
    const screening = panel.kind === "screen";
    return (
      <div className="msg-actions">
        <div className="abar">
          <div className="abar-panel">
            <span className="abar-lab">{screening ? tr("bulkTo") : t("moveLabel")}</span>
            {MOVE_TARGETS.map((v) => (
              <button
                key={v}
                type="button"
                className="abar-b abar-solo"
                onClick={() =>
                  screening ? onPanel({ kind: "confirm", dest: v }) : onRun(`move:${v}`)
                }
              >
                → {PLACE_LABEL[v] ?? v}
              </button>
            ))}
            <button type="button" className="abar-b" onClick={() => onPanel(null)}>
              {t("moveCancel")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (panel?.kind === "confirm") {
    /**
     * THE LAST MOMENT BEFORE CONSENT, and it states what will PERSIST separately from what
     * will move. The counts come from the same `planScreeningChange` that will run — not
     * from `ids.length`, which is a different and smaller number whenever a picked sender
     * has other mail in the mirror. Reporting the selection size here would be a
     * confirmation of something other than what happens.
     */
    const plan = bulk.screenPreview(ids, panel.dest);
    const place = PLACE_LABEL[panel.dest] ?? panel.dest;
    return (
      <div className="msg-actions">
        <div className="abar">
          <div className="abar-panel">
            <span className="abar-lab">
              {plan.senders === 0
                ? /* Nothing to confirm, said as itself. "0 senders → Ohbox. 0 messages move."
                     is a confirmation of nothing, and a user reading it would reasonably press
                     the button to find out what it meant. */
                  tr("bulkConfirmNothing", { place })
                : plan.rules > 0
                  ? tr("bulkConfirmRules", {
                      place,
                      senders: plan.senders,
                      count: plan.messages,
                      rules: plan.rules,
                    })
                  : tr("bulkConfirm", { place, senders: plan.senders, count: plan.messages })}
            </span>
            <button
              type="button"
              className="abar-b abar-solo primary"
              disabled={plan.senders === 0}
              onClick={() => {
                /* A REFUSED SCREENING KEEPS THE SELECTION — `onBulkScreen` answers a reader at
                   the press and returns false, and `onDone` here would throw away a set the
                   person still has a use for. The panel closes either way: the question has
                   been answered, one way or the other. */
                if (bulk.screen(ids, panel.dest)) onDone();
                else onPanel(null);
              }}
            >
              {tr("bulkCommit")}
            </button>
            <button type="button" className="abar-b" onClick={() => onPanel({ kind: "screen" })}>
              {t("moveCancel")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (panel?.kind === "delete") {
    /**
     * THE ASK, AND IT IS THE MESSAGE STRIP'S ASK — same panel, same `alertdialog`, same note, same pair of answers.
     * What differs is one number: the sentence counts the selection. WHY THERE IS AN ASK HERE AT ALL when `⌫`/`⌦`
     * have none: item 10's own distinction, one verb wider. A key held down over a list is a gesture that can run
     * away, so the keys open the window directly and the toast's Undo is the protection; a BUTTON labelled Delete,
     * and the `d` that names it, are aimed presses over a set somebody built — cheap to ask, and the ask is the last
     * place the count is stated before the rows go. `deleteNote` is reused WORD FOR WORD from the single-message
     * ceremony (a parity test on the mobile side pins it): what happens to the mail does not change with the count.
     */
    return (
      <div className="msg-actions">
        <div className="abar">
          <div
            className="abar-panel abar-delete"
            role="alertdialog"
            aria-label={t("bulkDeleteAsk", { count })}
            aria-describedby={deleteNoteId}
          >
            <span className="abar-lab">{t("bulkDeleteAsk", { count })}</span>
            <span className="abar-note" id={deleteNoteId}>{t("deleteNote")}</span>
            <button
              type="button"
              className="abar-b abar-solo abar-danger"
              onClick={() => {
                onPanel(null);
                onDelete();
              }}
            >
              {t("actionDelete")}
              <Key chord="Backspace" />
            </button>
            <button
              type="button"
              className="abar-b"
              ref={deleteCancelRef}
              onClick={() => onPanel(null)}
            >
              {t("moveCancel")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  /**
   * WHAT IS BEHIND "MORE" — the same verbs, in the same order they stand in the row, plus the
   * one that has no row position at all.
   *
   * `group` is what keeps "a verb is in the row or in the menu, never both": the admission
   * rules at the foot of `action-bar.css` switch each group off HERE at exactly the width they
   * switch it on THERE. One set of numbers, read from both sides — and for this pill they are
   * not numbers at all but the measurement, which is the point of retiring the old strip.
   */
  const menuItems: MoreMenuItem[] = [
    { id: "later", group: "later", label: t("actionLater"), run: () => { closeMenu(); onRun("later"); } },
    { id: "aside", group: "aside", label: t("actionSetAside"), run: () => { closeMenu(); onRun("aside"); } },
    { id: "resurface", group: "resurface", label: t("actionResurface"), run: () => { closeMenu(); onRun("resurface"); } },
    {
      id: "tag",
      group: "tag",
      label: t("actionTag"),
      icon: <Icon name="tag" size={13} />,
      /* Anchored on More, like Screening: the picker opens where the press was rather than
         under a menu that has just closed. */
      run: () => { const at = moreRef.current; setMenuOpen(false); bulk.tag(ids, at); onDone(); },
    },
    { id: "screen", group: "screen", label: tr("action"), run: () => { setMenuOpen(false); onPanel({ kind: "screen" }); } },
    { id: "move", group: "move", label: t("actionMove"), run: () => { closeMenu(); onPanel({ kind: "move" }); } },
    /**
     * DELETE — last, menu-only, and carrying NO `group`, like Draft reply on a message: it has
     * no row position, so no admission rule can surface it as a row button. A destructive verb
     * over a set does not belong where a stray click can land. It opens the ASK; the ask is the
     * only thing that presses the window.
     */
    {
      id: "delete",
      label: t("actionDelete"),
      icon: <Icon name="trash" size={13} />,
      run: () => { closeMenu(); onPanel({ kind: "delete" }); },
    },
  ];

  /* ONE row, rendered twice — visibly, and as the density measurement's hidden copy. A
     FUNCTION rather than a shared element so the copy can drop what must not be duplicated:
     `moreRef` stays on the VISIBLE More button only. */
  const rowGroups = (measure: boolean) => (
    <>
      {/* THE COUNT IS THE LEADING CAPSULE, AND IT IS THE WAY OUT.
          One control, not two: a separate "Clear" verb would be a second exit for one act, and
          "Auswahl aufheben" beside a count is 110px of German for something the count itself
          can say. It stands where Reply stands on a message — the leading slot — and wears the
          picked rows' own accent pair, so the capsule and the rows are visibly one object.

          `role="status"` on the number so a change in the count is ANNOUNCED and not merely
          present, which is what the retired strip's own `role="status"` did for the whole bar.
          The `aria-label` carries the count AND what pressing it does, so the button's name is
          never just "×" — including in compact, where the word is what folds. */}
      <div className="abar-g">
        <button
          type="button"
          className="abar-b abar-solo abar-count"
          aria-label={t("pickedAria", { count: rows })}
          onClick={onClear}
        >
          <span aria-hidden="true">×</span>
          <span role="status">{rows}</span>
          <span className="abar-count-word">{t("pickedWord")}</span>
          <Kbd>esc</Kbd>
        </button>
      </div>

      <div className="abar-g abar-seg abar-defer" role="group" aria-label={t("groupDefer")}>
        {defer}
      </div>

      {/* Between the horizons and filing, mirroring the message pill: a reader who has seen Tag
          there on a wide bar looks for it there on a narrow one. */}
      <div className="abar-g abar-v abar-tag">{tagButton}</div>

      <div className="abar-g abar-seg abar-file" role="group" aria-label={t("groupFile")}>
        {file}
      </div>

      <div className="abar-g abar-read-g">
        {/*
            Two directions, never a toggle — `BulkAction`'s own rule, and the reason is the set: `role="switch"`
            reports a current state and a selection has a MIXED one, so a toggle would mark six read and five unread
            in a gesture that reads as one decision. The dots are the message pill's and mean the same thing: the dot
            previews what the press LEAVES BEHIND — hollow on Read, filled on Unread, the same mark the list row uses,
            so "there is a dot" says one thing everywhere. Neither label folds: these carry no `.abar-read-lab`,
            deliberately — the compact floor drops one word, and dropping these two would leave bare dots saying
            nothing about direction; "Read" and "Unread" are already the shortest labels on the row, and it is the
            COUNT's word that folds (`bar-density.ts`).
          */}
        <span className="abar-g abar-seg" role="group" aria-label={t("groupRead")}>
          <button type="button" className="abar-b" onClick={onMarkSeen}>
            <span className="abar-dot abar-dot-off" aria-hidden="true" />
            {t("actionRead")}
            <Key chord="shift+u" />
          </button>
          <button type="button" className="abar-b" onClick={() => onRun("unread")}>
            <span className="abar-dot" aria-hidden="true" />
            {t("pickedMarkUnseen")}
            <Key chord="u" />
          </button>
        </span>

        <button
          ref={measure ? undefined : moreRef}
          type="button"
          className="abar-b abar-solo abar-more"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t("actionMore")}
          title={t("actionMore")}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Icon name="chev" size={12} className="abar-chev" />
        </button>
      </div>
    </>
  );

  /* `.msg-actions` IS THE CONTAINER THE MEASUREMENT RESOLVES AGAINST, and wearing it is the
     whole of how this bar became the message pill: every rule in `action-bar.css` that dresses
     a pill, folds a group or compacts the floor is written `.msg-actions …`, and none of them
     needed a second selector for this mount. */
  return (
    <div className="msg-actions">
      <div className="abar" data-admit={density.admit ?? undefined}>
        <div className="abar-row">{rowGroups(false)}</div>
        {density.armed ? (
          <div className="abar-row abar-measure" ref={density.measureRef}>
            {rowGroups(true)}
          </div>
        ) : null}
        {menuOpen ? (
          <MoreMenu
            items={menuItems}
            ariaLabel={t("actionMore")}
            anchor={moreRef.current}
            onClose={closeMenu}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Why an empty Ohbox is empty — the one answer that is this VIEW's to give. A live count used to sit here ("Syncing
 * your mailbox · 3 messages so far") gated on `SyncStatus.bootstrapping`, and that gate is the defect:
 * `bootstrapping` means "this TAB's first drain has not completed", which on a fresh account finishes in seconds
 * against an empty server-side mirror, while the WORKER's first import runs minutes to tens of minutes. The counter
 * switched itself off in seconds and the pane said nothing for the entire import. It MOVED, and moved UP: it is
 * `SyncBar`'s `importing` state now, keyed on the mirror actually growing (`shell/mail-state.ts`) and visible above
 * the deck in every pile — a view can only speak about itself, and "your mail is arriving" is not a fact about the
 * Ohbox.
 */

/**
 * What is left here: an empty Ohbox that is CORRECT. A fresh account is mostly Screener by design, so the true
 * sentence is "nothing has reached the Ohbox because every sender so far is new" — a statement about THIS list, which
 * no shell-level strip may make (above the deck it would tell somebody standing in the Screener that everything is in
 * the Screener). The split: `mail-state.ts` derives `screenerCandidate` once, for everybody; this pane contributes
 * the only fact it owns — its own list is empty — and renders. It does not re-derive: it reads {@link
 * MailState.settled}, derived from `bootstrapping` and the ladder's verdict up in `mail-state.ts`. Progress still
 * keys on the mirror growing and still lives in the strip; seconds is exactly the right length for the different
 * question asked here.
 */

/**
 * The third state this pane used to collapse: "empty" and "not looked yet" were one rendering,
 * so a slow connection showed "Nothing in your Ohbox." about mail the app had simply not read
 * yet. Before the mirror has been read there is no emptiness to report, so the pane reports
 * what is happening instead — after {@link LOADING_GRACE_MS}, so a fast connection keeps its
 * silent frame. It says the app is loading, never what it will find: a placeholder row, an
 * invented count or a skeleton shaped like mail would answer this defect by creating the one
 * this product treats as unforgivable.
 */

/**
 * The line that rule draws is about CONTENT, not shape: a bar as long as a real subject line is
 * a claim about that subject, a row carrying a name is a claim about a sender, an invented
 * count is the worst of the three — all forbidden. `BootSkeleton` below is on the other side by
 * construction: zero text nodes, `aria-hidden`, a fixed-width table derived from nothing, so
 * nothing in it can be mistaken for this mailbox. `test/boot-skeleton.test.tsx` holds that
 * boundary structurally. The demo and the Desktop never reach the `screenerCandidate` arms —
 * the derivation returns the resting value for a fixtures engine — and `settled` is true for
 * them for the same reason: a fixtures engine is permanently settled.
 */
function SyncState({ waiting, surface, setupHref }: { waiting: number; surface: ListSurface; setupHref: string }) {
  const t = useTranslations("ohbox");
  const { state, mailboxes } = useMailState();
  /* `skeleton` and `pending` are one rendering: a mirror nobody has read and a mirror the
     account's own facts say is still filling are both "not looked yet" to a reader, and the
     silhouette plus the grace sentence is the state this pane already had for the first. */
  const owedYet = !saysEmpty(surface);
  const speak = useLoadingGrace(owedYet);

  /* No mailbox, as `GET /mailboxes` answered it: the one thing to do, and where. */
  if (mailboxes !== null && mailboxes.length === 0) {
    return (
      <div className="empty empty-connect" role="status">
        <span className="glyph" aria-hidden="true">✉</span>
        <b>{t("connectTitle")}</b>
        {t("connectLead")}
        <a className="btn primary" href={setupHref}>{t("connectAction")}</a>
      </div>
    );
  }

  /* THE MIRROR HAS NOT BEEN READ, so this list is not empty — it is unknown. Above every arm
     below, because both of them state something about mail that has arrived. */
  if (owedYet) {
    return (
      <div className="empty" role="status" aria-busy="true">
        {/* `.mbx-wait` and not a bare span: `.mbx-spin` sizes itself with `width`/`height` and
            is a `<span>`, so it needs a flex parent or the border collapses to a dot. That
            pairing — spinner beside one muted line — is exactly what `.mbx-wait` already is
            (`app.css`, beside the Settings rows), and reusing it adds no CSS and inherits the
            `prefers-reduced-motion` answer the ring already has. Same reuse `SyncBar` makes,
            for the same reason and with the same note about the `mbx-` prefix. */}
        <span className="mbx-wait">
          <Spinner className="mbx-spin" />
          {speak ? <b>{t("loading")}</b> : null}
        </span>
        {/* The column's own geometry, under the sentence, on its own shorter grace — see the
            header above for why a contentless silhouette is not the placeholder this pane
            forbids. `rail` is deliberately off: in a browser tab the rail is real, populated and
            already on screen a few pixels to the left, and a second fake one beside it would be
            describing a layout the reader can see is not there. */}
        <BootSkeleton active={owedYet} />
      </div>
    );
  }

  /**
   * AND WHEN THERE IS NO EXPLANATION, SAY THE FACT ANYWAY: `screenerCandidate` is false for the whole of a first sync
   * — it requires mail to have landed and the mirror to have settled — so outside the demo this returned `null` for
   * the whole of the first import, which is the stretch that matters most, and the pane rendered NOTHING. Combined
   * with the group labels above, an empty Ohbox was literally the two words "New" and "Earlier" on an otherwise blank
   * column, which reads as a broken screen rather than an empty one. The sentence is bare on purpose. `SyncBar` is
   * directly above this pane and it is the one place allowed to say WHY the list is empty — it is the only surface
   * that has derived it, and it is already saying "Connected. The first sync has not finished yet." or "Not syncing —
   * …" or nothing at all.
   */

  /**
   * Repeating any of that here would reintroduce the same defect: a view speaking about something that is not a fact
   * about this view. What this pane owns is "this list is empty", which is true in every one of those states.
   */
  if (!state.screenerCandidate) {
    return (
      <div className="empty" role="status">
        <span className="glyph" aria-hidden="true">✉</span>
        <b>{t("emptyPlain")}</b>
      </div>
    );
  }
  return (
    <div className="empty" role="status">
      <span className="glyph" aria-hidden="true">{waiting > 0 ? "🕊" : "✉"}</span>
      {/* Two sentences, because two different things are true. Mail is held at the door and
          the door is one click away — or it arrived and was filed somewhere that is not here,
          and Search is how it is found. Neither claims the Ohbox is broken. */}
      <b>{waiting > 0 ? t("emptyScreenerTitle") : t("emptyFiledTitle")}</b>
      {waiting > 0
        ? t("emptyScreenerHint", { count: waiting })
        : t("emptyFiledHint", { count: state.count })}
    </div>
  );
}

function DoorbellMessage({ count }: { count: number }) {
  const t = useTranslations("ohbox");
  return (
    <>
      {t.rich("doorbell", {
        count,
        b: (chunks) => <b>{chunks}</b>,
      })}
    </>
  );
}
