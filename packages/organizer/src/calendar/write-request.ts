/**
 * A RECORDED WRITE AS A WRITER'S CALL. Pure: the act a row keeps, the stored event it names and the
 * calendars it moves between, turned into one call of the provider's writer, or into the word that
 * refuses it before anything is sent. Nothing a person typed becomes an address, a header or an id
 * here: the writer is handed typed drafts and what a reading stored.
 */
import { eventTimeOf, formatRRule, parseRRule, storedTimeOf, type DeleteMember, type EventTime, type RRule, type StoredTime, type ZoneSource } from "@ohmail/cal-core";
import {
  clockOf, continuedSeries, endedRule, movedRule, offItsClock, sameTime, repeatDeleteScopes, seriesProven, untilSkipped, type EventChange, type EventDraft, type ProofPlace,
  type ProvenRepeats, type ProviderRefusal, type WriteRefusal, type WriteReply, type WriteTarget,
} from "@ohmail/cal-providers";
import {
  CONTINUED_FIELDS, isAttendeeCopy, sharedCopyNeedsProtection, verifiedOrganizer, writeActRefusal, writeRowOf, type CalendarWriteContinuation, type CalendarWritePayload, type CalendarWriteRowFacts,
  type ContinuedField,
} from "@trafficflow/db/calendar";
import { personalSeriesOf, confirmedDeleteAudience } from "@ohmail/cal-providers/series";
import { draftRepeatSupported, seriesEditShape } from "@ohmail/cal-providers/repeat-shapes";
import { timeOfKey } from "./map.js";

type Act = CalendarWritePayload["act"];
type Fields = Extract<Act, { kind: "calendar_event_create" }>["event"];
type Time = Fields["start"];

/** A word a write is refused with, from either list, or the queue's own. */
export type WriteWord = ProviderRefusal | WriteRefusal | "content_refused";

/**
 * The stored event a write names, as the drain read it under the account's binding. Its version is
 * not here: a write is sent under the version it was recorded on, which its own row keeps.
 */
export interface StoredEvent extends CalendarWriteRowFacts {
  readonly providerId: string;
  readonly uid?: string;
  readonly partial?: boolean;
  readonly portableCopy?: boolean;
  readonly original: string | null;
  /** The version of the copy the store holds now: a write goes under its own recorded one. */
  readonly versionTag: string | null;
  readonly updatedAt?: Date;
  readonly status?: string;
  readonly thisAndFuture?: boolean;
  /** The first day's end as the row keeps it. */
  readonly endKind: string | null;
  readonly endLocal: string | null;
  readonly endZone: string | null;
  /** The days of its series that are not as its rule makes them (`changedDaysOf`): its excluded days and its changed days' rows. */
  readonly changedDays: number;
  /** The account's own address among the event's invitees, where it has one. */
  readonly ownInvitee: string | null;
  /** The version's stored guest list for a Google or Microsoft deletion. */
  readonly deleteGuests?: DeleteMember["guests"];
}

/** The start as the row keeps it: a series' first day. */
const startOf = (e: StoredEvent): EventTime | null =>
  eventTimeOf((e.startZone === null ? { kind: e.startKind, value: e.startLocal } : { kind: e.startKind, value: e.startLocal, zone: e.startZone }) as StoredTime);
/** The first day's end as the row keeps it. */
const endOf = (e: StoredEvent): EventTime | null =>
  e.endKind === null || e.endLocal === null ? null
    : eventTimeOf((e.endZone === null ? { kind: e.endKind, value: e.endLocal } : { kind: e.endKind, value: e.endLocal, zone: e.endZone }) as StoredTime);

export type WriteCall =
  | { readonly kind: "create"; readonly draft: EventDraft }
  | { readonly kind: "change"; readonly target: WriteTarget; readonly change: EventChange }
  | { readonly kind: "remove"; readonly target: WriteTarget }
  | { readonly kind: "answer"; readonly target: WriteTarget; readonly as: string; readonly reply: WriteReply }
  | { readonly kind: "move"; readonly target: WriteTarget; readonly to: string }
  | { readonly kind: "end"; readonly target: WriteTarget }
  /** The days of the series `from` names from its day `from.occurrence` on, made from that series' own component. */
  | {
      readonly kind: "continue"; readonly from: WriteTarget; readonly start: EventTime; readonly end: EventTime; readonly rule: RRule;
      readonly change: EventChange; readonly event: EventDraft; readonly requireExisting?: true;
    }
  | { readonly kind: "refuse"; readonly reason: WriteWord };

