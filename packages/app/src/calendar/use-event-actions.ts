import { useLayoutEffect, useRef, useState } from "react";
import {
  addDays,
  isoOfDay,
  eventTimeOf,
  deleteAudienceOf,
  pressAndHear,
  moveTime,
  reschedule,
  type CalendarEventRecord,
  type CalendarPort,
  type ZoneSource,
} from "@ohmail/app-logic/calendar";
import type { ToastFn } from "@ohmail/app-logic/press/report";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import type { CalendarAct, CalendarRemoveScope } from "@ohmail/wire";
import { useFrame, useReport } from "../frame/commands.js";
import { useKnownOwnAddresses } from "../frame/room.js";
import { fragmentOf } from "../frame/route.js";
import { useLocale, useText, useTimeZone, type Text } from "../text/index.js";
import { editableEvent, moveDestinations, removableEvent } from "./editable-event.js";
import type { CalendarEventFace } from "./faces.js";
import { useRangeUpdateReport } from "./update-report.js";
import type { DayEdge } from "./view.js";
import { eventUpdate, guestUpdate } from "./guest-update.js";

type Change =
  | { kind: "delete" }
  | { kind: "calendar"; target: string }
  | { kind: "time"; days: number; minutes: number }
  | { kind: "resize"; edge: DayEdge; days: number };

export function resizedDays(
  start: CalendarEventFace["start"],
  end: CalendarEventFace["end"],
  edge: DayEdge,
  days: number,
) {
  if (start.kind !== "date" || end.kind !== "date") return null;
  const first = isoOfDay(start);
  const last = addDays(isoOfDay(end), -1);
  const shifted = addDays(edge === "start" ? first : last, days);
  return edge === "start"
    ? { first: shifted > last ? last : shifted, last }
    : { first, last: shifted < first ? first : shifted };
}

const versionOf = (record: CalendarEventRecord) =>
  JSON.stringify([record.updatedAt, record.calendarId, record.start, record.end]);

type Request = {
  change: Change;
  face: CalendarEventFace;
  anchor: HTMLElement;
  base: string;
  version: string;
  scope: CalendarRemoveScope | null;
  scopes: readonly CalendarRemoveScope["kind"][];
  repeatRule: string | undefined;
  repeatStart: string;
  guests: readonly string[];
  audience: ReturnType<typeof guestUpdate>["audience"];
};

function deleteScopesAt(record: CalendarEventRecord, occurrence: string | null) {
  const scopes = record.deleteScopes ?? [];
  const rangeAnchor =
    occurrence !== null &&
    record.deleteMembers?.some(
      (member) => member.range && member.at !== null && String(member.at) === occurrence,
    );
  return rangeAnchor ? scopes.filter((kind) => kind !== "occurrence") : scopes;
}

function requestFor(
  record: CalendarEventRecord,
  face: CalendarEventFace,
  change: Change,
  anchor: HTMLElement,
): Request {
  const { names, audience } = guestUpdate(record, {});
  return {
    face,
    change,
    anchor,
    base: record.updatedAt,
    version: versionOf(record),
    scope: record.repeat && change.kind !== "calendar" ? null : { kind: "record" },
    scopes:
      change.kind === "delete" && record.repeat
        ? deleteScopesAt(record, face.ref.occurrence)
        : ["occurrence", "following", "record"],
    repeatRule: record.repeat?.rules[0],
    repeatStart: record.start.value,
    guests: names,
    audience,
  };
}

function guestsFor(
  record: CalendarEventRecord,
  change: Change,
  scope: CalendarRemoveScope,
  own: readonly string[] | null,
) {
  if (change.kind !== "delete" || !record.repeat) return guestUpdate(record, {});
  const audience = record.deleteMembers && deleteAudienceOf(record.deleteMembers, scope);
  if (
    !audience ||
    (audience.audience.organizer !== null &&
      !own?.some((address) => address.trim().toLowerCase() === audience.audience.organizer))
  )
    return null;
  return audience;
}

