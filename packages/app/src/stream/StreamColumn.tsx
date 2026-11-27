/**
 * THE STREAM: one sheet per item on the reading column's ground, the line "Seen up to here" between new and seen,
 * the focused item's actions at the column's foot. The read rule listens on this scroller alone
 * (`@ohmail/app-logic/streams`). The item's words are the engine's plain text, a stand-in until the reader hands
 * its own letter: no anchor, nothing that opens by itself. Each item is clipped until it is pressed: a press on it
 * opens it whole, its Expand and Collapse open and shut it; on a phone's width its control is Read in full and the
 * press opens the letter in the reader. A visit starts with every item shut.
 */
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useOptionalKeyBindings } from "@ohmail/app-logic/keys";
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";
import { useDayClock } from "@ohmail/app-logic/session/day-clock";
import { lineStampOf, useStreamModel, type StreamModel } from "@ohmail/app-logic/streams";
import { Button } from "@ohmail/ui/base";
import { BlankColumn, GroupHeading, Sheet } from "@ohmail/ui/mail";
import { estimateCardHeight } from "@ohmail/ui/stream-estimate";
import { useFrame, useSelectionBar } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useLocale, useText, useTimeZone } from "../text/index.js";
import { ListTouch, useGroundPull } from "../touch/index.js";
import { ReceiptEvents } from "./ReceiptEvents.js";
import { receiptAmount, useStreamText } from "./words.js";

import { useHoldForReply, useStreamClips, useStreamViewport } from "./use-stream-column.js";

import type { RowSelection } from "../place-list/use-row-selection.js";
import { StreamItem } from "./StreamItem.js";
import { StreamBackToTop } from "./StreamBackToTop.js";
import { StreamReplyContext } from "./StreamAbove.js";

interface StreamColumnProps {
  phone: boolean;
  keysHere: boolean;
  selection?: RowSelection;
}

export function StreamColumn(props: StreamColumnProps) {
  const { place } = useStreamModel();
  const column = <StreamColumnBody {...props} />;
  return place === "receipts" ? <ReceiptEvents>{column}</ReceiptEvents> : column;
}

function StreamColumnBody({ phone, keysHere, selection }: StreamColumnProps) {
  const showActions = !selection?.active;
  const state = useStreamColumnModel({ phone, keysHere, showActions });
  const {
    model,
    t,
    blank,
    locale,
    now,
    lineStamp,
    commands,
    reader,
    reply,
    replyHost,
    panelKeys,
    actionId,
    setReplyCard,
    whole,
    clip,
    viewport,
  } = state;
  const { armed, restores, start, end, attach, root, column, width, padTopPx, padBottomPx, near } = viewport;
  const pull = useGroundPull();
  const open = useStableCallback(model.open);
  const closeAddress = useStableCallback((id: string) => {
    if (model.addressedId === id) commands.open(null);
  });
  if (model.mayState && model.items.length === 0) return <BlankColumn>{blank("blank.clear")}</BlankColumn>;
  // On a phone the opening slice can paint early if it is where the visit starts.
  const drawCards = armed || (phone && !restores);
  const shown = drawCards ? model.items.slice(start, end) : [];
  return (
    <Sheet
      kind="reading"
      label={t("stream.label")}
      scroller={attach}
      head={
        phone ? (
          <ListTouch scroller={root} pull={pull} off={!showActions} rowSwipe={false} run={false} />
        ) : undefined
      }
      manualScrollAnchor={shown.length > 0}
      extendTop={!phone}
      foot={streamPanel(state, phone, state.panelVisible)}
      jump={
        <StreamBackToTop scroller={model.scroller} keysHere={keysHere} onPress={() => backToTop(model)} />
      }
    >
      <div
        ref={column}
        className="st-window"
        data-stream-window=""
        data-receipts={model.place === "receipts" ? "" : undefined}
      >
        {drawCards && padTopPx > 0 ? <div aria-hidden data-stream-head style={{ height: padTopPx }} /> : null}
        {shown.map((m, i) => {
          const conversation = reply?.conversations.get(m.id);
          const pick = selection?.rowProps(m.id);
          const folded = clip.linked !== m.id && !clip.whole.has(m.id) && conversation === undefined;
          const text = model.textOf(m.id);
          const amount = model.place === "receipts" ? receiptAmount(m, text) : undefined;
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
              <StreamItem
                m={amount && amount !== m.amount ? { ...m, amount } : m}
                selection={
                  pick?.selection ? { control: pick.selection, picked: pick.picked ?? false } : undefined
                }
                reader={reader}
                t={t}
                locale={locale}
                now={now}
                text={text}
                place={model.place}
                bodyState={model.bodyStateOf(m.id)}
                phone={phone}
                whole={!phone && (clip.linked === m.id || whole.has(m.id))}
                addressed={model.addressedId === m.id}
                opened={model.openId === m.id}
                active={model.actionId === m.id}
                preview={(near.has(m.id) || model.actionId === m.id) && model.hasPreviewMarkup(m.id)}
                scroller={model.scroller}
                open={open}
                closeAddress={closeAddress}
                enter={model.read.enter}
                hydrateOpened={model.hydrateOpened}
                setWhole={clip.set}
                markUnread={model.markUnread}
                conversation={conversation}
              />
              {replyHost === m.id ? reply?.sheet(panelKeys && actionId === m.id) : null}
            </div>
          );
        })}
        {drawCards && padBottomPx > 0 ? (
          <div aria-hidden data-stream-tail style={{ height: padBottomPx }} />
        ) : null}
      </div>
      {phone ? olderReceiptsLink(state) : null}
    </Sheet>
  );
}

