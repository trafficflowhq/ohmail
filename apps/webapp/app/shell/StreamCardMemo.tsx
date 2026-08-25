"use client";

/**
 * ONE READING-STREAM CARD, MEMOIZED ON WHAT IT DRAWS — NOT ON THE MESSAGE'S IDENTITY.
 *
 * Reads and Receipts mount an opening run of cards that grows toward the reader and never
 * unmounts (`stream-window.ts` — variable heights rule out the list column's fixed-row window,
 * and the `\Seen` observers need every card a reader could have scrolled past to stay in the
 * DOM). `content-visibility` makes the mounted cards cheap to LAY OUT and PAINT
 * (`app.css`); this is the third piece — the React RECONCILE. Every `/sync` apply bumps
 * the engine version, the shell re-renders, and the pile comes back down and re-runs the render
 * function of every mounted card whether or not its inputs changed. On a large mailbox that is
 * thousands of card renders per poll — most of the CPU a browser tab and the desktop WebView were
 * spending while sitting idle.
 *
 * ── WHY A CUSTOM COMPARATOR AND NOT DEFAULT SHALLOW-EQUAL ─────────────────────────────────────
 *
 * The obvious memo — compare the `m` prop by reference — is WRONG here, and quietly so: it would
 * work in a test that hands the same object back and fail in the app. The pile these views render
 * is the CONSENT PROJECTION (`presentationReader`), which returns `{ ...m, folder: place }` — a
 * FRESH object — for every message presented somewhere other than its physical folder. So a
 * relocated card's `m` reference changes on every version bump even when nothing it shows moved,
 * and a reference memo would re-render exactly those cards forever.
 *
 * So the comparator is keyed on the FACTS the card draws. A message's content is immutable per id
 * (subject, sender, amount and art never change under a stable id), so `m.id` stands in for all of
 * them; `unread` is the one mutable bit and is already folded into the `unread` prop. The body
 * arrives as PRIMITIVES (not the object `bodyOf` mints fresh each call), so a hydration flips
 * exactly the card that hydrated. The callbacks are stable (`useCallback`/state setters in the
 * view), and the per-card facts (`current`, `expanded`) are booleans, so a selection or
 * expand re-renders that one card and no other. `now` is `useMemo`'d on `demo` in the shell.
 *
 * The inline `onToggle`/`onAction`/`bodySlot`/`art` closures are built INSIDE this component, so
 * they cost nothing on a render it skips. The guard is `test/stream-rerender.test.tsx`, which drives the
 * cards through `presentationReader` so a reference memo cannot pass it.
 */

import { memo, type ReactNode } from "react";
import type { EngineMessage, MessageBody } from "@ohmail/client-engine";
import { StreamCard, StreamArt } from "@ohmail/ui";
import { senderName, displayTime } from "./format";
import { displayAddress } from "./idn";
import { MessageActionBar, type MessageAction } from "./MessagePane";
import { FoldTableArt } from "./StreamShell";
import type { RemoteImagesChrome } from "./remote-images";
import { MessageBody as MessageBodyView } from "../components/MessageBody";

export interface StreamCardMemoProps {
  /** The message. Its REFERENCE is not stable across a version bump (`presentationReader` clones a
   *  relocated message), so the comparator keys on `m.id` + the mutable bits, never on this object. */
  m: EngineMessage;
  /** The shell's frozen render clock — one reference across applies. */
  now: Date;
  /** Scroll-spy current card. A boolean so only the two cards whose value flips re-render. */
  current: boolean;
  /** The reader has this card open (the verbs show, the clamp lifts). A boolean, same reason. */
  expanded: boolean;
  /** Stamps `data-unseen` for the seen-on-scroll sweep. Draws nothing — see `StreamCard`. */
  unread: boolean;
  /** Body PRIMITIVES, not the fresh object `bodyOf` returns — see the header. */
  bodyText: string;
  bodyState: MessageBody["state"];
  bodyHtml: string | null;
  /** The STORED per-message consent flag. One of three facts `remoteLoaded` is the OR of. */
  bodyLoadedRemote: boolean;
  /**
   * THE REMOTE-IMAGES CHROME — the same object `MessagePane` and `MessageCard` read, so a card in
   * the stream loads a message's pictures under exactly the rules the reading pane does: the
   * account's auto mode, this session's press, the proxy, the pixel switch. ABSENT on a client
   * with no proxy (the demo, a test with no API), in which case nothing loads and no button is
   * offered — the same answer `MessageBody` gives everywhere else.
   *
   * This used to be missing, and the stream was the one surface where the reading pane's
   * "images load when you open a message" was false: every remote image blanked, the bar
   * counting them as blocked, and no button to press. Compared by REFERENCE in `areEqual` — the
   * hook memoizes it, so it moves only when a setting or a consent changes, which is exactly when
   * every mounted card must re-sanitize.
   */
  remoteImages?: RemoteImagesChrome;
  loadingLabel: string;
  failedLabel: string;
  /** The storage-cap sentence — terminal, honest, no retry implied. */
  withheldLabel: string;
  /** Stable — a `useState` setter chain in the view. Called with the card id. */
  onSelect: (id: string) => void;
  /** Stable — records which card is open and hydrates it. Called with the card id + open state. */
  onToggle: (id: string, open: boolean) => void;
  /** Stable — the shared verbs. Absent ⇒ no bar (demo, or a surface with no mutations). */
  onAction?: (action: MessageAction, m: EngineMessage) => void;
}

