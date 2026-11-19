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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStreamModel, type StreamModel } from "@ohmail/app-logic/streams";
import { onReplyPress } from "@ohmail/app-logic/writing/sent-reveal";
import { Button } from "@ohmail/ui/base";
import { BlankColumn, GroupHeading, Message, MessageHead, Sheet } from "@ohmail/ui/mail";
import { useFrame } from "../frame/index.js";
import { NONE } from "../host/index.js";
import { useLocale, useText, type Text } from "../text/index.js";
import { senderOf, stampOf, useStreamText } from "./words.js";

/** Items mounted at the opening, and how many more each time the stream nears its foot. */
export const STREAM_RUN = 24;

const noReply = (): null => null;

interface Clip {
  readonly phone: boolean;
  readonly whole: ReadonlySet<string>;
  /** The item opened whole (true), or shut again (false); the press on it says which. */
  readonly set: (id: string, whole: boolean) => void;
}

function Item({
  m,
  model,
  t,
  locale,
  clip,
  conversation,
}: {
  m: EngineMessage;
  model: StreamModel;
  t: Text;
  locale: string;
  clip: Clip;
  conversation?: ConversationShown;
}) {
  const reader = useFrame().host.features.reader;
  const who = senderOf(m);
  const stamp = stampOf(m.date, t, locale);
  const text = model.textOf(m.id);
  const whole = !clip.phone && clip.whole.has(m.id);
  /* The control's press is the control's: the item's own press, heard after it on the way up, leaves it alone. */
  const byControl = useRef(false);
  /* The expanded letter has controls of its own. Only its Collapse control belongs to this card. */
  const inLetterControl = (target: EventTarget | null): boolean =>
    (whole || conversation !== undefined) &&
    target instanceof Element &&
    target.closest("button, a, input, textarea, select, [role=menuitem]") !== null &&
    target.closest(".oh-message-more") === null;
  const press = (): void => {
    if (byControl.current) {
      byControl.current = false;
      return;
    }
    if (!clip.phone) clip.set(m.id, true);
    model.open(m.id);
  };
  const control = (): void => {
    byControl.current = true;
    if (clip.phone) {
      model.open(m.id);
      return;
    }
    clip.set(m.id, !whole);
    if (!whole) model.open(m.id);
  };
  return (
    <div
      className={text === null ? "st-item st-pend" : "st-item"}
      data-stream-item={m.id}
      data-open={model.openId === m.id ? "" : undefined}
      onPointerDown={(e) => {
        if (!inLetterControl(e.target)) model.read.enter();
      }}
      onClick={(e) => {
        if (!inLetterControl(e.target)) press();
      }}
    >
      {(whole || conversation !== undefined) && reader !== NONE && reader.OpenCard ? (
        <reader.OpenCard
          message={m}
          opened={model.openId === m.id}
          conversation={conversation}
          clip={whole ? { open: true, word: t("item.collapse"), onPress: control } : undefined}
        />
      ) : (
        <Message
          head={<MessageHead sender={who} stamp={{ when: stamp.when, full: false, title: stamp.full }} />}
          subject={m.subject || undefined}
          clip={
            clip.phone
              ? { open: false, word: t("item.full"), goes: true, onPress: control }
              : { open: whole, word: t(whole ? "item.collapse" : "item.expand"), onPress: control }
          }
        >
          {text ?? t("item.loading")}
        </Message>
      )}
    </div>
  );
}

/** Hydrate bodies of mounted cards as they come within one viewport of the stream. */
function useNearBodies(model: StreamModel, run: number): void {
  const { scroller, items, hydrateNear } = model;
  useEffect(() => {
    const Observer = scroller?.ownerDocument.defaultView?.IntersectionObserver;
    if (!scroller || !Observer) return;
    let observing = true;
    const observer = new Observer(
      (entries) => {
        if (!observing) return;
        const near: string[] = [];
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-stream-item");
          if (id && entry.isIntersecting) near.push(id);
        }
        hydrateNear(near);
      },
      { root: scroller, rootMargin: "100% 0px" },
    );
    for (const card of scroller.querySelectorAll("[data-stream-item]")) observer.observe(card);
    return () => {
      observing = false;
      observer.disconnect();
    };
  }, [scroller, items, run, hydrateNear]);
}