function backToTop(model: StreamModel): void {
  model.read.moved();
  model.read.own(() => model.scroller?.scrollTo({ top: 0, behavior: "instant" }));
}

function olderReceiptsLink({ model, host, viewport, commands, t }: ReturnType<typeof useStreamColumnModel>) {
  return viewport.armed &&
    model.place === "receipts" &&
    host.features.places.search !== NONE &&
    model.items.length > 0 &&
    viewport.end === model.items.length ? (
    <div className="st-search-tail">
      <Button kind="quiet" size="s" icon="search" onPress={() => commands.go({ place: "search" })}>
        {t("search.older")}
      </Button>
    </div>
  ) : null;
}

function streamPanel(state: ReturnType<typeof useStreamColumnModel>, phone: boolean, visible: boolean) {
  const { model, reader, panelId, panelKeys, actionId, keyboardOpened, whole, canAnswerFromPanel } = state;
  return reader !== NONE && panelId !== null && visible ? (
    <reader.Actions
      messageId={panelId}
      deleteKeyId={model.openId ?? panelId}
      canDeleteKey={model.canDeleteKey}
      canAnswerKey={model.canAnswerKey}
      watchAnswerKey={model.scroll.watchPosition}
      keysHere={panelKeys && actionId !== null}
      focus={keyboardOpened?.id === panelId && whole.has(panelId)}
      room={phone ? "phone" : undefined}
      canAnswerFromPanel={canAnswerFromPanel}
      markUnread={model.markUnread}
    />
  ) : undefined;
}

function useStreamColumnModel({
  phone,
  keysHere,
  showActions,
}: {
  phone: boolean;
  keysHere: boolean;
  showActions: boolean;
}) {
  const model = useStreamModel();
  const t = useStreamText(model.place);
  /* The blank of an empty stream is the Ohbox's own word, "All read". */
  const blank = useText("ohbox");
  const locale = useLocale();
  const { host, commands, route } = useFrame();
  const now = useDayClock(null, useTimeZone());
  const lineStamp = model.lineAt ? lineStampOf(model.lineAt, now, locale) || undefined : undefined;
  const reader = host.features.reader;
  const inline = phone && keysHere && model.addressedId !== null;
  const panelKeys = phone ? inline : keysHere;
  const reply = useContext(StreamReplyContext);
  useHoldForReply(model, reply);
  const [replyCard, setReplyCard] = useState<HTMLDivElement | null>(null);
  const replyHost = !phone || inline ? (reply?.messageId ?? null) : null;
  const actionId = replyHost ?? model.actionId;
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
  const { clip, keyboardOpened, restored, whole, collapsedAction } = useStreamClips(
    model,
    phone,
    route.open,
    viewport,
  );
  const { start, end } = viewport;
  const { scroll, read, toolbar } = model;
  const cardsMounted = viewport.armed && model.items.length > 0;
  const settleRead = read.settled;
  useLayoutEffect(() => {
    // Seed the read rule after the opening cards have painted.
    if (cardsMounted) settleRead();
  }, [cardsMounted, settleRead]);
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
  const addressedPanelId = actionId ?? fallback;
  const panelId = actionId ?? fallback ?? model.standingId;
  const panelVisible = showActions && (!phone || inline);
  const canAnswerFromPanel =
    addressedPanelId !== null &&
    collapsedAction !== addressedPanelId &&
    (model.actionVisit || whole.has(addressedPanelId) || replyHost === addressedPanelId);
  useEffect(() => {
    toolbar.current = panelVisible && reader !== NONE ? panelId : null;
    return () => {
      toolbar.current = null;
    };
  }, [toolbar, panelId, reader, panelVisible]);

  return {
    model,
    t,
    blank,
    locale,
    now,
    lineStamp,
    host,
    commands,
    reader,
    reply,
    replyHost,
    setReplyCard,
    panelKeys,
    actionId,
    panelId,
    panelVisible,
    canAnswerFromPanel,
    keyboardOpened,
    whole,
    clip,
    viewport,
  };
}
