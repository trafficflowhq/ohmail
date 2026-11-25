import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { type CalendarRecord, type CalendarPort, type ZoneSource } from "@ohmail/app-logic/calendar";
import { Icon, Menu, MenuItem, MenuNote, MenuRule, type Point } from "@ohmail/ui/base";
import type { PanelVerb } from "@ohmail/ui/mail";
import { useText } from "../text/index.js";
import type { CalendarEventFace } from "./faces.js";
import { ANSWERS } from "../invitations/AnswerChoices.js";
import { useEventResponse, type InvitationActions } from "../invitations/EventAnswers.js";
import type { EventActions } from "./use-event-actions.js";
import { CalendarMenu, SlotMenu, type CalendarMenuTarget } from "./event-menu-trigger.js";
import { useFrame } from "../frame/commands.js";
import { fragmentOf } from "../frame/route.js";
import { useCalendarOwnAddresses } from "./own-addresses.js";
import { NONE } from "../host/index.js";
import { editableEvent, eventMoveOptions, hasGuests, removableEvent } from "./editable-event.js";
import type { useNewEvent } from "./use-new-event.js";
import { useReadCardActions } from "./read-card-actions.js";
import { useEventCall } from "./event-call.js";
import { useEventLetters } from "./use-event-letters.js";

