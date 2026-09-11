"use client";

/**
 * Ohbox — the two-pane accepted-mail view: grouped list (New / Earlier)
 * against the engine's ohboxView selector, the Screener
 * doorbell, and the reading column. j/k moves, ↵ opens the reader,
 * t opens the tag picker, x picks, u toggles unread.
 */
import * as React from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useRowBadgeCopy } from "../shell/row-copy";
import { isOwnSent, isResurfaced, presentsUnread } from "@ohmail/client-engine";
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
  Spinner,
} from "@ohmail/ui";
import { MarkAllRead } from "../components/MarkAllRead";
import { ShortcutHint } from "../shell/ShortcutHint";
import { readColumnHidden } from "../shell/narrow";
import { groupSection, sendTimeOf, singletonGroup, type OhboxRowGroup } from "./ohbox-groups";
import { PLACE_LABEL, avatarOf, resurfaceLabel, rowAddress, rowStamp, senderName, sentAvatarOf, sentRowRecipient, tagsOfMessage, hueOf } from "../shell/format";
import { useKeyBindings, type KeyBinding } from "../shell/keymap";
import { useZoneNav } from "../shell/zone-nav";
import { useListWindow } from "../shell/list-window";
import { BootSkeleton } from "../shell/BootSkeleton";
import { useLoadingGrace } from "../shell/loading-grace";
import { useMailState } from "../shell/MailStateProvider";
import type { OlderMail } from "../shell/older-mail";
import { Key, MessagePane, MOVE_TARGETS, type BulkAction, type MessageAction, type MoveTarget } from "../shell/MessagePane";
import { MoreMenu, type MoreMenuItem } from "../shell/MoreMenu";
import { isModalOpen } from "../shell/modal-gate";
import { useBarDensity } from "../shell/bar-density";
import { DRAG_SLOP_PX, useDragToFile, type DragSource, type RailDropTarget } from "../shell/drag-file";
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
  /**
   * Run a verb over the ids. `false` means it was REFUSED at the press and nothing was
   * dispatched — a reader's Move, Screening or Delete — so the caller keeps the selection
   * rather than clearing it. A set thrown away by a press that did nothing is a set the
   * person has to rebuild before they can try the verb that would have worked.
   */
  run: (action: BulkAction, ids: string[]) => boolean;
  tag: (ids: string[], anchor: HTMLElement | null) => void;
  screenPreview: (
    ids: string[],
    dest: ScreeningDest,
  ) => { senders: number; messages: number; rules: number };
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
type PickPanel =
  | { kind: "move" | "screen" | "delete" }
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
 * How long a finger must rest on a row before it starts a selection.
 *
 * 450ms is the figure both mobile platforms use for the same gesture, and the two directions of
 * error are not symmetric: shorter and a tap that lingers picks a row somebody meant to open;
 * longer and the gesture feels like a wait rather than a press. A constant and not a setting —
 * a knob here would be a knob about whether a tap means what it says.
 */
const LONG_PRESS_MS = 450;

/**
 * The document the press landed in — `e.view` first, so a press inside a portal or a second
 * window is judged against the tree it actually happened in rather than this module's global.
 *
 * Module scope: it closes over nothing in the view, and rebuilding it per render would put a
 * fresh function into a binding's `when` on every keystroke anywhere in the app.
 */
const deleteDoc = (e: KeyboardEvent): Document =>
  (e.view as (Window & typeof globalThis) | null)?.document ?? document;

/**
 * How long a row slides before it re-files under "Earlier": long enough to
 * read as a deliberate move, short enough that the row is gone from "New
 * for you" by the time attention returns. Matches the `.row.settling`
 * transition in `row.css`; reduced-motion devices get no transition and the
 * row simply moves on the render this timer schedules. One constant for
 * every departure from "New for you" — a settled reply, an in-app read, a
 * `\Seen` from another client: one gesture, three causes, one mechanism
 * (`slideOut`).
 */
const SETTLE_MS = 280;

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

