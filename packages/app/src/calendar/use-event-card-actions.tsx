import { useEffect, useState, type KeyboardEvent } from "react";
import type { CalendarRecord } from "@ohmail/app-logic/calendar";
import { Menu, MenuItem } from "@ohmail/ui/base";
import { ActionPanel, type PanelVerb } from "@ohmail/ui/mail";
import { useText } from "../text/index.js";
import type { CalendarEventFace } from "./faces.js";
import type { EventActions } from "./use-event-actions.js";

export function useEventCardActions({
  event,
  actions,
  edit,
  removable,
  destinations,
}: {
  event: CalendarEventFace;
  actions: EventActions;
  edit: { onPress: () => void } | null;
  removable: boolean;
  destinations: readonly CalendarRecord[];
}) {
  const t = useText("calendar");
  const [moveMenu, setMoveMenu] = useState<HTMLElement | null>(null);
  const canTransfer = destinations.length > 0;
  useEffect(() => {
    if (!canTransfer) setMoveMenu(null);
  }, [canTransfer]);
  const blocked = actions.busy || actions.question !== null;
  const deleteEvent = (anchor: HTMLElement) => {
    actions.start(event, { kind: "delete" }, anchor);
  };
  const onKeyDown = (key: KeyboardEvent<HTMLDivElement>) => {
    const target = key.target as HTMLElement;
    if (
      blocked ||
      moveMenu ||
      (key.ctrlKey && !key.altKey) ||
      key.metaKey ||
      key.repeat ||
      target.closest("input, textarea, select, [contenteditable]")
    )
      return;
    const pressed = key.key;
    if (key.altKey) {
      if (!key.shiftKey || !edit || event.start.kind !== "date") return;
      const days = pressed === "ArrowLeft" ? -1 : pressed === "ArrowRight" ? 1 : 0;
      if (!days) return;
      actions.start(event, { kind: "resize", edge: key.ctrlKey ? "start" : "end", days }, target);
    } else if (!key.shiftKey && pressed === "e" && edit) {
      edit.onPress();
    } else if (!key.shiftKey && pressed === "m" && canTransfer) {
      setMoveMenu(target);
    } else if (!key.shiftKey && removable && ["d", "Delete", "Backspace"].includes(pressed)) {
      deleteEvent(target);
    } else if (key.shiftKey && edit) {
      const days = pressed === "ArrowLeft" ? -1 : pressed === "ArrowRight" ? 1 : 0;
      const delta = pressed === "ArrowUp" ? -15 : pressed === "ArrowDown" ? 15 : 0;
      const minutes = delta ? (actions.moveTime(event, delta, false)?.minutes ?? 0) : 0;
      if (!days && !minutes) return;
      actions.start(event, { kind: "time", days, minutes }, target);
    } else return;
    key.preventDefault();
    key.stopPropagation();
  };

  const items: PanelVerb[] = [];
  if (canTransfer)
    items.push({
      id: "move",
      label: t("actions.moveTo"),
      icon: "calendar",
      shortcut: "m",
      keyHint: "M",
      rank: 0,
      disabled: blocked,
      onPress: setMoveMenu,
    });
  if (removable)
    items.push({
      id: "delete",
      label: t("actions.delete"),
      icon: "trash",
      shortcut: "d Delete Backspace",
      keyHint: "D",
      rank: 0,
      disabled: blocked,
      onPress: deleteEvent,
    });
  const panel = items.length ? <ActionPanel label={t("actions.panel")} items={items} /> : null;

  const menu =
    moveMenu && canTransfer ? (
      <Menu open anchor={moveMenu} label={t("actions.moveTo")} onClose={() => setMoveMenu(null)}>
        {destinations.map((target) => (
          <MenuItem
            key={target.id}
            onPress={() => {
              setMoveMenu(null);
              actions.start(event, { kind: "calendar", target: target.id }, moveMenu);
            }}
          >
            {target.name}
          </MenuItem>
        ))}
      </Menu>
    ) : null;
  return { blocked, onKeyDown, panel, menu };
}
