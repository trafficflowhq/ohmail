"use client";

/**
 * Reads — list left, skim stream right. Scroll-marks-seen runs through
 * the engine (`feed_mark_seen`, preserving the waterline anchor), the
 * scroll-spy keeps list and stream in step, and the pending-AI chip
 * carries the classification approval flow.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type {
  EngineMessage,
  MessageBody,
  ReadsPartition,
  TagDTO,
} from "@ohmail/client-engine";
import {
  Chip,
  Kbd,
  ListPane,
  ListRows,
  MessageRow,
  Waterline,
} from "@ohmail/ui";
import { MarkAllRead } from "../components/MarkAllRead";
import { avatarOf, rowAddress, displayTime, senderName, tagsOfMessage, hueOf } from "../shell/format";
import { useKeyBindings, type KeyBinding } from "../shell/keymap";
import { useListWindow } from "../shell/list-window";
import { type MessageAction } from "../shell/MessagePane";
import { StreamShell, type StreamHandle } from "../shell/StreamShell";
import { StreamCardMemo } from "../shell/StreamCardMemo";
import { useStreamWindow } from "../shell/stream-window";

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
  now,
  cur,
  onCur,
  aiChip,
  chipState,
  onChipState,
  markSeen,
  isSeen,
  bodyOf,
  hydrateBody,
  jumpTo,
  onJumped,
  onAction,
  onMarkAllRead,
}: {
  partition: ReadsPartition;
  tags: TagDTO[];
  now: Date;
  cur: string | null;
  onCur: (id: string) => void;
  aiChip: ReadsAiChipMeta | null;
  chipState: ReadsChipState;
  onChipState: (s: Exclude<ReadsChipState, null>) => void;
  /** Mark one Reads message seen through the engine. */
  markSeen: (id: string) => void;
  isSeen: (m: EngineMessage) => boolean;
  /** The card's text and what it is — `bodyOf` over the live mirror. */
  bodyOf: (m: EngineMessage) => MessageBody;
  /**
   * Ask for one message's body. Idempotent and single-flight; `retry` is what distinguishes
   * a human asking again from an effect re-running — see `OhmailEngine.hydrateBody`.
   */
  hydrateBody: (id: string, opts?: { retry?: boolean }) => void;
  jumpTo: string | null;
  onJumped: () => void;
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
  const streamRef = useRef<StreamHandle>(null);
  const listScrollerRef = useRef<HTMLDivElement>(null);
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
   * THE STREAM MOUNTS AN OPENING RUN over the same `[fresh, seen]` order and grows toward the
   * reader — `stream-window.ts` carries the whole argument (why a prefix and not a window, why
   * `\Seen` stays intact, why growth re-arms). Mounting the pile whole was the dominant cost of
   * switching into this view: one card per message, built before first paint, measured at
   * 1.6–1.8 s of blocked main thread with the pile two thousand deep.
   *
   * A scroll to a card that is not in the DOM is a silent no-op (`StreamShell.scrollTo`), so
   * every jump goes through `ensure` first and the scroll runs AFTER the commit that mounted
   * the target — `pendingScroll` below is that ordering, made state instead of a race.
   */
  const stream = useStreamWindow({
    total: all.length,
    getRoot: () => streamRef.current?.element() ?? null,
  });
  const streamFresh = partition.fresh.slice(0, Math.min(stream.count, freshCount));
  const streamSeen = partition.seen.slice(0, Math.max(0, stream.count - freshCount));
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingScroll) return;
    streamRef.current?.scrollTo(pendingScroll);
    setPendingScroll(null);
  }, [pendingScroll]);
  // The waterline marks the fresh/seen junction; render it only when that junction is inside
  // the mounted window, so it travels with the boundary instead of pinning to the list top.
  const showWaterline = partition.waterline != null && win.start <= freshCount && win.end > freshCount;
  const unreadCount = all.filter((m) => m.unread).length;
  const current = cur ?? all.find((m) => m.unread)?.id ?? all[0]?.id ?? null;

  const seenMark = (id: string) => {
    const m = all.find((x) => x.id === id);
    if (!m || !m.unread || justSeen.has(id)) return;
    setJustSeen((s) => new Set(s).add(id));
    markSeen(id);
  };

  // Row click / tag-view jump: extend the mounted run through the card, then scroll to it
  // once the commit has it in the DOM (see `pendingScroll` above).
  const jump = (id: string) => {
    seenMark(id);
    onCur(id);
    stream.ensure(all.findIndex((m) => m.id === id));
    setPendingScroll(id);
  };

  useEffect(() => {
    if (!jumpTo) return;
    const timer = requestAnimationFrame(() => {
      onCur(jumpTo);
      stream.ensure(all.findIndex((m) => m.id === jumpTo));
      setPendingScroll(jumpTo);
      onJumped();
    });
    return () => cancelAnimationFrame(timer);
  }, [jumpTo, onCur, onJumped, stream.ensure, all]);

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
    document
      .querySelector(`.view-reads .row[data-id="${CSS.escape(cur)}"]`)
      ?.scrollIntoView({ block: "nearest" });
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
   * as it scrolls in rather than the raw text dump the stream showed until this slice. That is
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
  const order = all.map((m) => m.id);
  const at = current ? order.indexOf(current) : -1;
  const keys: KeyBinding[] = [
    {
      chord: "j",
      group: "navigate",
      label: t("keyNext"),
      disabled: at >= order.length - 1,
      run: () => at < order.length - 1 && jump(order[at + 1]!),
    },
    {
      chord: "k",
      group: "navigate",
      label: t("keyPrev"),
      disabled: at <= 0,
      run: () => at > 0 && jump(order[at - 1]!),
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

  const row = (m: EngineMessage) => (
    <MessageRow
      key={m.id}
      id={m.id}
      from={senderName(m)}
      address={rowAddress(m)}
      {...avatarOf(m)}
      time={displayTime(m, now)}
      subject={m.subject}
      preview={m.snippet}
      unread={m.unread || justSeen.has(m.id)}
      justSeen={justSeen.has(m.id)}
      seen={isSeen(m) && !justSeen.has(m.id)}
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
      setExpandedId(open ? id : null);
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
        unread={m.unread || justSeen.has(m.id)}
        justSeen={justSeen.has(m.id)}
        bodyText={body.text}
        bodyState={body.state}
        bodyHtml={body.html}
        bodyLoadedRemote={body.loadedRemoteContent}
        loadingLabel={loadingLabel}
        failedLabel={failedLabel}
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
        meta={t("meta", { count: unreadCount })}
        action={
          onMarkAllRead ? (
            <MarkAllRead
              unreadCount={unreadCount}
              onMarkAllRead={() => onMarkAllRead(all.filter((m) => m.unread).map((m) => m.id))}
            />
          ) : null
        }
        onSeen={seenMark}
        scrollerRef={listScrollerRef}
        /* Re-scan the seen-on-scroll observer as the window slides — a row that mounts on scroll
           must still mark itself read when the reader scrolls past it. */
        rescanKey={`${win.start}:${win.end}`}
        hints={
          <>
            <span>
              <Kbd>j</Kbd> <Kbd>k</Kbd> {t("hintMove")}
            </span>
            <span>
              <Kbd>↵</Kbd> {t("hintExpand")}
            </span>
            <span>{t("hintRowJump")}</span>
          </>
        }
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
          <Waterline label={t("waterline")} meta={partition.waterline!.meta} />
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
        /* The viewport-intent body fetch (B.3): a card nearing the fold hydrates so its
           rendered viewer is ready as it arrives. `hydrateBody` is idempotent + single-flight,
           so it composes with the current-card fetch above without double-spending. */
        onNear={hydrateBody}
        /* The run length is part of the key: growth mounts NEW cards, and both of the shell's
           observers re-scan on this value — without it a card mounted by a growth commit would
           never hydrate on approach and never mark itself seen. */
        contentKey={`${stream.count}:${all.map((m) => m.id).join(",")}`}
      >
        <div className="stream-top">
          <h1>{t("title")}</h1>
          <span className="meta num">{t("meta", { count: unreadCount })}</span>
        </div>
        <div className="stream-hints">
          <span>
            <Kbd>j</Kbd> <Kbd>k</Kbd> {t("hintNextPrev")}
          </span>
          <span>
            <Kbd>↵</Kbd> {t("hintExpand")}
          </span>
          <span>{t("hintSeen")}</span>
        </div>
        {streamFresh.map(card)}
        {/* The waterline marks the fresh/seen junction, so it renders once the run has reached
            it — a junction drawn below cards that are not the last fresh ones would lie. */}
        {partition.waterline && stream.count >= freshCount ? (
          <Waterline label={t("waterline")} meta={partition.waterline.meta} />
        ) : null}
        {streamSeen.map(card)}
        {/* The growth sentinel, then the reserved height standing in for the unmounted tail —
            the scrollbar still says how much mail there is. Both invisible furniture. */}
        <div ref={stream.sentinelRef} data-stream-sentinel aria-hidden />
        {stream.tailPx > 0 ? <div aria-hidden data-stream-tail style={{ height: stream.tailPx }} /> : null}
        {/* The end-of-pile line is a CLAIM ("that's everything"), so it is only made once
            everything is actually mounted above it. */}
        {stream.count >= all.length ? <div className="tail-row">{t("streamTail")}</div> : null}
      </StreamShell>
    </section>
  );
}
