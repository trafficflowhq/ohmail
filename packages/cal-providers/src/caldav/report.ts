/**
 * What is asked of a calendar home and of one calendar, and how the answers are read.
 *
 *   the home          PROPFIND, Depth 1: its children, of which the calendars for events are kept
 *   what changed      the sync report (RFC 6578): members with their tags, members that are gone,
 *                     a token; an answer the server cut short says so on the collection itself (507)
 *   everything        PROPFIND, Depth 1, for a calendar that keeps no token: members with their tags
 *   the objects       the multiget report (RFC 4791 section 7.9): the text of the members named
 *
 * Never asked: a query with a filter (one large provider refuses a filter on an identifier, and a
 * reader that needs one object reads the collection), and never the server's own expansion of a
 * series (it loses the rule and the zone).
 *
 * A report may name the collection it was asked of among its members, and an address outside the
 * collection; the first is no member, the second is listed as what it is and never fetched.
 */
import { DEFAULT_LIMITS, MAX_ZONE_NAME_CHARS, readCalendar } from "@ohmail/cal-core";
import { MAX_CALENDAR_NAME_CHARS, MAX_VALIDATOR_CHARS } from "../limits.js";
import type { CalendarInfo } from "../port.js";
import { addressOf, ask, bodyOf, isSelf, isUnder, propfindOf, refuse, sameMemberKey, scopeOf, xmlText, type Asked, type Refused, type Session } from "./ask.js";
import { APPLE_ICAL, CALDAV, CALENDARSERVER, DAV, childOf, childrenOf, propOf, type DavResponse, type Multistatus } from "./multistatus.js";

/** What a response that names no usable address is listed under: the start of what it wrote. */
const UNREADABLE_ADDRESS_CHARS = 256;

/* ── the home ────────────────────────────────────────────────────────────────────────────────────── */

const HOME = propfindOf(
  "<D:resourcetype/><D:displayname/><C:supported-calendar-component-set/><CS:getctag/><D:sync-token/><A:calendar-color/><D:current-user-privilege-set/><C:calendar-timezone-id/><C:calendar-timezone/>",
);
/** A colour as servers keep it: six digits, or eight with how opaque it is. */
const COLOUR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
/** The privileges that let a sign-in change a calendar's members (RFC 3744 section 3: `write` and `all` hold `write-content`). */
const WRITES = ["write-content", "write", "all"];

const textOf = (response: DavResponse, ns: string, local: string): string => propOf(response, ns, local)?.text.trim() ?? "";

/** A member's tag as the server wrote it, quotes and all: what a later change of the object is made conditional on. One longer than a validator may be is none. */
function entityTag(response: DavResponse): string | null {
  const tag = textOf(response, DAV, "getetag");
  return tag !== "" && tag.length <= MAX_VALIDATOR_CHARS ? tag : null;
}

/**
 * May the sign-in write here? A server that says nothing of privileges is one where a write is
 * tried: its refusal then is the "view only" answer, as it is where a privilege was withdrawn since.
 */
function writable(response: DavResponse): boolean {
  const set = propOf(response, DAV, "current-user-privilege-set");
  if (set === null) return true;
  return childrenOf(set, DAV, "privilege").some((p) => WRITES.some((name) => childOf(p, DAV, name) !== null));
}

/** The zone a calendar is meant to be read in: by its name where the server gives one (RFC 7809), else the name of the definition it keeps. */
function zoneOf(response: DavResponse): string | null {
  const named = textOf(response, CALDAV, "calendar-timezone-id");
  if (named !== "") return named.length <= MAX_ZONE_NAME_CHARS ? named : null;
  const definition = propOf(response, CALDAV, "calendar-timezone")?.text ?? "";
  if (definition.trim() === "") return null;
  const read = readCalendar(definition, DEFAULT_LIMITS);
  return read.ok ? (read.calendar.timezones[0]?.tzid ?? null) : null;
}

