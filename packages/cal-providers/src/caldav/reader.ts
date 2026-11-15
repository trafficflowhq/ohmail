/**
 * CalDAV read behind the port, by the standards and for any server that keeps them: who is signed
 * in, the calendars for events, and one calendar's stored objects by the server's own token for
 * what changed (RFC 6578), or by its members' tags where it keeps no token.
 *
 * A stored object is handed over whole: its text as the server keeps it, its tag, and every event
 * the calendar core reads from it, a series and its changed days as several items of one address.
 * Nothing is expanded here.
 *
 * Nothing is kept between two calls: no address, no sign-in, no listing. A reading in pages asks
 * for the listing again at every page and cuts it after the last address handed out, so the cursor
 * holds two short texts and the reader holds nothing. What a pass ends with is the token of its
 * FIRST listing: an object that changes while the pass runs is then told again by the next round,
 * where a later token would have passed it over.
 *
 * A listing the server itself cut short is read on only while the server lists it as it did: under
 * the token it handed back, or, where it words that token anew at every answer, with every member
 * handed out so far listed exactly as it was handed out. Otherwise that cut begins again.
 */
import { createHash } from "node:crypto";
import { DEFAULT_LIMITS, readCalendar } from "@ohmail/cal-core";
import { CURSOR_MAX_CHARS, MAX_PAGES_PER_CALL, MAX_PAGE_LIMIT, TOKEN_MAX_CHARS } from "../limits.js";
import type { Answer, CalendarInfo, CalendarReader, ChangeItem, ChangePage, ChangeToken, Connection, LeftReason } from "../port.js";
import type { AdapterDeps } from "../request/index.js";
import { addressOf, refuse, type Refused, type Session } from "./ask.js";
import { findHomes, findPrincipal, typedAddress, type Typed } from "./discover.js";
import { credentialHostsFor } from "./hosts.js";
import { calendarsOf, fetchMembers, listBySync, listByTags, tagOf, type FoundMembers, type Listed, type Listing } from "./report.js";

/**
 * Multiget reports one page may send. One is the rule. More are sent only where an answer was past
 * the ceiling on bytes and the request was halved: eight halvings take a full page to one object,
 * and a dozen objects can then still be asked for one by one. A page that has spent them ends
 * there and the next one goes on. Never fewer than nine, or a page could end having read nothing.
 */
export const MAX_FETCHES_PER_PAGE = MAX_PAGES_PER_CALL;

const SYNC = "sync:";
const TAG = "ctag:";

/**
 * Statuses a server answers a sync report with when it does not know the token (RFC 6578 section
 * 3.2 names 403; servers also write 400, 409 and 412), or does not have the report (405, 415, 501).
 * With a token named the token is gone; with none the collection is read by its members' tags.
 */
const REFUSES_THE_REPORT: ReadonlySet<number> = new Set([400, 403, 405, 409, 412, 415, 501]);

/** Where a reading in pages stands. All of it is in the cursor a caller hands back. */
interface Standing {
  /** How the calendar is listed: by the sync report, or by its members' tags. */
  readonly way: "sync" | "tags";
  /** The reading began from no token, or from a tag that no longer stands: its pages are the whole calendar. */
  readonly whole: boolean;
  /** The token the sync report is asked with; empty for none. */
  readonly from: string;
  /** The address the page before ended with: the listing is cut after it. `null` at a listing's start. */
  readonly after: string | null;
  /** The token (or tag) of this listing as it was first asked. */
  readonly first: string | null;
  /** In a listing the server cut short: what it listed of the members handed out so far ({@link toldOf}). `null` in any other. */
  readonly told: string | null;
}

const CURSOR_VERSION = 1;

function writeCursor(at: Standing): string | null {
  const text = JSON.stringify([CURSOR_VERSION, at.way, at.whole, at.from, at.after, at.first, at.told]);
  return text.length <= CURSOR_MAX_CHARS ? text : null;
}

function readCursor(text: string): Standing | null {
  if (text.length > CURSOR_MAX_CHARS) return null;
  let read: unknown;
  try {
    read = JSON.parse(text);
  } catch {
    // No cursor of this reader's: the caller begins again.
    return null;
  }
  if (!Array.isArray(read) || read.length !== 7 || read[0] !== CURSOR_VERSION) return null;
  const [, way, whole, from, after, first, told] = read as unknown[];
  if ((way !== "sync" && way !== "tags") || typeof whole !== "boolean" || typeof from !== "string") return null;
  if ((after !== null && typeof after !== "string") || (first !== null && typeof first !== "string") || (told !== null && typeof told !== "string")) return null;
  return { way, whole, from, after, first, told };
}

/** Where a reading begins from a caller's token; `null` for a token that is none of this reader's. */
function standingOf(since: ChangeToken | null): Standing | null {
  if (since === null) return { way: "sync", whole: true, from: "", after: null, first: null, told: null };
  if (since.provider !== "caldav" || since.value.length > TOKEN_MAX_CHARS) return null;
  if (since.value.startsWith(SYNC) && since.value.length > SYNC.length) return { way: "sync", whole: false, from: since.value.slice(SYNC.length), after: null, first: null, told: null };
  if (since.value.startsWith(TAG) && since.value.length > TAG.length) return { way: "tags", whole: true, from: since.value.slice(TAG.length), after: null, first: null, told: null };
  return null;
}