const timeOf = (t: Time): EventTime | null =>
  eventTimeOf(t.zone === undefined ? { kind: t.kind, value: t.value } : { kind: t.kind, value: t.value, zone: t.zone });

/** An event's fields as a writer's draft, or `null` for fields this version cannot turn into one. */
export function draftOf(f: Fields, organizer: string | null): EventDraft | null {
  const start = timeOf(f.start);
  const end = timeOf(f.end);
  const rule = f.repeat === null ? null : parseRRule(f.repeat);
  if (start === null || end === null || (f.repeat !== null && rule === null)) return null;
  return {
    start, end, summary: f.title, description: f.notes, location: f.place, url: f.callLink, busy: f.busy, private: f.private,
    rule, organizer: f.invitees.length > 0 ? organizer : null,
    attendees: f.invitees.map((p) => ({ email: p.address, name: p.name, optional: p.role === "optional" })),
    alarms: [...f.alarms],
  };
}

/** Of a draft, the fields the person named for the days a press gives a series of their own, as a writer's change. */
function namedChange(d: EventDraft, named: readonly ContinuedField[]): EventChange {
  const out: { -readonly [K in keyof EventDraft]?: EventDraft[K] } = {};
  for (const f of named) {
    if (f === "title") out.summary = d.summary;
    if (f === "notes") out.description = d.description;
    if (f === "place") out.location = d.location;
    if (f === "callLink") out.url = d.url;
    if (f === "busy") out.busy = d.busy;
    if (f === "private") out.private = d.private;
    if (f === "alarms") out.alarms = [...d.alarms];
  }
  return out;
}

/** A change's fields as a writer's change, or `null` for fields this version cannot turn into one. */
export function changeOf(c: Partial<Fields>, organizer: string | null): EventChange | null {
  const out: { -readonly [K in keyof EventDraft]?: EventDraft[K] } = {};
  if (c.start !== undefined || c.end !== undefined) {
    if (c.start === undefined || c.end === undefined) return null;
    const start = timeOf(c.start);
    const end = timeOf(c.end);
    if (start === null || end === null) return null;
    out.start = start;
    out.end = end;
  }
  if (c.title !== undefined) out.summary = c.title;
  if (c.notes !== undefined) out.description = c.notes;
  if (c.place !== undefined) out.location = c.place;
  if (c.callLink !== undefined) out.url = c.callLink;
  if (c.busy !== undefined) out.busy = c.busy;
  if (c.private !== undefined) out.private = c.private;
  if (c.repeat !== undefined) {
    const rule = c.repeat === null ? null : parseRRule(c.repeat);
    if (c.repeat !== null && rule === null) return null;
    out.rule = rule;
  }
  if (c.invitees !== undefined) {
    out.attendees = c.invitees.map((p) => ({ email: p.address, name: p.name, optional: p.role === "optional" }));
    out.organizer = c.invitees.length > 0 ? organizer : null;
  }
  if (c.alarms !== undefined) out.alarms = [...c.alarms];
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * The stored object as a writer's target, under `base`: the version the write was recorded on (or
 * re-based onto by the write it waited for), never the store's copy now, which a reading may have
 * moved on since. Never empty: without it nothing is sent.
 */
function targetOf(e: StoredEvent, base: string | null): WriteTarget | null {
  if (base === null || base === "") return null;
  return { id: e.providerId, version: base, text: e.original, occurrence: null };
}

const REPLY = { accepted: "ACCEPTED", tentative: "TENTATIVE", declined: "DECLINED" } as const;

const sameStored = (a: Time, t: EventTime): boolean => {
  const b = storedTimeOf(t);
  return a.kind === b.kind && a.value === b.value && (a.zone ?? null) === (b.zone ?? null);
};

/**
 * Is this row one of the shapes a press is recorded in (the door's rows), so that no part of a press
 * goes out of its press? A change of a day and the days after it only as the first of two parts
 * (its own key the press's) with its second there; their removal only alone (the series' end, no
 * part); a press's second part only as the new series after that press's own first (`firstKey`: the
 * key of the row it waits for), under the press's key and `:2`, where that first ended the series at
 * the very day the second goes on from (`firstEnded`: the day its applied row keeps); every other act
 * as no part at all. A row of another shape is no door's, and nothing of it is sent.
 */
