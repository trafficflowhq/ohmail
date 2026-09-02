"use client";

/**
 * Reads — list left, skim stream right. Two per-row facts, kept apart: NEWNESS is position
 * relative to the waterline ("new since last visit" — no dots), and READNESS is the
 * mailbox's own `\Seen`, rendered as the quiet ink on read rows. Scroll-past and dwell
 * feed per-message `\Seen` through the engine (the eventual sweep), the LEAVE of the view
 * commits the waterline in one anchored `feed_mark_seen` (`onLeaveSeen` — the reliability
 * floor), the scroll-spy keeps list and stream in step, and the pending-AI chip carries
 * the classification approval flow.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { presentsUnread } from "@ohmail/client-engine";
import type {
  EngineMessage,
  FeedPartition,
  MessageBody,
  TagDTO,
} from "@ohmail/client-engine";
import {
  Chip,
  ListPane,
  ListRows,
  MessageRow,
  Waterline,
} from "@ohmail/ui";
import { MarkAllRead } from "../components/MarkAllRead";
import { ShortcutHint } from "../shell/ShortcutHint";
import { avatarOf, rowAddress, rowStamp, senderName, tagsOfMessage, hueOf, withheldCopyKey } from "../shell/format";
import { useKeyBindings, type KeyBinding } from "../shell/keymap";
import { useZoneNav } from "../shell/zone-nav";
import { useListWindow } from "../shell/list-window";
import { type MessageAction } from "../shell/MessagePane";
import { StreamShell, type StreamHandle, type StreamLeaveState } from "../shell/StreamShell";
import { StreamCardMemo } from "../shell/StreamCardMemo";
import type { RemoteImagesChrome } from "../shell/remote-images";
import { useStreamWindow } from "../shell/stream-window";
import { waterlineStamp } from "../shell/format";

export type ReadsChipState = null | "approved" | "corrected";

interface ReadsAiChipMeta {
  afterId: string;
  label: string;
  approvedLabel: string;
  correctedLabel: string;
}

export function ReadsView({
  partition,
  tags,
  threadParticipants,
  absoluteTime,
  onToggleTime,
  now,
  cur,
  onCur,
  aiChip,
  chipState,
  onChipState,
  markSeen,
  onLeaveSeen,
  bodyOf,
  hydrateBody,
  remoteImages,
  jumpTo,
  onJumped,
  closeTo,
  onClosed,
  onAction,
  onMarkAllRead,
}: {
  partition: FeedPartition;
  /**
   * THE PEOPLE IN A ROW'S CONVERSATION, for its lead circles — bound to the engine's reader by
   * the shell (this view has none) and mapped to `{initials, hue}`. A LOOKUP into the shell's
   * per-version thread index, so calling it per row costs nothing; `[]` for a message whose
   * thread has no second voice in it, and the row then leads with the one sender's circle it
   * always did. Optional, so a view mounted without it (the demo, most tests) is unchanged.
   */
  threadParticipants?: (threadId: string) => { initials: string; hue: number }[];
  /**
   * THE DATE STAMPS — which form they are in, and the press that flips them.
   *
   * One boolean for every row at once: the shell owns it, resets it on a view switch and shares
   * it with the open message, so no two dates on screen are ever in different shapes. `rowStamp`
   * turns the pair into the row's stamp props. Optional, and absent leaves the rows exactly as
   * they were — relative dates, the exact instant on hover, nothing to press.
   */
  absoluteTime?: boolean;
  onToggleTime?: () => void;
  tags: TagDTO[];
  now: Date;
  cur: string | null;
  onCur: (id: string) => void;
  aiChip: ReadsAiChipMeta | null;
  chipState: ReadsChipState;
  onChipState: (s: Exclude<ReadsChipState, null>) => void;
  /** Mark one Reads message seen through the engine. */
  markSeen: (id: string) => void;
  /**
   * THE LEAVE-COMMIT — the reliability floor under the per-card sweep. Called once, as the
   * view unmounts (= the route changed away), with the waterline anchor ("the top of what
   * was on screen") and the unread ids the visit actually displayed. The view computes both
   * from `StreamShell`'s tracked range; the shell turns them into ONE anchored
   * `feed_mark_seen`. Never called for a visit no human scrolled — `StreamShell` reports
   * `drove: false` and this view then keeps its hands off the engine entirely. Optional:
   * a harness without a shell mounts nothing behind it and nothing fires.
   */
  onLeaveSeen?: (commit: { upToId: string; messageIds: string[] }) => void;
  /** The card's text and what it is — `bodyOf` over the live mirror. */
  bodyOf: (m: EngineMessage) => MessageBody;
  /**
   * Ask for one message's body. Idempotent and single-flight; `retry` is what distinguishes
   * a human asking again from an effect re-running — see `OhmailEngine.hydrateBody`.
   */
  hydrateBody: (id: string, opts?: { retry?: boolean }) => void;
  /** The remote-images chrome the reading pane reads; the stream's cards read the same one. */
  remoteImages?: RemoteImagesChrome;
  jumpTo: string | null;
  onJumped: () => void;
  /**
   * ── THE CONTROLLED CLOSE — the counterpart of `jumpTo`, and the same one-shot shape ─────────
   *
   * An id the shell is asking this view to CLOSE, because the URL no longer claims that reading:
   * Back walked out of a stream reading in place. `onClosed` acknowledges it, exactly the way
   * `onJumped` acknowledges a jump, so the request is state the shell clears rather than a
   * standing prop this view has to diff.
   *
   * A REQUEST, NOT A MIRROR OF EXPANSION. `StreamCard` owns the visual open and this view owns
   * only `expandedId` (the verbs), and neither becomes shell state or URL state here — a stream's
   * expanded card stays scroll posture, which is the shell's standing ruling. What the shell gains
   * is the ability to close the ONE card it had claimed, never to enumerate what is open.
   *
   * Optional, so a view mounted without a shell (the demo, most tests) simply has no close
   * channel and behaves exactly as it did.
   */
  closeTo?: string | null;
  onClosed?: () => void;
  /**
   * The message verbs — the shell's `onMessageAction`, the same one the Ohbox reader is given.
   * OPTIONAL, and absent leaves the cards with no bar rather than a bar that does nothing: this
   * view is mounted without a shell in several tests, and a control with nothing behind it is
   * the one thing a reading surface must never show.
   */
  onAction?: (action: MessageAction, message: EngineMessage) => void;
  /**
   * Mark the whole Reads pile read, chunked, via the shell. Distinct from `markSeen`, which
   * is the per-message dwell writer, and from the `feed_mark_seen` waterline: this flips exactly
   * the unread ids handed to it, folder-agnostically. Optional, since this view mounts without a
   * shell in tests.
   */
  onMarkAllRead?: (ids: string[]) => void;
}) {
  const t = useTranslations("reads");
  const tb = useTranslations("body");
  const locale = useLocale();
  const streamRef = useRef<StreamHandle>(null);
  const listScrollerRef = useRef<HTMLDivElement>(null);
  /** Dedup for the per-card sweep — a card marks itself once per visit. No longer any visual. */
  const [justSeen, setJustSeen] = useState<Set<string>>(() => new Set());
  /**
   * THE CARD WHOSE VERBS ARE SHOWING — the one the reader has EXPANDED, not the scroll-spy's
   * `current`. Gating the bar on `current` made it pop in on every card a scroll settled on; it
   * now follows expansion, and a click select-AND-expands (see `StreamCard`). Single, so the
   * stream still mounts one bar, not two hundred.
   */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const all = useMemo(
    () => [...partition.fresh, ...partition.seen],
    [partition.fresh, partition.seen],
  );
  const allRef = useRef(all);
  allRef.current = all;
  const onLeaveSeenRef = useRef(onLeaveSeen);
  onLeaveSeenRef.current = onLeaveSeen;
  /**
   * The stream's leave report → the waterline commit. The anchor is the newest card the
   * visit displayed; the flip set is the unread ids from that card down to the BOTTOM of
   * the final screen — the contiguous run the reader scrolled through, including the last
   * screenful the exit-through-the-top observer can structurally never reach. Bounded by
   * the viewport, never the pile: what was below the final screen was not displayed and is
   * not flipped. Refs, because this fires while the view is unmounting.
   */
  const onStreamLeave = useCallback((s: StreamLeaveState) => {
    const fn = onLeaveSeenRef.current;
    if (!fn || !s.drove || !s.newestSeenId) return;
    const order = allRef.current;
    const a = order.findIndex((m) => m.id === s.newestSeenId);
    if (a < 0) return;
    const b = s.bottomVisibleId ? order.findIndex((m) => m.id === s.bottomVisibleId) : -1;
    const end = b >= a ? b : a;
    fn({
      upToId: s.newestSeenId,
      messageIds: order.slice(a, end + 1).filter((m) => m.unread).map((m) => m.id),
    });
  }, []);
  /**
   * THE LIST IS A WINDOW over `[fresh, seen]`. A desktop client's mirror is the whole mailbox,
   * so `partition.fresh`/`seen` can be tens of thousands of rows, and mapping every one of them
   * mounted the whole pile on each visit — the cost History was windowed for. The reading
   * stream is bounded its own way — an opening run that grows toward the reader, `stream`
   * below — because its cards are variable-height and `useListWindow`'s fixed-row arithmetic
   * does not fit them. The waterline and the AI chip sit inside the windowed slice.
   */
  const win = useListWindow({ scrollerRef: listScrollerRef, count: all.length });
  const freshCount = partition.fresh.length;
  const freshFrom = Math.min(win.start, freshCount);
  const freshTo = Math.min(win.end, freshCount);
  const seenFrom = Math.max(0, win.start - freshCount);
  const seenTo = Math.max(0, win.end - freshCount);
  /**
   * THE STREAM IS A SLIDING WINDOW over the same `[fresh, seen]` order — only the cards near
   * the viewport are in the DOM, with measured-height spacers standing in for the rest.
   * `stream-window.ts` carries the whole argument (why the growing prefix it replaces made
   * scroll depth a permanent tax, how per-card heights keep the spacers honest, what `\Seen`
   * honesty means under a window).
   *
   * A scroll to a card that is not in the DOM is a silent no-op (`StreamShell.scrollTo`), so
   * every jump goes through `ensure` first and the scroll runs AFTER the commit that mounted
   * the target — `pendingScroll` below is that ordering, made state instead of a race.
   */
  const streamIds = useMemo(() => all.map((m) => m.id), [all]);
  const stream = useStreamWindow({
    ids: streamIds,
    getRoot: () => streamRef.current?.element() ?? null,
  });
  /* The windowed slice, split at the waterline's junction exactly as the list splits its own. */
  const sFreshFrom = Math.min(stream.start, freshCount);
  const sFreshTo = Math.min(stream.end, freshCount);
  const sSeenFrom = Math.max(0, stream.start - freshCount);
  const sSeenTo = Math.max(0, stream.end - freshCount);
  const streamFresh = partition.fresh.slice(sFreshFrom, sFreshTo);
  const streamSeen = partition.seen.slice(sSeenFrom, sSeenTo);
  /**
   * THE SCROLL THAT WAITS FOR ITS CARD — and, for a jump from outside, the OPEN that waits for
   * the scroll.
   *
   * `open` is what distinguishes a jump the reader arrived on (a search result, a tag row, a
   * cross-view "show me this") from a step inside the pile (j/k, a click on a neighbouring row).
   * The step only moves the cursor; the arrival has to leave the message OPEN, because the reader
   * asked for that message and nothing else. See {@link openLandedCard} for why the open happens
   * after the landing rather than with it.
   */
  const [pendingScroll, setPendingScroll] = useState<{ id: string; open: boolean } | null>(null);
  /**
   * OPEN THE LANDED CARD THE WAY A CLICK OPENS IT.
   *
   * `StreamCard` owns its own expanded state, so there is no prop to set: a click on the card
   * selects it and expands it in one gesture (`expandOnClick`, `packages/ui`), which is exactly
   * what "the reader opened this message" means here — the body unclamps and the message's verbs
   * come up. Driving that one mechanism is deliberate; a second way to open a card would be a
   * second definition of open.
   *
   * AFTER the landing, never before. Expanding pins the clip's `max-height` to the content height
   * measured at that moment, and a card the browser has not rendered yet (every card past the
   * fold carries `content-visibility: auto`) measures its intrinsic box rather than its text —
   * which would clip the message it was just asked to show.
   */
  /**
   * A CARD THE SHELL HAS SINCE ASKED TO CLOSE — the anchor loop's own race, closed by name.
   *
   * `scrollTo`'s landing callback fires up to ~1.5s after the jump was requested (the anchoring
   * budget), and a Back inside that window closes the card and then lets the landing re-open it.
   * The re-open is not a state flip this view can see — `openLandedCard` clicks the DOM — so the
   * defence is to remember which id was closed and refuse to open THAT one. Cleared when a fresh
   * jump for the same id arrives, because a second deep link to a message the reader closed
   * earlier is a new request and must open.
   */
  const closedRef = useRef<string | null>(null);
  /**
   * HOW MANY CLOSES HAVE HAPPENED — the ordering `closedRef` alone cannot express.
   *
   * `closedRef` holds an id and keeps holding it, so "was this id closed?" answers the same
   * before and after a second close of the SAME id. The jump needs the other question — "did a
   * close happen while my frame was pending?" — and only a counter answers that: a reader who
   * closes a card, deep-links back to it, and presses Back again inside the frame writes the
   * identical id, and an id comparison sees no change where the sequence changed.
   */
  const closeSeqRef = useRef(0);
  const openLandedCard = useCallback((id: string) => {
    if (closedRef.current === id) return;
    document
      .querySelector<HTMLElement>(`.view-reads .scast[data-sid="${CSS.escape(id)}"]`)
      ?.click();
  }, []);
  useEffect(() => {
    if (!pendingScroll) return;
    const { id, open } = pendingScroll;
    streamRef.current?.scrollTo(id, open ? () => openLandedCard(id) : undefined);
    setPendingScroll(null);
  }, [pendingScroll, openLandedCard]);
  /**
   * THE CONTROLLED CLOSE, driven through the card's OWN PILL — see `closeTo` on the props.
   *
   * The pill is the one definition of close in this codebase: it runs the collapse animation,
   * flips `StreamCard`'s internal `open`, and reports `onToggle(id, false)`, which clears
   * `expandedId` and takes the verbs down in the same motion. A second way to close a card would
   * be a second definition of closed, exactly as `openLandedCard` clicks the card rather than
   * inventing a second way to open one.
   *
   * THE PILL AND NOT THE CARD. Clicking the card selects and EXPANDS it (`expandOnClick`), so a
   * card-click here would re-open the very reading Back just left — and re-select it.
   *
   * Synchronous, with no `requestAnimationFrame`: the jump's frame exists to let a commit mount
   * the target row first, and a close has no such ordering — the card is on screen or there is
   * nothing to close. `[closeTo]` is the whole dependency list for the same reason the jump's is
   * (`onClosed` is a fresh closure on every shell render); the callback is read through a ref.
   *
   * A request for a card that is not mounted, or not open, is ACKNOWLEDGED and does nothing —
   * the shell must not be left holding a request forever because the reader had already
   * collapsed the card themselves.
   */
  const closeRefs = useRef({ onClosed });
  closeRefs.current = { onClosed };
  useEffect(() => {
    if (!closeTo) return;
    closedRef.current = closeTo;
    closeSeqRef.current += 1;
    // A landing still in flight for this id would re-open it; drop it before it can.
    setPendingScroll((p) => (p && p.id === closeTo ? null : p));
    document
      .querySelector<HTMLElement>(
        `.view-reads .scast[data-sid="${CSS.escape(closeTo)}"] .sc-x[aria-expanded="true"]`,
      )
      ?.click();
    closeRefs.current.onClosed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeTo]);
  // The waterline marks the fresh/seen junction; render it only when that junction is inside
  // the mounted window, so it travels with the boundary instead of pinning to the list top.
  const showWaterline = partition.waterline != null && win.start <= freshCount && win.end > freshCount;
  const unreadCount = all.filter((m) => m.unread).length;
  /**
   * WHAT THE PANE COUNTS: the BADGE — the fresh side of the line that is still unread on the
   * server ({@link FeedPartition.newCount}) — never a bare unread count over the pile, and no
   * longer the bare `freshCount` either. `freshCount` is POSITIONAL: it slices the list and
   * places the waterline, and over a stale anchor it can stand above rows the mailbox says
   * were read. While this number was `freshCount` and the rail's was `newCount`, one screen
   * said "3 new" beside a rail saying "1" — the cross-surface divergence this whole seam
   * exists to close, re-created two inches apart. One field, every surface: the rail, this
   * headline, the phone's meta line and its dock all read the selector's own count now.
   */
  const newCount = partition.newCount;
  /**
   * THE MARK-ALL PRESS CLEARS BOTH STATEMENTS THE VIEW MAKES, because a press that clears
   * only one was measured lying: the button (keyed on unread) vanished while the count and
   * the rows stood. The unread ids ride the shell's chunked `mark_seen` (real `\Seen`, to
   * the user's own IMAP via the worker); the line commits to the TOP through the SAME
   * writer the leave-commit uses (`onLeaveSeen` → `commitFeedSeen`, which skips a commit
   * that would change nothing). Afterwards: rows quiet, "0 new", and the button's absence
   * is a statement about the mail.
   */
  const markAllRead = () => {
    const ids = all.filter((m) => m.unread).map((m) => m.id);
    if (ids.length > 0) onMarkAllRead?.(ids);
    const top = all[0];
    if (top) onLeaveSeen?.({ upToId: top.id, messageIds: [] });
  };
  /** The line's stamp: fixture-authored on the demo, formatted from the commit instant live. */
  const wlStamp = partition.waterline?.at ? waterlineStamp(partition.waterline.at, locale) : "";
  const wlMeta =
    partition.waterline?.meta ?? (wlStamp ? t("waterlineMeta", { stamp: wlStamp }) : undefined);
  const current = cur ?? all.find((m) => m.unread)?.id ?? all[0]?.id ?? null;

  const seenMark = (id: string) => {
    const m = all.find((x) => x.id === id);
    if (!m || !m.unread || justSeen.has(id)) return;
    setJustSeen((s) => new Set(s).add(id));
    markSeen(id);
  };

  // Row click / j/k: extend the mounted run through the card, then scroll to it once the commit
  // has it in the DOM (see `pendingScroll` above). A step inside the pile moves the cursor and
  // nothing else — `StreamCard` opens on its own click, and j/k has ↵ for the clamp.
  const jump = (id: string) => {
    seenMark(id);
    onCur(id);
    stream.ensure(all.findIndex((m) => m.id === id));
    setPendingScroll({ id, open: false });
  };

  /**
   * A JUMP FROM OUTSIDE THE PILE — a search result, a tag row, any "show me this message".
   *
   * `[jumpTo]` IS THE WHOLE DEPENDENCY LIST, and that is the point rather than an omission. The
   * work happens in a `requestAnimationFrame`, and the callbacks the shell passes are fresh
   * closures on every one of its renders (`onJumped={() => setJump(null)}`) while `all` is
   * re-derived on every mirror delta — so with either in the deps this effect re-ran, its cleanup
   * cancelled the pending frame, and the jump was dropped for as long as the shell kept
   * re-rendering. A jump is a one-shot response to a request, not a subscription to the pile, so
   * the latest callbacks and the latest order are read through refs at fire time.
   */
  const jumpRefs = useRef({ onCur, onJumped });
  jumpRefs.current = { onCur, onJumped };
  useEffect(() => {
    if (!jumpTo) return;
    /**
     * WHICH REQUEST IS NEWER, DECIDED AT SCHEDULE TIME RATHER THAN ASSUMED.
     *
     * The line below used to clear `closedRef` unconditionally, on the reading that a jump is
     * always the newer request. It is not: this effect runs on the render that sets `jumpTo`
     * and the work happens a frame later, and the close effect is synchronous — so a Back
     * landing inside that one frame set `closedRef`, the frame then cleared it, and the
     * landing re-opened the card the reader had just closed, with the URL already bare.
     * `[jumpTo]` is unchanged by a close, so the effect's own cleanup never ran and the frame
     * was never cancelled.
     *
     * The two cases are separated by the close COUNTER and not by the tombstone's value:
     * closed-before-the-request means a genuinely new deep link to a message the reader closed
     * earlier, which must open; a close COUNTED while this frame was pending wins. Comparing
     * the id alone is not enough and was the first form of this fix — a second Back on a
     * message that was already the tombstone writes the same id, so nothing looks different.
     * The abandoned jump is still acknowledged — the shell must not be left holding a request
     * forever.
     */
    const closeSeqAtRequest = closeSeqRef.current;
    const timer = requestAnimationFrame(() => {
      if (closeSeqRef.current !== closeSeqAtRequest && closedRef.current === jumpTo) {
        jumpRefs.current.onJumped();
        return;
      }
      jumpRefs.current.onCur(jumpTo);
      stream.ensure(allRef.current.findIndex((m) => m.id === jumpTo));
      // A NEW request to show this message outranks an EARLIER close of it — see `closedRef`.
      if (closedRef.current === jumpTo) closedRef.current = null;
      setPendingScroll({ id: jumpTo, open: true });
      jumpRefs.current.onJumped();
    });
    return () => cancelAnimationFrame(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo]);

  /**
   * Keep the row the USER selected in view — `cur`, never `current`.
   *
   * `current` on line 76 is `cur` OR, when nothing has been selected, whichever message
   * happens to be the first unread one. Keyed on that, this effect scrolled the list on
   * MOUNT, to a row nobody had asked for, while the reading stream beside it stayed at the
   * top — and it re-ran every time the fallback re-resolved, which happens whenever a
   * message is marked read. A fallback may decide what is DISPLAYED (the highlight below
   * still follows `current`); it may not move the viewport and it may not be the thing that
   * drives a scroller into the seen-on-scroll machinery, which writes `\Seen` to the user's
   * own IMAP server. See `useSeenOnScroll` for the other half of this.
   */
  useEffect(() => {
    if (!cur) return;
    /**
     * REVEAL BEFORE SCROLLING. The list is a window (`useListWindow`), so the row for a
     * cursor set from OUTSIDE — a search jump landing deep in the pile — may simply not be
     * mounted, and `scrollIntoView` on a missing node is a silent no-op: the jump's arrival
     * had no row, no highlight and a list resting at its top. The window derives from
     * `scrollTop`, so putting the row's offset in view is what mounts it; the shell's locate
     * pass then finds and flashes it. A cursor moved by click or j/k is on a mounted row and
     * takes the `scrollIntoView` path exactly as before.
     */
    const idx = all.findIndex((m) => m.id === cur);
    if (idx >= 0 && (idx < win.start || idx >= win.end)) {
      const el = listScrollerRef.current;
      if (el) {
        el.scrollTop = Math.max(0, idx * win.rowHeight - el.clientHeight / 2);
        return;
      }
    }
    document
      .querySelector(`.view-reads .row[data-id="${CSS.escape(cur)}"]`)
      ?.scrollIntoView({ block: "nearest" });
    // The window's fields are read at fire time; re-running this on every scroll-driven
    // window change would fight the reader for the viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur]);

  /**
   * BECOMING CURRENT IS ONE OF TWO EXPLICIT-INTENT FETCHES; NEITHER IS THE PILE.
   *
   * The card under the cursor is the one being read — put there by a click, by j/k, or by
   * the scroll-spy as somebody scrolls the stream — so that is where the body is asked for
   * here. It also breaks a circle: a card holding only a snippet measures short, and before
   * `bodyState` existed a short card hid its Expand pill, so "hydrate on expand" alone would
   * have had no first move.
   *
   * The SECOND trigger is `StreamShell`'s `onNear` (wired to `hydrateBody` below): a card that
   * has come within a viewport's lookahead of the fold, so the sanitized html viewer is ready
   * as it scrolls in rather than the raw text dump the stream showed until this change. That is
   * what makes Reads read like mail; without it the cards render `body.text` because the html
   * part is never fetched.
   *
   * NEITHER FETCHES THE PILE. `partition.fresh` plus `partition.seen` is the whole of Reads,
   * and a mount that fetched all of it would be a pile-wide prefetch billed per message for
   * mail nobody looked at — and there is no API cost without revenue behind it.
   * Its posture is explicit-intent fetches, and a card the reader has reached — as the cursor
   * or as lookahead — is the smallest honest unit of that. Both paths go through the same
   * idempotent, single-flight `hydrateBody`, so the two triggers never double-spend.
   *
   * Keyed on `current` rather than on the version, so a delta landing mid-read does not
   * re-ask; `hydrateBody` would short-circuit anyway, and depending on the mirror here would
   * make the effect run on every drain.
   */
  useEffect(() => {
    if (current) hydrateBody(current);
  }, [current, hydrateBody]);

  // j/k step cards; ↵ toggles the current card's clamp. Declared into the registry so
  // the `?` sheet knows they exist and so the shell's global map yields to them here.
  const order = streamIds;
  const at = current ? order.indexOf(current) : -1;
  /* ↓/↑ are j/k — one pair of closures under four keycaps, registered into the zone model
     below so the arrows yield to the rail when focus is there (`zone-nav.tsx`). */
  const stepDown = {
    disabled: at >= order.length - 1,
    run: () => {
      if (at < order.length - 1) jump(order[at + 1]!);
    },
    label: t("keyNext"),
  };
  const stepUp = {
    disabled: at <= 0,
    run: () => {
      if (at > 0) jump(order[at - 1]!);
    },
    label: t("keyPrev"),
  };
  const keys: KeyBinding[] = [
    {
      chord: "j",
      group: "navigate",
      label: t("keyNext"),
      disabled: stepDown.disabled,
      run: stepDown.run,
    },
    {
      chord: "k",
      group: "navigate",
      label: t("keyPrev"),
      disabled: stepUp.disabled,
      run: stepUp.run,
    },
    {
      chord: "Enter",
      group: "message",
      label: t("keyExpand"),
      disabled: current == null,
      when: (e) => (e.target as HTMLElement).tagName !== "BUTTON",
      run: () =>
        current &&
        document
          .querySelector<HTMLButtonElement>(
            `.view-reads .scast[data-sid="${CSS.escape(current)}"] .sc-x`,
          )
          ?.click(),
    },
  ];
  useKeyBindings(keys);

  /* The zone model (`zone-nav.tsx`): rail ↔ list. A stream has no third column — the cards
     ARE the reading — so no reader zone is declared and → from the list stays inert. */
  useZoneNav({ list: { up: stepUp, down: stepDown, followId: current ?? null } });

  const row = (m: EngineMessage) => (
    <MessageRow
      key={m.id}
      id={m.id}
      from={senderName(m)}
      address={rowAddress(m)}
      {...avatarOf(m)}
      participants={m.threadId ? threadParticipants?.(m.threadId) : undefined}
      {...rowStamp(m, now, absoluteTime, onToggleTime)}
      subject={m.subject}
      preview={m.snippet}
      /* `data-unseen` for the sweep; NO dot — NEWNESS is the row's position relative to the
         line. READNESS is the mailbox's own statement and renders truthfully: a `\Seen`
         message (including one read before this client ever ran, or in another client)
         takes the quiet ink, an unread one keeps full weight. Measured live without this:
         a warm import rendered every row at unread weight, and "Mark all read" changed
         nothing visible.

         `presentsUnread`, because a message can be resurfaced WHEREVER it lives: the pin is
         state, not a folder, so a `ohmail/Reads` issue put back at the top of the Ohbox is
         listed in both places at once — and one of them drawing it bold while the other drew
         it grey is precisely the inconsistency this derivation exists to remove. It cannot
         cost a stray write: the scroll observer this attribute arms re-judges against the
         STORED flag before it marks anything (`onSeen` below), so a pinned row that is
         already read is observed and skipped. */
      unread={presentsUnread(m)}
      seen={!presentsUnread(m)}
      dotless
      selected={current === m.id}
      tags={tagsOfMessage(m, tags).map((tag) => ({ name: tag.name, hue: hueOf(tag) }))}
      onClick={() => jump(m.id)}
    />
  );

  /* Expanding a card that holds only a snippet IS the request for the rest of it — and the retry
     after a failure, which is why the failed copy says to expand again. It is also what raises the
     verbs, so record which card is open. STABLE (keyed only on `hydrateBody`) so `StreamCardMemo`
     can skip a card whose inputs did not change across a version bump — see its header. */
  const onToggle = useCallback(
    (id: string, open: boolean) => {
      /* CLOSING CLEARS THE BAR ONLY IF THE BAR IS THIS CARD'S. Expansion is per-card and
         multi-card — opening B never collapses A — so once the shell can close A on its own,
         "collapse A while the bar sits on B" is a real sequence, and the unguarded
         `open ? id : null` stripped B's verbs while B stayed open. */
      setExpandedId((prev) => (open ? id : prev === id ? null : prev));
      if (open) hydrateBody(id, { retry: true });
    },
    [hydrateBody],
  );
  const loadingLabel = tb("loading");
  const failedLabel = tb("failed");

  /* One memoized card per MOUNTED message — the memo keeps an apply that touched nothing from
     re-rendering the run, and the run itself keeps a switch from mounting the pile. `bodyOf` is
     called here (not inside the memo) because the body can change without the message reference
     changing; its PRIMITIVE fields are what the card compares on. The verbs, the html viewer and
     the fold-table art all live inside `StreamCardMemo`, gated on `expanded`/`current`, so they
     mount for one card, not two hundred. */
  const card = (m: EngineMessage) => {
    const body = bodyOf(m);
    return (
      <StreamCardMemo
        key={m.id}
        m={m}
        now={now}
        current={current === m.id}
        expanded={expandedId === m.id}
        /* Presented, exactly as the row above — one message drawn twice must not be drawn
           two ways. See the row for why the sweep is unaffected. */
        unread={presentsUnread(m)}
        bodyText={body.text}
        bodyState={body.state}
        bodyHtml={body.html}
        bodyLoadedRemote={body.loadedRemoteContent}
        remoteImages={remoteImages}
        loadingLabel={loadingLabel}
        failedLabel={failedLabel}
        /* Per MARKER (`withheldCopyKey`): which policy emptied the body decides the sentence. */
        withheldLabel={tb(withheldCopyKey(body.withheld))}
        onSelect={onCur}
        onToggle={onToggle}
        onAction={onAction}
      />
    );
  };

  const chipRow =
    aiChip && partition.fresh.some((m) => m.id === aiChip.afterId) ? (
      <div className="reads-chip-row">
        {chipState === "approved" ? (
          <Chip icon="check">{aiChip.approvedLabel}</Chip>
        ) : chipState === "corrected" ? (
          <Chip icon="route">{aiChip.correctedLabel}</Chip>
        ) : (
          <Chip
            variant="ai"
            actions={[
              { label: t("aiApprove"), onPress: () => onChipState("approved") },
              { label: t("aiCorrect"), onPress: () => onChipState("corrected") },
            ]}
          >
            {aiChip.label}
          </Chip>
        )}
      </div>
    ) : null;

  return (
    <section className="view split view-reads">
      <ListPane
        title={t("title")}
        meta={t("meta", { count: newCount })}
        action={
          onMarkAllRead ? (
            <MarkAllRead
              unreadCount={unreadCount}
              freshCount={freshCount}
              onMarkAllRead={markAllRead}
            />
          ) : null
        }
        onSeen={seenMark}
        scrollerRef={listScrollerRef}
        /* Re-scan the seen-on-scroll observer as the window slides — a row that mounts on scroll
           must still mark itself read when the reader scrolls past it. */
        rescanKey={`${win.start}:${win.end}`}
        /* One affordance, not a legend — see `ShortcutHint`. The strip clipped in the split
           layout, and the row-jump sentence taught a click by writing it down; the click
           teaches itself. */
        hints={<ShortcutHint />}
      >
        {/* ONE windowed sequence over `[fresh, seen]`: reserved height above, the fresh slice
            (with the AI chip inline), the waterline at the junction when it is in view, the seen
            slice, then the reserved height below. Two `ListRows` still, so the two groups keep
            their own row containers, but each renders only its share of the mounted window. */}
        {win.padTop > 0 ? <div aria-hidden style={{ height: win.padTop }} /> : null}
        <ListRows>
          {partition.fresh.slice(freshFrom, freshTo).map((m) => (
            <span key={m.id} style={{ display: "contents" }}>
              {row(m)}
              {aiChip?.afterId === m.id ? chipRow : null}
            </span>
          ))}
        </ListRows>
        {showWaterline ? (
          <Waterline label={t("waterline")} meta={wlMeta} />
        ) : null}
        <ListRows>{partition.seen.slice(seenFrom, seenTo).map(row)}</ListRows>
        {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
        <div className="tail-row">{t("tail")}</div>
      </ListPane>

      <StreamShell
        ref={streamRef}
        ariaLabel={t("streamAria")}
        onCurrentChange={onCur}
        onSeen={seenMark}
        onLeave={onStreamLeave}
        /* The viewport-intent body fetch (B.3): a card nearing the fold hydrates so its
           rendered viewer is ready as it arrives. `hydrateBody` is idempotent + single-flight,
           so it composes with the current-card fetch above without double-spending. */
        onNear={hydrateBody}
        /* The MOUNTED slice is the key: a window move mounts new cards, and both of the shell's
           observers re-scan on this value — without it a card mounted by a slide would never
           hydrate on approach and never mark itself seen. Keyed on the slice's own ids (not
           the pile's — joining every id built a string as big as the mailbox per render). */
        contentKey={`${stream.start}:${streamIds.slice(stream.start, stream.end).join(",")}`}
      >
        <div className="stream-top">
          <h1>{t("title")}</h1>
          <span className="meta num">{t("meta", { count: newCount })}</span>
        </div>
        <div className="stream-hints">
          <ShortcutHint />
        </div>
        {/* Reserved height above the window — the mail the reader scrolled past keeps its room. */}
        {stream.padTopPx > 0 ? (
          <div aria-hidden data-stream-head style={{ height: stream.padTopPx }} />
        ) : null}
        {streamFresh.map(card)}
        {/* The waterline marks the fresh/seen junction, so it renders while that junction is
            inside the mounted window — a junction drawn against the wrong neighbours would lie. */}
        {partition.waterline && stream.start <= freshCount && stream.end >= freshCount ? (
          <Waterline label={t("waterline")} meta={wlMeta} />
        ) : null}
        {streamSeen.map(card)}
        {/* The reserved height standing in for the unmounted tail — the scrollbar still says
            how much mail there is. Invisible furniture. */}
        {stream.padBottomPx > 0 ? (
          <div aria-hidden data-stream-tail style={{ height: stream.padBottomPx }} />
        ) : null}
        {/* The end-of-pile line is a CLAIM ("that's everything"), so it is only made while the
            pile's last card is actually mounted above it. */}
        {stream.end >= all.length ? <div className="tail-row">{t("streamTail")}</div> : null}
      </StreamShell>
    </section>
  );
}
