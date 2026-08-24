"use client";

/**
 * Ohbox — the two-pane accepted-mail view: grouped list (New / Earlier)
 * against the engine's ohboxView selector, the Screener
 * doorbell, and the reading column. j/k moves, ↵ opens the reader,
 * t opens the tag picker, x picks, u toggles unread.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { isOwnSent, isResurfaced } from "@ohmail/client-engine";
import type { EngineMessage, TagDTO } from "@ohmail/client-engine";
import {
  Doorbell,
  Icon,
  Kbd,
  ListGroupLabel,
  ListPane,
  ListRows,
  MessageRow,
  ReadColumn,
} from "@ohmail/ui";
import { MarkAllRead } from "../components/MarkAllRead";
import { ShortcutHint } from "../shell/ShortcutHint";
import { groupSection, sendTimeOf, singletonGroup, type OhboxRowGroup } from "./ohbox-groups";
import { PLACE_LABEL, avatarOf, resurfaceLabel, rowAddress, rowStamp, senderName, sentAvatarOf, sentRowRecipient, tagsOfMessage, hueOf } from "../shell/format";
import { useKeyBindings, type KeyBinding } from "../shell/keymap";
import { useListWindow } from "../shell/list-window";
import { BootSkeleton } from "../shell/BootSkeleton";
import { useLoadingGrace } from "../shell/loading-grace";
import { useMailState } from "../shell/MailStateProvider";
import type { OlderMail } from "../shell/older-mail";
import { MessagePane, MOVE_TARGETS, type BulkAction, type MessageAction, type MoveTarget } from "../shell/MessagePane";
import { useDragToFile, type DragSource, type RailDropTarget } from "../shell/drag-file";
import type { ScreeningDest } from "../shell/sender-screening";
import "../shell/action-bar.css";

/**
 * What a selection can be asked to do.
 *
 * Four callbacks and not one, because they are not one kind of thing. `run` and `tag` are
 * ordinary, reversible mail operations; `screen` is a consent decision about SENDERS, and
 * `screenPreview` exists so the surface can state what will persist BEFORE committing it.
 * Sharing a bar is right; sharing commit semantics would be the design error.
 */
export interface BulkVerbs {
  run: (action: BulkAction, ids: string[]) => void;
  tag: (ids: string[], anchor: HTMLElement | null) => void;
  screenPreview: (
    ids: string[],
    dest: ScreeningDest,
  ) => { senders: number; messages: number; rules: number };
  screen: (ids: string[], dest: ScreeningDest) => void;
}

/** Which sub-row the bulk bar is showing; `null` is the resting bar. Mirrors `BarPanel`. */
type PickPanel =
  | { kind: "move" | "more" | "screen" }
  | { kind: "confirm"; dest: MoveTarget };

/**
 * How long a split-pane selection must survive before it counts as read.
 *
 * Two seconds is long enough that no j/k sweep reaches it (a sweep is tens of milliseconds per
 * row) and short enough that someone who stopped to read the pane has, by any reasonable
 * account, read it. It is a constant and not a setting: a knob here would be a knob about
 * whether the product tells the truth.
 */
const DWELL_MS = 2000;

/**
 * How long a row slides before it re-files under "Earlier".
 *
 * Long enough to read as a deliberate move rather than a jump, short enough that the row is gone
 * from "New for you" by the time attention returns to the list. It matches the `.row.settling`
 * transition in `row.css`; a device that prefers reduced motion gets no transition at all (the
 * rule is inside a `prefers-reduced-motion: no-preference` block) and the row simply moves on the
 * render this timer schedules.
 *
 * ONE CONSTANT FOR EVERY DEPARTURE FROM "NEW FOR YOU" — a reply that settled, a message read in
 * the app, a `\Seen` that arrived from another mail client. They are one gesture with three
 * causes, so they share one duration and one mechanism (see `slideOut`).
 */
const SETTLE_MS = 280;

/**
 * A reply that just landed, for the animate-to-Earlier gesture.
 *
 * The shell sets this from `onSendSettled` the moment a reply is delivered: `messageId` is the
 * message that was answered (the one that should slide from "New for you" down to "Earlier"), and
 * `at` is when it settled, so a consumer can key an animation and ignore a stale value on a later
 * render. Exported so the shell and the view name the same shape.
 *
 * WHAT THE VIEW DOES WITH IT IS NARROW: it marks the answered message read. The slide is not this
 * prop's — it belongs to `slideOut`, which moves ANY row the selector has re-filed under "Earlier",
 * whatever read it. Answering a message is one of the things that reads it, not a second gesture.
 */
export interface OhboxReplyDone {
  /** The answered message — the row that moves to Earlier. */
  messageId: string;
  /** ISO-8601 instant the reply settled. */
  at: string;
}

