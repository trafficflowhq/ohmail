"use client";

/**
 * Receipts — the same two-pane pattern as Reads, with amounts on the right and ONE FLAT LIST
 * of rows. The day headings this view used to draw are gone: they split a short list into
 * one-row sections whose heading was taller than the row under it, and each row already carries
 * its own time stamp, so the heading restated what the row said. Reads never had them, and the
 * two views are meant to read as the same thing.
 *
 * Order still comes from the shell's `receiptsByDay` flatten — newest day first, newest within
 * a day — so nothing about the sequence changed, only what is drawn between the rows.
 *
 * Like Reads, the rows keep two facts apart: NEWNESS is position relative to this view's
 * OWN waterline ("new since last visit" — `view_meta` "receipts_waterline", independent of
 * Reads'; no dots), and READNESS is the mailbox's `\Seen`, rendered as the quiet ink on
 * read rows. Scroll-past still feeds per-message `\Seen` through `mark_seen` (the eventual
 * sweep; the `justSeen` set below is dedup, not state), and LEAVING the view commits the
 * waterline in one anchored `feed_mark_seen` via `onLeaveSeen`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { presentsUnread } from "@ohmail/client-engine";
import type { EngineMessage, MessageBody, TagDTO, WaterlineMeta } from "@ohmail/client-engine";
import { ListPane, ListRows, MessageRow, Waterline } from "@ohmail/ui";
import { MarkAllRead } from "../components/MarkAllRead";
import { ShortcutHint } from "../shell/ShortcutHint";
import { avatarOf, rowAddress, rowStamp, senderName, tagsOfMessage, hueOf, waterlineStamp, withheldCopyKey } from "../shell/format";
import { useKeyBindings, type KeyBinding } from "../shell/keymap";
import { useZoneNav } from "../shell/zone-nav";
import { useListWindow } from "../shell/list-window";
import { type MessageAction } from "../shell/MessagePane";
import { StreamShell, type StreamHandle, type StreamLeaveState } from "../shell/StreamShell";
import { StreamCardMemo } from "../shell/StreamCardMemo";
import type { RemoteImagesChrome } from "../shell/remote-images";
import { useStreamWindow } from "../shell/stream-window";

export function ReceiptsView({
  messages,
  waterline = null,
  freshCount,
  tags,
  threadParticipants,
  absoluteTime,
  onToggleTime,
  now,
  cur,
  onCur,
  unreadCount,
  isUnread,
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
  /** Every receipt, already in display order. Flat — the shell flattens `receiptsByDay`. */
  messages: EngineMessage[];
  /**
   * THIS VIEW'S OWN LINE — `view_meta` "receipts_waterline", never Reads'. Null (a first
   * visit, a harness) renders no line and every row is above it, exactly as Reads behaves
   * before its line exists.
   */
  waterline?: WaterlineMeta | null;
  /**
   * How many of `messages` sit ABOVE the line — computed by the shell from the SAME
   * partition that reads the meta, so the junction the view draws and the count it states
   * cannot disagree. Absent ⇒ everything is fresh (`messages.length`).
   */
  freshCount?: number;
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
  /** The engine's unread count for the pile — drives Mark-all-read only, never a row. */
  unreadCount: number;
  isUnread: (m: EngineMessage) => boolean;
  markSeen: (id: string) => void;
  /** The leave-commit — one anchored `feed_mark_seen` for THIS view. See `ReadsView`. */
  onLeaveSeen?: (commit: { upToId: string; messageIds: string[] }) => void;
  /** The card's text and what it is — `bodyOf` over the live mirror. */
  bodyOf: (m: EngineMessage) => MessageBody;
  /** Ask for one message's body. `retry` marks a human asking again — see `ReadsView`. */
  hydrateBody: (id: string, opts?: { retry?: boolean }) => void;
  /** The remote-images chrome the reading pane reads; the stream's cards read the same one. */
  remoteImages?: RemoteImagesChrome;
  jumpTo: string | null;
  onJumped: () => void;
  /** The controlled close and its acknowledgement — see `ReadsView` for the contract. */
  closeTo?: string | null;
  onClosed?: () => void;
  /** The message verbs — the shell's `onMessageAction`. Optional, exactly as in `ReadsView`. */
  onAction?: (action: MessageAction, message: EngineMessage) => void;
  /** Mark every unread receipt read, chunked, via the shell. Optional: this view mounts
   * without a shell in tests, and a "mark all" with nothing behind it must not render. */
  onMarkAllRead?: (ids: string[]) => void;
}) {
  const t = useTranslations("receipts");
  const tr = useTranslations("reads");
  const tb = useTranslations("body");
  const locale = useLocale();
  const streamRef = useRef<StreamHandle>(null);
  const listScrollerRef = useRef<HTMLDivElement>(null);
  /** Dedup for the per-card sweep — a card marks itself once per visit. No longer any visual. */
  const [justSeen, setJustSeen] = useState<Set<string>>(() => new Set());
  /**
   * THE CARD WHOSE VERBS ARE SHOWING — the one the reader has EXPANDED, and never the one the
   * scroll-spy happens to have made `current`. Scrolling moves `current` (selection, the dwell
   * seen-authority), and gating the reply bar on it made the bar pop in on every card a reader
   * scrolled past. The bar now follows expansion: a click select-AND-expands (see `StreamCard`),
   * which is the one gesture that surfaces it. Single, so the stream still mounts one bar.
   */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const all = messages;
  const allRef = useRef(all);
  allRef.current = all;
  const onLeaveSeenRef = useRef(onLeaveSeen);
  onLeaveSeenRef.current = onLeaveSeen;
  /** The stream's leave report → the waterline commit. Same derivation as `ReadsView`. */
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
  /** Where the line sits in the flat list; everything is fresh until the shell says otherwise. */
  const fresh = Math.min(freshCount ?? all.length, all.length);
  /**
   * The mark-all press clears both of this view's statements — the unread ids through the
   * shell's chunked `mark_seen`, the "N new" count through one line-commit to the top via
   * the same writer the leave-commit uses. See the Reads handler for the live measurement
   * that made the pairing mandatory.
   */
  const markAllRead = () => {
    const ids = all.filter(isUnread).map((m) => m.id);
    if (ids.length > 0) onMarkAllRead?.(ids);
    const top = all[0];
    if (top) onLeaveSeen?.({ upToId: top.id, messageIds: [] });
  };
  const wlStamp = waterline?.at ? waterlineStamp(waterline.at, locale) : "";
  const wlMeta = waterline?.meta ?? (wlStamp ? tr("waterlineMeta", { stamp: wlStamp }) : undefined);
  /**
   * THE LIST IS A WINDOW, not the whole pile. Receipts is a working set on most accounts, but a
   * standalone desktop client's mirror is the whole mailbox, and `all.map(row)` mounted every
   * row of it — the same unbounded cost History was windowed for. The reading stream to its
   * right mounts an opening run that grows toward the reader (`stream-window.ts`, which carries
   * the whole argument): mounting a card per message before first paint was the dominant cost
   * of switching into this view, exactly as it was for Reads.
   */
  const win = useListWindow({ scrollerRef: listScrollerRef, count: all.length });
  // The windowed slice, split at the line's junction exactly as `ReadsView` splits its window.
  const freshFrom = Math.min(win.start, fresh);
  const freshTo = Math.min(win.end, fresh);
  const seenFrom = Math.max(0, win.start - fresh);
  const seenTo = Math.max(0, win.end - fresh);
  const showWaterline = waterline != null && win.start <= fresh && win.end > fresh;
  const stream = useStreamWindow({
    total: all.length,
    getRoot: () => streamRef.current?.element() ?? null,
  });
  /* A scroll to a card that is not in the DOM is a silent no-op (`StreamShell.scrollTo`), so
     every jump extends the run first and scrolls AFTER the commit that mounted the target.
     `open` marks a jump from OUTSIDE the pile, which must leave the message open and not merely
     selected — the same pair, for the same reasons, as `ReadsView`. */
  const [pendingScroll, setPendingScroll] = useState<{ id: string; open: boolean } | null>(null);
  /** A card the shell has since asked to close — see `ReadsView.closedRef` for the race. */
  const closedRef = useRef<string | null>(null);
  /** How many closes have happened — see `ReadsView.closeSeqRef` for why an id cannot say. */
  const closeSeqRef = useRef(0);
  /** Open the landed card the way a click opens it — see `ReadsView.openLandedCard`. */
  const openLandedCard = useCallback((id: string) => {
    if (closedRef.current === id) return;
    document
      .querySelector<HTMLElement>(`.view-receipts .scast[data-sid="${CSS.escape(id)}"]`)
      ?.click();
  }, []);
  useEffect(() => {
    if (!pendingScroll) return;
    const { id, open } = pendingScroll;
    streamRef.current?.scrollTo(id, open ? () => openLandedCard(id) : undefined);
    setPendingScroll(null);
  }, [pendingScroll, openLandedCard]);
  /** The controlled close, through the card's own pill — see `ReadsView` for the full reasoning. */
  const closeRefs = useRef({ onClosed });
  closeRefs.current = { onClosed };
  useEffect(() => {
    if (!closeTo) return;
    closedRef.current = closeTo;
    closeSeqRef.current += 1;
    setPendingScroll((p) => (p && p.id === closeTo ? null : p));
    document
      .querySelector<HTMLElement>(
        `.view-receipts .scast[data-sid="${CSS.escape(closeTo)}"] .sc-x[aria-expanded="true"]`,
      )
      ?.click();
    closeRefs.current.onClosed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeTo]);
  const current = cur ?? all.find(isUnread)?.id ?? all[0]?.id ?? null;

  const seenMark = (id: string) => {
    const m = all.find((x) => x.id === id);
    if (!m || !isUnread(m) || justSeen.has(id)) return;
    setJustSeen((s) => new Set(s).add(id));
    markSeen(id);
  };

  const jump = (id: string) => {
    seenMark(id);
    onCur(id);
    stream.ensure(all.findIndex((m) => m.id === id));
    setPendingScroll({ id, open: false });
  };

  /* A jump from outside the pile. `[jumpTo]` is the whole dependency list for the reason
     `ReadsView`'s twin spells out: the shell's callbacks are fresh closures on every render and
     `all` moves on every mirror delta, so anything else in here cancels the pending frame and
     drops the jump. The latest callbacks and order are read through refs at fire time. */
  const jumpRefs = useRef({ onCur, onJumped });
  jumpRefs.current = { onCur, onJumped };
  useEffect(() => {
    if (!jumpTo) return;
    /* A close COUNTED while this frame was pending wins, exactly as `ReadsView`'s twin spells
       out — including why the counter and not the tombstone's id. `[jumpTo]` does not change on
       a close, so the cleanup never cancels the frame. The abandoned jump is acknowledged. */
    const closeSeqAtRequest = closeSeqRef.current;
    const timer = requestAnimationFrame(() => {
      if (closeSeqRef.current !== closeSeqAtRequest && closedRef.current === jumpTo) {
        jumpRefs.current.onJumped();
        return;
      }
      jumpRefs.current.onCur(jumpTo);
      stream.ensure(allRef.current.findIndex((m) => m.id === jumpTo));
      // A NEW request to show this message outranks an EARLIER close of it.
      if (closedRef.current === jumpTo) closedRef.current = null;
      setPendingScroll({ id: jumpTo, open: true });
      jumpRefs.current.onJumped();
    });
    return () => cancelAnimationFrame(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo]);

  /**
   * Keep the row the USER selected in view — `cur`, never `current`.
   * `current` on line 48 falls back to the first unread message, so keying this effect on
   * it made an untouched view scroll itself on mount and re-scroll every time a commit
   * moved the fallback. Same reasoning, and the same defect, as `ReadsView`.
   */
  useEffect(() => {
    if (!cur) return;
    /* Reveal an unmounted row before scrolling to it — the windowed list mounts its top, so
       a search jump deep into the pile had no row to scroll to and arrived unmarked. Same
       mechanism and reasoning as `ReadsView`'s effect of this name. */
    const idx = all.findIndex((m) => m.id === cur);
    if (idx >= 0 && (idx < win.start || idx >= win.end)) {
      const el = listScrollerRef.current;
      if (el) {
        el.scrollTop = Math.max(0, idx * win.rowHeight - el.clientHeight / 2);
        return;
      }
    }
    document
      .querySelector(`.view-receipts .row[data-id="${CSS.escape(cur)}"]`)
      ?.scrollIntoView({ block: "nearest" });
    // Window fields are read at fire time — see ReadsView for why `cur` is the only key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur]);

  /** The card under the cursor asks for its body. One id, never the pile — see `ReadsView`. */
  useEffect(() => {
    if (current) hydrateBody(current);
  }, [current, hydrateBody]);

  const order = all.map((m) => m.id);
  const at = current ? order.indexOf(current) : -1;
  /* ↓/↑ are j/k — one pair of closures under four keycaps, registered into the zone model
     below so the arrows yield to the rail when focus is there (`zone-nav.tsx`). */
  const stepDown = {
    disabled: at >= order.length - 1,
    run: () => {
      if (at < order.length - 1) jump(order[at + 1]!);
    },
    label: tr("keyNext"),
  };
  const stepUp = {
    disabled: at <= 0,
    run: () => {
      if (at > 0) jump(order[at - 1]!);
    },
    label: tr("keyPrev"),
  };
  const keys: KeyBinding[] = [
    {
      chord: "j",
      group: "navigate",
      label: tr("keyNext"),
      disabled: stepDown.disabled,
      run: stepDown.run,
    },
    {
      chord: "k",
      group: "navigate",
      label: tr("keyPrev"),
      disabled: stepUp.disabled,
      run: stepUp.run,
    },
    {
      chord: "Enter",
      group: "message",
      label: tr("keyExpand"),
      disabled: current == null,
      when: (e) => (e.target as HTMLElement).tagName !== "BUTTON",
      run: () =>
        current &&
        document
          .querySelector<HTMLButtonElement>(
            `.view-receipts .scast[data-sid="${CSS.escape(current)}"] .sc-x`,
          )
          ?.click(),
    },
  ];
  useKeyBindings(keys);

  /* The zone model (`zone-nav.tsx`): rail ↔ list. A stream has no third column — the cards
     ARE the reading — so no reader zone is declared and → from the list stays inert. */
  useZoneNav({ list: { up: stepUp, down: stepDown, followId: current ?? null } });

  /* Expanding is the request for the rest of the receipt, and the retry — and it raises the verbs,
     so record which card is open. STABLE so `StreamCardMemo` can skip an unchanged card across a
     version bump; see its header. */
  const onToggle = useCallback(
    (id: string, open: boolean) => {
      /* Closing clears the bar only if the bar is THIS card's — see `ReadsView.onToggle`. */
      setExpandedId((prev) => (open ? id : prev === id ? null : prev));
      if (open) hydrateBody(id, { retry: true });
    },
    [hydrateBody],
  );
  const loadingLabel = tb("loading");
  const failedLabel = tb("failed");

  /* One memoized card per MOUNTED message — same shape as `ReadsView.card`. */
  const card = (m: EngineMessage) => {
    const body = bodyOf(m);
    return (
      <StreamCardMemo
        key={m.id}
        m={m}
        now={now}
        current={current === m.id}
        expanded={expandedId === m.id}
        /* Presented, exactly as the row below — see it for why `isUnread` still decides
           every ACT and every count in this view. */
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
      amount={m.amount}
      /* `data-unseen` for the sweep; NO dot — newness is position relative to the line,
         exactly as in Reads. Read state renders truthfully beside it: a `\Seen` receipt
         takes the quiet ink, an unread one keeps full weight (see the Reads row for the
         live measurement behind this).

         `presentsUnread` and not the `isUnread` prop, and the split is deliberate: the pin is
         state rather than a folder, so a resurfaced receipt is listed here AND at the top of
         the Ohbox, and the two must draw it the same way. `isUnread` stays the answer for
         everything that ACTS or COUNTS in this view — the mark-all list, the landing cursor,
         the scroll sweep's re-judgement — so a pinned row that is already read is observed
         and skipped rather than written. */
      unread={presentsUnread(m)}
      seen={!presentsUnread(m)}
      dotless
      selected={current === m.id}
      tags={tagsOfMessage(m, tags).map((tag) => ({ name: tag.name, hue: hueOf(tag) }))}
      onClick={() => jump(m.id)}
    />
  );

  return (
    <section className="view split view-receipts">
      <ListPane
        title={t("title")}
        /* "New since last visit" — the fresh side of the line, never an unread count. */
        meta={t("meta", { count: fresh })}
        action={
          onMarkAllRead ? (
            <MarkAllRead
              unreadCount={unreadCount}
              freshCount={fresh}
              onMarkAllRead={markAllRead}
            />
          ) : null
        }
        onSeen={seenMark}
        scrollerRef={listScrollerRef}
        /* Re-scan the seen-on-scroll observer as the window slides, so a row that mounts on
           scroll is still marked read when the reader scrolls past it. */
        rescanKey={`${win.start}:${win.end}`}
        /* One affordance, not a legend — see `ShortcutHint` and the same note in ReadsView. */
        hints={<ShortcutHint />}
      >
        {/* Rows above and below the window as reserved height — the scrollbar and scroll
            position stay what they would be with every row mounted (`useListWindow`). The
            windowed sequence is split at the line's junction, exactly as in `ReadsView`:
            the fresh slice, the waterline when the junction is inside the window, the seen
            slice. */}
        {win.padTop > 0 ? <div aria-hidden style={{ height: win.padTop }} /> : null}
        <ListRows>{all.slice(freshFrom, freshTo).map(row)}</ListRows>
        {showWaterline ? <Waterline label={tr("waterline")} meta={wlMeta} /> : null}
        <ListRows>{all.slice(fresh + seenFrom, fresh + seenTo).map(row)}</ListRows>
        {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
        {/* No-collapse rule: every receipt is a real row above. */}
        <div className="tail-row">{t("tail")}</div>
      </ListPane>

      <StreamShell
        ref={streamRef}
        ariaLabel={t("streamAria")}
        onCurrentChange={onCur}
        onSeen={seenMark}
        onLeave={onStreamLeave}
        /* The run length is part of the key: growth mounts NEW cards, and the seen observer
           re-scans on this value — without it a card mounted by a growth commit would never
           mark itself seen. */
        contentKey={`${stream.count}:${all.map((m) => m.id).join(",")}`}
      >
        <div className="stream-top">
          <h1>{t("title")}</h1>
          <span className="meta num">{t("meta", { count: fresh })}</span>
        </div>
        <div className="stream-hints">
          <ShortcutHint />
        </div>
        {all.slice(0, Math.min(stream.count, fresh)).map(card)}
        {/* The line marks the fresh/seen junction in the stream, so it renders once the run
            has reached it — a junction drawn below cards that are not the last fresh ones
            would lie. Same rule, same shape, as `ReadsView`. */}
        {waterline && stream.count >= fresh ? (
          <Waterline label={tr("waterline")} meta={wlMeta} />
        ) : null}
        {all.slice(fresh, stream.count).map(card)}
        {/* Growth sentinel, then the reserved height standing in for the unmounted tail. */}
        <div ref={stream.sentinelRef} data-stream-sentinel aria-hidden />
        {stream.tailPx > 0 ? <div aria-hidden data-stream-tail style={{ height: stream.tailPx }} /> : null}
        {/* The end-of-pile line is a claim; it is made only over a fully mounted pile. */}
        {stream.count >= all.length ? <div className="tail-row">{t("tail")}</div> : null}
      </StreamShell>
    </section>
  );
}
