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
import { MAX_CALENDAR_NAME_CHARS, MAX_PAGE_LIMIT, MAX_VALIDATOR_CHARS, TOKEN_MAX_CHARS } from "../limits.js";
import type { CalendarInfo } from "../port.js";
import { addressOf, ask, bodyOf, collectionOptions, davCapabilities, finding, isSelf, isUnder, knownAt, offersMove, offersScheduling, propfindOf, refuse, sameMemberKey, schedulingAnswer, scopeOf, xmlText, type Asked, type Refused, type Session } from "./ask.js";
import { APPLE_ICAL, CALDAV, CALENDARSERVER, DAV, childOf, childrenOf, propOf, type DavResponse } from "./multistatus.js";

/** What a response that names no usable address is listed under: the start of what it wrote. */

/* ── the home ────────────────────────────────────────────────────────────────────────────────────── */

const ACCESS = "<D:current-user-privilege-set/><D:share-access/>";
const COLLECTION_ACCESS = propfindOf(ACCESS);
/** Optional probes share a budget so a slow collection leaves time for reads and writes. */
const ACCESS_PROBE_BUDGET_MS = 5_000;
const HOME = propfindOf(
  "<D:resourcetype/><D:displayname/><C:supported-calendar-component-set/><CS:getctag/><D:sync-token/><A:calendar-color/>" + ACCESS + "<D:owner/><C:calendar-timezone-id/><C:calendar-timezone/>",
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

/** A grant to edit an existing calendar member. */
function writePrivilege(response: DavResponse): boolean | null {
  const set = propOf(response, DAV, "current-user-privilege-set");
  if (set === null) return null;
  const names = childrenOf(set, DAV, "privilege").flatMap((p) =>
    p.children.filter((grant) => grant.ns === DAV).map((grant) => grant.local));
  return WRITES.some((name) => names.includes(name));
}

function shareAccess(response: DavResponse): boolean | null {
  const share = propOf(response, DAV, "share-access");
  if (share === null) return null;
  if (childOf(share, DAV, "read") || childOf(share, DAV, "no-access")) return false;
  return childOf(share, DAV, "read-write") === null ? null : true;
}

/**
 * A signal that ends with `signal` or after `ms`, whichever comes first. Built from one controller and a timer, because not every
 * host that runs this has `AbortSignal.any` (the phone's engine, a browser test's window). `done` clears the timer and the listener.
 */
function withBudget(signal: AbortSignal, ms: number): { readonly signal: AbortSignal; readonly done: () => void } {
  const budget = new AbortController();
  const end = (): void => budget.abort();
  const timer = setTimeout(end, ms);
  if (signal.aborted) end();
  else signal.addEventListener("abort", end, { once: true });
  return {
    signal: budget.signal,
    done: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", end);
    },
  };
}

