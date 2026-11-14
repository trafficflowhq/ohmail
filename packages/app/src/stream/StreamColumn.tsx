/**
 * THE STREAM: one sheet per item on the reading column's ground, the line "Seen up to here" between new and seen,
 * the action panel of the item last opened at the column's foot. The read rule listens on this scroller alone
 * (`@ohmail/app-logic/streams`). The item's words are the engine's plain text, a stand-in until the reader hands
 * its own letter: no anchor, nothing that opens by itself. Each item is clipped until it is pressed: a press on it
 * opens it whole, its Expand and Collapse open and shut it; on a phone's width its control is Read in full and the
 * press opens the letter in the reader. A visit starts with every item shut.
 */
import type { EngineMessage } from "@ohmail/wire";
import type { ConversationShown } from "@ohmail/app-logic/reader";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useOptionalKeyBindings } from "@ohmail/app-logic/keys";
import { useDayClock } from "@ohmail/app-logic/session/day-clock";
import { lineStampOf, useStreamModel, type StreamModel } from "@ohmail/app-logic/streams";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { estimateCardHeight } from "@ohmail/ui";
import { Button } from "@ohmail/ui/base";
import { BlankColumn, GroupHeading, Message, MessageHead, Sheet } from "@ohmail/ui/mail";
import { useFrame, useSelectionBar } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { BodyLoadStatus } from "../reader/BodyLoadStatus.js";
import { useLocale, useText, useTimeZone, type Text } from "../text/index.js";
import { ReceiptEvents } from "./ReceiptEvents.js";
import { senderOf, stampOf, useStreamText } from "./words.js";

import { useHoldForReply, useStreamClips, useStreamViewport, type Clip } from "./use-stream-column.js";
import { useStreamItem } from "./use-stream-item.js";

const noReply = (): null => null;

interface StreamItemProps {
  m: EngineMessage;
  model: StreamModel;
  t: Text;
  locale: string;
  clip: Clip;
  now: Date;
  text: string | null;
  near: boolean;
  conversation?: ConversationShown;
}

