import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  dayLong,
  clockTime,
  daySpanOf,
  type CalendarEventRecord,
  type CalendarPort,
  type CalendarRecord,
  type ZoneSource,
} from "@ohmail/app-logic/calendar";
import { Button, Icon } from "@ohmail/ui/base";
import { EventBridge, EventCard, type EventCardRow } from "@ohmail/ui/calendar";
import { EventAnswers, type InvitationActions } from "../invitations/EventAnswers.js";
import { NONE, type HostContract } from "../host/index.js";
import { useFrame } from "../frame/commands.js";
import { useLocale, useText, useTimeZone, type Text } from "../text/index.js";
import { useKnownOwnAddresses } from "../frame/room.js";
import { useDraftRestore } from "./draft-undo.js";
import type { EventDraft } from "./event-draft.js";
import { EditEvent } from "./EditEvent.js";
import { editableEvent, moveDestinations, removableEvent } from "./editable-event.js";
import { useEventCall } from "./event-call.js";
import type { CalendarEventFace } from "./faces.js";
import type { EventActions } from "./use-event-actions.js";
import { useMaps } from "./use-place-suggestions.js";
import { useEventPlacement } from "./use-event-placement.js";
import { useEventCardActions } from "./use-event-card-actions.js";
import { useEventLetters } from "./use-event-letters.js";

function timeOf(
  event: CalendarEventFace,
  zone: string,
  zones: ZoneSource,
  today: string,
  locale: string,
  t: Text,
) {
  const span = daySpanOf(event, zone, zones);
  const end = daySpanOf({ start: event.end, end: event.end }, zone, zones);
  const date = (day: string) => dayLong(day, locale, today.slice(0, 4));
  const dated = (day: string, minute: number | null) =>
    minute === null ? date(day) : t("atTime", { day: date(day), time: clockTime(minute, locale) });
  let when = date(event.ref.day);
  if (span !== null) {
    when = dated(span.first, span.startMinute);
    const last = span.allDay ? span.last : end?.first;
    if (last !== undefined && last !== span.first) {
      when = t("interval", { first: when, last: dated(last, span.endMinute) });
    } else if (span.endMinute !== null && span.endMinute !== span.startMinute) {
      when = t("interval", { first: when, last: clockTime(span.endMinute, locale) });
    }
  }
  return when;
}

function useEventCardRows(event: CalendarEventFace, host: HostContract, t: Text): EventCardRow[] {
  const letters = useEventLetters(event);
  const rows = rowsOf(event, host, t);
  if (letters.length) {
    rows.push({
      label: t("letters"),
      children: letters.map((letter) => (
        <Button key={letter.id} kind="quiet" size="s" onPress={letter.open}>
          {letter.subject || t("actions.openLetter")}
        </Button>
      )),
    });
  }
  return rows;
}

function rowsOf(event: CalendarEventFace, host: HostContract, t: Text): EventCardRow[] {
  const port = host.wires.calendar;
  const stored = port === NONE ? undefined : port.events().find(({ record }) => record.id === event.recordId);
  const calendar =
    stored &&
    host.engine.store
      .entries<CalendarRecord | null>("calendar")
      .find(({ entity }) => entity?.id === stored.record.calendarId)?.entity;
  const rows: EventCardRow[] = [];
  if (calendar) {
    rows.push({
      label: t("create.calendar"),
      tone: event.tone,
      text: calendar.name,
      children: event.viewOnly ? <Icon name="lock" size={16} className="oh-ecard-lock" /> : null,
    });
  }
  if (event.people.length) rows.push({ label: t("people"), text: event.people.join(", ") });
  return rows;
}

interface OpenEventProps {
  readonly event: CalendarEventFace;
  readonly zones: ZoneSource;
  readonly today: string;
  readonly actions: EventActions;
  readonly editNext?: RefObject<string | null>;
  readonly reply?: InvitationActions;
}