export function pressShaped(o: {
  readonly act: Act; readonly part: CalendarWritePayload["part"]; readonly key: string; readonly firstKey: string | null; readonly second: boolean;
  readonly firstEnded: string | null;
}): boolean {
  const { act, part } = o;
  const following = "scope" in act && act.scope.kind === "following";
  if (following && act.kind === "calendar_event_update") return part !== null && part.n === 1 && part.of === o.key && o.second;
  if (following || part === null) return part === null;
  return part.n === 2 && act.kind === "calendar_event_create" && part.from !== undefined && o.key === `${part.of}:2` && o.firstKey === part.of
    && o.firstEnded === part.from.at;
}

/**
 * Is the second part of a press on a day and the days after it the one this first part makes: from
 * this very series, from that day, naming what the person named, as the person named it? Asked of
 * every first part, whatever copy the store holds; a second part that is not is never sent, and
 * neither is its first.
 */
export function secondPartIsThePress(first: Extract<Act, { kind: "calendar_event_update" }>, second: CalendarWritePayload): boolean {
  const made = second.act;
  const from = second.part?.from;
  if (made.kind !== "calendar_event_create" || first.scope.kind !== "following" || from === undefined) return false;
  const named = CONTINUED_FIELDS.filter((f) => first.change[f] !== undefined);
  if (from.personalSeries !== first.personalSeries || (first.audience !== undefined && !from.confirmed) ||
    from.at !== first.scope.at || from.eventId !== first.eventId ||
    [...from.named].sort().join() !== [...named].sort().join()) return false;
  return !named.some((f) => JSON.stringify(made.event[f]) !== JSON.stringify(first.change[f]));
}

/**
 * Is the second part of a press on a day and the days after it the series that press makes of the
 * series as it stands (`continuedSeries`, the door's own reckoning): its start, its end and its
 * repeat (a count going on with what is left, an end on a day moved with a new time)? A second part
 * that is not is never sent, and neither is its first.
 */
export function secondPartHolds(
  event: StoredEvent, first: Extract<Act, { kind: "calendar_event_update" }>, second: CalendarWritePayload, zones: ZoneSource,
): boolean {
  const made = second.act;
  if (made.kind !== "calendar_event_create" || first.scope.kind !== "following" || !secondPartIsThePress(first, second)) return false;
  const start = startOf(event);
  const end = endOf(event);
  const rule = event.repeatRule === null ? null : parseRRule(event.repeatRule);
  const at = /^\d{1,16}$/.test(first.scope.at) ? Number(first.scope.at) : Number.NaN;
  if (start === null || end === null || rule === null || !Number.isSafeInteger(at)) return false;
  const c = first.change;
  const times = {
    ...(c.start === undefined ? {} : { start: timeOf(c.start) ?? undefined }),
    ...(c.end === undefined ? {} : { end: timeOf(c.end) ?? undefined }),
    ...(c.repeat === undefined || c.repeat === null ? {} : { rule: parseRRule(c.repeat) ?? undefined }),
  };
  const next = continuedSeries({ first: start, firstEnd: end, rule }, at, times, zones);
  return next !== null && sameStored(made.event.start, next.start) && sameStored(made.event.end, next.end)
    && made.event.repeat === formatRRule(next.rule);
}

/**
 * The call a recorded act makes, or the word that refuses it before anything leaves. `base` is the
 * row's `base_version_tag`; `organizer` the account's own address, where it has one; `to` the
 * destination calendar's provider id, for a move. A repeat is written only in a shape proven at the
 * connection's place (`place`: its provider's word, or a CalDAV server's own host), from a start the
 * rule names (`seriesProven`).
 */
