/**
 * Google's calendar, read: who is signed in, the calendars, and one calendar's events by Google's
 * own token for what changed. A series comes as its rule, and each changed day as a record of its
 * own that names the day it replaces; nothing is expanded here and nothing is kept between calls.
 *
 * Every request names a fixed address of Google's with a calendar's or an event's id as one escaped
 * segment of its path, and leaves through the request port that was handed in. The short sign-in
 * comes from the connection's own port and is given to the request port for Google's API host alone.
 */
import { MAX_UID_CHARS, MAX_ZONE_NAME_CHARS } from "@ohmail/cal-core";
import { CURSOR_MAX_CHARS, MAX_CALENDAR_NAME_CHARS, MAX_COLOR_CHARS, MAX_MASTERS_PER_ROUND, MAX_PAGES_PER_CALL, MAX_PAGE_LIMIT, TOKEN_MAX_CHARS } from "../limits.js";
import { bearerOf, isRecord, jsonOf, MAX_PROVIDER_ID_CHARS, pathSegment, refuse, type Json, type Left, type Refused } from "../json-answers.js";
import type { Answer, CalendarInfo, CalendarReader, ChangeItem, ChangePage, Connection } from "../port.js";
import { retryAfterMs, type AdapterDeps } from "../request/index.js";
import { convertEvent } from "./convert.js";
import { GOOGLE_API_HOST, GOOGLE_CALENDAR_BASE } from "./hosts.js";

/**
 * The query of an event list, the same in every request of a reading. Google: "All other query
 * parameters should be the same as for the initial synchronization to avoid undefined behavior."
 * So the page's size is this constant too, whatever smaller size a caller asks for.
 */
const EVENT_QUERY = `singleEvents=false&showDeleted=true&maxResults=${MAX_PAGE_LIMIT}`;
const CALENDAR_LIST = `${GOOGLE_CALENDAR_BASE}/users/me/calendarList?maxResults=${MAX_PAGE_LIMIT}`;

/** Google's words for a quota that is spent, which it answers with 403 as often as with 429. */
const QUOTA_REASONS: ReadonlySet<string> = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded"]);
const ADDRESS_LIKE = /^[^\s@]+@[^\s@]+$/;

type Asked = { readonly ok: true; readonly json: Json } | (Refused & { readonly status: number | null });

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v !== "" && v.length <= max ? v : null);

function quotaSpent(body: Uint8Array): boolean {
  const error = jsonOf(body)?.error;
  const listed = isRecord(error) && Array.isArray(error.errors) ? error.errors : [];
  return listed.some((e) => isRecord(e) && typeof e.reason === "string" && QUOTA_REASONS.has(e.reason));
}

/**
 * A status that is no page, as a word. `continued`: the request named state of an earlier answer (a
 * token, a next page), which is what a 410 or a 400 is then about: the reading begins again.
 */
function refusalOf(status: number, body: Uint8Array, wait: number | null, continued: boolean): Refused {
  if (status === 401) return refuse("sign_in_refused");
  if (status === 403) return quotaSpent(body) ? refuse("throttled", wait) : refuse("forbidden");
  if (status === 404) return refuse("not_found");
  if (status === 410 || status === 400) return refuse(continued ? "token_gone" : status === 410 ? "not_found" : "unknown");
  if (status === 429) return refuse("throttled", wait);
  if (status >= 500) return refuse("unavailable", wait);
  return refuse("unknown");
}