/** The home's children that are calendars for events (RFC 4791 sections 4.2 and 5.2.3), in the order the server lists them. */
export async function calendarsOf(s: Session, home: string): Promise<{ readonly ok: true; readonly calendars: readonly CalendarInfo[] } | Refused> {
  const asked = await ask(s, "PROPFIND", home, "1", HOME);
  if (!asked.ok) return refuse(asked.reason, asked.retryAfterMs);
  const scope = scopeOf(asked.url);
  const calendars: CalendarInfo[] = [];
  for (const response of asked.answer.responses) {
    const id = addressOf(response.href, asked.url);
    if (id === null || !isUnder(scope, id)) continue;
    const type = propOf(response, DAV, "resourcetype");
    // A scheduling inbox, a folder and a list someone else publishes are collections and no calendars.
    if (type === null || childOf(type, CALDAV, "calendar") === null) continue;
    // A calendar that says what it takes and does not take events is a list of tasks. One that does not say takes everything.
    const takes = propOf(response, CALDAV, "supported-calendar-component-set");
    if (takes !== null && !childrenOf(takes, CALDAV, "comp").some((c) => c.attributes.get("name")?.toUpperCase() === "VEVENT")) continue;
    const name = textOf(response, DAV, "displayname");
    const colour = textOf(response, APPLE_ICAL, "calendar-color");
    calendars.push({
      id,
      name: name !== "" && name.length <= MAX_CALENDAR_NAME_CHARS ? name : null,
      color: COLOUR.test(colour) ? colour.slice(0, 7).toLowerCase() : null,
      writable: writable(response),
      byToken: textOf(response, DAV, "sync-token") !== "",
      zone: zoneOf(response),
    });
  }
  return { ok: true, calendars };
}

/* ── one calendar's members ──────────────────────────────────────────────────────────────────────── */

export interface Listed {
  /** The member's address in one spelling: what it is known by, and what a listing is put in order by. */
  readonly id: string;
  /** The address as the server wrote it: what it is asked for by. */
  readonly written: string;
  /**
   * `changed`: there, with this tag. `removed`: the server says it is gone. `outside`: an address
   * that is not in the collection, or none at all. `refused`: the server names it with a status
   * that is neither.
   */
  readonly kind: "changed" | "removed" | "outside" | "refused";
  readonly tag: string | null;
}

export interface Listing {
  /** In the order of their ids, each id once. */
  readonly members: readonly Listed[];
  /** The sync token the answer hands back, or the collection's own tag for a listing by tags. `null` when the server gives none. */
  readonly token: string | null;
  /** The server cut the answer short: more is to come from `token` (RFC 6578 section 3.6). */
  readonly cut: boolean;
  /** The address that answered: members are asked for there. */
  readonly url: string;
}

type ListedAnswer = { readonly ok: true; readonly listing: Listing } | (Refused & { readonly status: number | null });

/**
 * An answer's responses told apart: the members, in order, and what the collection says of itself.
 * `skips`: a member that is none to list. The members are held by their addresses for this one
 * answer: no more of them than an answer may hold responses, none longer than an address may be.
 */
function membersOf(answer: Multistatus, url: string, skips: (member: DavResponse) => boolean): { readonly members: readonly Listed[]; readonly own: readonly DavResponse[] } {
  const scope = scopeOf(url);
  const members = new Map<string, Listed>();
  const own: DavResponse[] = [];
  for (const response of answer.responses) {
    const id = addressOf(response.href, url);
    if (id === null) {
      const start = response.href.slice(0, UNREADABLE_ADDRESS_CHARS);
      members.set(start, { id: start, written: response.href, kind: "outside", tag: null });
    } else if (isSelf(scope, id)) own.push(response);
    else if (!isUnder(scope, id)) members.set(id, { id, written: response.href, kind: "outside", tag: null });
    else if (response.status === 404 || response.status === 410) members.set(id, { id, written: response.href, kind: "removed", tag: null });
    else if (response.status !== null && (response.status < 200 || response.status > 299)) members.set(id, { id, written: response.href, kind: "refused", tag: null });
    else if (!skips(response)) members.set(id, { id, written: response.href, kind: "changed", tag: entityTag(response) });
  }
  return { members: [...members.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), own };
}

