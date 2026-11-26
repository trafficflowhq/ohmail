/**
 * Microsoft's calendar by Graph, read: who is signed in, the calendars, and one calendar's days in a
 * window by Graph's own change query. Graph hands the window's days over expanded; what leaves here is
 * each series once as its rule, each changed day as an event of its own, each single event, and for
 * every day of a series its identity alone. Nothing is kept between two calls.
 *
 * Built from Microsoft's pages and tried against a double made from them, not yet against Microsoft itself.
 * It is served only where the composing program names both its word and the base of its API.
 *
 * A token and a page cursor hold Graph's own link whole, with the window and the calendar the
 * reading was begun for: a token is spent for those and for nothing else, and a link is followed
 * only under the base this reader was made with.
 */
import { createHash } from "node:crypto";
import { instant, MS_PER_SECOND, wallFromSeconds } from "@ohmail/cal-core";
import { addressOf, bearerOf, filled, instantOfRfc3339, isRecord, jsonOf, leftOut, MAX_PROVIDER_ID_CHARS, pathSegment, refuse, type Json, type Left, type Refused } from "../json-answers.js";
import { CURSOR_MAX_CHARS, MAX_CALENDAR_NAME_CHARS, MAX_PAGES_PER_CALL, MAX_PAGE_LIMIT, MAX_URL_CHARS, TOKEN_MAX_CHARS } from "../limits.js";
import type { Answer, CalendarInfo, CalendarReader, ChangeItem, ChangePage, Connection, VerifiedEvent } from "../port.js";
import { retryAfterMs, type AdapterDeps, type Authorization, type HttpResponse } from "../request/index.js";
import { dayOfSeries, recordBounds, recordOf, selfResponseOf, seriesOfRecord, type SeriesClock } from "./convert.js";
import { graphBaseOf, insideBase, type GraphBase } from "./graph.js";

export interface MicrosoftDeps extends AdapterDeps {
  /** The base of Graph, named by the composing program: `MS_GRAPH_BASE` for Microsoft itself. No default. */
  readonly graphBase: string;
}

/** The last moment a window may name: the end of the year 9999, where the calendar's own arithmetic ends. */
const LAST_MOMENT_MS = 253_402_300_799_000;
/** Microsoft's code for a sync state it no longer keeps; compared without regard to letter case. */
const STATE_GONE = "syncstatenotfound";
/** How deep an error's codes are read: "apps should loop through all the nested error codes". Microsoft nests two or three. */
const ERROR_DEPTH = 8;
const VIEW_PAGE_LIMIT = 12;
const VIEW_SLICE_MS = 5_000;

function recordsDigest(records: readonly unknown[]): string {
  const sorted = JSON.stringify(records, (_key, value: unknown) => isRecord(value)
    ? Object.fromEntries(Object.keys(value).sort().map((name) => [name, value[name]]))
    : value);
  return createHash("sha256").update(sorted).digest("base64url");
}

/** Where a reading stands: Graph's link for what comes next, and the window and calendar it was begun for. */
interface Where {
  readonly startMs: number;
  readonly endMs: number;
  /** The calendar's id as the segment of a path. */
  readonly calendar: string;
  readonly link: string;
  readonly slice?: { readonly offset: number; readonly digest: string };
}

const pack = (w: Where): string => {
  const position = w.slice === undefined ? "" : `${w.slice.offset}:${w.slice.digest}:`;
  return `${w.startMs},${w.endMs},${w.calendar},${position}${w.link}`;
};

function unpack(value: string): Where | null {
  const a = value.indexOf(",");
  const b = a < 0 ? -1 : value.indexOf(",", a + 1);
  const c = b < 0 ? -1 : value.indexOf(",", b + 1);
  if (c < 0) return null;
  const [start, end, calendar, target] = [value.slice(0, a), value.slice(a + 1, b), value.slice(b + 1, c), value.slice(c + 1)];
  const position = /^(\d{1,3}):([A-Za-z0-9_-]{43}):/.exec(target);
  const link = position === null ? target : target.slice(position[0].length);
  const slice = position === null ? undefined : { offset: Number(position[1]), digest: position[2]! };
  if (slice !== undefined && (slice.offset < 1 || slice.offset >= MAX_PAGE_LIMIT)) return null;
  if (!/^\d{1,15}$/.test(start) || !/^\d{1,15}$/.test(end) || calendar === "" || link === "") return null;
  return windowOf(Number(start), Number(end)) === null ? null : { startMs: Number(start), endMs: Number(end), calendar, link, ...(slice && { slice }) };
}