function actionFor(
  change: Change,
  face: CalendarEventFace,
  record: CalendarEventRecord,
  base: string,
  scope: CalendarRemoveScope,
  zone: string,
  zones: ZoneSource,
  newId: () => string,
  audience: Request["audience"],
): CalendarAct | null {
  const stamped = { eventId: record.id, base };
  if (change.kind === "delete")
    return {
      kind: "calendar_event_delete",
      ...stamped,
      scope,
      ...((record.repeat || audience.guests.length > 0) && { audience }),
    };
  if (change.kind === "calendar") {
    return { kind: "calendar_event_move", ...stamped, toCalendarId: change.target };
  }
  // The whole series moves from its stored start. A single occurrence starts where it is drawn.
  const wholeSeries = scope.kind === "record" && record.repeat !== null;
  const start = wholeSeries ? eventTimeOf(record.start) : face.start;
  const end = wholeSeries ? record.end && eventTimeOf(record.end) : face.end;
  if (!start || !end) return null;
  const range = change.kind === "resize" ? resizedDays(start, end, change.edge, change.days) : null;
  const times =
    change.kind === "time"
      ? reschedule(start, end, change.days, change.minutes, zone, zones)
      : range && {
          start: { kind: "date" as const, value: range.first.replaceAll("-", "") },
          end: { kind: "date" as const, value: addDays(range.last, 1).replaceAll("-", "") },
        };
  if (!times) return null;
  const updateScope = scope.kind === "following" ? { ...scope, newEventId: newId() } : scope;
  return eventUpdate(record, base, times, updateScope);
}

function refreshedAction(
  { change, face, base, version, scope, audience }: Request,
  current: NonNullable<ReturnType<typeof removableEvent>>,
  host: Parameters<typeof removableEvent>[0],
  own: readonly string[] | null,
  zone: string,
  zones: ZoneSource,
  port: CalendarPort,
) {
  if (!scope) return "refusal.invalid";
  const { record } = current;
  if (
    change.kind === "delete" &&
    record.repeat &&
    !deleteScopesAt(record, face.ref.occurrence).includes(scope.kind)
  )
    return "refusal.readOnly";
  const live = guestsFor(record, change, scope, own);
  if (versionOf(record) !== version || !live || JSON.stringify(live.audience) !== JSON.stringify(audience))
    return "refusal.changed";
  if (
    change.kind === "calendar" &&
    !moveDestinations(host, current).some((target) => target.id === change.target)
  )
    return "refusal.readOnly";
  return (
    actionFor(change, face, record, base, scope, zone, zones, () => port.newId(), audience) ??
    "refusal.invalid"
  );
}

function scopeOf(kind: CalendarRemoveScope["kind"], at: string | null, first: string): CalendarRemoveScope {
  return kind === "record" || !at || (kind === "following" && Number(at) === Date.parse(first))
    ? { kind: "record" }
    : { kind, at };
}

function scopedRequest(
  question: Request,
  record: CalendarEventRecord,
  kind: CalendarRemoveScope["kind"],
  at: string | null,
  own: readonly string[] | null,
): Request | null {
  const scope = scopeOf(kind, at, record.startsAt);
  const found = guestsFor(record, question.change, scope, own);
  return found ? { ...question, scope, guests: found.names, audience: found.audience } : null;
}

async function commitAction(
  port: CalendarPort,
  act: CalendarAct,
  guests: readonly string[],
  locale: string,
  e: Text,
  report: ToastFn,
  current: () => boolean,
  close: () => void,
  updated?: (act: Extract<CalendarAct, { kind: "calendar_event_update" }>) => void,
) {
  if (act.kind === "calendar_event_delete" && guests.length === 0 && port.holdDelete) {
    const held = await port.holdDelete(act, UNDO_MS);
    if (!current()) return;
    const remaining = held.remainingMs();
    report(
      e("taken.delete"),
      remaining > 0
        ? {
            action: e("undoDelete"),
            duration: remaining,
            actionDeadline: held.deadline,
            onAction: () => {
              if (held.remainingMs() <= 0) {
                report(e("undoLate"));
                return;
              }
              void held.undo().then(
                (restored) => report(e(restored ? "deleteUndone" : "undoLate")),
                () => report(e("refusal.unknown")),
              );
            },
          }
        : undefined,
    );
    close();
    return;
  }
  const heard = await pressAndHear(port, act);
  if (!current()) return;
  if (heard.verdict?.kind === "refused" && heard.verdict.word === "version_stale")
    report(e("refusal.changed"));
  else if (heard.verdict?.kind === "taken" && act.kind === "calendar_event_delete" && guests.length)
    report(e("taken.deleteAudience", { guests: new Intl.ListFormat(locale).format(guests) }));
  else if (heard.verdict?.kind === "taken" && act.kind === "calendar_event_update" && updated) updated(act);
  else if (heard.say) report(e(heard.say));
  if (heard.verdict?.kind !== "refused") close();
}

