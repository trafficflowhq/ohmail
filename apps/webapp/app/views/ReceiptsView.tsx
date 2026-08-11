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
 * Seen-marking goes through the shell's `mark_seen` mutation, so it reaches `\Seen` on the
 * user's own IMAP server; the local `justSeen` set below is only the fade, not the state.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { EngineMessage, MessageBody, TagDTO } from "@ohmail/client-engine";
import { Kbd, ListPane, ListRows, MessageRow } from "@ohmail/ui";
import { MarkAllRead } from "../components/MarkAllRead";
import { avatarOf, rowAddress, displayTime, senderName, tagsOfMessage, hueOf } from "../shell/format";
import { useKeyBindings, type KeyBinding } from "../shell/keymap";
import { useListWindow } from "../shell/list-window";
import { type MessageAction } from "../shell/MessagePane";
import { StreamShell, type StreamHandle } from "../shell/StreamShell";
import { StreamCardMemo } from "../shell/StreamCardMemo";
import { useStreamWindow } from "../shell/stream-window";

export function ReceiptsView({
  messages,
  tags,
  threadParticipants,
  now,
  cur,
  onCur,
  unreadCount,
  isUnread,
  markSeen,
  bodyOf,
  hydrateBody,
  jumpTo,
  onJumped,
  onAction,
  onMarkAllRead,
}: {
  /** Every receipt, already in display order. Flat — the shell flattens `receiptsByDay`. */
  messages: EngineMessage[];
  /**
   * THE PEOPLE IN A ROW'S CONVERSATION, for its lead circles — bound to the engine's reader by
   * the shell (this view has none) and mapped to `{initials, hue}`. A LOOKUP into the shell's
   * per-version thread index, so calling it per row costs nothing; `[]` for a message whose
   * thread has no second voice in it, and the row then leads with the one sender's circle it
   * always did. Optional, so a view mounted without it (the demo, most tests) is unchanged.
   */
  threadParticipants?: (threadId: string) => { initials: string; hue: number }[];
  tags: TagDTO[];
  now: Date;
  cur: string | null;
  onCur: (id: string) => void;
  /** Engine unread minus the client seen-overlay. */
  unreadCount: number;
  isUnread: (m: EngineMessage) => boolean;
  markSeen: (id: string) => void;
  /** The card's text and what it is — `bodyOf` over the live mirror. */
  bodyOf: (m: EngineMessage) => MessageBody;
  /** Ask for one message's body. `retry` marks a human asking again — see `ReadsView`. */
  hydrateBody: (id: string, opts?: { retry?: boolean }) => void;
  jumpTo: string | null;
  onJumped: () => void;
  /** The message verbs — the shell's `onMessageAction`. Optional, exactly as in `ReadsView`. */
  onAction?: (action: MessageAction, message: EngineMessage) => void;
  /** Mark every unread receipt read, chunked, via the shell. Optional: this view mounts
   * without a shell in tests, and a "mark all" with nothing behind it must not render. */
  onMarkAllRead?: (ids: string[]) => void;
}) {
  const t = useTranslations("receipts");
  const tr = useTranslations("reads");
  const tb = useTranslations("body");
  const streamRef = useRef<StreamHandle>(null);
  const listScrollerRef = useRef<HTMLDivElement>(null);
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
  /**
   * THE LIST IS A WINDOW, not the whole pile. Receipts is a working set on most accounts, but a
   * standalone desktop client's mirror is the whole mailbox, and `all.map(row)` mounted every
   * row of it — the same unbounded cost History was windowed for. The reading stream to its
   * right mounts an opening run that grows toward the reader (`stream-window.ts`, which carries
   * the whole argument): mounting a card per message before first paint was the dominant cost
   * of switching into this view, exactly as it was for Reads.
   */
  const win = useListWindow({ scrollerRef: listScrollerRef, count: all.length });
  const stream = useStreamWindow({
    total: all.length,
    getRoot: () => streamRef.current?.element() ?? null,
  });
  /* A scroll to a card that is not in the DOM is a silent no-op (`StreamShell.scrollTo`), so
     every jump extends the run first and scrolls AFTER the commit that mounted the target. */
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingScroll) return;
    streamRef.current?.scrollTo(pendingScroll);
    setPendingScroll(null);
  }, [pendingScroll]);
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
   * `current` on line 48 falls back to the first unread message, so keying this effect on
   * it made an untouched view scroll itself on mount and re-scroll every time a commit
   * moved the fallback. Same reasoning, and the same defect, as `ReadsView`.
   */
  useEffect(() => {
    if (!cur) return;
    document
      .querySelector(`.view-receipts .row[data-id="${CSS.escape(cur)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  /** The card under the cursor asks for its body. One id, never the pile — see `ReadsView`. */
  useEffect(() => {
    if (current) hydrateBody(current);
  }, [current, hydrateBody]);

  const order = all.map((m) => m.id);
  const at = current ? order.indexOf(current) : -1;
  const keys: KeyBinding[] = [
    {
      chord: "j",
      group: "navigate",
      label: tr("keyNext"),
      disabled: at >= order.length - 1,
      run: () => at < order.length - 1 && jump(order[at + 1]!),
    },
    {
      chord: "k",
      group: "navigate",
      label: tr("keyPrev"),
      disabled: at <= 0,
      run: () => at > 0 && jump(order[at - 1]!),
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

  /* Expanding is the request for the rest of the receipt, and the retry — and it raises the verbs,
     so record which card is open. STABLE so `StreamCardMemo` can skip an unchanged card across a
     version bump; see its header. */
  const onToggle = useCallback(
    (id: string, open: boolean) => {
      setExpandedId(open ? id : null);
      if (open) hydrateBody(id, { retry: true });
    },
    [hydrateBody],
  );
  const loadingLabel = tb("loading");
  const failedLabel = tb("failed");

  const row = (m: EngineMessage) => (
    <MessageRow
      key={m.id}
      id={m.id}
      from={senderName(m)}
      address={rowAddress(m)}
      {...avatarOf(m)}
      participants={m.threadId ? threadParticipants?.(m.threadId) : undefined}
      time={displayTime(m, now)}
      subject={m.subject}
      preview={m.snippet}
      amount={m.amount}
      unread={isUnread(m) || justSeen.has(m.id)}
      justSeen={justSeen.has(m.id)}
      seen={!isUnread(m) && !justSeen.has(m.id)}
      selected={current === m.id}
      tags={tagsOfMessage(m, tags).map((tag) => ({ name: tag.name, hue: hueOf(tag) }))}
      onClick={() => jump(m.id)}
    />
  );

  return (
    <section className="view split view-receipts">
      <ListPane
        title={t("title")}
        meta={t("meta", { count: unreadCount })}
        action={
          onMarkAllRead ? (
            <MarkAllRead
              unreadCount={unreadCount}
              onMarkAllRead={() => onMarkAllRead(all.filter(isUnread).map((m) => m.id))}
            />
          ) : null
        }
        onSeen={seenMark}
        scrollerRef={listScrollerRef}
        /* Re-scan the seen-on-scroll observer as the window slides, so a row that mounts on
           scroll is still marked read when the reader scrolls past it. */
        rescanKey={`${win.start}:${win.end}`}
        hints={
          <>
            <span>
              <Kbd>j</Kbd> <Kbd>k</Kbd> {tr("hintMove")}
            </span>
            <span>
              <Kbd>↵</Kbd> {tr("hintExpand")}
            </span>
            <span>{tr("hintRowJump")}</span>
          </>
        }
      >
        <ListRows>
          {/* Rows above and below the window as reserved height — the scrollbar and scroll
              position stay what they would be with every row mounted. See `useListWindow`. */}
          {win.padTop > 0 ? <div aria-hidden style={{ height: win.padTop }} /> : null}
          {all.slice(win.start, win.end).map(row)}
          {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
        </ListRows>
        {/* No-collapse rule: every receipt is a real row above. */}
        <div className="tail-row">{t("tail")}</div>
      </ListPane>

      <StreamShell
        ref={streamRef}
        ariaLabel={t("streamAria")}
        onCurrentChange={onCur}
        onSeen={seenMark}
        /* The run length is part of the key: growth mounts NEW cards, and the seen observer
           re-scans on this value — without it a card mounted by a growth commit would never
           mark itself seen. */
        contentKey={`${stream.count}:${all.map((m) => m.id).join(",")}`}
      >
        <div className="stream-top">
          <h1>{t("title")}</h1>
          <span className="meta num">{t("meta", { count: unreadCount })}</span>
        </div>
        <div className="stream-hints">
          <span>
            <Kbd>j</Kbd> <Kbd>k</Kbd> {tr("hintNextPrev")}
          </span>
          <span>
            <Kbd>↵</Kbd> {tr("hintExpand")}
          </span>
          <span>{tr("hintSeen")}</span>
        </div>
        {all.slice(0, stream.count).map((m) => {
          const body = bodyOf(m);
          return (
            <StreamCardMemo
              key={m.id}
              m={m}
              now={now}
              current={current === m.id}
              expanded={expandedId === m.id}
              unread={isUnread(m) || justSeen.has(m.id)}
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
        })}
        {/* Growth sentinel, then the reserved height standing in for the unmounted tail. */}
        <div ref={stream.sentinelRef} data-stream-sentinel aria-hidden />
        {stream.tailPx > 0 ? <div aria-hidden data-stream-tail style={{ height: stream.tailPx }} /> : null}
        {/* The end-of-pile line is a claim; it is made only over a fully mounted pile. */}
        {stream.count >= all.length ? <div className="tail-row">{t("tail")}</div> : null}
      </StreamShell>
    </section>
  );
}