export function makeReader(deps: AdapterDeps): CalendarReader {
  async function ask(token: string, url: string, continued: boolean, signal: AbortSignal): Promise<Asked> {
    const answer = await deps.http.request(url, {
      method: "GET",
      headers: { accept: "application/json" },
      body: null,
      auth: { credential: { kind: "bearer", token }, admits: (host) => host === GOOGLE_API_HOST, tlsOnly: true },
      validators: null,
      signal,
    });
    if (!answer.arrived) return { ...refuse(answer.reason), status: null };
    if (answer.status !== 200) return { ...refusalOf(answer.status, answer.body, retryAfterMs(answer, deps.clock), continued), status: answer.status };
    const json = jsonOf(answer.body);
    return json === null ? { ...refuse("unreadable"), status: 200 } : { ok: true, json };
  }

  /** The whole calendar list: its pages followed here, no more of them than one call may follow. */
  async function calendarList(c: Connection, signal: AbortSignal): Promise<{ readonly ok: true; readonly entries: readonly Json[] } | Refused> {
    const signedIn = await bearerOf(c, signal);
    if (!signedIn.ok) return signedIn;
    const entries: Json[] = [];
    let pageToken: string | null = null;
    let query = "";
    for (let page = 0; page < MAX_PAGES_PER_CALL; page++) {
      const answer: Asked = await ask(signedIn.token, CALENDAR_LIST + query, false, signal);
      if (!answer.ok) return refuse(answer.reason, answer.retryAfterMs);
      const items = answer.json.items ?? [];
      if (!Array.isArray(items)) return refuse("unreadable");
      if (items.length > MAX_PAGE_LIMIT) return refuse("too_large");
      for (const item of items) if (isRecord(item)) entries.push(item);
      const next = answer.json.nextPageToken;
      if (next === undefined) return { ok: true, entries };
      const named = typeof next === "string" && next !== "" && next.length <= CURSOR_MAX_CHARS ? pathSegment(next) : null;
      if (named === null) return refuse("unreadable");
      if (next === pageToken) return refuse("page_link_refused");
      pageToken = next as string;
      query = `&pageToken=${named}`;
    }
    // A list that goes on past what one call follows: the link to one more page is not taken.
    return refuse("page_link_refused");
  }

  return {
    provider: "google",

    async checkSignIn(c, signal) {
      const list = await calendarList(c, signal);
      if (!list.ok) return list;
      // The account is named by its primary calendar, whose id is the account's own address: no further permission is asked for a name.
      const primary = list.entries.find((e) => e.primary === true);
      const id = primary === undefined ? null : text(primary.id, MAX_PROVIDER_ID_CHARS);
      return { ok: true, value: { principal: id, addresses: id !== null && ADDRESS_LIKE.test(id) ? [id] : [] } };
    },

    async listCalendars(c, signal) {
      const list = await calendarList(c, signal);
      if (!list.ok) return list;
      const calendars: CalendarInfo[] = [];
      for (const e of list.entries) {
        const id = text(e.id, MAX_PROVIDER_ID_CHARS);
        // A calendar that shows only when its owner is busy holds no event that could be read.
        if (id === null || e.deleted === true || e.accessRole === "freeBusyReader") continue;
        calendars.push({
          id,
          name: text(e.summaryOverride, MAX_CALENDAR_NAME_CHARS) ?? text(e.summary, MAX_CALENDAR_NAME_CHARS),
          color: text(e.backgroundColor, MAX_COLOR_CHARS),
          writable: e.accessRole === "owner" || e.accessRole === "writer",
          byToken: true,
          zone: text(e.timeZone, MAX_ZONE_NAME_CHARS),
        });
      }
      return { ok: true, value: calendars };
    },

    async readChanges(c, cal, since, page, signal): Promise<Answer<ChangePage>> {
      const calendar = cal.id === "" || cal.id.length > MAX_PROVIDER_ID_CHARS ? null : pathSegment(cal.id);
      if (calendar === null) return refuse("not_found");
      // A token of another provider's reading, or one no reading of Google's gave out, names no state of Google's.
      const from = since === null ? "" : since.provider === "google" && since.value !== "" && since.value.length <= TOKEN_MAX_CHARS ? pathSegment(since.value) : null;
      const at = page.cursor === null ? "" : page.cursor !== "" && page.cursor.length <= CURSOR_MAX_CHARS ? pathSegment(page.cursor) : null;
      if (from === null || at === null) return refuse("token_gone");
      const signedIn = await bearerOf(c, signal);
      if (!signedIn.ok) return signedIn;

      const events = `${GOOGLE_CALENDAR_BASE}/calendars/${calendar}/events`;
      const url = `${events}?${EVENT_QUERY}${from === "" ? "" : `&syncToken=${from}`}${at === "" ? "" : `&pageToken=${at}`}`;
      const answer = await ask(signedIn.token, url, since !== null || page.cursor !== null, signal);
      if (!answer.ok) return refuse(answer.reason, answer.retryAfterMs);
      const records = answer.json.items ?? [];
      if (!Array.isArray(records)) return refuse("unreadable");
      if (records.length > MAX_PAGE_LIMIT) return refuse("too_large");
      // Where the reading goes on is settled before anything more is asked: a page that does not say is not read in part.
      const next = answer.json.nextPageToken;
      const token = answer.json.nextSyncToken;
      if (next !== undefined) {
        if (typeof next !== "string" || next === "" || next.length > CURSOR_MAX_CHARS || pathSegment(next) === null) return refuse("unreadable");
        if (next === page.cursor) return refuse("page_link_refused");
      } else if (token !== undefined && (typeof token !== "string" || token === "" || token.length > TOKEN_MAX_CHARS || pathSegment(token) === null)) return refuse("unreadable");

      const now = deps.clock.now();
      const items: ChangeItem[] = [];
      const left: Left[] = [];
      /** The UID of each series met, by Google's id of it: from the page itself, or asked for once. `null`: the series is gone. */
      const uidOf = new Map<string, string | null>();
      const converted = records.map((record) => convertEvent(record, deps.zones, now));
      for (const one of converted) {
        if (one.kind === "item" && one.item.kind === "upsert" && one.item.event.recurrenceId === null && one.item.event.uid !== null) uidOf.set(one.item.id, one.item.event.uid);
      }
      let asked = 0;
      for (const one of converted) {
        if (one.kind === "left") left.push(one.left);
        else if (one.kind === "item") items.push(one.item);
        else {
          // A cancelled day is known by its series' UID. Google names the series by its own id and writes the UID only sometimes.
          let uid = one.uid ?? uidOf.get(one.masterId);
          if (uid === undefined) {
            if (++asked > MAX_MASTERS_PER_ROUND) return refuse("too_large");
            const series = await ask(signedIn.token, `${events}/${one.masterSegment}`, false, signal);
            if (!series.ok && series.status !== 404 && series.status !== 410) return refuse(series.reason, series.retryAfterMs);
            // A series that is gone takes its days with it: its own removal says so, and this day needs no word.
            uid = series.ok && series.json.status !== "cancelled" ? (text(series.json.iCalUID, MAX_UID_CHARS) ?? one.masterId) : null;
            uidOf.set(one.masterId, uid);
          }
          if (uid !== null) items.push({ kind: "cancelled_occurrence", uid, originalStart: one.originalStart });
        }
      }

      return {
        ok: true,
        value: {
          // From no token Google hands the calendar whole, over as many pages as it takes: what none of them names is gone.
          mode: since === null ? "whole" : "delta",
          unchanged: false,
          items,
          left,
          cursor: typeof next === "string" ? { kind: "more", value: next } : { kind: "end", token: typeof token === "string" ? { provider: "google", value: token } : null },
          expanded: null,
          refreshMs: null,
        },
      };
    },
  };
}
