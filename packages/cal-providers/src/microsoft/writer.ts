/**
 * Microsoft's calendar by Graph, written: a new event under a `transactionId` made from the write's
 * own key (Graph's own guard: the same id hands the first event back), a change and a removal
 * against the tag a reading stored (`If-Match`), and the account's own answer by Graph's three
 * answer calls. Built from Microsoft's own pages and tried against the bench's double; not tried
 * against Microsoft itself, and behind Microsoft's own switch. Graph sends invitations itself.
 *
 * A recurring edit uses the master and, for one day, the instance named by its original start.
 * A split creates the continuation before it shortens the original. A pasted call link and more
 * than one reminder are outside Graph's writable fields (Graph keeps neither as written),
 * and notes over a body in markup (the reader reads such a body as Graph's plain preview, so a
 * change of it would replace what the person never saw).
 */
import { portableMicrosoft } from "../portable.js";
import { createHash } from "node:crypto";
import {
  expandSeries,
  instant,
  momentOrUtc,
  MS_PER_DAY,
  recurrenceKeyOf,
  recurrenceKeyString,
  seriesOf,
  wallIn,
  type EventTime,
} from "@ohmail/cal-core";
import {
  addressOf,
  bearerOf,
  filled,
  isRecord,
  jsonOf,
  MAX_PROVIDER_ID_CHARS,
  pathSegment,
  type Json,
} from "../json-answers.js";
import { MAX_PAGES_PER_CALL, MAX_PAGE_LIMIT } from "../limits.js";
import type {
  CalendarRef,
  CalendarWriter,
  ChangeItem,
  Connection,
  EventChange,
  EventDraft,
  SeriesContinuation,
  WriteAnswer,
  WriteKey,
  WriteReply,
  WriteTarget,
} from "../port.js";
import type { ProviderRefusal, WriteRefusal } from "../refusals.js";
import {
  retryAfterMs,
  sendableTag,
  type HttpMethod,
  type HttpResponse,
  type Precondition,
} from "../request/index.js";
import { clockOf, sameTime } from "../series.js";
import {
  alreadyHolds,
  ordinarySharedChange,
  sameAudience,
  sameCancellationAudience,
} from "../write-compare.js";
import { dayOfSeries, recordOf, ruleOfRecurrence, seriesOfRecord, type SeriesClock } from "./convert.js";
import { graphBaseOf, insideBase } from "./graph.js";
import { graphAuthorization, stamp, type MicrosoftDeps } from "./reader.js";
import { dateOfTime, priorDate, recurrenceFor } from "../repeat-shapes.js";

type Refusal = {
  readonly ok: false;
  readonly reason: ProviderRefusal | WriteRefusal;
  readonly retryAfterMs: number | null;
};
const refused = (reason: ProviderRefusal | WriteRefusal, wait: number | null = null): Refusal => ({
  ok: false,
  reason,
  retryAfterMs: wait,
});
/** Done, as found: a write's own request was not what made it so (a refused precondition and a compare, an object already so). */
const answered = (items: readonly ChangeItem[]): WriteAnswer => ({ ok: true, items });
/** Done by the write's own request: what waits behind it may be re-based onto `items`. */
const wrote = (items: readonly ChangeItem[]): WriteAnswer => ({ ok: true, items, written: true });
type Upsert = Extract<ChangeItem, { kind: "upsert" }>;
type MatchTag = Extract<Precondition, { kind: "unchanged" }>;
type Master = {
  readonly item: Upsert;
  readonly raw: Json;
  readonly series: SeriesClock;
  readonly pre: MatchTag;
};
type Instance = {
  readonly item: Upsert;
  readonly raw: Json;
  readonly isException: boolean;
  readonly pre: MatchTag;
};

const carriedFields = [
  "subject",
  "body",
  "location",
  "locations",
  "sensitivity",
  "showAs",
  "isReminderOn",
  "reminderMinutesBeforeStart",
  "responseRequested",
  "allowNewTimeProposals",
  "hideAttendees",
  "categories",
  "importance",
] as const;

const masterFields = [
  "id",
  "iCalUId",
  "type",
  "changeKey",
  "transactionId",
  "recurrence",
  "start",
  "end",
  "isAllDay",
  "originalStartTimeZone",
  "originalEndTimeZone",
  "isOrganizer",
  "isCancelled",
  "organizer",
  "attendees",
  "bodyPreview",
  "hasAttachments",
  "isOnlineMeeting",
  "onlineMeeting",
  "originalStart",
  "seriesMasterId",
  "occurrenceId",
  "cancelledOccurrences",
  "exceptionOccurrences",
  ...carriedFields,
].join(",");

const continuationFields = [
  "id",
  "iCalUId",
  "type",
  "changeKey",
  "transactionId",
  "recurrence",
  "start",
  "end",
  "isAllDay",
  "originalStartTimeZone",
  "originalEndTimeZone",
  "isOrganizer",
  "isCancelled",
  "organizer",
  "attendees",
  "subject",
  "body",
  "bodyPreview",
  "location",
  "showAs",
  "sensitivity",
  "onlineMeeting",
  "isReminderOn",
  "reminderMinutesBeforeStart",
  "createdDateTime",
].join(",");

function recurrenceOf(raw: Json): { readonly pattern: Json; readonly range: Json } | null {
  const value = raw.recurrence;
  return isRecord(value) && isRecord(value.pattern) && isRecord(value.range)
    ? { pattern: value.pattern, range: value.range }
    : null;
}

function preconditionOf(raw: Json, header: string | null = null): MatchTag | null {
  const tag = filled(raw["@odata.etag"]) ?? header;
  return tag !== null && sendableTag(tag) ? { kind: "unchanged", tag } : null;
}

/** Graph may add defaults to a recurrence or an attendee when it returns the record. */
function submittedValuesMatch(expected: unknown, actual: unknown, exact = false): boolean {
  if (expected == null) return actual == null;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => submittedValuesMatch(item, actual[index], exact))
    );
  if (isRecord(expected))
    return (
      isRecord(actual) &&
      (!exact || Object.keys(expected).length === Object.keys(actual).length) &&
      Object.entries(expected).every(([key, value]) => submittedValuesMatch(value, actual[key], exact))
    );
  return expected === actual;
}

function audienceOf(target: WriteTarget, item: Upsert, raw: Json): Refusal | null {
  if (raw.isOrganizer === false) return refused("read_only");
  const expected = target.audience;
  if (expected === undefined || !Array.isArray(raw.attendees) || item.audienceIncomplete)
    return refused("version_stale");
  const plain = { ...item.event, recurrenceId: null, rules: [], added: [], excluded: [] };
  return sameAudience(expected, plain) ? null : refused("version_stale");
}

/** A master update may also mail any separately edited instances. */
function exceptionAudience(raw: Json, expected: WriteTarget["audience"]): boolean {
  const { exceptionOccurrences: instances } = raw;
  if (
    expected === undefined ||
    !Array.isArray(instances) ||
    raw["exceptionOccurrences@odata.nextLink"] !== undefined
  )
    return false;
  const allowed = new Set(expected.guests);
  if (expected.organizer !== null) allowed.add(expected.organizer);
  return instances.every((day) => {
    if (
      !isRecord(day) ||
      day.isOrganizer === false ||
      !Array.isArray(day.attendees) ||
      day.attendeesOmitted === true ||
      day["attendees@odata.nextLink"] !== undefined
    )
      return false;
    const organizer =
      isRecord(day.organizer) && isRecord(day.organizer.emailAddress)
        ? addressOf(day.organizer.emailAddress.address)
        : day.organizer === null
          ? null
          : undefined;
    return (
      organizer === expected.organizer &&
      day.attendees.every((entry) => {
        const address =
          isRecord(entry) && isRecord(entry.emailAddress) ? addressOf(entry.emailAddress.address) : undefined;
        return address !== undefined && allowed.has(address);
      })
    );
  });
}

