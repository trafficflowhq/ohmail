/**
 * A CalDAV calendar, written: a new object as a member named from the write's own key under the
 * collection a reading stored (`If-None-Match: *`), a stored object changed or removed against the
 * tag a reading stored (`If-Match`), and an invitee's own answer on its line. Every address is the
 * collection's, or a member under it as a reading named it; an address outside the collection is
 * refused before anything is asked. What a write answers is the member as the reader's own
 * multiget reads it back, so the store meets the server's object through the reading's mapper.
 *
 * Invitees are written only where the server says it sends invitations itself
 * (`calendar-auto-schedule`): this program sends none.
 */
import { DEFAULT_LIMITS, readCalendar, type PartStat } from "@ohmail/cal-core";
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
import { addressOf, isUnder, propfindOf, scopeOf, type Session } from "./ask.js";
import { answeredObjectText, changedObjectText, heldEvent, newObjectText, uidOfText } from "./edit.js";
import { caldavSession } from "./reader.js";
import { fetchMembers, type Fetched } from "./report.js";

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
const failedRead = (v: Fetched | Refusal): v is Refusal => typeof v === "object" && "ok" in v;

/** The write's key as the UUID a member and its UID are named by. */
function uuidOf(key: WriteKey): string | null {
  const h = key.hex;
  return /^[0-9a-f]{32}$/.test(h)
    ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
    : null;
}