/** The days asked for, where they are days: whole milliseconds, the first before the last, inside the calendar's years. */
function windowOf(startMs: number, endMs: number): { readonly startMs: number; readonly endMs: number } | null {
  return Number.isInteger(startMs) && Number.isInteger(endMs) && startMs >= 0 && startMs < endMs && endMs <= LAST_MOMENT_MS ? { startMs, endMs } : null;
}

/** A moment as Graph's query takes it: to the second, in UTC. */
export function stamp(ms: number): string {
  const w = wallFromSeconds(Math.floor(ms / MS_PER_SECOND));
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${String(w.year).padStart(4, "0")}-${two(w.month)}-${two(w.day)}T${two(w.hour)}:${two(w.minute)}:${two(w.second)}Z`;
}

/** Does an error's body name the sync state as gone, at any depth of its nested codes? */
function saysStateGone(body: Uint8Array): boolean {
  let error = jsonOf(body)?.error;
  for (let depth = 0; depth < ERROR_DEPTH && isRecord(error); depth++) {
    if (typeof error.code === "string" && error.code.toLowerCase() === STATE_GONE) return true;
    error = error.innererror ?? error.innerError;
  }
  return false;
}

/**
 * A status that is no page, as a word. The adapter leans on the status, and on one code of
 * Microsoft's only. `continued`: the request carried the state of an earlier answer (a token, a next
 * page), which is what a 410 or that code is then about. A 410's Location is never followed.
 */
function refusalOf(answer: HttpResponse, wait: number | null, continued: boolean): Refused {
  const { status } = answer;
  if (continued && (status === 410 || (status >= 400 && status < 500 && saysStateGone(answer.body)))) return refuse("token_gone");
  if (status === 401) return refuse("sign_in_refused");
  if (status === 403) return refuse("forbidden");
  if (status === 404 || status === 410) return refuse("not_found");
  // 429, and 509 for a spent bandwidth allowance; a busy service that names a wait asks to be left alone as well.
  if (status === 429 || status === 509 || (status === 503 && wait !== null)) return refuse("throttled", wait);
  if (status >= 500) return refuse("unavailable");
  return refuse("unknown");
}

type Asked = { readonly ok: true; readonly json: Json } | (Refused & { readonly status: number | null });
const present = (v: unknown): boolean => v !== undefined && v !== null;

interface ViewPage {
  readonly records: readonly unknown[];
  readonly link: string;
  readonly more: boolean;
}

type Upsert = Extract<ChangeItem, { kind: "upsert" }>;

const answerOf = { ACCEPTED: "accepted", TENTATIVE: "tentative", DECLINED: "declined", "NEEDS-ACTION": "none" } as const;

function verifiedRevision(
  raw: Json, items: readonly Upsert[], held: { readonly version: string | null; readonly answer: string | null } | undefined,
): Answer<VerifiedEvent> {
  const parked = { ok: true, value: { kind: "current", item: null, reread: true } } as const;
  const tag = filled(raw["@odata.etag"]);
  const key = filled(raw.changeKey);
  const sameVersion = (version: string | null) => version !== null && (version === tag || version === key);
  const modified = typeof raw.lastModifiedDateTime === "string" ? instantOfRfc3339(raw.lastModifiedDateTime) : null;
  const response = selfResponseOf(raw);
  const localAnswer = (value: Upsert["selfResponse"]) => value !== undefined && Object.hasOwn(answerOf, value)
    ? answerOf[value as keyof typeof answerOf] : null;
  const currentAnswer = localAnswer(response);
  const confirmed = items.find((item) => sameVersion(item.version) &&
    (item.selfResponse === undefined || item.selfResponse === response));
  for (const item of items) {
    if (item === confirmed) continue;
    const time = item.event.lastModified?.epochMs;
    if (modified !== null && time !== undefined) {
      if (time < modified) continue;
      if (time > modified) return parked;
    }
    // The stored revision can precede the new exact copy, even without comparable times.
    if (confirmed && held?.version === item.version &&
      (held.answer === null || localAnswer(item.selfResponse) === held.answer)) continue;
    // An unanswered list copy can lag a confirmed answer without any modification time.
    // An exact read returning a new unanswered copy is still accepted above.
    if (held?.answer && held.answer !== "none" && currentAnswer && currentAnswer !== "none" &&
      item.selfResponse === "NEEDS-ACTION") continue;
    return parked;
  }
  if (response === undefined && held?.answer && held.answer !== "none") return parked;
  const item = confirmed && response !== undefined ? { ...confirmed, selfResponse: response } : confirmed ?? null;
  // The exact copy can be ahead of the page. Its revision still needs to appear in a fresh window.
  const unlistedReply = item === null && currentAnswer !== null && currentAnswer !== held?.answer;
  return unlistedReply ? parked : { ok: true, value: { kind: "current", item } };
}

/**
 * The sign-in of one request to Graph: a short bearer, for the base's host alone, with TLS wherever
 * the base is named with it (Microsoft's own is; a double on this machine is named without). The
 * reader and the writer both make it here.
 */
export function graphAuthorization(token: string, base: GraphBase): Authorization {
  return { credential: { kind: "bearer", token }, admits: ({ host }) => host === base.host, tlsOnly: base.origin.startsWith("https:") };
}

/** A single default calendar identifies the authenticated Outlook account. */
function defaultOwner(entries: readonly Json[]): string | undefined {
  const primary = entries.filter((entry) => entry.isDefaultCalendar === true);
  const owner = primary.length === 1 ? primary[0]!.owner : null;
  return isRecord(owner) ? addressOf(owner.address) : undefined;
}

export function makeReader(deps: MicrosoftDeps): CalendarReader {
  // A base that is no address is a fault of the composing program: loud, and before any request.
  const base = graphBaseOf(deps.graphBase);
  const slices = new WeakMap<object, {
    request: string; digest: string; offset: number; view: ViewPage; series: Map<string, SeriesClock | null>;
  }>();

  async function ask(token: string, url: string, prefer: string | null, continued: boolean, signal: AbortSignal): Promise<Asked> {
    const answer = await deps.http.request(url, {
      method: "GET",
      headers: { accept: "application/json", ...(prefer === null ? {} : { prefer }) },
      body: null,
      auth: graphAuthorization(token, base),
      validators: null,
      signal,
    });
    if (!answer.arrived) return { ...refuse(answer.reason), status: null };
    if (answer.status !== 200) return { ...refusalOf(answer, retryAfterMs(answer, deps.clock), continued), status: answer.status };
    const json = jsonOf(answer.body);
    return json === null ? { ...refuse("unreadable"), status: 200 } : { ok: true, json };
  }

  /**
   * A link of Graph's for what comes next, or the word for one that is none or leaves the base.
   * `asked`: the page this one follows, which a next page may not be; `null` for the link of the next
   * reading, which is the one just spent whenever nothing changed.
   */
  function nextOf(link: unknown, asked: string | null): string | Refused {
    if (typeof link !== "string" || link === "" || link.length > MAX_URL_CHARS) return refuse("unreadable");
    return insideBase(link, base) && link !== asked ? link : refuse("page_link_refused");
  }

  async function viewPage(token: string, url: string, limit: number, continued: boolean, signal: AbortSignal): Promise<ViewPage | Refused> {
    const answer = await ask(token, url, `odata.maxpagesize=${limit}`, continued, signal);
    if (!answer.ok) return refuse(answer.reason, answer.retryAfterMs);
    const records = answer.json.value;
    if (!Array.isArray(records)) return refuse("unreadable");
    if (records.length > MAX_PAGE_LIMIT) return refuse("too_large");
    const [next, last] = [answer.json["@odata.nextLink"], answer.json["@odata.deltaLink"]];
    if (present(next) === present(last)) return refuse("unreadable");
    const more = present(next);
    const link = more ? nextOf(next, url) : nextOf(last, null);
    return typeof link === "string" ? { records, more, link } : link;
  }

  /** The whole list of calendars: its pages followed here, no more of them than one call may follow. */
  async function calendarList(c: Connection, signal: AbortSignal): Promise<{ readonly ok: true; readonly entries: readonly Json[] } | Refused> {
    const signedIn = await bearerOf(c, signal);
    if (!signedIn.ok) return signedIn;
    const entries: Json[] = [];
    let url = `${base.href}/me/calendars`;
    for (let page = 0; page < MAX_PAGES_PER_CALL; page++) {
      const answer = await ask(signedIn.token, url, null, false, signal);
      if (!answer.ok) return refuse(answer.reason, answer.retryAfterMs);
      const listed = answer.json.value;
      if (!Array.isArray(listed)) return refuse("unreadable");
      if (listed.length > MAX_PAGE_LIMIT) return refuse("too_large");
      for (const entry of listed) if (isRecord(entry)) entries.push(entry);
      if (!present(answer.json["@odata.nextLink"])) return { ok: true, entries };
      const next = nextOf(answer.json["@odata.nextLink"], url);
      if (typeof next !== "string") return next;
      url = next;
    }
    // A list that goes on past what one call follows: the link to one more page is not taken.
    return refuse("page_link_refused");
  }

  return {
    provider: "microsoft",

    async checkSignIn(c, signal) {
      const list = await calendarList(c, signal);
      if (!list.ok) return list;
      // The account is named by who owns its default calendar: the calendar's permission shows that, and no other is asked for a name.
      const address = defaultOwner(list.entries);
      return { ok: true, value: { principal: address ?? null, addresses: address === undefined ? [] : [address] } };
    },

    async listCalendars(c, signal) {
      const list = await calendarList(c, signal);
      if (!list.ok) return list;
      const self = defaultOwner(list.entries)?.toLowerCase();
      const calendars: CalendarInfo[] = [];
      for (const e of list.entries) {
        const id = filled(e.id);
        if (id === undefined || id.length > MAX_PROVIDER_ID_CHARS || pathSegment(id) === null) continue;
        const name = filled(e.name);
        // "If the user has never explicitly set a color for the calendar, this property is empty": a theme's name beside it is no colour.
        const color = typeof e.hexColor === "string" && /^#[0-9a-fA-F]{6}$/.test(e.hexColor) ? e.hexColor : null;
        const owned = self !== undefined && isRecord(e.owner) && addressOf(e.owner.address)?.toLowerCase() === self;
        calendars.push({ id, name: name === undefined || name.length > MAX_CALENDAR_NAME_CHARS ? null : name, color, writable: e.canEdit === true, ...(owned && { owned: true as const }), byToken: true, zone: null });
      }
      return { ok: true, value: calendars, principal: self ?? null };
    },

    async verifySelfResponse(c, cal, target, signal) {
      const calendar = pathSegment(cal.id);
      const id = pathSegment(target.id);
      if (!calendar || !id || [".", ".."].includes(calendar) || [".", ".."].includes(id)) return refuse("unreadable");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return refuse(signedIn.reason, signedIn.retryAfterMs);
      const current = await ask(signedIn.token, `${base.href}/me/calendars/${calendar}/events/${id}`, null, false, signal);
      if (!current.ok) {
        return current.status === 404 || current.status === 410
          ? { ok: true, value: { kind: "missing" } }
          : refuse(current.reason, current.retryAfterMs);
      }
      if (current.json.id !== target.id || current.json["@removed"] !== undefined) return refuse("unreadable");
      if (target.items.length > 0) return verifiedRevision(current.json, target.items, target.held);
      // A window can drop a live event that moved out of it. A master has no single window position.
      if (target.window === null || current.json.type === "seriesMaster") {
        return { ok: true, value: { kind: "reread" } };
      }
      const bounds = recordBounds(current.json, deps.zones);
      if (bounds === null) return { ok: true, value: { kind: "reread" } };
      const { start, end } = target.window;
      const outside = bounds.start >= end || (bounds.start < start && bounds.end <= start);
      return { ok: true, value: outside ? { kind: "outside" } : { kind: "current", item: null } };
    },

    async readChanges(c, cal, since, page, signal): Promise<Answer<ChangePage>> {
      const calendar = cal.id === "" || cal.id.length > MAX_PROVIDER_ID_CHARS ? null : pathSegment(cal.id);
      if (calendar === null) return refuse("not_found");
      const asked = page.window === null ? null : windowOf(page.window.start.epochMs, page.window.end.epochMs);
      const continued = page.cursor !== null || since !== null;
      let where: Where;
      if (continued) {
        const held = page.cursor !== null ? (page.cursor.length <= CURSOR_MAX_CHARS ? unpack(page.cursor) : null) : since !== null && since.provider === "microsoft" && since.value.length <= TOKEN_MAX_CHARS ? unpack(since.value) : null;
        // A token is spent for the calendar and the days it was given for. For any other it names no state: the caller reads those days whole.
        const sameDays = page.window === null || (asked !== null && held !== null && asked.startMs === held.startMs && asked.endMs === held.endMs);
        if (held === null || held.calendar !== calendar || !sameDays || (page.cursor === null && held.slice !== undefined)) return refuse("token_gone");
        // A link kept under another base is not followed. For a token that means a reading from the beginning under this one.
        if (!insideBase(held.link, base)) return refuse(page.cursor !== null ? "page_link_refused" : "token_gone");
        where = held;
      } else {
        // Graph's change query is over a window of days and has no form without one.
        if (asked === null) return refuse("unsupported");
        where = { ...asked, calendar, link: `${base.href}/me/calendars/${calendar}/calendarView/delta?startDateTime=${stamp(asked.startMs)}&endDateTime=${stamp(asked.endMs)}` };
      }
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;

      const limit = Math.min(Math.max(Math.trunc(page.limit) || 1, 1), VIEW_PAGE_LIMIT);
      const offset = where.slice?.offset ?? 0;
      const cached = page.scope === undefined ? undefined : slices.get(page.scope);
      const resumed = cached?.request === where.link && cached.offset === offset &&
        cached.digest === where.slice?.digest ? cached : undefined;
      const view = resumed?.view ?? await viewPage(signedIn.token, where.link, limit, continued, signal);
      if ("ok" in view) return view;
      const { records, link, more } = view;
      const kept = pack({ ...where, link, slice: undefined });
      if (kept.length > (more ? CURSOR_MAX_CHARS : TOKEN_MAX_CHARS)) return refuse("unreadable");

      const now = deps.clock.now();
      // Graph may reissue its opaque continuation when the same records are replayed. Only
      // changed records invalidate the saved offset. Follow the validated link from this response.
      const digest = resumed?.digest ?? (records.length > VIEW_PAGE_LIMIT || offset > 0 ? recordsDigest(records) : null);
      if (where.slice !== undefined && (offset >= records.length || where.slice.digest !== digest)) return refuse("token_gone");
      const items: ChangeItem[] = [];
      const left: Left[] = [];
      const seen: NonNullable<ChangePage["expanded"]>["seen"][number][] = [];
      const seriesOf = new Map(resumed?.series);
      let consumed = offset;
      for (const raw of records.slice(offset, offset + VIEW_PAGE_LIMIT)) {
        if (consumed > offset && deps.clock.now() - now >= VIEW_SLICE_MS) break;
        consumed += 1;
        const one = recordOf(raw, deps.zones, now);
        if (one.kind === "left") left.push(one.left);
        else if (one.kind === "item") items.push(one.item);
        else {
          let series = seriesOf.get(one.seriesId);
          if (series === undefined) {
            const master = await ask(signedIn.token, `${base.href}/me/calendars/${where.calendar}/events/${one.seriesSegment}`, null, false, signal);
            if (!master.ok && master.status !== 404 && master.status !== 410) return refuse(master.reason, master.retryAfterMs);
            // A series that is gone takes its days with it: Graph reports their removal itself.
            const made = master.ok ? seriesOfRecord(master.json, deps.zones, now) : null;
            if (typeof made === "string") left.push(leftOut(one.seriesId, made));
            else if (made !== null) items.push(made.item);
            series = made === null || typeof made === "string" ? null : made.series;
            seriesOf.set(one.seriesId, series);
          }
          if (series === null) continue;
          const day = dayOfSeries(one, series, deps.zones, now);
          if (day === null) left.push(leftOut(one.id, "unreadable"));
          else {
            seen.push({ ...day.seen, providerId: one.id });
            if (typeof day.item === "string") left.push(leftOut(one.id, day.item));
            else if (day.item !== null) items.push(day.item);
          }
        }
      }

      const slice = consumed < records.length
        ? { offset: consumed, digest: digest ?? recordsDigest(records) }
        : undefined;
      const partial = slice === undefined ? null : pack({ ...where, slice });
      if (partial !== null && partial.length > CURSOR_MAX_CHARS) return refuse("unreadable");
      if (page.scope !== undefined) {
        if (slice === undefined) slices.delete(page.scope);
        else slices.set(page.scope, { ...slice, request: where.link, view, series: seriesOf });
      }
      return {
        ok: true,
        value: {
          // From no token Graph hands over every day of the window: what the window held and no page names is gone.
          mode: since === null ? "whole" : "delta",
          unchanged: false,
          items,
          left,
          cursor: partial !== null || more
            ? { kind: "more", value: partial ?? kept } : { kind: "end", token: { provider: "microsoft", value: kept } },
          expanded: { window: { start: instant(where.startMs), end: instant(where.endMs) }, seen },
          refreshMs: null,
        },
      };
    },
  };
}
