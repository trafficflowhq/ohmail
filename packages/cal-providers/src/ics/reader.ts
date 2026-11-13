/**
 * A subscription by address, read: one calendar file at an address a person typed. The address is
 * a secret (whoever has it reads the calendar), so it is asked for where the request is made and
 * stands in no answer, no token and no id.
 *
 * The file is a stranger's text. It leaves through the request port that was handed in, which
 * decides what may be fetched; it is read by the calendar core alone, under the core's ceilings;
 * and it is taken whole or not at all. A reading replaces the calendar's set: `mode` is always
 * `whole`, in one page.
 */
import {
  DEFAULT_LIMITS, MAX_CALENDAR_TEXT_CHARS, calendarInfo, componentsOf, exactSeconds, nominalDays, propertyOf, readCalendars, writeComponent,
  type CalEvent, type CalObject, type Component, type DroppedComponent, type Duration, type EventTime, type Limits, type Property, type ReadRefusal,
} from "@ohmail/cal-core";
import { MAX_CALENDAR_NAME_CHARS, MAX_COLOR_CHARS, MAX_FEED_ZONE_DEFINITIONS, MAX_URL_CHARS } from "../limits.js";
import type { Answer, CalendarReader, ChangeItem, ChangePage, Connection, LeftReason } from "../port.js";
import type { ProviderRefusal } from "../refusals.js";
import { retryAfterMs, textOf, type AdapterDeps, type HttpAnswer } from "../request/index.js";
import { addressKey, hashOf, heldInterval, keptValidator, stateOf, tokenOf, type FeedState } from "./validators.js";

export interface IcsLimits {
  /** The calendar reader's own ceilings. */
  readonly read: Limits;
  /**
   * Characters of zone definitions carried into the events' own objects, over one file. A
   * definition is written once in a file and named by any number of its events, so carrying it
   * with each of them multiplies it: this is what that may come to.
   */
  readonly maxZoneTextChars: number;
}

type Refused = Extract<Answer<never>, { ok: false }>;
const refuse = (reason: ProviderRefusal, retryAfterMs: number | null = null): Refused => ({ ok: false, reason, retryAfterMs });

/** The one calendar a subscription has. Its id says nothing: the address is the connection's. */
const CALENDAR_ID = "subscription";
/** What an event's own object says made it: this program, from a file's event. */
const PRODID = "-//ohmail//Calendar subscription//EN";
const ACCEPT = "text/calendar, text/plain;q=0.5, */*;q=0.1";
const SCHEME = /^(webcals?|https?):\/\//i;
const MS_PER_SECOND = 1000;
const SECONDS_PER_DAY = 86_400;

/** The calendar reader's refusals that say "more than is read"; its others say "not readable". */
const TOO_MUCH: ReadonlySet<ReadRefusal> = new Set(["too_large", "too_many_lines", "too_many_parts", "line_too_long", "too_many_parameters", "too_many_components", "too_deep"]);

/**
 * The addresses to ask for what was typed, in order; `null` for what is no address of a calendar.
 * `webcal` only ever meant "fetch this and subscribe", and is asked over https. An address typed
 * with http is asked as typed first: the request port lets that through for a person's own server
 * on the person's own network and for nothing else, and then it is asked over https.
 */
function addressesOf(typed: string): readonly string[] | null {
  if (typed.length > MAX_URL_CHARS) return null;
  const address = typed.trim();
  const scheme = SCHEME.exec(address);
  if (scheme === null) return null;
  const rest = address.slice(scheme[0].length);
  return scheme[1]!.toLowerCase() === "http" ? [`http://${rest}`, `https://${rest}`] : [`https://${rest}`];
}

/** A status that is no file, as a word. */
function refusalOf(status: number): ProviderRefusal {
  // The address is private, or the key in it was withdrawn: there is no password to ask for.
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 410) return "ended";
  if (status === 429 || status === 503) return "throttled";
  if (status >= 500) return "unavailable";
  if (status >= 300 && status < 400) return "redirect_invalid";
  if (status >= 200 && status < 300) return "not_a_calendar";
  return "unknown";
}

/** The file's wish for the time between two asks, held inside the floor and the ceiling; `null` when it states none that is a length of time. */
function refreshOf(wish: Duration | null): number | null {
  if (wish === null) return null;
  const ms = (nominalDays(wish) * SECONDS_PER_DAY + exactSeconds(wish)) * MS_PER_SECOND;
  return Number.isFinite(ms) && ms > 0 ? heldInterval(ms) : null;
}

