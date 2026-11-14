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
import { formatRRule, type CalEvent, type EventTime } from "@ohmail/cal-core";
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
  WriteAnswer,
  WriteKey,
  WriteReply,
  WriteTarget,
} from "../port.js";
import type { ProviderRefusal, WriteRefusal } from "../refusals.js";
import {
  retryAfterMs,
  sendableTag,
  type AdapterDeps,
  type HttpMethod,
  type HttpResponse,
  type Precondition,
} from "../request/index.js";
import { alreadyHolds } from "../write-compare.js";
import { convertEvent } from "./convert.js";
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
const answered = (items: readonly ChangeItem[]): WriteAnswer => ({ ok: true, items });

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
 */
function bodyOf(f: EventChange, series: boolean): Json | "field_unwritable" {
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
    if (sendableTag(target.version)) return { kind: "unchanged", tag: target.version };
    const now = await read(token, events, id, signal);
    if ("ok" in now) return now;
    if (now.status !== 200) return refusalOf(now, "event_gone");
    const held = itemOf(now);
    if (held === null || held.item === null || held.item.kind !== "upsert") return refused("version_unknown");
    if (held.item.version !== target.version) return refused("version_stale");
    const tag = typeof held.raw.etag === "string" ? held.raw.etag : "";
    return sendableTag(tag) ? { kind: "unchanged", tag } : refused("version_unknown");
  }

  const eventsOf = (cal: CalendarRef): string | null => {
    const calendar = segment(cal.id);
    return calendar === null ? null : `${GOOGLE_CALENDAR_BASE}/calendars/${calendar}/events`;
  };

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
    const own = people.findIndex(
      (p) => p.self === true || (typeof p.email === "string" && p.email.toLowerCase() === wanted),
    );
    return { people, own };
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

    async create(
      c: Connection,
      cal: CalendarRef,
      req: { readonly key: WriteKey; readonly event: EventDraft },
      signal: AbortSignal,
    ): Promise<WriteAnswer> {
      const events = eventsOf(cal);
      // Google's own guard against a second event: an id it was given, which only this write's key makes.
      const id = /^[0-9a-f]{32}$/.test(req.key.hex) ? req.key.hex : null;
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
      return held === null ? refused("unreadable") : answered(held.item === null ? [] : [held.item]);
    },

    async change(c, cal, target, change, signal) {
      const events = eventsOf(cal);
      const id = segment(target.id);
      if (events === null || id === null) return refused("not_found");
      const body = bodyOf(change, change.rule !== undefined && change.rule !== null);
      if (body === "field_unwritable") return refused(body);
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const pre = await precondition(signedIn.token, events, id, target, signal);
      if ("ok" in pre) return pre;
      const res = await send(signedIn.token, "PATCH", `${events}/${id}?${NOTIFY}`, body, signal, pre);
      if ("ok" in res) return res;
      if (res.status === 412) return afterStale(signedIn.token, events, id, change, signal);
      if (res.status !== 200) return refusalOf(res, "event_gone");
      const held = itemOf(res);
      return held === null ? refused("unreadable") : answered(held.item === null ? [] : [held.item]);
    },

    async remove(c, cal, target, signal) {
      const events = eventsOf(cal);
      const id = segment(target.id);
      if (events === null || id === null) return refused("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const pre = await precondition(signedIn.token, events, id, target, signal);
      if ("ok" in pre) return pre.reason === "event_gone" ? answered([{ kind: "gone", id: target.id }]) : pre;
      const res = await send(signedIn.token, "DELETE", `${events}/${id}?${NOTIFY}`, null, signal, pre);
      if ("ok" in res) return res;
      // Gone already is what a removal wants.
      if (res.status === 200 || res.status === 204 || res.status === 404 || res.status === 410)
        return answered([{ kind: "gone", id: target.id }]);
      if (res.status === 412) return afterStale(signedIn.token, events, id, null, signal);
      return refusalOf(res, "event_gone");
    },

    async answer(c, cal, target, req: { readonly as: string; readonly reply: WriteReply }, signal) {
      const events = eventsOf(cal);
      const id = segment(target.id);
      if (events === null || id === null) return refused("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      // The answer is one invitee's line among all of them, so the event is read first and written back under that read's tag.
      const now = await read(signedIn.token, events, id, signal);
      if ("ok" in now) return now;
      if (now.status !== 200) return refusalOf(now, "event_gone");
      const held = itemOf(now);
      if (held === null || held.item === null || held.item.kind !== "upsert") return refused("unreadable");
      const status = { ACCEPTED: "accepted", TENTATIVE: "tentative", DECLINED: "declined" }[req.reply];
      if (held.item.version !== target.version) return answeredBefore(held, req.as, status);
      const tag = typeof held.raw.etag === "string" ? held.raw.etag : "";
      if (!sendableTag(tag)) return refused("version_unknown");
      const { people, own } = linesOf(held.raw, req.as);
      if (own < 0) return refused("not_found");
      const attendees = people.map((p, i) => (i === own ? { ...p, responseStatus: status } : p));
      const res = await send(signedIn.token, "PATCH", `${events}/${id}?${NOTIFY}`, { attendees }, signal, {
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
      return after === null ? refused("unreadable") : answered(after.item === null ? [] : [after.item]);
    },

    async moveEvent(c, from, to, target, signal) {
      const events = eventsOf(from);
      const id = segment(target.id);
      const destination = segment(to.id);
      if (events === null || id === null || destination === null) return refused("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
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
      return held === null ? refused("unreadable") : answered(held.item === null ? [] : [held.item]);
    },
  };
}
