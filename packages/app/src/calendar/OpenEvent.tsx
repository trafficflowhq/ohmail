import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  dayLong,
  clockTime,
  daySpanOf,
  type CalendarEventRecord,
  type CalendarPort,
  type ZoneSource,
} from "@ohmail/app-logic/calendar";
import { Button } from "@ohmail/ui/base";
import { EventCard } from "@ohmail/ui/calendar";
import { EventAnswers } from "../invitations/EventAnswers.js";
import { NONE } from "../host/index.js";
import { useFrame } from "../frame/commands.js";
import { useLocale, useText, useTimeZone, type Text } from "../text/index.js";
import { useKnownOwnAddresses } from "../frame/room.js";
import { EditEvent } from "./EditEvent.js";
import { editableEvent, moveDestinations, removableEvent } from "./editable-event.js";
import type { CalendarEventFace } from "./faces.js";
import type { EventActions } from "./use-event-actions.js";
import { useEventCardActions } from "./use-event-card-actions.js";

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

export function OpenEvent({
  event,
  zones,
  today,
  actions,
}: {
  readonly event: CalendarEventFace;
  readonly zones: ZoneSource;
  readonly today: string;
  readonly actions: EventActions;
}) {
  const { plan, commands, host } = useFrame();
  const port = host.wires.calendar;
  const t = useText("calendar");
  const known = useKnownOwnAddresses();
  const allowed = () =>
    port === NONE || event.viewOnly ? null : editableEvent(host, port, event.recordId, known);
  const current = allowed();
  const available = current !== null;
  const [editing, setEditing] = useState<{
    port: CalendarPort;
    engine: typeof host.engine;
    record: CalendarEventRecord;
  } | null>(null);
  useEffect(() => {
    if (!available || editing?.port !== port || editing?.engine !== host.engine) setEditing(null);
  }, [available, editing?.port, editing?.engine, port, host.engine]);
  const locale = useLocale();
  const zone = useTimeZone();
  const card = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const opener = card.current?.ownerDocument.activeElement;
    card.current?.querySelector("button")?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [event.id]);
  const when = timeOf(event, zone, zones, today, locale, t);
  const edit =
    current && port !== NONE
      ? {
          label: t("edit.action"),
          onPress: () => {
            const present = allowed();
            if (present) setEditing({ port, engine: host.engine, record: present.record });
          },
        }
      : null;
  const { blocked, onKeyDown, panel, menu } = useEventCardActions({
    event,
    actions,
    edit,
    removable: port !== NONE && removableEvent(host, port, event, known, zones) !== null,
    destinations: current ? moveDestinations(host, current) : [],
  });
  if (editing && editing.port === port && editing.engine === host.engine && current) {
    return (
      <EditEvent
        port={editing.port}
        original={editing.record}
        allowed={allowed}
        calendar={current.calendar}
        face={event}
        when={when}
        today={today}
      />
    );
  }
  return (
    <>
      <EventCard
        ref={card}
        frame={plan.device === "phone" ? "sheet" : "card"}
        onKeyDown={onKeyDown}
        answers={
          port !== NONE && !event.viewOnly ? (
            <EventAnswers key={event.id} port={port} recordId={event.recordId} />
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
        {...(event.second ? { where: [{ text: event.second }] } : {})}
        {...(event.notes ? { notes: event.notes } : {})}
        {...(event.people.length ? { rows: [{ label: t("people"), text: event.people.join(", ") }] } : {})}
        {...(event.status ? { tags: [{ text: event.status.text, hot: event.status.failed }] } : {})}
      />
      {plan.device !== "phone" && panel && (
        <div className="cal-event-panel" onKeyDown={onKeyDown}>
          {panel}
        </div>
      )}
      {menu}
    </>
  );
}