const pageSize = (asked: number): number => (Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), MAX_PAGE_LIMIT) : 1);

/** How many of a listing's members stand at or before this address: where the page after it begins. */
function countUpTo(members: readonly Listed[], after: string): number {
  const next = members.findIndex((m) => m.id > after);
  return next === -1 ? members.length : next;
}

/**
 * What a listing says of its first `count` members, as one short text: of each its address, what
 * the listing calls it and its tag. Two listings that say the same of them give the same text.
 * `null` where a member that is there came without a tag: nothing then tells whether it still is
 * the object that was handed out.
 */
function toldOf(members: readonly Listed[], count: number): string | null {
  const hash = createHash("sha256");
  for (let i = 0; i < count; i++) {
    const member = members[i]!;
    if (member.kind === "changed" && member.tag === null) return null;
    hash.update(JSON.stringify([member.id, member.kind, member.tag]));
  }
  return hash.digest("base64url");
}

type Left = { readonly id: string; readonly reason: LeftReason };

/** One listed member as what a page holds of it. */
function take(member: Listed, found: FoundMembers, items: ChangeItem[], left: Left[]): void {
  if (member.kind === "removed") items.push({ kind: "gone", id: member.id });
  else if (member.kind !== "changed") left.push({ id: member.id, reason: "unreadable" });
  else {
    const fetched = found(member);
    // Asked for and not answered: nothing is known of it, which is neither "there" nor "gone".
    if (fetched === undefined) left.push({ id: member.id, reason: "unreadable" });
    else if (fetched === "gone") items.push({ kind: "gone", id: member.id });
    else {
      const read = readCalendar(fetched.text, DEFAULT_LIMITS);
      if (!read.ok) left.push({ id: member.id, reason: read.reason });
      else {
        const version = fetched.tag ?? member.tag ?? "";
        for (const event of read.calendar.events) items.push({ kind: "upsert", id: member.id, version, event, text: fetched.text });
        // Read with something left out: what was read is shown, and the object is named as one not to write back.
        if (read.dropped.length > 0) left.push({ id: member.id, reason: read.dropped[0]!.reason });
        // An object that holds no event (a task, or nothing any more) is none of a calendar's.
        else if (read.calendar.events.length === 0) items.push({ kind: "gone", id: member.id });
      }
    }
  }
}

