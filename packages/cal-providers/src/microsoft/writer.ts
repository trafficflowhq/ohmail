/**
 * Microsoft's calendar by Graph, written: a new event under a `transactionId` made from the write's
 * own key (Graph's own guard: the same id hands the first event back), a change and a removal
 * against the tag a reading stored (`If-Match`), and the account's own answer by Graph's three
 * answer calls. Built from Microsoft's own pages and tried against the bench's double; not tried
 * against Microsoft itself, and behind Microsoft's own switch. Graph sends invitations itself.
 *
 * Not written here: a series (its rule is Graph's pattern, round-tripped against the reader's but
 * proven nowhere), a pasted call link and more than one reminder (Graph keeps neither as written),
 * and notes over a body in markup (the reader reads such a body as Graph's plain preview, so a
 * change of it would replace what the person never saw).
 */
import type { EventTime } from "@ohmail/cal-core";
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
  type HttpMethod,
  type HttpResponse,
  type Precondition,
} from "../request/index.js";
import { alreadyHolds } from "../write-compare.js";
import { recordOf } from "./convert.js";
import { graphBaseOf } from "./graph.js";
import { graphAuthorization, type MicrosoftDeps } from "./reader.js";

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

  /** Where a write's version is no tag, or a change touches notes: the event read once, compared, and its tag. */
  async function standing(
    token: string,
    id: string,
    target: WriteTarget,
    notes: boolean,
    signal: AbortSignal,
  ): Promise<Precondition | Refusal> {
    if (sendableTag(target.version) && !notes) return { kind: "unchanged", tag: target.version };
    const now = await read(token, id, signal);
    if ("ok" in now) return now;
    if (now.status !== 200) return refusalOf(now, "event_gone");
    const held = itemOf(now);
    if (held === null || held.item === null || held.item.kind !== "upsert") return refused("version_unknown");
    if (held.item.version !== target.version) return refused("version_stale");
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

  return {
    provider: "microsoft",

    async create(
      c: Connection,
      cal: CalendarRef,
      req: { readonly key: WriteKey; readonly event: EventDraft },
      signal: AbortSignal,
    ): Promise<WriteAnswer> {
      const calendar = segment(cal.id);
      const transactionId = transactionOf(req.key);
      if (calendar === null || transactionId === null) return refused("not_found");
      const body = bodyOf(req.event);
      if (typeof body === "string") return refused(body);
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
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
      // One day of a series is not written by this writer yet, and is never written as the series whole.
      if (target.occurrence !== null) return refused("repeat_unsupported");
      const id = segment(target.id);
      if (id === null) return refused("not_found");
      const body = bodyOf(change);
      if (typeof body === "string") return refused(body);
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
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
      if (target.occurrence !== null) return refused("repeat_unsupported");
      const id = segment(target.id);
      if (id === null) return refused("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      const pre = await standing(signedIn.token, id, target, false, signal);
      if ("ok" in pre) return pre.reason === "event_gone" ? answered([{ kind: "gone", id: target.id }]) : pre;
      const res = await send(signedIn.token, "DELETE", eventUrl(id), null, signal, pre);
      if ("ok" in res) return res;
      if (res.status === 204 || res.status === 200) return wrote([{ kind: "gone", id: target.id }]);
      if (res.status === 404 || res.status === 410) return answered([{ kind: "gone", id: target.id }]);
      if (res.status === 412) return afterStale(signedIn.token, id, target.id, null, signal);
      return refusalOf(res, "event_gone");
    },

    async answer(c, _cal, target, req: { readonly as: string; readonly reply: WriteReply }, signal) {
      // One day of a series is not written by this writer yet, and is never written as the series whole.
      if (target.occurrence !== null) return refused("repeat_unsupported");
      const id = segment(target.id);
      if (id === null) return refused("not_found");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;
      // Graph's answer calls take no precondition: the event is read first, and answered only as it was read.
      const now = await read(signedIn.token, id, signal);
      if ("ok" in now) return now;
      if (now.status !== 200) return refusalOf(now, "event_gone");
      const held = itemOf(now);
      if (held === null || held.item === null || held.item.kind !== "upsert") return refused("unreadable");
      if (held.item.version !== target.version) {
        // Another version: done where Graph already says this answer (an earlier attempt landed); else another copy.
        const said = isRecord(held.raw.responseStatus) ? held.raw.responseStatus.response : null;
        const wanted = { ACCEPTED: "accepted", TENTATIVE: "tentativelyAccepted", DECLINED: "declined" }[
          req.reply
        ];
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
      const shown = itemOf(after);
      return answered(shown === null || shown.item === null ? [] : [shown.item]);
    },

    // A series ended before one of its days is not written by this writer yet.
    async endSeries() {
      return refused("repeat_unsupported");
    },

    // Nor the days of a series from one of them on, as a series of their own.
    async continueSeries() {
      return refused("repeat_unsupported");
    },

    moveEvent: null,
  };
}