const shown = (text: string | null, max: number): string | null => (text !== null && text.length <= max ? text : null);
const line = (name: string, value: string): Property => ({ name, params: [], value });

type Got =
  | { readonly kind: "refused"; readonly answer: Refused }
  /** Nothing to apply: a 304, or the text that was read last time. */
  | { readonly kind: "same"; readonly state: FeedState }
  | { readonly kind: "text"; readonly text: string; readonly state: Omit<FeedState, "refreshMs"> };

type ReadText = { readonly ok: true; readonly calendars: readonly CalObject[]; readonly dropped: readonly DroppedComponent[] } | Refused;

/** The reader with its ceilings named. `makeReader` is the door; a test lowers a ceiling here to see it hold. */
export function makeIcsReader(deps: AdapterDeps, limits: IcsLimits): CalendarReader {
  async function ask(c: Connection, since: FeedState | null, signal: AbortSignal): Promise<Got> {
    const addresses = c.credential.kind === "address" ? addressesOf(c.credential.url()) : null;
    if (addresses === null) return { kind: "refused", answer: refuse("address_invalid") };
    let answer: HttpAnswer = { arrived: false, reason: "address_invalid" };
    let from = "";
    for (const address of addresses) {
      from = addressKey(address);
      // A validator belongs to the address it came from.
      const validators = since !== null && since.from === from && (since.etag !== null || since.lastModified !== null) ? { etag: since.etag, lastModified: since.lastModified } : null;
      answer = await deps.http.request(address, { method: "GET", headers: { accept: ACCEPT }, body: null, auth: null, validators, signal });
      // Only an address this deployment does not fetch as typed is asked once more, over https. Never the other way round.
      if (answer.arrived || answer.reason !== "address_not_allowed") break;
    }
    if (!answer.arrived) return { kind: "refused", answer: refuse(answer.reason) };

    // After a redirect the answer's validators are another address's, and are not kept for this one.
    const etag = answer.hops === 0 ? keptValidator(answer.header("etag")) : null;
    const lastModified = answer.hops === 0 ? keptValidator(answer.header("last-modified")) : null;
    if (answer.status === 304) {
      // Without a reading before it there is nothing a 304 could mean.
      if (since === null) return { kind: "refused", answer: refuse("unreadable") };
      const mine = since.from === from;
      return { kind: "same", state: { from, etag: etag ?? (mine ? since.etag : null), lastModified: lastModified ?? (mine ? since.lastModified : null), hash: since.hash, refreshMs: since.refreshMs } };
    }
    if (answer.status !== 200) {
      const reason = refusalOf(answer.status);
      return { kind: "refused", answer: refuse(reason, reason === "throttled" || reason === "unavailable" ? retryAfterMs(answer, deps.clock) : null) };
    }
    const hash = hashOf(answer.body);
    if (since !== null && since.hash === hash) return { kind: "same", state: { from, etag, lastModified, hash, refreshMs: since.refreshMs } };
    return { kind: "text", text: textOf(answer.body), state: { from, etag, lastModified, hash } };
  }

  /** The text as the calendars it holds. What it is called on the way decides nothing: a text with no calendar in it is no calendar. */
  function calendarsOf(text: string): ReadText {
    const read = readCalendars(text, limits.read);
    if (read.ok) return read;
    if (read.reason === "not_a_calendar") return refuse("not_a_calendar");
    return { ...refuse(TOO_MUCH.has(read.reason) ? "too_large" : "unreadable"), read: read.reason };
  }

  /**
   * Every event as an item, with the stored object it belongs to: the events of one UID, and the
   * definition of each zone they name that only the file knows. `null` when the definitions
   * carried would come to more than they may.
   */
  function objectsOf(calendars: readonly CalObject[], dropped: readonly DroppedComponent[]): Pick<ChangePage, "items" | "left"> | null {
    // The file's definitions by name as written: a time names its zone letter for letter. Names are
    // at most a zone name long (the reader holds that), and no more than the first few are looked at.
    const defined = new Map<string, Component>();
    for (const calendar of calendars) {
      for (const zone of componentsOf(calendar.tree, "VTIMEZONE")) {
        const name = propertyOf(zone, "TZID")?.value.trim() ?? "";
        if (name !== "" && !defined.has(name) && defined.size < MAX_FEED_ZONE_DEFINITIONS) defined.set(name, zone);
      }
    }
    // A zone the platform knows is read by the platform's rules, which are kept current; a file's
    // copy of them is as old as the file. So only a definition nobody else has travels on.
    const carried = new Map<string, { readonly component: Component; readonly chars: number } | null>();
    const carry = (name: string): { readonly component: Component; readonly chars: number } | null => {
      const zone = defined.get(name);
      if (zone === undefined) return null;
      let held = carried.get(name);
      if (held === undefined) {
        const written = deps.zones.offsetAt(name, 0) === null ? writeComponent(zone) : null;
        held = written !== null && written.ok ? { component: zone, chars: written.text.length } : null;
        carried.set(name, held);
      }
      return held;
    };

    // By the UID as written, each at most a UID long (the reader holds that); no more of them than the text has events.
    const groups: { readonly uid: string | null; readonly events: CalEvent[] }[] = [];
    const byUid = new Map<string, number>();
    for (const calendar of calendars) {
      for (const event of calendar.events) {
        const at = event.uid === null ? undefined : byUid.get(event.uid);
        if (at !== undefined) groups[at]!.events.push(event);
        else {
          if (event.uid !== null) byUid.set(event.uid, groups.length);
          groups.push({ uid: event.uid, events: [event] });
        }
      }
    }

    const items: ChangeItem[] = [];
    const left: { id: string; reason: LeftReason }[] = dropped.map((d, i) => ({ id: `${d.name === "" ? "component" : d.name}#${i + 1}`, reason: d.reason }));
    let zoneChars = 0;
    for (const [nth, group] of groups.entries()) {
      const zones = new Set<Component>();
      const note = (t: EventTime | null): void => {
        const zone = t !== null && t.kind === "zoned" ? carry(t.tzid) : null;
        if (zone !== null && !zones.has(zone.component)) {
          zones.add(zone.component);
          zoneChars += zone.chars;
        }
      };
      for (const event of group.events) {
        note(event.start);
        note(event.end);
        note(event.recurrenceId);
        for (const time of event.excluded) note(time);
        for (const added of event.added) {
          note(added.start);
          note(added.end);
        }
      }
      if (zoneChars > limits.maxZoneTextChars) return null;
      const written = writeComponent({ name: "VCALENDAR", properties: [line("VERSION", "2.0"), line("PRODID", PRODID)], components: [...zones, ...group.events.map((e) => e.component)] });
      if (!written.ok) {
        left.push({ id: group.uid ?? `no-uid#${nth + 1}`, reason: "unreadable" });
        continue;
      }
      // A file's event has no version of its own: its text's hash says whether it changed.
      const version = hashOf(written.text);
      // An event with no UID is told from one reading to the next by nothing but its text.
      const id = group.uid ?? `no-uid:${version}`;
      for (const event of group.events) items.push({ kind: "upsert", id, version, event, text: written.text });
    }
    return { items, left };
  }

  const page = (unchanged: boolean, found: Pick<ChangePage, "items" | "left">, state: FeedState): Answer<ChangePage> => ({
    ok: true,
    value: { mode: "whole", unchanged, items: found.items, left: found.left, cursor: { kind: "end", token: tokenOf(state) }, expanded: null, refreshMs: state.refreshMs },
  });

  return {
    provider: "ics",

    // An address is not a sign-in: whether it opens is what a first look at the calendar says.
    async checkSignIn() {
      return refuse("unsupported");
    },

    async listCalendars(c, signal) {
      const got = await ask(c, null, signal);
      if (got.kind === "refused") return got.answer;
      if (got.kind === "same") return refuse("unreadable");
      const read = calendarsOf(got.text);
      if (!read.ok) return read;
      const info = calendarInfo(read.calendars[0]!);
      return { ok: true, value: [{ id: CALENDAR_ID, name: shown(info.name, MAX_CALENDAR_NAME_CHARS), color: shown(info.color, MAX_COLOR_CHARS), writable: false, byToken: false, zone: info.timezone }] };
    },

    async readChanges(c, _calendar, since, _page, signal) {
      const got = await ask(c, stateOf(since), signal);
      if (got.kind === "refused") return got.answer;
      if (got.kind === "same") return page(true, { items: [], left: [] }, got.state);
      const read = calendarsOf(got.text);
      if (!read.ok) return read;
      const found = objectsOf(read.calendars, read.dropped);
      if (found === null) return refuse("too_large");
      return page(false, found, { ...got.state, refreshMs: refreshOf(calendarInfo(read.calendars[0]!).refreshInterval) });
    },
  };
}

/** A subscription's reader. The request port handed in is the one for a host a person named. */
export const makeReader = (deps: AdapterDeps): CalendarReader => makeIcsReader(deps, { read: DEFAULT_LIMITS, maxZoneTextChars: MAX_CALENDAR_TEXT_CHARS });