export function OhboxView({
  demo,
  replyDone,
  noticeSection,
  standingNotice,
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
   * The armed read, reported upward — `id` while a message's read is armed
   * but not yet written, `null` when the debt is spent or torn up. An armed
   * read PRESENTS as read ({@link commitPendingRead}, `effUnread`), and the
   * mobile reader sheet is the SHELL's `MessagePane`, so its verb would go
   * on deriving from the not-yet-written store flag without this channel.
   * A report of view-local fact, never a second writer of read-state.
   * Optional: a harness mounted without it has no sheet to inform.
   */
  onReadArmed?: (id: string | null) => void;
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
  const rowBadge = useRowBadgeCopy();
  /* The reading column's region name — shared vocabulary with every split view, so the
     screen-reader landing (`ReadColumn regionLabel`) says the same thing everywhere. */
  const tReader = useTranslations("reader");

  /**
   * Session-scoped placement, and the slide that ends it. Two refs, one per pinned upper group, reconciled at
   * render (the value must be right for the render that reads it): a row keeps its slot; a live arrival INSERTS
   * at the selector's slot — the top for genuinely new mail (appending filed every post-mount arrival at the
   * bottom; reported). A read message leaves "New for you" NOW — keeping read rows made a read mailbox look
   * unread all session: the moment the selector re-files a row it slides (`SETTLE_MS`) and `dismissed` releases
   * its slot. The one unmoved row is the message being read — reading commits on the way OUT ({@link
   * commitPendingRead}). `promoted` is the reverse move: an explicit mark-unread enters at the FRONT of New and
   * cancels a slide in flight — the later explicit act wins, immediately.
   */
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [promoted, setPromoted] = useState<Set<string>>(() => new Set());
  const [settling, setSettling] = useState<Set<string>>(() => new Set());
  const resurfacedOrder = useRef<string[]>([]);
  const newOrder = useRef<string[]>([]);
  /** Slides in flight, id → timer handle. Cancelled by `promote` and by unmount. */
  const slideTimers = useRef<Map<string, number>>(new Map());

  /**
   * Record an explicit "this is unread again" for one or more ids (see `promoted`). Four
   * halves, none housekeeping: the id joins the promote set so the next reconcile leads New
   * with it; the slide timer is torn up and `settling` comes off, so a row caught mid-descent
   * stops where it is; and it leaves `dismissed`, so a completed slide cannot keep filtering it
   * out of the order it is being promoted into. NOT pruned when a row leaves the Ohbox: the set
   * is bounded by explicit acts in one session and a held id is inert once the row is in the
   * New order — a prune would be a second writer of the same fact for no behaviour.
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
   * The rows the selector now files under "Earlier" — the predicate the slide turns on.
   * Membership of `previouslySeen`, NOT `m.unread === false`: a resurfaced row that has been
   * read still belongs at the top — the pin, not the read state, decides that group, and
   * sliding on the read flag would drop it into a section that does not contain it (a row that
   * vanishes until the server catches up). The question asked is the one the answer depends on:
   * does the selector say this row's place is now "Earlier"? Every cause — in-app read,
   * answered message, adopted `\Seen` — reaches this view as the same re-partition.
   */
  const earlierIds = useMemo(() => new Set(previouslySeen.map((m) => m.id)), [previouslySeen]);

  /**
   * The stable merge: where a fresh id enters the session order — before the first kept row the
   * selector ranks after it (for New: date desc, so a genuinely new arrival enters at the top), at
   * the end when none. A merge, not a re-sort: kept rows never move relative to each other, and an
   * OLD unread arrival (a backfill, a foreign mark-unread) files at its date slot. The rank is the
   * id's index in `current`, the selector's own output. `lead` is the promote block: explicit
   * unreads go to the front; once placed they are kept rows. A dismissal is spent when the selector
   * stops filing the row under "Earlier" (`dropped`) — a permanent one would swallow the way back
   * for mail marked unread elsewhere.
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
     * One pass, not one scan per fresh id: the naive splice is
     * O(kept × fresh), maximised by the most ordinary case — a cold mount,
     * where every id is fresh and a large unread group costs millions of
     * rank lookups inside a render. A two-pointer merge is equivalent
     * because the anchor is monotonic: `fresh` ascends in rank, so "the
     * first kept row with rank > r" only moves down the list as r grows,
     * and a kept row skipped for one fresh id is skipped for every later
     * one. Nothing is revisited.
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
   * The pin claims a row out of the session orders — the display half of the selector's dedup. The selector
   * never shows one message twice; the session orders could: a "Resurface now" on a row sitting in New put
   * its id into `resurfacedOrder` while `newOrder` kept holding it, and the message rendered twice until a
   * reload. Each upper order is pruned to agree with the SELECTOR about which section owns the id:
   * `newOrder` never holds a pinned id; `resurfacedOrder` holds a pinned id OR one re-filed under "Earlier"
   * — the slide's lease, kept for `SETTLE_MS`. An id in neither (a rolled-back pin on an unread row) is
   * released to New immediately. Pruning the ORDERS, not the display lists, keeps `upper` honest too; what
   * is lost is only the row's old position across an unpin.
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
   * One row per conversation, per section. Five unread replies in one thread were five rows in
   * "New for you". `groupSection` (`ohbox-groups.ts`) folds each section's DISPLAY list — after
   * session placement, so a fold never fights the session order — into one row per `threadId`.
   * New and Earlier fold independently; resurfaced rows stay per-message (each pin is its own
   * "you asked to see this again"); the server-paged Older tail is not this client's to fold.
   * Messages remain the unit of everything but the rows: the meta count, mark-all-read,
   * read-state and the pick set keep message semantics — a grouped row is a rendering and a
   * keyboard stop, not a new entity.
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
   * The list is a window over `[New for you, Earlier]`: a mirror window still holds thousands
   * of rows, and grouped `.map(row)` mounted every accepted row — the unbounded cost
   * History was windowed for. The two groups keep their own `role="listbox"` containers, each
   * rendering its share of the window with reserved height above and below; the Older tail is
   * server-paged and stays whole. The Ohbox writes no `\Seen` on scroll (read-state is the
   * dwell), so no observer re-scan is needed; the split reader reads `selected` from `all` by
   * id, so a pick survives its row scrolling out. Resurfaced rows are not windowed — a small
   * pinned set rendered whole at the top.
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
   * Reveal a selection the window has not mounted — the search jump's landing. `openMessage`
   * sets the cursor and navigates, but the row only EXISTS if the window mounted it, and the
   * window mounts the top: a hit on anything deeper arrived at a resting list — no row, no
   * flash, nothing connecting click to arrival. Scrolling the scroller is the fix the window is
   * built for: the slice derives from `scrollTop`, so putting the row's offset in view mounts
   * it and the locate pass flashes it. Keyed on the selection, a no-op when already mounted,
   * never runs on scroll; resurfaced rows render whole and return early.
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
      /* A REFUSAL KEEPS THE SELECTION. Clearing afterwards is right for a verb that HAPPENED —
         the rows have been dealt with, and a set that survived would invite a second
         application of it. A reader's Move, Screening or Delete does not happen: `run` answers
         `false` at the press, nothing was dispatched, and throwing the set away would make the
         person rebuild it before trying a verb that works. */
      if (bulk.run(action, pickedIds)) clearPicked();
      else setPickPanel(null);
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
   * The list, readable from inside a timer. The dwell fires two seconds
   * after the render that armed it and must judge the list as it is THEN —
   * still present, still unread — without putting `all` in its dependency
   * array (see the dwell). Assigned in render, not refreshed by an effect:
   * an effect would make the dwell's correctness depend on effect
   * declaration order, an invariant nothing states. Same shape as
   * `StreamShell` and `useSeenOnScroll` in `@ohmail/ui`.
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
   * The message `u` just put back to unread, and why nothing here may undo it: in the split
   * pane the cursor is still on the row, so the dwell arms and the departure commit would mark
   * it read again — the user's explicit act reverted by a heuristic while they watch. An
   * explicit unread pins the message until the cursor MOVES. A ref, not state: readable in the
   * same commit by code outside a render. Keyed to `dwellOn`, not `selected` — `selected` also
   * moves when the list re-partitions, which is not a cursor move and must not release a pin.
   * Declared here because the commit below reads it (no forward reference into a later const).
   */
  const pinnedUnread = useRef<string | null>(null);

  /**
   * Reading is committed on the way OUT, not on the way in. The message being looked at keeps its dot and its
   * place: committing on arrival re-partitions the list under the cursor — the opened row jumps groups,
   * everything below slides up, the count drops mid-read. So arrival ARMS and departure COMMITS: this ref holds
   * the one message read but not yet left (written by the dwell and by an explicit open), spent by {@link
   * commitPendingRead} at each of the four ways out. It carries the whole stability argument now that a read
   * row slides to "Earlier" at once. A ref, not state: the commit paths run outside render (a timer, a document
   * event, unmount cleanup). At most ONE message is ever owed — arriving somewhere new settles the previous
   * debt first, so this can never become a queue a reload would drop.
   */
  const pendingRead = useRef<string | null>(null);

  /**
   * An armed read presents as read — the renderable twin of {@link pendingRead}. Committing on departure is
   * invisible by design, except the open message's verb kept offering "Mark read" and its row sat at full
   * unread weight while being read (owner-reported). Both now derive from the ARMED state: on arm the row loses
   * its dot and the verb flips to "Mark unread". What does not move: the WRITE (departure still commits, one
   * path), the PLACE (the row keeps its slot until departure), the COUNTS (the header and mark-all-read count
   * truly unread mail via `unreadIds` — a count following the presentation would claim an unhappened write, and
   * the commit re-judges through `allRef`). One writer for the pair: {@link armRead} moves ref and state
   * together, and `commitPendingRead` stays callable from cleanups.
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
   * Spend the debt — and re-judge it at the moment of spending, never at arming: the message
   * can be filed away, marked read by another device, or pinned unread by `u` between the two,
   * so all three are checked here against the list as it is now. It clears the ref FIRST and
   * unconditionally: two departure triggers can fire in one tick, and a debt spent twice is two
   * `mark_seen` dispatches for one reading — idempotent by construction. Reads only refs, so it
   * is safe from a cleanup with an empty dependency array and a once-registered `pagehide`
   * listener — a closure-dependent commit is the bug class the dwell's own dependency array was
   * rewritten to remove.
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
    // landing and this is a departure. The read LANDS — the label travels to the server, which
    // marks read WITHOUT spending a resurface pin (owner ruling 2026-08-26: reading a resurfaced
    // message sticks; the pin is answered only by dealing with the row) — so "open it and leave"
    // stays read AND stays pinned. Every deliberate reader below omits the flag and spends.
    markSeenRef.current([id], false, "glance");
  }, [armRead]);

  /**
   * The cursor the USER put here — the only value that can arm the dwell. `selectedId` cannot answer
   * this: it used to arrive through two implicit fallbacks meaning "the newest unread message",
   * silently re-resolving on every re-partition — and since the list is partitioned BY `unread`, a
   * commit fed the next arm: two seconds per message, straight through the Ohbox, onto a real IMAP
   * server. Both fallbacks are gone, and the dwell still keys on this rather than `selected`:
   * `selected` also moves when a message leaves the pile, which is not a cursor move. Structural
   * guarantee: `dwellOn` is written in exactly two places — `selectByUser` (j, k, click) and `open`
   * (clears it). Nothing derived from the list can produce it.
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
   * `onEnterReader` is a statement of intent, not an instruction to raise a sheet: the shell answers with
   * the reader only where the reading column is hidden — at a split width the column IS the open. It also
   * pins the selection via `onSelect`, which is what makes `open` a complete statement on its own: the
   * mobile tap and a `↵` from anywhere both need the cursor where the reader is. An open supersedes a dwell
   * — reading is established, the timer has nothing to decide. It does NOT dispatch: opening arms the read,
   * leaving commits it — a write on open would re-partition the list at the exact moment attention turned
   * to the message. The row keeps its dot and place while on screen.
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
   * Stepping into the pane with → is engagement — `open` minus the reader
   * raise. The read-marking guard has two triggers: dwelling, and explicit
   * engagement; arrowing into the reading column is the second, so it ARMS
   * the read through the same `armRead`, spent by the same departures,
   * written with the same `"glance"` label (pane focus is not "dealing with
   * the row", so a resurface pin survives it). No sheet: at a split width
   * the column already shows this message and → is a focus move. Where the
   * column is hidden the zone hook calls `open` instead (`onHiddenEnter`).
   */
  const engage = useCallback((m: EngineMessage) => {
    setDwellOn(null);
    if (m.unread) {
      if (pendingRead.current !== m.id) commitPendingRead();
      armRead(m.id);
    }
  }, [commitPendingRead, armRead]);

  /**
   * The selection taken away from outside is a departure — the Back button's half of
   * commit-on-leave. The URL carries the open message, so Back on `#/ohbox/m/A` clears the
   * SHELL's selection while this view stays mounted — a way of leaving A none of the four
   * departures sees. Without this, a dwell armed on A kept running unselected, and an armed
   * debt was spent only at the NEXT departure. So the cursor prop going null cancels the dwell
   * (leaving inside two seconds is not reading) and COMMITS the debt (leaving after them is
   * exactly the departure the commit waits for) — the same two halves `selectByUser` applies.
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
   * Two directions, not one toggle: "invert eleven messages" turns a mixed selection into a different mixed selection — a
   * direction produces the same state from any state, which is why the bulk vocabulary has `read` and `unread` as separate
   * members; the single-message case must not disagree. The pin is why these are not `onMarkSeen` at the call site: marking
   * unread inside the dwell window leaves an already-recorded debt that departure would spend — the message un-unreading
   * itself one keypress later. So `u` sets the pin AND tears up the debt (its own message's only); both are load-bearing — the
   * debt covers the next departure, the pin covers re-entry. And it calls `promote`, the third mechanism, about placement: a
   * row just made unread must move back above the "Earlier" line, and `promote` also cancels a slide in flight — read, change
   * your mind within 280 ms, and the timer would otherwise file the row anyway.
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
   * The 2 s dwell, and why j/k alone must commit nothing: the split pane's reading column shows
   * whatever the cursor is on, but `jjjjj` is navigation, and marking every passed row would empty
   * the Ohbox by accident. The timer arms on selection, the cleanup cancels on every change;
   * stopping for two seconds commits that one. It arms on `dwellOn` and NOTHING else — the
   * dependency array is the guarantee: a re-partition cannot change `dwellOn`, so a commit can
   * never arm the next one. `all` is deliberately not a dependency (read through `allRef`); the
   * target is frozen at arm time; and it dispatches nothing — it records a debt, spent in {@link
   * commitPendingRead}. Split pane only: on mobile only `open` counts.
   */
  useEffect(() => {
    if (dwellOn == null) return;
    const id = dwellOn;
    if (pinnedUnread.current === id) return;
    if (!allRef.current.find((m) => m.id === id)?.unread) return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    if (readColumnHidden()) return;
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
   * #2 — the view goes away. Switching views unmounts this component, and
   * leaving the Ohbox is unambiguously leaving the message open in it —
   * without this, walking away via the rail would be the one exit that
   * silently forgot the reading. The effect body is empty and the cleanup
   * is the whole of it, which only works because {@link commitPendingRead}
   * has a stable identity (reads only refs, memoised on nothing): a commit
   * function rebuilt each render would fire this on ordinary re-renders and
   * mark mail read mid-session.
   */
  useEffect(() => commitPendingRead, [commitPendingRead]);

  /**
   * #3 — the reader sheet closes, and only where the sheet WAS the reading. Below 900px there
   * is no reading column: dismissing the sheet is leaving the message, and on a phone it is
   * usually the only departure. At a split width it is not one: the column goes on showing the
   * same message, so committing there would mark mail read while the reader is looking at it —
   * the very thing this mechanism stops, arriving through the one path that looks like an exit.
   * The width question uses the same query the dwell asks, at the moment the sheet closes, not
   * when it opened: a rotated device is judged by where the reading actually ended.
   */
  const prevReaderId = useRef<string | null>(readerId);
  useEffect(() => {
    const closed = prevReaderId.current !== null && readerId === null;
    prevReaderId.current = readerId;
    if (!closed) return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    if (!readColumnHidden()) return;
    commitPendingRead();
  }, [readerId, commitPendingRead]);

  /**
   * #4 — the tab goes away. `pagehide` is the last event a page reliably gets on close,
   * navigation, or bfcache-freeze, and it fires where `beforeunload` does not — notably mobile,
   * where a reader leaves without moving the cursor. It dispatches the ORDINARY mutation, not a
   * beacon: a side channel would leave the idempotency key and overlay behind, a write no other
   * read-state write takes and nothing can de-duplicate. The cost is stated: a tab killed hard
   * enough loses the pending commit — the right direction to fail: the message stays unread, a
   * second chance to read it rather than mail silently marked read.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onLeave = () => commitPendingRead();
    window.addEventListener("pagehide", onLeave);
    return () => window.removeEventListener("pagehide", onLeave);
  }, [commitPendingRead]);

  /**
   * The slide: a row leaves the upper groups by MOVING, not disappearing. The only writer of `settling`
   * and `dismissed`, so there is exactly one answer to "how does a row leave New for you". Two steps and
   * a gap: the class goes on first and the row keeps its slot for {@link SETTLE_MS} (what `row.css`
   * transitions over); only then is the id dropped and the row redrawn under "Earlier" — same-tick
   * dropping is a teleport. It re-judges its premise when it lands ({@link commitPendingRead}'s shape):
   * 280 ms is long enough for `u`, another client, or a filing to change the answer, so completion asks
   * `earlierRef` again and abandons the move if "Earlier" is no longer where the row belongs; `promote`
   * cancels the timer outright for the explicit case.
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
   * What starts a slide: the selector re-filing a row this view is still holding up. One
   * observation against the session orders: an id held in an upper group that `ohboxView` now
   * files under "Earlier". An in-app read (the optimistic overlay flips the row), a settled
   * reply, and a `\Seen` adopted from another client all arrive as the same delta — one
   * mechanism, because they are one event with different causes; per-cause hooks were how
   * external reads came to move nothing until a reload. Keyed on `earlierIds` and nothing else
   * — a memo over `previouslySeen`, so it re-runs exactly on changes that can add work.
   * `slideOut` is idempotent on an id already in flight.
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
   * A settled reply marks the message it answered read. Answering is being done with it, and
   * the write also clears any resurfaced pin server-side (`MessageService.markSeen`), so a
   * reply closes a resurface. The shell hands the settled reply down as {@link replyDone},
   * keyed on the settle instant so a value already acted on is ignored. The move is NOT written
   * here any more: reads move rows now, and a second copy of the gesture would be two
   * mechanisms racing over one row — the write is the whole of this effect, the slide follows
   * through `slideOut`. It acts only on a row currently in the New session order: a reply to
   * something in "Earlier" is answering read mail, a no-op.
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
  /**
   * ONE WALK, FOUR KEYCAPS. ↓/↑ are `j`/`k` — same steps, same entry moves, same
   * `selectByUser` and therefore the same dwell guard: an arrow flick down the list arms
   * and cancels exactly as a `jjjjj` sweep does and commits nothing (see `DWELL_MS`).
   * Extracted so the letter bindings below and the zone hook's arrow bindings dispatch ONE
   * pair of closures — a second copy is how two keys presented as aliases drift apart.
   */
  const stepDown = {
    // `at < 0` — no cursor, or a cursor on something these rows do not contain — is ENTRY,
    // and this expression already treats it as one: `-1 >= order.length - 1` is false for any
    // non-empty list, so the step comes in at the top. See `stepUp` for the other half.
    disabled: at >= order.length - 1,
    run: () => {
      if (at < order.length - 1) selectByUser(order[at + 1]!);
    },
    label: t("keyNext"),
  };
  const stepUp = {
    disabled: order.length === 0 || at === 0,
    run: () => {
      if (at < 0) selectByUser(order[order.length - 1]!);
      else if (at > 0) selectByUser(order[at - 1]!);
    },
    label: t("keyPrev"),
  };

  /**
   * ⇧↓ / ⇧↑ — move the cursor and drag the selection with it. The keyboard twin of a shift-click, and it was simply
   * missing: a range could be built with a mouse and not with the keys, on a product whose list is keyboard-first.
   * ADDITIVE, never subtractive — the one real decision: shrink-on-reverse (⇧↑ un-picking what ⇧↓ picked) is what a
   * text field does, and it needs a second piece of state beside the set — a live range with a direction — because
   * the set alone cannot say which members came from THIS gesture; worse, it would remove rows picked by other means
   * (⌘-click four rows, then ⇧↓ ⇧↑, and two are gone). So the range only ever adds, exactly as ⇧-click does; removal
   * is the way you added — `x`, ⌘-click, or Escape. With no anchor the cursor's own row becomes one, so the first ⇧↓
   * picks the row you are on and the row you land on — the pair the gesture visibly spans.
   */

  /**
   * Key repeat is allowed, unlike `⌫`: a held ⇧↓ walking a range down the list is the gesture, and each repeat adds
   * one row to a set not yet acted on — a held `⌫` would walk a pile into Trash one window at a time, which is why
   * item 10 guards that one.
   */
  const extendPick = useCallback((dir: 1 | -1) => {
    if (order.length === 0) return;
    if (anchor.current === null && selectedId) anchor.current = selectedId;
    const next = at < 0 ? order[dir === 1 ? 0 : order.length - 1] : order[at + dir];
    if (!next) return;
    selectByUser(next);
    pickRangeTo(next);
    // `order`/`at` are rebuilt each render and must be read AS RENDERED, the same reason
    // `togglePick` and `pickRangeTo` state above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, at, selectedId, selectByUser, pickRangeTo]);

  /**
   * DELETE THE SELECTION — one press, one window, one toast, one Undo for the whole set. It goes through
   * `BulkAction`'s `delete` arm, which hands the ids to the SAME `delete-undo.ts` window a single ⌫ opens. Nothing is
   * dispatched here and nothing is dispatched by the shell's arm either: the window holds the ids and sends one
   * `message_delete` per id only when it closes, so Undo inside it cancels a delete that never happened. That is the
   * only undo this wire can honour — there is no un-delete on it. The pick clears on the press, like every verb that
   * ran: the rows leave every pile at once (`hideMessages` over the held ids), so a set that survived would be
   * pointing at rows that are not on screen.
   */
  const deletePicked = useCallback(() => runBulk("delete"), [runBulk]);
  /**
   * NO CURSOR IS ITS OWN REASON — spread into every `message` binding below whose `disabled` is `selected == null`.
   * See `keymap.tsx#DisabledReason`. This is the view the defect was reported against: an Ohbox nobody had touched
   * has no cursor, so ↵, `t`, `x`, `u` and `⇧I` here — and the shell's nine verbs under them — were all `disabled`,
   * and the dispatcher dropped each one before the chord was matched. Every one of those presses did nothing at all,
   * with the `?` sheet the only place that state showed. The first press now places the cursor on the first row and
   * says which verb the next press runs. NOT on `⇧U` or the four extend chords: those rest on the PICK
   * (`picked.size`, `order.length`), not on the cursor, and ⇧↓ is how a pick starts. The selection layer above is
   * absent rather than disabled when nothing is picked, so none of it can be reached by this rule either.
   */
  const noCursor = selected == null ? ({ disabledReason: "no_cursor" } as const) : {};

  const keys: KeyBinding[] = [
    {
      chord: "j",
      group: "navigate",
      label: t("keyNext"),
      disabled: stepDown.disabled,
      run: stepDown.run,
    },
    {
      /**
       * The exact inverse of `j`, and that has to include the way in. The Ohbox rests with NO cursor — deliberate:
       * the reading column stays at rest until somebody chooses a message — so the keys are how a reader ENTERS the
       * list, not merely how they move inside it. `j` has always had an entry move (nothing selected → first row);
       * `k` had none, declared inert whenever the cursor was not on a row — on a fresh Ohbox `j` walked the list and
       * `k` did nothing, two keys presented as a pair, one dead. The pair is one gesture in two directions, so it
       * enters from the two ends: `j` at the top going down, `k` at the bottom going up; inside the list they are
       * strict inverses over the same row order — both read the one `order` array built above. `at < 0` covers both
       * readings of "not on a row": nothing selected, and a selection standing outside the three grouped sections.
       */
      chord: "k",
      group: "navigate",
      label: t("keyPrev"),
      disabled: stepUp.disabled,
      run: stepUp.run,
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
      ...noCursor,
      // ↵ on a focused button presses the button; that is the browser's and it stays so.
      when: (e) => (e.target as HTMLElement).tagName !== "BUTTON",
      // The `: onEnterReader()` arm is gone with the boolean it depended on. It meant
      // "open the reader on nothing" — with an empty list there is no message to read, and
      // the sheet it opened rendered a `<span/>`.
      run: () => selected && open(selected),
    },
    /**
     * The selection layer. While a selection exists, the verb letters act on it — following a rule the product
     * already has: every verb wears its keycap, and a keycap on the selection pill must do what the pill does. The
     * pill offers Later, Park, Resurface, Tag, Screening, Move, Read, Unread and Delete, so those letters mean the
     * selection while there is one and the cursor's message when there is not. Declared FIRST, because declaration
     * order IS precedence inside a layer (`ordered()` runs the first ENABLED match): `t` and `u` have cursor twins
     * below, outranked exactly while `picked.size > 0`; `a e b s m d ⌫ ⌦` have no view-level twin — their cursor
     * versions are the SHELL's, and `view` outranks the shell, the same precedence that lets the Screener own `c`.
     */

    /**
     * Every one is `disabled`, not absent, without a selection: a disabled binding still appears in the `?` sheet,
     * which keeps a shortcut learnable. The cost, stated: somebody who used `x` and then a letter expecting the
     * cursor's message now acts on the pick — Gmail's model, the sheet says so in words while the selection is up,
     * and it is a real behaviour change.
     */
    {
      chord: "shift+ArrowDown",
      group: "message",
      label: t("keyExtendDown"),
      disabled: order.length === 0,
      run: () => extendPick(1),
    },
    {
      chord: "shift+j",
      group: "message",
      label: t("keyExtendDown"),
      disabled: order.length === 0,
      run: () => extendPick(1),
    },
    {
      chord: "shift+ArrowUp",
      group: "message",
      label: t("keyExtendUp"),
      disabled: order.length === 0,
      run: () => extendPick(-1),
    },
    {
      chord: "shift+k",
      group: "message",
      label: t("keyExtendUp"),
      disabled: order.length === 0,
      run: () => extendPick(-1),
    },
    /**
     * And these ten are declared only while a selection exists — not `disabled`, ABSENT: the one departure from
     * "declare it and disable it", for the `?` sheet rather than the dispatcher. `groupedBindings` dedups BY CHORD,
     * one row per key, preferring an enabled declaration over a disabled one; every chord below has a twin for the
     * cursor's message (`t`/`u` in this view, `a e b s m d ⌫ ⌦` in the shell) and the view's layer is walked FIRST —
     * so a disabled selection binding won the row and the sheet taught "Park the selection" to somebody with nothing
     * selected (measured: with no pick and no cursor, `a` read "Queue the selection for the Reply Run"). Absent, the
     * sheet is right in both states and the shared dedup rule untouched; the CHORD is still listed by the twin, only
     * the label changes.
     */

    /**
     * The four extend chords above are NOT in here: they have no twin, and they are how a selection STARTS — a key
     * that creates the state cannot be gated on it.
     */
    ...(picked.size > 0
      ? ([
    {
      chord: "a",
      group: "message",
      label: t("keySelLater"),
      run: () => runBulk("later"),
    },
    {
      chord: "e",
      group: "message",
      label: t("keySelPark"),
      run: () => runBulk("aside"),
    },
    {
      chord: "b",
      group: "message",
      label: t("keySelResurface"),
      run: () => runBulk("resurface"),
    },
    {
      /* THE PICKER NEEDS AN ANCHOR, and from a key there is no pressed element to give it. The
         pill's own Tag button is the honest one to point at: it is where the mouse path opens
         the same picker, so the popover appears in one place however it was asked for. */
      chord: "t",
      group: "message",
      label: t("keySelTag"),
      run: () =>
        bulk.tag(
          pickedIds,
          document.querySelector<HTMLElement>(".view-ohbox .list-foot .abar-tag .abar-b"),
        ),
    },
    {
      chord: "s",
      group: "message",
      label: t("keySelScreen"),
      run: () => setPickPanel({ kind: "screen" }),
    },
    {
      chord: "m",
      group: "message",
      label: t("keySelMove"),
      run: () => setPickPanel({ kind: "move" }),
    },
    {
      chord: "u",
      group: "message",
      label: t("keySelUnread"),
      run: () => runBulk("unread"),
    },
    {
      /* `d` ASKS; `⌫`/`⌦` DO NOT — item 10's own distinction, one verb wider. `d` is the letter
         printed on the pill's own Delete item, an aimed press over a set somebody built, and
         the ask is the last place the count is stated before the rows go. */
      chord: "d",
      group: "message",
      label: t("keySelDeleteAsk"),
      run: () => setPickPanel({ kind: "delete" }),
    },
    {
      chord: "Backspace",
      group: "message",
      label: t("keySelDelete"),
      /**
       * TWO CONDITIONS ON THE EVENT, and neither can be a `disabled` flag.
       * · A HELD KEY IS ONE PRESS. Backspace auto-repeats, and a finger resting on it would open window after
       *   window over a whole pile.
       * · NOTHING IS STANDING OVER THE DECK. Measured before this line existed: three rows picked, the `?` sheet
       *   OPEN, one press of ⌫ — and all three were filed, because the selection's delete chords never received a
       *   modal gate at all. The shell's own delete keys had one; these were not on the list, and could not have
       *   been, since the list enumerated what the SHELL owns and the More menu's open state lives below it.
       */

      /**
       * `isModalOpen` asks the DOM instead of a list, which is why it is a `when` and not a `disabled`: `disabled` is
       * computed while React renders, and the menu this is meant to catch opens without the shell re-rendering. A
       * `false` here does not consume the key — it falls through, and the `?` sheet keeps listing the verb, which is
       * right: the key is bound, it is simply not the innermost thing being asked.
       */
      when: (e: KeyboardEvent) => !e.repeat && !isModalOpen(deleteDoc(e)),
      run: deletePicked,
    },
    {
      chord: "Delete",
      group: "message",
      label: t("keySelDelete"),
      when: (e: KeyboardEvent) => !e.repeat && !isModalOpen(deleteDoc(e)),
      run: deletePicked,
    },
        ] satisfies KeyBinding[])
      : []),
    {
      chord: "t",
      group: "message",
      label: t("keyTag"),
      disabled: selected == null,
      ...noCursor,
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
      ...noCursor,
      run: () => selected && togglePick(selected.id),
    },
    {
      /**
       * THE PAIR, AND WHY IT IS NOT GMAIL'S EXACT PAIR. Gmail is ⇧I to mark read and ⇧U to mark unread, and it is the
       * precedent worth following — but `shift+u` is taken here, by the bulk "mark what I picked" verb declared a few
       * lines below, and taking it back would break a shipped shortcut to match a convention. So: `⇧I` is Gmail's,
       * verbatim, and `u` keeps the key this product has always used for unread — which is also the better mnemonic
       * of the two. `u` USED TO BE A TOGGLE. See `markUnread` for why a direction is the right shape. Both are listed
       * in the `?` sheet because both declare a label, and the sheet is generated from this registry.
       */
      chord: "u",
      group: "message",
      label: t("keyMarkUnread"),
      disabled: selected == null,
      ...noCursor,
      run: () => selected && markUnread(selected),
    },
    {
      chord: "shift+i",
      group: "message",
      label: t("keyMarkRead"),
      disabled: selected == null,
      ...noCursor,
      run: () => selected && markRead(selected),
    },
    {
      /**
       * THE BULK ACTION, ON THE KEYBOARD. The complaint was that multiple messages could not be selected and marked
       * seen, and the half that shipped could only be finished with a mouse: the bar's buttons are reachable by Tab,
       * but there was no way to say "mark what I picked" from the keys that made the pick, and nothing in the `?`
       * sheet mentioned that marking a selection was possible at all. Declaring it here documents it — the sheet is
       * generated from this registry and cannot list a key that does nothing. `⇧U` and not a fresh letter: `u` is
       * already "mark read / unread" at the cursor, so the shifted twin is the same verb over the selection.
       * `chordMatches` keeps plain `u` from swallowing it.
       */
      chord: "shift+u",
      group: "message",
      label: t("keyMarkPicked"),
      disabled: picked.size === 0,
      run: () => markPicked(),
    },
    {
      /**
       * ESCAPE CANCELS THE OPEN SUB-ROW BEFORE IT CLEARS THE SELECTION. FIRST in this array, and the array's order IS
       * the precedence — `ordered()` walks a layer's bindings in declaration order and the first match runs
       * (`keymap.tsx`). So this is stated where precedence lives rather than as a condition inside the clear binding,
       * which is the shape that rots. It matters most for the confirm row: that row is the last moment before a
       * consent decision commits, and an Escape that blew past it to clear the selection would leave the user with
       * neither the confirmation nor the set they had built. NO NEW `document` LISTENER — there are already five,
       * measured. This is a registry binding in the view layer, which the shell's `overlay` scope still outranks, so
       * a `?` sheet or the palette opened over this closes first and the sub-row survives.
       */
      chord: "Escape",
      group: "message",
      label: t("keyCancelBulk"),
      disabled: pickPanel == null,
      run: () => setPickPanel(null),
    },
    {
      /**
       * Escape clears the selection — when nothing is open on top of it. This used to read `picked.size === 0 ||
       * chrome.replyTo != null`, and the second clause is the whole story. The reply tests went red the moment a
       * selection survived into the reply editor — "r opened an inline editor but Esc did not close it" — because
       * this VIEW binding outranked the shell's Escape cascade unconditionally and cleared the selection instead. The
       * patch taught this view to name ONE of the shell's overlays, which left the `?` sheet, the ⌘K palette and the
       * screening popover broken in exactly the same way and put the next overlay one line from joining them.
       */

      /**
       * The condition is gone because the precedence is stated where precedence lives: the shell's Escape is
       * registered in the `overlay` scope, which outranks every view layer while something is open and stands down
       * when nothing is (`keymap.tsx`). So this binding is once again only about this view — a picked set is the
       * innermost thing the OHBOX has — and it knows nothing about what the shell may be showing.
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
   * THE ZONE MODEL — rail ← list → open message (`zone-nav.tsx`). ↓/↑ in the list are
   * `stepDown`/`stepUp`, the same closures `j`/`k` dispatch, so the dwell guard is one
   * mechanism under four keycaps. → into the pane is `engage` (the armed read, above); at
   * widths where the column is hidden it is `open`, the deliberate open the sheet answers.
   */
  useZoneNav({
    list: { up: stepUp, down: stepDown, followId: selected?.id ?? null },
    reader: {
      selector: ".view-ohbox .read-col",
      disabled: selected == null,
      onEnter: () => selected && engage(selected),
      onHiddenEnter: () => selected && open(selected),
    },
  });

  /**
   * SHIFT-CLICK RANGES, intercepted in the CAPTURE phase.
   *
   * `MessageRow` lives in `@ohmail/ui` and its `onClick` takes no event, so the modifier is
   * unreachable from the row itself — and widening a shared design-system primitive for one
   * view's selection model is the wrong trade. Capture runs before the row's own handler, so
   * `stopPropagation` here means a shift-click extends the range INSTEAD of moving the cursor,
   * rather than doing both.
   */
  /**
   * Entering a selection on a phone — a long press on a row. A phone had NO way in: `x` needs a
   * keyboard, ⇧-click a modifier, and a tap is the open — every verb the selection bar offers
   * was desktop-only. The hold is the gesture both platforms already use for "start selecting"
   * in a list, so it is the one to implement: a checkbox on every row would cost the row its
   * lead alignment for a mark the rail already makes, and a hover-reveal has no touch
   * equivalent.
   */

  /**
   * Four conditions, each keeping this gesture out of another's way: `pointerType === "touch"` — a mouse hold is a
   * click somebody is taking their time over, and the desktop has `x` and ⌘-click; 450ms — long enough not to fire on
   * a lingering tap, the figure both platforms use; no travel past `DRAG_SLOP_PX` — a moving finger is scrolling, and
   * a selection mid-scroll would be the worst surprise (same threshold the drag-to-file gesture uses, imported — and
   * `drag-file.ts` returns early on touch, so the two cannot both arm on one pointer); and the press that fired is
   * not also a TAP — the `click` after a hold would open the reader over the selection that just appeared, so the
   * next one is swallowed. `contextmenu` is prevented while the timer runs: Android fires it on a long press, and
   * iOS's callout is covered by `-webkit-touch-callout: none` on `.row`.
   */
  const holdRef = useRef<{ id: string; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  /** A hold FIRED, so the `click` closing the same press is not a tap. Cleared by that click. */
  const heldRef = useRef(false);

  const cancelHold = useCallback(() => {
    if (holdRef.current) clearTimeout(holdRef.current.timer);
    holdRef.current = null;
  }, []);

  const onHoldPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    cancelHold();
    /* A NEW PRESS ENDS THE LAST ONE'S CLAIM ON THE NEXT CLICK. The swallow flag is normally
       cleared by the `click` that closes the hold's own press — but that click is not
       guaranteed: Android suppresses it after some long presses, and a flag left standing would
       eat the next unrelated tap instead, which on a phone is the tap that adds the second row.
       Bounding it to the press that set it costs one line and removes the whole class. */
    heldRef.current = false;
    if (e.pointerType !== "touch") return;
    const row = (e.target as HTMLElement).closest<HTMLElement>(".row[data-id]");
    const id = row?.dataset.id;
    if (!id) return;
    /* NOT the sender circle: that tap opens the screening popover and always has. A hold that
       started on it is a hold on the popover's control, not on the row. */
    if ((e.target as HTMLElement).closest(".av")) return;
    holdRef.current = {
      id,
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        holdRef.current = null;
        heldRef.current = true;
        togglePick(id);
      }, LONG_PRESS_MS),
    };
  }, [cancelHold, togglePick]);

  const onHoldPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const h = holdRef.current;
    if (!h) return;
    if (Math.hypot(e.clientX - h.x, e.clientY - h.y) >= DRAG_SLOP_PX) cancelHold();
  }, [cancelHold]);

  /** The hold's own press must not also open the row — see `heldRef`. */
  const onHoldClickCapture = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    if (!heldRef.current) return;
    heldRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  useEffect(() => cancelHold, [cancelHold]);

  const onRangeClickCapture = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    /* ⌘/Ctrl TOGGLES ONE ROW AND NEVER MOVES THE CURSOR — the standard single-pick every list
       on both platforms has, and until now the only modifier-less way to pick was the keyboard
       (`x` at the cursor), so a mouse user could build a RANGE and could not build a scattered
       set. ⇧ still extends. Both are additive; neither opens the message. */
    const pick = e.shiftKey ? pickRangeTo : e.metaKey || e.ctrlKey ? togglePick : null;
    if (!pick) return;
    const id = (e.target as HTMLElement).closest<HTMLElement>(".row[data-id]")?.dataset.id;
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    pick(id);
  }, [pickRangeTo, togglePick]);

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
   * "Done" on a pinned row — the deliberate release, standing where the eye looks for it. A resurfaced row's one way
   * out (short of answering) was a read verb that never said so: `⇧I`, the bar's "Mark as read", a bulk Read.
   * Reported from real use in exactly those terms, and the question is asked AT THE PIN, so the answer stands on the
   * pinned row itself, in the Screener quick-adjust's reveal grammar (`MessageRow.actions` — hover, focus, selection;
   * always shown where hover does not exist). It dispatches `resurface_done` — the shell's one release arm, shared
   * with the action bar's Done — for THIS row's message, never the selected one, which is why it does not press `⇧I`;
   * the choreography that follows is the existing one (the deliberate `mark_seen` spends the pin first-frame,
   * `lastReadAt` files the row atop "Earlier", `slideOut` draws the descent).
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
   * READ-STATE AS PRESENTED — {@link presentsUnread} minus the armed read (see `armedRead`). Used by exactly the
   * surfaces that SHOW read-state: the row's dot/ink and the open message's verb. Everything that acts on or counts
   * read-state (`unreadIds`, mark-all-read, the dwell's and the commit's re-judgements, the slide) keeps reading the
   * store's own flag. A PINNED ROW IS UNREAD, AND THE ARMED READ DOES NOT SUBTRACT FROM IT: `presentsUnread` answers
   * `true` for every resurfaced row (owner ruling 2026-08-31 — the engine holds the reasoning), and the `armedRead`
   * subtraction is applied to what is LEFT of that, never over the top of it. Which is the point: the arming exists
   * so a message being read stops looking new, and a resurfaced row is not claiming to be new — it is claiming the
   * reader asked to see it again, and that claim is answered by Done or by a reply, not by looking.
   */

  /**
   * Subtracting the arm here would put the flip-flop straight back: the row would unbold on the dwell, the
   * glance-read would land without spending the pin, and the next render would re-bold it from a state nothing had
   * changed.
   */
  const effUnread = (m: EngineMessage): boolean =>
    isResurfaced(m) ? true : presentsUnread(m) && m.id !== armedRead;

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
      protectedLabel={m.protected != null ? rowBadge.protectedLabel : undefined}
      stateNote={stateNoteOf(m)}
      tags={tagsOfMessage(m, tags).map((tag) => ({ name: tag.name, hue: hueOf(tag) }))}
      /* `picked` carries BOTH the styling and the ARIA now — it used to be a
         class name only, so `aria-selected` was set on zero rows and the selection existed
         for sighted mouse users and nobody else. See `MessageRow`. */
      picked={picked.has(m.id)}
      actions={actions}
      onClick={() => {
        if (readColumnHidden() && picked.size > 0) {
          /* THE LIST-SELECTION CONTRACT, and both platforms have it: once a selection exists,
             a tap adds to it or takes away from it rather than opening. Without this the only
             way to build a set on a phone would be one long press per row, and the FIRST tap
             after entering the mode would leave the mode. The way out is the count capsule. */
          togglePick(m.id);
        } else if (readColumnHidden()) {
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
   * THE VOICES A GROUPED ROW SPEAKS FOR — one message per distinct sender, newest first. The unread members while the
   * conversation is waiting (what is unanswered is what the row is for), else the newest member alone once it has all
   * been read. Returns the MESSAGES rather than their names because two things are derived from this list and they
   * must not drift: the sender line ({@link groupSenders}) and the row's lead circles. A row whose text reads "Ada
   * Lund, Bo Ek" and whose faces are somebody else's would be two answers to one question.
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
   * One row for a conversation — and a plain {@link row} for anything that did not fold, so a section of singletons
   * renders byte-for-byte as it always has. The folded row shows the conversation's STORED name (server-cleaned; see
   * `threadSubject`, falling back to the newest member's subject until the thread row syncs), the newest member's
   * snippet and time, the distinct unread senders on the sender line — the same people as the row's lead circles
   * (`participants` below) — and the member count as `⤷ N`. Click and ↵ act on the LATEST UNREAD member: the ordinary
   * per-message open, so the thread view, dwell and departure commit behave exactly as for a plain row and nothing
   * bulk-marks the folded members read. `selected` is row MEMBERSHIP, so the highlight survives the lead message
   * changing.
   */

  /**
   * `settling` ONLY WHEN EVERY MEMBER IS SLIDING: the slide is per MESSAGE — read one of five unread replies and that
   * message alone descends while the row stands and its count drops; read the last and the whole conversation
   * re-files under "Earlier" as one row. A row that animated on each member would be five slides, four ending where
   * they started.
   */
  const groupRow = (g: OhboxRowGroup) => {
    if (g.members.length === 1) return row(g.members[0]!);
    const target = g.openTarget;
    const shown = g.latest;
    const voices = groupVoices(g);
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
     * · everything read (the live shape — own-sent is never unread, so a folded reply sits in an all-read "Earlier"
     *   row): the sender line and the LEAD circle are the recipient's, exactly as on a singleton sent row — the strip
     *   beside the subject keeps the conversation's people either way;
     */

    /**
     * · unread members present: the distinct unread senders own the sender line, unchanged, and the snippet — which
     *   is the reply's — carries the label as its attribution. A reply with no recipients on the row (pre-recipient
     *   mirror) is `sent == null`, and the row keeps the ordinary sender summary.
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
        protectedLabel={shown.protected != null ? rowBadge.protectedLabel : undefined}
        /* The open target's state, because the target is what the row's click and every verb
           pressed on this row act on — a chip describing some OTHER member would promise a
           toggle the keys cannot deliver. */
        stateNote={stateNoteOf(target)}
        tags={tagsOfMessage(shown, tags).map((tag) => ({ name: tag.name, hue: hueOf(tag) }))}
        picked={g.members.every((m) => picked.has(m.id))}
        onClick={() => {
          if (readColumnHidden() && picked.size > 0) {
            // The same contract as the singleton row above — and a folded row toggles all of
            // its members, which is what `togglePick` does with a row id.
            togglePick(target.id);
          } else if (readColumnHidden()) {
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
      onClickCapture={(e) => { onHoldClickCapture(e); onRangeClickCapture(e); }}
      /* BESIDE the drag's own handler, not instead of it: `drag-file.ts` returns early for a
         touch pointer and this one returns early for every other kind, so exactly one of the
         two can arm on any given press. */
      onPointerDownCapture={(e) => { drag.onPointerDown(e); onHoldPointerDown(e); }}
      onPointerMoveCapture={onHoldPointerMove}
      onPointerUpCapture={cancelHold}
      onPointerCancelCapture={cancelHold}
      onContextMenuCapture={(e) => { if (holdRef.current) e.preventDefault(); }}
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
            heading-over-nothing rule, kept as the window slides. */}
        {/* Resurfaced — pinned at the very top under its own quiet label, whole and outside the
            window (a scheduled set is small): not "this arrived" but "you asked to see this
            again now", so it earns its own heading. Every row here is drawn unread whatever its
            stored flag says (owner ruling 2026-08-31 — `presentsUnread`, with `effUnread` above
            keeping the armed read off it). A DELIBERATE read clears the pin server-side
            (`MessageService.markSeen` without the glance label) and the row slides to "Earlier"
            — once the selector actually files it there, why the slide keys on section
            membership rather than the read flag (see `earlierIds`). A GLANCE — the two-second
            dwell — records the reading and spends no pin, so the row does not move or change:
            the fix for the reported flip-flop. Each row carries "Done" — see `doneFor`. */}
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
            {/* `group`: the landing demo's callout anchors — see ListGroupLabel */}
            <ListGroupLabel group="new">{t("newForYou")}</ListGroupLabel>
            <ListRows multiSelectable ariaLabel={t("newForYou")}>{groupedNew.slice(newFrom, newTo).map(groupRow)}</ListRows>
          </>
        ) : null}
        {groupedPrev.length > 0 && prevTo > prevFrom ? (
          <>
            <ListGroupLabel group="earlier">{t("previouslySeen")}</ListGroupLabel>
            <ListRows multiSelectable ariaLabel={t("previouslySeen")}>{groupedPrev.slice(prevFrom, prevTo).map(groupRow)}</ListRows>
          </>
        ) : null}
        {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
        {/* the account's own sent mail rides "Earlier" now, but only the most recent slice of
            it (the `DEFAULT_SENT_HISTORY_MESSAGES` ingest window). Say so rather than let the list
            imply it holds every message ever sent — older sent mail is on the server, reachable
            through Search. Shown only when sent mail is actually present in the window below. */}
        {hasOwnSent ? <div className="tail-row">{t("sentNote")}</div> : null}
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
      <ReadColumn regionLabel={tReader("pane")}>
        {selected ? (
          <MessagePane
            /* The pane derives its read-state verb from `message.unread`, so the open message
               travels with its PRESENTED state — in BOTH directions. An armed read offers
               "Mark unread" (the only honest action on a message that is being read) while the
               store's flag waits for the departure write; a RESURFACED row offers "Mark as
               read" whatever its stored flag says, because that is what the row beside it is
               drawing and a pane that disagreed with its own list is the inconsistency this
               whole seam exists to close. Pressing it is a deliberate read, which spends the
               pin and releases the row — one of the three ways out, beside Done and a reply.
               See `armedRead`; the shell does the same for the reader sheet via `onReadArmed`. */
            message={effUnread(selected) === selected.unread ? selected : { ...selected, unread: effUnread(selected) }}
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
           * under 900px, where a tap IS the open.
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
          aria-label={t("pickedAria", { count })}
          onClick={onClear}
        >
          <span aria-hidden="true">×</span>
          <span role="status">{count}</span>
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
          <Spinner className="mbx-spin" />
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
