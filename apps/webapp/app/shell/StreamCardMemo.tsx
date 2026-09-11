"use client";

/**
 * One reading-stream card, memoized on what it draws — not the message's identity. Reads and Receipts
 * mount an opening run of cards that never unmounts (`stream-window.ts`), and every `/sync` apply
 * re-renders every mounted card — thousands per poll, most of an idle tab's CPU. A reference memo on `m`
 * is quietly wrong: the pile is the consent projection (`presentationReader`), which returns a FRESH
 * object for every relocated message, so exactly those cards would re-render forever. The comparator keys
 * on the facts the card draws: `m.id` for the immutable fields; the four mutable ones (`unread`,
 * `triage`, `sensitivity.no_forward`, `folder`) each compared; the body as primitives; callbacks stable.
 * The guard is `test/stream-rerender.test.tsx`, driven through `presentationReader`.
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
   * The remote-images chrome — the same object `MessagePane` and `MessageCard` read, so a stream
   * card loads pictures under exactly the reading pane's rules: the account's auto mode, this
   * session's press, the proxy, the pixel switch. Absent on a client with no proxy (the demo, a
   * test with no API): nothing loads and no button is offered. It used to be missing, and the
   * stream was the one surface where "images load when you open a message" was false. Compared by
   * REFERENCE in `areEqual` — the hook memoizes it, so it moves only when a setting or a consent
   * changes, which is exactly when every mounted card must re-sanitize.
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
   * Who else got it — the reading pane's own block, capped (`CARD_RECIPIENT_CHIPS`). Withheld
   * entirely below two: a message addressed to one person is the ordinary case, and "To: you"
   * under every subject is a line that never says anything — the card draws the block exactly when
   * there is something to say. The reading pane keeps naming the single recipient: a reader who
   * opened a message is asking about that message; a card is a summary of a pile. `to`/`cc` are
   * absent on a DTO that predates them, hence `?? 0` — an unknown audience is not several.
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
 * Keyed on what the card DRAWS, not the message reference — see the header. `m.id` stands in for every
 * immutable-per-id field; the mutable ones travel as their own props, and the list is deliberately exhaustive
 * over `StreamCardMemoProps`. Three do not travel as props: `m` is handed whole to `MessageActionBar`, and the
 * projection clones a relocated message, so a NEW object with the SAME id is exactly what a triage change looks
 * like. That gap was covered while `onAction` changed identity every render; once the shell's callbacks became
 * stable (`stable-callback.ts`), Park's button stopped moving and a second press dispatched `set_aside` again
 * instead of `none`. Compared at the exact sub-values `ActionBar` reads (`triage?.state`,
 * `sensitivity?.no_forward`, `folder`), never by container reference — those are rebuilt per projection pass.
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