export function makeReader(deps: AdapterDeps): CalendarReader {
  /** What a call asks with: the typed address read, and the sign-in for the typed host and its siblings. */
  function open(c: Connection, signal: AbortSignal): { readonly ok: true; readonly session: Session; readonly typed: Typed } | Refused {
    if (c.credential.kind !== "basic") return refuse("sign_in_refused");
    const typed = c.start === null ? null : typedAddress(c.start);
    if (typed === null) return refuse("address_invalid");
    // Typed with TLS (`secured` is the TLS form of an address typed without): the password then never travels without it,
    // whatever address a server's answer or a caller's stored calendar names.
    const auth = { credential: c.credential, admits: credentialHostsFor(typed.host), tlsOnly: typed.secured === null };
    return { ok: true, typed, session: { deps, signal, auth } };
  }

  async function homesOf(c: Connection, signal: AbortSignal) {
    const opened = open(c, signal);
    if (!opened.ok) return opened;
    const who = await findPrincipal(opened.session, opened.typed);
    if (!who.ok) return who;
    // The session the principal was found with: it may have become one for TLS alone on the way.
    const homes = await findHomes(who.session, who.principal);
    if (!homes.ok) return homes;
    return { ok: true as const, session: who.session, principal: who.principal, homes: homes.homes, addresses: homes.addresses };
  }

  return {
    provider: "caldav",

    async checkSignIn(c, signal) {
      const found = await homesOf(c, signal);
      if (!found.ok) return found;
      return { ok: true, value: { principal: found.principal, addresses: found.addresses } };
    },

    async listCalendars(c, signal) {
      const found = await homesOf(c, signal);
      if (!found.ok) return found;
      const calendars = new Map<string, CalendarInfo>();
      for (const home of found.homes) {
        const listed = await calendarsOf(found.session, home);
        if (!listed.ok) return listed;
        for (const calendar of listed.calendars) if (!calendars.has(calendar.id)) calendars.set(calendar.id, calendar);
      }
      return { ok: true, value: [...calendars.values()] };
    },

    async readChanges(c, cal, since, page, signal): Promise<Answer<ChangePage>> {
      const opened = open(c, signal);
      if (!opened.ok) return opened;
      const s = opened.session;
      const began = page.cursor === null ? standingOf(since) : readCursor(page.cursor);
      if (began === null) return refuse("token_gone");
      const collection = addressOf(cal.id);
      if (collection === null) return refuse("not_found");

      // The listing: what changed since the token, or everything.
      let way = began.way;
      const from = way === "sync" ? began.from : "";
      let tagBefore: string | null = null;
      if (way === "tags" && page.cursor === null) {
        // A round from a tag: while the collection's tag is the one the last reading ended with, nothing in it changed.
        const now = await tagOf(s, collection);
        if (!now.ok) return now;
        if (now.tag !== null && now.tag === began.from) {
          return { ok: true, value: { mode: "whole", unchanged: true, items: [], left: [], cursor: { kind: "end", token: since }, expanded: null, refreshMs: null } };
        }
        tagBefore = now.tag;
        // Changed: it is read whole, as from no token. A server that has learnt the sync report since is then read by it.
        way = "sync";
      }
      let listing: Listing;
      if (way === "sync") {
        const listed = await listBySync(s, collection, from);
        if (listed.ok) listing = listed.listing;
        else if (listed.status === null || !REFUSES_THE_REPORT.has(listed.status)) return refuse(listed.reason, listed.retryAfterMs);
        else if (from !== "" || page.cursor !== null) return refuse("token_gone");
        else {
          // No token was named, so it is the report this collection does not take: it is read by its members' tags.
          const byTags = await listByTags(s, collection);
          if (!byTags.ok) return refuse(byTags.reason, byTags.retryAfterMs);
          way = "tags";
          listing = byTags.listing;
        }
      } else {
        const listed = await listByTags(s, collection);
        if (!listed.ok) return refuse(listed.reason, listed.retryAfterMs);
        listing = listed.listing;
      }

      let after = began.after;
      let first = began.first;
      if (listing.cut) {
        if (listing.token === null || listing.token === "") return refuse("unreadable");
        if (after !== null && first !== listing.token) {
          // Asked a second time, the server hands back another token. Where it lists everything handed out so far exactly as it
          // was handed out, it has only worded the token anew and the cut is read on under that one. Where it does not, it cut
          // otherwise: what the pages before handed out says nothing of this cut, so it begins again.
          if (began.told !== null && began.told === toldOf(listing.members, countUpTo(listing.members, after))) first = listing.token;
          else {
            after = null;
            first = null;
          }
        }
      }
      // What the reading will end with: the token of this listing as it was first asked. A listing by tags that does not carry the collection's own tag ends with the one read before it.
      first ??= way === "tags" ? (listing.token ?? tagBefore) : listing.token;

      const limit = pageSize(page.limit);
      const begins = after === null ? 0 : countUpTo(listing.members, after);
      const rest = listing.members.slice(begins);
      const wanted = rest.slice(0, limit);

      const items: ChangeItem[] = [];
      const left: Left[] = [];
      let done = 0;
      let size = wanted.length;
      for (let fetches = 0; done < wanted.length && fetches < MAX_FETCHES_PER_PAGE; ) {
        const batch = wanted.slice(done, done + size);
        const changed = batch.filter((m) => m.kind === "changed");
        let found: FoundMembers = () => undefined;
        if (changed.length > 0) {
          fetches++;
          const fetched = await fetchMembers(s, listing.url, changed);
          if (fetched.ok) found = fetched.found;
          else if (fetched.reason !== "too_large") return refuse(fetched.reason, fetched.retryAfterMs);
          else if (batch.length > 1) {
            // The answer was past a ceiling: half as many are asked for.
            size = Math.ceil(batch.length / 2);
            continue;
          } else {
            // One object alone is past it: it is left out by that word, and the calendar reads on.
            left.push({ id: batch[0]!.id, reason: "too_large" });
            done += 1;
            continue;
          }
        }
        for (const member of batch) take(member, found, items, left);
        done += batch.length;
        // What fitted may fit twice over: the heavy object is behind.
        size *= 2;
      }

      let cursor: ChangePage["cursor"];
      if (done < rest.length) {
        const told = listing.cut ? toldOf(listing.members, begins + done) : null;
        const more = writeCursor({ way, whole: began.whole, from, after: wanted[done - 1]!.id, first, told });
        if (more === null) return refuse("too_large");
        cursor = { kind: "more", value: more };
      } else if (listing.cut) {
        // More is to come from the token the server handed back. One that is the token it was asked with would be asked for ever.
        if (listing.token === from) return refuse("page_link_refused");
        const more = writeCursor({ way, whole: began.whole, from: listing.token!, after: null, first: null, told: null });
        if (more === null) return refuse("too_large");
        cursor = { kind: "more", value: more };
      } else {
        // A token longer than a caller keeps is none: the calendar is then read whole each round, which is slow and never wrong.
        const value = first === null || first === "" ? null : `${way === "sync" ? SYNC : TAG}${first}`;
        cursor = { kind: "end", token: value === null || value.length > TOKEN_MAX_CHARS ? null : { provider: "caldav", value } };
      }
      return { ok: true, value: { mode: began.whole ? "whole" : "delta", unchanged: false, items, left, cursor, expanded: null, refreshMs: null } };
    },
  };
}
