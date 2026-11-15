#!/usr/bin/env node
/**
 * A double of Microsoft Graph's calendar, for the bench. No Microsoft test account exists yet, so the
 * Microsoft adapter is tried against this: it answers as Microsoft's own pages say, call by call.
 *
 * It is a double and it is blind where the pages are: what a real mailbox does beyond them is not here.
 * Microsoft stays "built, not tried against Microsoft itself" until that trial.
 *
 *   node ms-double.mjs          listens on 127.0.0.1:8822, makes a token for this start, and writes
 *                               OHCAL_MS_DOUBLE_TOKEN and OHCAL_MS_GRAPH_BASE into .cal-bench.env (600)
 *   import { startMsDouble }    the same server inside a test process, on a port of its own
 *
 * Graph only. The sign-in (login.microsoftonline.com) is not doubled: the adapter takes a port that
 * hands it an access token, and here that token is the one made at start. Any other token gets the
 * documented 401. It never reads the accounts file and is never given a real token.
 *
 * What it answers (v1.0):
 *   GET    /me/calendars
 *   GET    /me/calendar/calendarView, /me/calendars/{id}/calendarView        ?startDateTime&endDateTime [$top $skip $select]
 *   GET    /me/calendarView/delta, /me/calendars/{id}/calendarView/delta      ?startDateTime&endDateTime | $skiptoken | $deltatoken
 *   GET    /me/events/{id}, /me/calendars/{id}/events/{id}                    a series master carries the rule
 *   GET    /me/events/{id}/instances                                         ?startDateTime&endDateTime
 *   POST   /me/events, /me/calendar/events, /me/calendars/{id}/events         201
 *   PATCH  .../events/{id}                                                   200; an occurrence becomes an exception
 *   DELETE .../events/{id}                                                   204
 *   POST   .../events/{id}/accept | tentativelyAccept | decline              202, no body
 * and, the double's own (same token): POST /__double/reset, /__double/expire-sync-state,
 * /__double/throttle {count, retryAfter}; GET /__double/state (counts).
 *
 * Read on Microsoft's pages on 2026-11-13: "event: delta", "Get incremental changes to events in a
 * calendar view", "List calendarView" (the delta round, the `@removed` shape, `Prefer: odata.maxpagesize`,
 * UTC unless `Prefer: outlook.timezone`, `$top` 1 to 1000, no `$select`/`$filter`/`$orderby`/`$search`/
 * `$expand` on delta). From before and not read again that day: the error bodies' codes, the 410 with
 * `Location` for a sync state that is gone, the 429 with `Retry-After`, the three answers' rules.
 * A query option the double does not implement gets 501 `DoubleDoesNotImplement`, never a quiet guess.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, closeSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(HERE, ".cal-bench.env");
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WINDOWS_ZONES = { UTC: "UTC", "W. Europe Standard Time": "Europe/Zurich", "Central Europe Standard Time": "Europe/Budapest", "GMT Standard Time": "Europe/London", "Pacific Standard Time": "America/Los_Angeles", "Eastern Standard Time": "America/New_York" };
const PATTERNS = ["daily", "weekly", "absoluteMonthly", "absoluteYearly"];
const DAY_MS = 86_400_000;
/** The tail that makes a date the start of its day in UTC. */
const UTC_MIDNIGHT = "T" + "00:00:00Z";

// ---------------------------------------------------------------------------------------------- time

function ianaOf(name) {
  if (WINDOWS_ZONES[name]) return WINDOWS_ZONES[name];
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return name;
  } catch {
    return undefined;
  }
}
function wallClock(ms, zone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}
function instantOf(local, zone) {
  const asUtc = Date.parse(local.slice(0, 19) + "Z");
  return asUtc - (Date.parse(wallClock(asUtc, zone) + "Z") - asUtc);
}
/** `startDateTime`/`endDateTime`: the offset in the value, UTC when it has none. */
function parseBound(value) {
  if (typeof value !== "string" || value === "") return NaN;
  return Date.parse(/(Z|[+-]\d{2}:\d{2})$/.test(value) ? value : value + "Z");
}
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// ---------------------------------------------------------------------------------------------- the mailbox

class Mailbox {
  constructor(seed, base) {
    this.seed = seed;
    this.base = base;
    this.generation = 0;
    this.reset();
  }