/** Graph can advance the exception tag when it applies a master update. Seal its untouched fields. */
function exceptionSnapshotOf(day: Instance, body: Json): string {
  const protectedFields = new Set([
    "start",
    "end",
    "isAllDay",
    "originalStart",
    "originalStartTimeZone",
    "originalEndTimeZone",
    "attendees",
    "organizer",
    // Setting the primary location can replace Graph's entire locations collection.
    "locations",
  ]);
  const ignored = new Set(["@odata.context", "@odata.etag", "changeKey", "lastModifiedDateTime"]);
  for (const field of Object.keys(body)) if (!protectedFields.has(field)) ignored.add(field);
  if ("body" in body) ignored.add("bodyPreview");
  const unchanged = Object.fromEntries(Object.entries(day.raw).filter(([key]) => !ignored.has(key)));
  const canon = JSON.stringify(unchanged, (_key, value: unknown) =>
    isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
  return createHash("sha256").update(canon).digest("hex");
}

function onlyConfirmedGuests(expected: WriteTarget["audience"], change: EventChange): boolean {
  if (change.attendees === undefined) return true;
  const allowed = new Set(expected?.guests);
  return change.attendees.every((entry) => allowed.has(entry.email.toLowerCase()));
}

/** An unanswered end can have landed. Only explicit refusals can lead to compensation. */
const definitelyRefused = (status: number): boolean => [400, 401, 403, 409, 412, 422].includes(status);

function segment(id: string): string | null {
  if (id === "" || id === "." || id === ".." || id.length > MAX_PROVIDER_ID_CHARS) return null;
  return pathSegment(id);
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
/** Midnight: a whole day starts and ends there. */
const MIDNIGHT = "00:00:00";

/** A time as Graph writes it: a clock time and the zone it is told in. A clock time with no zone is no time Graph keeps. */
function timeJson(t: EventTime): Json | null {
  switch (t.kind) {
    case "date":
      return { dateTime: `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}T${MIDNIGHT}`, timeZone: "UTC" };
    case "instant": {
      const iso = new Date(t.epochMs).toISOString();
      return { dateTime: iso.slice(0, 19), timeZone: "UTC" };
    }
    case "zoned": {
      const w = t.wall;
      return {
        dateTime: `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`,
        timeZone: t.tzid,
      };
    }
    case "floating":
      return null;
  }
}

/** The fields of a draft or a change as Graph's event, field by field from the typed values. */
function bodyOf(f: EventChange): Json | "field_unwritable" | "repeat_unsupported" {
  const body: Json = {};
  if (f.rule !== undefined && f.rule !== null) return "repeat_unsupported";
  if (f.url !== undefined && f.url !== null) return "field_unwritable";
  if (f.alarms !== undefined && f.alarms.length > 1) return "field_unwritable";
  if (f.summary !== undefined) body.subject = f.summary;
  if (f.description !== undefined) body.body = { contentType: "text", content: f.description ?? "" };
  if (f.location !== undefined) body.location = { displayName: f.location ?? "" };
  if (f.start !== undefined || f.end !== undefined) {
    if (f.start === undefined || f.end === undefined) return "field_unwritable";
    const start = timeJson(f.start);
    const end = timeJson(f.end);
    if (start === null || end === null || (f.start.kind === "date") !== (f.end.kind === "date"))
      return "field_unwritable";
    body.start = start;
    body.end = end;
    body.isAllDay = f.start.kind === "date";
  }
  if (f.busy !== undefined) body.showAs = f.busy ? "busy" : "free";
  if (f.private !== undefined) body.sensitivity = f.private ? "private" : "normal";
  if (f.attendees !== undefined) {
    body.attendees = f.attendees.map((p) => ({
      emailAddress: { address: p.email, ...(p.name === null ? {} : { name: p.name }) },
      type: p.optional ? "optional" : "required",
    }));
  }
  if (f.alarms !== undefined) {
    body.isReminderOn = f.alarms.length > 0;
    if (f.alarms.length > 0) body.reminderMinutesBeforeStart = f.alarms[0];
  }
  return body;
}

/** A transactionId from the write's key: the same name on every attempt. */
function transactionOf(key: WriteKey): string | null {
  const h = key.hex;
  return /^[0-9a-f]{32}$/.test(h)
    ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
    : null;
}

export function makeWriter(deps: MicrosoftDeps): CalendarWriter {
  const base = graphBaseOf(deps.graphBase);

  function refusalOf(res: HttpResponse, gone: ProviderRefusal | WriteRefusal): Refusal {
    const wait = retryAfterMs(res, deps.clock);
    if (res.status >= 300 && res.status < 400) return refused("redirect_invalid");
    if (res.status === 401) return refused("sign_in_refused");
    if (res.status === 403) return refused("read_only");
    if (res.status === 404 || res.status === 410) return refused(gone);
    if (res.status === 400) return refused("field_unwritable");
    if (res.status === 429 || res.status === 509 || (res.status === 503 && wait !== null))
      return refused("throttled", wait);
    if (res.status >= 500) return refused("unavailable", wait);
    return refused("unknown");
  }

  async function send(
    token: string,
    method: HttpMethod,
    url: string,
    body: Json | null,
    signal: AbortSignal,
    precondition?: Precondition,
  ): Promise<HttpResponse | Refusal> {
    const answer = await deps.http.request(url, {
      method,
      headers:
        body === null
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      body: body === null ? null : JSON.stringify(body),
      auth: graphAuthorization(token, base),
      validators: null,
      ...(precondition === undefined ? {} : { precondition }),
      signal,
    });
    return answer.arrived ? answer : refused(answer.reason);
  }

  /** The event as the reader converts it, and Graph's raw record beside it. */
  function itemOf(res: HttpResponse): { readonly item: ChangeItem | null; readonly raw: Json } | null {
    const raw = jsonOf(res.body);
    if (raw === null) return null;
    const one = recordOf(raw, deps.zones, deps.clock.now());
    return { item: one.kind === "item" ? one.item : null, raw };
  }

  const eventUrl = (id: string): string => `${base.href}/me/events/${id}`;

  async function read(token: string, id: string, signal: AbortSignal): Promise<HttpResponse | Refusal> {
    return send(token, "GET", eventUrl(id), null, signal);
  }

  async function readMaster(
    token: string,
    id: string,
    target: WriteTarget,
    signal: AbortSignal,
    exceptions = false,
    checkAudience = true,
  ): Promise<Master | Refusal> {
    const url = new URL(eventUrl(id));
    if (exceptions) {
      url.searchParams.set("$select", masterFields);
      url.searchParams.set("$expand", "exceptionOccurrences");
    }
    const res = await send(token, "GET", url.href, null, signal);
    if ("ok" in res) return res;
    if (res.status !== 200) return refusalOf(res, "event_gone");
    const raw = jsonOf(res.body);
    if (raw === null) return refused("unreadable");
    const master = seriesOfRecord(raw, deps.zones, deps.clock.now());
    if (typeof master === "string" || master.item.id !== target.id) return refused("version_stale");
    const audience = checkAudience
      ? audienceOf(target, master.item, raw)
      : raw.isOrganizer === true
        ? null
        : refused("read_only");
    if (audience !== null) return audience;
    const pre = preconditionOf(raw, res.header("etag"));
    return pre === null ? refused("version_unknown") : { ...master, raw, pre };
  }

  async function cancelChangedSeries(
    token: string,
    id: string,
    target: WriteTarget,
    signal: AbortSignal,
  ): Promise<WriteAnswer> {
    const reviewed = target.seriesCancellation!;
    const master = await readMaster(token, id, target, signal, true, false);
    if ("ok" in master)
      return master.reason === "event_gone" ? answered([{ kind: "gone", id: target.id }]) : master;
    const listsMatch = (held: Master) => {
      const live = held.raw.exceptionOccurrences;
      return (
        held.item.version === target.version &&
        Array.isArray(live) &&
        !held.raw[["exceptionOccurrences", "odata.nextLink"].join("@")] &&
        live.length === reviewed.overrides.length &&
        reviewed.overrides.every(
          (entry) =>
            live.filter(
              (day) =>
                isRecord(day) &&
                day.id === entry.id &&
                (day["@odata.etag"] === entry.version || day.changeKey === entry.version),
            ).length === 1,
        )
      );
    };
    if (!listsMatch(master)) return refused("version_stale");
    const items = [master.item];
    for (const entry of reviewed.overrides) {
      const key = segment(entry.id);
      if (!key) return refused("version_stale");
      const response = await read(token, key, signal);
      if ("ok" in response) return response;
      const raw = jsonOf(response.body);
      const day = recordOf(raw, deps.zones, deps.clock.now());
      if (
        response.status !== 200 ||
        day.kind !== "day" ||
        !day.changed ||
        day.seriesId !== target.id ||
        day.id !== entry.id ||
        day.raw.isOrganizer !== true
      )
        return refused("version_stale");
      const found = dayOfSeries(day, master.series, deps.zones, deps.clock.now())?.item;
      if (
        !found ||
        typeof found === "string" ||
        (found.version !== entry.version && day.raw.changeKey !== entry.version)
      )
        return refused("version_stale");
      items.push(found);
    }
    if (!sameCancellationAudience(target.audience, items)) return refused("version_stale");
    const current = await readMaster(token, id, target, signal, true, false);
    if ("ok" in current) return current;
    if (!listsMatch(current)) return refused("version_stale");
    const sent = await send(
      token,
      "POST",
      `${eventUrl(id)}/cancel`,
      { comment: reviewed.message },
      signal,
      current.pre,
    );
    if ("ok" in sent) return sent;
    if (sent.status === 202 || sent.status === 200 || sent.status === 204)
      return wrote([{ kind: "gone", id: target.id }]);
    return sent.status === 412 ? refused("version_stale") : refusalOf(sent, "event_gone");
  }

  const keyOf = (time: EventTime): string => recurrenceKeyString(recurrenceKeyOf(time, deps.zones));

  function instanceOf(
    raw: unknown,
    target: WriteTarget,
    series: SeriesClock,
    subset = false,
    answering: boolean | "applied" = false,
  ): Instance | Refusal | null {
    const record = recordOf(raw, deps.zones, deps.clock.now());
    if (record.kind !== "day" || record.seriesId !== target.id || target.occurrence === null) return null;
    const day = dayOfSeries({ ...record, changed: true }, series, deps.zones, deps.clock.now());
    if (day === null || keyOf(day.seen.originalStart) !== keyOf(target.occurrence)) return null;
    if (day.item === null || typeof day.item === "string") return refused("unreadable");
    const audience = answering
      ? record.raw.isOrganizer === false &&
        (answering === "applied" ||
          (target.exception
            ? record.changed &&
              record.id === target.exception.id &&
              (day.item.version === target.exception.version ||
                record.raw.changeKey === target.exception.version)
            : !record.changed))
        ? null
        : refused("version_stale")
      : subset
        ? day.item.audienceIncomplete ||
          !exceptionAudience({ exceptionOccurrences: [record.raw] }, target.audience)
          ? refused("version_stale")
          : null
        : audienceOf(target, day.item, record.raw);
    if (audience !== null) return audience;
    const pre = preconditionOf(record.raw);
    return pre === null
      ? refused("version_unknown")
      : { item: day.item, raw: record.raw, isException: record.changed, pre };
  }

  async function uniqueMatch<T extends object>(
    token: string,
    first: string,
    match: (raw: unknown) => T | Refusal | null,
    signal: AbortSignal,
  ): Promise<T | Refusal> {
    let url = first;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES_PER_CALL; page++) {
      seen.add(url);
      const res = await send(token, "GET", url, null, signal);
      if ("ok" in res) return res;
      if (res.status !== 200) return refusalOf(res, "event_gone");
      const answer = jsonOf(res.body);
      if (!Array.isArray(answer?.value)) return refused("unreadable");
      let selected: T | null = null;
      for (const raw of answer.value) {
        const hit = match(raw);
        if (hit === null) continue;
        if ("ok" in hit) return hit as Refusal;
        if (selected !== null) return refused("version_stale");
        selected = hit;
      }
      if (selected !== null) return selected;
      const next = answer["@odata.nextLink"];
      if (next === undefined || next === null) return refused("version_stale");
      if (typeof next !== "string" || !insideBase(next, base) || seen.has(next))
        return refused("page_link_refused");
      url = next;
    }
    return refused("page_link_refused");
  }

  function readInstance(
    token: string,
    id: string,
    target: WriteTarget,
    series: SeriesClock,
    signal: AbortSignal,
    answering: boolean | "applied" = false,
  ): Promise<Instance | Refusal> {
    const at = target.occurrence === null ? NaN : momentOrUtc(target.occurrence, deps.zones);
    if (!Number.isFinite(at)) return Promise.resolve(refused("version_stale"));
    const url = new URL(`${eventUrl(id)}/instances`);
    // Include nearby UTC times for all-day events whose original start is midnight on their own clock.
    url.searchParams.set("startDateTime", stamp(at - MS_PER_DAY));
    url.searchParams.set("endDateTime", stamp(at + 2 * MS_PER_DAY));
    return uniqueMatch(token, url.href, (raw) => instanceOf(raw, target, series, false, answering), signal);
  }

  async function readException(
    token: string,
    target: WriteTarget,
    master: Master,
    signal: AbortSignal,
    subset = false,
  ): Promise<Instance | Refusal> {
    const exception = target.exception;
    const id = exception && segment(exception.id);
    if (
      !exception ||
      !id ||
      (target.occurrence !== null && keyOf(target.occurrence) !== keyOf(exception.occurrence))
    )
      return refused("version_stale");
    const res = await read(token, id, signal);
    if ("ok" in res) return res;
    if (res.status !== 200) return refusalOf(res, "event_gone");
    const selected = { ...target, occurrence: exception.occurrence };
    const day = instanceOf(jsonOf(res.body), selected, master.series, subset);
    if (day !== null && "ok" in day) return day;
    return day?.isException && day.item.id === exception.id && day.item.event.status !== "CANCELLED"
      ? day
      : refused("version_stale");
  }

  function matchesException(day: Instance, target: WriteTarget): boolean {
    const version = target.exception?.version;
    return version !== undefined && (day.item.version === version || day.raw.changeKey === version);
  }

  function selectedStillListed(master: Master, day: Instance): boolean {
    const { exceptionOccurrences } = master.raw;
    if (!Array.isArray(exceptionOccurrences)) return false;
    const listed = exceptionOccurrences.filter((raw: unknown) => isRecord(raw) && raw.id === day.item.id);
    if (listed.length !== 1) return false;
    const [raw] = listed;
    return (
      raw["@odata.etag"] === day.pre.tag ||
      (typeof day.raw.changeKey === "string" && raw.changeKey === day.raw.changeKey)
    );
  }

  function splitCanReplace(master: Master, target: WriteTarget): boolean {
    const { exception } = target;
    if (!exception) return !hasSeriesChanges(master);
    const { cancelledOccurrences: cancelled, exceptionOccurrences: exceptions } = master.raw;
    if (
      !Array.isArray(cancelled) ||
      cancelled.length ||
      !Array.isArray(exceptions) ||
      exceptions.length !== 1 ||
      master.raw["exceptionOccurrences@odata.nextLink"] !== undefined
    )
      return false;
    const raw = exceptions[0];
    const selected = { ...target, occurrence: exception.occurrence };
    const day = instanceOf(raw, selected, master.series, true);
    return (
      day !== null &&
      !("ok" in day) &&
      day.item.id === exception.id &&
      day.isException &&
      matchesException(day, target)
    );
  }

  function splitDate(master: Master, target: WriteTarget): string | null {
    if (target.occurrence === null) return null;
    const at = momentOrUtc(target.occurrence, deps.zones);
    if (!Number.isFinite(at)) return null;
    const local =
      master.series.wholeDays || master.series.zone === null
        ? dateOfTime(instant(at))
        : wallIn(at, master.series.zone, deps.zones);
    return local === null ? null : priorDate(local);
  }

  function hasSeriesChanges(master: Master): boolean {
    const { cancelledOccurrences: cancelled, exceptionOccurrences: exceptions } = master.raw;
    return (
      !Array.isArray(cancelled) ||
      !Array.isArray(exceptions) ||
      cancelled.length > 0 ||
      exceptions.length > 0 ||
      master.raw["exceptionOccurrences@odata.nextLink"] !== undefined
    );
  }

  /** A title or guest override leaves the old schedule in place. Require every day as originally generated. */
  function exceptionsKeepSchedule(master: Master): boolean {
    const { cancelledOccurrences: cancelled, exceptionOccurrences: exceptions } = master.raw;
    if (
      !Array.isArray(cancelled) ||
      cancelled.length > 0 ||
      !Array.isArray(exceptions) ||
      exceptions.length > MAX_PAGE_LIMIT ||
      master.raw["exceptionOccurrences@odata.nextLink"] !== undefined
    )
      return false;
    const [series] = seriesOf([master.item.event], deps.zones);
    if (series === undefined) return false;
    return exceptions.every((raw) => {
      if (!isRecord(raw) || raw.isCancelled !== false) return false;
      const exception = recordOf(raw, deps.zones, deps.clock.now());
      if (exception.kind !== "day" || !exception.changed || exception.seriesId !== master.item.id)
        return false;
      const day = dayOfSeries(exception, master.series, deps.zones, deps.clock.now());
      if (day?.item == null || typeof day.item === "string") return false;
      const { start, end, status } = day.item.event;
      if (start === null || end === null || status === "CANCELLED") return false;
      const at = momentOrUtc(day.seen.originalStart, deps.zones);
      const found = expandSeries(
        series,
        { startMs: at - 1, endMs: at + 1, viewerZone: "Etc/UTC" },
        deps.zones,
      );
      const key = keyOf(day.seen.originalStart);
      return (
        !found.capped &&
        found.occurrences.some(
          (expected) =>
            recurrenceKeyString(expected.key) === key &&
            sameTime(expected.start, start) &&
            sameTime(expected.end, end),
        )
      );
    });
  }

  function continuationBody(
    master: Master,
    target: WriteTarget,
    after: SeriesContinuation,
  ): { readonly body: Json } | Refusal {
    if (
      master.raw.hasAttachments === true ||
      master.raw.isOnlineMeeting === true ||
      master.item.event.url !== null
    )
      return refused("field_unwritable");
    const recurrence = recurrenceFor(after.rule, after.start, deps.zones);
    if (recurrence === null) return refused("repeat_unsupported");
    const fields = after.event?.attendees;
    if (fields !== undefined) {
      const guests = target.audience?.guests ?? [];
      const wanted = new Set(fields.map(({ email }) => email.toLowerCase()));
      if (
        wanted.size !== fields.length ||
        wanted.size !== guests.length ||
        !guests.every((guest) => wanted.has(guest))
      )
        return refused("version_stale");
    }
    const { rule: _rule, attendees: _attendees, organizer: _organizer, ...named } = after.change;
    const change = bodyOf({ ...named, start: after.start, end: after.end });
    if (typeof change === "string") return refused(change);
    // Keep the provider's unchanged fields, including rich notes and resource attendee types.
    const body: Json = {};
    for (const field of carriedFields) {
      if (master.raw[field] !== undefined && master.raw[field] !== null) body[field] = master.raw[field];
    }
    if (after.change.location !== undefined) delete body.locations;
    body.attendees = Array.isArray(master.raw.attendees)
      ? master.raw.attendees
          .filter(
            (attendee) =>
              isRecord(attendee) &&
              isRecord(attendee.emailAddress) &&
              addressOf(attendee.emailAddress.address) !== target.audience?.organizer,
          )
          .map(({ emailAddress, type }) => ({ emailAddress, type }))
      : [];
    return { body: { ...body, ...change, recurrence } };
  }

  function continuationOf(raw: Json, target: WriteTarget, after: SeriesContinuation): Upsert | Refusal {
    const record = recordOf(raw, deps.zones, deps.clock.now());
    if (
      record.kind !== "item" ||
      record.item.kind !== "upsert" ||
      raw.type !== "seriesMaster" ||
      record.item.id === target.id
    )
      return refused("version_stale");
    const audience = audienceOf(target, record.item, raw);
    if (audience !== null) return audience;
    const recurrence = recurrenceFor(after.rule, after.start, deps.zones);
    const wanted = ruleOfRecurrence(recurrence);
    const range = isRecord(recurrence?.range) ? recurrence.range : null;
    const actual = recurrenceOf(raw)?.range;
    const { alarms, attendees: _attendees, organizer: _organizer, ...change } = after.change;
    const event = after.event;
    const carried =
      event === undefined
        ? {}
        : {
            summary: event.summary,
            description: event.description,
            location: event.location,
            private: event.private,
            busy: event.busy,
          };
    const matchesAlarm =
      alarms === undefined ||
      (alarms.length === 0
        ? raw.isReminderOn !== true
        : alarms.length === 1 && raw.isReminderOn === true && raw.reminderMinutesBeforeStart === alarms[0]);
    return wanted !== null &&
      range !== null &&
      actual !== undefined &&
      matchesAlarm &&
      range.startDate === actual.startDate &&
      range.recurrenceTimeZone === actual.recurrenceTimeZone &&
      alreadyHolds(
        { ...carried, ...change, start: after.start, end: after.end, rule: wanted },
        record.item.event,
        deps.zones,
      )
      ? record.item
      : refused("version_stale");
  }

  async function recoverContinuation(
    token: string,
    calendar: string,
    target: WriteTarget,
    after: SeriesContinuation,
    signal: AbortSignal,
  ): Promise<Upsert | Refusal> {
    const transactionId = transactionOf(after.key);
    if (transactionId === null) return refused("not_found");
    // Compare Graph's returned transactionId without repeating a create.
    const url = new URL(`${base.href}/me/calendars/${calendar}/events`);
    url.searchParams.set("$select", continuationFields);
    url.searchParams.set("$orderby", "createdDateTime desc");
    url.searchParams.set("$top", String(MAX_PAGE_LIMIT));
    return uniqueMatch(
      token,
      url.href,
      (raw) =>
        isRecord(raw) && raw.transactionId === transactionId ? continuationOf(raw, target, after) : null,
      signal,
    );
  }

  async function postContinuation(
    token: string,
    calendar: string,
    target: WriteTarget,
    after: SeriesContinuation,
    body: Json,
    signal: AbortSignal,
  ) {
    const transactionId = transactionOf(after.key);
    if (transactionId === null) return refused("not_found");
    const res = await send(
      token,
      "POST",
      `${base.href}/me/calendars/${calendar}/events`,
      { ...body, transactionId },
      signal,
    );
    if ("ok" in res) return res;
    if (res.status !== 201 && res.status !== 200) return refusalOf(res, "not_found");
    const raw = jsonOf(res.body);
    if (raw === null || raw.transactionId !== transactionId) return refused("unavailable");
    const item = continuationOf(raw, target, after);
    if ("ok" in item) return item;
    const id = segment(item.id);
    const pre = preconditionOf(raw, res.header("etag"));
    return id === null || pre === null
      ? refused("unavailable")
      : { id, pre, item, created: res.status === 201 };
  }

  function recoveredRollbackTag(live: Master, body: Json): MatchTag | null {
    const { raw } = live;
    if (
      raw.isOrganizer !== true ||
      raw.hasAttachments === true ||
      raw.isOnlineMeeting === true ||
      live.item.event.url !== null ||
      live.item.event.attendees.some(
        (attendee) => attendee.partstat !== null && attendee.partstat !== "NEEDS-ACTION",
      )
    )
      return null;
    const { start, end, recurrence, isAllDay, attendees } = body;
    if (
      !isRecord(start) ||
      !isRecord(end) ||
      start.timeZone !== raw.originalStartTimeZone ||
      end.timeZone !== raw.originalEndTimeZone ||
      isAllDay !== raw.isAllDay ||
      !submittedValuesMatch(recurrence, raw.recurrence) ||
      !submittedValuesMatch(attendees, raw.attendees) ||
      carriedFields.some((field) => !submittedValuesMatch(body[field], raw[field], true))
    )
      return null;
    return live.pre;
  }

  async function readLiveContinuation(
    token: string,
    id: string,
    providerId: string,
    target: WriteTarget,
    after: SeriesContinuation,
    signal: AbortSignal,
  ): Promise<Master | Refusal> {
    const live = await readMaster(token, id, { ...target, id: providerId }, signal, true);
    if ("ok" in live) return live.reason === "event_gone" ? refused("version_stale") : live;
    if (live.raw.transactionId !== transactionOf(after.key)) return refused("version_stale");
    const item = continuationOf(live.raw, target, after);
    return "ok" in item ? item : live;
  }

  async function rollBack(
    token: string,
    id: string,
    pre: MatchTag,
    after: SeriesContinuation,
    signal: AbortSignal,
  ): Promise<Refusal | null> {
    const result = await send(token, "DELETE", eventUrl(id), null, signal, pre);
    if ("ok" in result) {
      if (
        ["timeout", "connection_failed", "host_unresolved", "throttled", "unavailable", "unknown"].includes(
          result.reason,
        )
      )
        return result;
      if (result.reason === "unreadable" || result.reason === "too_large") return refused("unavailable");
      return null;
    }
    if (result.status >= 200 && result.status < 300) return rememberCreation(after, null);
    if (result.status === 408) return refused("timeout");
    if (result.status === 429 || result.status >= 500) return refusalOf(result, "event_gone");
    return null;
  }

  async function rememberCreation(after: SeriesContinuation, tag: string | null): Promise<Refusal | null> {
    try {
      await after.rememberCreatedVersion?.(tag);
      return null;
    } catch {
      return refused("unknown");
    }
  }

  async function retireSplitException(
    token: string,
    target: WriteTarget,
    after: SeriesContinuation,
    split: {
      readonly source: Master;
      readonly shortened: Upsert;
      readonly continuation: Upsert;
      readonly creationTag: string | undefined;
      readonly last: string;
      readonly late?: boolean;
    },
    signal: AbortSignal,
  ): Promise<readonly ChangeItem[] | Refusal> {
    const { exception } = target;
    if (!exception) return [split.shortened];
    const found = await readException(token, target, split.source, signal, true);
    const gone = { kind: "gone", id: exception.id } as const;
    if ("ok" in found) return found.reason === "event_gone" ? [split.shortened, gone] : found;
    if (split.late) return refused("version_stale");
    const child = segment(found.item.id);
    const oldId = segment(split.shortened.id);
    const newId = segment(split.continuation.id);
    if (
      child === null ||
      oldId === null ||
      newId === null ||
      split.creationTag === undefined ||
      !matchesException(found, target)
    )
      return refused("version_stale");

    // Graph normally removes the exception when it trims the recurrence. If it survives,
    // verify both sides of the split again and retire only the exact reviewed exception.
    const continuation = await readLiveContinuation(
      token,
      newId,
      split.continuation.id,
      target,
      after,
      signal,
    );
    if ("ok" in continuation) return continuation;
    if (continuation.pre.tag !== split.creationTag || hasSeriesChanges(continuation))
      return refused("version_stale");
    const original = await readMaster(token, oldId, target, signal);
    if ("ok" in original) return original;
    if (
      !holdsEnd(original.raw, split.last) ||
      (original.item.version !== split.shortened.version &&
        original.raw.changeKey !== split.shortened.version)
    )
      return refused("version_stale");
    const result = await send(token, "DELETE", eventUrl(child), null, signal, found.pre);
    if ("ok" in result) return result;
    if (result.status === 404 || result.status === 410 || (result.status >= 200 && result.status < 300))
      return [split.shortened, gone];
    return result.status === 412 ? refused("version_stale") : refusalOf(result, "event_gone");
  }

  function notesUnwritable(raw: Json, change: EventChange): boolean {
    return (
      change.description !== undefined &&
      isRecord(raw.body) &&
      String(raw.body.contentType).toLowerCase() === "html"
    );
  }

  function holdsEnd(raw: Json, last: string): boolean {
    const range = recurrenceOf(raw)?.range;
    return range?.type === "endDate" && range.endDate === last;
  }

  /** The old copy still covers every following day at its original time. */
  async function canRollBack(
    token: string,
    id: string,
    target: WriteTarget,
    before: Master,
    exact: boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    const current = await readMaster(token, id, target, signal, true);
    if ("ok" in current || !splitCanReplace(current, target)) return false;
    if (exact && (current.pre.tag !== before.pre.tag || current.raw.changeKey !== before.raw.changeKey))
      return false;
    return originalScheduleMatches(before, current);
  }

  function originalScheduleMatches(before: Master, current: Master): boolean {
    const original = before.item.event;
    const { start, end } = current.item.event;
    const rule = original.rules[0]?.rule;
    const oldRange = recurrenceOf(before.raw)?.range;
    const liveRange = recurrenceOf(current.raw)?.range;
    return (
      original.start !== null &&
      original.end !== null &&
      start !== null &&
      end !== null &&
      rule != null &&
      oldRange !== undefined &&
      liveRange !== undefined &&
      oldRange.startDate === liveRange.startDate &&
      oldRange.recurrenceTimeZone === liveRange.recurrenceTimeZone &&
      sameTime(original.start, start) &&
      sameTime(original.end, end) &&
      alreadyHolds({ rule }, current.item.event, deps.zones)
    );
  }

  function lateSourceMatches(before: Master, current: Master): boolean {
    return (
      current.pre.tag === before.pre.tag &&
      current.raw.changeKey === before.raw.changeKey &&
      originalScheduleMatches(before, current) &&
      exceptionsKeepSchedule(current)
    );
  }

  async function patchOccurrence(
    token: string,
    target: WriteTarget,
    master: Master,
    day: Instance,
    change: EventChange,
    body: Json,
    signal: AbortSignal,
    subset = false,
  ): Promise<WriteAnswer> {
    if (notesUnwritable(day.raw, change)) return refused("field_unwritable");
    const id = segment(day.item.id);
    if (id === null) return refused("unreadable");
    const res = await send(token, "PATCH", eventUrl(id), body, signal, day.pre);
    if ("ok" in res) return res;
    if (res.status === 412) return refused("version_stale");
    if (res.status !== 200) return refusalOf(res, "event_gone");
    const saved = instanceOf(jsonOf(res.body), target, master.series, subset);
    return saved !== null && !("ok" in saved) && saved.item.id === day.item.id
      ? wrote([saved.item])
      : refused("unavailable");
  }

  function resizeException(master: Master, day: Instance, end: EventTime): number | null {
    const from = master.item.event.end;
    const held = day.item.event;
    if (from === null || held.start === null || held.end === null) return null;
    const delta = momentOrUtc(end, deps.zones) - momentOrUtc(from, deps.zones);
    const adjusted = momentOrUtc(held.end, deps.zones) + delta;
    return adjusted > momentOrUtc(held.start, deps.zones) ? adjusted : null;
  }

  function exceptionPatch(day: Instance, change: EventChange, body: Json, endMs: number | undefined) {
    if (change.end === undefined) return endMs === undefined ? { change, body } : null;
    const { start, end } = day.item.event;
    if (start === null || end === null || endMs === undefined || endMs <= momentOrUtc(start, deps.zones))
      return null;
    const resized = clockOf(end, endMs, deps.zones);
    const value = resized === null ? null : timeJson(resized);
    if (resized === null || value === null) return null;
    const { start: _changeStart, ...fields } = change;
    const { start: _bodyStart, isAllDay: _allDay, ...providerFields } = body;
    return { change: { ...fields, end: resized }, body: { ...providerFields, end: value } };
  }

  function masterReceiptMatches(
    master: Master,
    target: WriteTarget,
    change: EventChange,
    version: string,
  ): boolean {
    return (
      master.pre.tag === version &&
      exceptionAudience(master.raw, target.audience) &&
      alreadyHolds(change, master.item.event, deps.zones)
    );
  }

  async function finishMasterException(
    token: string,
    id: string,
    target: WriteTarget,
    master: Master,
    change: EventChange,
    body: Json,
    receipt: NonNullable<WriteTarget["masterReceipt"]>,
    signal: AbortSignal,
    first?: Upsert,
  ): Promise<WriteAnswer> {
    const exception = target.exception;
    if (!exception || (first === undefined && !masterReceiptMatches(master, target, change, receipt.version)))
      return refused("version_stale");

    // Graph may already have propagated the master change. A read is enough when it has.
    const done = first ? wrote : answered;
    const day = await readException(token, target, master, signal, true);
    if ("ok" in day) return day;
    const patch = exceptionPatch(day, change, body, receipt.exceptionEndMs);
    if (patch === null) return refused("version_stale");
    if (alreadyHolds(patch.change, day.item.event, deps.zones)) return done([first ?? master.item, day.item]);
    if (!matchesException(day, target) && receipt.exceptionSnapshot !== exceptionSnapshotOf(day, patch.body))
      return refused("version_stale");

    const current = await readMaster(token, id, target, signal, true);
    if ("ok" in current) return current;
    if (!masterReceiptMatches(current, target, change, receipt.version) || !selectedStillListed(current, day))
      return refused("version_stale");
    const selected = { ...target, occurrence: exception.occurrence };
    const saved = await patchOccurrence(token, selected, master, day, patch.change, patch.body, signal, true);
    return saved.ok ? done([current.item, ...saved.items]) : saved;
  }

  async function changeMaster(
    token: string,
    id: string,
    target: WriteTarget,
    master: Master,
    change: EventChange,
    body: Json,
    signal: AbortSignal,
  ): Promise<WriteAnswer> {
    if (!exceptionAudience(master.raw, target.audience)) return refused("version_stale");
    const priorStart = master.item.event.start;
    const reschedules =
      change.start !== undefined && (priorStart === null || !sameTime(priorStart, change.start));
    const reshapes = change.rule !== undefined || reschedules;
    if (reshapes && hasSeriesChanges(master)) return refused("repeat_unsupported");
    if (notesUnwritable(master.raw, change)) return refused("field_unwritable");
    let exceptionEndMs: number | undefined;
    let exceptionSnapshot: string | undefined;
    if (target.exception) {
      const selected = await readException(token, target, master, signal, true);
      if ("ok" in selected) return selected;
      if (!matchesException(selected, target)) return refused("version_stale");
      if (notesUnwritable(selected.raw, change)) return refused("field_unwritable");
      if (change.end !== undefined) {
        const resized = resizeException(master, selected, change.end);
        if (resized === null || exceptionPatch(selected, change, body, resized) === null)
          return refused("field_unwritable");
        exceptionEndMs = resized;
        delete body.start;
        delete body.isAllDay;
      }
      exceptionSnapshot = exceptionSnapshotOf(selected, body);
      const current = await readMaster(token, id, target, signal, true);
      if ("ok" in current) return current;
      if (
        current.pre.tag !== master.pre.tag ||
        current.raw.changeKey !== master.raw.changeKey ||
        !selectedStillListed(current, selected) ||
        !exceptionAudience(current.raw, target.audience)
      )
        return refused("version_stale");
    }
    const rule = change.rule === undefined ? master.item.event.rules[0]?.rule : change.rule;
    if (rule === null) body.recurrence = null;
    else if (reshapes) {
      const start = change.start ?? master.item.event.start;
      const next = rule && start !== null && recurrenceFor(rule, start, deps.zones);
      if (!next) return refused("repeat_unsupported");
      body.recurrence = next;
    }
    const res = await send(token, "PATCH", eventUrl(id), body, signal, master.pre);
    if ("ok" in res) return res;
    if (res.status === 412) return refused("version_stale");
    if (res.status !== 200) return refusalOf(res, "event_gone");
    const saved = itemOf(res);
    if (saved?.item?.kind !== "upsert" || saved.item.id !== target.id) return refused("unavailable");
    if (!target.exception) return wrote([saved.item]);

    const pre = preconditionOf(saved.raw, res.header("etag"));
    if (pre === null || !alreadyHolds(change, saved.item.event, deps.zones)) return refused("version_stale");
    const receipt = {
      version: pre.tag,
      ...(exceptionEndMs !== undefined && { exceptionEndMs }),
      ...(exceptionSnapshot !== undefined && { exceptionSnapshot }),
    };
    try {
      await target.rememberMasterReceipt?.(receipt);
    } catch {
      return refused("unknown");
    }
    return finishMasterException(token, id, target, master, change, body, receipt, signal, saved.item);
  }

  async function changeRecurring(
    token: string,
    id: string,
    target: WriteTarget,
    change: EventChange,
    body: Json,
    signal: AbortSignal,
  ): Promise<WriteAnswer> {
    if (!onlyConfirmedGuests(target.audience, change)) return refused("version_stale");
    const whole = target.occurrence === null;
    const checkMasterAudience = whole || target.exception === undefined;
    const master = await readMaster(token, id, target, signal, whole, checkMasterAudience);
    if ("ok" in master) return master;
    if (whole && target.masterReceipt)
      return finishMasterException(token, id, target, master, change, body, target.masterReceipt, signal);
    const masterMatches = master.item.version === target.version || master.raw.changeKey === target.version;
    if (!masterMatches && whole) return refused("version_stale");
    if (whole) return changeMaster(token, id, target, master, change, body, signal);
    if (change.rule !== undefined) return refused("repeat_unsupported");
    const day = target.exception
      ? await readException(token, target, master, signal)
      : await readInstance(token, id, target, master.series, signal);
    if ("ok" in day) return day;
    const reviewed = target.exception ? matchesException(day, target) : !day.isException;
    if (!masterMatches || !reviewed) {
      // The exact same child may already hold the requested change after an unanswered write.
      return day.isException && alreadyHolds(change, day.item.event, deps.zones)
        ? answered([day.item])
        : refused("version_stale");
    }
    const current = await readMaster(token, id, target, signal, false, checkMasterAudience);
    if ("ok" in current) return current;
    if (current.item.version !== master.item.version) return refused("version_stale");
    return patchOccurrence(token, target, master, day, change, body, signal);
  }

  /** Where a write's version is no tag, or a change touches notes: the event read once, compared, and its tag. */
  async function standing(
    token: string,
    id: string,
    target: WriteTarget,
    notes: boolean,
    signal: AbortSignal,
  ): Promise<Precondition | Refusal> {
    if (!target.sharedCopy && !target.audience && sendableTag(target.version) && !notes)
      return { kind: "unchanged", tag: target.version };
    const now = await read(token, id, signal);
    if ("ok" in now) return now;
    if (now.status !== 200) return refusalOf(now, "event_gone");
    const held = itemOf(now);
    if (held === null || held.item === null || held.item.kind !== "upsert") return refused("version_unknown");
    if (held.item.version !== target.version) return refused("version_stale");
    if (
      target.sharedCopy &&
      (held.item.audienceIncomplete ||
        held.raw.type !== "singleInstance" ||
        !Array.isArray(held.raw.attendees) ||
        held.raw.attendees.length)
    )
      return refused("read_only");
    if (target.audience) {
      if (held.item.audienceIncomplete || !sameAudience(target.audience, held.item.event))
        return refused("version_stale");
    }
    if (notes && isRecord(held.raw.body) && String(held.raw.body.contentType).toLowerCase() === "html")
      return refused("field_unwritable");
    const tag = typeof held.raw["@odata.etag"] === "string" ? held.raw["@odata.etag"] : "";
    return sendableTag(tag) ? { kind: "unchanged", tag } : refused("version_unknown");
  }

  async function afterStale(
    token: string,
    id: string,
    targetId: string,
    change: EventChange | null,
    signal: AbortSignal,
  ): Promise<WriteAnswer> {
    const now = await read(token, id, signal);
    if ("ok" in now) return now;
    if (now.status === 404 || now.status === 410)
      return change === null ? answered([{ kind: "gone", id: targetId }]) : refused("event_gone");
    if (now.status !== 200 || change === null) return refused("version_stale");
    const held = itemOf(now);
    return held !== null &&
      held.item !== null &&
      held.item.kind === "upsert" &&
      alreadyHolds(change, held.item.event, deps.zones)
      ? answered([held.item])
      : refused("version_stale");
  }

  function findCopy(token: string, calendar: string, transactionId: string, signal: AbortSignal) {
    const url = new URL(`${base.href}/me/calendars/${calendar}/events`);
    url.searchParams.set("$select", continuationFields);
    url.searchParams.set("$orderby", "createdDateTime desc");
    url.searchParams.set("$top", String(MAX_PAGE_LIMIT));
    return uniqueMatch(
      token,
      url.href,
      (raw) => {
        if (!isRecord(raw) || raw.transactionId !== transactionId) return null;
        const record = recordOf(raw, deps.zones, deps.clock.now());
        return record.kind === "item" && record.item.kind === "upsert" ? record.item : refused("unreadable");
      },
      signal,
    );
  }

  return {
    provider: "microsoft",

    async findMoveCopy(c, cal, key, signal) {
      const calendar = segment(cal.id);
      const transactionId = transactionOf(key);
      if (calendar === null || transactionId === null) return refused("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const found = await findCopy(signedIn.token, calendar, transactionId, signal);
      return "ok" in found ? found : answered([found]);
    },

    async readForMove(c, cal, id, signal) {
      const calendar = segment(cal.id);
      const event = segment(id);
      if (!calendar || !event) return refused("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const response = await send(
        signedIn.token,
        "GET",
        `${base.href}/me/calendars/${calendar}/events/${event}?$expand=extensions,attachments($select=id)`,
        null,
        signal,
      );
      if ("ok" in response) return response;
      if (response.status === 404 || response.status === 410) return answered([{ kind: "gone", id }]);
      if (response.status !== 200) return refusalOf(response, "event_gone");
      const held = itemOf(response);
      if (held?.item?.kind !== "upsert" || held.item.id !== id) return refused("unreadable");
      return answered([{ ...held.item, ...(portableMicrosoft(held.raw) && { portableCopy: true }) }]);
    },

    async create(
      c: Connection,
      cal: CalendarRef,
      req: { readonly key: WriteKey; readonly event: EventDraft; readonly recover?: boolean },
      signal: AbortSignal,
    ): Promise<WriteAnswer> {
      const calendar = segment(cal.id);
      const transactionId = transactionOf(req.key);
      if (calendar === null || transactionId === null) return refused("not_found");
      const { rule, ...fields } = req.event;
      const recurrence = rule === null ? null : recurrenceFor(rule, fields.start, deps.zones);
      if (rule !== null && recurrence === null) return refused("repeat_unsupported");
      const body = bodyOf(fields);
      if (typeof body === "string") return refused(body);
      if (recurrence !== null) body.recurrence = recurrence;
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      if (req.recover) {
        const found = await findCopy(signedIn.token, calendar, transactionId, signal);
        if (!("ok" in found)) return answered([found]);
        if (found.reason !== "version_stale") return found;
      }
      const res = await send(
        signedIn.token,
        "POST",
        `${base.href}/me/calendars/${calendar}/events`,
        { ...body, transactionId },
        signal,
      );
      if ("ok" in res) return res;
      if (res.status !== 201 && res.status !== 200) return refusalOf(res, "not_found");
      const held = itemOf(res);
      return held === null ? refused("unreadable") : wrote(held.item === null ? [] : [held.item]);
    },

    async change(c, _cal, target, change, signal) {
      if (target.sharedCopy && (target.recurringSeries || target.occurrence || !ordinarySharedChange(change)))
        return refused("read_only");
      if (!target.recurringSeries && target.occurrence !== null) return refused("repeat_unsupported");
      const id = segment(target.id);
      if (id === null) return refused("not_found");
      const { rule: _rule, ...fields } = change;
      const body = bodyOf(target.recurringSeries ? fields : change);
      if (typeof body === "string") return refused(body);
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      if (target.recurringSeries) return changeRecurring(signedIn.token, id, target, change, body, signal);
      const pre = await standing(signedIn.token, id, target, change.description !== undefined, signal);
      if ("ok" in pre) return pre;
      const res = await send(signedIn.token, "PATCH", eventUrl(id), body, signal, pre);
      if ("ok" in res) return res;
      if (res.status === 412) return afterStale(signedIn.token, id, target.id, change, signal);
      if (res.status !== 200) return refusalOf(res, "event_gone");
      const held = itemOf(res);
      return held === null ? refused("unreadable") : wrote(held.item === null ? [] : [held.item]);
    },

    async remove(c, _cal, target, signal) {
      // One day of a series is not written by this writer yet, and is never written as the series whole.
      if (target.occurrence !== null && !target.recurringSeries) return refused("repeat_unsupported");
      let id = segment(target.id);
      if (id === null) return refused("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      if (target.seriesCancellation && target.occurrence === null)
        return cancelChangedSeries(signedIn.token, id, target, signal);
      const master = target.recurringSeries
        ? await readMaster(signedIn.token, id, target, signal, true)
        : null;
      if (
        master &&
        !("ok" in master) &&
        (master.item.version !== target.version ||
          !Array.isArray(master.raw.exceptionOccurrences) ||
          master.raw.exceptionOccurrences.length > 0)
      )
        return refused("version_stale");
      let pre =
        master === null
          ? await standing(signedIn.token, id, target, false, signal)
          : "ok" in master
            ? master
            : master.pre;
      let result: ChangeItem = { kind: "gone", id: target.id };
      if (master && !("ok" in master) && target.occurrence !== null) {
        const day = await readInstance(signedIn.token, id, target, master.series, signal);
        if ("ok" in day) return day;
        const originalStart = day.item.event.recurrenceId;
        const uid = master.item.event.uid;
        id = segment(day.item.id);
        if (day.isException || !uid || !originalStart || !id) return refused("version_stale");
        pre = day.pre;
        result = { kind: "cancelled_occurrence", uid, originalStart };
      }
      if ("ok" in pre)
        return pre.reason === "event_gone" && target.occurrence === null ? answered([result]) : pre;
      const res = await send(signedIn.token, "DELETE", eventUrl(id), null, signal, pre);
      if ("ok" in res) return res;
      if (res.status === 204 || res.status === 200) return wrote([result]);
      if (res.status === 404 || res.status === 410) return answered([result]);
      if (res.status === 412 && target.occurrence !== null) return refused("version_stale");
      if (res.status === 412) return afterStale(signedIn.token, id, target.id, null, signal);
      return refusalOf(res, "event_gone");
    },

    async answer(
      c,
      _cal,
      target,
      req: { readonly as: string; readonly reply: WriteReply; readonly retry?: true },
      signal,
    ) {
      if (target.occurrence !== null && !target.recurringSeries) return refused("repeat_unsupported");
      const initialId = segment(target.id);
      if (initialId === null) return refused("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const { token } = signedIn;
      // Graph answers a series or a single instance at its own address.
      const now = await read(token, initialId, signal);
      if ("ok" in now) return now;
      if (now.status !== 200) return refusalOf(now, "event_gone");
      const wanted = { ACCEPTED: "accepted", TENTATIVE: "tentativelyAccepted", DECLINED: "declined" }[
        req.reply
      ];
      let held = itemOf(now);
      let version = target.version;
      let parseAfter = itemOf;
      if (target.occurrence !== null) {
        const raw = held?.raw;
        if (!raw || raw.isOrganizer !== false) return refused("read_only");
        // The series is not compared by its version: Exchange moves that on for what no day shows (an exception made
        // elsewhere, its own bookkeeping). What the answer is about is the day, and the day is held to what was shown:
        // still a plain day of this series at its first time, or the changed day the person saw (`target.exception`).
        const master = seriesOfRecord(raw, deps.zones, deps.clock.now());
        if (typeof master === "string" || master.item.id !== target.id) return refused("version_stale");
        let day = await readInstance(token, initialId, target, master.series, signal, true);
        if ("ok" in day) {
          if (!req.retry || day.reason !== "version_stale") return day;
          day = await readInstance(token, initialId, target, master.series, signal, "applied");
          if ("ok" in day) return day;
          if (
            !day.isException ||
            (target.exception && day.item.id !== target.exception.id) ||
            day.item.event.organizer?.email !== master.item.event.organizer?.email ||
            !isRecord(day.raw.responseStatus) ||
            day.raw.responseStatus.response !== wanted
          )
            return refused("version_stale");
          return answered([day.item]);
        }
        if (day.item.event.organizer?.email !== master.item.event.organizer?.email)
          return refused("version_stale");
        // The day as Graph lists it is the one answered: Graph's answer takes no version, so a second read of it would
        // hold nothing more, and Graph's single read of a day may carry another tag than its listing.
        if (req.retry && isRecord(day.raw.responseStatus) && day.raw.responseStatus.response === wanted)
          return answered([day.item]);
        parseAfter = (response) => {
          const after = instanceOf(jsonOf(response.body), target, master.series, false, "applied");
          return after && !("ok" in after) ? after : null;
        };
        held = day;
        version = day.item.version;
      }
      if (held === null || held.item === null || held.item.kind !== "upsert") return refused("unreadable");
      const id = segment(held.item.id);
      if (id === null) return refused("not_found");
      if (held.item.version !== version) {
        // Another version: done where Graph already says this answer (an earlier attempt landed); else another copy.
        const said = isRecord(held.raw.responseStatus) ? held.raw.responseStatus.response : null;
        return said === wanted ? answered([held.item]) : refused("version_stale");
      }
      const call = { ACCEPTED: "accept", TENTATIVE: "tentativelyAccept", DECLINED: "decline" }[req.reply];
      const res = await send(
        signedIn.token,
        "POST",
        `${eventUrl(id)}/${call}`,
        { sendResponse: true },
        signal,
      );
      if ("ok" in res) return res;
      if (res.status !== 202 && res.status !== 200) return refusalOf(res, "event_gone");
      // Read again after the answer: a copy Graph's answer call names no version of, so nothing waiting behind it is re-based onto it.
      const after = await read(signedIn.token, id, signal);
      if ("ok" in after || after.status !== 200) return answered([]);
      const shown = parseAfter(after);
      return answered(shown === null || shown.item === null ? [] : [shown.item]);
    },

    async endSeries(c, cal, target, req, signal) {
      if (!target.recurringSeries || req.then === null || target.occurrence === null)
        return refused("repeat_unsupported");
      const id = segment(target.id);
      const calendar = segment(cal.id);
      if (id === null || calendar === null) return refused("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const { token } = signedIn;
      const master = await readMaster(token, id, target, signal, true);
      if ("ok" in master) return master;
      const last = splitDate(master, target);
      const recurrence = recurrenceOf(master.raw);
      if (
        last === null ||
        recurrence === null ||
        typeof recurrence.range.startDate !== "string" ||
        last < recurrence.range.startDate
      )
        return refused("repeat_unsupported");
      const after = req.then;
      const savedTag = after.createdVersion;
      if (savedTag !== undefined && !sendableTag(savedTag)) return refused("version_unknown");
      const recoverEnd = async (live: Master): Promise<WriteAnswer> => {
        if (!req.mayBeDone || !holdsEnd(live.raw, last)) return refused("version_stale");
        const existing = await recoverContinuation(token, calendar, target, after, signal);
        if ("ok" in existing) return existing;
        if (savedTag !== undefined && existing.version !== savedTag) return refused("version_stale");
        const finished = await retireSplitException(
          token,
          target,
          after,
          {
            source: live,
            shortened: live.item,
            continuation: existing,
            creationTag: savedTag,
            last,
            late: req.late,
          },
          signal,
        );
        return "ok" in finished ? finished : answered(finished);
      };
      if (master.item.version !== target.version && master.raw.changeKey !== target.version)
        return recoverEnd(master);
      if (req.late || holdsEnd(master.raw, last)) return refused("version_stale");
      if (!splitCanReplace(master, target)) {
        if (!req.mayBeDone) return refused("repeat_unsupported");
        if (savedTag === undefined || !exceptionsKeepSchedule(master)) return refused("version_stale");
        // A previously queued cleanup can finish without creating a new copy or touching the original.
        const existing = await recoverContinuation(token, calendar, target, after, signal);
        if ("ok" in existing) return existing;
        const existingId = segment(existing.id);
        const draft = continuationBody(master, target, after);
        if (existingId === null || "ok" in draft) return refused("version_stale");
        const live = await readLiveContinuation(token, existingId, existing.id, target, after, signal);
        if ("ok" in live) return live;
        if (live.pre.tag !== savedTag || hasSeriesChanges(live)) return refused("version_stale");
        const tag = recoveredRollbackTag(live, draft.body);
        if (tag === null) return refused("version_stale");
        const original = await readMaster(token, id, target, signal, true);
        if ("ok" in original) return original;
        if (!lateSourceMatches(master, original)) return refused("version_stale");
        return (await rollBack(token, existingId, tag, after, signal)) ?? refused("version_stale");
      }
      if (!exceptionAudience(master.raw, target.audience)) return refused("version_stale");
      const first = master.item.event.start;
      const rule = master.item.event.rules[0]?.rule;
      const pattern =
        first !== null &&
        rule &&
        recurrenceFor({ ...rule, count: null, until: null }, first, deps.zones)?.pattern;
      if (!pattern) return refused("repeat_unsupported");
      const day = target.exception
        ? await readException(token, target, master, signal, true)
        : await readInstance(token, id, target, master.series, signal);
      if ("ok" in day) return day;
      if (target.exception ? !matchesException(day, target) : day.isException)
        return refused("version_stale");
      const continuation = continuationBody(master, target, after);
      if ("ok" in continuation) return continuation;
      const current = await readMaster(token, id, target, signal, true);
      if ("ok" in current) return current;
      if (
        current.pre.tag !== master.pre.tag ||
        !splitCanReplace(current, target) ||
        !exceptionAudience(current.raw, target.audience)
      )
        return refused("version_stale");
      const made =
        savedTag !== undefined
          ? await recoverContinuation(token, calendar, target, after, signal)
          : await postContinuation(token, calendar, target, after, continuation.body, signal);
      if ("ok" in made) return made;
      const item = "item" in made ? made.item : made;
      const continuationId = segment(item.id);
      if (continuationId === null) return refused("version_unknown");
      const fresh = "created" in made && made.created && !req.mayBeDone;
      const creationTag = fresh ? made.pre.tag : savedTag;
      if (fresh) {
        const failure = await rememberCreation(after, made.pre.tag);
        if (failure !== null) return failure;
      }
      const live = await readLiveContinuation(token, continuationId, item.id, target, after, signal);
      if ("ok" in live) return live;
      if (hasSeriesChanges(live) || (creationTag !== undefined && live.pre.tag !== creationTag))
        return refused("version_stale");
      const cleanContinuation = async (lateException: boolean): Promise<Refusal | null> => {
        if (creationTag === undefined) return null;
        const copy = await readLiveContinuation(token, continuationId, item.id, target, after, signal);
        if ("ok" in copy || copy.pre.tag !== creationTag || hasSeriesChanges(copy)) return null;
        const tag = fresh
          ? copy.raw.changeKey === live.raw.changeKey
            ? copy.pre
            : null
          : recoveredRollbackTag(copy, continuation.body);
        if (tag === null) return null;
        if (lateException) {
          const original = await readMaster(token, id, target, signal, true);
          if ("ok" in original || !lateSourceMatches(master, original)) return null;
        } else if (!(await canRollBack(token, id, target, master, !fresh, signal))) return null;
        return rollBack(token, continuationId, tag, after, signal);
      };
      const beforeTrim = await readMaster(token, id, target, signal, true);
      if ("ok" in beforeTrim) return beforeTrim;
      if (beforeTrim.pre.tag !== master.pre.tag || beforeTrim.raw.changeKey !== master.raw.changeKey)
        return recoverEnd(beforeTrim);
      if (!splitCanReplace(beforeTrim, target) || !exceptionAudience(beforeTrim.raw, target.audience)) {
        const retry = await cleanContinuation(true);
        if (retry !== null) return retry;
        return refused("version_stale");
      }
      const recurrenceTimeZone = filled(recurrence.range.recurrenceTimeZone);
      const range = {
        type: "endDate",
        startDate: recurrence.range.startDate,
        endDate: last,
        ...(recurrenceTimeZone !== undefined && { recurrenceTimeZone }),
      };
      const res = await send(
        token,
        "PATCH",
        eventUrl(id),
        { recurrence: { pattern, range } },
        signal,
        master.pre,
      );
      if ("ok" in res) return res;
      if (res.status === 200) {
        const saved = itemOf(res);
        if (saved?.item?.kind !== "upsert" || saved.item.id !== target.id || !holdsEnd(saved.raw, last))
          return refused("unavailable");
        const finished = await retireSplitException(
          token,
          target,
          after,
          {
            source: master,
            shortened: saved.item,
            continuation: item,
            creationTag,
            last,
          },
          signal,
        );
        return "ok" in finished ? finished : wrote(finished);
      }
      if (res.status === 412 && req.mayBeDone) {
        const live = await readMaster(token, id, target, signal);
        if (!("ok" in live) && live.item.version !== master.item.version && holdsEnd(live.raw, last))
          return recoverEnd(live);
      }
      if (definitelyRefused(res.status)) {
        const retry = await cleanContinuation(false);
        if (retry !== null) return retry;
      }
      return res.status === 412 ? refused("version_stale") : refusalOf(res, "event_gone");
    },

    async continueSeries(c, cal, req, signal) {
      const { from } = req;
      if (!from.recurringSeries || from.occurrence === null) return refused("repeat_unsupported");
      if (!req.requireExisting) return refused("version_stale");
      const id = segment(from.id);
      const calendar = segment(cal.id);
      if (id === null || calendar === null) return refused("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const { token } = signedIn;
      const master = await readMaster(token, id, from, signal);
      if ("ok" in master) return master;
      const last = splitDate(master, from);
      if (last === null || !holdsEnd(master.raw, last)) return refused("version_stale");
      const existing = await recoverContinuation(token, calendar, from, req, signal);
      if ("ok" in existing) return existing;
      return req.createdVersion === undefined || existing.version === req.createdVersion
        ? answered([existing])
        : refused("version_stale");
    },

    moveEvent: null,
  };
}
