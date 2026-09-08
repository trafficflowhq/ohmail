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
 * them. The MUTABLE bits are four, and every one of them is compared: `unread`, which travels as
 * its own prop, and `triage`, `sensitivity.no_forward` and `folder`, which do not — they are drawn
 * by the action bar, which is handed `m` WHOLE. The body arrives as PRIMITIVES (not the object
 * `bodyOf` mints fresh each call), so a hydration flips exactly the card that hydrated. The
 * callbacks are stable (`useCallback`/state setters in the view, and `stable-callback.ts` in the
 * shell), and the per-card facts (`current`, `expanded`) are booleans, so a selection or expand
 * re-renders that one card and no other. `now` is `useMemo`'d on `demo` in the shell.
 *
 * That "four" is load-bearing and was three for a while: the three that arrive inside `m` were
 * missing, and nothing caught it because `onAction` still changed identity often enough to
 * re-render the card for another reason. See `areEqual` for what that cost once the shell's
 * callbacks became genuinely stable.
 *
 * The inline `onToggle`/`onAction`/`bodySlot`/`art` closures are built INSIDE this component, so
 * they cost nothing on a render it skips. The guard is `test/stream-rerender.test.tsx`, which drives the
 * cards through `presentationReader` so a reference memo cannot pass it.
 */

import { memo, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { EngineMessage, MessageBody } from "@ohmail/client-engine";
import { StreamCard, StreamArt } from "@ohmail/ui";
import { senderName, displayTime } from "./format";
import { displayAddress } from "./idn";
import { MessageActionBar, type MessageAction } from "./MessagePane";
import { MessageRecipients } from "./MessageRecipients";
import { FoldTableArt } from "./StreamShell";
import type { RemoteImagesChrome } from "./remote-images";
import { MessageBody as MessageBodyView } from "../components/MessageBody";
import { BlockNoticeGloss, type BlockNotice } from "../components/BlockNotice";

/**
 * HOW MANY RECIPIENTS A CARD NAMES BEFORE THE REST BECOMES A COUNT.
 *
 * The reading pane names everyone; a card is a summary and has one head's worth of room. Two
 * is what a `To` label plus two `Name – address` chips occupy without the row becoming the
 * tallest thing in the head at 390px, which is the width most of this view is read at
 * (`scripts/fit-render.mjs` measures the block at 390 and 1440). Above it the block folds to
 * `+N more`, behind the same press that already reveals the exact date and the message's
 * physical folder — see `MessageRecipients`.
 */
const CARD_RECIPIENT_CHIPS = 2;

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
  /* The card's two toggle words. `StreamCard` has none of its own — see `copy-census`. */
  const tm = useTranslations("message");
  /**
   * WHAT THIS MESSAGE HAD REFUSED, as the viewer reports it (`MessageBody.onNotice`) — carried to
   * the card's HEAD as a glyph rather than said as a bar above the body. Internal state, not a
   * prop, so `areEqual` below is untouched: the viewer reports once per real change, this card
   * re-renders once to place the glyph, and a card with nothing refused never re-renders for it.
   * `setNotice` is a state setter and therefore stable, which is what keeps the viewer's effect
   * from re-firing on every render of this card.
   */
  const [notice, setNotice] = useState<BlockNotice | null>(null);
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
        onNotice={setNotice}
      />
    ) : undefined;
  /**
   * WHO ELSE GOT IT — the reading pane's own block, capped (`CARD_RECIPIENT_CHIPS`).
   *
   * WITHHELD ENTIRELY BELOW TWO. A message addressed to one person is the ordinary case, and
   * "To: you" under every subject in the stream is a line that never says anything — the item
   * asks that a message with SEVERAL recipients say so, so the card draws the block exactly
   * when there is something to say and is otherwise the header it was. The reading pane keeps
   * naming the single recipient, because a reader who opened a message is asking about that
   * message; a card is a summary of a pile.
   *
   * `to`/`cc` are absent on a DTO that predates them and on a bare test message, hence `?? 0`
   * — an unknown audience is not several.
   */
  const recipientCount = (m.to?.length ?? 0) + (m.cc?.length ?? 0);
  const recipients: ReactNode =
    recipientCount > 1 ? <MessageRecipients message={m} max={CARD_RECIPIENT_CHIPS} /> : undefined;

  /* Shown only while the viewer that reported it is mounted: a card whose body went back to a
     snippet has no document left for the fact to be true of. */
  const noticeNode: ReactNode =
    bodySlot && notice ? <BlockNoticeGloss notice={notice} /> : undefined;
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
      notice={noticeNode}
      subject={m.subject}
      body={bodyText}
      bodyState={bodyState}
      expandLabel={tm("expandCard")}
      collapseLabel={tm("collapseCard")}
      loadingLabel={loadingLabel}
      failedLabel={failedLabel}
      withheldLabel={withheldLabel}
      bodySlot={bodySlot}
      recipients={recipients}
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
 *
 * ── THE THREE THAT DO NOT TRAVEL AS THEIR OWN PROP ──────────────────────────────────────────
 *
 * `m` is handed WHOLE to `MessageActionBar`, so the fields that bar reads are drawn by this card
 * even though they arrive inside `m` rather than beside it. `m.id` alone cannot stand in for them:
 * the projection clones a relocated message, so a NEW object with the SAME id is exactly what a
 * triage change looks like, and comparing ids says "equal" to it.
 *
 * That gap was invisible for as long as `onAction` changed identity on every render that mattered
 * — the card re-rendered for that reason and picked up the fresh `m` on the way past. Once the
 * shell's callbacks became genuinely stable (`stable-callback.ts`) the cover was gone and the
 * defect became reachable: press Park on a card, the mutation lands, the button does not move
 * because the card still holds the pre-mutation `m`; press again and the STALE `m` reaches the
 * handler, which dispatches `set_aside` a second time instead of `none`, so the message cannot be
 * unparked from the card that parked it.
 *
 * Compared at the exact sub-values `ActionBar` reads (`triage?.state`, `sensitivity?.no_forward`,
 * `folder`) rather than by object reference: the containers are rebuilt per projection pass, so a
 * reference comparison would re-render every card on every version bump — the cost this memo
 * exists to avoid — while telling us nothing about whether the card's drawing changed.
 */
function areEqual(a: StreamCardMemoProps, b: StreamCardMemoProps): boolean {
  return (
    a.m.id === b.m.id &&
    a.m.triage?.state === b.m.triage?.state &&
    a.m.sensitivity?.no_forward === b.m.sensitivity?.no_forward &&
    a.m.folder === b.m.folder &&
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
