/**
 * Google's calendar, written: a new event under an id made from the write's own key, a change and
 * a removal against the version a reading stored, the account's own answer to an invitation, and
 * Google's own move between two calendars. Every request leaves through the request port the
 * provider was made with, for Google's API host alone, with a calendar's and an event's id as one
 * escaped segment of a path and a query of constants. Invitees always hear of a change
 * (`sendUpdates=all`): no setting can say otherwise.
 *
 * What a write answers is what a reading would hand for the object after it, read by the reader's
 * own converter, so the store meets Google's answer through the reading's mapper.
 */
import { createHash } from "node:crypto";
import {
  formatRRule,
  instant,
  momentOrUtc,
  recurrenceKeyOf,
  type CalEvent,
  type EventTime,
} from "@ohmail/cal-core";
import {
  bearerOf,
  isRecord,
  jsonOf,
  MAX_PROVIDER_ID_CHARS,
  pathSegment,
  type Json,
} from "../json-answers.js";
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
import { CURSOR_MAX_CHARS, MAX_PAGES_PER_CALL } from "../limits.js";
import type { ProviderRefusal, WriteRefusal } from "../refusals.js";
import {
  retryAfterMs,
  sendableTag,
  type AdapterDeps,
  type HttpMethod,
  type HttpResponse,
  type Precondition,
} from "../request/index.js";
import { clockOf, endBefore, isDayOf } from "../series.js";
import {
  alreadyHolds,
  ordinarySharedChange,
  sameAudience,
  sameCancellationAudience,
} from "../write-compare.js";
import { convertEvent, googleSelfAttendee, googleTimeOf, isDefaultGoogleEvent } from "./convert.js";
import { GOOGLE_CALENDAR_BASE } from "./hosts.js";
import { googleAuthorization } from "./reader.js";

const QUOTA_REASONS: ReadonlySet<string> = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
]);
/** The one setting of who hears of a write, and the only value it takes. */
const NOTIFY = "sendUpdates=all";
// Google keeps these keys on this calendar's own copy only. They establish that a retried request
// already landed, even when an instance edit did not change the master's tag.
const EDIT_KEY = "ohmailRecurringEdit";
const EXCEPTION_EDIT_KEY = "ohmailRecurringEditException";
const SPLIT_KEY = "ohmailRecurringSplit";
const SPLIT_VERSION = "ohmailRecurringSplitTag";

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
type HeldEvent = { readonly item: Upsert; readonly raw: Json };
type ContinuationDraft = { readonly body: Json; readonly event: EventDraft };
type SeriesIndex = {
  readonly versions: ReadonlyMap<string, string | null>;
  readonly exceptions: readonly {
    readonly id: string;
    readonly parent: string;
    readonly tag: unknown;
    readonly originalStart: unknown;
    readonly cancelled: boolean;
  }[];
};

const writeId = (key: WriteKey | undefined): string | null =>
  key && /^[0-9a-f]{32}$/.test(key.hex) ? key.hex : null;

function privateProperties(raw: Json): Json {
  const extended = raw.extendedProperties;
  return isRecord(extended) && isRecord(extended.private) ? extended.private : {};
}

function withPrivateKeys(raw: Json, keys: Readonly<Record<string, string>>): Json {
  const extended = isRecord(raw.extendedProperties) ? raw.extendedProperties : {};
  return { ...extended, private: { ...privateProperties(raw), ...keys } };
}

/** Every field outside the edit, ignoring revision metadata and the inherited master marker. */
function exceptionSnapshot(raw: Json, body: Json): string {
  const { etag: _etag, updated: _updated, sequence: _sequence, extendedProperties, ...fields } = raw;
  for (const field of Object.keys(body)) delete fields[field];
  if (isRecord(extendedProperties)) {
    const { private: _private, ...extended } = extendedProperties;
    const { [EDIT_KEY]: _masterMarker, ...properties } = privateProperties(raw);
    if (Object.keys(properties).length > 0) extended.private = properties;
    if (Object.keys(extended).length > 0) fields.extendedProperties = extended;
  }
  return createHash("sha256")
    .update(
      JSON.stringify(fields, (_field, value) =>
        isRecord(value)
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, value[key]]),
            )
          : value,
      ),
    )
    .digest("hex");
}

function sameGuests(attendees: NonNullable<EventChange["attendees"]>, guests: readonly string[]): boolean {
  const addresses = new Set(attendees.map(({ email }) => email.toLowerCase()));
  return (
    addresses.size === attendees.length &&
    addresses.size === guests.length &&
    new Set(guests).size === guests.length &&
    guests.every((guest) => addresses.has(guest))
  );
}

