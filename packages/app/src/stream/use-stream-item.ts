import type { EngineMessage } from "@ohmail/wire";
import type { ConversationShown } from "@ohmail/app-logic/reader";
import { useEffect, useLayoutEffect, useRef } from "react";
import { animate, motionPx, motionReduced } from "@ohmail/ui/base";
import { useReceiptEventRows } from "./ReceiptEvents.js";

export function useStreamItem(
  m: EngineMessage,
  whole: boolean,
  setWhole: (id: string, open: boolean) => void,
  hydrateOpened: (id: string, ask?: boolean) => void,
  conversation?: ConversationShown,
) {
  const receiptEvents = useReceiptEventRows(m);
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
  const fold = (): void => {
    const body = card.current?.querySelector<HTMLElement>(".oh-message-clip");
    clipFrom.current = body && !motionReduced(body) ? body.clientHeight : null;
    setWhole(m.id, !whole);
  };
  useEffect(() => {
    if (whole || conversation !== undefined) hydrateOpened(m.id, conversation === undefined);
  }, [whole, conversation, hydrateOpened, m.id]);
  const inControl = (target: EventTarget | null): boolean =>
    target instanceof Element &&
    target.closest("button, a, input, textarea, select, [role=menuitem], .oh-over") !== null;
  return { card, fold, receiptEvents, inControl };
}
