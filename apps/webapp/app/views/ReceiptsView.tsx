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
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { EngineMessage, MessageBody, TagDTO } from "@ohmail/client-engine";
import { Kbd, ListPane, ListRows, MessageRow, StreamCard } from "@ohmail/ui";
import { avatarOf, rowAddress, displayTime, senderName, tagsOfMessage, hueOf } from "../shell/format";
import { useKeyBindings, type KeyBinding } from "../shell/keymap";
import { useListWindow } from "../shell/list-window";
import { MessageActionBar, type MessageAction } from "../shell/MessagePane";
import { StreamShell, type StreamHandle } from "../shell/StreamShell";
// Aliased: `MessageBody` is already imported above as the engine's body DTO type.
import { MessageBody as MessageBodyView } from "../components/MessageBody";

export function ReceiptsView({
  messages,
  tags,
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
}: {
  /** Every receipt, already in display order. Flat — the shell flattens `receiptsByDay`. */
  messages: EngineMessage[];
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
}) {
  const t = useTranslations("receipts");
  const tr = useTranslations("reads");
  const tb = useTranslations("body");
  const streamRef = useRef<StreamHandle>(null);
  const listScrollerRef = useRef<HTMLDivElement>(null);
  const [justSeen, setJustSeen] = useState<Set<string>>(() => new Set());

  const all = messages;
  /**
   * THE LIST IS A WINDOW, not the whole pile. Receipts is a working set on most accounts, but a
   * standalone desktop client's mirror is the whole mailbox, and `all.map(row)` mounted every
   * row of it — the same unbounded cost History was windowed for. Only the LIST column is
   * windowed here; the reading stream to its right stays whole (its cards are variable-height
   * and drive `\Seen` through scroll-coupled observers) and is kept cheap off-screen in CSS.
   */
  const win = useListWindow({ scrollerRef: listScrollerRef, count: all.length });
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
    streamRef.current?.scrollTo(id);
  };

  useEffect(() => {
    if (!jumpTo) return;
    const timer = requestAnimationFrame(() => {
      onCur(jumpTo);
      streamRef.current?.scrollTo(jumpTo);
      onJumped();
    });
    return () => cancelAnimationFrame(timer);
  }, [jumpTo, onCur, onJumped]);

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
        contentKey={all.map((m) => m.id).join(",")}
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
        {all.map((m) => {
          const body = bodyOf(m);
          return (
            <StreamCard
              key={m.id}
              id={m.id}
              from={senderName(m)}
              address={m.from.address}
              amount={m.amount}
              time={displayTime(m, now)}
              subject={m.subject}
              body={body.text}
              bodyState={body.state}
              loadingLabel={tb("loading")}
              failedLabel={tb("failed")}
              /* The opened receipt renders through the same html viewer as everywhere else,
                 once its body has been hydrated and only when there is an html part. See
                 `ReadsView` for the reasoning; remote content stays blocked here too. */
              bodySlot={
                body.state === "full" && body.html ? (
                  <MessageBodyView messageId={m.id} text={body.text} html={body.html} remoteLoaded={body.loadedRemoteContent} />
                ) : undefined
              }
              unread={isUnread(m) || justSeen.has(m.id)}
              justSeen={justSeen.has(m.id)}
              current={current === m.id}
              onSelect={(id) => onCur(id)}
              /* Expanding is the request for the rest of the receipt, and the retry. */
              onToggle={(open) => open && hydrateBody(m.id, { retry: true })}
              /* THE VERBS, on the receipt being read and on no other — the Ohbox's own bar.
                 See `ReadsView` for why it is gated on `current`. */
              actions={
                onAction && current === m.id ? (
                  <MessageActionBar message={m} now={now} onAction={(a) => onAction(a, m)} />
                ) : undefined
              }
            />
          );
        })}
        <div className="tail-row">{t("tail")}</div>
      </StreamShell>
    </section>
  );
}