/** An id as one segment of a path, or `null` for one no write names (empty, a dot path, past Google's ceiling, half a character). */
function segment(id: string): string | null {
  if (id === "" || id === "." || id === ".." || id.length > MAX_PROVIDER_ID_CHARS) return null;
  return pathSegment(id);
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** A time as Google writes it. A clock time with no zone is no time Google keeps. A series needs a zone even for an instant. */
function timeJson(t: EventTime, series: boolean): Json | null {
  switch (t.kind) {
    case "date":
      return { date: `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}` };
    case "instant":
      return series
        ? { dateTime: new Date(t.epochMs).toISOString(), timeZone: "UTC" }
        : { dateTime: new Date(t.epochMs).toISOString() };
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

/**
 * The fields of a draft or a change as Google's event, field by field from the typed values: nothing
 * of a person's is spread into it. `field_unwritable`: a field Google would not keep as written (a
 * clock time with no zone, a pasted call link, which Google keeps nowhere its reading returns it).
 * The repeat proof writes its cases with it, so that what is proven is what this writer sends.
 */
export function bodyOf(f: EventChange, series: boolean): Json | "field_unwritable" {
  const body: Json = {};
  if (f.summary !== undefined) body.summary = f.summary;
  if (f.description !== undefined) body.description = f.description ?? "";
  if (f.location !== undefined) body.location = f.location ?? "";
  if (f.url !== undefined && f.url !== null) return "field_unwritable";
  if (f.start !== undefined || f.end !== undefined) {
    if (f.start === undefined || f.end === undefined) return "field_unwritable";
    const start = timeJson(f.start, series);
    const end = timeJson(f.end, series);
    if (start === null || end === null) return "field_unwritable";
    body.start = start;
    body.end = end;
  }
  if (f.busy !== undefined) body.transparency = f.busy ? "opaque" : "transparent";
  if (f.private !== undefined) body.visibility = f.private ? "private" : "default";
  if (f.rule !== undefined) body.recurrence = f.rule === null ? [] : [`RRULE:${formatRRule(f.rule)}`];
  if (f.attendees !== undefined) {
    body.attendees = f.attendees.map((p) => ({
      email: p.email,
      ...(p.name === null ? {} : { displayName: p.name }),
      ...(p.optional ? { optional: true } : {}),
    }));
  }
  if (f.alarms !== undefined)
    body.reminders = {
      useDefault: false,
      overrides: f.alarms.map((minutes) => ({ method: "popup", minutes })),
    };
  return body;
}

function quotaSpent(body: Uint8Array): boolean {
  const error = jsonOf(body)?.error;
  const listed = isRecord(error) && Array.isArray(error.errors) ? error.errors : [];
  return listed.some((e) => isRecord(e) && typeof e.reason === "string" && QUOTA_REASONS.has(e.reason));
}

export function makeWriter(deps: AdapterDeps): CalendarWriter {
  /** A status that is no success, as a write's word. Google's body is read only for its machine reason of a spent quota. */
  function refusalOf(res: HttpResponse, gone: ProviderRefusal | WriteRefusal): Refusal {
    const wait = retryAfterMs(res, deps.clock);
    if (res.status >= 300 && res.status < 400) return refused("redirect_invalid");
    if (res.status === 401) return refused("sign_in_refused");
    if (res.status === 403) return quotaSpent(res.body) ? refused("throttled", wait) : refused("read_only");
    if (res.status === 404 || res.status === 410) return refused(gone);
    if (res.status === 400) return refused("field_unwritable");
    if (res.status === 429) return refused("throttled", wait);
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
      auth: googleAuthorization(token),
      validators: null,
      ...(precondition === undefined ? {} : { precondition }),
      signal,
    });
    return answer.arrived ? answer : refused(answer.reason);
  }

  /** The object as the reader converts it: its item, and Google's raw record for what the item does not carry. */
  function itemOf(res: HttpResponse): { readonly item: ChangeItem | null; readonly raw: Json } | null {
    const raw = jsonOf(res.body);
    if (raw === null) return null;
    const one = convertEvent(raw, deps.zones, deps.clock.now());
    return { item: one.kind === "item" ? one.item : null, raw };
  }

  /** The event as Google holds it now, read once. */
  async function read(
    token: string,
    events: string,
    id: string,
    signal: AbortSignal,
  ): Promise<HttpResponse | Refusal> {
    return send(token, "GET", `${events}/${id}`, null, signal);
  }

  /**
   * The precondition a change of `target` is made under: its stored version where that is an entity
   * tag; where it is not (a recorded exchange keeps no tag), the object is read once, its version
   * compared with the stored one, and the tag of that read is sent. Never no precondition.
   */
  async function precondition(
    token: string,
    events: string,
    id: string,
    target: WriteTarget,
    signal: AbortSignal,
  ): Promise<Precondition | Refusal> {
    if (!target.sharedCopy && !target.audience && sendableTag(target.version))
      return { kind: "unchanged", tag: target.version };
    const now = await read(token, events, id, signal);
    if ("ok" in now) return now;
    if (now.status !== 200) return refusalOf(now, "event_gone");
    const held = itemOf(now);
    if (held === null || held.item === null || held.item.kind !== "upsert") return refused("version_unknown");
    if (held.item.version !== target.version) return refused("version_stale");
    if (
      target.sharedCopy &&
      (held.item.audienceIncomplete ||
        held.raw.attendeesOmitted === true ||
        held.item.event.recurrenceId ||
        held.item.event.rules.length ||
        held.item.event.added.length ||
        (held.raw.attendees != null && (!Array.isArray(held.raw.attendees) || held.raw.attendees.length)))
    )
      return refused("read_only");
    if (target.audience) {
      if (held.item.audienceIncomplete || !sameAudience(target.audience, held.item.event))
        return refused("version_stale");
    }
    const tag = typeof held.raw.etag === "string" ? held.raw.etag : "";
    return sendableTag(tag) ? { kind: "unchanged", tag } : refused("version_unknown");
  }

  const eventsOf = (cal: CalendarRef): string | null => {
    const calendar = segment(cal.id);
    return calendar === null ? null : `${GOOGLE_CALENDAR_BASE}/calendars/${calendar}/events`;
  };

  function heldEvent(raw: Json): HeldEvent | null {
    const converted = convertEvent(raw, deps.zones, deps.clock.now());
    return converted.kind === "item" && converted.item.kind === "upsert"
      ? { raw, item: converted.item }
      : null;
  }

  async function readEvent(
    token: string,
    events: string,
    id: string,
    signal: AbortSignal,
  ): Promise<HeldEvent | Refusal> {
    const path = segment(id);
    if (path === null) return refused("not_found");
    const res = await read(token, events, path, signal);
    if ("ok" in res) return res;
    if (res.status !== 200) return refusalOf(res, "event_gone");
    const raw = jsonOf(res.body);
    const held = raw === null ? null : heldEvent(raw);
    return held === null || held.item.id !== id ? refused("version_unknown") : held;
  }

  function validSeriesAudience(held: HeldEvent, target: WriteTarget): boolean {
    const { event, audienceIncomplete } = held.item;
    return (
      target.audience !== undefined &&
      !audienceIncomplete &&
      sameAudience(target.audience, {
        ...event,
        recurrenceId: null,
        rules: [],
        added: [],
        excluded: [],
      })
    );
  }

  function isSeriesMaster(held: HeldEvent): boolean {
    const { event } = held.item;
    return event.recurrenceId === null && event.rules.length > 0;
  }

  function seriesHead(held: HeldEvent, target: WriteTarget): boolean {
    return isSeriesMaster(held) && validSeriesAudience(held, target);
  }

  /** All-day queue keys are UTC midnight. A timed key must resolve to the scheduled instant. */
  function scheduledDay(day: EventTime, first: EventTime): EventTime | null {
    const key = recurrenceKeyOf(day, deps.zones);
    if (first.kind === "date") {
      if (key.kind === "date") return key.date;
      if (key.kind === "instant" && key.epochMs % 86_400_000 === 0)
        return clockOf(first, key.epochMs, deps.zones);
      return null;
    }
    return key.kind === "instant" ? instant(key.epochMs) : null;
  }

  async function readInstance(
    token: string,
    events: string,
    master: HeldEvent,
    day: EventTime,
    signal: AbortSignal,
  ): Promise<HeldEvent | Refusal> {
    const masterPath = segment(master.item.id);
    const first = master.item.event.start;
    if (masterPath === null || first === null) return refused("version_unknown");
    const cut = scheduledDay(day, first);
    if (cut === null) return refused("version_stale");
    const when =
      cut.kind === "date"
        ? `${pad(cut.year, 4)}-${pad(cut.month)}-${pad(cut.day)}`
        : new Date(momentOrUtc(cut, deps.zones)).toISOString();
    const query = new URLSearchParams({ originalStart: when });
    let found: HeldEvent | null = null;
    for (let page = 0; page < MAX_PAGES_PER_CALL; page++) {
      const res = await send(token, "GET", `${events}/${masterPath}/instances?${query}`, null, signal);
      if ("ok" in res) return res;
      if (res.status !== 200) return refusalOf(res, "event_gone");
      const listed = jsonOf(res.body);
      if (!Array.isArray(listed?.items)) return refused("unreadable");
      for (const raw of listed.items) {
        if (!isRecord(raw) || raw.recurringEventId !== master.item.id || raw.id === master.item.id) continue;
        const instance = heldEvent(raw);
        const original = instance?.item.event.recurrenceId;
        if (instance === null || !original || (original.kind === "date") !== (cut.kind === "date")) continue;
        if (momentOrUtc(original, deps.zones) !== momentOrUtc(cut, deps.zones)) continue;
        if (found !== null) return refused("version_stale");
        found = instance;
      }
      const next = listed.nextPageToken;
      if (next === undefined || next === null || next === "") return found ?? refused("version_stale");
      if (typeof next !== "string" || next.length > CURSOR_MAX_CHARS || next === query.get("pageToken"))
        return refused("page_link_refused");
      query.set("pageToken", next);
    }
    return refused("page_link_refused");
  }

  function isReviewedException(raw: Json, master: HeldEvent, target: WriteTarget): boolean {
    const reviewed = target.exception;
    const first = master.item.event.start;
    if (
      reviewed === undefined ||
      first === null ||
      raw.id !== reviewed.id ||
      raw.recurringEventId !== master.item.id
    )
      return false;
    const cut = scheduledDay(reviewed.occurrence, first);
    const chosen = target.occurrence === null ? cut : scheduledDay(target.occurrence, first);
    const original = googleTimeOf(raw.originalStartTime, deps.zones);
    if (
      cut === null ||
      chosen === null ||
      original === null ||
      original === "zone_name_too_long" ||
      (original.kind === "date") !== (cut.kind === "date")
    )
      return false;
    const boundary = momentOrUtc(cut, deps.zones);
    return boundary === momentOrUtc(chosen, deps.zones) && boundary === momentOrUtc(original, deps.zones);
  }

  async function readReviewedException(
    token: string,
    events: string,
    master: HeldEvent,
    target: WriteTarget,
    signal: AbortSignal,
  ): Promise<HeldEvent | Refusal> {
    const reviewed = target.exception;
    if (reviewed === undefined) return refused("version_stale");
    const actual = await readEvent(token, events, reviewed.id, signal);
    if ("ok" in actual) return actual.reason === "event_gone" ? refused("version_stale") : actual;
    return isReviewedException(actual.raw, master, target) && validSeriesAudience(actual, target)
      ? actual
      : refused("version_stale");
  }

  /** An unexpanded event list includes persisted exceptions without expanding an endless series. */
  async function readSeriesIndex(
    token: string,
    events: string,
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<SeriesIndex | Refusal> {
    // A cancelled exception can omit iCalUID, but still carries its exact parent id.
    const query = new URLSearchParams({
      singleEvents: "false",
      showDeleted: "true",
      showHiddenInvitations: "true",
      maxResults: "1000",
      fields: "nextPageToken,accessRole,items(id,etag,recurringEventId,status,originalStartTime)",
    });
    const versions = new Map<string, string | null>();
    const exceptions: SeriesIndex["exceptions"][number][] = [];
    for (let page = 0; page < MAX_PAGES_PER_CALL; page++) {
      const res = await send(token, "GET", `${events}?${query}`, null, signal);
      if ("ok" in res) return res;
      if (res.status !== 200) return refusalOf(res, "event_gone");
      const listed = jsonOf(res.body);
      if (!Array.isArray(listed?.items)) return refused("unreadable");
      if (listed.accessRole !== "owner" && listed.accessRole !== "writer") return refused("read_only");
      for (const raw of listed.items) {
        if (!isRecord(raw) || typeof raw.id !== "string") return refused("unreadable");
        if (ids.includes(raw.id)) {
          if (versions.has(raw.id)) return refused("version_stale");
          const tag =
            typeof raw.etag === "string" && raw.status !== "cancelled" && raw.recurringEventId === undefined
              ? raw.etag
              : null;
          versions.set(raw.id, tag);
        }
        if (typeof raw.recurringEventId === "string" && ids.includes(raw.recurringEventId))
          exceptions.push({
            id: raw.id,
            parent: raw.recurringEventId,
            tag: raw.etag,
            originalStart: raw.originalStartTime,
            cancelled: raw.status === "cancelled",
          });
      }
      const next = listed.nextPageToken;
      if (next === undefined || next === null || next === "") return { versions, exceptions };
      if (typeof next !== "string" || next.length > CURSOR_MAX_CHARS || next === query.get("pageToken"))
        return refused("page_link_refused");
      query.set("pageToken", next);
    }
    return refused("page_link_refused");
  }

  async function checkExceptions(
    token: string,
    events: string,
    target: WriteTarget,
    check:
      | { readonly metadataOnly: boolean }
      | { readonly instance: { readonly id: string; readonly version?: string } },
    signal: AbortSignal,
  ): Promise<true | Refusal> {
    const index = await readSeriesIndex(token, events, [target.id], signal);
    if ("ok" in index) return index;
    if (index.versions.get(target.id) !== target.version) return refused("version_stale");
    if ("instance" in check) {
      const matching = index.exceptions.filter((item) => item.id === check.instance.id);
      const bound = check.instance.version;
      return (
        bound === undefined
          ? matching.length === 0
          : matching.length === 1 && matching[0]?.tag === bound && !matching[0].cancelled
      )
        ? true
        : refused("version_stale");
    }
    const reviewed = target.exception;
    if (
      reviewed &&
      !index.exceptions.some(
        (actual) => actual.id === reviewed.id && actual.tag === reviewed.version && !actual.cancelled,
      )
    )
      return refused("version_stale");
    for (const raw of index.exceptions) {
      if (!check.metadataOnly || raw.cancelled) return refused("repeat_unsupported");
      const exception = await readEvent(token, events, raw.id, signal);
      if ("ok" in exception) return exception.reason === "event_gone" ? refused("version_stale") : exception;
      if (
        exception.raw.recurringEventId !== target.id ||
        exception.item.version !== raw.tag ||
        !validSeriesAudience(exception, target)
      )
        return refused("version_stale");
    }
    return true;
  }

  async function verifyCancellation(
    token: string,
    events: string,
    master: HeldEvent,
    target: WriteTarget,
    signal: AbortSignal,
  ) {
    const reviewed = target.seriesCancellation!;
    const matches = (index: SeriesIndex) => {
      const live = index.exceptions.filter((day) => !day.cancelled);
      return (
        index.versions.get(target.id) === target.version &&
        live.length === reviewed.overrides.length &&
        reviewed.overrides.every(
          (day) => live.filter(({ id, tag }) => id === day.id && tag === day.version).length === 1,
        )
      );
    };
    const index = await readSeriesIndex(token, events, [target.id], signal);
    if ("ok" in index) return index;
    if (!matches(index)) return refused("version_stale");
    const items = [master.item];
    for (const day of reviewed.overrides) {
      const read = await readEvent(token, events, day.id, signal);
      if ("ok" in read) return read;
      if (read.raw.recurringEventId !== target.id || read.item.version !== day.version)
        return refused("version_stale");
      items.push(read.item);
    }
    if (!sameCancellationAudience(target.audience, items)) return refused("version_stale");
    const current = await readSeriesIndex(token, events, [target.id], signal);
    if ("ok" in current) return current;
    return matches(current) ? (true as const) : refused("version_stale");
  }

  function splitUnchanged(index: SeriesIndex, original: WriteTarget, id: string, tag: string): boolean {
    return (
      index.versions.get(original.id) === original.version &&
      index.versions.get(id) === tag &&
      !index.exceptions.some((exception) => exception.parent === id)
    );
  }

  function splitExceptionRefusal(index: SeriesIndex, master: HeldEvent, target: WriteTarget): Refusal | null {
    const exceptions = index.exceptions.filter((instance) => instance.parent === target.id);
    const reviewed = target.exception;
    if (reviewed === undefined) return exceptions.length === 0 ? null : refused("repeat_unsupported");
    const first = master.item.event.start;
    const cut = first === null ? null : scheduledDay(reviewed.occurrence, first);
    if (cut === null) return refused("version_stale");
    const selected = exceptions.filter((instance) => instance.id === reviewed.id);
    if (selected.length !== 1 || selected[0]?.cancelled || selected[0].tag !== reviewed.version)
      return refused("version_stale");
    const boundary = momentOrUtc(cut, deps.zones);
    for (const instance of exceptions) {
      const original = googleTimeOf(instance.originalStart, deps.zones);
      if (
        original === null ||
        original === "zone_name_too_long" ||
        (original.kind === "date") !== (cut.kind === "date")
      )
        return refused("version_stale");
      const at = momentOrUtc(original, deps.zones);
      if (instance.id === reviewed.id) {
        if (at !== boundary) return refused("version_stale");
      } else if (!(at < boundary)) {
        return refused("repeat_unsupported");
      }
    }
    return null;
  }

  async function changeFromException(
    token: string,
    events: string,
    master: HeldEvent,
    target: WriteTarget,
    key: string,
    change: EventChange,
    body: Json,
    signal: AbortSignal,
  ): Promise<WriteAnswer> {
    const reviewed = target.exception;
    const alreadyChanged = privateProperties(master.raw)[EDIT_KEY] === key;
    if (
      reviewed === undefined ||
      !seriesHead(master, target) ||
      (alreadyChanged
        ? !alreadyHolds(change, master.item.event, deps.zones)
        : master.item.version !== target.version)
    )
      return refused("version_stale");
    if (
      change.start !== undefined ||
      change.end !== undefined ||
      change.rule !== undefined ||
      change.attendees !== undefined
    )
      return refused("repeat_unsupported");
    const selected = await readReviewedException(token, events, master, target, signal);
    if ("ok" in selected) return selected;

    let receipt = target.masterReceipt;
    if (receipt && (!alreadyChanged || receipt.version !== master.item.version))
      return refused("version_stale");
    let head: WriteAnswer = answered([master.item]);
    let snapshot: string | undefined;
    if (!alreadyChanged) {
      if (selected.item.version !== reviewed.version) return refused("version_stale");
      const safe = await checkExceptions(token, events, target, { metadataOnly: true }, signal);
      if (safe !== true) return safe;
      snapshot = exceptionSnapshot(selected.raw, body);
      head = await patchRecurring(token, events, master, key, body, signal);
    }
    if (!head.ok) return head;
    const acknowledgedHead = head.items[0];
    if (
      acknowledgedHead?.kind !== "upsert" ||
      acknowledgedHead.id !== target.id ||
      !sendableTag(acknowledgedHead.version)
    )
      return refused("version_unknown");
    if (!alreadyHolds(change, acknowledgedHead.event, deps.zones)) return refused("version_stale");
    if (head.written && snapshot !== undefined) {
      receipt = { version: acknowledgedHead.version, exceptionSnapshot: snapshot };
      try {
        await target.rememberMasterReceipt?.(receipt);
      } catch {
        return refused("unknown");
      }
    }
    // A child can inherit the master marker without inheriting a field it had overridden.
    const { visibility: _visibility, ...instanceBody } = body;
    const { private: _private, ...instanceChange } = change;
    const live = alreadyChanged
      ? selected
      : await readReviewedException(token, events, master, target, signal);
    if ("ok" in live) return live;
    if (
      Object.keys(instanceBody).length === 0 ||
      privateProperties(live.raw)[EXCEPTION_EDIT_KEY] === key ||
      alreadyHolds(instanceChange, live.item.event, deps.zones)
    ) {
      const items = [...head.items, live.item];
      return head.written ? wrote(items) : answered(items);
    }
    if (
      live.item.version !== reviewed.version &&
      receipt?.exceptionSnapshot !== exceptionSnapshot(live.raw, body)
    )
      return refused("version_stale");
    const current = await readEvent(token, events, target.id, signal);
    if ("ok" in current) return current;
    if (
      current.item.version !== (receipt?.version ?? acknowledgedHead.version) ||
      !seriesHead(current, target) ||
      privateProperties(current.raw)[EDIT_KEY] !== key ||
      !alreadyHolds(change, current.item.event, deps.zones)
    )
      return refused("version_stale");
    const saved = await patchRecurring(token, events, live, key, instanceBody, signal, EXCEPTION_EDIT_KEY);
    if (!saved.ok) return saved;
    const items = [...head.items, ...saved.items];
    return head.written ? wrote(items) : answered(items);
  }

  async function changeRecurring(
    token: string,
    events: string,
    target: WriteTarget,
    change: EventChange,
    signal: AbortSignal,
  ): Promise<WriteAnswer> {
    const key = writeId(target.writeKey);
    if (key === null || target.audience === undefined) return refused("version_stale");
    if (change.attendees !== undefined && !sameGuests(change.attendees, target.audience.guests))
      return refused("version_stale");
    const whole = target.occurrence === null;
    if (!whole && change.rule !== undefined) return refused("repeat_unsupported");
    // Google applies a more restrictive instance visibility to the entire recurring event.
    if (!whole && change.private !== undefined) return refused("field_unwritable");
    const body = bodyOf(change, whole);
    if (body === "field_unwritable") return refused(body);
    const master = await readEvent(token, events, target.id, signal);
    if ("ok" in master) return master;
    if (whole && target.exception)
      return changeFromException(token, events, master, target, key, change, body, signal);
    if (whole && privateProperties(master.raw)[EDIT_KEY] === key) return answered([master.item]);
    const validMaster = (held: HeldEvent) =>
      !whole && target.exception !== undefined
        ? isSeriesMaster(held) && (held.item.event.organizer?.email ?? null) === target.audience?.organizer
        : seriesHead(held, target);
    if (!validMaster(master) || master.item.version !== target.version) return refused("version_stale");
    if (!sendableTag(master.item.version)) return refused("version_unknown");
    let held = master;
    if (target.occurrence === null) {
      const metadataOnly =
        change.start === undefined &&
        change.end === undefined &&
        change.rule === undefined &&
        change.attendees === undefined;
      const safe = await checkExceptions(token, events, target, { metadataOnly }, signal);
      if (safe !== true) return safe;
    } else {
      const instance =
        target.exception === undefined
          ? await readInstance(token, events, master, target.occurrence, signal)
          : await readReviewedException(token, events, master, target, signal);
      if ("ok" in instance) return instance;
      if (!validSeriesAudience(instance, target)) return refused("version_stale");
      const markers = privateProperties(instance.raw);
      if (markers[EXCEPTION_EDIT_KEY] === key) return answered([instance.item]);
      // Earlier occurrence writes used the master's marker. A matching marker alone could
      // be inherited and is never evidence that this instance took the write.
      if (
        markers[EDIT_KEY] === key &&
        privateProperties(master.raw)[EDIT_KEY] !== key &&
        alreadyHolds(change, instance.item.event, deps.zones)
      )
        return answered([instance.item]);
      if (target.exception !== undefined && instance.item.version !== target.exception.version)
        return refused("version_stale");
      const safe = await checkExceptions(
        token,
        events,
        target,
        { instance: { id: instance.item.id, version: target.exception?.version } },
        signal,
      );
      if (safe !== true) return safe;
      const current = await readEvent(token, events, target.id, signal);
      if ("ok" in current) return current;
      if (!validMaster(current) || current.item.version !== target.version) return refused("version_stale");
      held = instance;
    }
    return patchRecurring(token, events, held, key, body, signal, whole ? EDIT_KEY : EXCEPTION_EDIT_KEY);
  }

  async function patchRecurring(
    token: string,
    events: string,
    held: HeldEvent,
    key: string,
    body: Json,
    signal: AbortSignal,
    marker = EDIT_KEY,
  ): Promise<WriteAnswer> {
    const id = segment(held.item.id);
    const tag = held.raw.etag;
    if (id === null || typeof tag !== "string" || !sendableTag(tag)) return refused("version_unknown");
    const res = await send(
      token,
      "PATCH",
      `${events}/${id}?${NOTIFY}`,
      {
        ...body,
        extendedProperties: withPrivateKeys(held.raw, { [marker]: key }),
      },
      signal,
      { kind: "unchanged", tag },
    );
    if ("ok" in res) return res;
    if (res.status === 412) {
      const now = await readEvent(token, events, held.item.id, signal);
      if ("ok" in now) return now;
      return privateProperties(now.raw)[marker] === key ? answered([now.item]) : refused("version_stale");
    }
    if (res.status !== 200) return refusalOf(res, "event_gone");
    const saved = itemOf(res)?.item;
    return saved?.kind === "upsert" && saved.id === held.item.id ? wrote([saved]) : refused("unknown");
  }

  function splitBoundary(master: HeldEvent, target: WriteTarget) {
    const { start: first, end: firstEnd, rules } = master.item.event;
    const rule = rules[0]?.rule;
    const recurrence = master.raw.recurrence;
    if (
      first === null ||
      firstEnd === null ||
      !rule ||
      !Array.isArray(recurrence) ||
      recurrence.length !== 1 ||
      target.occurrence === null
    )
      return null;
    const cut = scheduledDay(target.occurrence, first);
    if (cut === null) return null;
    const at = momentOrUtc(cut, deps.zones);
    if (at <= momentOrUtc(first, deps.zones)) return null;
    const ended = { ...rule, count: null, until: endBefore(cut, deps.zones) };
    const trimmed = formatRRule(ended) === formatRRule(rule);
    return {
      ended,
      trimmed,
      hasDay: !trimmed && isDayOf({ first, firstEnd, rule }, [], String(at), deps.zones) === true,
    };
  }

  function continuationBody(
    master: HeldEvent,
    target: WriteTarget,
    next: SeriesContinuation,
  ): ContinuationDraft | Refusal {
    const { event } = next;
    const id = writeId(next.key);
    if (id === null || id === target.id) return refused("not_found");
    if (event === undefined || event.rule === null) return refused("repeat_unsupported");
    if (
      !target.audience ||
      (event.attendees.length > 0 && event.organizer !== target.audience.organizer) ||
      !sameGuests(event.attendees, target.audience.guests)
    )
      return refused("version_stale");
    const body = bodyOf(event, true);
    if (body === "field_unwritable") return refused(body);
    // A provider reminder or guest-privacy setting survives when the person changes another field.
    if (next.change.alarms === undefined) {
      if (isRecord(master.raw.reminders)) body.reminders = master.raw.reminders;
      else delete body.reminders;
    }
    for (const field of ["guestsCanInviteOthers", "guestsCanModify", "guestsCanSeeOtherGuests"] as const)
      if (typeof master.raw[field] === "boolean") body[field] = master.raw[field];
    return { body: { ...body, id, extendedProperties: { private: { [SPLIT_KEY]: id } } }, event };
  }

  async function readContinuation(
    token: string,
    events: string,
    id: string,
    signal: AbortSignal,
  ): Promise<HeldEvent | Refusal> {
    const held = await readEvent(token, events, id, signal);
    if ("ok" in held) return held;
    return privateProperties(held.raw)[SPLIT_KEY] === id && held.item.event.recurrenceId === null
      ? held
      : refused("version_stale");
  }

  async function insertContinuation(
    token: string,
    events: string,
    id: string,
    body: Json,
    signal: AbortSignal,
  ) {
    const res = await send(token, "POST", `${events}?${NOTIFY}`, body, signal);
    if ("ok" in res) return res;
    if (res.status === 409) {
      const held = await readContinuation(token, events, id, signal);
      return "ok" in held ? held : { held, tag: null };
    }
    if (res.status !== 200) return refusalOf(res, "not_found");
    const raw = jsonOf(res.body);
    const held = raw === null ? null : heldEvent(raw);
    if (!held || held.item.id !== id || privateProperties(held.raw)[SPLIT_KEY] !== id)
      return refused("unknown");
    const tag = typeof held.raw.etag === "string" && sendableTag(held.raw.etag) ? held.raw.etag : null;
    return { held, tag };
  }

  // A duplicate id alone could be a changed copy. Before shortening the old event, the new one
  // must still represent the accepted draft. Google encodes reminders outside the event converter.
  function holdsContinuation(held: HeldEvent, target: WriteTarget, next: ContinuationDraft): boolean {
    const saved = held.item.event;
    const { body, event } = next;
    const recurrence = held.raw.recurrence;
    if (
      !sendableTag(held.item.version) ||
      held.item.version !== held.raw.etag ||
      saved.recurrenceId !== null ||
      !Array.isArray(recurrence) ||
      recurrence.length !== 1
    )
      return false;
    const audience = target.audience;
    const organizer = saved.organizer?.email ?? null;
    // An event that had no organizer can be created with Google's implicit organizer for this calendar.
    if (
      !audience ||
      (organizer !== audience.organizer &&
        (audience.organizer !== null || !isRecord(held.raw.organizer) || held.raw.organizer.self !== true))
    )
      return false;
    if (!validSeriesAudience(held, { ...target, audience: { ...audience, organizer } })) return false;
    const { alarms: _, ...fields } = event;
    const attendees = saved.attendees.filter((person) => person.email !== organizer);
    if (new Set(attendees.map((person) => person.email)).size !== attendees.length) return false;
    if (!alreadyHolds(fields, { ...saved, attendees }, deps.zones)) return false;
    for (const field of ["start", "end"] as const) {
      const wanted = body[field];
      const observed = held.raw[field];
      if (
        isRecord(wanted) &&
        typeof wanted.timeZone === "string" &&
        (!isRecord(observed) || wanted.timeZone !== observed.timeZone)
      )
        return false;
    }
    const guestDefaults = {
      guestsCanInviteOthers: true,
      guestsCanModify: false,
      guestsCanSeeOtherGuests: true,
    } as const;
    for (const field of Object.keys(guestDefaults) as (keyof typeof guestDefaults)[])
      if ((body[field] ?? guestDefaults[field]) !== (held.raw[field] ?? guestDefaults[field])) return false;
    const reminders = (value: unknown): string | null => {
      if (value === undefined || (isRecord(value) && value.useDefault === true)) return "default";
      if (!isRecord(value) || value.useDefault !== false) return null;
      const overrides = value.overrides;
      if (overrides === undefined) return "[]";
      if (!Array.isArray(overrides)) return null;
      const labels = overrides.map((alarm) =>
        isRecord(alarm) && typeof alarm.method === "string" && typeof alarm.minutes === "number"
          ? `${alarm.method} ${alarm.minutes}`
          : null,
      );
      return labels.includes(null) ? null : JSON.stringify(labels.sort());
    };
    const wanted = reminders(body.reminders);
    return wanted !== null && wanted === reminders(held.raw.reminders);
  }

  async function recoverContinuation(
    token: string,
    events: string,
    id: string,
    master: HeldEvent,
    target: WriteTarget,
    next: ContinuationDraft,
    signal: AbortSignal,
    createdVersion?: string,
  ): Promise<HeldEvent | Refusal> {
    const held = await readContinuation(token, events, id, signal);
    if ("ok" in held) return held;
    const version = privateProperties(master.raw)[SPLIT_VERSION];
    return (version === undefined || version === held.item.version) &&
      (createdVersion === undefined || createdVersion === held.item.version) &&
      holdsContinuation(held, target, next)
      ? held
      : refused("version_stale");
  }

  async function rememberSplitVersion(
    remember: SeriesContinuation["rememberCreatedVersion"],
    version: string | null,
  ): Promise<true | Refusal> {
    try {
      await remember?.(version);
      return true;
    } catch {
      return refused("unknown");
    }
  }

  async function rollbackContinuation(
    token: string,
    events: string,
    id: string,
    tag: string,
    reason: Refusal,
    remember: SeriesContinuation["rememberCreatedVersion"],
    signal: AbortSignal,
  ): Promise<Refusal> {
    const rollback = await send(token, "DELETE", `${events}/${id}?${NOTIFY}`, null, signal, {
      kind: "unchanged",
      tag,
    });
    if ("ok" in rollback) return rollback;
    if (rollback.status >= 200 && rollback.status < 300) {
      const cleared = await rememberSplitVersion(remember, null);
      return cleared === true ? reason : cleared;
    }
    // A stale delete leaves the edited continuation intact. A transient response gives the
    // queue another chance to inspect both objects with the saved creation tag.
    if (rollback.status === 412) return refused("version_stale");
    const blocked = refusalOf(rollback, "event_gone");
    return ["unavailable", "throttled", "unknown", "sign_in_refused"].includes(blocked.reason)
      ? blocked
      : reason;
  }

  async function finishSplit(
    token: string,
    events: string,
    target: WriteTarget,
    master: HeldEvent,
    continuation: HeldEvent,
    written: boolean,
    signal: AbortSignal,
    late = false,
  ): Promise<WriteAnswer> {
    const result = written ? wrote : answered;
    const reviewed = target.exception;
    if (reviewed === undefined) return result([master.item]);
    const id = segment(reviewed.id);
    if (id === null || !sendableTag(reviewed.version)) return refused("version_unknown");
    const done = () => result([master.item, { kind: "gone", id: reviewed.id }]);
    const response = await read(token, events, id, signal);
    if ("ok" in response) return response;
    if (response.status === 404 || response.status === 410) return done();
    if (response.status !== 200) return refusalOf(response, "event_gone");
    const raw = jsonOf(response.body);
    if (raw === null || !isReviewedException(raw, master, target)) return refused("version_stale");
    if (raw.status === "cancelled") return done();
    const held = heldEvent(raw);
    if (late || held === null || !validSeriesAudience(held, target) || held.item.version !== reviewed.version)
      return refused("version_stale");

    // The old override can stand on its own after shortening the master. Drop it only while
    // the verified replacement still covers the selected day and neither series has changed.
    const index = await readSeriesIndex(token, events, [master.item.id, continuation.item.id], signal);
    if ("ok" in index) return index;
    if (
      !splitUnchanged(
        index,
        { ...target, version: master.item.version },
        continuation.item.id,
        continuation.item.version,
      )
    )
      return refused("version_stale");
    const removed = await send(token, "DELETE", `${events}/${id}?${NOTIFY}`, null, signal, {
      kind: "unchanged",
      tag: reviewed.version,
    });
    if ("ok" in removed) return removed;
    if ((removed.status >= 200 && removed.status < 300) || removed.status === 404 || removed.status === 410)
      return done();
    return removed.status === 412 ? refused("version_stale") : refusalOf(removed, "event_gone");
  }

  async function settleRejectedEnd(
    token: string,
    events: string,
    target: WriteTarget,
    id: string,
    next: ContinuationDraft,
    createdTag: string | null,
    remember: SeriesContinuation["rememberCreatedVersion"],
    res: HttpResponse,
    signal: AbortSignal,
  ): Promise<WriteAnswer> {
    const reason = res.status === 412 ? refused("version_stale") : refusalOf(res, "event_gone");
    // The old version proves the full pre-split schedule remains. A different version can still
    // contain the selected day after someone shortened its later dates, so keep the new copy.
    if (![400, 401, 403, 412].includes(res.status) || reason.reason === "throttled") return reason;
    const current = await readEvent(token, events, target.id, signal);
    if ("ok" in current) return reason;
    const split = splitBoundary(current, target);
    if (split?.trimmed && privateProperties(current.raw)[SPLIT_KEY] === id) {
      if (!seriesHead(current, target)) return refused("version_stale");
      const continued = await recoverContinuation(
        token,
        events,
        id,
        current,
        target,
        next,
        signal,
        createdTag ?? undefined,
      );
      return "ok" in continued
        ? continued
        : finishSplit(token, events, target, current, continued, false, signal);
    }
    // Without the original creation tag, a duplicate read may include independent changes even
    // if all fields recorded in the app's draft still match.
    if (createdTag === null || current.item.version !== target.version) return reason;
    const index = await readSeriesIndex(token, events, [target.id, id], signal);
    if ("ok" in index) return index;
    if (!splitUnchanged(index, target, id, createdTag)) return refused("version_stale");
    return rollbackContinuation(token, events, id, createdTag, reason, remember, signal);
  }

  /** A change refused for its version: done, where the object already holds every field of it; else made on another copy. */
  async function afterStale(
    token: string,
    events: string,
    id: string,
    change: EventChange | null,
    signal: AbortSignal,
  ): Promise<WriteAnswer> {
    const now = await read(token, events, id, signal);
    if ("ok" in now) return now;
    if (now.status === 404 || now.status === 410)
      return change === null ? answered([{ kind: "gone", id }]) : refused("event_gone");
    if (now.status !== 200) return refusalOf(now, "event_gone");
    const held = itemOf(now);
    if (held === null || held.item === null) return refused("version_stale");
    if (change === null) return held.item.kind === "gone" ? answered([held.item]) : refused("version_stale");
    return held.item.kind === "upsert" && alreadyHolds(change, held.item.event as CalEvent, deps.zones)
      ? answered([held.item])
      : refused("version_stale");
  }

  /** The event's invitees as Google holds them, and which of them is the account's own line (`-1`: none). */
  function linesOf(raw: Json, as: string): { readonly people: Json[]; readonly own: number } {
    const people = Array.isArray(raw.attendees) ? raw.attendees.filter(isRecord) : [];
    const wanted = as.toLowerCase();
    const self = googleSelfAttendee(people);
    if (self !== undefined && self !== wanted) return { people, own: -1 };
    const matching = people.flatMap((p, i) =>
      typeof p.email === "string" && p.email.toLowerCase() === wanted ? [i] : [],
    );
    return { people, own: matching.length === 1 ? matching[0]! : -1 };
  }

  /** An answer refused for its version: done where the account's line already says it (an earlier attempt landed); else another copy. */
  function answeredBefore(
    held: { readonly item: ChangeItem | null; readonly raw: Json } | null,
    as: string,
    status: string,
  ): WriteAnswer {
    if (held === null || held.item === null || held.item.kind !== "upsert") return refused("version_stale");
    const { people, own } = linesOf(held.raw, as);
    return own >= 0 && people[own]!.responseStatus === status
      ? answered([held.item])
      : refused("version_stale");
  }

  return {
    provider: "google",

    async findMoveCopy(c, cal, key, signal) {
      const id = writeId(key);
      return id === null ? refused("not_found") : this.readForMove!(c, cal, id, signal);
    },

    async readForMove(c, cal, id, signal) {
      const events = eventsOf(cal);
      if (!events) return refused("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const found = await readEvent(signedIn.token, events, id, signal);
      if ("ok" in found) return found.reason === "event_gone" ? answered([{ kind: "gone", id }]) : found;
      return answered([found.item]);
    },

    async create(
      c: Connection,
      cal: CalendarRef,
      req: { readonly key: WriteKey; readonly event: EventDraft },
      signal: AbortSignal,
    ): Promise<WriteAnswer> {
      const events = eventsOf(cal);
      // Google's own guard against a second event: an id it was given, which only this write's key makes.
      const id = writeId(req.key);
      if (events === null || id === null) return refused("not_found");
      const body = bodyOf(req.event, req.event.rule !== null);
      if (body === "field_unwritable") return refused(body);
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const made = await send(signedIn.token, "POST", `${events}?${NOTIFY}`, { ...body, id }, signal);
      if ("ok" in made) return made;
      if (made.status === 409) {
        // The id is taken: an earlier attempt of this very write made it, and its answer was lost. It is read from where it was made.
        const now = await read(signedIn.token, events, id, signal);
        if ("ok" in now) return now;
        if (now.status !== 200) return refusalOf(now, "unknown");
        const held = itemOf(now);
        return held === null || held.item === null ? refused("unreadable") : answered([held.item]);
      }
      if (made.status !== 200) return refusalOf(made, "not_found");
      const held = itemOf(made);
      return held === null ? refused("unreadable") : wrote(held.item === null ? [] : [held.item]);
    },

    async change(c, cal, target, change, signal) {
      if (target.sharedCopy && (target.recurringSeries || target.occurrence || !ordinarySharedChange(change)))
        return refused("read_only");
      if (target.occurrence !== null && !target.recurringSeries) return refused("repeat_unsupported");
      const events = eventsOf(cal);
      const id = segment(target.id);
      if (events === null || id === null) return refused("not_found");
      if (target.recurringSeries) {
        const signedIn = await bearerOf(c, signal);
        return signedIn.ok ? changeRecurring(signedIn.token, events, target, change, signal) : signedIn;
      }
      const body = bodyOf(change, change.rule !== undefined && change.rule !== null);
      if (body === "field_unwritable") return refused(body);
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const pre = await precondition(signedIn.token, events, id, target, signal);
      if ("ok" in pre) return pre;
      const notifications = target.sharedCopy ? "sendUpdates=none" : NOTIFY;
      const res = await send(signedIn.token, "PATCH", `${events}/${id}?${notifications}`, body, signal, pre);
      if ("ok" in res) return res;
      if (res.status === 412) return afterStale(signedIn.token, events, id, change, signal);
      if (res.status !== 200) return refusalOf(res, "event_gone");
      const held = itemOf(res);
      return held === null ? refused("unreadable") : wrote(held.item === null ? [] : [held.item]);
    },

    async remove(c, cal, target, signal) {
      // One day of a series is not written by this writer yet, and is never written as the series whole.
      if (target.occurrence !== null && !target.recurringSeries) return refused("repeat_unsupported");
      const events = eventsOf(cal);
      let id = segment(target.id);
      if (events === null || id === null) return refused("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const { token } = signedIn;
      let pre: Precondition | Refusal;
      let result: ChangeItem = { kind: "gone", id: target.id };
      if (target.recurringSeries) {
        const master = await readEvent(token, events, target.id, signal);
        if ("ok" in master)
          return master.reason === "event_gone" && target.occurrence === null ? answered([result]) : master;
        if (
          !(target.seriesCancellation ? isSeriesMaster(master) : seriesHead(master, target)) ||
          master.item.version !== target.version
        )
          return refused("version_stale");
        let tag = master.item.version;
        if (target.occurrence === null) {
          const reviewed = target.seriesCancellation
            ? await verifyCancellation(token, events, master, target, signal)
            : await checkExceptions(token, events, target, { metadataOnly: false }, signal);
          if (reviewed !== true) return reviewed;
        } else {
          const day = await readInstance(token, events, master, target.occurrence, signal);
          if ("ok" in day) return day;
          const originalStart = day.item.event.recurrenceId;
          const uid = master.item.event.uid;
          id = segment(day.item.id);
          if (!uid || !originalStart || !id || !validSeriesAudience(day, target))
            return refused("version_stale");
          const reviewed = await checkExceptions(
            token,
            events,
            target,
            { instance: { id: day.item.id } },
            signal,
          );
          if (reviewed !== true) return reviewed;
          tag = day.item.version;
          result = { kind: "cancelled_occurrence", uid, originalStart };
        }
        if (!sendableTag(tag)) return refused("version_unknown");
        pre = { kind: "unchanged", tag };
      } else {
        pre = await precondition(token, events, id, target, signal);
      }
      if ("ok" in pre) return pre.reason === "event_gone" ? answered([result]) : pre;
      const res = await send(signedIn.token, "DELETE", `${events}/${id}?${NOTIFY}`, null, signal, pre);
      if ("ok" in res) return res;
      // Gone already is what a removal wants.
      if (res.status === 200 || res.status === 204) return wrote([result]);
      if (res.status === 404 || res.status === 410) return answered([result]);
      if (res.status === 412 && target.occurrence !== null) return refused("version_stale");
      if (res.status === 412) return afterStale(signedIn.token, events, id, null, signal);
      return refusalOf(res, "event_gone");
    },

    async answer(
      c,
      cal,
      target,
      req: { readonly as: string; readonly reply: WriteReply; readonly retry?: true },
      signal,
    ) {
      if (target.occurrence !== null && !target.recurringSeries) return refused("repeat_unsupported");
      const events = eventsOf(cal);
      if (events === null || segment(target.id) === null) return refused("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const { token } = signedIn;
      const status = { ACCEPTED: "accepted", TENTATIVE: "tentative", DECLINED: "declined" }[req.reply];
      // A day is resolved through its reviewed series before its own tag is used for the answer.
      const original = await readEvent(token, events, target.id, signal);
      if ("ok" in original) return original;
      let held = original;
      if (target.occurrence !== null) {
        if (!isSeriesMaster(original) || original.item.version !== target.version)
          return refused("version_stale");
        const day = target.exception
          ? await readEvent(token, events, target.exception.id, signal)
          : await readInstance(token, events, original, target.occurrence, signal);
        if ("ok" in day) return day;
        if (
          (target.exception && !isReviewedException(day.raw, original, target)) ||
          day.item.event.organizer?.email !== original.item.event.organizer?.email
        )
          return refused("version_stale");
        const exact = await checkExceptions(
          token,
          events,
          target,
          { instance: { id: day.item.id, version: target.exception?.version } },
          signal,
        );
        if (exact !== true || (target.exception && day.item.version !== target.exception.version)) {
          if (exact !== true && exact.reason !== "version_stale") return exact;
          return req.retry ? answeredBefore(day, req.as, status) : refused("version_stale");
        }
        if (req.retry) {
          const applied = answeredBefore(day, req.as, status);
          if (applied.ok) return applied;
        }
        held = day;
      } else if (held.item.version !== target.version) {
        return answeredBefore(held, req.as, status);
      }
      const id = segment(held.item.id);
      if (id === null) return refused("not_found");
      const tag = typeof held.raw.etag === "string" ? held.raw.etag : "";
      if (!sendableTag(tag)) return refused("version_unknown");
      const { people, own } = linesOf(held.raw, req.as);
      if (own < 0) return refused(googleSelfAttendee(people) === undefined ? "not_found" : "version_stale");
      const body = {
        attendeesOmitted: true,
        attendees: [{ email: people[own]!.email, responseStatus: status }],
      };
      const res = await send(signedIn.token, "PATCH", `${events}/${id}?${NOTIFY}`, body, signal, {
        kind: "unchanged",
        tag,
      });
      if ("ok" in res) return res;
      if (res.status === 412) {
        const again = await read(signedIn.token, events, id, signal);
        if ("ok" in again) return again;
        return again.status === 200
          ? answeredBefore(itemOf(again), req.as, status)
          : refusalOf(again, "event_gone");
      }
      if (res.status !== 200) return refusalOf(res, "event_gone");
      const after = itemOf(res);
      return after === null ? refused("unreadable") : wrote(after.item === null ? [] : [after.item]);
    },

    async endSeries(c, cal, target, req, signal) {
      if (!target.recurringSeries || target.occurrence === null || req.then === null)
        return refused("repeat_unsupported");
      const events = eventsOf(cal);
      const masterId = segment(target.id);
      const id = writeId(req.then.key);
      if (events === null || masterId === null || id === null) return refused("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const { token } = signedIn;
      const master = await readEvent(token, events, target.id, signal);
      if ("ok" in master) return master;
      if (!seriesHead(master, target)) return refused("version_stale");
      const split = splitBoundary(master, target);
      if (split === null) return refused("repeat_unsupported");
      const next = continuationBody(master, target, req.then);
      if ("ok" in next) return next;
      const { createdVersion, rememberCreatedVersion } = req.then;
      if (master.item.version !== target.version || req.late) {
        if (!req.mayBeDone || !split.trimmed || privateProperties(master.raw)[SPLIT_KEY] !== id)
          return refused("version_stale");
        const continued = await recoverContinuation(
          token,
          events,
          id,
          master,
          target,
          next,
          signal,
          createdVersion,
        );
        return "ok" in continued
          ? continued
          : finishSplit(token, events, target, master, continued, false, signal, req.late);
      }
      if (!split.hasDay) return refused("version_stale");
      if (!sendableTag(master.item.version)) return refused("version_unknown");
      let made: { readonly held: HeldEvent; readonly tag: string | null };
      if (createdVersion !== undefined) {
        const held = await readContinuation(token, events, id, signal);
        if ("ok" in held) return held;
        if (held.item.version !== createdVersion) return refused("version_stale");
        made = { held, tag: createdVersion };
      } else {
        const selected =
          target.exception === undefined
            ? await readInstance(token, events, master, target.occurrence, signal)
            : await readReviewedException(token, events, master, target, signal);
        if ("ok" in selected) return selected;
        if (!validSeriesAudience(selected, target)) return refused("version_stale");
        if (target.exception && selected.item.version !== target.exception.version)
          return refused("version_stale");
        const index = await readSeriesIndex(token, events, [target.id], signal);
        if ("ok" in index) return index;
        if (index.versions.get(target.id) !== target.version) return refused("version_stale");
        const blocked = splitExceptionRefusal(index, master, target);
        if (blocked !== null) return blocked;
        const original = await readEvent(token, events, target.id, signal);
        if ("ok" in original) return original;
        if (original.item.version !== target.version || !seriesHead(original, target))
          return refused("version_stale");
        const inserted = await insertContinuation(token, events, id, next.body, signal);
        if ("ok" in inserted) return inserted;
        made = inserted;
      }
      if (!holdsContinuation(made.held, target, next)) return refused("version_stale");
      if (createdVersion === undefined && made.tag !== null) {
        const remembered = await rememberSplitVersion(rememberCreatedVersion, made.tag);
        if (remembered !== true) return remembered;
      }
      // Exceptions on either series can appear while the insert is in flight without moving its master tag.
      const version = made.held.item.version;
      const index = await readSeriesIndex(token, events, [target.id, id], signal);
      if ("ok" in index) return index;
      if (!splitUnchanged(index, target, id, version)) return refused("version_stale");
      const blocked = splitExceptionRefusal(index, master, target);
      if (blocked !== null)
        return made.tag === null
          ? blocked
          : rollbackContinuation(token, events, id, made.tag, blocked, rememberCreatedVersion, signal);
      const res = await send(
        token,
        "PATCH",
        `${events}/${masterId}?${NOTIFY}`,
        {
          recurrence: [`RRULE:${formatRRule(split.ended)}`],
          extendedProperties: withPrivateKeys(master.raw, { [SPLIT_KEY]: id, [SPLIT_VERSION]: version }),
        },
        signal,
        { kind: "unchanged", tag: master.item.version },
      );
      if ("ok" in res) return res;
      if (res.status !== 200)
        return settleRejectedEnd(
          token,
          events,
          target,
          id,
          next,
          made.tag,
          rememberCreatedVersion,
          res,
          signal,
        );
      const raw = jsonOf(res.body);
      const ended = raw === null ? null : heldEvent(raw);
      return ended?.item.id === target.id &&
        privateProperties(ended.raw)[SPLIT_KEY] === id &&
        privateProperties(ended.raw)[SPLIT_VERSION] === version &&
        splitBoundary(ended, target)?.trimmed
        ? finishSplit(token, events, target, ended, made.held, true, signal)
        : refused("unknown");
    },

    async continueSeries(c, cal, req, signal) {
      const { from } = req;
      if (!from.recurringSeries || from.occurrence === null) return refused("repeat_unsupported");
      if (!req.requireExisting) return refused("version_stale");
      const events = eventsOf(cal);
      const id = writeId(req.key);
      if (events === null || id === null || id === from.id) return refused("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const { token } = signedIn;
      const master = await readEvent(token, events, from.id, signal);
      if ("ok" in master) return master;
      if (!seriesHead(master, from) || !splitBoundary(master, from)?.trimmed) return refused("version_stale");
      const split = privateProperties(master.raw)[SPLIT_KEY];
      if (split !== undefined && split !== id) return refused("version_stale");
      const next = continuationBody(master, from, req);
      if ("ok" in next) return next;
      const continued = await recoverContinuation(
        token,
        events,
        id,
        master,
        from,
        next,
        signal,
        req.createdVersion,
      );
      return "ok" in continued ? continued : answered([continued.item]);
    },

    async moveEvent(c, from, to, target, signal) {
      if (target.occurrence !== null) return refused("repeat_unsupported");
      const events = eventsOf(from);
      const id = segment(target.id);
      const destination = segment(to.id);
      if (events === null || id === null || destination === null) return refused("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      // The move endpoint has no conditional request. Recheck the version and audience immediately before it.
      const current = await readEvent(signedIn.token, events, target.id, signal);
      if ("ok" in current) return current;
      if (!isDefaultGoogleEvent(current.raw)) return refused("unsupported");
      if (current.item.version !== target.version || !target.audience) return refused("version_stale");
      if (target.recurringSeries) {
        if (!seriesHead(current, target)) return refused("version_stale");
        const verified = await checkExceptions(
          signedIn.token,
          events,
          target,
          { metadataOnly: false },
          signal,
        );
        if (verified !== true) return verified;
      } else if (current.item.audienceIncomplete || !sameAudience(target.audience, current.item.event)) {
        return refused("version_stale");
      }
      const res = await send(
        signedIn.token,
        "POST",
        `${events}/${id}/move?destination=${destination}&${NOTIFY}`,
        null,
        signal,
      );
      if ("ok" in res) return res;
      if (res.status !== 200) return refusalOf(res, "event_gone");
      const held = itemOf(res);
      return held === null ? refused("unreadable") : wrote(held.item === null ? [] : [held.item]);
    },
  };
}