function Item({ m, model, t, locale, clip, now, text, near, conversation }: StreamItemProps) {
  const { reader, whole, card, control, bodyState, pending, receiptEvents, inControl, press } = useStreamItem(
    m,
    model,
    clip,
    conversation,
  );
  const who = senderOf(m);
  const stamp = stampOf(m.date, t, locale, now);
  const amountInHead = model.place === "receipts" && !m.subject;
  const headingAmount = amountInHead ? undefined : m.amount;
  const PreviewBody =
    reader !== NONE && (near || model.actionId === m.id) && !model.hidePrefetchedNotice(m.id)
      ? reader.PreviewBody
      : undefined;
  const previewHead =
    reader !== NONE && reader.PreviewHead ? (
      <reader.PreviewHead message={m} hideBodyNotice={model.hidePrefetchedNotice(m.id)} />
    ) : (
      <MessageHead
        sender={{ ...who, displayAddress: displayAddress(who.address) }}
        stamp={{ when: stamp.when, full: false, title: stamp.full }}
        amount={amountInHead ? m.amount : undefined}
        staticMetadata
      />
    );
  const hasReceiptEvents = receiptEvents !== null;
  return (
    <div
      ref={card}
      className={text === null ? "st-item st-pend" : "st-item"}
      data-stream-item={m.id}
      data-held={whole && model.actionId === m.id ? "" : undefined}
      data-expanded={whole || conversation !== undefined ? "" : undefined}
      data-unseen={m.unread ? "" : undefined}
      tabIndex={whole ? 0 : undefined}
      onFocus={(event) => {
        const card = event.currentTarget;
        if (
          (whole || conversation !== undefined) &&
          model.addressedId !== m.id &&
          card.contains(event.target) &&
          !event.target.closest(".oh-over") &&
          !card.contains(event.relatedTarget)
        )
          model.open(m.id);
      }}
      data-open={model.openId === m.id ? "" : undefined}
      onPointerDown={(e) => {
        if (!inControl(e.target)) model.read.enter();
      }}
      onClick={(e) => {
        if (!inControl(e.target)) press();
      }}
    >
      {(whole || conversation !== undefined) && reader !== NONE && reader.OpenCard ? (
        <reader.OpenCard
          message={m}
          opened={model.openId === m.id}
          conversation={conversation}
          scroller={model.scroller}
          onEnter={() => model.read.enter(m.id)}
          clip={whole ? { open: true, word: t("item.collapse"), onPress: control } : undefined}
        />
      ) : (
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
            clip.phone
              ? { open: false, word: t("item.full"), goes: true, pending, onPress: control }
              : {
                  open: whole,
                  word: t(whole ? "item.collapse" : "item.expand"),
                  description: t("item.keyboardOpen"),
                  pending,
                  onPress: control,
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
      )}
    </div>
  );
}

export function StreamColumn(props: { phone: boolean; keysHere: boolean }) {
  const { place } = useStreamModel();
  const column = <StreamColumnBody {...props} />;
  return place === "receipts" ? <ReceiptEvents>{column}</ReceiptEvents> : column;
}

function StreamColumnBody({ phone, keysHere }: { phone: boolean; keysHere: boolean }) {
  const {
    model,
    t,
    blank,
    newsText,
    locale,
    now,
    lineStamp,
    host,
    commands,
    reader,
    reply,
    replyHost,
    setReplyCard,
    inline,
    panelKeys,
    actionId,
    panelId,
    keyboardOpened,
    whole,
    clip,
    viewport,
  } = useStreamColumnModel({ phone, keysHere });
  const { start, end, attach, column, width, padTopPx, padBottomPx, near } = viewport;
  if (model.mayState && model.items.length === 0) return <BlankColumn>{blank("blank.clear")}</BlankColumn>;
  const shown = model.items.slice(start, end);
  const panel =
    reader !== NONE && panelId !== null && (!phone || inline) ? (
      <reader.Actions
        messageId={panelId}
        deleteKeyId={model.openId ?? panelId}
        canDeleteKey={model.canDeleteKey}
        canAnswerKey={model.canAnswerKey}
        keysHere={panelKeys && actionId !== null}
        focus={keyboardOpened?.id === panelId && whole.has(panelId)}
        showPanel={model.actionVisit || whole.has(panelId) || replyHost === panelId}
        markUnread={model.markUnread}
      />
    ) : undefined;
  return (
    <Sheet
      kind="reading"
      label={t("stream.label")}
      scroller={attach}
      manualScrollAnchor={shown.length > 0}
      extendTop={!phone}
      foot={panel}
    >
      <div
        ref={column}
        className="st-window"
        data-stream-window=""
        data-receipts={model.place === "receipts" ? "" : undefined}
      >
        {padTopPx > 0 ? <div aria-hidden data-stream-head style={{ height: padTopPx }} /> : null}
        {shown.map((m, i) => {
          const conversation = reply?.conversations.get(m.id);
          const folded = clip.linked !== m.id && !clip.whole.has(m.id) && conversation === undefined;
          const text = model.textOf(m.id);
          const estimate = estimateCardHeight({
            width,
            subject: m.subject || "",
            preview: text ?? m.snippet ?? "",
            recipients: m.to.length + m.cc.length > 1,
            touch: phone,
            clamped: text === null,
          });
          return (
            <div
              key={m.id}
              className="st-window-card"
              data-stream-window-item={m.id}
              data-folded={folded ? "" : undefined}
              style={{ containIntrinsicBlockSize: `auto ${estimate}px` }}
              ref={replyHost === m.id ? setReplyCard : undefined}
            >
              {model.lineShown && start + i === model.freshCount ? (
                <GroupHeading count={lineStamp}>{t("waterline.label")}</GroupHeading>
              ) : null}
              <Item
                m={m}
                model={model}
                t={t}
                locale={locale}
                clip={clip}
                now={now}
                text={text}
                near={near.has(m.id)}
                conversation={conversation}
              />
              {replyHost === m.id ? reply?.sheet : null}
            </div>
          );
        })}
        {padBottomPx > 0 ? <div aria-hidden data-stream-tail style={{ height: padBottomPx }} /> : null}
      </div>
      {model.place === "news" && model.mayState && end === model.items.length ? (
        <p>{newsText("streamTail")}</p>
      ) : null}
      {model.place === "receipts" &&
      host.features.places.search !== NONE &&
      model.items.length > 0 &&
      end === model.items.length ? (
        <Button kind="quiet" size="s" onPress={() => commands.go({ place: "search" })}>
          {t("search.older")}
        </Button>
      ) : null}
    </Sheet>
  );
}

function useStreamColumnModel({ phone, keysHere }: { phone: boolean; keysHere: boolean }) {
  const model = useStreamModel();
  const t = useStreamText(model.place);
  /* The blank of an empty stream is the Ohbox's own word, "All read". */
  const blank = useText("ohbox");
  const newsText = useText("reads");
  const locale = useLocale();
  const { host, commands, route } = useFrame();
  const now = useDayClock(null, useTimeZone());
  const lineStamp =
    model.place === "news" && model.lineAt ? lineStampOf(model.lineAt, now, locale) || undefined : undefined;
  const reader = host.features.reader;
  const useInlineReply = reader === NONE ? noReply : (reader.useInlineReply ?? noReply);
  const { actionId } = model;
  const inline = phone && keysHere && model.addressedId !== null;
  const panelKeys = phone ? inline : keysHere;
  const reply = useInlineReply(panelKeys ? actionId : null, model.items);
  useHoldForReply(model, reply);
  const [replyCard, setReplyCard] = useState<HTMLDivElement | null>(null);
  const replyHost = !phone || inline ? (reply?.messageId ?? null) : null;
  useSelectionBar(inline && reader !== NONE);
  useOptionalKeyBindings(
    inline && replyHost === null
      ? [
          {
            chord: "Escape",
            group: "message",
            label: t("item.collapse"),
            run: model.closeInline,
          },
        ]
      : [],
  );
  useLayoutEffect(() => {
    if (replyHost !== null && replyCard) return model.scroll.revealEnd(replyHost, replyCard);
  }, [model.scroll, replyCard, replyHost]);
  const viewport = useStreamViewport(model);
  const { clip, keyboardOpened, restored, whole } = useStreamClips(model, phone, route.open, viewport);
  const { start, end } = viewport;
  const { scroll, read, toolbar } = model;
  const lastWindow = useRef({ start, end });
  const refreshRead = read.windowChanged;
  useEffect(() => {
    const previous = lastWindow.current;
    lastWindow.current = { start, end };
    if (previous.start === start && previous.end === end) return;
    scroll.windowChanged();
    refreshRead();
  }, [start, end, scroll, refreshRead]);

  const fallback =
    route.open === null && restored !== null && whole.has(restored) && scroll.onScreen(restored)
      ? restored
      : null;
  const panelId = actionId ?? fallback;
  useEffect(() => {
    toolbar.current = panelId;
  }, [toolbar, panelId]);

  return {
    model,
    t,
    blank,
    newsText,
    locale,
    now,
    lineStamp,
    host,
    commands,
    reader,
    reply,
    replyHost,
    setReplyCard,
    inline,
    panelKeys,
    actionId,
    panelId,
    keyboardOpened,
    whole,
    clip,
    viewport,
  };
}
