import { memo } from "react";
import type { EngineMessage } from "@ohmail/wire";
import type { ConversationShown } from "@ohmail/app-logic/reader";
import type { StreamModel } from "@ohmail/app-logic/streams";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { Message, MessageHead, type MessageHeadProps } from "@ohmail/ui/mail";
import { NONE, type ReaderEntry } from "../host/index.js";
import { BodyLoadStatus } from "../reader/BodyLoadStatus.js";
import type { Text } from "../text/index.js";
import { useStreamItem } from "./use-stream-item.js";
import { senderOf, stampOf } from "./words.js";

interface StreamItemProps {
  m: EngineMessage;
  selection?: MessageHeadProps["selection"];
  reader: ReaderEntry | typeof NONE;
  t: Text;
  locale: string;
  now: Date;
  text: string | null;
  conversation?: ConversationShown;
  place: StreamModel["place"];
  bodyState: ReturnType<StreamModel["bodyStateOf"]>;
  phone: boolean;
  whole: boolean;
  addressed: boolean;
  opened: boolean;
  active: boolean;
  preview: boolean;
  markUnread: StreamModel["markUnread"];
  scroller: StreamModel["scroller"];
  open: StreamModel["open"];
  closeAddress: (id: string) => void;
  enter: StreamModel["read"]["enter"];
  hydrateOpened: StreamModel["hydrateOpened"];
  setWhole: (id: string, open: boolean) => void;
}

export const StreamItem = memo(function StreamItem(props: StreamItemProps) {
  const {
    m,
    reader,
    t,
    locale,
    now,
    text,
    conversation,
    phone,
    whole,
    addressed,
    opened,
    active,
    scroller,
    open,
    closeAddress,
    enter,
    hydrateOpened,
    setWhole,
  } = props;
  const { card, fold, receiptEvents, inControl } = useStreamItem(
    m,
    whole,
    setWhole,
    hydrateOpened,
    conversation,
  );
  const control = (): void => {
    if (phone) {
      open(m.id);
      return;
    }
    fold();
    if (!whole) open(m.id);
    else closeAddress(m.id);
  };
  return (
    <div
      ref={card}
      className={text === null ? "st-item st-pend" : "st-item"}
      data-stream-item={m.id}
      data-held={whole && active ? "" : undefined}
      data-expanded={whole || conversation !== undefined ? "" : undefined}
      data-unseen={m.unread ? "" : undefined}
      tabIndex={whole ? 0 : undefined}
      onFocus={(event) => {
        const card = event.currentTarget;
        if (
          (whole || conversation !== undefined) &&
          !addressed &&
          card.contains(event.target) &&
          !event.target.closest('.oh-over, .oh-messagehead-tools [aria-haspopup="menu"]') &&
          !card.contains(event.relatedTarget)
        )
          open(m.id);
      }}
      data-open={opened ? "" : undefined}
      onPointerDown={(e) => {
        if (!inControl(e.target)) enter();
      }}
      onClick={(e) => {
        if (inControl(e.target)) return;
        if (!phone && !whole) fold();
        // A heading press reads here, while opening from the list or body can land the letter.
        open(m.id, false, true, !phone && e.target instanceof Element && e.target.closest("h2") !== null);
      }}
    >
      {(whole || conversation !== undefined) && reader !== NONE && reader.OpenCard ? (
        <reader.OpenCard
          message={m}
          markUnread={props.markUnread}
          opened={opened}
          conversation={conversation}
          scroller={scroller}
          onEnter={() => enter(m.id)}
          clip={whole ? { open: true, word: t("item.collapse"), onPress: control } : undefined}
        />
      ) : (
        <FoldedCard {...props} onPress={control} receiptEvents={receiptEvents} />
      )}
    </div>
  );
});

function FoldedCard({
  m,
  selection,
  reader,
  t,
  locale,
  now,
  text,
  place,
  bodyState,
  phone,
  whole,
  preview,
  markUnread,
  onPress,
  receiptEvents,
}: StreamItemProps & {
  onPress: () => void;
  receiptEvents: ReturnType<typeof useStreamItem>["receiptEvents"];
}) {
  const pending = bodyState === "loading";
  const who = senderOf(m);
  const stamp = stampOf(m.date, t, locale, now);
  const amountInHead = place === "receipts" && !m.subject;
  const headingAmount = amountInHead ? undefined : m.amount;
  const PreviewBody = reader !== NONE && preview ? reader.PreviewBody : undefined;
  const previewHead =
    reader !== NONE && reader.PreviewHead ? (
      <reader.PreviewHead
        message={m}
        hideBodyNotice={text === null}
        selection={selection}
        markUnread={markUnread}
      />
    ) : (
      <MessageHead
        sender={{ ...who, displayAddress: displayAddress(who.address) }}
        stamp={{ when: stamp.when, full: false, title: stamp.full }}
        amount={amountInHead ? m.amount : undefined}
        staticMetadata
        selection={selection}
      />
    );
  const hasReceiptEvents = receiptEvents !== null;
  return (
    <Message
      head={
        hasReceiptEvents ? (
          <>
            {previewHead}
            {headingAmount ? (
              <p className="oh-text oh-display oh-message-amount st-receipt-amount">{headingAmount}</p>
            ) : null}
            {m.subject ? <h2 className="oh-text oh-display oh-message-subject">{m.subject}</h2> : null}
            {receiptEvents}
          </>
        ) : (
          previewHead
        )
      }
      subject={hasReceiptEvents ? undefined : m.subject || undefined}
      amount={hasReceiptEvents ? undefined : headingAmount}
      files={
        hasReceiptEvents && m.hasAttachments ? <span className="oh-vh">{t("item.file")}</span> : undefined
      }
      clip={
        phone
          ? {
              open: false,
              word: t("item.full"),
              goes: true,
              incomplete: text === null,
              pending,
              onPress,
            }
          : {
              open: whole,
              word: t(whole ? "item.collapse" : "item.expand"),
              description: t("item.keyboardOpen"),
              incomplete: text === null,
              pending,
              onPress,
            }
      }
    >
      {bodyState === "loading" || bodyState === "failed" ? (
        <>
          <BodyLoadStatus state={bodyState} messageId={m.id} preview />
          <div className="oh-message-body">{m.snippet}</div>
        </>
      ) : PreviewBody ? (
        <div className="oh-message-body">
          <PreviewBody message={m}>{text ?? m.snippet ?? ""}</PreviewBody>
        </div>
      ) : (
        (text ?? m.snippet ?? "")
      )}
    </Message>
  );
}
