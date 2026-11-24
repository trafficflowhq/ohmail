import type { KeyboardEvent } from "react";
import type { CalendarEventFace } from "./faces.js";
import type { EventActions } from "./use-event-actions.js";

export function cardKeys({
  event,
  actions,
  edit,
  duplicate,
  canTransfer,
  removable,
  blocked,
  setMoveMenu,
  deleteEvent,
}: {
  event: CalendarEventFace;
  actions: EventActions;
  edit: { onPress: () => void } | null;
  duplicate?: () => void;
  canTransfer: boolean;
  removable: boolean;
  blocked: boolean;
  setMoveMenu: (anchor: HTMLElement) => void;
  deleteEvent: (anchor: HTMLElement) => void;
}) {
  const canMove = edit || actions.proposal.baseOf(event) !== undefined;
  return (key: KeyboardEvent<HTMLDivElement>) => {
    const target = key.target as HTMLElement;
    if (
      blocked ||
      (key.ctrlKey && !key.altKey) ||
      key.metaKey ||
      key.repeat ||
      target.closest("input, textarea, select, [contenteditable], a[href]")
    )
      return;
    const pressed = key.key;
    if (key.altKey) {
      if (!key.shiftKey || !canMove || event.start.kind !== "date") return;
      const days = pressed === "ArrowLeft" ? -1 : pressed === "ArrowRight" ? 1 : 0;
      if (!days) return;
      actions.start(event, { kind: "resize", edge: key.ctrlKey ? "start" : "end", days }, target);
    } else if (!key.shiftKey && pressed === "e" && edit) {
      edit.onPress();
    } else if (!key.shiftKey && pressed === "m" && canTransfer) {
      setMoveMenu(target);
    } else if (!key.shiftKey && removable && ["d", "Delete", "Backspace"].includes(pressed)) {
      deleteEvent(target);
    } else if (key.shiftKey && pressed.toLowerCase() === "d" && duplicate) {
      duplicate();
    } else if (key.shiftKey && canMove) {
      const days = pressed === "ArrowLeft" ? -1 : pressed === "ArrowRight" ? 1 : 0;
      const delta = pressed === "ArrowUp" ? -15 : pressed === "ArrowDown" ? 15 : 0;
      const minutes = delta ? (actions.moveTime(event, delta, false)?.minutes ?? 0) : 0;
      if (!days && !minutes) return;
      actions.start(event, { kind: "time", days, minutes }, target);
    } else return;
    key.preventDefault();
    key.stopPropagation();
  };
}
