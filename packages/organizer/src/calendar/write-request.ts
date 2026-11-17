/**
 * A RECORDED WRITE AS A WRITER'S CALL. Pure: the act a row keeps, the stored event it names and the
 * calendars it moves between, turned into one call of the provider's writer, or into the word that
 * refuses it before anything is sent. Nothing a person typed becomes an address, a header or an id
 * here: the writer is handed typed drafts and what a reading stored.
 */
import { eventTimeOf, parseRRule, type EventTime } from "@ohmail/cal-core";
import {
  repeatProven, type EventChange, type EventDraft, type ProviderRefusal, type ProviderWord, type RepeatShape, type WriteRefusal,
  type WriteReply, type WriteTarget,
} from "@ohmail/cal-providers";
import { isSeriesRow, type CalendarWritePayload } from "@trafficflow/db/calendar";

type Act = CalendarWritePayload["act"];
type Fields = Extract<Act, { kind: "calendar_event_create" }>["event"];
type Time = Fields["start"];

/** A word a write is refused with, from either list, or the queue's own. */
export type WriteWord = ProviderRefusal | WriteRefusal | "content_refused";

/**
 * The stored event a write names, as the drain read it under the account's binding. Its version is
 * not here: a write is sent under the version it was recorded on, which its own row keeps.
 */
export interface StoredEvent {
  readonly providerId: string;
  readonly original: string | null;
  /** What makes it a series or one day of one (`isSeriesRow`). */
  readonly repeatRule: string | null;
  readonly recurrenceId: string;
  readonly addedDates: unknown;
  /** The account's own address among the event's invitees, where it has one. */
  readonly ownInvitee: string | null;
}

export type WriteCall =
  | { readonly kind: "create"; readonly draft: EventDraft }
  | { readonly kind: "change"; readonly target: WriteTarget; readonly change: EventChange }
  | { readonly kind: "remove"; readonly target: WriteTarget }
  | { readonly kind: "answer"; readonly target: WriteTarget; readonly as: string; readonly reply: WriteReply }
  | { readonly kind: "move"; readonly target: WriteTarget; readonly to: string }
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

/**
 * The call a recorded act makes, or the word that refuses it before anything leaves. `base` is the
 * row's `base_version_tag`; `organizer` the account's own address, where it has one; `to` the
 * destination calendar's provider id, for a move.
 */
export function writeCallOf(o: {
  readonly provider: ProviderWord;
  readonly act: Act;
  readonly event: StoredEvent | null;
  readonly base: string | null;
  readonly organizer: string | null;
  readonly to: string | null;
  readonly proven?: Readonly<Record<ProviderWord, readonly RepeatShape[]>>;
}): WriteCall {
  const { act } = o;
  const unproven = (rule: EventDraft["rule"] | undefined): boolean => rule !== undefined && rule !== null && !repeatProven(o.provider, rule, o.proven);
  if (act.kind === "calendar_event_create") {
    const draft = draftOf(act.event, o.organizer);
    if (draft === null) return { kind: "refuse", reason: "content_refused" };
    if (unproven(draft.rule)) return { kind: "refuse", reason: "repeat_unsupported" };
    return { kind: "create", draft };
  }
  if (o.event === null) return { kind: "refuse", reason: "event_gone" };
  // A series, or one day of one, is written by no act of this version (no repeat is proven at a provider yet): a row recorded before the door refused such acts is not sent either.
  if (isSeriesRow(o.event)) return { kind: "refuse", reason: "repeat_unsupported" };
  // Only the record whole is written by this version: a day of a series waits for its own build.
  if ("scope" in act && act.scope.kind !== "record") return { kind: "refuse", reason: "content_refused" };
  const target = targetOf(o.event, o.base);
  if (target === null) return { kind: "refuse", reason: "version_unknown" };
  switch (act.kind) {
    case "calendar_event_update": {
      const change = changeOf(act.change, o.organizer);
      if (change === null) return { kind: "refuse", reason: "content_refused" };
      if (unproven(change.rule)) return { kind: "refuse", reason: "repeat_unsupported" };
      return { kind: "change", target, change };
    }
    case "calendar_event_delete":
      return { kind: "remove", target };
    case "calendar_event_answer":
      if (o.event.ownInvitee === null) return { kind: "refuse", reason: "content_refused" };
      return { kind: "answer", target, as: o.event.ownInvitee, reply: REPLY[act.answer] };
    case "calendar_event_move":
      return o.to === null ? { kind: "refuse", reason: "not_found" } : { kind: "move", target, to: o.to };
  }
}