/** What changed since `token`, or everything from the empty one: the sync report, asked of the collection itself. */
export async function listBySync(s: Session, collection: string, token: string): Promise<ListedAnswer> {
  const body = bodyOf("D:sync-collection", `<D:sync-token>${xmlText(token)}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop>`);
  const asked = await ask(s, "REPORT", collection, "0", body);
  if (!asked.ok) return asked;
  const { members, own } = membersOf(asked.answer, asked.url, () => false);
  return { ok: true, listing: { members, token: asked.answer.syncToken, cut: own.some((self) => self.status === 507), url: asked.url } };
}

/** Every member with its tag, for a collection that keeps no token; `token` is the collection's own tag. */
export async function listByTags(s: Session, collection: string): Promise<ListedAnswer> {
  const asked = await ask(s, "PROPFIND", collection, "1", propfindOf("<D:getetag/><D:resourcetype/><CS:getctag/>"));
  if (!asked.ok) return asked;
  const isCollection = (member: DavResponse): boolean => {
    const type = propOf(member, DAV, "resourcetype");
    return type !== null && childOf(type, DAV, "collection") !== null;
  };
  const { members, own } = membersOf(asked.answer, asked.url, isCollection);
  const tag = own.map((self) => textOf(self, CALENDARSERVER, "getctag")).find((text) => text !== "") ?? null;
  return { ok: true, listing: { members, token: tag, cut: false, url: asked.url } };
}

/** The collection's own tag, which changes whenever a member does; `null` when the server keeps none. */
export async function tagOf(s: Session, collection: string): Promise<{ readonly ok: true; readonly tag: string | null } | Refused> {
  const asked = await ask(s, "PROPFIND", collection, "0", propfindOf("<CS:getctag/>"));
  if (!asked.ok) return refuse(asked.reason, asked.retryAfterMs);
  const scope = scopeOf(asked.url);
  for (const response of asked.answer.responses) {
    const id = addressOf(response.href, asked.url);
    if (id !== null && isSelf(scope, id)) return { ok: true, tag: textOf(response, CALENDARSERVER, "getctag") || null };
  }
  return { ok: true, tag: null };
}

/** A member as fetched: its text whole and the tag that came with it, or `gone` when the server no longer has it. */
export type Fetched = { readonly tag: string | null; readonly text: string } | "gone";

/** What a multiget answered of a member; `undefined` for one the answer does not hold. */
export type FoundMembers = (member: Listed) => Fetched | undefined;

/** The text of the members named. */
export async function fetchMembers(s: Session, collection: string, members: readonly Listed[]): Promise<{ readonly ok: true; readonly found: FoundMembers } | Extract<Asked, { ok: false }>> {
  const hrefs = members.map((m) => `<D:href>${xmlText(m.written)}</D:href>`).join("");
  const asked = await ask(s, "REPORT", collection, null, bodyOf("C:calendar-multiget", `<D:prop><D:getetag/><C:calendar-data/></D:prop>${hrefs}`));
  if (!asked.ok) return asked;
  const found = new Map<string, Fetched>();
  for (const response of asked.answer.responses) {
    const id = addressOf(response.href, asked.url);
    if (id === null) continue;
    if (response.status === 404 || response.status === 410) {
      found.set(sameMemberKey(id), "gone");
      continue;
    }
    // Only a text from a block that says 200 is one: the collection's own response, where a server writes it, has none.
    const data = propOf(response, CALDAV, "calendar-data");
    if (data !== null) found.set(sameMemberKey(id), { tag: entityTag(response), text: data.text });
  }
  // A member named with an address that is none was never asked for.
  return { ok: true, found: (member) => (member.kind === "changed" ? found.get(sameMemberKey(member.id)) : undefined) };
}
