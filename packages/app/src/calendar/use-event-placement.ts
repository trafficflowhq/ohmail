import { useLayoutEffect, useState, type RefObject } from "react";
import type { EventBridgeProps, EventCardProps } from "@ohmail/ui/calendar";

export type CardPlacement = Pick<EventCardProps, "style" | "side" | "origin">;
type Bridge = Omit<EventBridgeProps, "tone">;
type Box = Bridge["event"]["box"];
type Seat = { card: CardPlacement; bridge?: Bridge };

const OPEN_EVENT = ".oh-ev[data-open], .oh-erow[data-open]";
const GAP = 10;
const EDGE = 8;
const SHORT_CHIP = 34;
const FIRST_LINE = 28;
const PANEL_ROOM = 68;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

function boxIn(element: Element, origin: DOMRect, scale: number): Box {
  const { left, top, right, bottom } = element.getBoundingClientRect();
  return {
    left: (left - origin.left) / scale,
    right: (right - origin.left) / scale,
    top: (top - origin.top) / scale,
    bottom: (bottom - origin.top) / scale,
  };
}

function visibleBox(box: Box, bounds: Box): Box | null {
  const clipped = {
    left: Math.max(box.left, bounds.left),
    right: Math.min(box.right, bounds.right),
    top: Math.max(box.top, bounds.top),
    bottom: Math.min(box.bottom, bounds.bottom),
  };
  return clipped.right - clipped.left > 3 && clipped.bottom - clipped.top > 3 ? clipped : null;
}

function rim(element: Element) {
  return Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
}

function locateCard(card: HTMLElement, view: HTMLElement, preferred: Element | null): Seat | null {
  const width = view.clientWidth;
  const height = view.clientHeight;
  const origin = view.getBoundingClientRect();
  const cardWidth = card.offsetWidth;
  const cardHeight = card.offsetHeight;
  if (!width || !height || !origin.width || !cardWidth || !cardHeight) return null;
  const scale = origin.width / width;
  const anchors = [...view.querySelectorAll<HTMLElement>(OPEN_EVENT)];
  if (preferred instanceof HTMLElement && anchors.includes(preferred)) {
    anchors.splice(anchors.indexOf(preferred), 1);
    anchors.unshift(preferred);
  }
  if (!anchors.length) {
    return { card: { style: { left: Math.max(EDGE, width - cardWidth - EDGE), top: EDGE } } };
  }
  for (const anchor of anchors) {
    const whole = boxIn(anchor, origin, scale);
    const scroller = anchor.closest(".oh-tg-scroll, .oh-mo-weeks[data-run], .cal-ag-list");
    const bounds = scroller
      ? boxIn(scroller, origin, scale)
      : { left: 0, right: width, top: 0, bottom: height };
    const box = visibleBox(whole, bounds);
    if (box) return besideEvent({ anchor, box, whole, bounds, width, height, card, cardWidth, cardHeight });
  }
  return null;
}

function besideEvent({
  anchor,
  box,
  whole,
  bounds,
  width,
  height,
  card,
  cardWidth,
  cardHeight,
}: {
  anchor: HTMLElement;
  box: Box;
  whole: Box;
  bounds: Box;
  width: number;
  height: number;
  card: HTMLElement;
  cardWidth: number;
  cardHeight: number;
}): Seat {
  const right = box.right + GAP;
  const left = box.left - GAP - cardWidth;
  const side = right + cardWidth <= width - EDGE ? "r" : left >= EDGE ? "l" : "o";
  const x = side === "r" ? right : side === "l" ? left : Math.max(EDGE, width - cardWidth - EDGE);
  const short = whole.bottom - whole.top <= SHORT_CHIP && side !== "o";
  const firstLine = short ? (box.top + box.bottom) / 2 - FIRST_LINE : box.top;
  const min = short ? EDGE : Math.max(EDGE, bounds.top);
  const y = clamp(firstLine, min, height - cardHeight - PANEL_ROOM);
  const head = card.querySelector<HTMLElement>(".oh-ecard-head");
  const placement: CardPlacement = {
    side,
    style: { left: x, top: y },
    origin: { x: side === "l" ? cardWidth : 0, y: clamp((box.top + box.bottom) / 2 - y, 0, cardHeight) },
  };
  if (side === "o") return { card: placement };
  return {
    card: placement,
    bridge: {
      width,
      height,
      side,
      line: Number.parseFloat(getComputedStyle(card).getPropertyValue("--oh-cal-open-line")) || 1,
      event: { box, whole, radius: rim(anchor) },
      card: {
        box: { left: x, top: y, right: x + cardWidth, bottom: y + cardHeight },
        radius: rim(card),
        headBottom: head ? y + head.offsetTop + head.offsetHeight - card.scrollTop : undefined,
      },
    },
  };
}

export function useEventPlacement(
  card: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  revision: number | undefined,
) {
  const [seat, setSeat] = useState<Seat>();
  useLayoutEffect(() => {
    if (!enabled) return;
    const element = card.current;
    const view = element?.closest<HTMLElement>(".cal-body-view");
    const win = view?.ownerDocument.defaultView;
    if (!element || !view || !win) return;
    const active = view.ownerDocument.activeElement;
    const preferred = active?.closest(OPEN_EVENT) ?? null;
    let frame = 0;
    const measure = () => {
      const next = locateCard(element, view, preferred);
      setSeat((last) => next ?? (last?.bridge ? { card: last.card } : last));
    };
    const schedule = () => {
      if (frame) return;
      frame = win.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    measure();
    view.addEventListener("scroll", schedule, true);
    win.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(view);
    observer?.observe(element);
    return () => {
      win.cancelAnimationFrame(frame);
      observer?.disconnect();
      view.removeEventListener("scroll", schedule, true);
      win.removeEventListener("resize", schedule);
    };
  }, [card, enabled, revision]);
  return enabled ? seat : undefined;
}