function useEventActionState(page: string, engine: object, port: CalendarPort, zone: string) {
  const [question, ask] = useState<Request | null>(null);
  const [busy, setBusy] = useState(false);
  const ticket = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    ask(null);
    setBusy(false);
    return () => {
      ticket.current = null;
    };
  }, [page, engine, port, zone]);

  return { question, ask, busy, setBusy, ticket };
}

export function useEventActions(port: CalendarPort, zones: ZoneSource) {
  const { host, commands, route } = useFrame();
  const own = useKnownOwnAddresses();
  const zone = useTimeZone();
  const e = useText("event");
  const locale = useLocale();
  const reportRange = useRangeUpdateReport(port);
  const report = useReport();
  const page = fragmentOf(route);
  const { question, ask, busy, setBusy, ticket } = useEventActionState(page, host.engine, port, zone);

  const canWrite = (face: CalendarEventFace, change: Change) =>
    face.viewOnly
      ? null
      : change.kind === "delete"
        ? removableEvent(host, port, face, own, zones)
        : editableEvent(host, port, face.recordId, own);

  const allowed = !question || canWrite(question.face, question.change) !== null;
  useLayoutEffect(() => {
    if (!allowed) ask(null);
  }, [allowed, ask]);

  const send = async (request: Request) => {
    const { change, face, scope, guests } = request;
    if (ticket.current || !scope) return;
    ask(null);
    const current = canWrite(face, change);
    if (!current) {
      report(e("refusal.readOnly"));
      return;
    }
    const act = refreshedAction(request, current, host, own, zone, zones, port);
    if (typeof act === "string") {
      report(e(act));
      return;
    }
    const range = change.kind === "resize" && resizedDays(face.start, face.end, change.edge, change.days);
    const before = { ...current.record };
    const currentRecord = () => canWrite(face, change)?.record ?? null;
    const stamp = Symbol();
    ticket.current = stamp;
    setBusy(true);
    try {
      await commitAction(
        port,
        act,
        guests,
        locale,
        e,
        report,
        () => ticket.current === stamp,
        () => {
          if (route.open === face.id) commands.event(null);
        },
        range ? (act) => reportRange(range, before, act.change, currentRecord) : undefined,
      );
    } catch {
      if (ticket.current === stamp) report(e("refusal.unknown"));
    } finally {
      if (ticket.current === stamp) {
        ticket.current = null;
        setBusy(false);
      }
    }
  };

  const start = (face: CalendarEventFace, change: Change, anchor: HTMLElement, expectedVersion?: string) => {
    if (ticket.current || question || (change.kind === "time" && !change.days && !change.minutes)) return;
    if (change.kind === "resize") {
      const range = resizedDays(face.start, face.end, change.edge, change.days);
      const before = resizedDays(face.start, face.end, change.edge, 0);
      if (!range || (range.first === before?.first && range.last === before.last)) return;
    }
    const current = canWrite(face, change);
    if (!current) return;
    const request = requestFor(current.record, face, change, anchor);
    if (expectedVersion !== undefined && request.version !== expectedVersion) {
      report(e("refusal.changed"));
      return;
    }
    if (!request.scope || request.guests.length) ask(request);
    else void send(request);
  };

  const chooseScope = (kind: CalendarRemoveScope["kind"]) => {
    if (!question || !question.scopes.includes(kind)) return;
    const current = canWrite(question.face, question.change);
    const at = question.face.ref.occurrence;
    if (!current || (kind !== "record" && !at)) {
      ask(null);
      return;
    }
    const next = scopedRequest(question, current.record, kind, at, own);
    if (!next) {
      ask(null);
      report(e("refusal.changed"));
      return;
    }
    if (next.guests.length) ask(next);
    else void send(next);
  };

  return {
    busy,
    question: allowed ? question : null,
    start,
    chooseScope,
    moveTime: (face: CalendarEventFace, delta: number, snap: boolean) =>
      moveTime(face, delta, snap, zone, zones),
    moveVersion: (face: CalendarEventFace) => {
      if (busy || question) return undefined;
      const event = canWrite(face, { kind: "time", days: 0, minutes: 0 });
      return event && versionOf(event.record);
    },
    cancel: () => ask(null),
    confirm: () => question && void send(question),
  };
}

export type EventActions = ReturnType<typeof useEventActions>;