export function OpenEvent({ event, zones, today, actions, editNext, reply }: OpenEventProps) {
  const { plan, commands, host } = useFrame();
  const port = host.wires.calendar;
  const t = useText("calendar");
  const known = useKnownOwnAddresses();
  const allowed = useCallback(
    () => (port === NONE || event.viewOnly ? null : editableEvent(host, port, event.recordId, known)),
    [port, event.viewOnly, event.recordId, host, known],
  );
  const current = allowed();
  const call = useEventCall(event);
  const rows = useEventCardRows(event, host, t);
  if (call) rows.push({ label: call.label, call });
  const maps = useMaps(event.second ?? null);
  const { editing, begin, end, beforeRestore } = useEventEditor(event, port, allowed, editNext);
  const locale = useLocale();
  const zone = useTimeZone();
  const card = useRef<HTMLDivElement>(null);
  const seat = useEventPlacement(card, plan.device === "desktop", editing?.revision);
  const bridge = seat?.bridge && <EventBridge {...seat.bridge} tone={event.tone} />;
  const focusReadCard = useCardFocus(card, event.id, editing === null);
  const finish = () => {
    end();
    focusReadCard();
  };
  const when = timeOf(event, zone, zones, today, locale, t);
  const edit = current ? { label: t("edit.action"), onPress: begin } : null;
  const { blocked, onKeyDown, panel, toolbar, menu, items } = useEventCardActions({
    event,
    actions,
    edit,
    join: call?.join,
    removable: port !== NONE && removableEvent(host, port, event, known, zones) !== null,
    destinations: current ? moveDestinations(host, current) : [],
  });
  if (editing && editing.port === port && editing.engine === host.engine && current) {
    return (
      <>
        <EditEvent
          card={card}
          placement={seat?.card}
          key={editing.revision}
          beforeRestore={beforeRestore}
          port={editing.port}
          actionItems={items}
          provider={current.connection?.provider}
          original={editing.record}
          allowed={allowed}
          calendar={current.calendar}
          face={event}
          when={when}
          today={today}
          recovered={editing.draft}
          finish={finish}
        />
        {bridge}
        {menu}
      </>
    );
  }
  return (
    <>
      <EventCard
        ref={card}
        {...seat?.card}
        frame={plan.device === "phone" ? "sheet" : "card"}
        onKeyDown={onKeyDown}
        keyShortcuts={
          edit && event.start.kind === "date" && event.end.kind === "date"
            ? "Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Control+Alt+Shift+ArrowLeft Control+Alt+Shift+ArrowRight"
            : undefined
        }
        answers={
          port !== NONE && !event.viewOnly && reply ? (
            <EventAnswers key={event.id} reply={reply} recordId={event.recordId} />
          ) : null
        }
        {...(edit && !blocked ? { edit } : {})}
        foot={
          edit || panel ? (
            <>
              {edit && (
                <Button kind="two" icon="write" disabled={blocked} onPress={edit.onPress}>
                  {edit.label}
                </Button>
              )}
              {panel}
            </>
          ) : null
        }
        title={event.title}
        when={when}
        tone={event.tone}
        close={{ label: t("closeEvent"), onPress: () => commands.event(null) }}
        {...(event.second ? { where: [{ text: event.second, maps }] } : {})}
        {...(event.notes ? { notes: event.notes } : {})}
        rows={rows}
        {...(event.status ? { status: event.status } : {})}
      />
      {plan.device !== "phone" && toolbar && (
        <div className="cal-event-panel" data-call={call ? "" : undefined} onKeyDown={onKeyDown}>
          {toolbar}
        </div>
      )}
      {bridge}
      {menu}
    </>
  );
}

function useEventEditor(
  event: CalendarEventFace,
  port: CalendarPort | typeof NONE,
  allowed: () => ReturnType<typeof editableEvent>,
  editNext: RefObject<string | null> | undefined,
) {
  const { host } = useFrame();
  const available = allowed() !== null;
  const beforeRestore = useRef<(() => void) | null>(null);
  const revision = useRef(0);
  const [editing, setEditing] = useState<{
    port: CalendarPort;
    engine: typeof host.engine;
    record: CalendarEventRecord;
    draft?: EventDraft;
    revision: number;
  } | null>(null);
  useEffect(() => {
    setEditing((was) => (was && available && was.port === port && was.engine === host.engine ? was : null));
  }, [available, port, host.engine]);
  useDraftRestore("edit", port, ({ draft, original }) => {
    if (port !== NONE && original.id === event.recordId && allowed()) {
      beforeRestore.current?.();
      setEditing({ port, engine: host.engine, record: original, draft, revision: ++revision.current });
    }
  });
  const begin = useCallback(() => {
    const present = allowed();
    if (port !== NONE && present)
      setEditing({ port, engine: host.engine, record: present.record, revision: ++revision.current });
  }, [allowed, port, host.engine]);
  useLayoutEffect(() => {
    if (editNext?.current !== event.id) return;
    editNext.current = null;
    begin();
  }, [editNext, event.id, begin]);
  return { editing, begin, end: () => setEditing(null), beforeRestore };
}

function useCardFocus(card: RefObject<HTMLDivElement | null>, id: string, reading: boolean) {
  const readAgain = useRef(false);
  useLayoutEffect(() => {
    if (reading && readAgain.current) {
      readAgain.current = false;
      card.current?.querySelector("button")?.focus();
    }
  }, [card, reading]);
  useLayoutEffect(() => {
    const opener = card.current?.ownerDocument.activeElement;
    card.current?.querySelector("button")?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [card, id]);
  return () => {
    readAgain.current = true;
  };
}
