/**
 * THE STREAM: one sheet per item on the reading column's ground, the line "Seen up to here" between new and seen,
 * the action panel of the item last opened at the column's foot. The read rule listens on this scroller alone
 * (`@ohmail/app-logic/streams`). The item's words are the engine's plain text, a stand-in until the reader hands
 * its own letter: no anchor, nothing that opens by itself. Each item is clipped until it is pressed: a press on it
 * opens it whole, its Expand and Collapse open and shut it; on a phone's width its control is Read in full and the
 * press opens the letter in the reader. A visit starts with every item shut.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStreamModel, type StreamModel } from "@ohmail/app-logic/streams";
import { Button } from "@ohmail/ui/base";
import { BlankColumn, GroupHeading, Message, MessageHead, Sheet } from "@ohmail/ui/mail";
import { useFrame } from "../frame/index.js";
import { NONE } from "../host/index.js";
import { useLocale, useText, type Text } from "../text/index.js";
import { senderOf, stampOf, useStreamText } from "./words.js";

/** Items mounted at the opening, and how many more each time the stream nears its foot. */
export const STREAM_RUN = 24;

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
}: {
  m: EngineMessage;
  model: StreamModel;
  t: Text;
  locale: string;
  clip: Clip;
}) {
  const who = senderOf(m);
  const stamp = stampOf(m.date, t, locale);
  const text = model.textOf(m.id);
  const whole = !clip.phone && clip.whole.has(m.id);
  /* The control's press is the control's: the item's own press, heard after it on the way up, leaves it alone. */
  const byControl = useRef(false);
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
      onPointerDown={() => model.read.enter()}
      onClick={press}
    >
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
    </div>
  );
}

export function StreamColumn({ phone }: { phone: boolean }) {
  const model = useStreamModel();
  const t = useStreamText(model.place);
  /* The blank of an empty stream is the Ohbox's own word, "All read". */
  const blank = useText("ohbox");
  const locale = useLocale();
  const { host, commands } = useFrame();
  const reader = host.features.reader;
  const [run, setRun] = useState(STREAM_RUN);
  const [whole, setWhole] = useState<ReadonlySet<string>>(() => new Set());
  const setOne = useCallback(
    (id: string, open: boolean) =>
      setWhole((was) => {
        if (was.has(id) === open) return was;
        const next = new Set(was);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );
  const clip: Clip = { phone, whole, set: setOne };
  const openId = model.openId;
  const openAt = openId === null ? -1 : model.items.findIndex((m) => m.id === openId);

  /*
   * An item opened from the list stands in the stream: mounted, then landed on, once per opening. The scroll is the
   * press's, not a hand's. The run growing under a letter that stays open (End reaching the foot) lands nothing again.
   */
  const { scroll } = model;
  const landedId = useRef<string | null>(null);
  useEffect(() => {
    if (openAt < 0 || openId === null) {
      landedId.current = null;
      return;
    }
    if (openAt >= run) {
      setRun(openAt + STREAM_RUN);
      return;
    }
    if (model.scroller === null || landedId.current === openId) return;
    landedId.current = openId;
    scroll.scrollTo(openId);
  }, [openAt, run, openId, model.scroller, scroll]);

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
    reader !== NONE && model.openId !== null && openAt >= 0 ? (
      <reader.Actions messageId={model.openId} />
    ) : undefined;
  return (
    <Sheet kind="reading" label={t("stream.label")} scroller={model.attach} foot={panel}>
      {shown.map((m, i) => (
        <div key={m.id}>
          {model.lineShown && i === model.freshCount ? (
            <GroupHeading>{t("waterline.label")}</GroupHeading>
          ) : null}
          <Item m={m} model={model} t={t} locale={locale} clip={clip} />
        </div>
      ))}
      {model.place === "receipts" && model.items.length > 0 && run >= model.items.length ? (
        <Button kind="quiet" size="s" onPress={() => commands.go({ place: "search" })}>
          {t("search.older")}
        </Button>
      ) : null}
    </Sheet>
  );
}