  reset() {
    this.generation++;
    this.rev = 1;
    this.sequence = 0;
    this.events = new Map();
    this.tombstones = [];
    this.throttle = { count: 0, retryAfter: 1 };
    this.counts = { requests: 0, invitationsSent: 0, updatesSent: 0, cancellationsSent: 0, answersSent: 0 };
    this.calendars = this.seed.calendars.map((c) => ({ ...c }));
    for (const e of this.seed.events) {
      if (e.seriesMasterId) this.#storeException(this.events.get(e.seriesMasterId), e.originalDate, e);
      else this.#store(e, e.calendarId, e.id);
    }
  }

  defaultCalendar() {
    return this.calendars.find((c) => c.isDefaultCalendar);
  }
  #touch(e) {
    e._rev = ++this.rev;
    e.changeKey = randomBytes(12).toString("base64");
    e.lastModifiedDateTime = stamp(Date.UTC(2026, 10, 13, 12, 0, this.rev));
    return e;
  }
  #zone(e) {
    return ianaOf(e.start.timeZone) ?? "UTC";
  }

  #store(input, calendarId, id) {
    const me = { emailAddress: { name: this.seed.user.name, address: this.seed.user.address } };
    const isOrganizer = input.isOrganizer ?? true;
    const e = {
      id: id ?? `evt-${++this.sequence}-${randomBytes(6).toString("hex")}`,
      calendarId,
      createdDateTime: stamp(Date.UTC(2026, 10, 13, 12, 0, 0)),
      categories: input.categories ?? [],
      transactionId: input.transactionId ?? null,
      originalStartTimeZone: input.start.timeZone ?? "UTC",
      originalEndTimeZone: input.end.timeZone ?? "UTC",
      reminderMinutesBeforeStart: input.reminderMinutesBeforeStart ?? 15,
      isReminderOn: input.isReminderOn ?? true,
      hasAttachments: false,
      subject: input.subject ?? "",
      bodyPreview: input.bodyPreview ?? String(input.body?.content ?? "").replace(/<[^>]*>/g, "").slice(0, 255),
      body: input.body ?? { contentType: "html", content: input.bodyPreview ? `<p>${input.bodyPreview}</p>` : "" },
      importance: input.importance ?? "normal",
      sensitivity: input.sensitivity ?? "normal",
      isAllDay: input.isAllDay ?? false,
      isCancelled: false,
      isOrganizer,
      responseRequested: true,
      seriesMasterId: null,
      showAs: input.showAs ?? "busy",
      type: input.recurrence ? "seriesMaster" : "singleInstance",
      isOnlineMeeting: input.isOnlineMeeting ?? false,
      onlineMeetingProvider: input.isOnlineMeeting ? (input.onlineMeetingProvider ?? "teamsForBusiness") : "unknown",
      onlineMeeting: null,
      allowNewTimeProposals: input.allowNewTimeProposals ?? true,
      responseStatus: { response: isOrganizer ? "organizer" : "notResponded", time: "0001-01-01T00:00:00Z" },
      start: { dateTime: input.start.dateTime.slice(0, 19), timeZone: input.start.timeZone ?? "UTC" },
      end: { dateTime: input.end.dateTime.slice(0, 19), timeZone: input.end.timeZone ?? "UTC" },
      location: input.location ?? { displayName: "", locationType: "default", uniqueIdType: "unknown" },
      recurrence: input.recurrence ?? null,
      attendees: input.attendees ?? [],
      organizer: input.organizer ?? me,
      cancelledOccurrences: [],
    };
    e.iCalUId = `${e.id}@ms-double.example`;
    e.webLink = `https://outlook.ms-double.example/calendar/item/${encodeURIComponent(e.id)}`;
    if (e.isOnlineMeeting) e.onlineMeeting = { joinUrl: `https://teams.ms-double.example/l/meetup-join/${encodeURIComponent(e.id)}` };
    this.events.set(e.id, this.#touch(e));
    return e;
  }

  #storeException(master, originalDate, changes) {
    const o = this.#occurrence(master, originalDate);
    const zone = this.#zone(master);
    const e = { ...master, attendees: structuredClone(master.attendees), id: o.id, type: "exception", seriesMasterId: master.id, recurrence: null, cancelledOccurrences: [], _originalDate: originalDate, _originalStart: o.startMs };
    e.start = changes.start ?? { dateTime: wallClock(o.startMs, zone), timeZone: master.start.timeZone };
    e.end = changes.end ?? { dateTime: wallClock(o.endMs, zone), timeZone: master.end.timeZone };
    this.events.set(e.id, this.#touch(e));
    return e;
  }

  /** The local dates a series falls on, by its pattern and range. */
  #dates(master) {
    const { pattern, range } = master.recurrence;
    const first = Date.parse(range.startDate + UTC_MIDNIGHT);
    const limit = range.type === "numbered" ? range.numberOfOccurrences : 800;
    const last = range.type === "endDate" ? Date.parse(range.endDate + UTC_MIDNIGHT) : Infinity;
    const interval = pattern.interval ?? 1;
    const weekStart = DAYS.indexOf(pattern.firstDayOfWeek ?? "sunday");
    const weekOf = (ms) => Math.floor((ms / DAY_MS - ((new Date(ms).getUTCDay() - weekStart + 7) % 7)) / 7);
    const d0 = new Date(first);
    const out = [];
    for (let ms = first, guard = 0; out.length < limit && ms <= last && guard < 20_000; ms += DAY_MS, guard++) {
      const d = new Date(ms);
      const months = (d.getUTCFullYear() - d0.getUTCFullYear()) * 12 + d.getUTCMonth() - d0.getUTCMonth();
      let hit = false;
      if (pattern.type === "daily") hit = Math.round((ms - first) / DAY_MS) % interval === 0;
      else if (pattern.type === "weekly") hit = (weekOf(ms) - weekOf(first)) % interval === 0 && (pattern.daysOfWeek ?? [DAYS[d0.getUTCDay()]]).includes(DAYS[d.getUTCDay()]);
      else if (pattern.type === "absoluteMonthly") hit = months % interval === 0 && d.getUTCDate() === (pattern.dayOfMonth ?? d0.getUTCDate());
      else if (pattern.type === "absoluteYearly") hit = months % (12 * interval) === 0 && d.getUTCDate() === (pattern.dayOfMonth ?? d0.getUTCDate());
      if (hit) out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  #occurrence(master, date) {
    const zone = this.#zone(master);
    const startMs = instantOf(`${date}T${master.start.dateTime.slice(11, 19)}`, zone);
    const length = instantOf(master.end.dateTime, ianaOf(master.end.timeZone) ?? "UTC") - instantOf(master.start.dateTime, zone);
    return { id: `${master.id}.${date}`, date, startMs, endMs: startMs + length };
  }

  #span(e) {
    return { startMs: instantOf(e.start.dateTime, ianaOf(e.start.timeZone) ?? "UTC"), endMs: instantOf(e.end.dateTime, ianaOf(e.end.timeZone) ?? "UTC") };
  }

  /** Every single instance, occurrence and exception of a calendar, as { id, event, type, startMs, endMs, rev }. */
  instances(calendarId) {
    const out = [];
    for (const e of this.events.values()) {
      if (e.calendarId !== calendarId || e.type === "exception") continue;
      if (e.type === "singleInstance") out.push({ id: e.id, event: e, type: e.type, ...this.#span(e), rev: e._rev });
      else {
        for (const date of this.#dates(e)) {
          const o = this.#occurrence(e, date);
          if (e.cancelledOccurrences.includes(o.id)) continue;
          const x = this.events.get(o.id);
          if (x) out.push({ id: x.id, event: x, type: "exception", ...this.#span(x), originalStart: x._originalStart, rev: Math.max(x._rev, e._rev) });
          else out.push({ id: o.id, event: e, type: "occurrence", startMs: o.startMs, endMs: o.endMs, originalStart: o.startMs, rev: e._rev });
        }
      }
    }
    return out.sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
  }

  view(calendarId, fromMs, toMs) {
    return this.instances(calendarId).filter((i) => i.startMs < toMs && i.endMs > fromMs);
  }

  /** One of a calendar's days by its id: a stored event, or an occurrence nobody changed yet. */
  find(id) {
    const stored = this.events.get(id);
    if (stored) return { stored };
    const dot = id.lastIndexOf(".");
    const master = dot > 0 ? this.events.get(id.slice(0, dot)) : undefined;
    if (!master || master.type !== "seriesMaster" || master.cancelledOccurrences.includes(id)) return {};
    const instance = this.instances(master.calendarId).find((i) => i.id === id);
    return instance ? { master, instance } : {};
  }

  render(i, zoneName) {
    const e = i.event;
    const zone = zoneName ? ianaOf(zoneName) : undefined;
    const at = (ms, own) => (e.isAllDay ? { dateTime: `${own.dateTime}.0000000`, timeZone: own.timeZone } : zone ? { dateTime: `${wallClock(ms, zone)}.0000000`, timeZone: zoneName } : { dateTime: `${wallClock(ms, "UTC")}.0000000`, timeZone: "UTC" });
    const { calendarId: _c, cancelledOccurrences, _rev, _originalDate, _originalStart, ...shown } = e;
    return {
      "@odata.etag": `W/"${e.changeKey}"`,
      ...shown,
      id: i.id,
      type: i.type,
      seriesMasterId: i.type === "occurrence" || i.type === "exception" ? (e.type === "seriesMaster" ? e.id : e.seriesMasterId) : null,
      recurrence: i.type === "seriesMaster" ? e.recurrence : null,
      ...(i.type === "seriesMaster" ? { cancelledOccurrences } : {}),
      ...(i.originalStart !== undefined ? { originalStart: stamp(i.originalStart) } : {}),
      start: at(i.startMs, e.start),
      end: at(i.endMs, e.end),
    };
  }
  renderStored(e, zoneName) {
    return this.render({ id: e.id, event: e, type: e.type, ...this.#span(e), originalStart: e._originalStart }, zoneName);
  }

  create(calendarId, input) {
    if (input.transactionId) {
      const same = [...this.events.values()].find((e) => e.transactionId === input.transactionId);
      if (same) return same;
    }
    const e = this.#store(input, calendarId);
    if (e.attendees.length > 0) this.counts.invitationsSent++;
    return e;
  }

  update(id, patch) {
    const found = this.find(id);
    const e = found.stored ?? (found.instance ? this.#storeException(found.master, found.instance.id.slice(found.instance.id.lastIndexOf(".") + 1), {}) : undefined);
    if (!e) return undefined;
    for (const k of ["subject", "body", "categories", "importance", "sensitivity", "isAllDay", "showAs", "location", "attendees", "allowNewTimeProposals", "reminderMinutesBeforeStart", "isReminderOn"]) if (patch[k] !== undefined) e[k] = patch[k];
    for (const k of ["start", "end"]) if (patch[k]?.dateTime) e[k] = { dateTime: patch[k].dateTime.slice(0, 19), timeZone: patch[k].timeZone ?? e[k].timeZone };
    if (patch.body) e.bodyPreview = String(patch.body.content ?? "").replace(/<[^>]*>/g, "").slice(0, 255);
    if (patch.recurrence !== undefined && e.type !== "exception") {
      e.recurrence = patch.recurrence;
      e.type = patch.recurrence ? "seriesMaster" : "singleInstance";
    }
    if (patch.isOnlineMeeting === true && !e.isOnlineMeeting) {
      e.isOnlineMeeting = true;
      e.onlineMeetingProvider = patch.onlineMeetingProvider ?? "teamsForBusiness";
      e.onlineMeeting = { joinUrl: `https://teams.ms-double.example/l/meetup-join/${encodeURIComponent(e.id)}` };
    }
    if (e.attendees.length > 0 && e.isOrganizer) this.counts.updatesSent++;
    return this.#touch(e);
  }

  remove(id) {
    const found = this.find(id);
    const gone = (eventId, calendarId) => this.tombstones.push({ id: eventId, calendarId, rev: ++this.rev });
    if (found.stored && found.stored.type !== "exception") {
      const e = found.stored;
      if (e.type === "seriesMaster") for (const i of this.instances(e.calendarId).filter((x) => x.event === e || x.event.seriesMasterId === e.id)) gone(i.id, e.calendarId);
      else gone(e.id, e.calendarId);
      for (const x of [...this.events.values()]) if (x.seriesMasterId === e.id) this.events.delete(x.id);
      this.events.delete(e.id);
      if (e.attendees.length > 0 && e.isOrganizer) this.counts.cancellationsSent++;
      return true;
    }
    const master = found.master ?? (found.stored ? this.events.get(found.stored.seriesMasterId) : undefined);
    if (!master) return false;
    this.events.delete(id);
    master.cancelledOccurrences.push(id);
    master.changeKey = randomBytes(12).toString("base64");
    gone(id, master.calendarId);
    return true;
  }

  answer(e, kind, body) {
    e.responseStatus = { response: { accept: "accepted", tentativelyAccept: "tentativelyAccepted", decline: "declined" }[kind], time: stamp(Date.UTC(2026, 10, 13, 12, 0, this.rev + 1)) };
    for (const a of e.attendees) if (a.emailAddress?.address === this.seed.user.address) a.status = { ...e.responseStatus };
    if (body.sendResponse !== false) this.counts.answersSent++;
    this.#touch(e);
  }

  /** What a delta round hands over since `since`: removed first, then changed; everything when `since` is 0. */
  changes(calendarId, fromMs, toMs, since, zoneName) {
    const inView = this.view(calendarId, fromMs, toMs);
    if (since === 0) return inView.map((i) => ({ "@odata.type": "#microsoft.graph.event", ...this.render(i, zoneName) }));
    const ids = new Set(inView.map((i) => i.id));
    const removed = new Set(this.tombstones.filter((t) => t.calendarId === calendarId && t.rev > since).map((t) => t.id));
    // An event changed so that it left the range is handed over as removed, as Microsoft's page says.
    for (const i of this.instances(calendarId)) if (i.rev > since && !ids.has(i.id) && i.type !== "occurrence") removed.add(i.id);
    return [
      ...[...removed].filter((id) => !ids.has(id)).map((id) => ({ "@odata.type": "#microsoft.graph.event", id, "@removed": { reason: "deleted" } })),
      ...inView.filter((i) => i.rev > since).map((i) => ({ "@odata.type": "#microsoft.graph.event", ...this.render(i, zoneName) })),
    ];
  }
}

// ---------------------------------------------------------------------------------------------- the HTTP side

const encodeState = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function decodeState(token) {
  try {
    return JSON.parse(Buffer.from(String(token), "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function handler(box, token, hosts, log) {
  return async (req, res) => {
    const requestId = randomUUID();
    const send = (status, body, headers = {}) => {
      const text = body === undefined ? "" : JSON.stringify(body);
      res.writeHead(status, { ...(text ? { "Content-Type": "application/json;odata.metadata=minimal;odata.streaming=true;IEEE754Compatible=false;charset=utf-8" } : {}), "OData-Version": "4.0", "request-id": requestId, "client-request-id": requestId, ...headers });
      res.end(text);
      return status;
    };
    const fail = (status, code, message, headers) => send(status, { error: { code, message, innerError: { date: stamp(Date.now()).slice(0, 19), "request-id": requestId, "client-request-id": requestId } } }, headers);

    const url = new URL(req.url, box.base);
    const done = (status, route) => log(`${req.method} ${route} ${status}`);
    if (!hosts.includes(req.headers.host ?? "")) return done(fail(421, "DoubleRefusesHost", "The double answers only on its own loopback address."), "refused-host");
    const sent = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (sent === undefined) return done(fail(401, "InvalidAuthenticationToken", "Access token is empty.", { "WWW-Authenticate": 'Bearer realm="", authorization_uri="https://login.microsoftonline.com/common/oauth2/authorize"' }), "no-token");
    if (sent !== token) return done(fail(401, "InvalidAuthenticationToken", "Access token validation failure.", { "WWW-Authenticate": 'Bearer realm="", authorization_uri="https://login.microsoftonline.com/common/oauth2/authorize", error="invalid_token"' }), "wrong-token");

    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return done(fail(400, "BadRequest", "Unable to read JSON request payload. Please ensure Content-Type header is set and payload is of valid JSON format."), "bad-json");
      }
    }
    const q = Object.fromEntries([...url.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
    const path = url.pathname;

    // The double's own switches.
    if (path.startsWith("/__double/")) {
      const what = path.slice("/__double/".length);
      if (req.method === "POST" && what === "reset") return (box.reset(), done(send(204), "double-reset"));
      if (req.method === "POST" && what === "expire-sync-state") return (box.generation++, done(send(204), "double-expire-sync-state"));
      if (req.method === "POST" && what === "throttle") return ((box.throttle = { count: Number(body.count ?? 1), retryAfter: Number(body.retryAfter ?? 1) }), done(send(204), "double-throttle"));
      if (req.method === "GET" && what === "state") return done(send(200, { ...box.counts, events: box.events.size, calendars: box.calendars.length, removed: box.tombstones.length }), "double-state");
      return done(fail(404, "DoubleHasNoSuchSwitch", "No such switch."), "double-unknown");
    }
    if (!path.startsWith("/v1.0/me/")) return done(fail(400, "BadRequest", `Resource not found for the segment '${path.split("/").filter(Boolean)[0] ?? ""}'.`), "outside-v1");

    box.counts.requests++;
    if (box.throttle.count > 0) {
      box.throttle.count--;
      return done(fail(429, "TooManyRequests", "Please retry again later.", { "Retry-After": String(box.throttle.retryAfter) }), "throttled");
    }

    const rest = path.slice("/v1.0/me".length);
    const prefer = String(req.headers.prefer ?? "");
    const zoneName = /outlook\.timezone="([^"]+)"/.exec(prefer)?.[1];
    if (zoneName && !ianaOf(zoneName)) return done(fail(400, "TimeZoneNotSupportedException", "A valid TimeZone value must be specified."), "bad-zone");
    const calendarOf = (id) => (id === undefined ? box.defaultCalendar() : box.calendars.find((c) => c.id === decodeURIComponent(id)));
    const notFound = (route) => done(fail(404, "ErrorItemNotFound", "The specified object was not found in the store."), route);
    const unsupported = (names, route) => {
      const used = Object.keys(q).filter((k) => k.startsWith("$") && !names.includes(k));
      return used.length > 0 ? done(fail(501, "DoubleDoesNotImplement", `The double does not implement: ${used.join(", ")}.`), route) : undefined;
    };
    const window = () => {
      const fromMs = parseBound(q.startdatetime);
      const toMs = parseBound(q.enddatetime);
      return Number.isNaN(fromMs) || Number.isNaN(toMs) ? undefined : { fromMs, toMs };
    };
    const noWindow = (route) => done(fail(400, "ErrorInvalidParameter", "This request requires a time window specified by the query string parameters StartDateTime and EndDateTime."), route);
    const select = (o) => (q.$select ? Object.fromEntries(Object.entries(o).filter(([k]) => k === "id" || k.startsWith("@") || q.$select.split(",").map((s) => s.trim()).includes(k))) : o);
    let m;

    // GET /me/calendars
    if (req.method === "GET" && rest === "/calendars") {
      if (unsupported([], "calendars")) return;
      const owner = { name: box.seed.user.name, address: box.seed.user.address };
      return done(send(200, { "@odata.context": `${box.base}/$metadata#users('me')/calendars`, value: box.calendars.map((c) => ({ ...c, changeKey: "double", owner, allowedOnlineMeetingProviders: ["teamsForBusiness"], defaultOnlineMeetingProvider: "teamsForBusiness", isTallyingResponses: c.isDefaultCalendar, isRemovable: !c.isDefaultCalendar, hexColor: "" })) }), "calendars");
    }

    // GET …/calendarView/delta
    if (req.method === "GET" && (m = /^(?:\/calendars\/([^/]+)|\/calendar)?\/calendarView\/delta$/.exec(rest))) {
      const route = "calendar-view-delta";
      const calendar = calendarOf(m[1]);
      if (!calendar) return notFound(route);
      const deltaUrl = `${box.base}/me${m[1] ? `/calendars/${m[1]}` : ""}/calendarView/delta`;
      const size = Math.max(1, Number(/odata\.maxpagesize=(\d+)/.exec(prefer)?.[1] ?? 50));
      const given = q.$skiptoken ?? q.$deltatoken;
      let state;
      if (given !== undefined) {
        state = decodeState(given);
        if (!state || state.g !== box.generation || state.c !== calendar.id) {
          const fresh = state?.s !== undefined ? `${deltaUrl}?startDateTime=${encodeURIComponent(stamp(state.s))}&endDateTime=${encodeURIComponent(stamp(state.e))}` : deltaUrl;
          return done(fail(410, "SyncStateNotFound", "The sync state generation is not found; a full synchronization is required.", { Location: fresh }), route);
        }
        if (q.$deltatoken !== undefined) state = { ...state, k: "skip", snap: box.rev, o: 0 };
      } else {
        const refused = ["$select", "$filter", "$orderby", "$search", "$expand"].filter((k) => q[k] !== undefined);
        if (refused.length > 0) return done(fail(400, "ErrorInvalidUrlQuery", `The following parameters are not supported with change tracking over the 'CalendarView' resource: '${refused.join(", ")}'.`), route);
        const w = window();
        if (!w) return noWindow(route);
        state = { k: "skip", g: box.generation, c: calendar.id, s: w.fromMs, e: w.toMs, since: 0, snap: box.rev, o: 0 };
      }
      const all = box.changes(calendar.id, state.s, state.e, state.since, zoneName);
      const page = all.slice(state.o, state.o + size);
      const more = state.o + size < all.length;
      const link = more ? { "@odata.nextLink": `${deltaUrl}?$skiptoken=${encodeState({ ...state, o: state.o + size })}` } : { "@odata.deltaLink": `${deltaUrl}?$deltatoken=${encodeState({ k: "delta", g: state.g, c: state.c, s: state.s, e: state.e, since: state.snap })}` };
      return done(send(200, { "@odata.context": `${box.base}/$metadata#Collection(event)`, ...link, value: page }), route);
    }

    // GET …/calendarView
    if (req.method === "GET" && (m = /^(?:\/calendars\/([^/]+)|\/calendar)?\/calendarView$/.exec(rest))) {
      const route = "calendar-view";
      const calendar = calendarOf(m[1]);
      if (!calendar) return notFound(route);
      if (unsupported(["$top", "$skip", "$select"], route)) return;
      const w = window();
      if (!w) return noWindow(route);
      const top = Number(q.$top ?? 10);
      const skip = Number(q.$skip ?? 0);
      if (!Number.isInteger(top) || top < 1 || top > 1000) return done(fail(400, "ErrorInvalidUrlQuery", "The value of $top must be between 1 and 1000."), route);
      const all = box.view(calendar.id, w.fromMs, w.toMs);
      const next = new URL(url.href);
      next.searchParams.set("$top", String(top));
      next.searchParams.set("$skip", String(skip + top));
      return done(send(200, { "@odata.context": `${box.base}/$metadata#users('me')/calendars('${calendar.id}')/calendarView`, value: all.slice(skip, skip + top).map((i) => select(box.render(i, zoneName))), ...(skip + top < all.length ? { "@odata.nextLink": next.href } : {}) }), route);
    }

    // POST …/events
    if (req.method === "POST" && (m = /^(?:\/calendars\/([^/]+)|\/calendar)?\/events$/.exec(rest))) {
      const route = "event-create";
      const calendar = calendarOf(m[1]);
      if (!calendar) return notFound(route);
      if (!calendar.canEdit) return done(fail(403, "ErrorAccessDenied", "Access is denied. Check credentials and try again."), route);
      if (!body.start?.dateTime || !body.end?.dateTime) return done(fail(400, "ErrorPropertyValidationFailure", "At least one property failed validation."), route);
      if (body.recurrence && !PATTERNS.includes(body.recurrence.pattern?.type)) return done(fail(501, "DoubleDoesNotImplement", "The double does not implement this recurrence pattern."), route);
      return done(send(201, { "@odata.context": `${box.base}/$metadata#users('me')/calendars('${calendar.id}')/events/$entity`, ...box.renderStored(box.create(calendar.id, body), zoneName) }), route);
    }

    // …/events/{id}[/accept|/tentativelyAccept|/decline|/instances]
    if ((m = /^(?:\/calendars\/([^/]+)|\/calendar)?\/events\/([^/]+)(?:\/(accept|tentativelyAccept|decline|instances))?$/.exec(rest))) {
      const id = decodeURIComponent(m[2]);
      const action = m[3];
      const found = box.find(id);
      const route = `event-${action ?? req.method.toLowerCase()}`;
      if (m[1] && !calendarOf(m[1])) return notFound(route);
      if (!found.stored && !found.instance) return notFound(route);
      const shown = () => (found.stored ? box.renderStored(found.stored, zoneName) : box.render(found.instance, zoneName));
      const stale = req.headers["if-match"] && found.stored && req.headers["if-match"] !== `W/"${found.stored.changeKey}"`;

      if (action === "instances" && req.method === "GET") {
        if (!found.stored || found.stored.type !== "seriesMaster") return done(fail(400, "ErrorInvalidRequest", "The event is not a series master."), route);
        const w = window();
        if (!w) return noWindow(route);
        const days = box.view(found.stored.calendarId, w.fromMs, w.toMs).filter((i) => i.event === found.stored || i.event.seriesMasterId === id);
        return done(send(200, { "@odata.context": `${box.base}/$metadata#users('me')/events('${id}')/instances`, value: days.map((i) => box.render(i, zoneName)) }), route);
      }
      if (action && req.method === "POST") {
        if (!found.stored) return done(fail(501, "DoubleDoesNotImplement", "The double does not answer for one occurrence that was never changed."), route);
        const e = found.stored;
        if (e.isOrganizer) return done(fail(400, "ErrorInvalidRequest", "Your request can't be completed. You can't respond to this meeting because you're the meeting organizer."), route);
        if (body.proposedNewTime && action === "accept") return done(fail(400, "ErrorInvalidRequest", "A new time can be proposed only with a tentative answer or a decline."), route);
        if (body.proposedNewTime && body.sendResponse === false) return done(fail(400, "ErrorInvalidRequest", "A new time proposal requires the response to be sent."), route);
        if (body.proposedNewTime && !e.allowNewTimeProposals) return done(fail(400, "ErrorInvalidRequest", "The organizer does not allow new time proposals for this event."), route);
        box.answer(e, action, body);
        return done(send(202), route);
      }
      if (action) return done(fail(405, "MethodNotAllowed", "The HTTP method is not allowed on this resource."), route);
      if (req.method === "GET") {
        if (unsupported(["$select"], route)) return;
        return done(send(200, { "@odata.context": `${box.base}/$metadata#users('me')/events/$entity`, ...select(shown()) }), route);
      }
      if (req.method === "PATCH") {
        if (stale) return done(fail(412, "ErrorIrresolvableConflict", "The send or update operation could not be performed because the change key passed in the request does not match the current change key for the item."), route);
        if (body.recurrence && !PATTERNS.includes(body.recurrence.pattern?.type)) return done(fail(501, "DoubleDoesNotImplement", "The double does not implement this recurrence pattern."), route);
        return done(send(200, { "@odata.context": `${box.base}/$metadata#users('me')/events/$entity`, ...box.renderStored(box.update(id, body), zoneName) }), route);
      }
      if (req.method === "DELETE") {
        if (stale) return done(fail(412, "ErrorIrresolvableConflict", "The send or update operation could not be performed because the change key passed in the request does not match the current change key for the item."), route);
        box.remove(id);
        return done(send(204), route);
      }
    }
    return done(fail(501, "DoubleDoesNotImplement", "The double does not implement this call."), "not-implemented");
  };
}

// ---------------------------------------------------------------------------------------------- start and stop

function writeEnv(pairs, drop = []) {
  const values = new Map();
  if (existsSync(ENV_FILE)) {
    for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) values.set(m[1], m[2]);
    }
  }
  for (const k of drop) values.delete(k);
  for (const [k, v] of Object.entries(pairs)) values.set(k, v);
  const tmp = `${ENV_FILE}.tmp-${process.pid}`;
  try {
    const fd = openSync(tmp, "w", 0o600);
    writeSync(fd, [...values].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}\n`).join(""));
    closeSync(fd);
    renameSync(tmp, ENV_FILE);
    chmodSync(ENV_FILE, 0o600);
  } catch (e) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw e;
  }
}

/**
 * Starts the double on 127.0.0.1. `port` 0 takes a free one (a test's own double).
 * Resolves to its Graph base address, its token, and `close()`.
 */
export function startMsDouble({ port = 8822, token = randomBytes(32).toString("base64url"), seedPath = join(HERE, "ms-seed.json"), log = () => {} } = {}) {
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  return new Promise((resolve, reject) => {
    const hosts = [];
    const box = new Mailbox(seed, "");
    const server = createServer((req, res) => handler(box, token, hosts, log)(req, res).catch(() => res.headersSent || (res.writeHead(500), res.end())));
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const at = server.address().port;
      hosts.push(`127.0.0.1:${at}`, `localhost:${at}`);
      box.base = `http://127.0.0.1:${at}/v1.0`;
      resolve({ base: box.base, origin: `http://127.0.0.1:${at}`, token, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const KEYS = ["OHCAL_MS_DOUBLE_TOKEN", "OHCAL_MS_GRAPH_BASE"];
  const double = await startMsDouble({ log: (line) => process.stdout.write(line + "\n") });
  writeEnv({ OHCAL_MS_DOUBLE_TOKEN: double.token, OHCAL_MS_GRAPH_BASE: double.base });
  process.stdout.write(`ms-double: listening on ${double.origin}; its token and base are in .cal-bench.env\n`);
  const stop = () => {
    writeEnv({}, KEYS);
    double.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
