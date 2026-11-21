/**
 * THE STREAM: one sheet per item on the reading column's ground, the line "Seen up to here" between new and seen,
 * the action panel of the item last opened at the column's foot. The read rule listens on this scroller alone
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
import { ReceiptEvents } from "./ReceiptEvents.js";
import { useStreamText } from "./words.js";

import { useHoldForReply, useStreamClips, useStreamViewport } from "./use-stream-column.js";

import { StreamItem } from "./StreamItem.js";
import { StreamReplyContext } from "./StreamAbove.js";

export function StreamColumn(props: { phone: boolean; keysHere: boolean }) {
  const { place } = useStreamModel();
  const column = <StreamColumnBody {...props} />;
  return place === "receipts" ? <ReceiptEvents>{column}</ReceiptEvents> : column;
}

function StreamColumnBody({ phone, keysHere }: { phone: boolean; keysHere: boolean }) {
  const state = useStreamColumnModel({ phone, keysHere });
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
    panelKeys,
    actionId,
    setReplyCard,
    whole,
    clip,
    viewport,
  } = state;
  const { start, end, attach, column, width, padTopPx, padBottomPx, near } = viewport;
  const open = useStableCallback(model.open);
  const closeAddress = useStableCallback((id: string) => {
    if (model.addressedId === id) commands.open(null);
  });
  if (model.mayState && model.items.length === 0) return <BlankColumn>{blank("blank.clear")}</BlankColumn>;
  const shown = model.items.slice(start, end);
  const panel = streamPanel(state, phone);
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
              <StreamItem
                m={m}
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
                conversation={conversation}
              />
              {replyHost === m.id ? reply?.sheet(panelKeys && actionId === m.id) : null}
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

function streamPanel(state: ReturnType<typeof useStreamColumnModel>, phone: boolean) {
  const { model, reader, panelId, panelKeys, actionId, keyboardOpened, whole, inline, replyHost, showPanel } =
    state;
  return reader !== NONE && panelId !== null && (!phone || inline) ? (
    <reader.Actions
      messageId={panelId}
      deleteKeyId={model.openId ?? panelId}
      canDeleteKey={model.canDeleteKey}
      canAnswerKey={model.canAnswerKey}
      keysHere={panelKeys && actionId !== null}
      focus={keyboardOpened?.id === panelId && whole.has(panelId)}
      showPanel={showPanel}
      markUnread={model.markUnread}
    />
  ) : undefined;
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
  const { actionId } = model;
  const inline = phone && keysHere && model.addressedId !== null;
  const panelKeys = phone ? inline : keysHere;
  const reply = useContext(StreamReplyContext);
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
  const { clip, keyboardOpened, restored, whole, collapsedAction } = useStreamClips(
    model,
    phone,
    route.open,
    viewport,
  );
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
  const showPanel =
    panelId !== null &&
    collapsedAction !== panelId &&
    (model.actionVisit || whole.has(panelId) || replyHost === panelId);
  useEffect(() => {
    toolbar.current = showPanel ? panelId : null;
  }, [toolbar, panelId, showPanel]);

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
    showPanel,
    keyboardOpened,
    whole,
    clip,
    viewport,
  };
}
