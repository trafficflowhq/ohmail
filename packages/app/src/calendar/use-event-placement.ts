import { useLayoutEffect, useState, type RefObject } from "react";
import { bridgeShape, type EventBridgeProps, type EventCardProps } from "@ohmail/ui/calendar";

export type CardPlacement = Pick<EventCardProps, "style" | "side" | "origin">;
type Bridge = Omit<EventBridgeProps, "tone">;
type Box = Bridge["event"]["box"];
type Seat = { card: CardPlacement; anchor?: HTMLElement; bridge?: Bridge };

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

function locateCard(
  card: HTMLElement,
  view: HTMLElement,
  preferred: Element | null,
  reading: boolean,
): Seat | null {
  const width = view.clientWidth;
  const height = view.clientHeight;
  const origin = view.getBoundingClientRect();
  const cardWidth = card.offsetWidth;
  const cardHeight = card.offsetHeight;
  if (!width || !height || !origin.width || !cardWidth || !cardHeight) return null;
  const scale = origin.width / width;
  const anchors = [
    ...view.querySelectorAll<HTMLElement>(reading ? ".fr-list .oh-erow[data-open]" : OPEN_EVENT),
  ];
  if (preferred instanceof HTMLElement && anchors.includes(preferred)) {
    anchors.splice(anchors.indexOf(preferred), 1);
    anchors.unshift(preferred);
  }
  if (!anchors.length) {
    return { card: { style: { left: Math.max(EDGE, width - cardWidth - EDGE), top: EDGE } } };
  }
  for (const anchor of anchors) {
    const whole = boxIn(anchor, origin, scale);
    const scroller = anchor.closest(
      reading ? ".fr-list" : ".oh-tg-scroll, .oh-mo-weeks[data-run], .cal-ag-list",
    );
    const bounds = scroller
      ? boxIn(scroller, origin, scale)
      : { left: 0, right: width, top: 0, bottom: height };
    const box = visibleBox(whole, bounds);
    if (box) {
      const pixel = 1 / (scale * (view.ownerDocument.defaultView?.devicePixelRatio ?? 1));
      return besideEvent({ anchor, box, whole, bounds, width, height, card, cardWidth, cardHeight, pixel });
    }
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
  pixel,
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
  pixel: number;
}): Seat {
  const right = box.right + GAP;
  const left = box.left - GAP - cardWidth;
  const min = Math.max(EDGE, bounds.top);
  const max = Math.max(min, height - cardHeight - PANEL_ROOM);
  const fold = card.ownerDocument.documentElement.dataset.device === "fold";
  const below = box.bottom + GAP;
  const above = box.top - GAP - cardHeight;
  const side =
    right + cardWidth <= width - EDGE
      ? "r"
      : left >= EDGE
        ? "l"
        : fold && below <= max
          ? "b"
          : fold && above >= min
            ? "t"
            : "o";
  const beside = side === "r" || side === "l";
  const centre = (box.left + box.right) / 2;
  const x =
    side === "r"
      ? right
      : side === "l"
        ? left
        : side === "o"
          ? Math.max(EDGE, width - cardWidth - EDGE)
          : clamp(centre - cardWidth / 2, EDGE, width - cardWidth - EDGE);
  const short = whole.bottom - whole.top <= SHORT_CHIP && beside;
  const firstLine = short ? (box.top + box.bottom) / 2 - FIRST_LINE : box.top;
  const y = side === "b" ? below : side === "t" ? above : clamp(firstLine, short ? EDGE : min, max);
  const head = card.querySelector<HTMLElement>(".oh-ecard-head");
  const placement: CardPlacement = { side, style: { left: x, top: y } };
  if (side === "o") return { card: placement, anchor };
  const line = Number.parseFloat(getComputedStyle(card).getPropertyValue("--oh-cal-open-line")) || 1;
  const eventRadius = rim(anchor);
  const bridge: Bridge = {
    width,
    height,
    side,
    line,
    pixel,
    event: { box, whole, radius: eventRadius },
    card: {
      box: { left: x, top: y, right: x + cardWidth, bottom: y + cardHeight },
      radius: rim(card),
      headBottom: head ? y + head.offsetTop + head.offsetHeight - card.scrollTop : undefined,
    },
  };
  const shape = bridgeShape(bridge);
  if (!shape) return { card: placement, anchor };
  return {
    anchor,
    card: {
      ...placement,
      origin: { x: shape.middle.x - x, y: shape.middle.y - y },
      style: { ...placement.style, clipPath: shadowCut(box, whole, eventRadius, x, y) },
    },
    bridge,
  };
}

/** The card's lift stops at the visible event, including when the hours cut one of its corners. */
function shadowCut(box: Box, whole: Box, radius: number, x: number, y: number): string {
  const l = box.left - x;
  const r = box.right - x;
  const t = box.top - y;
  const b = box.bottom - y;
  const corner = Math.min(radius, (r - l) / 2, (b - t) / 2);
  const top = Math.abs(box.top - whole.top) > 0.5 ? 0 : corner;
  const bottom = Math.abs(box.bottom - whole.bottom) > 0.5 ? 0 : corner;
  return `path(evenodd, "M-4096 -4096H8192V8192H-4096Z M${l + top} ${t}H${r - top}A${top} ${top} 0 0 1 ${r} ${t + top}V${b - bottom}A${bottom} ${bottom} 0 0 1 ${r - bottom} ${b}H${l + bottom}A${bottom} ${bottom} 0 0 1 ${l} ${b - bottom}V${t + top}A${top} ${top} 0 0 1 ${l + top} ${t}Z")`;
}

export function useEventPlacement(
  card: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  revision: number | string | undefined,
  reading = false,
) {
  const [seat, setSeat] = useState<Seat>();
  useLayoutEffect(() => {
    if (!enabled) return;
    const element = card.current;
    const view = element?.closest<HTMLElement>(reading ? ".fr-main" : ".cal-body-view");
    const win = view?.ownerDocument.defaultView;
    if (!element || !view || !win) return;
    const active = view.ownerDocument.activeElement;
    const preferred = active?.closest(OPEN_EVENT) ?? null;
    let frame = 0;
    const measure = () => {
      const next = locateCard(element, view, preferred, reading);
      setSeat(
        (last) =>
          next ??
          (last?.bridge
            ? { card: { ...last.card, style: { ...last.card.style, clipPath: undefined } } }
            : last),
      );
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
  }, [card, enabled, revision, reading]);
  return enabled ? seat : undefined;
}
