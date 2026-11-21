import type { MouseEventHandler } from "react";
import type { CalendarEventFace } from "./faces.js";
import type { DraftPreview } from "./NewEvent.js";
import type { EventActions } from "./use-event-actions.js";
import type { useEventDrag } from "./use-event-drag.js";
import type { CalendarViewProps } from "./view.js";
import { DRAFT_EVENT } from "./event-draft.js";

export function canvasClickHandler(
  open: boolean,
  close: () => void,
  suppress: MouseEventHandler<HTMLDivElement>,
): MouseEventHandler<HTMLDivElement> {
  return (event) => {
    suppress(event);
    if (event.defaultPrevented || !open) return;
    const target = event.target as Element;
    if (target.closest(".oh-ecard, .oh-over, .cal-event-panel, button, a, input, select, textarea")) return;
    event.stopPropagation();
    close();
  };
}

export function calendarDragHandler(
  actions: EventActions,
  drag: ReturnType<typeof useEventDrag>["drag"],
  drafting: boolean,
  preview: DraftPreview | null,
  events: readonly CalendarEventFace[],
): CalendarViewProps["onDrag"] {
  if (actions.busy || actions.question) return undefined;
  return (id, press, segment) => {
    if (drafting) {
      if (id === DRAFT_EVENT && preview?.face.start.kind === "date")
        drag(preview.face, press, preview.moveRange);
      return;
    }
    const face = events.find((event) => event.id === id);
    const editing = press.currentTarget.closest(".cal-body-view")?.querySelector(".oh-ecard[data-editing]");
    if (face && !editing) drag(face, press, undefined, segment);
  };
}
