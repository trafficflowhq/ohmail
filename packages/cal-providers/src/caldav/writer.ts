/**
 * A CalDAV calendar, written: a new object as a member named from the write's own key under the
 * collection a reading stored (`If-None-Match: *`), a stored object changed or removed against the
 * tag a reading stored (`If-Match`), and an invitee's own answer on its line. Every address is the
 * collection's, or a member under it as a reading named it; an address outside the collection is
 * refused before anything is asked. What a write answers is the member as the reader's own
 * multiget reads it back, so the store meets the server's object through the reading's mapper.
 *
 * A stored address names a path, never a host: every request here leaves the reader's one way
 * (`leave`, in `ask.ts`), and a collection on a host the server did not name in this turn gets no
 * request and no sign-in (`host_changed`).
 *
 * Invitees are written only where the server says it sends invitations itself
 * (`calendar-auto-schedule`): this program sends none.
 */
import {
  DEFAULT_LIMITS,
  deleteAudienceOf,
  momentOrUtc,
  sameTime,
  readCalendar,
  sameDeleteAudience,
  type EventTime,
  type PartStat,
} from "@ohmail/cal-core";
import type {
  CalendarRef,
  CalendarWriter,
  ChangeItem,
  Connection,
  EventChange,
  EventDraft,
  SeriesContinuation,
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
import { personalSeriesOf, seriesDeleteMembers, spelledAs, storedObjectFacts } from "../series.js";
import { alreadyHolds, ordinarySharedChange, sameAudience } from "../write-compare.js";
import {
  addressOf,
  allowsMove,
  collectionOptions,
  davCapabilities,
  isUnder,
  leave,
  offersScheduling,
  schedulingAnswer,
  scopeOf,
  type Session,
} from "./ask.js";
import {
  answerHolds,
  answeredObjectText,
  changedObjectText,
  continuedObjectText,
  dayAnsweredText,
  dayAbsent,
  dayCancelledText,
  dayOfAnotherCopy,
  dayChangedText,
  dayHolds,
  heldEvent,
  inviteesOf,
  newObjectText,
  sameReviewedSeries,
  seriesEndedText,
  seriesEndsBefore,
  seriesGoesOnFrom,
  uidOfText,
} from "./edit.js";
import { caldavSession } from "./reader.js";
import { fetchMembers, type Fetched } from "./report.js";

type Refusal = {
  readonly ok: false;
  readonly reason: ProviderRefusal | WriteRefusal;
  readonly retryAfterMs: number | null;
};
type Accepted = Extract<WriteAnswer, { ok: true }>;
type Continuation = {
  readonly collection: string;
  readonly member: string;
  readonly uid: string;
  readonly text: string;
};

/** Does a change name nothing but the account's own reminders, which no invitee is ever told of? */
const remindersOnly = (change: EventChange): boolean =>
  Object.keys(change).length > 0 && Object.keys(change).every((k) => k === "alarms");
const refused = (reason: ProviderRefusal | WriteRefusal, wait: number | null = null): Refusal => ({
  ok: false,
  reason,
  retryAfterMs: wait,
});
/** Done, as found: a write's own request was not what made it so (a refused precondition and a compare, an object already so). */
const answered = (items: readonly ChangeItem[]): Accepted => ({ ok: true, items });
/** Done by the write's own request: what waits behind it may be re-based onto `items`. */
const wrote = (items: readonly ChangeItem[]): Accepted => ({ ok: true, items, written: true });
const failedRead = (v: Fetched | Refusal): v is Refusal => typeof v === "object" && "ok" in v;

/** A rejected conditional write can already be done only for the same series and dates.
 * A one-date success contains its new override. Compare the dates and recipients of every
 * component, including properties a server can schedule but the mirror does not understand. */
function sameSchedule(wanted: string, found: string): boolean {
  const signature = (text: string): string | null => {
    const read = readCalendar(text, DEFAULT_LIMITS);
    if (!read.ok || read.dropped.length || read.calendar.events.length === 0) return null;
    const schedule = [
      "UID",
      "DTSTART",
      "DTEND",
      "DURATION",
      "RECURRENCE-ID",
      "RRULE",
      "RDATE",
      "EXRULE",
      "EXDATE",
      "STATUS",
      "ATTENDEE",
      "ORGANIZER",
    ];
    const dates = read.calendar.events.map((event) =>
      event.component.properties
        .filter((p) => schedule.some((name) => spelledAs(p, name)))
        .map((p) => JSON.stringify([p.name.toUpperCase(), p.params, p.value]))
        .sort(),
    );
    return JSON.stringify(dates.map((parts) => JSON.stringify(parts)).sort());
  };
  const expected = signature(wanted);
  return expected !== null && expected === signature(found);
}

/** Only a definitive rejection can permit cleanup. A transport or server failure may follow a committed PUT. */
const canRollBack = (status: number): boolean =>
  [400, 401, 403, 405, 409, 412, 413, 415, 422].includes(status);
const strongTag = (tag: string | null): string | null =>
  tag !== null && sendableTag(tag) && !tag.startsWith("W/") ? tag : null;
const canRetryCleanup = (reason: Refusal["reason"]): boolean =>
  ["unavailable", "throttled", "timeout", "connection_failed"].includes(reason);

/** XML can normalize line endings. Every line and value, including the creation stamps, must match. */
const sameCalendarText = (a: string, b: string): boolean =>
  a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");

/** Ignore serialization changes such as line folding, while retaining every content line. */
function sameCalendarContent(wanted: string, found: string): boolean {
  if (sameCalendarText(wanted, found)) return true;
  const expected = readCalendar(wanted, DEFAULT_LIMITS);
  const stored = readCalendar(found, DEFAULT_LIMITS);
  return (
    expected.ok &&
    stored.ok &&
    expected.dropped.length === 0 &&
    stored.dropped.length === 0 &&
    JSON.stringify(expected.calendar.tree) === JSON.stringify(stored.calendar.tree)
  );
}

/** A read-back tag is safe for queued followers only when it describes the copy we sent. */
function writtenTag(
  responseTag: string | null,
  readBack: Exclude<Fetched, "gone">,
  text: string,
): string | null {
  const observed = strongTag(readBack.tag);
  if (observed === null) return null;
  return responseTag === observed || (responseTag === null && sameCalendarContent(text, readBack.text))
    ? observed
    : null;
}

/** The write's key as the UUID a member and its UID are named by. */
function uuidOf(key: WriteKey): string | null {
  const h = key.hex;
  return /^[0-9a-f]{32}$/.test(h)
    ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
    : null;
}

/** The exception and its series share one CalDAV resource and entity tag. */
function exceptionMatchesTarget(target: WriteTarget): boolean {
  const reviewed = target.exception;
  return (
    reviewed === undefined ||
    (target.recurringSeries === true &&
      reviewed.id === target.id &&
      reviewed.version === target.version &&
      (target.occurrence === null || sameTime(reviewed.occurrence, target.occurrence)))
  );
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
    const answer = await leave(s, url, {
      method,
      headers: text === null ? {} : { "content-type": "text/calendar; charset=utf-8" },
      body: text,
      precondition,
    });
    return answer.arrived ? answer : refused(answer.reason);
  }

  /** The member as a reading reads it: its text and its tag, `gone`, or the word of a failed read. */
  async function readMember(s: Session, collection: string, member: string): Promise<Fetched | Refusal> {
    const got = await fetchMembers(s, collection, [
      { id: member, written: new URL(member).pathname, kind: "changed", tag: null },
    ]);
    if (!got.ok) return refused(got.reason, got.retryAfterMs);
    return got.found({ id: member, written: member, kind: "changed", tag: null }) ?? refused("unavailable");
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
      ...(read.dropped.length > 0 && { resourceIncomplete: true }),
    }));
  }

  /**
   * Read back after a write the server took. Acknowledgement settles the write, but rebasing a
   * later edit needs proof that the read-back copy came from this write.
   */
  async function afterWrite(
    s: Session,
    collection: string,
    member: string,
    res: HttpResponse,
    text: string | null,
  ): Promise<Accepted> {
    const back = await readMember(s, collection, member);
    const tag = res.header("etag");
    if (failedRead(back)) {
      if (text === null) return answered([{ kind: "gone", id: member }]);
      return answered(itemsOf(member, { tag: tag !== null && sendableTag(tag) ? tag : null, text }));
    }
    const items = itemsOf(member, back);
    return text !== null &&
      back !== "gone" &&
      writtenTag(tag, back, text) !== null &&
      !items.some((item) => item.kind === "upsert" && item.resourceIncomplete)
      ? wrote(items)
      : answered(items);
  }

  async function rollBack(
    s: Session,
    created: { readonly member: string; readonly tag: string },
  ): Promise<Refusal | null> {
    const res = await send(s, "DELETE", created.member, null, { kind: "unchanged", tag: created.tag });
    const failure =
      "ok" in res
        ? res
        : res.status === 408
          ? refused("timeout")
          : res.status === 423
            ? refused("throttled", retryAfterMs(res, deps.clock))
            : refusalOf(res, "event_gone");
    return canRetryCleanup(failure.reason) ? failure : null;
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

  /** Does the collection advertise server-side scheduling? */
  async function sendsInvitations(
    s: Session,
    collection: string,
    requireCalendarAccess = false,
  ): Promise<boolean | Refusal> {
    const options = await collectionOptions(s, collection);
    const answer = await schedulingAnswer(s, collection, options);
    if (!answer.arrived) return refused(answer.reason);
    if (answer.status < 200 || answer.status >= 300) return refusalOf(answer, "not_found");
    const capabilities = davCapabilities(answer);
    if (requireCalendarAccess && !capabilities.includes("calendar-access")) return refused("read_only");
    return offersScheduling(capabilities);
  }

  /**
   * Does a write on a stored object with invitees (any line but its organizer's own, on any of its
   * events) need the server to send invitations itself, and does it? Its invitees hear of its change
   * or its removal from the server alone, whatever the write is of (one event, a series, a day of
   * one); at a server that sends none they would never hear: the write is refused
   * `invitees_unsupported` (ruling ii: one rule for every write). `true`: write it.
   */
  async function inviteesHear(s: Session, collection: string, text: string | null): Promise<true | Refusal> {
    const read = text === null ? null : readCalendar(text, DEFAULT_LIMITS);
    if (read === null || !read.ok || !read.calendar.events.some((e) => inviteesOf(e).length > 0)) return true;
    const sends = await sendsInvitations(s, collection);
    return sends === true ? true : sends === false ? refused("invitees_unsupported") : sends;
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

  function seriesAudienceHolds(
    text: string,
    target: WriteTarget,
    scope: "change" | "following" | "master",
  ): boolean {
    const members = seriesDeleteMembers(text, deps.zones);
    if (members === null) return false;
    const selected = scope === "master" ? members.filter((member) => member.at === null) : members;
    const actual = deleteAudienceOf(
      selected,
      target.occurrence === null || scope === "master"
        ? { kind: "record" }
        : {
            kind: scope === "following" ? "following" : "occurrence",
            at: String(momentOrUtc(target.occurrence, deps.zones)),
          },
    )?.audience;
    if (!actual) return false;
    return target.audience ? sameDeleteAudience(actual, target.audience) : actual.guests.length === 0;
  }

  /**
   * The series the days of the series in `text` become from its day `was` on, as `then` asks it: its
   * member under the collection, named from its key alone, and its text, made from that copy of the
   * series; or the word that refuses it. Nothing is asked of the server.
   */
  function continuation(
    cal: CalendarRef,
    text: string,
    was: EventTime,
    then: SeriesContinuation,
  ): Continuation | Refusal {
    if (then.change.attendees !== undefined) return refused("field_unwritable");
    const uid = uuidOf(then.key);
    const collection = addressOf(cal.id);
    if (uid === null || collection === null) return refused("not_found");
    // The member is named from the key alone, under the collection: nothing a person typed names it.
    const member = addressOf(`${uid}.ics`, `${collection.replace(/\/+$/, "")}/`);
    if (member === null || !isUnder(scopeOf(collection), member)) return refused("address_not_allowed");
    const made = continuedObjectText(
      text,
      was,
      uid,
      then.start,
      then.end,
      then.rule,
      then.change,
      then.createdAtMs ?? deps.clock.now(),
      deps.zones,
    );
    if (!made.ok) return refused(made.reason === "not_found" ? "event_gone" : made.reason);
    return { collection, member, uid, text: made.text };
  }

  /** Same series after a lost creation answer. A matching address alone is insufficient for a new split. */
  function continuationHolds(
    made: Continuation,
    now: Exclude<Fetched, "gone">,
    change: EventChange,
    compare: boolean,
  ): boolean {
    if (uidOfText(now.text) !== made.uid) return false;
    if (!compare) return true;
    const event = heldEvent(now.text);
    return event !== null && sameSchedule(made.text, now.text) && alreadyHolds(change, event, deps.zones);
  }

  /** Ensure one resource across both rows. Recovery can authorize cleanup only under its exact generated copy. */
  async function ensureContinuation(
    s: Session,
    made: Continuation,
    change: EventChange,
    options: {
      readonly compare: boolean;
      readonly requireExisting?: true;
      readonly recoverRollback?: boolean;
      readonly sendLegacy?: boolean;
    },
  ): Promise<{ readonly answer: Accepted; readonly rollbackTag: string | null } | Refusal> {
    const { collection, member, text } = made;
    const found = options.sendLegacy ? "gone" : await readMember(s, collection, member);
    if (failedRead(found)) return found;
    if (found !== "gone")
      return continuationHolds(made, found, change, options.compare)
        ? {
            answer: answered(itemsOf(member, found)),
            rollbackTag:
              options.recoverRollback && sameCalendarContent(text, found.text) ? strongTag(found.tag) : null,
          }
        : refused("version_stale");
    if (options.requireExisting) return refused("version_stale");
    const hear = await inviteesHear(s, collection, text);
    if (hear !== true) return hear;
    const res = await send(s, "PUT", member, text, { kind: "new" });
    if ("ok" in res) return res;
    if (res.status !== 412 && res.status !== 200 && res.status !== 201 && res.status !== 204)
      return refusalOf(res, "not_found");
    if (options.sendLegacy && res.status !== 412)
      return { answer: await afterWrite(s, collection, member, res, text), rollbackTag: null };
    const now = await readMember(s, collection, member);
    if (failedRead(now)) return now;
    if (now === "gone") return refused(options.sendLegacy ? "unknown" : "unavailable");
    if (!continuationHolds(made, now, change, options.compare))
      return refused(options.sendLegacy && !options.compare ? "unknown" : "version_stale");
    const tag = res.status === 412 ? null : res.header("etag");
    const verified = res.status === 412 ? null : writtenTag(tag, now, text);
    const items = itemsOf(member, now);
    return {
      answer:
        verified !== null && !items.some((item) => item.kind === "upsert" && item.resourceIncomplete)
          ? wrote(items)
          : answered(items),
      rollbackTag: strongTag(tag) ?? (options.compare ? verified : null),
    };
  }

  /** A change refused for its version: done where the member already holds every field of it; else made on another copy. */
  async function afterStale(
    s: Session,
    collection: string,
    member: string,
    change: EventChange | null,
    wantedSeries?: string,
    known?: Fetched,
    reviewedException = false,
  ): Promise<WriteAnswer> {
    const now = known ?? (await readMember(s, collection, member));
    if (failedRead(now)) return now;
    if (now === "gone")
      return change === null ? answered([{ kind: "gone", id: member }]) : refused("event_gone");
    if (change === null || (wantedSeries && !sameSchedule(wantedSeries, now.text)))
      return refused("version_stale");
    if (reviewedException && (!wantedSeries || !sameReviewedSeries(wantedSeries, now.text)))
      return refused("version_stale");
    const event = heldEvent(now.text);
    return event !== null && alreadyHolds(change, event, deps.zones)
      ? answered(itemsOf(member, now))
      : refused("version_stale");
  }

  /**
   * A write of one day refused for its version: done where the member already has that day as the
   * write wants it (changed so, or cancelled: excluded, or a day its rule does not name); else it was
   * made on another copy, a cancelled day past the series' end that the series does not exclude among
   * them.
   */
  async function afterStaleDay(
    s: Session,
    collection: string,
    member: string,
    was: EventTime,
    change: EventChange | null,
    wantedSeries?: string,
    requireExclusion = false,
    known?: Fetched,
  ): Promise<WriteAnswer> {
    const now = known ?? (await readMember(s, collection, member));
    if (failedRead(now)) return now;
    if (now === "gone")
      return change === null ? answered([{ kind: "gone", id: member }]) : refused("event_gone");
    if (wantedSeries && !sameSchedule(wantedSeries, now.text)) return refused("version_stale");
    if (change === null && dayOfAnotherCopy(now.text, was, deps.zones)) return refused("version_stale");
    const done =
      change === null
        ? dayAbsent(now.text, was, deps.zones, requireExclusion)
        : dayHolds(now.text, was, change, deps.zones);
    return done ? answered(itemsOf(member, now)) : refused("version_stale");
  }

  async function changeSharedCopy(
    s: Session,
    place: { collection: string; member: string },
    target: WriteTarget,
    change: EventChange,
  ): Promise<WriteAnswer> {
    if (
      !ordinarySharedChange(change) ||
      target.occurrence ||
      target.recurringSeries ||
      target.exception ||
      (target.text !== null && storedObjectFacts(target.text, null).organizer === "")
    )
      return refused("read_only");
    const version = strongTag(target.version);
    if (!version) return refused("version_unknown");
    const current = await readMember(s, place.collection, place.member);
    if (current === "gone") return refused("event_gone");
    if (failedRead(current)) return current;
    if (current.tag !== version || (target.text !== null && !sameCalendarText(current.text, target.text)))
      return refused("version_stale");

    const read = readCalendar(current.text, DEFAULT_LIMITS);
    if (
      !read.ok ||
      read.dropped.length ||
      read.calendar.events.length !== 1 ||
      read.calendar.tree.properties.some((property) => spelledAs(property, "METHOD")) ||
      read.calendar.tree.components.some(({ name }) => name !== "VEVENT" && name !== "VTIMEZONE")
    )
      return refused("read_only");
    const event = read.calendar.events[0]!;
    const organizer = storedObjectFacts(current.text, null).organizer;
    if (
      event.recurrenceId ||
      event.rules.length ||
      event.added.length ||
      organizer === "" ||
      (target.text === null && (organizer !== null || event.attendees.length))
    )
      return refused("read_only");
    // A scheduling object needs an organizer (RFC 6638 §3.1). Where one is
    // present, use a PUT only on a server advertising CalDAV without auto-scheduling.
    if (organizer !== null) {
      const scheduling = await sendsInvitations(s, place.collection, true);
      if (scheduling !== false) return scheduling === true ? refused("read_only") : scheduling;
    }
    const text = changedObjectText(current.text, change, deps.clock.now(), deps.zones);
    if (!text.ok) return refused(text.reason === "not_found" ? "event_gone" : text.reason);
    const res = await send(s, "PUT", place.member, text.text, { kind: "unchanged", tag: version });
    if ("ok" in res) return res;
    if (res.status === 412) return refused("version_stale");
    if (res.status !== 200 && res.status !== 201 && res.status !== 204) return refusalOf(res, "event_gone");
    return afterWrite(s, place.collection, place.member, res, text.text);
  }

  return {
    provider: "caldav",

    async findMoveCopy(c, cal, key, signal) {
      const uid = uuidOf(key);
      const collection = addressOf(cal.id);
      if (uid === null || collection === null) return refused("not_found");
      const member = addressOf(`${uid}.ics`, `${collection.replace(/\/+$/, "")}/`);
      return member === null ? refused("not_found") : this.readForMove!(c, cal, member, signal);
    },

    async readForMove(c, cal, id, signal) {
      const opened = caldavSession(deps, c, signal);
      if (!opened.ok) return opened;
      const place = placeOf(cal, id);
      if (!place) return refused("address_not_allowed");
      const found = await readMember(opened.session, place.collection, place.member);
      if (failedRead(found)) return found;
      return found === "gone" ? answered([{ kind: "gone", id }]) : answered(itemsOf(place.member, found));
    },

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
      if (!exceptionMatchesTarget(target)) return refused("version_stale");
      const opened = caldavSession(deps, c, signal);
      if (!opened.ok) return opened;
      const s = opened.session;
      const place = placeOf(cal, target.id);
      if (place === null) return refused("address_not_allowed");
      if (target.sharedCopy) return changeSharedCopy(s, place, target, change);
      const live = target.recurringSeries ? await readMember(s, place.collection, place.member) : null;
      if (live === "gone") return refused("event_gone");
      if (live !== null && failedRead(live)) return live;
      if (live !== null && live.tag !== target.version && target.text === null)
        return refused("version_stale");
      const stood =
        live?.tag === target.version && sendableTag(live.tag)
          ? { tag: live.tag, text: live.text }
          : await standing(s, place.collection, place.member, target);
      if ("ok" in stood) return stood;
      if (target.personalSeries && !personalSeriesOf(stood.text)) return refused("version_stale");
      if (target.recurringSeries && !seriesAudienceHolds(stood.text, target, "change"))
        return refused("version_stale");
      // A change that names invitees (an empty list too) is told to them, and to those it takes off, by the server alone.
      if (change.attendees !== undefined) {
        if (
          target.recurringSeries ||
          target.personalSeries ||
          target.occurrence !== null ||
          heldEvent(stood.text)?.rules.length
        )
          return refused("field_unwritable");
        const sends = await sendsInvitations(s, place.collection);
        if (sends !== true) return sends === false ? refused("invitees_unsupported") : sends;
      }
      if (target.audience && !target.recurringSeries) {
        const read = readCalendar(stood.text, DEFAULT_LIMITS);
        const event =
          read.ok && read.dropped.length === 0 && read.calendar.events.length === 1
            ? read.calendar.events[0]
            : null;
        if (
          !event ||
          !sameAudience(
            target.audience,
            event,
            event.component.properties.filter((p) => spelledAs(p, "ATTENDEE")).length,
          )
        )
          return refused("version_stale");
      }
      const was = target.occurrence;
      // One day of a series is written in that day's own component; the series and its other days stay as they were.
      const text =
        was === null
          ? changedObjectText(stood.text, change, deps.clock.now(), deps.zones, target.exception?.occurrence)
          : dayChangedText(
              stood.text,
              was,
              change,
              deps.clock.now(),
              deps.zones,
              target.exception !== undefined,
            );
      if (!text.ok) return refused(text.reason === "not_found" ? "event_gone" : text.reason);
      const wanted = target.personalSeries || target.recurringSeries ? text.text : undefined;
      const checkStale = (now?: Fetched) =>
        was === null
          ? afterStale(s, place.collection, place.member, change, wanted, now, target.exception !== undefined)
          : afterStaleDay(s, place.collection, place.member, was, change, wanted, false, now);
      if (live !== null && live.tag !== stood.tag) return checkStale(live);
      // Other changes are sent by the server to the event's invitees. The account's own reminders are private.
      if (change.attendees === undefined && !remindersOnly(change)) {
        const hear = await inviteesHear(s, place.collection, stood.text);
        if (hear !== true) return hear;
      }
      const res = await send(s, "PUT", place.member, text.text, { kind: "unchanged", tag: stood.tag });
      if ("ok" in res) return res;
      if (res.status === 412) return checkStale();
      if (res.status !== 200 && res.status !== 201 && res.status !== 204) return refusalOf(res, "event_gone");
      return afterWrite(s, place.collection, place.member, res, text.text);
    },

    async remove(c, cal, target, signal) {
      const opened = caldavSession(deps, c, signal);
      if (!opened.ok) return opened;
      const s = opened.session;
      const place = placeOf(cal, target.id);
      if (place === null) return refused("address_not_allowed");
      const was = target.occurrence;
      if (target.caldavReadOnly) {
        return was === null
          ? afterStale(s, place.collection, place.member, null)
          : afterStaleDay(s, place.collection, place.member, was, null, undefined, true);
      }
      if (was !== null) {
        // One day cancelled: an excluded day in the series' own component, and the day's own component out. The member stays.
        const stood = await standing(s, place.collection, place.member, target);
        if ("ok" in stood) return stood;
        const hear = await inviteesHear(s, place.collection, stood.text);
        if (hear !== true) return hear;
        const text = dayCancelledText(stood.text, was, deps.zones);
        if (!text.ok) return refused(text.reason === "not_found" ? "event_gone" : text.reason);
        // No day of the series at `was`: done as it stands where the series excludes that day (past its end too) or its rule
        // does not name it; a day past the series' end that it does not exclude is another copy than the one the write was made
        // on (the fourth recheck's finding of a removal shown done while its days stand).
        if ("absent" in text)
          return dayOfAnotherCopy(stood.text, was, deps.zones) ? refused("version_stale") : answered([]);
        const res = await send(s, "PUT", place.member, text.text, { kind: "unchanged", tag: stood.tag });
        if ("ok" in res) return res;
        if (res.status === 412) return afterStaleDay(s, place.collection, place.member, was, null);
        if (res.status !== 200 && res.status !== 201 && res.status !== 204)
          return refusalOf(res, "event_gone");
        return afterWrite(s, place.collection, place.member, res, text.text);
      }
      let tag = target.version;
      let held = target.text;
      // The object as it stands where the store keeps no sendable version of it, or no text to tell its invitees by.
      if (!sendableTag(tag) || held === null) {
        const stood = await standing(s, place.collection, place.member, target);
        if ("ok" in stood)
          return stood.reason === "event_gone" ? answered([{ kind: "gone", id: target.id }]) : stood;
        tag = stood.tag;
        held = stood.text;
      }
      // An event removed, one or a series, where it has invitees: only where the server tells them.
      const hear = await inviteesHear(s, place.collection, held);
      if (hear !== true) return hear;
      const res = await send(s, "DELETE", place.member, null, { kind: "unchanged", tag });
      if ("ok" in res) return res;
      // Gone already is what a removal wants.
      if (res.status === 200 || res.status === 204) return wrote([{ kind: "gone", id: target.id }]);
      if (res.status === 404 || res.status === 410) return answered([{ kind: "gone", id: target.id }]);
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
      const was = target.occurrence;
      const reply = req.reply as PartStat;
      // The series' answer on its own line; one day's on that day's own component, the series and its other days as they were.
      const text =
        was === null
          ? answeredObjectText(stood.text, req.as, reply, deps.clock.now())
          : dayAnsweredText(stood.text, was, req.as, reply, deps.clock.now(), deps.zones);
      if (!text.ok) return refused(text.reason === "not_found" ? "not_found" : text.reason);
      const res = await send(s, "PUT", place.member, text.text, { kind: "unchanged", tag: stood.tag });
      if ("ok" in res) return res;
      if (res.status === 412) {
        // Refused for its version: done where the account's line already says it (an earlier attempt landed); else another copy.
        const now = await readMember(s, place.collection, place.member);
        if (failedRead(now)) return now;
        if (now === "gone") return refused("event_gone");
        return answerHolds(now.text, was, req.as, reply, deps.zones)
          ? answered(itemsOf(place.member, now))
          : refused("version_stale");
      }
      if (res.status !== 200 && res.status !== 201 && res.status !== 204) return refusalOf(res, "event_gone");
      return afterWrite(s, place.collection, place.member, res, text.text);
    },

    async endSeries(c, cal, target, req, signal) {
      if (!exceptionMatchesTarget(target) || (target.exception !== undefined && req.then === null))
        return refused("version_stale");
      const opened = caldavSession(deps, c, signal);
      if (!opened.ok) return opened;
      const s = opened.session;
      const place = placeOf(cal, target.id);
      if (place === null) return refused("address_not_allowed");
      const was = target.occurrence;
      if (was === null) return refused("field_unwritable");
      const readOnly = req.late === true || target.caldavReadOnly === true;
      const keepCancelled = req.then !== null;
      const createFirst =
        req.then !== null && (target.recurringSeries === true || req.then.requireExisting === true);
      const endedText = (text: string) =>
        seriesEndedText(text, was, deps.clock.now(), deps.zones, {
          keepCancelled,
          rejectFutureOverrides: keepCancelled && target.recurringSeries === true,
          replaceReviewedOverride: target.exception !== undefined,
        });
      const recoveredEnd = async (now: Exclude<Fetched, "gone">): Promise<WriteAnswer> => {
        // The same cutoff can be another client's edit. New queue rows require proof of their own first write.
        if (req.then?.requireExisting) {
          const made = continuation(cal, now.text, was, req.then);
          if ("ok" in made) return made;
          const proof = await ensureContinuation(s, made, req.then.change, {
            compare: true,
            requireExisting: true,
          });
          if ("ok" in proof) return proof;
        }
        return answered(itemsOf(place.member, now));
      };
      // The copy the write was made on, as the store holds it; where the store holds another, the member as it is now: done
      // where it ends exactly where this write ends it and that end may be this write's own (an earlier attempt of it landed, and
      // no other write may have made it), else made on another copy. An end too old to send (`late`) is only looked at, at the
      // member itself: found so on another version than the copy it was made on, it is done; nothing of it goes late.
      let stood: { readonly tag: string; readonly text: string };
      if (!readOnly && !createFirst && target.text !== null && sendableTag(target.version))
        stood = { tag: target.version, text: target.text };
      else {
        const now = await readMember(s, place.collection, place.member);
        if (failedRead(now)) return now;
        if (now === "gone") return refused("event_gone");
        const expected = target.recurringSeries && target.text !== null ? endedText(target.text) : null;
        if (
          req.mayBeDone &&
          (!target.personalSeries || personalSeriesOf(now.text)) &&
          ((!createFirst && !readOnly) || now.tag !== target.version) &&
          (expected === null || (expected.ok && sameSchedule(expected.text, now.text))) &&
          seriesEndsBefore(now.text, was, deps.zones)
        )
          return recoveredEnd(now);
        if (readOnly) return refused("version_stale");
        if (now.tag === null || !sendableTag(now.tag)) return refused("version_unknown");
        if (now.tag !== target.version) return refused("version_stale");
        stood = { tag: now.tag, text: now.text };
      }
      if (target.personalSeries && !personalSeriesOf(stood.text)) return refused("version_stale");
      if (target.recurringSeries && !seriesAudienceHolds(stood.text, target, "following"))
        return refused("version_stale");
      // The press's own copy ends before that day already: there are no days from it on to let go, and none to make a series of.
      if (seriesEndsBefore(stood.text, was, deps.zones))
        return req.then === null ? answered([]) : refused("event_gone");
      const made = req.then === null ? null : continuation(cal, stood.text, was, req.then);
      if (made !== null && "ok" in made) return made;
      // The ended series' invitees hear of the days it gives up from the server alone, where it sends invitations itself; the
      // series those days become asks the same invitees (the series' own, its organizer's own line kept).
      const hear = await inviteesHear(s, place.collection, stood.text);
      if (hear !== true) return hear;
      const text = endedText(stood.text);
      if (!text.ok) return refused(text.reason === "not_found" ? "event_gone" : text.reason);
      // DECIDED BY THE BUILDER: confirm the continuation exists while the original still holds its days.
      // The second queue row recovers this deterministic member and publishes it in the mirror.
      let created: { readonly member: string; readonly tag: string } | null = null;
      if (createFirst && req.then !== null && made !== null) {
        const result = await ensureContinuation(s, made, req.then.change, {
          compare: true,
          recoverRollback:
            req.mayBeDone && req.then.requireExisting === true && req.then.createdAtMs !== undefined,
        });
        if ("ok" in result) return result;
        if (result.rollbackTag !== null) created = { member: made.member, tag: result.rollbackTag };
      }
      const res = await send(s, "PUT", place.member, text.text, { kind: "unchanged", tag: stood.tag });
      if ("ok" in res) return res;
      if (res.status === 200 || res.status === 201 || res.status === 204)
        return afterWrite(s, place.collection, place.member, res, text.text);
      if (res.status === 412 || (created !== null && canRollBack(res.status))) {
        const now = await readMember(s, place.collection, place.member);
        if (created !== null && failedRead(now) && canRetryCleanup(now.reason)) return now;
        if (!failedRead(now) && now !== "gone") {
          if (
            res.status === 412 &&
            req.mayBeDone &&
            (!(target.personalSeries || target.recurringSeries) || sameSchedule(text.text, now.text)) &&
            seriesEndsBefore(now.text, was, deps.zones)
          )
            return recoveredEnd(now);
          // Someone else may have shortened or removed the original. Keep the continuation if its days are in doubt.
          if (created !== null && now.tag === stood.tag && sameSchedule(stood.text, now.text)) {
            const retry = await rollBack(s, created);
            if (retry !== null) return retry;
          }
        }
        if (res.status === 412)
          return failedRead(now) ? now : refused(now === "gone" ? "event_gone" : "version_stale");
      }
      return refusalOf(res, "event_gone");
    },

    async continueSeries(c, cal, req, signal) {
      const opened = caldavSession(deps, c, signal);
      if (!opened.ok) return opened;
      const s = opened.session;
      const uid = uuidOf(req.key);
      if (uid === null || addressOf(cal.id) === null) return refused("not_found");
      const source = placeOf(cal, req.from.id);
      if (source === null) return refused("address_not_allowed");
      const was = req.from.occurrence;
      if (was === null) return refused("field_unwritable");
      const legacy = !req.from.recurringSeries && !req.requireExisting;
      const legacyDraft = legacy ? req.event : undefined;
      // The series as the store holds it is what its days are made from (read once where the store keeps no text of it). They are
      // made only where the series no longer has them: where the store's copy goes on from that day, the member is read, and where
      // that goes on from it too (given a new repeat since its end, by the person or by another program) those days stand there,
      // and making them here would make them twice: refused for its copy, nothing sent.
      let from = req.from.text;
      if (
        legacyDraft !== undefined ||
        req.from.personalSeries ||
        req.from.recurringSeries ||
        from === null ||
        seriesGoesOnFrom(from, was, deps.zones)
      ) {
        const now = await readMember(s, source.collection, source.member);
        if (failedRead(now)) return now;
        if (now === "gone") return refused("event_gone");
        // The two parts are distinct writes. The cached end can have been reversed between them.
        if (
          (req.from.personalSeries || req.from.recurringSeries) &&
          (now.tag !== req.from.version || !seriesEndsBefore(now.text, was, deps.zones))
        )
          return refused("version_stale");
        if (seriesGoesOnFrom(now.text, was, deps.zones)) return refused("version_stale");
        from = now.text;
      }
      if (req.from.personalSeries && !personalSeriesOf(from)) return refused("version_stale");
      if (req.from.recurringSeries && !seriesAudienceHolds(from, req.from, "master"))
        return refused("version_stale");
      // The legacy second row can still create the member. Its queued invitees, not later mirrored ones,
      // determine who may hear of that creation.
      if (legacyDraft !== undefined) {
        const organizer = legacyDraft.organizer?.trim().toLowerCase() ?? null;
        const guests = legacyDraft.attendees
          .map(({ email }) => email.trim().toLowerCase())
          .filter((address) => address !== organizer);
        if (!seriesAudienceHolds(from, { ...req.from, audience: { organizer, guests } }, "master"))
          return refused("version_stale");
      }
      const made = continuation(cal, from, was, req);
      if ("ok" in made) return made;
      const result = await ensureContinuation(s, made, req.change, {
        compare: !!(req.from.personalSeries || req.from.recurringSeries || req.requireExisting),
        ...(req.requireExisting && { requireExisting: req.requireExisting }),
        sendLegacy: legacy,
      });
      return "ok" in result ? result : result.answer;
    },

    async moveEvent(c, from, to, target, signal) {
      if (target.occurrence !== null) return refused("repeat_unsupported");
      const opened = caldavSession(deps, c, signal);
      if (!opened.ok) return opened;
      const session = opened.session;
      const place = placeOf(from, target.id);
      const collection = addressOf(to.id);
      if (!place || !collection || new URL(place.collection).origin !== new URL(collection).origin)
        return refused("address_not_allowed");
      const pathname = new URL(place.member).pathname;
      const name = pathname.slice(pathname.lastIndexOf("/") + 1);
      const destination = addressOf(name, `${collection.replace(/\/+$/, "")}/`);
      if (!name || !destination || destination === place.member || !isUnder(scopeOf(collection), destination))
        return refused("address_not_allowed");
      const held = await standing(session, place.collection, place.member, { ...target, text: null });
      if ("ok" in held) {
        if (held.reason !== "event_gone" || !target.retryMove || target.text === null) return held;
        const reviewed = readCalendar(target.text, DEFAULT_LIMITS);
        if (!reviewed.ok || reviewed.dropped.length) return held;
        const uid = reviewed.calendar.events.find(({ recurrenceId }) => recurrenceId === null)?.uid;
        if (!uid) return held;
        const copy = await readMember(session, collection, destination);
        if (failedRead(copy)) return copy;
        return copy !== "gone" &&
          itemsOf(destination, copy).some(
            (item) => item.kind === "upsert" && item.event.recurrenceId === null && item.event.uid === uid,
          )
          ? answered([])
          : held;
      }
      if (!(await allowsMove(session, place.member))) return refused("unsupported");
      const members = seriesDeleteMembers(held.text, deps.zones, target.recurringSeries === true);
      const audience = members && deleteAudienceOf(members, { kind: "record" })?.audience;
      if (!audience || !target.audience || !sameDeleteAudience(audience, target.audience))
        return refused("version_stale");
      const answer = await leave(session, place.member, {
        method: "MOVE",
        body: null,
        headers: { destination, overwrite: "F" },
        precondition: { kind: "unchanged", tag: held.tag },
      });
      if (!answer.arrived) return refused(answer.reason);
      if (answer.status === 201 || answer.status === 204) return wrote([]);
      if (answer.status === 412) return refused("version_stale");
      return refusalOf(answer, "event_gone");
    },
  };
}