async function sharedWriteAccess(s: Session, id: string, fallback: boolean): Promise<boolean> {
  if (s.signal.aborted) return fallback;
  const asked = await ask(s, "PROPFIND", id, "0", COLLECTION_ACCESS);
  if (!asked.ok) return fallback;
  const scope = scopeOf(id);
  const own = asked.answer.responses.find((response) => {
    const address = addressOf(response.href, asked.url);
    return address !== null && isSelf(scope, address);
  });
  if (own === undefined) return fallback;
  const share = shareAccess(own);
  return share !== false && (writePrivilege(own) ?? share ?? fallback);
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

/** A home named by the signed-in principal may locate itself with a redirect. */
export const askHome = (s: Session, home: string) => ask(finding(s), "PROPFIND", home, "1", HOME);

/** The home's children that are calendars for events (RFC 4791 sections 4.2 and 5.2.3), in the order the server lists them. */
export async function calendarsOf(s: Session, home: string, principal: string): Promise<{ readonly ok: true; readonly calendars: readonly CalendarInfo[] } | Refused> {
  const asked = await askHome(s, home);
  if (!asked.ok) return refuse(asked.reason, asked.retryAfterMs);
  const scope = scopeOf(asked.url);
  const calendars: CalendarInfo[] = [];
  const needsAccess = new Set<string>();
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
    const ownerHref = propOf(response, DAV, "owner");
    const owner = ownerHref && childOf(ownerHref, DAV, "href");
    const ownerUrl = owner && addressOf(owner.text.trim(), asked.url);
    const owned = ownerUrl !== null && isSelf(scopeOf(principal), ownerUrl);
    const share = shareAccess(response);
    const privilege = writePrivilege(response);
    const shared = share !== null || (ownerUrl !== null && !owned) || childOf(type, CALENDARSERVER, "shared") !== null;
    if (shared && share !== false && privilege !== true) needsAccess.add(id);
    // When the server gives no access data, let it decide each write as before.
    const canWrite = share !== false && (privilege ?? share ?? true);
    calendars.push({
      id,
      name: name !== "" && name.length <= MAX_CALENDAR_NAME_CHARS ? name : null,
      color: COLOUR.test(colour) ? colour.slice(0, 7).toLowerCase() : null,
      writable: canWrite,
      ...(owned && { owned: true as const }),
      byToken: textOf(response, DAV, "sync-token") !== "",
      zone: zoneOf(response),
    });
  }
  if (needsAccess.size > 0) {
    const budget = withBudget(s.signal, ACCESS_PROBE_BUDGET_MS);
    const probe = { ...s, signal: budget.signal };
    const shared = calendars.flatMap((cal, index) => needsAccess.has(cal.id) ? [{ cal, index }] : []);
    try {
      for (let i = 0; i < shared.length; i += 4) {
        await Promise.all(shared.slice(i, i + 4).map(async ({ cal, index }) => {
          const writable = await sharedWriteAccess(probe, cal.id, cal.writable);
          calendars[index] = { ...cal, writable };
        }));
      }
    } finally {
      budget.done();
    }
  }
  for (let i = 0; i < calendars.length; i += 4) {
    await Promise.all(calendars.slice(i, i + 4).map(async (cal, index) => {
      if (!cal.writable) return;
      const options = await collectionOptions(s, cal.id);
      const answer = await schedulingAnswer(s, cal.id, options);
      const autoSchedule = !answer.arrived || answer.status < 200 || answer.status >= 300
        ? null : offersScheduling(davCapabilities(answer)) || undefined;
      const nativeMove = cal.owned
        ? (!options.arrived || options.status < 200 || options.status >= 300
          ? null : offersMove(options) || undefined)
        : undefined;
      calendars[i + index] = {
        ...cal,
        ...(autoSchedule !== undefined && { autoSchedule }),
        ...(nativeMove !== undefined && { nativeMove }),
      };
    }));
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
  /** An explicit temporary failure to read the member's listing properties. */
  readonly retry?: Refused;
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

function memberStatus(response: DavResponse, ns: string, local: string): number | null {
  if (response.status !== null && (response.status < 200 || response.status >= 300)) return response.status;
  if (propOf(response, ns, local) !== null) return null;
  return response.propstats.find((block) => block.props.some((p) => p.ns === ns && p.local === local))?.status ?? null;
}

function retryMember(status: number | null, wait: number | null): Refused | null {
  if (status === 429 || ((status === 423 || status === 503) && wait !== null)) return refuse("throttled", wait);
  if (status === 408 || status === 423 || status === 425 || (status !== null && status >= 500))
    return refuse("unavailable", wait);
  return null;
}

/**
 * An answer's responses told apart: the members, in order, and what the collection says of itself.
 * `skips`: a member that is none to list. The members are held by their addresses for this one
 * answer: no more of them than an answer may hold responses, none longer than an address may be.
 * `collection` is the address the collection was asked at: its members are known under its
 * origin, whichever of the server's hosts answered (`url`).
 */
function membersOf(asked: Extract<Asked, { ok: true }>, collection: string, skips: (member: DavResponse) => boolean): { readonly members: readonly Listed[]; readonly own: readonly DavResponse[] } | null {
  const { answer, url, retryAfterMs } = asked;
  const scope = scopeOf(url);
  const known = knownAt(collection, url);
  const members = new Map<string, Listed>();
  const own: DavResponse[] = [];
  const seen = new Set<string>();
  for (const response of answer.responses) {
    const read = addressOf(response.href, url);
    if (read === null) return null;
    if (isSelf(scope, read)) {
      own.push(response);
      continue;
    }
    const id = known(read);
    if (!isUnder(scope, read)) {
      members.set(id, { id, written: response.href, kind: "outside", tag: null });
      continue;
    }
    const key = sameMemberKey(id);
    if (seen.has(key)) return null;
    seen.add(key);
    if (response.status === 404 || response.status === 410) members.set(id, { id, written: response.href, kind: "removed", tag: null });
    else if (!skips(response)) {
      const retry = retryMember(memberStatus(response, DAV, "getetag"), retryAfterMs);
      if (retry !== null) members.set(id, { id, written: response.href, kind: "refused", tag: null, retry });
      else if (response.status !== null && (response.status < 200 || response.status >= 300))
        members.set(id, { id, written: response.href, kind: "refused", tag: null });
      else members.set(id, { id, written: response.href, kind: "changed", tag: entityTag(response) });
    }
  }
  return { members: [...members.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), own };
}

/** What changed since `token`, or everything from the empty one: the sync report, asked of the collection itself. */
export async function listBySync(s: Session, collection: string, token: string): Promise<ListedAnswer> {
  const start = `<D:sync-token>${xmlText(token)}</D:sync-token><D:sync-level>1</D:sync-level>`;
  const properties = "<D:prop><D:getetag/></D:prop>";
  const limit = `<D:limit><D:nresults>${MAX_PAGE_LIMIT}</D:nresults></D:limit>`;
  let asked = await ask(s, "REPORT", collection, "0", bodyOf("D:sync-collection", start + limit + properties), "inventory");
  // A server can decline the requested cut. Its uncut answer still has the regular byte and XML bounds.
  if (!asked.ok && asked.status === 507)
    asked = await ask(s, "REPORT", collection, "0", bodyOf("D:sync-collection", start + properties), "inventory");
  if (!asked.ok) return asked;
  const next = asked.answer.syncToken;
  // A collection sync report always returns a usable token, even for an empty inventory.
  if (!next || next.length + "sync:".length > TOKEN_MAX_CHARS || /[\s\p{Cc}]/u.test(next))
    return { ...refuse("unreadable"), status: 207 };
  const listed = membersOf(asked, collection, () => false);
  if (listed === null || listed.own.length > 1 ||
    listed.own.some((self) => self.status !== null && self.status >= 400 && self.status !== 507))
    return { ...refuse("unreadable"), status: 207 };
  const { members, own } = listed;
  return { ok: true, listing: { members, token: next, cut: own.some((self) => self.status === 507), url: asked.url } };
}

/** Every member with its tag, for a collection that keeps no token; `token` is the collection's own tag. */
export async function listByTags(s: Session, collection: string): Promise<ListedAnswer> {
  const asked = await ask(s, "PROPFIND", collection, "1", propfindOf("<D:getetag/><D:resourcetype/><CS:getctag/>"), "inventory");
  if (!asked.ok) return asked;
  const isCollection = (member: DavResponse): boolean => {
    const type = propOf(member, DAV, "resourcetype");
    return type !== null && childOf(type, DAV, "collection") !== null;
  };
  const listed = membersOf(asked, collection, isCollection);
  const self = listed?.own[0];
  if (listed === null || self === undefined || listed.own.length !== 1 ||
    !(self.status === 200 || self.propstats.some((block) => block.status === 200)))
    return { ...refuse("unreadable"), status: 207 };
  const tag = textOf(self, CALENDARSERVER, "getctag") || null;
  return { ok: true, listing: { members: listed.members, token: tag, cut: false, url: asked.url } };
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
export type FoundMembers = (member: Listed) => Fetched | Refused | undefined;

/** The text of the members named, asked at `collection`; `knownAs` is the calendar's stored address, whose origin the members are known under (as {@link membersOf}). */
export async function fetchMembers(s: Session, collection: string, members: readonly Listed[], knownAs = collection): Promise<{ readonly ok: true; readonly found: FoundMembers } | Extract<Asked, { ok: false }>> {
  const hrefs = members.map((m) => `<D:href>${xmlText(m.written)}</D:href>`).join("");
  const asked = await ask(s, "REPORT", collection, null, bodyOf("C:calendar-multiget", `<D:prop><D:getetag/><C:calendar-data/></D:prop>${hrefs}`), "member-data");
  if (!asked.ok) return asked;
  const known = knownAt(knownAs, asked.url);
  const found = new Map<string, Fetched | Refused>();
  const seen = new Set<string>();
  for (const response of asked.answer.responses) {
    const read = addressOf(response.href, asked.url);
    if (read === null) return { ...refuse("unreadable"), status: 207 };
    const key = sameMemberKey(known(read));
    if (seen.has(key)) return { ...refuse("unreadable"), status: 207 };
    seen.add(key);
    if (response.status === 404 || response.status === 410) {
      if (asked.answer.badCalendarData) return { ...refuse("unreadable"), status: 207 };
      found.set(key, "gone");
      continue;
    }
    const status = memberStatus(response, CALDAV, "calendar-data");
    const retry = retryMember(status, asked.retryAfterMs);
    if (retry !== null) {
      found.set(key, retry);
      continue;
    }
    if (status !== null && status >= 400) {
      found.set(key, refuse("unreadable"));
      continue;
    }
    const data = propOf(response, CALDAV, "calendar-data");
    if (data !== null) found.set(key, data.text.includes("\0") ? refuse("unreadable") : { tag: entityTag(response), text: data.text });
  }
  // A member named with an address that is none was never asked for.
  return { ok: true, found: (member) => (member.kind === "changed" ? found.get(sameMemberKey(member.id)) : undefined) };
}