export function CalendarMenus({
  actions,
  reply,
  zones,
  events,
  beside,
  onAgendaRow,
  fallback,
  dragging,
  create,
  onDay,
  editNext,
  children,
}: {
  actions: EventActions;
  reply: InvitationActions;
  zones: ZoneSource;
  events: readonly CalendarEventFace[];
  beside: readonly CalendarEventFace[];
  onAgendaRow: (id: string, day: string) => void;
  fallback: RefObject<HTMLElement | null>;
  dragging: boolean;
  create: ReturnType<typeof useNewEvent>;
  onDay: (day: string) => void;
  editNext: RefObject<string | null>;
  children: ReactNode;
}) {
  const { commands, host, plan, route } = useFrame();
  const routeKey = fragmentOf(route);
  const [menu, setMenu] = useState<{
    target: CalendarMenuTarget;
    route: string;
    engine: typeof host.engine;
  } | null>(null);
  const enabled = plan.device !== "phone" && route.words.panel !== "new" && !dragging;
  useEffect(() => setMenu(null), [routeKey, host.engine, enabled]);
  const context = enabled && menu?.route === routeKey && menu.engine === host.engine ? menu.target : null;
  const event =
    context?.kind === "event"
      ? (context.day ? [...beside, ...events] : events).find(({ id }) => id === context.id)
      : undefined;
  const serial = useRef(0);
  const canMake = create !== null && route.open === null;
  const canGo = route.place === "week" || context?.kind === "date";
  const opened = context?.opener;
  useLayoutEffect(() => {
    const safe = fallback.current;
    if (!opened || !safe) return;
    const owner = opened.ownerDocument;
    return () => {
      queueMicrotask(() => {
        if (!opened.isConnected && safe.isConnected && owner.activeElement === owner.body)
          safe.focus({ preventScroll: true });
      });
    };
  }, [opened, fallback]);
  useEffect(() => {
    if (context?.kind === "event" && !event) setMenu(null);
  }, [context, event]);
  const close = () => setMenu(null);

  return (
    <CalendarMenu.Provider
      value={
        enabled
          ? {
              open: (target) => {
                if (
                  actions.busy ||
                  actions.question ||
                  fallback.current?.querySelector(".oh-ecard[data-editing]")
                )
                  return;
                if (target.kind === "time" && route.place === "day" && !canMake) return;
                serial.current += 1;
                setMenu({ target, route: routeKey, engine: host.engine });
              },
              slot: context?.kind === "time" ? context : null,
            }
          : null
      }
    >
      {children}
      {context && context.kind !== "event" && (canMake || canGo) && (
        <SlotMenu
          context={context}
          close={close}
          create={canMake ? create : null}
          onDay={canGo ? onDay : null}
          place={route.place === "week" ? "week" : "day"}
        />
      )}
      {context?.kind === "event" && event && host.wires.calendar !== NONE && (
        <EventContextMenu
          key={serial.current}
          event={event}
          opener={context.opener}
          port={host.wires.calendar}
          at={context.at}
          actions={actions}
          reply={reply}
          zones={zones}
          close={close}
          removeOnOpen={context.remove}
          openEvent={() => (context.day ? onAgendaRow(event.id, context.day) : commands.event(event.ref))}
          edit={
            route.open === event.id
              ? undefined
              : () => {
                  editNext.current = event.id;
                  if (context.day) onAgendaRow(event.id, context.day);
                  else commands.event(event.ref);
                  if (host.device.address.read() === routeKey) editNext.current = null;
                }
          }
        />
      )}
    </CalendarMenu.Provider>
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
  openEvent: () => void;
  removeOnOpen?: boolean;
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

function DestinationItems({
  destinations,
  blocked,
  onPress,
  actions,
  event,
  opener,
}: {
  destinations: readonly CalendarRecord[];
  blocked: boolean;
  onPress: (run: () => void) => () => void;
  actions: EventActions;
  event: CalendarEventFace;
  opener: HTMLElement;
}) {
  return destinations.map(({ id, name }) => (
    <MenuItem
      key={id}
      disabled={blocked}
      onPress={onPress(() => actions.start(event, { kind: "calendar", target: id }, opener))}
    >
      {name}
    </MenuItem>
  ));
}

function CardMenuItems({
  verbs,
  letter,
  opener,
  onPress,
  blocked,
}: {
  verbs: readonly (PanelVerb | undefined)[];
  letter?: () => void;
  opener: HTMLElement;
  onPress: (run: () => void) => () => void;
  blocked: boolean;
}) {
  const t = useText("calendar");
  return (
    <>
      {verbs.map(
        (verb) =>
          verb && (
            <MenuItem
              key={verb.id}
              icon={verb.icon}
              disabled={blocked || verb.disabled}
              onPress={onPress(() => verb.onPress?.(opener))}
            >
              {verb.label}
            </MenuItem>
          ),
      )}
      {letter && (
        <MenuItem icon="frommail" onPress={onPress(letter)}>
          {t("actions.openLetter")}
        </MenuItem>
      )}
    </>
  );
}

export function EventContextMenu(props: EventContextMenuProps) {
  const { event, opener, port, at, actions, reply, zones, close, edit, openEvent, removeOnOpen } = props;
  const { host, route } = useFrame();
  const t = useText("calendar");
  const invitations = useText("invitations");
  const known = useCalendarOwnAddresses();
  const current = event.viewOnly ? null : editableEvent(host, port, event, known);
  const removable = removableEvent(host, port, event, known, zones);
  const { destinations, moveRestriction } = eventMoveOptions(host, current);
  const [moving, setMoving] = useState(false);
  const [closed, setClosed] = useState(false);
  const { duplicate, mail, removal, removalQuestion, hide, retry } = useReadCardActions(
    port,
    event,
    current,
    true,
    reply,
  );
  const blocked = actions.busy || actions.question !== null;
  const used = useRef(false);
  const removeEvent = () => {
    if (blocked) return;
    if (removal) {
      setClosed(true);
      removal.onPress?.(opener);
    } else if (removable) {
      close();
      actions.start(event, { kind: "delete" }, opener);
    } else close();
  };
  useLayoutEffect(() => {
    if (!removeOnOpen || used.current) return;
    used.current = true;
    removeEvent();
  });
  const { links: letters } = useEventLetters(event);
  const call = useEventCall(event);
  const response = useEventResponse(reply, event, close);
  const answer = event.viewOnly ? null : response.answer;
  const propose = !event.viewOnly && actions.proposal.baseOf(event);
  if (response.reviewing) return response.question;
  if (closed || removeOnOpen) return removalQuestion ?? null;
  const hasActions = [
    answer,
    propose,
    duplicate,
    removal,
    mail,
    hide,
    retry,
    current,
    removable,
    destinations.length,
    letters.length,
    call,
  ].some(Boolean);
  if (route.open === event.id && !hasActions) return null;
  const onPress = (run: () => void) => () => {
    close();
    run();
  };
  const label = t(moving ? "actions.moveTo" : "actions.panel");
  return (
    <Menu open kind="context" {...{ anchor: at, returnFocus: opener, label, onClose: close }}>
      {moveRestriction && (moving || destinations.length === 0) && (
        <MenuNote>{t(`actions.moveRestriction.${moveRestriction}`)}</MenuNote>
      )}
      {moving ? (
        <DestinationItems {...{ destinations, blocked, onPress, actions, event, opener }} />
      ) : (
        <>
          {route.open !== event.id && (
            <MenuItem icon="calendar" onPress={onPress(openEvent)}>
              {t("openEvent")}
            </MenuItem>
          )}
          {call && <CallMenuItem join={call.join} close={close} />}
          {answer && <ContextAnswers {...{ answer, response, opener, blocked, invitations }} />}
          {propose && (
            <MenuItem icon="clock" disabled={blocked} onPress={onPress(() => actions.proposal.open(event))}>
              {t("proposal.action")}
            </MenuItem>
          )}
          {current && edit && (
            <MenuItem icon="write" disabled={blocked} onPress={onPress(edit)}>
              {t("edit.action")}
            </MenuItem>
          )}
          {duplicate && (
            <MenuItem icon="copy" disabled={blocked} onPress={onPress(duplicate)}>
              {t("edit.duplicate")}
            </MenuItem>
          )}
          {destinations.length > 0 && (
            <MenuItem icon="calendar" disabled={blocked} onPress={() => setMoving(true)}>
              {t("actions.moveTo")}
            </MenuItem>
          )}
          <CardMenuItems
            verbs={[mail, hide, retry]}
            letter={letters[0]?.open}
            {...{ opener, onPress, blocked }}
          />
          {(removal || removable) && (
            <RemovalItem
              disabled={blocked}
              onPress={removeEvent}
              label={
                removal?.label ??
                t(removable && hasGuests(removable.record) ? "actions.cancelEvent" : "actions.delete")
              }
            />
          )}
        </>
      )}
    </Menu>
  );
}

function ContextAnswers({
  answer,
  response,
  opener,
  blocked,
  invitations,
}: {
  answer: NonNullable<ReturnType<typeof useEventResponse>["answer"]>;
  response: ReturnType<typeof useEventResponse>;
  opener: HTMLElement;
  blocked: boolean;
  invitations: ReturnType<typeof useText>;
}) {
  return ANSWERS.map((value) => (
    <MenuItem
      key={value}
      checked={answer === value}
      disabled={blocked}
      onPress={() => response.choose(value, opener)}
    >
      {invitations(`answer.${value}`)}
    </MenuItem>
  ));
}

function RemovalItem({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
}) {
  return (
    <>
      <MenuRule />
      <MenuItem icon="trash" {...{ onPress, disabled }}>
        {label}
      </MenuItem>
    </>
  );
}
