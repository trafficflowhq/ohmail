import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  dayShort,
  clockTime,
  daySpanOf,
  type CalendarEventRecord,
  type CalendarPort,
  type CalendarRecord,
  type ZoneSource,
} from "@ohmail/app-logic/calendar";
import { Button, Icon } from "@ohmail/ui/base";
import { EventBridge, EventCard, type EventCardRow, type EventCardProps } from "@ohmail/ui/calendar";
import { EventAnswers, type InvitationActions } from "../invitations/EventAnswers.js";
import { NONE, type HostContract } from "../host/index.js";
import { useFrame } from "../frame/commands.js";
import { useLocale, useText, useTimeZone, type Text } from "../text/index.js";
import { useKnownOwnAddresses } from "../frame/room.js";
import { useDraftRestore } from "./draft-undo.js";
import type { EventDraft } from "./event-draft.js";
import { EditEvent } from "./EditEvent.js";
import { peopleRows } from "./event-card-people.js";
import { repeatLine } from "./EventActionQuestion.js";
import { editableEvent, eventOwned, moveDestinations, removableEvent } from "./editable-event.js";
import { useEventCall } from "./event-call.js";
import type { CalendarEventFace } from "./faces.js";
import type { EventActions } from "./use-event-actions.js";
import { useMaps } from "./use-place-suggestions.js";
import { useEventPlacement } from "./use-event-placement.js";
import { useEventCardActions } from "./use-event-card-actions.js";
import { useEventLetters } from "./use-event-letters.js";
import { useReadCardActions } from "./read-card-actions.js";
import { overlapTags } from "./overlap-tags.js";

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
  const date = (day: string) => dayShort(day, locale, today.slice(0, 4));
  const dated = (day: string, minute: number | null) =>
    minute === null ? date(day) : t("atTime", { day: date(day), time: clockTime(minute, locale) });
  let when = date(event.ref.day);
  if (span !== null) {
    when = dated(span.first, span.startMinute);
    const last = span.allDay ? span.last : end?.first;
    if (last !== undefined && last !== span.first) {
      when = t("interval", { first: when, last: dated(last, span.endMinute) });
    } else if (span.endMinute !== null && span.endMinute !== span.startMinute) {
      when += `–${clockTime(span.endMinute, locale)}`;
    }
  }
  return when;
}

function useEventCardRows(event: CalendarEventFace, host: HostContract, t: Text): EventCardRow[] {
  const letters = useEventLetters(event);
  const locale = useLocale();
  const own = useKnownOwnAddresses();
  const rows = rowsOf(event, host, t, locale, own);
  if (letters.length) {
    rows.push({
      label: t("letters", { count: letters.length }),
      children: letters.map((letter) => (
        <Button key={letter.id} kind="quiet" size="s" onPress={letter.open}>
          {letter.subject || t("actions.openLetter")}
        </Button>
      )),
    });
  }
  return rows;
}

function rowsOf(
  event: CalendarEventFace,
  host: HostContract,
  t: Text,
  locale: string,
  own: readonly string[] | null,
): EventCardRow[] {
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
  if (calendar?.access === "busy" || !stored) return rows;
  rows.push(...peopleRows(stored.record, own, t));
  const { repeat, start, alarms } = stored.record;
  if (repeat?.rules.length === 1 && !repeat.added.length) {
    rows.push({ label: t("edit.repeatLabel"), text: repeatLine(repeat.rules[0], start.value, t, locale) });
  }
  if (alarms.length) {
    const alert = new Intl.ListFormat(locale).format(
      alarms.map(({ minutesBefore }) => t("edit.alertMinutes", { minutes: minutesBefore })),
    );
    rows.push({ label: t("edit.alert"), text: alert });
  }
  return rows;
}

interface OpenEventProps {
  readonly event: CalendarEventFace;
  readonly events?: readonly CalendarEventFace[];
  readonly zones: ZoneSource;
  readonly today: string;
  readonly actions: EventActions;
  readonly editNext?: RefObject<string | null>;
  readonly reply?: InvitationActions;
}

