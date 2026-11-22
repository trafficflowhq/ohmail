import { useLayoutEffect, useRef, useState } from "react";
import {
  eventTimeOf,
  deleteAudienceOf,
  pressAndHear,
  moveTime,
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
import {
  editBase,
  editSchedule,
  editVersions,
  editableEvent,
  eventOwned,
  moveDestinations,
  removableEvent,
  type EditableEvent,
} from "./editable-event.js";
import type { CalendarEventFace } from "./faces.js";
import { useCalendarGestureReport } from "./update-report.js";
import { canStartTimeChange, changedTimes, resizedDays, type EventChange } from "./event-time-change.js";
import { eventWhen } from "./event-words.js";
import { editGuestUpdate, eventUpdate, guestUpdate } from "./guest-update.js";

const versionOf = (current: EditableEvent) => `${editVersions(current)}\n${editSchedule(current)}`;

const needsFreshSeriesQuestion = (current: EditableEvent, change: EventChange, version: string) =>
  !!current.record.repeat &&
  change.kind !== "delete" &&
  change.kind !== "calendar" &&
  version !== versionOf(current) &&
  version.split("\n")[1] === editSchedule(current);

type Request = {
  change: EventChange;
  face: CalendarEventFace;
  anchor: HTMLElement;
  version: string;
  scope: CalendarRemoveScope | null;
  scopes: readonly CalendarRemoveScope["kind"][];
  repeatRule: string | undefined;
  repeatStart: string;
  changedOccurrence: boolean;
  firstOccurrence: boolean;
  guests: readonly string[];
  audience: ReturnType<typeof guestUpdate>["audience"];
};

function deleteScopesAt(record: EditableEvent["record"], occurrence: string | null) {
  const scopes = record.deleteScopes ?? [];
  const rangeAnchor =
    occurrence !== null &&
    record.deleteMembers?.some(
      (member) => member.range && member.at !== null && String(member.at) === occurrence,
    );
  return rangeAnchor ? scopes.filter((kind) => kind !== "occurrence") : scopes;
}

function requestFor(
  current: EditableEvent,
  face: CalendarEventFace,
  change: EventChange,
  anchor: HTMLElement,
): Request {
  const { record, exception } = current;
  const { names, audience } = guestUpdate(exception ?? record, {});
  return {
    face,
    change,
    anchor,
    version: versionOf(current),
    scope: record.repeat && change.kind !== "calendar" ? null : { kind: "record" },
    scopes:
      change.kind === "delete" && record.repeat
        ? deleteScopesAt(record, face.ref.occurrence)
        : ["occurrence", "following", "record"],
    repeatRule: record.repeat?.rules[0],
    repeatStart: record.start.value,
    changedOccurrence: exception !== null,
    firstOccurrence: Number(face.ref.occurrence) === Date.parse(record.startsAt),
    guests: names,
    audience,
  };
}

function guestsFor(
  current: EditableEvent,
  change: EventChange,
  scope: CalendarRemoveScope,
  own: readonly string[] | null,
) {
  const { record } = current;
  if (!record.repeat) return guestUpdate(record, {});
  if (change.kind !== "delete") return editGuestUpdate(current, {}, scope);
  const audience = record.deleteMembers && deleteAudienceOf(record.deleteMembers, scope);
  if (
    !audience ||
    (audience.audience.organizer !== null &&
      !own?.some((address) => address.trim().toLowerCase() === audience.audience.organizer) &&
      !(
        eventOwned(record, own) &&
        record.organizer?.address.trim().toLowerCase() === audience.audience.organizer
      ))
  )
    return null;
  return audience;
}

function actionFor(
  change: EventChange,
  face: CalendarEventFace,
  current: EditableEvent,
  scope: CalendarRemoveScope,
  zone: string,
  zones: ZoneSource,
  newId: () => string,
  audience: Request["audience"],
): CalendarAct | null {
  const { record, exception } = current;
  const stamped = { eventId: record.id, base: record.updatedAt };
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
  const times = changedTimes(change, { ...face, start, end }, zone, zones);
  if (!times) return null;
  if (change.kind === "resize-time" && (!record.repeat || wholeSeries) && record.end) {
    if (change.edge === "start") times.end = record.end;
    else times.start = record.start;
  }
  const updateScope = scope.kind === "following" ? { ...scope, newEventId: newId() } : scope;
  return eventUpdate(exception ?? record, editBase(current, updateScope), times, updateScope, { audience });
}

function refreshedAction(
  { change, face, version, scope, audience }: Request,
  current: EditableEvent,
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
  const live = guestsFor(current, change, scope, own);
  if (versionOf(current) !== version || !live || JSON.stringify(live.audience) !== JSON.stringify(audience))
    return "refusal.changed";
  const destination =
    change.kind === "calendar"
      ? moveDestinations(host, current).find((target) => target.id === change.target)
      : undefined;
  if (change.kind === "calendar" && !destination) return "refusal.readOnly";
  const act = actionFor(change, face, current, scope, zone, zones, () => port.newId(), audience);
  return act ? { act, destination } : "refusal.invalid";
}

function scopeOf(kind: CalendarRemoveScope["kind"], at: string | null, first: string): CalendarRemoveScope {
  return kind === "record" || !at || (kind === "following" && Number(at) === Date.parse(first))
    ? { kind: "record" }
    : { kind, at };
}

function scopedRequest(
  question: Request,
  current: EditableEvent,
  kind: CalendarRemoveScope["kind"],
  at: string | null,
  own: readonly string[] | null,
): Request | null {
  const scope = scopeOf(kind, at, current.record.startsAt);
  const found = guestsFor(current, question.change, scope, own);
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
  destination?: string,
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
  else if (heard.verdict?.kind === "taken" && act.kind === "calendar_event_move" && destination)
    report(destination);
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

function whenFor(question: Request, zone: string, zones: ZoneSource, locale: string) {
  const { change, face } = question;
  const times = changedTimes(change, face, zone, zones);
  return times && eventWhen(times, zone, zones, locale, change.kind === "resize-time");
}

export function useEventActions(port: CalendarPort, zones: ZoneSource) {
  const { host, commands, route } = useFrame();
  const own = useKnownOwnAddresses();
  const zone = useTimeZone();
  const e = useText("event");
  const locale = useLocale();
  const reportUpdate = useCalendarGestureReport(port, zone, zones);
  const report = useReport();
  const page = fragmentOf(route);
  const { question, ask, busy, setBusy, ticket } = useEventActionState(page, host.engine, port, zone);

  const canWrite = (face: CalendarEventFace, change: EventChange): EditableEvent | null => {
    if (face.viewOnly) return null;
    if (change.kind !== "delete") return editableEvent(host, port, face, own);
    const current = removableEvent(host, port, face, own, zones);
    return current && { ...current, exception: null };
  };

  const allowed = !question || canWrite(question.face, question.change) !== null;
  useLayoutEffect(() => {
    if (!allowed) ask(null);
  }, [allowed, ask]);

  const send = async (request: Request) => {
    const { change, face, scope, guests } = request;
    if (ticket.current || !scope) return;
    ask(null);
    const current = canWrite(face, change);
    if (!current) return report(e("refusal.readOnly"));
    if (needsFreshSeriesQuestion(current, change, request.version))
      return ask(requestFor(current, face, change, request.anchor));
    const outcome = refreshedAction(request, current, host, own, zone, zones, port);
    if (typeof outcome === "string") return report(e(outcome));
    const range = change.kind === "resize" && resizedDays(face.start, face.end, change.edge, change.days);
    const currentRecord = () => canWrite(face, change)?.record ?? null;
    const stamp = Symbol();
    ticket.current = stamp;
    setBusy(true);
    try {
      await commitAction(
        port,
        outcome.act,
        guests,
        locale,
        e,
        report,
        () => ticket.current === stamp,
        () => {
          if (route.open === face.id) commands.event(null);
        },
        reportUpdate(range, change.kind === "resize-time" || change.kind === "time", current, currentRecord),
        outcome.destination?.name,
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

  const start = (
    face: CalendarEventFace,
    change: EventChange,
    anchor: HTMLElement,
    expectedVersion?: string,
  ) => {
    if (ticket.current || question || !canStartTimeChange(face, change, zone, zones)) return;
    const current = canWrite(face, change);
    if (!current) return;
    const request = requestFor(current, face, change, anchor);
    if (expectedVersion !== undefined && request.version !== expectedVersion) {
      if (needsFreshSeriesQuestion(current, change, expectedVersion)) ask(request);
      else report(e("refusal.changed"));
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
    const next = scopedRequest(question, current, kind, at, own);
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
    question: allowed && question ? { ...question, when: whenFor(question, zone, zones, locale) } : null,
    start,
    chooseScope,
    moveTime: (face: CalendarEventFace, delta: number, snap: boolean) =>
      moveTime(face, delta, snap, zone, zones),
    moveVersion: (face: CalendarEventFace) => {
      const event = !busy && !question && canWrite(face, { kind: "time", days: 0, minutes: 0 });
      return event ? versionOf(event) : undefined;
    },
    cancel: () => ask(null),
    confirm: () => question && void send(question),
  };
}

export type EventActions = ReturnType<typeof useEventActions>;