export function StreamColumn({ phone, keysHere }: { phone: boolean; keysHere: boolean }) {
  const model = useStreamModel();
  const t = useStreamText(model.place);
  /* The blank of an empty stream is the Ohbox's own word, "All read". */
  const blank = useText("ohbox");
  const locale = useLocale();
  const { host, commands } = useFrame();
  const reader = host.features.reader;
  const useInlineReply = reader === NONE ? noReply : (reader.useInlineReply ?? noReply);
  const reply = useInlineReply(keysHere ? model.openId : null, model.items);
  const replyHost = reply?.messageId ?? null;
  useEffect(
    () =>
      onReplyPress((parent) => {
        if (
          replyHost !== null &&
          model.openId !== null &&
          reply?.conversations.get(replyHost)?.messages.some((m) => m.id === parent)
        )
          model.scroll.hold(model.openId);
      }),
    [reply, replyHost, model.openId, model.scroll],
  );
  const lastHost = useRef<string | null>(null);
  useLayoutEffect(() => {
    const closed = lastHost.current;
    if (closed !== null && closed !== replyHost && !reply?.conversations.has(closed))
      model.scroll.hold(closed, true);
    lastHost.current = replyHost;
  }, [replyHost, model.scroll, reply]);
  const [run, setRun] = useState(STREAM_RUN);
  const [whole, setWhole] = useState<ReadonlySet<string>>(() => new Set());
  const landed = useRef<{ id: string; entry: StreamModel["entered"] | null; mayExpand: boolean } | null>(
    null,
  );
  const setOne = useCallback((id: string, open: boolean) => {
    if (!open && landed.current?.id === id) landed.current.mayExpand = false;
    setWhole((was) => {
      if (was.has(id) === open) return was;
      const next = new Set(was);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const clip: Clip = { phone, whole, set: setOne };
  const openId = model.addressedId;
  const openAt = openId === null ? -1 : model.items.findIndex((m) => m.id === openId);

  /*
   * An item opened from the list stands in the stream: mounted, then landed on, once per opening. The scroll is the
   * press's, not a hand's. The run growing under a letter that stays open (End reaching the foot) lands nothing again.
   */
  const { scroll } = model;
  const entry = model.entered;
  const { read } = model;
  useEffect(() => {
    if (openAt < 0 || openId === null) {
      landed.current = null;
      return;
    }
    if (openAt >= run) {
      setRun(openAt + STREAM_RUN);
      return;
    }
    if (model.scroller === null) return;
    const request = !phone && entry?.letter === openId ? entry : null;
    if (landed.current?.id === openId && (!request || landed.current.entry === request)) return;
    const flight = { id: openId, entry: request, mayExpand: request !== null };
    landed.current = flight;
    if (request) {
      read.enter(openId);
      request.taken();
    }
    scroll.scrollTo(
      openId,
      request
        ? () => {
            if (landed.current === flight && flight.mayExpand) setOne(openId, true);
          }
        : undefined,
    );
  }, [openAt, run, openId, model.scroller, scroll, entry, phone, setOne, read]);

  useNearBodies(model, run);

  /* More of the pile as the stream nears its foot. */
  useEffect(() => {
    const scroller = model.scroller;
    if (!scroller || run >= model.items.length) return;
    const grow = (): void => {
      if (scroller.scrollTop + scroller.clientHeight * 2 >= scroller.scrollHeight)
        setRun((r) => r + STREAM_RUN);
    };
    scroller.addEventListener("scroll", grow, { passive: true });
    return () => scroller.removeEventListener("scroll", grow);
  }, [model.scroller, model.items.length, run]);

  if (model.mayState && model.items.length === 0) return <BlankColumn>{blank("blank.clear")}</BlankColumn>;
  const shown = model.items.slice(0, run);
  const panel =
    reader !== NONE && model.openId !== null ? (
      <reader.Actions messageId={model.openId} keysHere={keysHere} markUnread={model.markUnread} />
    ) : undefined;
  return (
    <Sheet kind="reading" label={t("stream.label")} scroller={model.attach} foot={panel}>
      {shown.map((m, i) => (
        <div key={m.id}>
          {model.lineShown && i === model.freshCount ? (
            <GroupHeading>{t("waterline.label")}</GroupHeading>
          ) : null}
          <Item
            m={m}
            model={model}
            t={t}
            locale={locale}
            clip={clip}
            conversation={reply?.conversations.get(m.id)}
          />
          {!phone && reply?.messageId === m.id ? reply.sheet : null}
        </div>
      ))}
      {model.place === "receipts" && host.features.places.search !== NONE && model.items.length > 0 && run >= model.items.length ? (
        <Button kind="quiet" size="s" onPress={() => commands.go({ place: "search" })}>
          {t("search.older")}
        </Button>
      ) : null}
    </Sheet>
  );
}
