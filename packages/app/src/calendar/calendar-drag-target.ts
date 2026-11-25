export const DROP = "[data-cal-drop-day]";

export function dayTarget(view: HTMLElement, point: PointerEvent, kind?: string) {
  const doc = view.ownerDocument;
  const hits = doc.elementsFromPoint?.(point.clientX, point.clientY) ?? [
    doc.elementFromPoint?.(point.clientX, point.clientY),
  ];
  for (const hit of hits) {
    const target = hit?.closest<HTMLElement>(DROP);
    if (target && (!kind || target.dataset.calDropKind === kind) && view.contains(target)) return target;
    const lane = hit?.closest("[data-cal-all-day-lane]");
    if (lane && (!kind || kind === "all-day") && view.contains(lane)) {
      for (const column of lane.querySelectorAll<HTMLElement>(DROP)) {
        const rect = column.getBoundingClientRect();
        if (rect.left <= point.clientX && point.clientX < rect.right) return column;
      }
    }
  }
  return null;
}

export function dayDelta(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000;
}

export function dragScrollArea(view: HTMLElement, kind: string) {
  return view.querySelector<HTMLElement>(kind === "time" ? "[data-today-scroll]" : ".oh-mo-weeks");
}

export function scrollDrag(
  view: HTMLElement,
  kind: string,
  refresh: (point: PointerEvent) => void,
  stepWeek?: (direction: -1 | 1) => void,
) {
  const window = view.ownerDocument.defaultView;
  let frame = 0;
  let latest: PointerEvent | null = null;
  let nextStep = 0;
  const tick = (now: number) => {
    frame = 0;
    const scroller = dragScrollArea(view, kind);
    if (!latest || !scroller) return;
    const { clientX: x, clientY: y } = latest;
    const { top, bottom, left, right } = scroller.getBoundingClientRect();
    if (x < left || x >= right || y < top || y >= bottom) {
      nextStep = 0;
      return;
    }
    const before = scroller.scrollTop;
    scroller.scrollTop += y < top + 36 ? -10 : y > bottom - 36 ? 10 : 0;
    const cols = stepWeek && scroller.querySelectorAll<HTMLElement>('[data-cal-drop-kind="time"]');
    const first = cols && cols[0]?.getBoundingClientRect();
    const last = cols && cols[cols.length - 1]?.getBoundingClientRect();
    const side =
      first && x >= first.left && x < first.left + 20
        ? -1
        : last && x < last.right && x >= last.right - 20
          ? 1
          : 0;
    if (!side) nextStep = 0;
    else if (!nextStep) nextStep = now + 550;
    else if (now >= nextStep) {
      nextStep = now + 550;
      const offset = scroller.scrollTop;
      stepWeek?.(side);
      window?.requestAnimationFrame(() => {
        if (!latest) return;
        const next = dragScrollArea(view, kind);
        if (next) next.scrollTop = offset;
        refresh(latest);
      });
    }
    if (scroller.scrollTop !== before) refresh(latest);
    if (side || scroller.scrollTop !== before) frame = window?.requestAnimationFrame(tick) ?? 0;
  };
  const onScroll = () => latest && refresh(latest);
  view.addEventListener("scroll", onScroll, true);
  return {
    move(point: PointerEvent) {
      latest = point;
      refresh(point);
      if (!frame) frame = window?.requestAnimationFrame(tick) ?? 0;
    },
    stop() {
      if (frame) window?.cancelAnimationFrame(frame);
      latest = null;
      view.removeEventListener("scroll", onScroll, true);
    },
  };
}

export function listenDrag(
  doc: Document,
  touchmove: ((event: TouchEvent) => void) | null,
  listeners: {
    move: (event: PointerEvent) => void;
    end: (event: PointerEvent) => void;
    cancel: (event: PointerEvent) => void;
    escape: (event: KeyboardEvent) => void;
    cleanup: () => void;
  },
) {
  const { move, end, cancel, escape, cleanup } = listeners;
  doc.addEventListener("pointermove", move, { passive: false });
  doc.addEventListener("pointerup", end);
  doc.addEventListener("pointercancel", cancel);
  if (touchmove) doc.addEventListener("touchmove", touchmove, { passive: false });
  doc.addEventListener("keydown", escape, true);
  doc.defaultView?.addEventListener("blur", cleanup);
  return () => {
    doc.removeEventListener("pointermove", move);
    doc.removeEventListener("pointerup", end);
    doc.removeEventListener("pointercancel", cancel);
    if (touchmove) doc.removeEventListener("touchmove", touchmove);
    doc.removeEventListener("keydown", escape, true);
    doc.defaultView?.removeEventListener("blur", cleanup);
  };
}