export function writeCallOf(o: {
  readonly place: ProofPlace | null;
  readonly act: Act;
  readonly event: StoredEvent | null;
  readonly base: string | null;
  readonly organizer: string | null;
  /** Whose an event is, lower case: the account's mailboxes by the one own set, and the connection's principal. */
  readonly owners: ReadonlySet<string>;
  readonly access: string;
  readonly to: string | null;
  readonly zones: ZoneSource;
  /** Now, in epoch milliseconds: a series' days are held against the clock times its zone skips from today on. */
  readonly now: number;
  readonly proven?: ProvenRepeats;
  readonly cancellationAttempted?: boolean;
  readonly firstAttempt?: boolean;
  readonly confirmedFollowing?: boolean;
  readonly exception?: WriteTarget["exception"];
  readonly seriesCancellation?: WriteTarget["seriesCancellation"];
  /**
   * The second half of a press on a day and the days after it: where it comes from, and that series
   * as the store holds it (`null`: gone from the store). Its new series is made from that series'
   * own component, never from the act's fields alone.
   */
  readonly continuation?: { readonly from: CalendarWriteContinuation; readonly source: StoredEvent | null };
}): WriteCall {
  const { act } = o;
  const caldav = o.place?.startsWith("caldav:") === true;
  if (act.kind === "calendar_event_delete" && act.localOnly) return { kind: "refuse", reason: "read_only" };
  const seriesEdit = act.kind === "calendar_event_update" && (act.audience !== undefined || o.confirmedFollowing) &&
    o.event !== null && writeRowOf(o.event) === "series";
  const editing = seriesEdit || o.continuation?.from.confirmed === true;
  const unproven = (rule: EventDraft["rule"] | undefined, start: EventTime | null): boolean =>
    rule !== undefined && rule !== null && (start === null || !(editing
      ? seriesEditShape(o.place, rule, start, o.zones, o.now)
      : seriesProven(o.place, rule, start, o.zones, o.now, o.proven)));
  if (act.kind === "calendar_event_create") {
    const draft = draftOf(act.event, o.organizer);
    if (draft === null) return { kind: "refuse", reason: "content_refused" };
    const unsupported = act.repeatSelected && draft.rule !== null && o.continuation === undefined
      ? !draftRepeatSupported(o.place, draft.rule, draft.start, o.zones, o.now)
      : unproven(draft.rule, draft.start);
    if (unsupported) return { kind: "refuse", reason: "repeat_unsupported" };
    if (o.continuation === undefined) {
      if (caldav && draft.attendees.length > 0 && draft.organizer === null) return { kind: "refuse", reason: "invitees_unsupported" };
      return { kind: "create", draft };
    }
    const { from, source } = o.continuation;
    if (source === null) return { kind: "refuse", reason: "event_gone" };
    if (from.personalSeries && (!o.place?.startsWith("caldav:") || !personalSeriesOf(source.original))) return { kind: "refuse", reason: "version_stale" };
    // A new series goes out under the series' own organizer. An attendee copy cannot be carried on.
    if (isAttendeeCopy(source, o.owners, o.access) || sharedCopyNeedsProtection(source, o.owners, o.access)) return { kind: "refuse", reason: "read_only" };
    const cut = timeOfKey(from.at);
    if (draft.rule === null || cut === null) return { kind: "refuse", reason: "content_refused" };
    if (source.versionTag === null || source.versionTag === "") return { kind: "refuse", reason: "version_unknown" };
    const organizer = source.organizer?.trim().toLowerCase() ?? null;
    const attendees = draft.attendees.filter((person) => person.email.trim().toLowerCase() !== organizer);
    const audience = { organizer, guests: attendees.map((person) => person.email.trim().toLowerCase()).sort() };
    return {
      kind: "continue", from: { id: source.providerId, version: source.versionTag, text: source.original, occurrence: cut,
        ...(from.confirmed ? { recurringSeries: true, audience } : from.personalSeries ? { personalSeries: true } : {}) },
      start: draft.start, end: draft.end, rule: draft.rule, change: namedChange(draft, from.named),
      event: { ...draft, organizer, attendees },
      ...(from.confirmed && { requireExisting: true }),
    };
  }
  if (o.event === null) return { kind: "refuse", reason: "event_gone" };
  if (act.kind === "calendar_event_update" && o.access === "writer" && o.event.partial)
    return { kind: "refuse", reason: "read_only" };
  if (seriesEdit && o.firstAttempt && o.event.updatedAt && o.event.updatedAt.getTime() !== Date.parse(act.base))
    return { kind: "refuse", reason: "version_stale" };
  const personal = act.kind === "calendar_event_update" && act.personalSeries;
  if (personal && (!o.place?.startsWith("caldav:") || o.event.myAnswer !== null || !personalSeriesOf(o.event.original))) return { kind: "refuse", reason: "version_stale" };
  // What the door refuses on this row as it stands is not sent either: a row recorded before a check of the door's. An attendee copy takes
  // only the account's answer.
  const why = writeActRefusal(o.event, act, o.event.changedDays, o.owners, o.access, o.exception !== undefined);
  if (why !== null) return { kind: "refuse", reason: why.word };
  // A series is written only where its own repeat, from its own start, is a shape the provider was proven to keep.
  const stored = writeRowOf(o.event) === "series" ? parseRRule(o.event.repeatRule!) : null;
  const first = startOf(o.event);
  let updateAudience = act.kind === "calendar_event_update" ? act.audience : undefined;
  if (stored !== null && act.kind === "calendar_event_update" && !updateAudience && (!personal || o.confirmedFollowing)) {
    const organizer = o.event.organizer?.trim().toLowerCase() ?? null;
    const guests = o.event.deleteGuests;
    if (!guests || guests.some((person) => person.address.trim().toLowerCase() !== organizer) ||
      (o.place?.startsWith("caldav:") && o.event.original !== null &&
        !confirmedDeleteAudience(o.place, o.event, true, act.scope, undefined, o.zones)))
      return { kind: "refuse", reason: "version_stale" };
    if (o.place === "google" || o.place === "microsoft" || o.confirmedFollowing) updateAudience = { organizer, guests: [] };
  }
  if (writeRowOf(o.event) === "series") {
    const cloud = o.place === "google" || o.place === "microsoft";
    const checkingStoredCloudSeries = cloud && (act.kind === "calendar_event_answer" || (act.kind === "calendar_event_move" && act.audience !== undefined));
    const reviewedDelete = act.kind === "calendar_event_delete" && act.audience !== undefined;
    if (stored === null || first === null || (!reviewedDelete && (checkingStoredCloudSeries
      ? !seriesEditShape(o.place, stored, first, o.zones, o.now)
      : unproven(stored, first)))) return { kind: "refuse", reason: "repeat_unsupported" };
    if (act.kind === "calendar_event_delete" &&
      !repeatDeleteScopes(o.place, stored, first, o.zones, o.now, o.proven).includes(act.scope.kind))
      return { kind: "refuse", reason: "repeat_unsupported" };
  }
  // A day of the series whose clock time is not the series' own (the night its zone's clocks go forward over that time) is named by
  // no write, one day or the days from it on, whatever today is: where it is written would be a guess. The door refuses the same.
  const firstDayEnd = endOf(o.event);
  const series = stored === null || first === null || firstDayEnd === null ? null : { first, firstEnd: firstDayEnd, rule: stored };
  if ("scope" in act && act.scope.kind !== "record" && series !== null && offItsClock(series, act.scope.at, o.zones)) {
    return { kind: "refuse", reason: "repeat_unsupported" };
  }
  // One day of the series, or the day the series ends before, is named by the time it was first at, as its key says it.
  const day = "scope" in act && act.scope.kind !== "record" ? timeOfKey(act.scope.at) : null;
  if ("scope" in act && act.scope.kind !== "record" && day === null) return { kind: "refuse", reason: "content_refused" };
  const whole = targetOf(o.event, o.base);
  if (whole === null) return { kind: "refuse", reason: "version_unknown" };
  const deleteAudience = act.kind === "calendar_event_delete" && o.base === o.event.versionTag
    ? (o.seriesCancellation && act.scope.kind === "record" && stored && (o.place === "google" || o.place === "microsoft") ? (act.audience ?? null) : confirmedDeleteAudience(o.place, { ...o.event, unchangedSeries: o.event.changedDays === 0 }, stored !== null, act.scope, act.audience, o.zones))
    : null;
  const checkCancellation = act.kind === "calendar_event_delete" && o.cancellationAttempted === true
    && o.place?.startsWith("caldav:") === true && o.base !== o.event.versionTag;
  if (act.kind === "calendar_event_delete" && deleteAudience === null && !checkCancellation) {
    return { kind: "refuse", reason: "version_stale" };
  }
  const target: WriteTarget = {
    ...whole, occurrence: day, ...(o.exception && { exception: o.exception }), ...(personal && { personalSeries: true }),
    ...(stored !== null && updateAudience && { recurringSeries: true, audience: updateAudience,
      text: o.event.versionTag === o.base ? whole.text : null }),
    ...(checkCancellation && { caldavReadOnly: true, text: null }),
  };
  // A day and the days after it: the series ends before that day. Changed, those days are the second part of the press, a new series.
  // The series as it stands after its end is a shape the place was proven to keep too: an end is a rule of its own.
  // The series' end is made on the copy the press was made on: where the store holds another now, the writer reads the member and
  // takes it as done only where it ends exactly as this press ends it.
  if ("scope" in act && act.scope.kind === "following") {
    const at = /^\d{1,16}$/.test(act.scope.at) ? Number(act.scope.at) : Number.NaN;
    const ended = stored === null || first === null || !Number.isSafeInteger(at) ? null : endedRule(stored, first, at, o.zones);
    if (ended === null || unproven(ended, first)) return { kind: "refuse", reason: "repeat_unsupported" };
    // The days from that day on at a new time: their end moves with the time, which an end in the stretch the zone skips cannot
    // (`untilSkipped`, the door's own reckoning through `continuedSeries`): nothing of the press is sent.
    const cut = first === null ? null : clockOf(first, at, o.zones);
    const moved = act.kind === "calendar_event_update" && act.change.start !== undefined ? timeOf(act.change.start) : null;
    if (series !== null && cut !== null && moved !== null && !sameTime(cut, moved) && untilSkipped(series, o.zones)) {
      return { kind: "refuse", reason: "repeat_unsupported" };
    }
    return { kind: "end", target: o.event.versionTag === o.base ? target : { ...target, text: null } };
  }
  switch (act.kind) {
    case "calendar_event_update": {
      const event = o.event;
      const sharedCopy = sharedCopyNeedsProtection(event, o.owners, o.access);
      const existingAddress = event.organizer?.trim().toLowerCase();
      const noGuests = event.deleteGuests?.every(({ address }) => address.trim().toLowerCase() === existingAddress);
      if (sharedCopy) {
        if (event.partial || !event.deleteGuests) return { kind: "refuse", reason: "read_only" };
        const dav = o.place?.startsWith("caldav:") === true;
        if ((dav && event.original === null && (!noGuests || event.organizer !== null)) || (!dav && !noGuests))
          return { kind: "refuse", reason: "read_only" };
        if (event.original !== null && event.versionTag !== o.base) return { kind: "refuse", reason: "version_stale" };
      }
      if (caldav && act.change.invitees?.length && o.organizer === null) return { kind: "refuse", reason: "invitees_unsupported" };
      const organizer = !caldav && existingAddress && o.owners.has(existingAddress) ? existingAddress : o.organizer;
      let change = changeOf(act.change, organizer);
      if (change === null) return { kind: "refuse", reason: "content_refused" };
      // A whole series' new start, with no repeat named, moves the series' end (UNTIL) with it, from the series as it stands
      // now (behind a write of it that went first, too): its last day stays its last. Where it cannot be moved, nothing leaves.
      if (target.occurrence === null && stored !== null && first !== null && change.start !== undefined && change.rule === undefined) {
        const firstEnd = endOf(o.event);
        const moved = firstEnd === null ? null : movedRule(stored, first, firstEnd, first, change.start, o.zones);
        if (moved === null) return { kind: "refuse", reason: "repeat_unsupported" };
        if (moved !== stored) change = { ...change, rule: moved };
      }
      // The series as it would stand after a change of the record: its repeat (the new one, or its own) from its start (the new
      // one, or its own). One day's change moves that day alone; the series stands as it was, and was asked above.
      if (target.occurrence === null && unproven(change.rule === undefined ? stored : change.rule, change.start ?? first)) {
        return { kind: "refuse", reason: "repeat_unsupported" };
      }
      return { kind: "change", target: sharedCopy ? { ...target, sharedCopy: true } :
        act.audience ? { ...target, audience: act.audience } : target, change };
    }
    case "calendar_event_delete":
      // Cloud writers compare the live audience under this same provider version before deleting.
      return { kind: "remove", target: deleteAudience && (o.place === "google" || o.place === "microsoft")
        ? { ...target, audience: deleteAudience, ...(stored && { recurringSeries: true }), ...(o.seriesCancellation && { seriesCancellation: o.seriesCancellation }) }
        : target };
    case "calendar_event_answer":
      if (o.event.ownInvitee === null || o.event.status === "cancelled") return { kind: "refuse", reason: "content_refused" };
      return { kind: "answer", target: day === null ? target : { ...target, recurringSeries: true }, as: o.event.ownInvitee, reply: REPLY[act.answer] };
    case "calendar_event_move": {
      if (o.place === "google" && !verifiedOrganizer(o.event.organizer, o.owners))
        return { kind: "refuse", reason: "read_only" };
      if (o.to === null) return { kind: "refuse", reason: "not_found" };
      const audience = o.base === o.event.versionTag
        ? confirmedDeleteAudience(o.place, { ...o.event, unchangedSeries: o.event.changedDays === 0 },
          stored !== null, { kind: "record" }, act.audience, o.zones)
        : null;
      return audience
        ? { kind: "move", target: { ...target, audience, ...(stored && { recurringSeries: true }) }, to: o.to }
        : { kind: "refuse", reason: "version_stale" };
    }
  }
}
