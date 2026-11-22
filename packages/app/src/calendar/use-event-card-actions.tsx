import { useEffect, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { clockTime, dayShort, type CalendarRecord, type ZoneSource } from "@ohmail/app-logic/calendar";
import { Button, Icon, Menu, MenuItem, MenuRule, type Point } from "@ohmail/ui/base";
import { ActionPanel, type PanelVerb } from "@ohmail/ui/mail";
import { useLocale, useText, useTimeZone } from "../text/index.js";
import type { CalendarEventFace } from "./faces.js";
import { ANSWERS } from "../invitations/AnswerChoices.js";
import type { InvitationActions } from "../invitations/EventAnswers.js";
import type { EventActions } from "./use-event-actions.js";
import { WeekContextMenu, type WeekContextTarget } from "../week/WeekView.js";
import { useFrame } from "../frame/commands.js";
import { fragmentOf } from "../frame/route.js";
import { useKnownOwnAddresses } from "../frame/room.js";
import { NONE } from "../host/index.js";
import { editableEvent, moveDestinations, removableEvent } from "./editable-event.js";
import type { useNewEvent } from "./use-new-event.js";
import { useDuplicateDraft } from "./draft-undo.js";
import { draftForDuplicate } from "./edit-draft.js";
import { useEventCall } from "./event-call.js";
import { useEventLetters } from "./use-event-letters.js";
import type { CalendarPort } from "@ohmail/app-logic/calendar";

export function useEventCardActions({
  event,
  actions,
  edit,
  join,
  removable,
  destinations,
}: {
  event: CalendarEventFace;
  actions: EventActions;
  edit: { onPress: () => void } | null;
  join?: { href: string; label: string };
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

  const toolbar = join ? (
    <>
      <Button href={join.href} outside icon="video">
        {join.label}
      </Button>
      {panel}
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
  return { blocked, onKeyDown, panel, toolbar, menu, items };
}

export function WeekMenus({
  actions,
  reply,
  zones,
  events,
  create,
  onDay,
  editNext,
  children,
}: {
  actions: EventActions;
  reply: InvitationActions;
  zones: ZoneSource;
  events: readonly CalendarEventFace[];
  create: ReturnType<typeof useNewEvent>;
  onDay: (day: string) => void;
  editNext: RefObject<string | null>;
  children: ReactNode;
}) {
  const { commands, host, plan, route } = useFrame();
  const t = useText("calendar");
  const locale = useLocale();
  const routeKey = fragmentOf(route);
  const [menu, setMenu] = useState<{
    target: WeekContextTarget;
    route: string;
    engine: typeof host.engine;
  } | null>(null);
  const enabled = route.place === "week" && plan.device !== "phone" && route.words.panel !== "new";
  useEffect(() => setMenu(null), [routeKey, host.engine, enabled]);
  const context = enabled && menu?.route === routeKey && menu.engine === host.engine ? menu.target : null;
  const event = context?.kind === "event" ? events.find(({ id }) => id === context.id) : undefined;
  const close = () => setMenu(null);

  return (
    <WeekContextMenu.Provider
      value={
        enabled
          ? {
              open: (target) => setMenu({ target, route: routeKey, engine: host.engine }),
              slot: context?.kind === "time" ? context : null,
            }
          : null
      }
    >
      {children}
      {context?.kind === "time" && (
        <Menu open kind="context" anchor={context.at} label={t("view.week")} onClose={close}>
          {create && route.open === null && (
            <>
              <MenuItem
                icon="plus"
                label={t("create.title")}
                note={t("atTime", {
                  day: dayShort(context.day, locale),
                  time: clockTime(context.from, locale),
                })}
                onPress={() => {
                  close();
                  create(context.day, context.from, context.to);
                }}
              >
                {t("create.title")}
              </MenuItem>
              <MenuRule />
            </>
          )}
          <MenuItem
            icon="day"
            onPress={() => {
              close();
              onDay(context.day);
            }}
          >
            {t("view.day")}
          </MenuItem>
        </Menu>
      )}
      {context?.kind === "event" && event && host.wires.calendar !== NONE && (
        <EventContextMenu
          key={event.id}
          event={event}
          opener={context.opener}
          port={host.wires.calendar}
          at={context.at}
          actions={actions}
          reply={reply}
          zones={zones}
          close={close}
          edit={
            route.open === event.id
              ? undefined
              : () => {
                  editNext.current = event.id;
                  commands.event(event.ref);
                  if (host.device.address.read() === routeKey) editNext.current = null;
                }
          }
        />
      )}
    </WeekContextMenu.Provider>
  );
}
interface EventContextMenuProps {
  event: CalendarEventFace;
  opener: HTMLElement;
  port: CalendarPort;
  at: Point | Element;
  actions: EventActions;
  reply: InvitationActions;
  zones: ZoneSource;
  close: () => void;
  edit?: () => void;
}

function CallMenuItem({ join, close }: { join: { href: string; label: string }; close: () => void }) {
  return (
    <a
      className="oh-control oh-menu-item cal-call-menu-link"
      role="menuitem"
      href={join.href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={close}
    >
      <Icon name="video" size={20} />
      <span className="oh-menu-word">{join.label}</span>
    </a>
  );
}

export function EventContextMenu(props: EventContextMenuProps) {
  const { event, opener, port, at, actions, reply, zones, close, edit } = props;
  const { host, commands, route } = useFrame();
  const t = useText("calendar");
  const invitations = useText("invitations");
  const known = useKnownOwnAddresses();
  const zone = useTimeZone();
  const duplicate = useDuplicateDraft(port);
  const current = event.viewOnly ? null : editableEvent(host, port, event.recordId, known);
  const removable = removableEvent(host, port, event, known, zones) !== null;
  const destinations = current ? moveDestinations(host, current) : [];
  const [moving, setMoving] = useState(false);
  const letters = useEventLetters(event);
  const call = useEventCall(event);
  const answer = event.viewOnly ? null : reply.invitation(event.recordId)?.myAnswer;
  if (
    route.open === event.id &&
    !answer &&
    !current &&
    !removable &&
    !destinations.length &&
    !letters.length &&
    !call
  )
    return null;
  const blocked = actions.busy || actions.question !== null;
  const onPress = (run: () => void) => () => {
    close();
    run();
  };
  return (
    <Menu
      open
      kind="context"
      anchor={at}
      label={t(moving ? "actions.moveTo" : "actions.panel")}
      onClose={close}
    >
      {moving ? (
        destinations.map(({ id, name }) => (
          <MenuItem
            key={id}
            disabled={blocked}
            onPress={onPress(() => actions.start(event, { kind: "calendar", target: id }, opener))}
          >
            {name}
          </MenuItem>
        ))
      ) : (
        <>
          {route.open !== event.id && (
            <MenuItem icon="calendar" onPress={onPress(() => commands.event(event.ref))}>
              {t("openEvent")}
            </MenuItem>
          )}
          {call && <CallMenuItem join={call.join} close={close} />}
          {answer &&
            ANSWERS.map((value) => (
              <MenuItem
                key={value}
                checked={answer === value}
                disabled={blocked}
                onPress={onPress(() => void reply.answer(event.recordId, value))}
              >
                {invitations(`answer.${value}`)}
              </MenuItem>
            ))}
          {current && edit && (
            <MenuItem icon="write" disabled={blocked} onPress={onPress(edit)}>
              {t("edit.action")}
            </MenuItem>
          )}
          {current && (
            <MenuItem
              icon="copy"
              disabled={blocked}
              onPress={onPress(() =>
                duplicate(draftForDuplicate(current.record, event, zone), current.calendar.id),
              )}
            >
              {t("edit.duplicate")}
            </MenuItem>
          )}
          {destinations.length > 0 && (
            <MenuItem icon="calendar" disabled={blocked} onPress={() => setMoving(true)}>
              {t("actions.moveTo")}
            </MenuItem>
          )}
          {letters[0] && (
            <MenuItem icon="frommail" onPress={onPress(letters[0].open)}>
              {t("actions.openLetter")}
            </MenuItem>
          )}
          {removable && (
            <>
              <MenuRule />
              <MenuItem
                icon="trash"
                disabled={blocked}
                onPress={onPress(() => actions.start(event, { kind: "delete" }, opener))}
              >
                {t("actions.delete")}
              </MenuItem>
            </>
          )}
        </>
      )}
    </Menu>
  );
}
