import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { clockTime, dayShort, type CalendarRecord, type ZoneSource } from "@ohmail/app-logic/calendar";
import { Button, Icon, Menu, MenuItem, MenuRule, type Point } from "@ohmail/ui/base";
import type { PanelVerb } from "@ohmail/ui/mail";
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
import { editableEvent, hasGuests, moveDestinations, removableEvent } from "./editable-event.js";
import type { useNewEvent } from "./use-new-event.js";
import { useDuplicateDraft } from "./draft-undo.js";
import { draftForDuplicate } from "./edit-draft.js";
import { ReadActionPanel } from "./ReadActionPanel.js";
import { cardKeys } from "./event-card-keys.js";
import { useEventCall } from "./event-call.js";
import { useEventLetters } from "./use-event-letters.js";
import type { CalendarPort } from "@ohmail/app-logic/calendar";

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
  const deleteEvent = (anchor: HTMLElement) => actions.start(event, { kind: "delete" }, anchor);
  const onKeyDown = cardKeys({
    event,
    actions,
    edit,
    duplicate,
    canTransfer,
    removable: removable !== null,
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
  const current = event.viewOnly ? null : editableEvent(host, port, event, known);
  const removable = removableEvent(host, port, event, known, zones);
  const destinations = current ? moveDestinations(host, current) : [];
  const [moving, setMoving] = useState(false);
  const { links: letters } = useEventLetters(event);
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
            event.ref.occurrence === null &&
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
                duplicate(
                  draftForDuplicate(current.exception ?? current.record, event, zone),
                  current.calendar.id,
                ),
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
                {t(hasGuests(removable.record) ? "actions.cancelEvent" : "actions.delete")}
              </MenuItem>
            </>
          )}
        </>
      )}
    </Menu>
  );
}