export function makeWriter(deps: AdapterDeps): CalendarWriter {
  function refusalOf(res: HttpResponse, gone: ProviderRefusal | WriteRefusal): Refusal {
    const wait = retryAfterMs(res, deps.clock);
    if (res.status >= 300 && res.status < 400) return refused("redirect_invalid");
    if (res.status === 401) return refused("sign_in_refused");
    if (res.status === 403) return refused("read_only");
    if (res.status === 404 || res.status === 410) return refused(gone);
    if (res.status === 400 || res.status === 415 || res.status === 422) return refused("field_unwritable");
    if (res.status === 413 || res.status === 507) return refused("too_large");
    if (res.status === 429 || (res.status === 503 && wait !== null)) return refused("throttled", wait);
    if (res.status >= 500) return refused("unavailable", wait);
    return refused("unknown");
  }

  async function send(
    s: Session,
    method: HttpMethod,
    url: string,
    text: string | null,
    precondition: Precondition,
  ): Promise<HttpResponse | Refusal> {
    const answer = await deps.http.request(url, {
      method,
      headers: text === null ? {} : { "content-type": "text/calendar; charset=utf-8" },
      body: text,
      auth: s.auth,
      validators: null,
      precondition,
      signal: s.signal,
    });
    return answer.arrived ? answer : refused(answer.reason);
  }

  /** The member as a reading reads it: its text and its tag, `gone`, or the word of a failed read. */
  async function readMember(s: Session, collection: string, member: string): Promise<Fetched | Refusal> {
    const got = await fetchMembers(s, collection, [
      { id: member, written: new URL(member).pathname, kind: "changed", tag: null },
    ]);
    if (!got.ok) return refused(got.reason, got.retryAfterMs);
    return got.found({ id: member, written: member, kind: "changed", tag: null }) ?? refused("unreadable");
  }

  /** What a reading would hand for the member now: each of its events as an upsert under its tag, or its removal. */
  function itemsOf(member: string, fetched: Fetched): ChangeItem[] {
    if (fetched === "gone") return [{ kind: "gone", id: member }];
    const read = readCalendar(fetched.text, DEFAULT_LIMITS);
    if (!read.ok) return [];
    return read.calendar.events.map((event): ChangeItem => ({
      kind: "upsert",
      id: member,
      version: fetched.tag ?? "",
      event,
      text: fetched.text,
    }));
  }

  /** Read back after a write; where the read fails, what was written under the tag the write answered. */
  async function afterWrite(
    s: Session,
    collection: string,
    member: string,
    res: HttpResponse,
    text: string | null,
  ): Promise<WriteAnswer> {
    const back = await readMember(s, collection, member);
    if (failedRead(back)) {
      if (text === null) return answered([{ kind: "gone", id: member }]);
      const tag = res.header("etag");
      return answered(itemsOf(member, { tag: tag !== null && sendableTag(tag) ? tag : null, text }));
    }
    return answered(itemsOf(member, back));
  }

  /** The collection and a member under it, as a reading stored them; `null` where either is no such address. */
  function placeOf(
    cal: CalendarRef,
    id: string | null,
  ): { readonly collection: string; readonly member: string } | null {
    const collection = addressOf(cal.id);
    if (collection === null) return null;
    const member = id === null ? null : addressOf(id);
    if (member === null || !isUnder(scopeOf(collection), member)) return null;
    return { collection, member };
  }

  /** Does the server send invitations itself? Read off the `DAV` line of its answer about the collection. */
  async function sendsInvitations(s: Session, collection: string): Promise<boolean | Refusal> {
    const answer = await deps.http.request(collection, {
      method: "PROPFIND",
      headers: {
        accept: "application/xml, text/xml",
        "content-type": "application/xml; charset=utf-8",
        depth: "0",
      },
      body: propfindOf("<D:resourcetype/>"),
      auth: s.auth,
      validators: null,
      signal: s.signal,
    });
    if (!answer.arrived) return refused(answer.reason);
    if (answer.status !== 207) return refusalOf(answer, "not_found");
    return (answer.header("dav") ?? "")
      .split(",")
      .map((w) => w.trim().toLowerCase())
      .includes("calendar-auto-schedule");
  }

  /**
   * The precondition and the stored text a change is made on: the stored tag where it is an entity
   * tag and the stored text is there; else the member read once, its tag compared with the stored
   * one, and that read's text and tag used. Never no precondition.
   */
  async function standing(
    s: Session,
    collection: string,
    member: string,
    target: WriteTarget,
  ): Promise<{ readonly tag: string; readonly text: string } | Refusal> {
    if (sendableTag(target.version) && target.text !== null)
      return { tag: target.version, text: target.text };
    const now = await readMember(s, collection, member);
    if (failedRead(now)) return now;
    if (now === "gone") return refused("event_gone");
    if (now.tag === null || !sendableTag(now.tag)) return refused("version_unknown");
    if (now.tag !== target.version) return refused("version_stale");
    return { tag: now.tag, text: now.text };
  }

  /** A change refused for its version: done where the member already holds every field of it; else made on another copy. */
  async function afterStale(
    s: Session,
    collection: string,
    member: string,
    change: EventChange | null,
  ): Promise<WriteAnswer> {
    const now = await readMember(s, collection, member);
    if (failedRead(now)) return now;
    if (now === "gone")
      return change === null ? answered([{ kind: "gone", id: member }]) : refused("event_gone");
    if (change === null) return refused("version_stale");
    const event = heldEvent(now.text);
    return event !== null && alreadyHolds(change, event, deps.zones)
      ? answered(itemsOf(member, now))
      : refused("version_stale");
  }

  return {
    provider: "caldav",

    async create(
      c: Connection,
      cal: CalendarRef,
      req: { readonly key: WriteKey; readonly event: EventDraft },
      signal: AbortSignal,
    ): Promise<WriteAnswer> {
      const opened = caldavSession(deps, c, signal);
      if (!opened.ok) return opened;
      const s = opened.session;
      const uid = uuidOf(req.key);
      const collection = addressOf(cal.id);
      if (uid === null || collection === null) return refused("not_found");
      // The member is named from the key alone, under the collection: nothing a person typed names it.
      const member = addressOf(`${uid}.ics`, `${collection.replace(/\/+$/, "")}/`);
      if (member === null || !isUnder(scopeOf(collection), member)) return refused("address_not_allowed");
      if (req.event.attendees.length > 0) {
        const sends = await sendsInvitations(s, collection);
        if (sends !== true) return sends === false ? refused("invitees_unsupported") : sends;
      }
      const text = newObjectText(req.event, uid, deps.clock.now(), deps.zones);
      if (!text.ok)
        return refused(
          text.reason === "left_out" ? "unreadable" : text.reason === "not_found" ? "unknown" : text.reason,
        );
      const res = await send(s, "PUT", member, text.text, { kind: "new" });
      if ("ok" in res) return res;
      if (res.status === 412) {
        // The member is there: an earlier attempt of this very write made it, if its UID is ours. Read where it was written.
        const now = await readMember(s, collection, member);
        if (failedRead(now)) return now;
        if (now === "gone") return refused("unknown");
        return uidOfText(now.text) === uid ? answered(itemsOf(member, now)) : refused("unknown");
      }
      if (res.status !== 201 && res.status !== 204 && res.status !== 200) return refusalOf(res, "not_found");
      return afterWrite(s, collection, member, res, text.text);
    },

    async change(c, cal, target, change, signal) {
      const opened = caldavSession(deps, c, signal);
      if (!opened.ok) return opened;
      const s = opened.session;
      const place = placeOf(cal, target.id);
      if (place === null) return refused("address_not_allowed");
      if (change.attendees !== undefined && change.attendees.length > 0) {
        const sends = await sendsInvitations(s, place.collection);
        if (sends !== true) return sends === false ? refused("invitees_unsupported") : sends;
      }
      const stood = await standing(s, place.collection, place.member, target);
      if ("ok" in stood) return stood;
      const text = changedObjectText(stood.text, change, deps.clock.now(), deps.zones);
      if (!text.ok) return refused(text.reason === "not_found" ? "event_gone" : text.reason);
      const res = await send(s, "PUT", place.member, text.text, { kind: "unchanged", tag: stood.tag });
      if ("ok" in res) return res;
      if (res.status === 412) return afterStale(s, place.collection, place.member, change);
      if (res.status !== 200 && res.status !== 201 && res.status !== 204) return refusalOf(res, "event_gone");
      return afterWrite(s, place.collection, place.member, res, text.text);
    },

    async remove(c, cal, target, signal) {
      const opened = caldavSession(deps, c, signal);
      if (!opened.ok) return opened;
      const s = opened.session;
      const place = placeOf(cal, target.id);
      if (place === null) return refused("address_not_allowed");
      let tag = target.version;
      if (!sendableTag(tag)) {
        const stood = await standing(s, place.collection, place.member, target);
        if ("ok" in stood)
          return stood.reason === "event_gone" ? answered([{ kind: "gone", id: target.id }]) : stood;
        tag = stood.tag;
      }
      const res = await send(s, "DELETE", place.member, null, { kind: "unchanged", tag });
      if ("ok" in res) return res;
      // Gone already is what a removal wants.
      if (res.status === 200 || res.status === 204 || res.status === 404 || res.status === 410)
        return answered([{ kind: "gone", id: target.id }]);
      if (res.status === 412) return afterStale(s, place.collection, place.member, null);
      return refusalOf(res, "event_gone");
    },

    async answer(c, cal, target, req: { readonly as: string; readonly reply: WriteReply }, signal) {
      const opened = caldavSession(deps, c, signal);
      if (!opened.ok) return opened;
      const s = opened.session;
      const place = placeOf(cal, target.id);
      if (place === null) return refused("address_not_allowed");
      // The server carries an answer to the organizer only where it schedules; this program sends no letter.
      const sends = await sendsInvitations(s, place.collection);
      if (sends !== true) return sends === false ? refused("invitees_unsupported") : sends;
      const stood = await standing(s, place.collection, place.member, target);
      if ("ok" in stood) return stood;
      const text = answeredObjectText(stood.text, req.as, req.reply as PartStat, deps.clock.now());
      if (!text.ok) return refused(text.reason === "not_found" ? "not_found" : text.reason);
      const res = await send(s, "PUT", place.member, text.text, { kind: "unchanged", tag: stood.tag });
      if ("ok" in res) return res;
      if (res.status === 412) {
        // Refused for its version: done where the account's line already says it (an earlier attempt landed); else another copy.
        const now = await readMember(s, place.collection, place.member);
        if (failedRead(now)) return now;
        if (now === "gone") return refused("event_gone");
        const as = req.as.trim().toLowerCase();
        return heldEvent(now.text)?.attendees.some(
          (p) => p.email === as && (p.partstat ?? "NEEDS-ACTION") === req.reply,
        )
          ? answered(itemsOf(place.member, now))
          : refused("version_stale");
      }
      if (res.status !== 200 && res.status !== 201 && res.status !== 204) return refusalOf(res, "event_gone");
      return afterWrite(s, place.collection, place.member, res, text.text);
    },

    // CalDAV has no move this program uses (MOVE is never sent): a move is a new member and a removal.
    moveEvent: null,
  };
}