export function OhboxView({
  demo,
  replyDone,
  noticeSection,
  resurfaced = [],
  newForYou,
  previouslySeen,
  threadParticipants,
  threadSubject,
  absoluteTime,
  onToggleTime,
  tags,
  now,
  selectedId,
  onSelect,
  onEnterReader,
  onMarkSeen,
  onReadArmed,
  readerId,
  doorbellInitials,
  doorbellHues,
  doorbellCount,
  settled,
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
   * A QUIET LINE ABOVE THE LIST — the shell's channel for ambient state the Ohbox's owner
   * should see without being interrupted. Today that is the away responder's "replies are
   * going out for you" (`shell/AwayNotice.tsx`); the next quiet notice reuses this slot.
   *
   * A `ReactNode` SLOT and not a boolean per notice, deliberately: a boolean prop per notice
   * is how a view ends up with five, and this view's props are already twenty named things
   * about mail rows. The view draws what it is given and gates NOTHING — whether there is
   * anything to say, and on which install, is the shell's call, made where the server state
   * lives. Absent means absent: no placeholder, no reserved height.
   */
  noticeSection?: ReactNode;
  /** Fixture world or a real mailbox — decides the "older mail" tail. See its use below. */
  demo: boolean;
  /**
   * RESURFACED MAIL, PINNED ABOVE EVERYTHING — bubbled-up items the worker has flipped back
   * (see `bubbleUpPass`). Rendered in a group of its own under a quiet label, never folded into
   * "New for you". Optional and defaulted to `[]`: several tests mount this view without it.
   */
  resurfaced?: EngineMessage[];
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
  onSelect: (id: string) => void;
  /**
   * Open the reader ON A MESSAGE.
   *
   * It took no argument while the shell's reader was a boolean over `selectedOhbox`. It
   * takes one now because `open` below calls `onSelect` and this in the same tick, so the
   * shell's own selection has not re-rendered yet — a reader that read it would show the
   * previously selected message.
   */
  onEnterReader: (messageId: string) => void;
  /**
   * The shell's `mark_seen` mutation — the one read-state writer.
   *
   * `via` says whether the reader ASKED for this or the view decided for them; it travels
   * because a resurfaced pin is answered by being dealt with, and a dwell is not dealing with
   * anything. Only {@link commitPendingRead} claims `"glance"`. Omitting it means deliberate,
   * which is what every other caller here is.
   */
  onMarkSeen: (ids: string[], unread: boolean, via?: "glance") => void;
  /**
   * THE ARMED READ, REPORTED UPWARD — `id` while a message's read is armed but not yet written,
   * `null` the moment the debt is spent or torn up.
   *
   * An armed read PRESENTS as read (see {@link commitPendingRead} and `effUnread` below): the row
   * loses its dot and the read-state verb flips, while the write still waits for departure. This
   * view can only flip the surfaces it renders — and the mobile reader sheet is the SHELL's
   * `MessagePane`, mounted over `readerMessage` in `AppShell`, so the sheet's verb would go on
   * deriving from the not-yet-written store flag without this channel. The shell holds the id and
   * presents the sheet's message with the same effective state; it is a REPORT of view-local
   * fact, never a second writer of read-state. Optional: a harness mounted without it simply has
   * no sheet to inform.
   */
  onReadArmed?: (id: string | null) => void;
  /**
   * WHICH MESSAGE THE READER SHEET IS SHOWING, or `null` when it is closed.
   *
   * This view does not open the sheet and does not read it for anything it renders. It needs the
   * value for ONE reason: closing the sheet is one of the four ways of LEAVING a message, and
   * leaving is what commits reading (see the commit below). The sheet belongs to the shell, so
   * the only way for this view to notice it closing is to be told.
   *
   * REQUIRED, with no default, for the reason `settled` and `older` have none: the safe-looking
   * default is `null`, which reads as "the sheet is never open" — and a mobile reader would then
   * mark nothing read on close, silently, in exactly the surface where closing the sheet is the
   * only way to leave a message at all.
   */
  readerId: string | null;
  doorbellInitials: string[];
  /** Per-sender tint hues for the doorbell stack, index-aligned with `doorbellInitials`. */
  doorbellHues?: number[];
  doorbellCount: number;
  /**
   * MAY THIS VIEW STATE ITS EMPTINESS AS A FACT? Derived once in `shell/mail-state.ts` — see
   * {@link MailState.settled} there for the defect and the derivation.
   *
   * Three sentences on this pane are claims about the user's own mail rather than about the
   * list: the meta count, the doorbell's "All clear", and the empty pane. All three were
   * rendered before the first drain had finished, over a mailbox that was not empty.
   *
   * It arrives as a PROP and not from `useMailState()`, because this view is mounted with no
   * provider by `test/ohbox-read-state.test.ts` and that hook throws without one — deliberately.
   *
   * REQUIRED, with no default. A default would be `true` (nothing else is renderable), which is
   * exactly the silent-omission mode `sync-scheduler.ts` rejects for the wake signal: a caller
   * that forgets it gets the lying surface and no error anywhere. Required, the omission is a
   * type error at the one shipped call site and a visible difference in any harness.
   */
  settled: boolean;
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
   * WHAT LIES BEYOND THE END OF THIS DEVICE'S WINDOW, and how to reach it. See
   * `app/shell/older-mail.ts`.
   *
   * A PROP with no default, for the reason `settled` has none: the only safe default would be
   * "there is nothing older", which is the sentence a windowed client must never say by
   * accident. Required, and a caller that forgets it is a type error at the one shipped call
   * site rather than a list that quietly stops at ninety days.
   *
   * It arrives from the shell rather than from a hook called here because this view is mounted
   * with no engine at all by several tests, deliberately — the same seam every other engine
   * fact on this pane comes through.
   */
  older: OlderMail;
  /** Mark every unread Ohbox message read, chunked, via the shell. Optional: this view is
   * mounted without a shell in several tests, and a control with nothing behind it must not show. */
  onMarkAllRead?: (ids: string[]) => void;
}) {
  const t = useTranslations("ohbox");

  /**
   * ═══ SESSION-SCOPED PLACEMENT, AND THE SLIDE THAT ENDS IT ════════════════════════════
   *
   * Two refs, one per pinned upper group — resurfaced and New for you. Each is reconciled at
   * render: it keeps the ids it already held that are still in the Ohbox, then MERGES any that the
   * selector has newly placed in that group into the slot the selector's own order gives them
   * relative to the kept rows (see `reconcile`). Refs, and reconciled in render rather than an
   * effect, for the reason `allRef` below is: the value has to be right for the render that reads
   * it, not one render late.
   *
   * What the session order is FOR is the ordering: a row keeps the slot it was given rather than
   * being re-sorted every time the selector recomputes, and a live arrival INSERTS between the
   * kept rows without shuffling their order among themselves. For genuinely new mail — the common
   * arrival — that slot is the TOP, which is where new mail belongs. Appending is what shipped,
   * and it was a reported defect: every message that arrived by sync after mount filed at the
   * BOTTOM of "New for you", below mail that had been sitting on screen since the mount, for the
   * whole session. What the session order is NOT for is holding a message in "New for you" after
   * it has been read.
   *
   * ── A READ MESSAGE LEAVES "NEW FOR YOU" NOW, NOT ON THE NEXT RELOAD ──────────────────
   *
   * This reverses the earlier ruling, deliberately. That ruling deferred the forward move: a
   * message read this session kept its slot with its dot cleared, on the argument that "the reader
   * did not ask for the move". The cost of it is what shipped, and it is worse than the churn it
   * avoided — a mailbox read in the app looked exactly like a mailbox that had not been read.
   * "New for you" went on listing mail the reader had finished with, for the whole session, and the
   * only way to make the list agree with the reading was to reload the page. A section heading that
   * needs a page refresh to become true is not a stable list; it is a stale one.
   *
   * So: the moment the selector files a row under "Earlier" — because the reader read it here,
   * because a reply to it settled, or because a `\Seen` for it arrived from another mail client —
   * the row SLIDES down and re-files. `settling` carries the slide (280 ms, `SETTLE_MS`), and when
   * it ends `dismissed` drops the id from the session order so the next render draws it under
   * "Earlier". `slideOut` below owns all of it.
   *
   * THE ONE THING THAT DOES NOT MOVE IS THE MESSAGE BEING READ RIGHT NOW, and that is not an
   * exception bolted on here — it falls out of reading being committed on the way OUT (see
   * {@link commitPendingRead}). Nothing is written while the message is on screen, so there is
   * nothing for the selector to re-file and nothing to slide; the row moves when the reader leaves
   * it, which is the moment their attention is already somewhere else.
   *
   * ── THE REVERSE MOVE: `promoted` ─────────────────────────────────────────────────────
   *
   * `promoted` holds the ids the reader has explicitly put back to unread this session, and
   * `reconcile` enters each of them at the FRONT of the New order rather than at the slot the
   * date merge would give them. A message somebody marks unread is usually OLD, so its date slot
   * is the bottom of New — where the append used to put it too, and that was a reported defect:
   * the row a reader has just finished with sits at the TOP of "Earlier", so filing it by date
   * moved it exactly one position — past the "Earlier" label to the last slot of New, where it
   * looks like nothing happened. The top of New is also where the next thing the reader intends
   * to do with it is, and on a long list the bottom of New is off screen.
   *
   * IT WINS OVER A SLIDE THAT IS ALREADY RUNNING, which is why `promote` cancels the timer, clears
   * `settling` and clears `dismissed`: a message read a moment ago is on its way down, and the
   * reader has just said "no, this is unfinished". The later explicit act wins, and it wins
   * immediately rather than 280 ms later when a timer nobody can see fires.
   */
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [promoted, setPromoted] = useState<Set<string>>(() => new Set());
  const [settling, setSettling] = useState<Set<string>>(() => new Set());
  const resurfacedOrder = useRef<string[]>([]);
  const newOrder = useRef<string[]>([]);
  /** Slides in flight, id → timer handle. Cancelled by `promote` and by unmount. */
  const slideTimers = useRef<Map<string, number>>(new Map());

  /**
   * Record an explicit "this is unread again" for one or more ids — see `promoted` above.
   *
   * Four halves, and none of them is housekeeping. The id joins the promote set so the next
   * reconcile leads the New order with it; the slide timer is torn up and the `settling` class
   * comes off, so a row caught mid-descent stops where it is instead of finishing a move the
   * reader has just contradicted; and it leaves `dismissed` so a slide that already completed
   * cannot keep filtering it out of the order it is being promoted into.
   *
   * NOT PRUNED when a row leaves the Ohbox. The set is bounded by explicit user acts within one
   * session, and an id it still holds is inert the moment the row is in the New order (reconcile
   * only consults it for ids it is placing for the first time). A prune would be a second writer
   * of the same fact for no behaviour.
   */
  const promote = useCallback((ids: readonly string[]) => {
    for (const id of ids) {
      const timer = slideTimers.current.get(id);
      if (timer === undefined) continue;
      window.clearTimeout(timer);
      slideTimers.current.delete(id);
    }
    setSettling((prev) => {
      if (!ids.some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    setPromoted((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    setDismissed((prev) => {
      if (!ids.some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const ohboxAll = useMemo(
    () => [...resurfaced, ...newForYou, ...previouslySeen],
    [resurfaced, newForYou, previouslySeen],
  );
  const byId = useMemo(() => new Map(ohboxAll.map((m) => [m.id, m])), [ohboxAll]);

  /**
   * THE ROWS THE SELECTOR NOW FILES UNDER "EARLIER" — the predicate the whole slide turns on.
   *
   * Membership of `previouslySeen`, and not `m.unread === false`, because those two are not the
   * same question. A RESURFACED row that has been read is read and still belongs at the top of the
   * list: the worker's pin, not the read state, decides that group, and `ohboxView` keeps it out of
   * "Earlier" until the pin is cleared. Sliding on the read flag alone would drop such a row out of
   * its pinned group and into a section that does not contain it — a row that vanishes from the
   * list entirely until the server catches up.
   *
   * So the question asked here is the one the answer depends on: does the selector say this row's
   * place is now "Earlier"? Every cause is covered by construction — an in-app read, an answered
   * message, a `\Seen` adopted from another client — because all three reach this view as the same
   * re-partition.
   */
  const earlierIds = useMemo(() => new Set(previouslySeen.map((m) => m.id)), [previouslySeen]);

  /**
   * ── THE STABLE MERGE: WHERE A FRESH ID ENTERS THE SESSION ORDER ──────────────────────────
   *
   * A fresh id — one the session order is not already holding — inserts BEFORE the first kept
   * row the selector ranks after it, and at the end when there is none. For New, the selector's
   * order is date desc, so "ranks after" is "is older": a genuinely new arrival is newer than
   * everything on screen and enters at the TOP, which is the reported defect this replaces (the
   * append filed every post-mount arrival at the bottom). And it is a MERGE, not a re-sort, on
   * both sides: kept rows never move relative to each other — the list does not shuffle under
   * the reader — and fresh ids keep the selector's own order among themselves.
   *
   * THE HONEST HALF OF THE RULE IS THE OLD ARRIVAL. A sync can also deliver an OLD unread
   * message — a mirror backfill, or old mail marked unread on another client, which arrives as a
   * plain re-partition with no `promote` anywhere — and "new mail at the top" must not read as
   * "anything fresh at the top": its date slot is below everything newer, so it files there, and
   * only mail that genuinely just arrived leads the list.
   *
   * The rank is the id's index in `current` — the selector's own output — not a date comparator
   * of this view's: `byDateDesc` lives in the selector and a copy here would be a second writer
   * of the same rule, one tiebreak drift away from disagreeing with it. A kept id the selector
   * no longer files in this group (a row mid-slide to "Earlier", holding its slot on the
   * `dismissed` lease) has no rank and no opinion: it anchors no insertion and keeps its slot.
   *
   * `lead` is the promote block: ids entering this group for the first time that the reader has
   * explicitly marked unread go to the FRONT — above even a genuinely newer arrival merging in
   * the same render, because the promote is the reader's own act at this instant and the later
   * word wins — keeping the group's relative order among themselves (a bulk unread of three
   * keeps their arrival order rather than reversing it). Once placed, a promoted id is a kept
   * row like any other: mail newer than it arriving on a LATER sync files above it, which is the
   * rule every inbox keeps after a mark-unread. An id already in `prev` is skipped by `have`, so
   * a row the session order is already holding never moves — which is what makes marking a row
   * that is already in New a no-op on placement.
   *
   * A DISMISSAL IS SPENT THE MOMENT THE SELECTOR STOPS FILING THE ROW UNDER "EARLIER", which is
   * what `dropped` says. `dismissed` is a session set that now takes an entry for every message
   * read in the session, so a permanent one would swallow the row's way back: mail marked unread
   * from another client arrives as a plain re-partition — no `promote` call, nothing explicit here
   * — and an unconditional `dismissed.has(id)` would file it under a section it is no longer in and
   * then refuse to draw it in the section it IS in. Reading the two facts together is what makes
   * the set self-healing rather than a leak with a UI consequence.
   */
  const dropped = (id: string): boolean => dismissed.has(id) && earlierIds.has(id);
  const reconcile = (
    prev: string[],
    current: EngineMessage[],
    front?: ReadonlySet<string>,
  ): string[] => {
    const keep = prev.filter((id) => byId.has(id) && !dropped(id));
    const have = new Set(keep);
    const rank = new Map(current.map((m, i) => [m.id, i]));
    const lead: string[] = [];
    const fresh: string[] = [];
    for (const m of current) {
      if (dropped(m.id) || have.has(m.id)) continue;
      have.add(m.id);
      (front?.has(m.id) ? lead : fresh).push(m.id);
    }
    if (fresh.length === 0) return lead.length > 0 ? [...lead, ...keep] : keep;
    /**
     * ONE PASS, NOT ONE SCAN PER FRESH ID. The naive form — scan `keep` from the top for each
     * fresh id and splice — is O(kept × fresh), and the case that maximises it is the most
     * ordinary one there is: a cold mount, where EVERY id is fresh and a large unread group costs
     * millions of rank lookups inside a render. A two-pointer merge is equivalent because the
     * anchor is MONOTONIC: `fresh` is in `current` order, i.e. ascending rank, and the anchor
     * ("the first kept row with rank > r") can only move DOWN the list as r grows — the set
     * {rank > r} shrinks as r rises, so its first member's index never decreases, and a kept row
     * skipped for one fresh id (unranked, or ranked at or above it) is skipped for every later
     * one. So kept rows are emitted up to each fresh id's anchor, the fresh id before it, and
     * nothing is ever revisited.
     */
    const merged: string[] = [];
    let ki = 0;
    for (const id of fresh) {
      const r = rank.get(id)!;
      while (ki < keep.length) {
        const kr = rank.get(keep[ki]!);
        if (kr !== undefined && kr > r) break;
        merged.push(keep[ki]!);
        ki += 1;
      }
      merged.push(id);
    }
    for (; ki < keep.length; ki += 1) merged.push(keep[ki]!);
    return lead.length > 0 ? [...lead, ...merged] : merged;
  };
  // Resurfaced takes no promote set: that group is the worker's pin, not a reading order, and a
  // `u` on a resurfaced row leaves it exactly where the pin put it.
  /**
   * THE PIN CLAIMS A ROW OUT OF THE SESSION ORDERS — the display half of the selector's dedup.
   *
   * `ohboxView` already files a resurfaced row in the pinned group and holds it out of the other
   * two, so the props this view receives never show one message twice. The session orders can:
   * `reconcile`'s keep clause holds an id as long as `byId` — built over ALL THREE groups — still
   * knows it, and `dropped` releases only the read-into-"Earlier" slide. So a "Resurface now" on a
   * row sitting in New put its id into `resurfacedOrder` while `newOrder` went on holding it, and
   * the message rendered TWICE — pinned at the top and again in its old slot — until a reload
   * emptied the session orders. The settled state was always right; the optimistic window lied.
   *
   * The rule that ends it: each upper order is pruned to agree with the SELECTOR about which
   * section owns the id. `newOrder` never holds a pinned id — the pin is instant, in both
   * directions of the optimistic window. `resurfacedOrder` holds an id the pin claims OR one the
   * selector has re-filed under "Earlier": that second clause is not a leak, it is the slide's
   * lease — reading a pinned row clears the pin and files it below in one gesture, and the slide
   * effect (keyed on `earlierIds`, right below) needs the order to keep the row's slot for
   * `SETTLE_MS` before `dismissed` releases it, exactly as it does for a read row leaving New.
   * An id in neither set — a pin rolled back on an unread row — is released to New immediately,
   * where `reconcile` re-admits it, so a rollback re-files the row instead of leaving it pinned
   * to nothing or drawn twice. Pruning the ORDERS rather than filtering the display lists keeps
   * `upper` (which holds rows out of "Earlier") honest for the same reason. What is lost is only
   * the row's old position in New across an unpin, which no reload preserves either.
   */
  const pinnedIds = new Set(resurfaced.map((m) => m.id));
  resurfacedOrder.current = reconcile(resurfacedOrder.current, resurfaced)
    .filter((id) => pinnedIds.has(id) || earlierIds.has(id));
  newOrder.current = reconcile(newOrder.current, newForYou, promoted)
    .filter((id) => !pinnedIds.has(id));

  // The three groups as DISPLAYED: session order for the two upper ones, and "Earlier" with the
  // pinned upper ids removed so a row read this session is never shown twice.
  const upper = new Set([...resurfacedOrder.current, ...newOrder.current]);
  const displayResurfaced = resurfacedOrder.current
    .map((id) => byId.get(id))
    .filter((m): m is EngineMessage => m != null);
  const displayNew = newOrder.current
    .map((id) => byId.get(id))
    .filter((m): m is EngineMessage => m != null);
  const displayPrev = previouslySeen.filter((m) => !upper.has(m.id));

  /**
   * ═══ ONE ROW PER CONVERSATION, PER SECTION ═══════════════════════════════════════════════
   *
   * Five unread replies in one thread were five rows in "New for you" — the list rendered one
   * row per unread message by design, and only the demo fixtures ever populated `threadCount`.
   * `groupSection` (see `ohbox-groups.ts` for the rules) folds each section's DISPLAY list —
   * after session placement, so a fold never fights the session order — into one row per
   * `threadId`. New and Earlier fold independently: a thread with unreads here and history
   * there shows one row in each. Resurfaced rows stay per-message (each pin is its own "you
   * asked to see this again"), and the server-paged Older tail is not this client's to fold.
   *
   * MESSAGES REMAIN THE UNIT OF EVERYTHING BUT THE ROWS. `all` below still lists messages:
   * the meta count, mark-all-read, the read-state machinery and the pick set all keep their
   * message semantics — a grouped row is a rendering and a keyboard stop, not a new entity.
   */
  const groupedNew = groupSection(displayNew);
  const groupedPrev = groupSection(displayPrev);
  /** The rows on screen, top to bottom — what j/k walk and what a pick range spans. */
  const navRows: OhboxRowGroup[] = [
    ...displayResurfaced.map(singletonGroup),
    ...groupedNew,
    ...groupedPrev,
  ];
  /** The row holding this message, folded or not; -1 for a message not in the three groups. */
  const rowIndexOf = (id: string | null): number =>
    id == null ? -1 : navRows.findIndex((g) => g.members.some((m) => m.id === id));

  // Selection and read-state follow the MESSAGES on screen, top to bottom.
  const all = [...displayResurfaced, ...displayNew, ...displayPrev];
  const unreadIds = all.filter((m) => m.unread).map((m) => m.id);
  /** Does "Earlier" hold any of the account's own sent mail? Gates the history-window note. */
  const hasOwnSent = displayPrev.some(isOwnSent);

  /**
   * THE LIST IS A WINDOW over `[New for you, Earlier]`. The Ohbox is a working set, but a
   * standalone desktop client's mirror is the whole mailbox, and grouped `.map(row)` mounted
   * every accepted row of it — the unbounded cost History was windowed for. The two groups keep
   * their own `role="listbox"` containers; each renders only its share of the mounted window,
   * with reserved height above and below. The `Older` tail below is bounded (server pages) and
   * stays whole. The Ohbox writes no `\Seen` on scroll (its read-state is the dwell), so unlike
   * Reads/Receipts the window needs no observer re-scan. The split reader is untouched: it reads
   * `selected` from `all` by id, so a pick survives its row scrolling out of the window.
   *
   * RESURFACED ROWS ARE NOT WINDOWED — they are a small, pinned set at the very top, rendered
   * whole above the window's own top padding. Only New for you and Earlier are windowed.
   */
  const listScrollerRef = useRef<HTMLDivElement>(null);
  // The window counts ROWS — grouped conversations — because rows are what get mounted.
  const win = useListWindow({ scrollerRef: listScrollerRef, count: groupedNew.length + groupedPrev.length });
  const newCount = groupedNew.length;
  const newFrom = Math.min(win.start, newCount);
  const newTo = Math.min(win.end, newCount);
  const prevFrom = Math.max(0, win.start - newCount);
  const prevTo = Math.max(0, win.end - newCount);
  /**
   * THE OPEN MESSAGE, or `null` — never "the first one, then".
   *
   * This had `?? all[0]` on it, the twin of the one `AppShell` used to carry, and between them
   * an untouched Ohbox opened its newest unread message: the reading column rendered it, the
   * shell fetched its body, and the first `j` or click after that was a departure that marked
   * it read. A resting column is rendered instead (see {@link ReadColumn} below), which is a
   * state the product can be in rather than a message it chose for somebody.
   */
  const selected = all.find((m) => m.id === selectedId) ?? null;

  /**
   * REVEAL A SELECTION THE WINDOW HAS NOT MOUNTED — the search jump's landing.
   *
   * `openMessage` sets this pile's cursor and navigates here in one gesture, but the row it
   * named only EXISTS if the window mounted it, and the window mounts the top of the list.
   * A hit on anything deeper arrived at a list resting at its top: no row, no flash (the
   * locate effect polls a selector against rows that were never in the DOM), and nothing on
   * screen connecting the click to the arrival. Scrolling the SCROLLER is the fix the window
   * is built for — the slice derives from `scrollTop`, so putting the row's offset in view
   * mounts it, and the shell's locate pass then finds, centers and flashes it.
   *
   * Keyed on the SELECTION, and a no-op whenever the row is already mounted — an ordinary
   * click (which can only land on a mounted row) changes nothing, and this never runs on
   * scroll, so it cannot fight the reader for the viewport. Resurfaced rows render whole
   * above the window and need no revealing; their negative `winIdx` returns early.
   */
  useEffect(() => {
    if (!selectedId) return;
    const idx = rowIndexOf(selectedId);
    const winIdx = idx - displayResurfaced.length;
    if (idx < 0 || winIdx < 0) return;
    if (winIdx >= win.start && winIdx < win.end) return;
    const el = listScrollerRef.current;
    if (el) el.scrollTop = Math.max(0, winIdx * win.rowHeight - el.clientHeight / 2);
    // Deliberately only the selection: the window's own fields are read at fire time, and
    // re-running on every scroll-driven window change would re-scroll the list under the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  /* ── multi-select: VIEW-LOCAL, deliberately ──────────────────────────────
     It is a selection, not a document: it means nothing after you leave the
     Ohbox, and persisting it would resurrect a stale set on the next visit.
     `anchor` is the range origin for shift-click, kept in a ref so changing it
     never costs a render. */
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  /** The bulk bar's open sub-row. Same union shape as `MessagePane`'s. */
  const [pickPanel, setPickPanel] = useState<PickPanel | null>(null);

  const clearPicked = useCallback(() => {
    if (picked.size > 0) setPicked(new Set());
    setPickPanel(null);
    anchor.current = null;
  }, [picked.size]);

  /**
   * A PICK IS A PICK OF THE ROW — and a row can be a conversation now. Toggling a grouped row
   * toggles every message it stands for: the row says "⤷ 5", so a verb run on the pick must
   * act on five messages, not on the one that happens to lead the fold. (Representative-only
   * picking was the alternative, and it made "Move" on a five-unread conversation move one
   * message and leave the row standing — a verb that visibly does not do what the row shows.)
   * A message not in any row — the Older tail — is its own pick, exactly as before.
   */
  const togglePick = useCallback((id: string) => {
    const row = navRows[rowIndexOf(id)];
    const ids = row ? row.members.map((m) => m.id) : [id];
    setPicked((prev) => {
      const next = new Set(prev);
      const allIn = ids.every((i) => next.has(i));
      for (const i of ids) {
        if (allIn) next.delete(i);
        else next.add(i);
      }
      return next;
    });
    anchor.current = id;
    // Deliberately not memoised on stability: `navRows` is rebuilt each render and this must
    // read the rows as rendered, which is also why the deps are what they are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navRows]);

  /** Shift-click: add the inclusive ROW range from the anchor to `id`, in list order. */
  const pickRangeTo = useCallback((id: string) => {
    const from = anchor.current ? rowIndexOf(anchor.current) : -1;
    const to = rowIndexOf(id);
    if (from < 0 || to < 0) {
      togglePick(id);
      return;
    }
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    setPicked((prev) => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) for (const m of navRows[i]!.members) next.add(m.id);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navRows, togglePick]);

  /**
   * The selection IN LIST ORDER, which is the order every verb acts in.
   *
   * A `Set`'s iteration order is insertion order, so a range built upwards and one built
   * downwards would dispatch in different orders for the same visible selection. Deriving it
   * from `all` means the mutations follow what is on screen.
   */
  const pickedIds = useMemo(
    () => all.filter((m) => picked.has(m.id)).map((m) => m.id),
    [all, picked],
  );

  /**
   * Run a bulk verb and drop the selection.
   *
   * Clearing afterwards is the rule `markPicked` has always had: the verb has been applied
   * to exactly these messages, so a set that survived would invite a second application of
   * a verb that has already happened — and after a move or a screening the rows are not
   * even in this list any more.
   */
  const runBulk = useCallback(
    (action: BulkAction) => {
      // The selection's `unread` direction is the same explicit act `u` is, over more rows, so it
      // re-surfaces them the same way — see `promoted`. Only the direction, never the toggle:
      // `read` has nothing to promote and `move`/the horizons take the rows out of this list.
      if (action === "unread") promote(pickedIds);
      bulk.run(action, pickedIds);
      clearPicked();
    },
    [bulk, pickedIds, clearPicked, promote],
  );

  /**
   * Mark everything picked read, in ONE mutation — one request, one transaction, one intent.
   *
   * `⇧U` and the bar's Read button are THE SAME CALL, which is the action bar's own rule
   * about the read switch applied to the selection: two paths to one verb is how a button and its key drift
   * into meaning different things. It used to call `onMarkSeen` directly, so the key marked
   * mail read and said nothing while every other bulk verb reported what it had done.
   */
  const markPicked = useCallback(() => runBulk("read"), [runBulk]);

  // Ids that vanished from the list (moved, filed, deleted) leave with it — a count that
  // outlives its rows is a count that acts on nothing.
  useEffect(() => {
    setPicked((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(all.map((m) => m.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [all]);

  /* ── read-state ────────────────────────────────────────────────────────── */

  /**
   * THE LIST, READABLE FROM INSIDE A TIMER.
   *
   * The dwell below fires two seconds after the render that armed it and has to judge the
   * list as it is THEN — still present, still unread — without putting `all` in its
   * dependency array (see the dwell for why that would be fatal). Assigned in render rather
   * than refreshed by an effect: an effect would make the dwell's correctness depend on
   * effect DECLARATION ORDER, an invariant nothing states and a reorder would silently
   * break, with this bug as the failure mode. Same shape as `StreamShell` and
   * `useSeenOnScroll` in `@ohmail/ui`.
   */
  const allRef = useRef(all);
  allRef.current = all;

  /**
   * THE WRITER, held the same way, so the dwell's deps are ONE value.
   *
   * `onMarkSeen` was a dependency of the dwell until this change, which made the dwell's
   * correctness depend on a caller keeping its callback identity stable: `AppShell` does
   * (`markSeen` is a `useCallback`), but a caller that did not would restart the two seconds
   * on every render and the dwell would never fire at all — silently, with no error. That is
   * too much load on a memo somebody else owns. Behind a ref, the effect depends on exactly
   * one thing: the cursor the user put here.
   */
  const markSeenRef = useRef(onMarkSeen);
  markSeenRef.current = onMarkSeen;

  /**
   * {@link earlierIds}, READABLE FROM INSIDE THE SLIDE TIMER, and held the same way and for the
   * same reason as `allRef` above: the slide has to re-judge its own premise at the moment it
   * completes, against the list as it is THEN, not as it was 280 ms earlier when the row started
   * moving. Assigned in render so a slide that fires between two renders reads the newer answer.
   */
  const earlierRef = useRef(earlierIds);
  earlierRef.current = earlierIds;

  /**
   * THE MESSAGE `u` JUST PUT BACK TO UNREAD, and why nothing here may undo it.
   *
   * Pressing `u` on the row under the cursor marks it unread — and in the split pane the cursor
   * is still on it, so the dwell below arms and the commit further down would mark it read again.
   * The mutation fires, the server agrees, and the user's explicit act is reverted by a heuristic
   * while they watch. That is not subtle; it makes `u` useless in the one view whose keyboard map
   * advertises it, and the `?` overlay would be documenting a key that does not do what it says.
   *
   * An explicit "unread" therefore pins the message until the cursor MOVES. A ref rather than
   * state: it must be readable in the same commit by code that runs outside a render, and it
   * should not cause a render of its own.
   *
   * KEYED TO `dwellOn`, NOT to `selected`, so that the pin and the machinery it blocks agree on
   * what "the cursor" means — `selected` also moves when the list re-partitions underneath the
   * user, which is not a cursor move and must not release a pin. The release itself is an effect
   * further down, where `dwellOn` exists; the ref is declared HERE because the commit below reads
   * it and a forward reference into a later `const` is exactly the kind of ordering dependency
   * this file has already been bitten by once.
   */
  const pinnedUnread = useRef<string | null>(null);

  /**
   * ═══ READING IS COMMITTED ON THE WAY OUT, NOT ON THE WAY IN ═══════════════════════════════
   *
   * The message a reader is looking at RIGHT NOW keeps its dot and keeps its place in "New for
   * you". That is not a delay for its own sake — it is what makes the list stable to read from.
   * Committing on arrival re-partitions the list under the cursor at the moment attention is on
   * it: the row you just opened jumps from one group to the other, everything below it slides up,
   * and the "New" count drops while you are still reading the thing it was counting.
   *
   * So arrival ARMS and departure COMMITS. This ref holds the one message that has been read but
   * not yet left — written by the dwell when its two seconds elapse, and by an explicit open —
   * and it is spent by {@link commitPendingRead} at each of the four ways out.
   *
   * IT CARRIES THE WHOLE OF THE STABILITY ARGUMENT NOW. A read used to be doubly deferred: nothing
   * was written until the reader left, and the row then held its slot anyway until a reload. The
   * second half is gone — a read row slides to "Earlier" at once (see the session-placement block
   * above) — so this is the only thing standing between the reader and a list that re-sorts under
   * their eyes. Which is enough, and is where the protection belonged all along: the list moves at
   * the moment attention has already left the message, never while it is being looked at.
   *
   * A ref rather than state, for the same reason `pinnedUnread` is one: the commit paths run
   * outside React's render (a timer, a document event, an unmount cleanup) and must see the value
   * as it is at that instant.
   *
   * At most ONE message is ever owed. Reading is a cursor, not a set: arriving somewhere new is
   * itself a departure from the last place, so the previous debt is settled before a new one is
   * taken on and this can never become a queue that a reload would drop.
   */
  const pendingRead = useRef<string | null>(null);

  /**
   * ═══ AN ARMED READ PRESENTS AS READ ══════════════════════════════════════════════════════
   *
   * The renderable twin of {@link pendingRead}, and the fix for the two surfaces that leaked the
   * deferral (owner-reported). Committing on departure is invisible by design — except that the
   * open message's read-state verb went on offering "Mark read" (deriving from a store flag the
   * departure had not written yet), and its row sat at full unread weight under "New for you" for
   * as long as it was being read. Both surfaces now derive from the ARMED state: the moment a
   * read is armed — an explicit open, or the split pane's two-second dwell — the row loses its
   * dot and its weight, and the verb flips to "Mark unread", the only honest action on a message
   * that is being read.
   *
   * WHAT DOES NOT MOVE WITH IT, deliberately:
   *   · THE WRITE. Departure still commits, on the one path every read-state write takes. This
   *     is presentation of a fact this view already holds, never a second writer.
   *   · THE PLACE. The row keeps its slot under "New for you" until departure — the session
   *     lease is untouched, and the arming render can restyle a row but never moves one.
   *   · THE COUNTS. The header's "N unread" and mark-all-read keep counting TRULY unread mail
   *     (`unreadIds`), so they can sit one above the dots on screen while a message is open.
   *     A count that followed the presentation would claim a write that has not happened — and
   *     the commit's own re-judgement reads true state through `allRef`, which is what keeps
   *     the departure write firing at all.
   *
   * Arming used to be free of renders on purpose; the render is now the point — it is what draws
   * the unbold. One writer for the pair: {@link armRead} moves the ref and the state together
   * (plus the upward report — see the `onReadArmed` prop), so the two can never disagree, and
   * `commitPendingRead` stays callable from cleanups because `armRead` is memoised on nothing.
   */
  const [armedRead, setArmedRead] = useState<string | null>(null);
  const onReadArmedRef = useRef(onReadArmed);
  onReadArmedRef.current = onReadArmed;
  const armRead = useCallback((id: string | null) => {
    pendingRead.current = id;
    setArmedRead(id);
    onReadArmedRef.current?.(id);
  }, []);

  /**
   * SPEND THE DEBT — and re-judge it at the moment of spending, never at the moment of arming.
   *
   * The world moves between arming and leaving: the message can be filed or moved out of the
   * Ohbox, another device or a `⇧I` can already have marked it read, or `u` can have pinned it
   * unread on purpose. All three are checked HERE, against the list as it is now, because a check
   * performed when the debt was taken on would be answering a question about a mailbox that no
   * longer exists.
   *
   * It clears the ref FIRST and unconditionally. Two of the four departure triggers can fire in
   * the same tick (closing the reader on a phone unmounts nothing, but leaving the view while a
   * sheet is up closes both), and a debt spent twice is two `mark_seen` dispatches for one
   * reading — one request too many, and on a slow network a visible flicker as the second answer
   * lands. Idempotent by construction rather than by the writer being asked to de-duplicate.
   *
   * Reads ONLY refs, so it is safe to call from a cleanup with an empty dependency array and from
   * a `pagehide` listener registered once. That is deliberate: a callback with dependencies would
   * make the unmount commit depend on the last render having the right closure, which is exactly
   * the class of bug the dwell's own dependency array was rewritten to remove.
   */
  const commitPendingRead = useCallback(() => {
    const id = pendingRead.current;
    // Through `armRead`, so the armed presentation ends with the debt — whatever the departure,
    // and whether or not the re-judgement below decides to write.
    if (id != null) armRead(null);
    if (id == null) return;
    if (pinnedUnread.current === id) return;
    if (!allRef.current.find((m) => m.id === id)?.unread) return;
    // A GLANCE, and it says so. Nobody pressed anything to get here: the dwell armed on a cursor
    // landing and this is a departure. A resurfaced row read this way keeps its pin — the engine
    // drops it from the batch (`OhmailEngine.enrich`) — so "open it and leave" no longer answers
    // a resurface the reader never dealt with. Every deliberate reader below omits the flag.
    markSeenRef.current([id], false, "glance");
  }, [armRead]);

  /**
   * THE CURSOR THE USER PUT HERE — and the only value in this file that can arm the dwell.
   *
   * `selectedId` cannot answer this question, and that is what shipped the runaway. It used to
   * arrive already resolved through TWO implicit fallbacks — `AppShell`'s `?? allOhbox[0]` and
   * this view's own — so before anything had been picked it meant "the newest unread message",
   * and it silently RE-RESOLVED onto a different message every time the list re-partitioned.
   * Since the list is partitioned BY `unread` (`ohboxView`), marking one message read is itself
   * a re-partition, so a dwell keyed on `selected` fed itself: commit → the row leaves "New for
   * you" → the fallback lands on the next unread message → the effect sees a selection it never
   * asked for and arms again. Two seconds per message, straight through the Ohbox, onto a real
   * IMAP server.
   *
   * BOTH FALLBACKS ARE GONE NOW, so `selected` can no longer re-resolve onto anything — and
   * this state is still the value the dwell keys on rather than `selected`. The reason is
   * unchanged and is not the fallback: `selected` also moves when a message leaves the pile
   * underneath the user, which is not a cursor move and must not arm a timer. The guarantee is
   * still structural rather than a condition in the effect body: `dwellOn` is written in
   * exactly two places — `selectByUser`, reachable only from j, k and a click, and `open`,
   * which clears it. Nothing derived from the list can produce it.
   */
  const [dwellOn, setDwellOn] = useState<string | null>(null);

  /**
   * Move the cursor because the USER moved it — j, k, and a click on an unselected row.
   *
   * DEPARTURE #1 of four. Landing on a different message is leaving the one before it, and it is
   * the trigger that fires in ordinary use: read something, press j, and the row you were on
   * moves to "Earlier" as you go. A move onto the SAME id is not a departure and settles nothing,
   * which is why the debt is spent only when the ids differ.
   */
  const selectByUser = useCallback((id: string) => {
    if (pendingRead.current !== id) commitPendingRead();
    setDwellOn(id);
    onSelect(id);
  }, [onSelect, commitPendingRead]);

  /**
   * Opening a message IS reading it — Enter, a second click on the selected row, mobile tap.
   *
   * `onEnterReader` is an unconditional statement of INTENT ("the user asked to open this
   * message"), not an instruction to raise a sheet. The shell answers it with the
   * reader only where the reading column is hidden; at a split width the column beside this
   * list IS the open, and a sheet over it was the same message rendered twice.
   *
   * It also PINS the selection by calling `onSelect`, and that is not housekeeping. It was
   * added because a click on the top row of a fresh Ohbox took the "already selected" branch
   * below — the implicit fallback had made it `selected` with nobody choosing it — so the open
   * committed while `ohboxSel` stayed null; the moment the commit moved that row into
   * "Previously seen" the fallback re-resolved to the next unread message and the reader sheet,
   * which renders `selectedOhbox`, swapped to a message the user had not opened. That entry
   * point no longer exists: with both fallbacks deleted the first click on a fresh Ohbox is a
   * plain selection and `open` is only ever reached with a selection already made. The call
   * stays because it is what makes `open` a complete statement on its own — the mobile tap and
   * a `↵` arriving from anywhere else both need the cursor to end up where the reader is.
   *
   * And an open SUPERSEDES a dwell: reading is established the moment the message is opened, so
   * the timer armed by whichever click selected this row has nothing left to decide.
   *
   * WHAT IT DOES NOT DO IS DISPATCH. Opening ARMS the read; leaving commits it. An open that
   * marked the message read on the spot would re-partition the list under the reader at the exact
   * moment they turned their attention to the message — the row leaving "New for you" while it is
   * the thing being looked at. So this records the debt and the four departure paths spend it.
   * The message keeps its dot and its place for as long as it is the one on screen.
   */
  const open = useCallback((m: EngineMessage) => {
    setDwellOn(null);
    onSelect(m.id);
    if (m.unread) {
      if (pendingRead.current !== m.id) commitPendingRead();
      armRead(m.id);
    }
    onEnterReader(m.id);
  }, [onSelect, onEnterReader, commitPendingRead, armRead]);

  /**
   * THE SELECTION TAKEN AWAY FROM OUTSIDE IS A DEPARTURE — the Back button's half of the
   * commit-on-leave rule. The URL carries the open message now, so Back on `#/ohbox/m/A`
   * clears the SHELL's selection while this view stays mounted — a way of
   * leaving message A that none of the four departures below can see. Without this, the dwell
   * timer armed on A kept running with A no longer selected (Back inside the two seconds:
   * A armed OFF-screen and a later cursor move wrote it read), and a debt already armed was
   * spent only at the NEXT departure instead of at this one.
   *
   * So: the cursor prop going null while this view holds a dwell or a debt cancels the dwell
   * (leaving before the two seconds elapsed is not reading) and COMMITS the debt (leaving after
   * they elapsed is exactly the departure the commit waits for) — the same two halves
   * `selectByUser` applies when the cursor moves to another row.
   */
  const prevSelectedId = useRef(selectedId);
  useEffect(() => {
    const prev = prevSelectedId.current;
    prevSelectedId.current = selectedId;
    // A TRANSITION to null, not the resting state: only a selection that existed and was taken
    // away is a departure. (A parent may re-render this view with the cursor prop one commit
    // behind its own click handling; a bare null must not spend a dwell that same commit.)
    if (selectedId !== null || prev === null) return;
    if (dwellOn === null && pendingRead.current === null) return;
    setDwellOn(null);
    commitPendingRead();
  }, [selectedId, dwellOn, commitPendingRead]);

  /**
   * RELEASE THE `u` PIN WHEN THE CURSOR MOVES — the second half of `pinnedUnread`, declared
   * above with the argument for it. It lives here because `dwellOn` is what "the cursor" means
   * and `dwellOn` does not exist further up.
   *
   * NO GUARD BELOW FAILS IF THIS IS PUT BACK TO `selected?.id`, and that is stated rather
   * than hidden: with `dwellOn` set, `onSelect` has set the shell's `ohboxSel` to the same
   * id, so the two only diverge once the message leaves the Ohbox — and the commit's
   * fire-time re-read already drops that case. This is coherence, not a fixed bug.
   */
  useEffect(() => {
    if (pinnedUnread.current && pinnedUnread.current !== dwellOn) pinnedUnread.current = null;
  }, [dwellOn]);

  /**
   * ═══ TWO DIRECTIONS, NOT ONE TOGGLE ═══════════════════════════════════════════════════
   *
   * This was a single `toggleUnread` on a single key. It is now two idempotent commands, and
   * the reason is what a toggle does to a SET: "invert eleven messages" turns a mixed
   * selection into a different mixed selection, so pressing the key twice is not a no-op and
   * pressing it once has an outcome nobody can predict without counting first. A direction
   * always produces the same state from any state, which is why Gmail binds two keys for this
   * and why the bulk vocabulary (`BulkAction`) has always had `read` and `unread` as separate
   * members rather than one flip. The single-message case is the one-element case of that
   * rule, and it should not disagree with it.
   *
   * ── THE PIN IS THE WHOLE REASON THESE ARE NOT `onMarkSeen` AT THE CALL SITE ────────────
   *
   * Marking unread inside the dwell window arms nothing new, but the debt that was already
   * recorded would be spent on the way out and mark it read again — the message would silently
   * un-unread itself one keypress later. So `u` does BOTH halves: it sets the pin the commit
   * checks, and it tears up the debt outright.
   *
   * TWO MECHANISMS FOR ONE OUTCOME, AND BOTH ARE LOAD-BEARING. Cancelling the debt is what makes
   * `u` survive the very next departure; the pin is what makes it survive a departure that
   * happens some other way — a second open, a re-entry into the same row. Neither alone covers
   * both, and an explicit unread that a heuristic can undo is not an explicit unread.
   *
   * The debt is cancelled only when it is THIS message's. `u` acts on the row under the cursor;
   * if some other message is still owed a commit, that reading really did happen and the pin
   * here says nothing about it.
   *
   * ── AND IT MOVES THE ROW BACK ABOVE THE "EARLIER" LINE ─────────────────────────────────
   *
   * A THIRD mechanism, and it is about placement rather than about the write: the two above keep
   * the state from being undone, and neither of them puts the row anywhere. `promote` does (see
   * `promoted`), because "New for you" is defined by unread-in-Ohbox and a row this key has just
   * made unread that stayed under "Earlier" is the list contradicting its own section heading.
   *
   * `promote` ALSO TEARS UP A SLIDE IN FLIGHT, which is the case this key meets most often now
   * that reading moves rows: read a message, change your mind within 280 ms, and the row is
   * mid-descent. The two mechanisms above would leave the read state alone and the timer would
   * still file the row under "Earlier" a quarter-second later — the reader's last word undone by
   * a clock they cannot see. See `promote`.
   */
  const markUnread = useCallback((m: EngineMessage) => {
    pinnedUnread.current = m.id;
    // Through `armRead`, so tearing up the debt also re-bolds the row and puts the verb back —
    // the presentation half of "the later explicit act wins" (see `armedRead`).
    if (pendingRead.current === m.id) armRead(null);
    promote([m.id]);
    onMarkSeen([m.id], true);
  }, [onMarkSeen, promote, armRead]);

  const markRead = useCallback((m: EngineMessage) => {
    // Reading it is consent for the dwell to have been right, so the pin is released. The debt
    // is left alone rather than cleared: the commit re-reads the list when it fires and will find
    // this message already read, so it spends the debt on nothing. One place decides that.
    pinnedUnread.current = null;
    onMarkSeen([m.id], false);
  }, [onMarkSeen]);

  /**
   * THE 2 s DWELL, and why j/k alone must commit nothing.
   *
   * In the split pane the reading column already shows whatever the cursor is on, so a strict
   * "only an explicit open counts" rule would leave a message the user has plainly read sitting
   * bold. But `jjjjj` down a list is navigation, not reading, and marking every row it passes
   * would empty the Ohbox by accident — the one destructive-feeling thing a keyboard sweep can
   * do. A dwell separates the two: the timer is armed on selection and CANCELLED by the cleanup
   * on every change, so a sweep of ten rows arms and cancels ten times and commits nothing,
   * while stopping on one for two seconds commits that one.
   *
   * IT ARMS ON `dwellOn` AND ON NOTHING ELSE, which is the whole of the runaway fix. The
   * dependency array is the guarantee, not a condition in the body: a list that re-partitions
   * — which is exactly what a read commit does to a list grouped by `unread` — cannot change
   * `dwellOn`, so the effect does not re-run and a commit can never arm the next one. The
   * previous version depended on `selected`, which the implicit fallback re-pointed at the
   * next unread message after every commit, and the Ohbox marked itself read at one message
   * per two seconds, on the user's own IMAP server.
   *
   * `all` IS DELIBERATELY NOT A DEPENDENCY. It changes on every sync delta, and a dependency
   * on it would restart the two seconds each time — on a live mailbox the dwell would never
   * reach the end of its own clock. The current list is read through `allRef` instead, at the
   * two moments that need it.
   *
   * THE TARGET IS FROZEN AT ARM TIME. It records the id the user was standing on, never
   * "whatever is selected now", so a list that reorders mid-dwell cannot redirect the write
   * onto a message nobody looked at.
   *
   * ── AND IT DISPATCHES NOTHING. IT RECORDS A DEBT ──────────────────────────────────────
   *
   * The timer used to call the writer directly, which meant two seconds of stillness re-sorted
   * the list under the reader's eyes: the row moved out of "New for you" while it was the one
   * being read, the count dropped, and everything below it slid up. The dwell's judgement is
   * still exactly the same — this is the moment the product decides reading has happened — but
   * the CONSEQUENCE is deferred to the moment the reader leaves. So the fire-time re-read moves
   * with it, into {@link commitPendingRead}, where it can answer the same three questions
   * (still here, still unread, not pinned) against a list that is one departure newer.
   *
   * Split pane only. On mobile there is no reading column beside the list, so a selection shows
   * nothing and dwelling on it means nothing; there, only `open` counts.
   */
  useEffect(() => {
    if (dwellOn == null) return;
    const id = dwellOn;
    if (pinnedUnread.current === id) return;
    if (!allRef.current.find((m) => m.id === id)?.unread) return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    if (window.matchMedia("(max-width: 900px)").matches) return;
    const timer = window.setTimeout(() => {
      // Through `armRead`, so the row's ink and the verb flip with the debt (see `armedRead`).
      // The render this costs restyles the one row; placement is the session order's and does
      // not move. `armRead` is memoised on nothing, so the dependency array below still re-runs
      // this effect on `dwellOn` and on nothing else.
      armRead(id);
    }, DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [dwellOn, armRead]);

  /**
   * ═══ DEPARTURES #2, #3 AND #4 ═════════════════════════════════════════════════════════════
   *
   * #1 is the cursor moving, and it lives in `selectByUser` because that is where a cursor move
   * happens. The other three are things that happen TO this view rather than in it, so they are
   * effects.
   */

  /**
   * #2 — THE VIEW GOES AWAY. Switching to Reads, Receipts, the Screener or Settings unmounts this
   * component (the shell renders exactly one view), and leaving the Ohbox is unambiguously
   * leaving the message that was open in it. Without this, walking away by clicking a rail item
   * would be the one exit that silently forgot the reading.
   *
   * THE EFFECT BODY IS EMPTY AND THE CLEANUP IS THE WHOLE OF IT, which only works because
   * {@link commitPendingRead} has a stable identity — it reads nothing but refs and is memoised on
   * nothing. A cleanup re-runs whenever a dependency changes, so a commit function that was
   * rebuilt each render would fire this on ordinary re-renders and mark mail read mid-session,
   * with no departure anywhere in sight.
   */
  useEffect(() => commitPendingRead, [commitPendingRead]);

  /**
   * #3 — THE READER SHEET CLOSES, AND ONLY WHERE THE SHEET WAS THE READING.
   *
   * Below 900px there is no reading column: the sheet IS how a message is read, so dismissing it
   * is leaving the message, and on a phone it is usually the ONLY departure that happens — a
   * reader taps a message, reads it, taps back, and never moves the cursor at all.
   *
   * At a split width it is not a departure and must not be treated as one. The column beside the
   * list goes on showing the same message after the sheet closes, so committing there would mark
   * mail read while the reader is still looking at it — the very thing this whole mechanism was
   * built to stop, arriving through the one path that looks like an exit and is not.
   *
   * The width question is asked with the SAME query the dwell asks, at the moment the sheet
   * closes rather than at the moment it opened: a device rotated or a window resized mid-read
   * should be judged by where the reading actually ended.
   */
  const prevReaderId = useRef<string | null>(readerId);
  useEffect(() => {
    const closed = prevReaderId.current !== null && readerId === null;
    prevReaderId.current = readerId;
    if (!closed) return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    if (!window.matchMedia("(max-width: 900px)").matches) return;
    commitPendingRead();
  }, [readerId, commitPendingRead]);

  /**
   * #4 — THE TAB GOES AWAY. `pagehide` is the last event a page reliably gets on a close, a
   * navigation away, or being frozen into the back/forward cache, and it fires in cases
   * `beforeunload` does not — notably on mobile, which is where a reader is most likely to leave
   * without ever moving the cursor.
   *
   * IT DISPATCHES THE ORDINARY MUTATION, not a beacon. A side-channel request would leave the
   * client's own idempotency key and optimistic overlay behind, so the write would arrive by a
   * route no other read-state write takes and could not be de-duplicated against the one the user
   * might make from another device a second later. One writer, one path.
   *
   * The cost is stated rather than hidden: a tab killed hard enough that no listener runs loses
   * the pending commit. That is the direction to fail in — the message stays unread and is
   * presented as new next time, which is a second chance to read it rather than mail silently
   * marked read on the strength of a session nobody finished.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onLeave = () => commitPendingRead();
    window.addEventListener("pagehide", onLeave);
    return () => window.removeEventListener("pagehide", onLeave);
  }, [commitPendingRead]);

  /**
   * ═══ THE SLIDE: A ROW LEAVES THE UPPER GROUPS BY MOVING, NOT BY DISAPPEARING ══════════
   *
   * Start one row's descent to "Earlier". It is the only writer of `settling` and the only writer
   * of `dismissed`, so there is exactly one answer in this file to "how does a row leave New for
   * you", however it came to be read.
   *
   * TWO STEPS AND A GAP BETWEEN THEM, and the gap is the point. The class goes on first and the
   * row keeps its slot for {@link SETTLE_MS}, which is what `row.css` transitions over; only then
   * is the id dropped from the session order and the row redrawn under "Earlier". Dropping it in
   * the same tick would be a teleport — the row would vanish from under the cursor and reappear
   * somewhere below, and everything between the two positions would jump up a row with no motion
   * to explain it.
   *
   * IT RE-JUDGES ITS OWN PREMISE WHEN IT LANDS, the way {@link commitPendingRead} does. 280 ms is
   * long enough for the answer to change: `u` can put the message back to unread, another client
   * can, the row can be filed out of the Ohbox altogether. So the completion asks `earlierRef`
   * again — is "Earlier" still where this belongs? — and abandons the move if it is not, leaving
   * the row exactly where the reader last saw it. `promote` cancels the timer outright for the
   * explicit case; this covers the ones nothing in this view initiated.
   */
  const slideOut = useCallback((id: string) => {
    if (slideTimers.current.has(id)) return;
    setSettling((s) => new Set(s).add(id));
    const timer = window.setTimeout(() => {
      slideTimers.current.delete(id);
      if (earlierRef.current.has(id)) setDismissed((d) => new Set(d).add(id));
      setSettling((s) => {
        if (!s.has(id)) return s;
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }, SETTLE_MS);
    slideTimers.current.set(id, timer);
  }, []);

  /**
   * ═══ WHAT STARTS A SLIDE: THE SELECTOR RE-FILING A ROW THIS VIEW IS STILL HOLDING UP ══
   *
   * The whole gesture keys on ONE observation, made against the session orders rather than against
   * any particular act: an id these orders are holding in an upper group, which `ohboxView` now
   * files under "Earlier". Reading a message here produces exactly that (the optimistic `mark_seen`
   * overlay flips the row before any request lands), and so does a reply settling, and so does a
   * `\Seen` adopted from Exchange, Mail.app or a phone — the worker writes it to the mirror and it
   * arrives as the same delta. One mechanism, because they are one event with different causes; a
   * per-cause hook would have been three places to forget the third one, which is precisely how
   * external reads came to move nothing at all until a reload.
   *
   * KEYED ON `earlierIds` AND NOTHING ELSE. It is a memo over `previouslySeen`, so the effect
   * re-runs on exactly the changes that can add work and never on the ones that cannot — a new
   * unread arriving, a selection moving, a picked set changing. The session orders are read from
   * their refs, which render has already reconciled by the time any effect runs.
   *
   * `slideOut` is idempotent on an id already in flight, so a re-render mid-slide re-observes the
   * same row and does nothing to it.
   */
  useEffect(() => {
    for (const id of resurfacedOrder.current) if (earlierIds.has(id)) slideOut(id);
    for (const id of newOrder.current) if (earlierIds.has(id)) slideOut(id);
  }, [earlierIds, slideOut]);

  /** Nothing may fire into an unmounted view — the whole map, once, on the way out. */
  useEffect(() => {
    const timers = slideTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  /**
   * ═══ A SETTLED REPLY MARKS THE MESSAGE IT ANSWERED READ ═══════════════════════════════
   *
   * Answering a message is being done with it, and the product says so by writing the read state —
   * which is also what clears any resurfaced pin server-side (`MessageService.markSeen`), so a
   * reply closes a resurface. The shell hands the settled reply down as {@link replyDone}, keyed on
   * the settle instant so a value already acted on is ignored across later renders.
   *
   * THE MOVE IS NOT WRITTEN HERE ANY MORE. This used to run its own slide-then-dismiss, because it
   * was the one deliberate mid-session move in a design where reads did not move rows at all. Reads
   * move rows now, so a second copy of the gesture would be two mechanisms racing over one row —
   * both setting `settling`, both scheduling a dismissal. The write is the whole of this effect;
   * the slide follows from it through `slideOut`, exactly as it does for a message read by hand.
   *
   * It still acts only on a row CURRENTLY in the New session order: a reply to something already in
   * "Earlier" is answering mail that has been read, and a late confirmation for a message the list
   * no longer shows in New is a no-op.
   */
  const replyDoneStamp = useRef<string | null>(null);
  useEffect(() => {
    const rd = replyDone ?? null;
    if (!rd) return;
    const stamp = `${rd.messageId}|${rd.at}`;
    if (replyDoneStamp.current === stamp) return;
    replyDoneStamp.current = stamp;
    if (!newOrder.current.includes(rd.messageId)) return;
    if (allRef.current.find((m) => m.id === rd.messageId)?.unread) {
      markSeenRef.current([rd.messageId], false);
    }
    // Keyed on `replyDone` alone: the refs and setters it reaches are stable, and re-running on any
    // other change would replay a settle the stamp guard has already spent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyDone]);

  /**
   * The Ohbox's keys, DECLARED.
   *
   * These were a sixth `document` listener with the shell's and four other views'; they are
   * now a view layer in the registry, which means two things: they win over the global map
   * while this view is mounted (and disappear with it), and the `?` sheet lists them
   * because they exist, not because someone remembered to write them down.
   */
  /**
   * j/k WALK ROWS, NOT MESSAGES. `order` holds each row's OPEN TARGET — for a conversation,
   * its latest unread — so landing on a grouped row selects the message the row leads with,
   * and a folded member is never a keyboard stop. `at` resolves through row MEMBERSHIP, so a
   * selection standing on a member that stopped leading its row (a newer reply arrived) still
   * knows which row it is on.
   */
  const order = navRows.map((g) => g.openTarget.id);
  const at = rowIndexOf(selected?.id ?? null);
  const keys: KeyBinding[] = [
    {
      chord: "j",
      group: "navigate",
      label: t("keyNext"),
      // `at < 0` — no cursor, or a cursor on something these rows do not contain — is ENTRY,
      // and this expression already treats it as one: `-1 >= order.length - 1` is false for any
      // non-empty list, so `j` steps in at the top. See `k` below for the other half.
      disabled: at >= order.length - 1,
      run: () => at < order.length - 1 && selectByUser(order[at + 1]!),
    },
    {
      /**
       * THE EXACT INVERSE OF `j`, AND THAT HAS TO INCLUDE THE WAY IN.
       *
       * The Ohbox rests with NO cursor. That is deliberate — the reading column stays at rest
       * until somebody chooses a message, rather than opening the newest unread on nobody's
       * behalf — and it means the keys are how a reader enters the list, not merely how they
       * move around inside it.
       *
       * `j` has always had an entry move: with nothing selected it lands on the first row. `k`
       * had none. It was declared inert whenever the cursor was not already on a row, so on a
       * freshly opened Ohbox `j` walked the list and `k` did nothing at all, with nothing on
       * screen to explain the difference. Two keys presented as a pair, one of them dead.
       *
       * The pair is one gesture in two directions, so it enters from the two ends: `j` comes in
       * at the top going down, `k` comes in at the bottom going up. Inside the list they are
       * strict inverses over the same row order — `j` then `k` returns to the row you left,
       * whatever the grouping and whatever order this session placed the rows in, because both
       * read the one `order` array built above.
       *
       * `at < 0` covers both readings of "not on a row": nothing selected, and a selection
       * standing on something outside the three grouped sections. Neither is a state either key
       * may quietly ignore.
       */
      chord: "k",
      group: "navigate",
      label: t("keyPrev"),
      disabled: order.length === 0 || at === 0,
      run: () => {
        if (at < 0) selectByUser(order[order.length - 1]!);
        else if (at > 0) selectByUser(order[at - 1]!);
      },
    },
    {
      chord: "Enter",
      group: "message",
      label: t("keyOpen"),
      /* DECLARED DEAD WHEN THERE IS NOTHING TO OPEN, and this is new with the fallback's
         removal. `run` has always been guarded, so ↵ on an untouched Ohbox did nothing either
         way — but the `?` sheet is generated from this table, and a binding with no `disabled`
         is advertised as available. Before, the fallback meant there was always a message and
         the question never arose; now the first thing a reader sees is a resting column, and a
         key sheet promising "open the message" beside it would be documenting a dead key. `j`
         is the way in, which is what the resting column itself says. */
      disabled: selected == null,
      // ↵ on a focused button presses the button; that is the browser's and it stays so.
      when: (e) => (e.target as HTMLElement).tagName !== "BUTTON",
      // The `: onEnterReader()` arm is gone with the boolean it depended on. It meant
      // "open the reader on nothing" — with an empty list there is no message to read, and
      // the sheet it opened rendered a `<span/>`.
      run: () => selected && open(selected),
    },
    {
      chord: "t",
      group: "message",
      label: t("keyTag"),
      disabled: selected == null,
      run: () =>
        selected &&
        onAddTag(
          selected.id,
          document.querySelector<HTMLElement>(
            `.view-ohbox .row[data-id="${CSS.escape(selected.id)}"]`,
          ),
        ),
    },
    {
      chord: "x",
      group: "message",
      label: t("keyPick"),
      disabled: selected == null,
      run: () => selected && togglePick(selected.id),
    },
    {
      /**
       * THE PAIR, AND WHY IT IS NOT GMAIL'S EXACT PAIR.
       *
       * Gmail is ⇧I to mark read and ⇧U to mark unread, and it is the precedent worth
       * following — but `shift+u` is taken here, by the bulk "mark what I picked" verb
       * declared a few lines below, and taking it back would break a shipped shortcut to
       * match a convention. So: `⇧I` is Gmail's, verbatim, and `u` keeps the key this
       * product has always used for unread — which is also the better mnemonic of the two.
       *
       * `u` USED TO BE A TOGGLE. See `markUnread` for why a direction is the right shape.
       * Both are listed in the `?` sheet because both declare a label, and the sheet is
       * generated from this registry.
       */
      chord: "u",
      group: "message",
      label: t("keyMarkUnread"),
      disabled: selected == null,
      run: () => selected && markUnread(selected),
    },
    {
      chord: "shift+i",
      group: "message",
      label: t("keyMarkRead"),
      disabled: selected == null,
      run: () => selected && markRead(selected),
    },
    {
      /**
       * THE BULK ACTION, ON THE KEYBOARD.
       *
       * The complaint was that multiple messages could not be selected and marked seen, and
       * the half that shipped could only be finished with a mouse: the bar's buttons are
       * reachable by Tab, but there was no way to say "mark what I picked" from the keys
       * that made the pick, and nothing in the `?` sheet mentioned that marking a selection
       * was possible at all. Declaring it here documents it — the sheet is generated from
       * this registry and cannot list a key that does nothing.
       *
       * `⇧U` and not a fresh letter: `u` is already "mark read / unread" at the cursor, so
       * the shifted twin is the same verb over the selection. `chordMatches` keeps plain
       * `u` from swallowing it.
       */
      chord: "shift+u",
      group: "message",
      label: t("keyMarkPicked"),
      disabled: picked.size === 0,
      run: () => markPicked(),
    },
    {
      /**
       * ESCAPE CANCELS THE OPEN SUB-ROW BEFORE IT CLEARS THE SELECTION.
       *
       * FIRST in this array, and the array's order IS the precedence — `ordered()` walks a
       * layer's bindings in declaration order and the first match runs (`keymap.tsx`). So
       * this is stated where precedence lives rather than as a condition inside the clear
       * binding, which is the shape that rots.
       *
       * It matters most for the confirm row: that row is the last moment before a consent
       * decision commits, and an Escape that blew past it to clear the selection would leave
       * the user with neither the confirmation nor the set they had built.
       *
       * NO NEW `document` LISTENER — there are already five, measured. This is a registry
       * binding in the view layer, which the shell's `overlay` scope still outranks, so a `?`
       * sheet or the palette opened over this closes first and the sub-row survives.
       */
      chord: "Escape",
      group: "message",
      label: t("keyCancelBulk"),
      disabled: pickPanel == null,
      run: () => setPickPanel(null),
    },
    {
      /**
       * Escape clears the selection — when nothing is open on top of it.
       *
       * This used to read `picked.size === 0 || chrome.replyTo != null`, and the second
       * clause is the whole story. The reply tests went red the moment a selection survived
       * into the reply editor — "r opened an inline editor but Esc did not close it" —
       * because this VIEW binding outranked the shell's Escape cascade unconditionally and
       * cleared the selection instead. The patch taught this view to name ONE of the
       * shell's overlays, which left the `?` sheet, the ⌘K palette and the screening
       * popover broken in exactly the same way and put the next overlay one line from
       * joining them.
       *
       * The condition is gone because the precedence is stated where precedence lives: the
       * shell's Escape is registered in the `overlay` scope, which outranks every view
       * layer while something is open and stands down when nothing is (`keymap.tsx`). So
       * this binding is once again only about this view — a picked set is the innermost
       * thing the OHBOX has — and it knows nothing about what the shell may be showing.
       */
      chord: "Escape",
      group: "message",
      label: t("keyClear"),
      disabled: picked.size === 0,
      run: clearPicked,
    },
  ];
  useKeyBindings(keys);

  /**
   * SHIFT-CLICK RANGES, intercepted in the CAPTURE phase.
   *
   * `MessageRow` lives in `@ohmail/ui` and its `onClick` takes no event, so the modifier is
   * unreachable from the row itself — and widening a shared design-system primitive for one
   * view's selection model is the wrong trade. Capture runs before the row's own handler, so
   * `stopPropagation` here means a shift-click extends the range INSTEAD of moving the cursor,
   * rather than doing both.
   */
  const onRangeClickCapture = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    if (!e.shiftKey) return;
    const id = (e.target as HTMLElement).closest<HTMLElement>(".row[data-id]")?.dataset.id;
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    pickRangeTo(id);
  }, [pickRangeTo]);

  /**
   * OWN-SENT ROWS NAME THE RECIPIENT — "Me → Nora Lindt", never the writer's own identity.
   *
   * A sent row's `from` is the reader themselves, which is the one fact on the row that says
   * nothing; who it WENT TO is the row's whole context. The first To recipient's display name
   * (their address where there is none), "+N" for the rest, and the circle carries the
   * recipient's initial and hue — the person the row is about. `null` keeps the ordinary
   * sender display: a received row, or a sent row whose mirror predates recipients on the
   * wire (empty `to`) — never "Me →" with nothing after the arrow.
   */
  const sentLabelOf = (m: EngineMessage): { label: string; avatar: { avatarInitial: string; avatarHue: number } } | null => {
    const r = sentRowRecipient(m);
    if (!r) return null;
    const label =
      r.extra > 0
        ? t("rowSentToMore", { name: r.name, count: r.extra })
        : t("rowSentTo", { name: r.name });
    return { label, avatar: sentAvatarOf(r) };
  };

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
        ? t("stateResurface", { when: resurfaceLabel(m.triage.bubbleUpAt) })
        : t("stateResurfaceBare");
    return undefined;
  };

  /**
   * "DONE" ON A PINNED ROW — the deliberate release, standing where the eye looks for it.
   *
   * A resurfaced row's one way out (short of answering it) was a read verb that never said so:
   * `⇧I`, the bar's "Mark as read", a bulk Read. Reported from real use in exactly those terms —
   * "we need a clear action to mark it done, it must be clear how to remove the resurfaced
   * state" — and the question is asked AT THE PIN, so the answer stands on the pinned row itself, in the
   * Screener quick-adjust's own reveal grammar (`MessageRow.actions`, shown on hover, focus and
   * selection; always shown where hover does not exist — see `.rsf-done` in `app.css`).
   *
   * IT DISPATCHES `resurface_done` — the shell's one release arm, shared with the action bar's
   * Done — for THIS row's message, never the selected one, which is why it does not press `⇧I`.
   * The choreography that follows is entirely the existing one: the deliberate `mark_seen`
   * spends the pin first-frame, `lastReadAt` files the row at the top of "Earlier", and
   * `slideOut` draws the descent.
   *
   * NULL, NOT ABSENT, ONCE THE PIN IS SPENT: the slot must survive the 280 ms slide
   * (`MessageRow.actions` — dropping the prop remounts the button and kills the transition),
   * and a control that offered "Done" on a row already released would be a press that does
   * nothing. The rows of the other groups never carry the slot at all.
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
   * READ-STATE AS PRESENTED — the store's flag minus the armed read (see `armedRead`). Used by
   * exactly the surfaces that SHOW read-state: the row's dot/ink and the open message's verb.
   * Everything that acts on or counts read-state (`unreadIds`, mark-all-read, the dwell's and the
   * commit's re-judgements, the slide) keeps reading the store's own flag.
   */
  const effUnread = (m: EngineMessage): boolean => m.unread && m.id !== armedRead;

  /**
   * `actions` is threaded only by the pin group's own mapper below — `row` itself stays unary
   * because it is passed straight to `.map(row)` in two places, where a second parameter would
   * silently receive the INDEX.
   */
  const rowWith = (m: EngineMessage, actions?: ReactNode) => {
    // the conversation's people, computed by the shell's bound selector and never in the row.
    // Only for a threaded row; `[]` for a single-sender thread or none, and the row then leads
    // with the one full-size circle it always did.
    const participants = m.threadId && threadParticipants ? threadParticipants(m.threadId) : [];
    // see `sentLabelOf`: an own-sent row is labelled by its recipient, circle included; the
    // address slot stays empty (the writer's own address is the fact being replaced).
    const sent = sentLabelOf(m);
    return (
    <MessageRow
      key={m.id}
      id={m.id}
      from={sent ? sent.label : senderName(m)}
      address={sent ? undefined : rowAddress(m)}
      {...(sent ? sent.avatar : avatarOf(m))}
      {...rowStamp(m, now, absoluteTime, onToggleTime)}
      subject={m.subject}
      preview={m.protected ? t("protectedPreview") : m.snippet}
      /* As PRESENTED, not as stored: a row whose read is armed drops its dot and its weight the
         moment the reading is established, while the write waits for departure and the row keeps
         its slot. See `armedRead`. */
      unread={effUnread(m)}
      seen={!effUnread(m)}
      selected={selected?.id === m.id}
      // the settling class rides the row for the 280 ms it takes to slide down to "Earlier" —
      // read here, answered, or read on another mail client. See `slideOut`.
      className={settling.has(m.id) ? "settling" : undefined}
      threadCount={m.threadCount}
      /* An own-sent row's LEAD is the RECIPIENT's and stays that way: the row is about the
         person it went to. The strip beside the subject is NOT suppressed with it — the faces
         name who the CONVERSATION is between, which the reader's own reply is one voice of.
         Suppressing them under the Me → label meant a thread lost its people the moment the
         reader answered it (reported against a live two-person exchange); the strip rides the
         subject line, so it takes nothing from the lead. `MessageRow` still draws nothing for
         fewer than two, so a sent singleton is untouched. */
      participants={participants}
      hasAttachment={m.hasAttachments}
      protected={m.protected != null}
      stateNote={stateNoteOf(m)}
      tags={tagsOfMessage(m, tags).map((tag) => ({ name: tag.name, hue: hueOf(tag) }))}
      /* `picked` carries BOTH the styling and the ARIA now — it used to be a
         class name only, so `aria-selected` was set on zero rows and the selection existed
         for sighted mouse users and nobody else. See `MessageRow`. */
      picked={picked.has(m.id)}
      actions={actions}
      onClick={() => {
        if (window.matchMedia("(max-width: 900px)").matches) {
          // Mobile: a tap IS the open — there is no reading column to preview into. `open`
          // selects as well as commits, so the cursor lands here exactly once.
          open(m);
        } else if (selected?.id === m.id) {
          // Second click on the already-selected row: an explicit OPEN, so it is read — and
          // at a split width that is all it is, because the pane beside this list is already
          // showing it. This branch used to catch the FIRST click on the top row of an
          // untouched Ohbox as well, because the implicit fallback had already made it
          // `selected`; with that gone, every row's first click is the `else` below and this
          // means what it says.
          open(m);
        } else {
          selectByUser(m.id);
        }
      }}
    />
    );
  };

  /** The plain row, exactly as it always rendered — safe under `.map(row)`. */
  const row = (m: EngineMessage) => rowWith(m);

  /**
   * THE VOICES A GROUPED ROW SPEAKS FOR — one message per distinct sender, newest first.
   *
   * The unread members while the conversation is waiting (what is unanswered is what the row is
   * for), else the newest member alone once it has all been read.
   *
   * Returns the MESSAGES rather than their names because two things are derived from this list
   * and they must not drift: the sender line ({@link groupSenders}) and the row's lead circles.
   * A row whose text reads "Ada Lund, Bo Ek" and whose faces are somebody else's would be two
   * answers to one question.
   */
  const groupVoices = (g: OhboxRowGroup): EngineMessage[] => {
    const pool = (g.unreadCount > 0 ? g.members.filter((m) => m.unread) : [g.latest])
      .slice()
      .sort((a, b) => sendTimeOf(b) - sendTimeOf(a));
    const seen = new Set<string>();
    const out: EngineMessage[] = [];
    for (const m of pool) {
      const key = m.from.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
    return out;
  };

  /** A grouped row's sender summary: the distinct unread voices, newest first. */
  const groupSenders = (g: OhboxRowGroup): string =>
    groupVoices(g).map(senderName).join(", ");

  /**
   * ONE ROW FOR A CONVERSATION — and a plain {@link row} for anything that did not fold, so a
   * section of singletons renders byte-for-byte as it always has.
   *
   * What the folded row shows and does:
   *   · the conversation's STORED name (server-cleaned; see the `threadSubject` prop), falling
   *     back to the newest member's subject while the thread row has not synced;
   *   · the NEWEST member's snippet and time — a new reply updates the row in place;
   *   · the distinct unread senders on the sender line, THOSE SAME PEOPLE as the row's lead
   *     circles (see `participants` below), and the member count as the `⤷ N` beside the
   *     subject — who and how many, said once each;
   *   · click and ↵ act on the LATEST UNREAD member — the ordinary per-message open, so the
   *     thread view, the dwell and the departure commit behave exactly as for a plain row, and
   *     nothing bulk-marks the folded members read;
   *   · `selected` is row MEMBERSHIP, so the highlight survives the lead message changing;
   *   · `settling` ONLY WHEN EVERY MEMBER IS SLIDING, which is what makes a conversation behave
   *     the way a reader expects when they work through it. The slide is per MESSAGE: read one
   *     of five unread replies and that message alone descends, so the row stands still and its
   *     count goes to four — nothing moves, because the conversation is still waiting. Read the
   *     last one and every member is in flight at once, so the row itself slides and the whole
   *     conversation re-files under "Earlier" as one row. A row that animated on each member
   *     would be five slides for one conversation, four of which end where they started.
   */
  const groupRow = (g: OhboxRowGroup) => {
    if (g.members.length === 1) return row(g.members[0]!);
    const target = g.openTarget;
    const shown = g.latest;
    const voices = groupVoices(g);
    /**
     * THE ROW'S FACES, and they are the SENDER LINE's people whenever there are people on it.
     *
     * Two sources, one precedence, and the order matters. A waiting conversation names its
     * distinct unread senders — so the circles are those senders, from the members the view
     * already holds. A conversation that has all been read names only its newest voice, which
     * is one face and not a conversation, so the row falls back to the mirror's own answer for
     * who is in the thread (`threadParticipants`, newest first) — the whole history, including
     * the members this section is not showing.
     *
     * `MessageRow` draws nothing for fewer than two, which is the same "there is no
     * conversation of people here" both sources already agree on.
     */
    const participants =
      voices.length > 1 ? voices.map(circleOf) : threadParticipants ? threadParticipants(g.key) : [];
    /**
     * THE NEWEST MEMBER IS THE ACCOUNT'S OWN REPLY — the conversation ends, so far, with the
     * reader's own words, and the row says who they went to rather than showing the reader
     * their own name (see `sentLabelOf`). Two arms, one label, never both:
     *   · everything read (the live shape — own-sent is never unread, so a folded reply sits
     *     in an all-read "Earlier" row): the sender line and the LEAD circle are the
     *     recipient's, exactly as on a singleton sent row — the strip beside the subject keeps
     *     the conversation's people either way;
     *   · unread members present: the distinct unread senders own the sender line, unchanged,
     *     and the snippet — which is the reply's — carries the label as its attribution.
     * A reply with no recipients on the row (pre-recipient mirror) is `sent == null`, and the
     * row keeps the ordinary sender summary.
     */
    const sent = sentLabelOf(shown);
    const sentLeads = sent !== null && g.unreadCount === 0;
    return (
      <MessageRow
        key={`t:${g.key}`}
        id={target.id}
        /* The fold SHOWS every member, so anything locating "the row where message X is"
           (the shell's flash after a search jump) must be able to match this row on any of
           them — `data-id` alone named only the lead. See MessageRow.memberIds. */
        memberIds={g.members.map((m) => m.id)}
        from={sentLeads ? sent.label : groupSenders(g)}
        {...(sentLeads ? sent.avatar : avatarOf(target))}
        /* The stamp is the newest member's, in whichever form the list is in — the same message
           the relative stamp has always named, so the exact date on hover is that one's too. */
        {...rowStamp(shown, now, absoluteTime, onToggleTime)}
        subject={threadSubject?.(g.key) ?? shown.subject}
        // see the docblock: the conversation slides only when the whole of it is on its way down.
        className={g.members.every((m) => settling.has(m.id)) ? "settling" : undefined}
        preview={
          shown.protected
            ? t("protectedPreview")
            : sent !== null && !sentLeads
              ? `${sent.label}: ${shown.snippet}`
              : shown.snippet
        }
        /* The fold's own count is true unread (it also picks `openTarget`); the DOT is presented
           state — a conversation whose one unread member is being read right now reads as read.
           See `armedRead`. */
        unread={g.members.some(effUnread)}
        seen={!g.members.some(effUnread)}
        selected={selected != null && g.members.some((m) => m.id === selected.id)}
        threadCount={g.members.length}
        /* the Me → recipient rule wins the LEAD circle and the sender line — not the strip,
           which still names the conversation's people: see the singleton row above. */
        participants={participants}
        hasAttachment={g.members.some((m) => m.hasAttachments)}
        protected={shown.protected != null}
        /* The open target's state, because the target is what the row's click and every verb
           pressed on this row act on — a chip describing some OTHER member would promise a
           toggle the keys cannot deliver. */
        stateNote={stateNoteOf(target)}
        tags={tagsOfMessage(shown, tags).map((tag) => ({ name: tag.name, hue: hueOf(tag) }))}
        picked={g.members.every((m) => picked.has(m.id))}
        onClick={() => {
          if (window.matchMedia("(max-width: 900px)").matches) {
            open(target);
          } else if (selected != null && g.members.some((m) => m.id === selected.id)) {
            open(target);
          } else {
            selectByUser(target.id);
          }
        }}
      />
    );
  };

  /**
   * ═══ DRAG-TO-FILE — what a row's drag STANDS FOR, and what a drop DISPATCHES ═══════════
   *
   * The gesture lives in `shell/drag-file.ts`; these two closures are the semantics, and
   * they are deliberately thin because every arm is an EXISTING verb:
   *
   *   · a picked row drags the whole selection and a drop is `runBulk` — the bulk bar's own
   *     commit, selection-clear included;
   *   · a lone row is the pill's `onAction`, verbatim;
   *   · a folded conversation outside the selection is the bulk fan-out over its members —
   *     the row says "⤷ 5", so the drop acts on five, exactly as a pick of that row would;
   *   · a tag drop is the picker's apply (`onDropTag` → `bulkToggleTag`, apply-direction).
   *
   * Fresh closures each render, read through the hook's ref at use time — nothing here can
   * run stale, and nothing is memoised for a gesture that happens at hand speed.
   */
  const dragSourceFor = (rowId: string): DragSource | null => {
    const idx = rowIndexOf(rowId);
    if (idx < 0) return null;
    const g = navRows[idx]!;
    const members = g.members;
    const selection = picked.size > 0 && members.every((m) => picked.has(m.id));
    const ids = selection ? pickedIds : members.map((m) => m.id);
    const messages = ids
      .map((id) => byId.get(id))
      .filter((m): m is EngineMessage => m != null);
    if (messages.length === 0) return null;
    // The ghost wears what the ROW shows — same sender line, same subject — so what is in
    // hand is recognisably the thing that was picked up.
    const shown = members.length > 1 ? g.latest : members[0]!;
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
      const m = byId.get(source.ids[0]!);
      if (m) onAction(target.action, m);
      return;
    }
    bulk.run(target.action, source.ids);
  };

  const drag = useDragToFile({ sourceFor: dragSourceFor, onDrop: onRailDrop });

  return (
    <section
      className="view split view-ohbox"
      onClickCapture={onRangeClickCapture}
      onPointerDownCapture={drag.onPointerDown}
    >
      <ListPane
        title={t("title")}
        scrollerRef={listScrollerRef}
        /* "0 new" IS A CLAIM ABOUT THE MAILBOX, not a description of the
           list — and its predecessor ("0 unread of 0 messages") was on screen, beside
           "Nothing in your Ohbox.", over an account that
           was not empty, for as long as the first drain took. While the mirror has not
           been read there is no count to state, so none is stated: no dash, no zero, no
           substitute. A count that returns the moment there is one to give is not a gap; a
           wrong count is a lie. Any NON-zero total is a real observation whatever the drain is
           doing, so only the empty case is withheld.

           THE FORM IS THE READS HEADER'S — "{count} new", one compact line with the action
           right-aligned beside it: the long "unread of N messages" tail made the header wrap
           to three lines. The fuller noun sentence — an earlier report asked the two header
           counts to name their nouns — lives on in the rail tooltip (`rail.ohboxTitle`),
           which still says "N unread of M messages". */
        meta={
          !settled && all.length === 0
            ? undefined
            : t("meta", { count: unreadIds.length })
        }
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
            {!settled && doorbellCount === 0 ? null : (
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
            {/* THE SELECTION AFFORDANCE, ABOVE THE SCROLLER.
                It used to be the scroller's first child, so the count and the bulk action
                scrolled off the moment you picked something forty rows down — the state was
                unknowable exactly when it mattered most. `ListPane`'s `header` slot is
                documented for a bulk bar; this is the bulk bar.

                Still a plain bar in this view rather than a `@ohmail/ui` primitive: nothing
                else in the product has a multi-select, and a component invented for one
                caller is a guess about the second one.

                `role="status"` so the count is ANNOUNCED as it changes, not merely present. */}
            {picked.size > 0 ? (
              <div className="pick-bar" role="status">
                <span>{t("picked", { count: picked.size })}</span>
                <BulkBar
                  ids={pickedIds}
                  panel={pickPanel}
                  onPanel={setPickPanel}
                  onRun={runBulk}
                  onMarkSeen={markPicked}
                  bulk={bulk}
                  onDone={clearPicked}
                />
                <button type="button" className="quiet" onClick={clearPicked}>
                  {t("pickedClear")} <Kbd>esc</Kbd>
                </button>
              </div>
            ) : null}
          </>
        }
        /* The strip used to spell the whole keymap out ("j k move · ↵ read · t tag …") and,
           being clamped to one line, CLIPPED mid-word whenever this pane shared the window
           with the reading column. One affordance now — the key that opens the generated
           sheet. The bindings themselves are unchanged, declared in `keys` above. */
        hints={<ShortcutHint />}
      >
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
            heading-over-nothing rule, kept as the window slides. */}
        {/* RESURFACED — pinned at the very top under its own quiet label, whole and outside
            the window (a scheduled set is small). It is a different claim from "New for you": not
            "this arrived" but "you asked to see this again now", so it earns its own heading rather
            than being folded in. Reading one clears the pin server-side (`MessageService.markSeen`),
            and the row slides down to "Earlier" on the same mechanism a read row in "New for you"
            does — but only once the selector actually files it there, which is the whole reason the
            slide keys on section membership rather than on the read flag (see `earlierIds`). Until
            that answer arrives the row stays pinned, read, exactly where the reader left it.
            Each pinned row carries the "Done" release control — see `doneFor`. */}
        {displayResurfaced.length > 0 ? (
          <>
            <ListGroupLabel>{t("resurfacedGroup")}</ListGroupLabel>
            <ListRows multiSelectable ariaLabel={t("resurfacedGroup")}>
              {displayResurfaced.map((m) => rowWith(m, doneFor(m)))}
            </ListRows>
          </>
        ) : null}
        {win.padTop > 0 ? <div aria-hidden style={{ height: win.padTop }} /> : null}
        {groupedNew.length > 0 && newTo > newFrom ? (
          <>
            <ListGroupLabel>{t("newForYou")}</ListGroupLabel>
            <ListRows multiSelectable ariaLabel={t("newForYou")}>{groupedNew.slice(newFrom, newTo).map(groupRow)}</ListRows>
          </>
        ) : null}
        {groupedPrev.length > 0 && prevTo > prevFrom ? (
          <>
            <ListGroupLabel>{t("previouslySeen")}</ListGroupLabel>
            <ListRows multiSelectable ariaLabel={t("previouslySeen")}>{groupedPrev.slice(prevFrom, prevTo).map(groupRow)}</ListRows>
          </>
        ) : null}
        {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
        {/* the account's own sent mail rides "Earlier" now, but only the most recent slice of
            it (the `DEFAULT_SENT_HISTORY_MESSAGES` ingest window). Say so rather than let the list
            imply it holds every message ever sent — older sent mail is on the server, reachable
            through Search. Shown only when sent mail is actually present in the window below.
            COPY-SHIM: inline literal pending an `en.json` key. */}
        {hasOwnSent ? (
          <div className="tail-row">Your recent sent mail is included above. Older sent mail stays on your server — find it in Search.</div>
        ) : null}
        {/* The view's own fact — this list is empty — combined with a state derived once, up
            in the shell. `doorbellCount` is the Screener's waiting count, already a prop. */}
        {all.length === 0 ? <SyncState waiting={doorbellCount} settled={settled} /> : null}
        {/* MAIL FROM BEYOND WHAT THIS DEVICE KEPT.

            Rendered BELOW the local window and under its own group label, because that is what
            it is: rows that came from the server a moment ago and are not in the mirror. They
            are not merged into "Earlier" — a reader who scrolls past the label has been told
            where the boundary is, and a list that hid it would be claiming the device holds
            more than it does.

            They carry the mirror's own row wherever it has one (see `older-mail.ts`), so a
            message somebody files here behaves exactly like one above the line. */}
        {older.items.length > 0 ? (
          <>
            <ListGroupLabel>{t("olderTitle")}</ListGroupLabel>
            <ListRows multiSelectable ariaLabel={t("olderTitle")}>{older.items.map(row)}</ListRows>
          </>
        ) : null}
        {/* THE TAIL, AND IT SAYS THREE DIFFERENT TRUE THINGS DEPENDING ON THE CLIENT.

            The demo keeps its own sentence. "Older mail stays on your server — find it in
            Search." is true of Mila's fixture world, a hand-made slice of a mailbox with a
            beginning; there is no server behind it to load anything from.

            A client that keeps the WHOLE mailbox — the standalone desktop client — gets
            nothing at all. Its list ends where its mail ends, and an affordance to load more
            would be an offer it cannot keep. That is `older.available === false`, read from the
            engine rather than guessed from the mode.

            A windowed client gets the control and a sentence that says what it is offering.
            That sentence used to be shipped to live accounts as a claim, unconditionally, and
            it was FALSE then: the mirror held every message, so telling a paying customer their
            old mail was somewhere else was a claim the code contradicted. It is true now, of
            this client, because the mirror is a window — and it comes with the way back rather
            than with a suggestion to go and search.

            The no-collapse rule — never an "N more" count standing in for mail — is satisfied
            throughout: every message is a real
            row, above the line or below it.

            ── AND IT WAITS FOR THE MIRROR TO HAVE BEEN READ ────────────────────────────────

            `settled` gates the whole windowed arm, for the reason `SyncState` above it is gated
            and it is the same defect one block further down the pane. Reported on first open:
            "Nothing in your Ohbox. This device keeps your recent mail. The rest is on your
            server. Load older mail", for up to a minute, and then the mail arrived. The first
            sentence was already withheld; these two were not, because they were gated on the
            CLIENT SHAPE — "is this mirror a window" — which is a build-time fact and true from
            the first frame. Being a window is not the claim being made. "This device keeps your
            recent mail" says where the reader's mail IS, which is exactly the class of statement
            {@link MailState.settled} exists to hold back: before the first drain the mirror holds
            nothing, so "recent mail" has no referent and the sentence is false in the ordinary
            reading of it. And `olderAction` is worse than a false statement, it is a wrong
            INSTRUCTION — the newest mail is in flight, and the only control on the pane points
            backwards, past it, at a page the reader has not been shown yet.

            The cost is that a RETURNING tab, whose hydrated mirror is on screen before its drain
            lands, loses the tail for the length of that drain. That is a control appearing at the
            bottom of a list a second later, which is the cheap side of this trade: the alternative
            is stating where somebody's mail is kept before having looked. Nothing about the window
            is hidden for good — `SyncBar` is saying what is happening the whole time, and the
            sentence and its control return together the moment there is a drained mirror to
            describe. */}
        {demo ? <div className="tail-row">{t("tail")}</div> : null}
        {!demo && older.available && settled ? (
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
                <span className="mbx-spin" aria-hidden="true" />
                {t("olderLoading")}
              </span>
            ) : (
              <>
                {/* THE HONEST COVERAGE LINE. Three states, and the one that must never be
                    guessed is `exhausted`: "That is everything on your server" is a claim about
                    somebody's whole mailbox, and it is said only because the server answered a
                    page with no cursor after it. An empty page, a refusal and a network failure
                    are all different, and none of them says this. */}
                {older.items.length > 0
                  ? t("olderShowing", { count: older.items.length })
                  : t("olderPrompt")}{" "}
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
          that passed it. Below 900px the column is `display:none`, so that button was
          reachable at exactly the widths where the sheet duplicates the pane it is standing
          on — a control whose only outcome was the defect. The reader is not lost: it is
          what "opened" means where there is no column, which is the shell's `enterReader`. */}
      <ReadColumn>
        {selected ? (
          <MessagePane
            /* The pane derives its read-state verb from `message.unread`, so the open message
               travels with its PRESENTED state: an armed read offers "Mark unread" — the only
               honest action on a message that is being read — while the store's flag waits for
               the departure write. See `armedRead`; the shell does the same for the reader
               sheet via `onReadArmed`. */
            message={selected.unread && !effUnread(selected) ? { ...selected, unread: false } : selected}
            tags={tags}
            now={now}
            onAction={(a) => {
              /* The pane's read-state buttons press `u`/`⇧I` and fall back to `onAction("unread")`
                 — a FLIP — only where no keymap answers. A flip resolved ABOVE this view would
                 derive from the store's flag and invert the verb on an armed message, and it
                 would skip the pin/promote/armed machinery either way. So the fallback is routed
                 through the same two directions the keys take; everything else passes through. */
              if (a === "unread") {
                if (effUnread(selected)) markRead(selected);
                else markUnread(selected);
                return;
              }
              onAction(a, selected);
            }}
            onAddTag={onAddTag}
          />
        ) : all.length > 0 ? (
          /**
           * ═══ THE RESTING COLUMN ═══════════════════════════════════════════════════════════
           *
           * What the reading column says when nothing is open, which since the two fallbacks
           * were deleted is what it says on arrival. A blank panel here would read as a pane
           * that failed to load; this one names the state and says how to leave it.
           *
           * It is the `.empty` shape every other pile's empty state already uses — glyph,
           * title, one line — so an unfamiliar column is answered in a vocabulary the reader
           * has met in the Screener, in a tag and in Search. Nothing more is put in it:
           *
           *   · NO UNREAD COUNT. The list header beside it already states one, and a number
           *     restated two panels apart is a number that will eventually disagree with
           *     itself.
           *   · NO SECOND KEY LEGEND. The `?` sheet is the one list of the bindings, and the
           *     pane foot already carries the affordance that opens it (`ShortcutHint`). One
           *     `<kbd>j</kbd>` in the sentence is a pointer at a key, not a copy of the map.
           *   · NO `role="status"`. This is not an announcement of something that changed; it
           *     is what the region contains at rest. It becomes a live region the moment a
           *     screen reader is told it changed, and every `j` would then read out a panel the
           *     reader is not in.
           *
           * AND ONLY WHEN THERE ARE ROWS. An empty Ohbox already says it is empty, in the list
           * — the Screener's show-once rule. "Nothing open." beside "Nothing in your Ohbox." is
           * one absence stated twice, so with no rows the column stays empty and the list's own
           * sentence is the only one. Mobile needs no arm of its own: `app.css` puts
           * `display:none` on this column under 900px, where a tap IS the open.
           */
          <div className="empty">
            <span className="glyph" aria-hidden="true">✉</span>
            <b>{t("emptyRestTitle")}</b>
            {t.rich("emptyRestHint", { kbd: (chunks) => <Kbd>{chunks}</Kbd> })}
          </div>
        ) : null}
      </ReadColumn>
    </section>
  );
}

/**
 * ═══ THE SELECTION'S ACTION BAR ════════════════════════════════════════════════════════
 *
 * The requirement: a selection must offer more than mark unseen, mark read and Escape — it
 * needs the sender's screening and its tags too.
 *
 * ── IT IS THE MESSAGE BAR'S GROUPING, NOT A SECOND VOCABULARY ─────────────────────────
 *
 * The message action bar established what these verbs are and how they group, and the classes
 * below are that bar's own (`action-bar.css`): one segmented control for the three horizons, two filing
 * verbs adjacent because they answer the same question at two scopes, the read state apart
 * from the verbs, and a More panel that REPLACES the row rather than growing it. A second
 * grouping invented for bulk would mean the same five verbs sit in two different orders
 * depending on how many messages you have selected, which is the kind of thing a user
 * experiences as the app changing its mind.
 *
 * Two deliberate divergences, both forced:
 *
 *   · **No Reply.** There is no such act over eleven messages. The leading slot the accent
 *     verb occupies is taken by Tag, which is the instant, reversible verb here.
 *   · **Read and Unread are two buttons, not a switch.** `role="switch"` reports a current
 *     state, and a selection has a mixed one; a toggle over it would mark six read and five
 *     unread in a gesture that reads as one decision.
 *
 * ── AND SCREENING GETS A CEREMONY THE OTHERS DO NOT ───────────────────────────────────
 *
 * Everything else here is a mail operation on the messages you picked. Screening is a
 * decision about SENDERS: for a sender still waiting at the gate it promotes a rule that
 * governs all their future mail, and it moves every message that sender has in the mirror,
 * not only the ones in the selection. So it is two steps — pick a destination, then a row
 * that states the senders, the messages and the rules before anything is dispatched.
 *
 * **There is no undo, and that is why the confirm row exists.** `POST /screener/:id` has no
 * inverse, so an Undo affordance would either do nothing or move the mail back
 * while the rule it created stood — a control that lies about what it reversed. Stating the
 * counts before committing is the honest version of the same protection.
 */
function BulkBar({
  ids,
  panel,
  onPanel,
  onRun,
  onMarkSeen,
  bulk,
  onDone,
}: {
  ids: string[];
  panel: PickPanel | null;
  onPanel: (next: PickPanel | null) => void;
  onRun: (action: BulkAction) => void;
  /** Mark-read keeps its own path: ⇧U's handler, so the bar and the key are one call. */
  onMarkSeen: () => void;
  bulk: BulkVerbs;
  onDone: () => void;
}) {
  const t = useTranslations("ohbox");
  const tr = useTranslations("screening");

  const defer = (
    <>
      <button type="button" className="abar-b" onClick={() => onRun("later")}>
        {t("actionLater")}
      </button>
      <button type="button" className="abar-b" onClick={() => onRun("aside")}>
        {t("actionSetAside")}
      </button>
      <button type="button" className="abar-b" onClick={() => onRun("resurface")}>
        {t("actionResurface")}
      </button>
    </>
  );

  const file = (
    <>
      <button type="button" className="abar-b" onClick={() => onPanel({ kind: "screen" })}>
        {tr("action")}
      </button>
      <button type="button" className="abar-b" onClick={() => onPanel({ kind: "move" })}>
        {t("actionMove")}
      </button>
    </>
  );

  const tagButton = (anchorClass: string) => (
    <button
      type="button"
      className={anchorClass}
      onClick={(e) => {
        bulk.tag(ids, (e.currentTarget as HTMLElement | null) ?? null);
        onDone();
      }}
    >
      {t("tagChip")}
    </button>
  );

  if (panel?.kind === "move" || panel?.kind === "screen") {
    const screening = panel.kind === "screen";
    return (
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
              bulk.screen(ids, panel.dest);
              onDone();
            }}
          >
            {tr("bulkCommit")}
          </button>
          <button type="button" className="abar-b" onClick={() => onPanel({ kind: "screen" })}>
            {t("moveCancel")}
          </button>
        </div>
      </div>
    );
  }

  if (panel?.kind === "more") {
    return (
      <div className="abar">
        <div className="abar-panel">
          <span className="abar-lab">{t("actionMore")}</span>
          <span className="abar-pg abar-p-defer">{defer}</span>
          <span className="abar-pg abar-p-file">{file}</span>
          <button type="button" className="abar-b" onClick={() => onPanel(null)}>
            {t("moveCancel")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="abar">
      <div className="abar-row">
        <div className="abar-g">{tagButton("abar-b abar-solo")}</div>

        <div className="abar-g abar-seg abar-defer" role="group" aria-label={t("groupDefer")}>
          {defer}
        </div>

        <div className="abar-g abar-seg abar-file" role="group" aria-label={t("groupFile")}>
          {file}
        </div>

        <div className="abar-g abar-read-g">
          <span className="abar-g abar-seg" role="group" aria-label={t("groupRead")}>
            <button type="button" className="abar-b" onClick={onMarkSeen}>
              {t("pickedMarkSeen")} <Kbd>⇧U</Kbd>
            </button>
            <button type="button" className="abar-b" onClick={() => onRun("unread")}>
              {t("pickedMarkUnseen")}
            </button>
          </span>
          <button
            type="button"
            className="abar-b abar-solo abar-more"
            aria-haspopup="true"
            aria-expanded={false}
            aria-label={t("actionMore")}
            title={t("actionMore")}
            onClick={() => onPanel({ kind: "more" })}
          >
            <Icon name="chev" size={12} className="abar-chev" />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * WHY AN EMPTY OHBOX IS EMPTY — the one answer that is this VIEW's to give.
 *
 * ── WHAT THIS PANE USED TO DO, AND WHY IT WAS SILENT FOR HALF AN HOUR ────────────────────
 *
 * A live count was put here — "Syncing your mailbox · 3 messages so far" — gated on
 * `SyncStatus.bootstrapping`. That gate is the defect. `bootstrapping` means "this TAB's first
 * drain has not completed", and a fresh account's first drain completes in seconds against an
 * empty server-side mirror. The WORKER's first import is a different clock entirely: minutes
 * on a mailbox of any size, and tens of minutes on a full one. So the counter switched itself off within
 * seconds and the pane then said nothing at all for the entire import — which is exactly the
 * half hour a first import spends saying "Waiting for first sync" somewhere else.
 *
 * The counter therefore MOVED, and moved UP: it is `SyncBar`'s `importing` state now, keyed on
 * the mirror actually growing (`shell/mail-state.ts`) rather than on a tab-local boolean, and
 * rendered above the deck so it is visible in Reads, Receipts and the Screener too. This is
 * the same lesson a second time — a view can only speak about itself, and "your mail is arriving"
 * is not a fact about the Ohbox.
 *
 * ── WHAT IS LEFT HERE, AND WHY IT BELONGS HERE ──────────────────────────────────────────
 *
 * One thing: an empty Ohbox that is CORRECT. A fresh account is mostly Screener by design, so
 * the true sentence is "nothing has reached the Ohbox because every sender so far is new" —
 * and that is a statement about THIS list, which no shell-level strip may make. Rendered above
 * the deck it would tell somebody standing in the Screener that everything is in the Screener.
 *
 * The split is: `mail-state.ts` derives `screenerCandidate` (mail landed, mirror settled,
 * nothing wrong), ONCE, for everybody. This pane contributes the only fact it owns — that its
 * own list is empty — and renders. **It does not re-derive.**
 *
 * That last rule is why this pane reads no `SyncStatus` field itself. It used to say
 * "`bootstrapping`, `failures` and `terminal` are deliberately no longer read here", which
 * described the mechanism rather than the rule and is no longer true of the second half of what
 * this pane says. It reads {@link MailState.settled}, which is derived from `bootstrapping` and
 * from the ladder's own verdict, ONCE, up in `mail-state.ts`. The argument is untouched: what
 * was wrong was a COUNTER gated on a tab-local boolean that goes false in seconds while the
 * worker's import runs for minutes. Progress still keys on the mirror growing and still lives in
 * the strip. Seconds is exactly the right length for the different question asked here.
 *
 * ── AND THE THIRD STATE THIS PANE USED TO COLLAPSE ──────────────────────────────────────
 *
 * "Empty" and "not looked yet" were one rendering, so a slow connection showed "no messages".
 * The mirror persists in IndexedDB and the client's own first drain had not finished, so
 * `Nothing in your Ohbox.` was a statement about mail the app had simply not read yet. Before the mirror has been read there is no emptiness to report, so this pane reports
 * what is actually happening instead — after {@link LOADING_GRACE_MS}, so a fast connection
 * still gets the silent frame it always had rather than a sub-second flash.
 *
 * **It says the app is loading, never what it will find.** A placeholder row, an invented count
 * or a skeleton shaped like mail would answer this defect by creating the one this product
 * treats as unforgivable.
 *
 * ── AND THE LINE THAT RULE ACTUALLY DRAWS ───────────────────────────────────────────────
 *
 * It is about CONTENT, not about shape, and the difference is the whole of what may be added
 * here. A bar as long as a real subject line is a claim about that subject; a row carrying a
 * name is a claim about a sender; a count invented to fill a slot is the worst of the three. All
 * three remain forbidden. `BootSkeleton` below is on the other side of that line by
 * construction: zero text nodes, `aria-hidden`, and a fixed width table that is derived from
 * nothing — so there is nothing in it that could be mistaken for this mailbox, because there is
 * nothing in it at all. It draws where the list is about to be, and the sentence above it stays
 * the only thing on this pane that says anything. `test/boot-skeleton.test.tsx` holds that boundary
 * as a structural assertion rather than as this paragraph.
 *
 * The demo and the Desktop never reach the `screenerCandidate` arms — the derivation returns the
 * resting value for a fixtures engine before it looks at anything else — and `settled` is true
 * for them for the same reason: a fixtures engine is permanently settled.
 */
function SyncState({ waiting, settled }: { waiting: number; settled: boolean }) {
  const t = useTranslations("ohbox");
  const { state } = useMailState();
  const speak = useLoadingGrace(!settled);

  /* THE MIRROR HAS NOT BEEN READ, so this list is not empty — it is unknown. Above every arm
     below, because both of them state something about mail that has arrived. */
  if (!settled) {
    return (
      <div className="empty" role="status" aria-busy="true">
        {/* `.mbx-wait` and not a bare span: `.mbx-spin` sizes itself with `width`/`height` and
            is a `<span>`, so it needs a flex parent or the border collapses to a dot. That
            pairing — spinner beside one muted line — is exactly what `.mbx-wait` already is
            (`app.css`, beside the Settings rows), and reusing it adds no CSS and inherits the
            `prefers-reduced-motion` answer the ring already has. Same reuse `SyncBar` makes,
            for the same reason and with the same note about the `mbx-` prefix. */}
        <span className="mbx-wait">
          <span className="mbx-spin" aria-hidden="true" />
          {speak ? <b>{t("loading")}</b> : null}
        </span>
        {/* The column's own geometry, under the sentence, on its own shorter grace — see the
            header above for why a contentless silhouette is not the placeholder this pane
            forbids. `rail` is deliberately off: in a browser tab the rail is real, populated and
            already on screen a few pixels to the left, and a second fake one beside it would be
            describing a layout the reader can see is not there. */}
        <BootSkeleton active={!settled} />
      </div>
    );
  }

  /* ── AND WHEN THERE IS NO EXPLANATION, SAY THE FACT ANYWAY ────────────────────────────
   *
   * `screenerCandidate` is false for the whole of a first sync — it requires mail to have
   * landed and the mirror to have settled — so outside the demo this returned `null` for the
   * whole of the first import, which is the stretch that matters most, and the pane rendered NOTHING. Combined with the group labels
   * above, an empty Ohbox was literally the two words "New" and "Earlier" on an otherwise blank
   * column, which reads as a broken screen rather than an empty one.
   *
   * The sentence is bare on purpose. `SyncBar` is directly above this pane and it is the one
   * place allowed to say WHY the list is empty — it is the only surface that has derived it,
   * and it is already saying "Connected. The first sync has not finished yet." or "Not
   * syncing — …" or nothing at all. Repeating any of that here would reintroduce the same
   * defect: a view speaking about something that is not a fact about this view. What this
   * pane owns is "this list is empty", which is true in every one of those states.
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
