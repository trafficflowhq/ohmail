import type { CalendarRecord } from "@ohmail/app-logic/calendar";
import { useEffect, useState } from "react";
import { Button, Menu, MenuItem } from "@ohmail/ui/base";
import type { PanelVerb } from "@ohmail/ui/mail";
import { useText } from "../text/index.js";
import type { CalendarEventFace } from "./faces.js";
import type { EventActions } from "./use-event-actions.js";
import { useFrame } from "../frame/commands.js";
import { hasGuests, type removableEvent } from "./editable-event.js";
import { ReadActionPanel } from "./ReadActionPanel.js";
import { cardKeys } from "./event-card-keys.js";

interface EventCardActionsProps {
  event: CalendarEventFace;
  actions: EventActions;
  edit: { onPress: () => void } | null;
  duplicate?: () => void;
  hide?: PanelVerb;
  mail?: PanelVerb;
  retry?: PanelVerb;
  join?: { href: string; label: string };
  removable: ReturnType<typeof removableEvent>;
  destinations: readonly CalendarRecord[];
  remove?: PanelVerb;
  invited: boolean;
  moveRestriction: "guests" | "fields" | null;
}

export function useEventCardActions({
  event,
  actions,
  edit,
  duplicate,
  hide,
  mail,
  retry,
  join,
  removable,
  destinations,
  remove,
  invited,
  moveRestriction,
}: EventCardActionsProps) {
  const t = useText("calendar");
  const { plan } = useFrame();
  const [moveMenu, setMoveMenu] = useState<HTMLElement | null>(null);
  const [more, setMore] = useState<HTMLElement | null>(null);
  const canTransfer = destinations.length > 0;
  useEffect(() => {
    if (!canTransfer) setMoveMenu(null);
  }, [canTransfer]);
  const blocked = actions.busy || actions.question !== null;
  const deleteEvent = (anchor: HTMLElement) => {
    if (remove) remove.onPress?.(anchor);
    else actions.start(event, { kind: "delete" }, anchor);
  };
  const onKeyDown = cardKeys({
    event,
    actions,
    edit,
    duplicate,
    canTransfer,
    removable: removable !== null || !!remove,
    blocked: blocked || !!moveMenu || !!more,
    setMoveMenu,
    deleteEvent,
  });
  const items: PanelVerb[] = [];
  if (canTransfer)
    items.push({
      id: "move",
      label: t("actions.moveTo"),
      icon: "calendar",
      shortcut: "m",
      keyHint: "m",
      rank: 0,
      disabled: blocked,
      onPress: setMoveMenu,
    });
  if (removable)
    items.push({
      id: "delete",
      label: t(hasGuests(removable.record) ? "actions.cancelEvent" : "actions.delete"),
      icon: "trash",
      shortcut: "d Delete Backspace",
      keyHint: "d",
      rank: 0,
      disabled: blocked,
      onPress: deleteEvent,
    });
  if (mail && !event.viewOnly) items.push({ ...mail, disabled: blocked });
  const duplicateInMore: PanelVerb | undefined =
    invited && duplicate
      ? { id: "duplicate", label: t("edit.duplicate"), icon: "copy", onPress: duplicate }
      : undefined;
  const behind = [duplicateInMore, remove, hide, event.viewOnly ? mail : undefined].filter(
    (verb) => verb !== undefined,
  );
  const panel =
    items.length || duplicate || retry || behind.length || moveRestriction ? (
      <ReadActionPanel
        {...{ items, blocked, more, setMore, retry, behind }}
        note={moveRestriction ? t(`actions.moveRestriction.${moveRestriction}`) : undefined}
        duplicate={duplicateInMore ? undefined : duplicate}
        edit={retry && plan.device !== "phone" ? edit?.onPress : undefined}
        duplicatePrimary={event.viewOnly && !join && !retry}
      />
    ) : null;
  const toolbar = join ? (
    <>
      {retry && panel}
      <Button href={join.href} outside icon="video" kind={retry ? "quiet" : undefined}>
        {join.label}
      </Button>
      {!retry && panel}
    </>
  ) : (
    panel
  );
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
  return {
    blocked,
    onKeyDown,
    panel,
    toolbar,
    menu,
    items,
  };
}