function StreamCardMemoInner({
  m, now, current, expanded, unread,
  bodyText, bodyState, bodyHtml, bodyLoadedRemote, remoteImages, loadingLabel, failedLabel, withheldLabel,
  onSelect, onToggle, onAction,
}: StreamCardMemoProps) {
  /* THE SAME THREE-TERM `remoteLoaded` AS `MessagePane`, and the same withheld button in auto
     mode: the stored flag, the account's auto setting, this session's press. Built inside the
     memo so a skipped render costs nothing. */
  const bodySlot: ReactNode =
    bodyState === "full" && bodyHtml ? (
      <MessageBodyView
        messageId={m.id}
        text={bodyText}
        html={bodyHtml}
        remoteLoaded={
          bodyLoadedRemote || (remoteImages?.auto ?? false) || (remoteImages?.consented(m.id) ?? false)
        }
        imageProxy={remoteImages ? remoteImages.proxyFor(m.id) : null}
        onLoadRemote={remoteImages && !remoteImages.auto ? () => remoteImages.consent(m.id) : undefined}
        loadTrackingPixels={remoteImages?.loadPixels ?? false}
      />
    ) : undefined;
  const art: ReactNode = m.art ? (
    <StreamArt ariaLabel={m.art.ariaLabel} caption={m.art.caption}>
      <FoldTableArt />
    </StreamArt>
  ) : undefined;
  return (
    <StreamCard
      id={m.id}
      from={senderName(m)}
      address={displayAddress(m.from.address)}
      amount={m.amount}
      time={displayTime(m, now)}
      subject={m.subject}
      body={bodyText}
      bodyState={bodyState}
      loadingLabel={loadingLabel}
      failedLabel={failedLabel}
      withheldLabel={withheldLabel}
      bodySlot={bodySlot}
      art={art}
      unread={unread}
      current={current}
      onSelect={onSelect}
      onToggle={(open) => onToggle(m.id, open)}
      actions={
        onAction && expanded ? (
          <MessageActionBar message={m} now={now} onAction={(a) => onAction(a, m)} />
        ) : undefined
      }
    />
  );
}

/**
 * Keyed on what the card DRAWS, not on the message reference — see the header. `m.id` stands in for
 * every immutable-per-id field (subject/sender/amount/art); the mutable ones travel as their own
 * props. Miss one and a real change would be dropped, so the list is deliberately exhaustive over
 * `StreamCardMemoProps`.
 */
function areEqual(a: StreamCardMemoProps, b: StreamCardMemoProps): boolean {
  return (
    a.m.id === b.m.id &&
    a.now === b.now &&
    a.current === b.current &&
    a.expanded === b.expanded &&
    a.unread === b.unread &&
    a.bodyText === b.bodyText &&
    a.bodyState === b.bodyState &&
    a.bodyHtml === b.bodyHtml &&
    a.bodyLoadedRemote === b.bodyLoadedRemote &&
    a.remoteImages === b.remoteImages &&
    a.loadingLabel === b.loadingLabel &&
    a.failedLabel === b.failedLabel &&
    a.withheldLabel === b.withheldLabel &&
    a.onSelect === b.onSelect &&
    a.onToggle === b.onToggle &&
    a.onAction === b.onAction
  );
}

export const StreamCardMemo = memo(StreamCardMemoInner, areEqual);
