import type { EngineMessage } from "@ohmail/wire";
import type { ConversationShown } from "@ohmail/app-logic/reader";
import type { StreamModel } from "@ohmail/app-logic/streams";
import { useEffect, useLayoutEffect, useRef } from "react";
import { animate, motionPx, motionReduced } from "@ohmail/ui/base";
import { useFrame } from "../frame/commands.js";
import { useReceiptEventRows } from "./ReceiptEvents.js";
import type { Clip } from "./use-stream-column.js";

export function useStreamItem(
  m: EngineMessage,
  model: StreamModel,
  clip: Clip,
  conversation?: ConversationShown,
) {
  const { host, commands } = useFrame();
  const reader = host.features.reader;
  const bodyState = model.bodyStateOf(m.id);
  const pending = bodyState === "loading";
  const receiptEvents = useReceiptEventRows(m);
  const whole = !clip.phone && (clip.linked === m.id || clip.whole.has(m.id));
  const card = useRef<HTMLDivElement>(null);
  const clipFrom = useRef<number | null>(null);
  useLayoutEffect(() => {
    const from = clipFrom.current;
    clipFrom.current = null;
    const body = card.current?.querySelector<HTMLElement>(".oh-message-clip");
    if (!body || from === null || typeof body.animate !== "function") return;
    const to = body.clientHeight;
    if (Math.abs(to - from) > motionPx(body, "--stream-clip-motion-threshold")) {
      const flight = animate(body, "in", {
        ease: "--e-move",
        keyframes: [{ maxHeight: `${from}px` }, { maxHeight: `${to}px` }],
      });
      return () => flight?.cancel();
    }
  }, [whole]);
  const fold = (open: boolean): void => {
    const body = card.current?.querySelector<HTMLElement>(".oh-message-clip");
    clipFrom.current = body && !motionReduced(body) ? body.clientHeight : null;
    clip.set(m.id, open);
  };
  const { hydrateOpened } = model;
  useEffect(() => {
    if (whole || conversation !== undefined) hydrateOpened(m.id, conversation === undefined);
  }, [whole, conversation, hydrateOpened, m.id]);
  const inControl = (target: EventTarget | null): boolean =>
    target instanceof Element &&
    target.closest("button, a, input, textarea, select, [role=menuitem], .oh-over") !== null;
  const press = (): void => {
    if (!clip.phone && !whole) fold(true);
    model.open(m.id, false, true);
  };
  const control = (): void => {
    if (clip.phone) {
      model.open(m.id);
      return;
    }
    fold(!whole);
    if (!whole) model.open(m.id);
    else if (model.addressedId === m.id && !model.openedLocally(m.id)) commands.open(null);
  };
  return { reader, whole, card, control, bodyState, pending, receiptEvents, inControl, press };
}