export function OpenEvent({ event, events, zones, today, actions, editNext, reply }: OpenEventProps) {
  const { plan, commands, host } = useFrame();
  const port = host.wires.calendar;
  const t = useText("calendar");
  const known = useKnownOwnAddresses();
  const allowed = useCallback(
    () => (port === NONE || event.viewOnly ? null : editableEvent(host, port, event, known)),
    [port, event, host, known],
  );
  const current = allowed();
  const readActions = useReadCardActions(port, event, current, events !== undefined);
  const invited = invitationOf(port, event, known);
  const call = useEventCall(event);
  const rows = useEventCardRows(event, host, t);
  if (call) rows.push({ label: call.label, call });
  if (invited && !current) rows.push({ label: t("edit.time"), children: t("edit.organizerTime") });
  if (!current && !invited && event.repeats && event.state !== "off") {
    rows.push({
      label: t("edit.action"),
      children: t(event.viewOnly ? "edit.repeatReadOnly" : "edit.repeatUnavailable"),
    });
  }
  const maps = useMaps(event.second ?? null);
  const { editing, begin, end, beforeRestore } = useEventEditor(event, port, allowed, editNext);
  const locale = useLocale();
  const zone = useTimeZone();
  const card = useRef<HTMLDivElement>(null);
  const seat = useEventPlacement(card, plan.device !== "phone", editing?.revision);
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
    ...readActions,
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
          scopeAnchor={seat?.anchor}
          key={editing.revision}
          beforeRestore={beforeRestore}
          port={editing.port}
          actionItems={items}
          provider={current.connection?.provider}
          original={editing.record}
          exception={editing.exception}
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
        {...readCardDetails(event, { when, rows, maps, invited, canEdit: current !== null }, t)}
        tags={[...eventTags(event, t), ...overlapTags(event, events ?? [], zone, zones, t)]}
        close={{ label: t("closeEvent"), onPress: () => commands.event(null) }}
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

function readCardDetails(
  event: CalendarEventFace,
  {
    when,
    rows,
    maps,
    invited,
    canEdit,
  }: {
    when: string;
    rows: EventCardRow[];
    maps: ReturnType<typeof useMaps>;
    invited: boolean;
    canEdit: boolean;
  },
  t: Text,
): Pick<EventCardProps, "title" | "when" | "tone" | "why" | "rows" | "status" | "where" | "notes"> {
  return {
    title: event.title,
    when,
    tone: event.tone,
    rows,
    why: event.viewOnly
      ? { text: t("edit.readOnlyCalendar"), locked: true }
      : invited && !canEdit
        ? { text: t("edit.invited") }
        : undefined,
    where: event.second ? [{ text: event.second, maps }] : undefined,
    notes: event.notes ?? undefined,
    status: event.conflict ? undefined : (event.status ?? undefined),
  };
}

function eventTags(event: CalendarEventFace, t: Text) {
  return [
    ...(event.waits ? [{ text: t("toAnswer"), hot: true }] : []),
    ...(event.state === "off" ? [{ text: t("edit.cancelled"), hot: true }] : []),
    ...(event.state === "maybe" ? [{ text: t("edit.maybe") }] : []),
    ...(event.conflict ? [{ text: t("edit.changedElsewhere"), hot: true }] : []),
  ];
}

function invitationOf(
  port: CalendarPort | typeof NONE,
  event: CalendarEventFace,
  own: readonly string[] | null,
) {
  if (port === NONE || event.state === "off") return false;
  const record = port.events().find(({ record }) => record.id === event.recordId)?.record;
  return !!record?.organizer && record.myAnswer !== null && !eventOwned(record, own);
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
    exception: CalendarEventRecord | null;
    draft?: EventDraft;
    revision: number;
  } | null>(null);
  useEffect(() => {
    setEditing((was) => (was && available && was.port === port && was.engine === host.engine ? was : null));
  }, [available, port, host.engine]);
  useDraftRestore("edit", port, ({ draft, original }) => {
    const current = allowed();
    if (port !== NONE && original.id === event.recordId && current) {
      beforeRestore.current?.();
      setEditing({
        port,
        engine: host.engine,
        record: current.exception ? current.record : original,
        exception: current.exception ? original : null,
        draft,
        revision: ++revision.current,
      });
    }
  });
  const begin = useCallback(() => {
    const present = allowed();
    if (port !== NONE && present)
      setEditing({
        port,
        engine: host.engine,
        record: present.record,
        exception: present.exception,
        revision: ++revision.current,
      });
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
