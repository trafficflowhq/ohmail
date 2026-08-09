"use client";

/**
 * Reads — list left, skim stream right. Scroll-marks-seen runs through
 * the engine (`feed_mark_seen`, preserving the waterline anchor), the
 * scroll-spy keeps list and stream in step, and the pending-AI chip
 * carries the classification approval flow.
 */
import { useEffect, useMemo, useRef, useState } from "react";
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
  StreamArt,
  StreamCard,
  Waterline,
} from "@ohmail/ui";
import { avatarOf, rowAddress, displayTime, senderName, tagsOfMessage, hueOf } from "../shell/format";
import { useKeyBindings, type KeyBinding } from "../shell/keymap";
import { useListWindow } from "../shell/list-window";
import { MessageActionBar, type MessageAction } from "../shell/MessagePane";
import { FoldTableArt, StreamShell, type StreamHandle } from "../shell/StreamShell";
// Aliased: `MessageBody` is already imported above as the engine's body DTO type.
import { MessageBody as MessageBodyView } from "../components/MessageBody";

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
   * mounted the whole pile on each visit — the cost History was windowed for. Only the LIST is
   * windowed; the reading stream keeps every card (variable height, `\Seen` on scroll) and is
   * kept cheap off-screen in CSS. The waterline and the AI chip sit inside the windowed slice.
   */
  const win = useListWindow({ scrollerRef: listScrollerRef, count: all.length });
  const freshCount = partition.fresh.length;
  const freshFrom = Math.min(win.start, freshCount);
  const freshTo = Math.min(win.end, freshCount);
  const seenFrom = Math.max(0, win.start - freshCount);
  const seenTo = Math.max(0, win.end - freshCount);
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

  // Row click / tag-view jump: the stream scrolls to the card.
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

  const card = (m: EngineMessage) => {
    const body = bodyOf(m);
    return (
    <StreamCard
      key={m.id}
      id={m.id}
      from={senderName(m)}
      address={m.from.address}
      time={displayTime(m, now)}
      subject={m.subject}
      body={body.text}
      bodyState={body.state}
      loadingLabel={tb("loading")}
      failedLabel={tb("failed")}
      /* Once hydrated, an opened card renders the sanitized html viewer — the same
         `MessageBody` the Ohbox pane and the reader use — instead of dumping `body.text`.
         Only when there is an html part; a plain-text mail keeps the text clamp unchanged.
         No image proxy is threaded here, so remote content stays blocked, which is the
         privacy-preserving default the viewer already ships. */
      bodySlot={
        body.state === "full" && body.html ? (
          <MessageBodyView messageId={m.id} text={body.text} html={body.html} remoteLoaded={body.loadedRemoteContent} />
        ) : undefined
      }
      unread={m.unread || justSeen.has(m.id)}
      justSeen={justSeen.has(m.id)}
      current={current === m.id}
      onSelect={(id) => onCur(id)}
      /* Expanding a card that holds only a snippet IS the request for the rest of it — and
         the retry after a failure, which is why the failed copy says to expand again. It is
         also what raises the verbs, so record which card is open. */
      onToggle={(open) => {
        setExpandedId(open ? m.id : null);
        if (open) hydrateBody(m.id, { retry: true });
      }}
      /* THE VERBS, on the card the reader EXPANDED and on no other. The Ohbox's bar, not a
         second one written for this view — see `MessageActionBar`. Gated on the expanded card
         (never on `current`, which a scroll moves) so a stream of two hundred cards mounts one
         bar, and only when the reader opens a card, not when they scroll past it. */
      actions={
        onAction && expandedId === m.id ? (
          <MessageActionBar message={m} now={now} onAction={(a) => onAction(a, m)} />
        ) : undefined
      }
      art={
        m.art ? (
          <StreamArt ariaLabel={m.art.ariaLabel} caption={m.art.caption}>
            <FoldTableArt />
          </StreamArt>
        ) : undefined
      }
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
        contentKey={all.map((m) => m.id).join(",")}
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
        {partition.fresh.map(card)}
        {partition.waterline ? (
          <Waterline label={t("waterline")} meta={partition.waterline.meta} />
        ) : null}
        {partition.seen.map(card)}
        <div className="tail-row">{t("streamTail")}</div>
      </StreamShell>
    </section>
  );
}
