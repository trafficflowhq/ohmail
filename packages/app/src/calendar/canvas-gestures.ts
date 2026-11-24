import type { MouseEventHandler } from "react";
import type { CalendarEventFace } from "./faces.js";
import type { DraftPreview } from "./NewEvent.js";
import type { EventActions } from "./use-event-actions.js";
import type { useEventDrag } from "./use-event-drag.js";
import type { CalendarViewProps } from "./view.js";
import { addDays, isoOfDay } from "@ohmail/app-logic/calendar";
import { resizedDays } from "./event-time-change.js";
import { PROPOSAL_DRAFT } from "./use-event-proposals.js";
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
    if (actions.proposal.draft) {
      if (id === PROPOSAL_DRAFT) drag(actions.proposal.draft, press, actions.proposal.adjust, segment);
      return;
    }
    if (drafting) {
      if (id === DRAFT_EVENT && preview?.face.start.kind === "date" && preview.face.end.kind === "date") {
        const { start, end } = preview.face;
        drag(preview.face, press, (change) => {
          if (change.kind === "resize") {
            const span = resizedDays(start, end, change.edge, change.days);
            if (span) preview.moveRange(span.first, span.last);
          } else if (change.kind === "time" && change.days) {
            preview.moveRange(addDays(isoOfDay(start), change.days), addDays(isoOfDay(end), change.days - 1));
          }
        });
      }
      return;
    }
    const face = events.find((event) => event.id === id);
    const editing = press.currentTarget.closest(".cal-body-view")?.querySelector(".oh-ecard[data-editing]");
    if (face && !editing) drag(face, press, undefined, segment);
  };
}

export function calendarResizeHandler(
  actions: EventActions,
  events: readonly CalendarEventFace[],
): NonNullable<CalendarViewProps["onResizeTime"]> {
  return (id, edge, minutes, anchor) => {
    const change = { kind: "resize-time", edge, minutes } as const;
    if (id === PROPOSAL_DRAFT) {
      actions.proposal.adjust(change);
      return;
    }
    const face = events.find((event) => event.id === id);
    if (face) actions.start(face, change, anchor);
  };
}

export function openFace(
  route: { open: string | null; words: { panel?: string; invitation?: string } },
  events: readonly CalendarEventFace[],
  beside?: readonly CalendarEventFace[],
  pending?: CalendarEventFace | null,
) {
  if (route.open === null || route.words.panel === "new") return undefined;
  return (
    events.find((event) => event.id === route.open) ??
    beside?.find((event) => event.id === route.open) ??
    (pending?.id === route.open && pending.id === route.words.invitation ? pending : undefined)
  );
}
