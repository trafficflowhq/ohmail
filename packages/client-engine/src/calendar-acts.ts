/**
 * A PERSON'S CALENDAR ACTS OVER THE RECORDS THE FEED HOLDS: one pure overlay, used alike for the acts
 * still on this device and for the writes an event's record says the provider has not taken yet, and
 * the one selector a view reads, which says of each event whether it waits and where.
 *
 * Two waits, never blurred: `device` (the act is in this device's queue and has not reached our
 * server) and `provider` (our server holds it and the provider has not taken it). A write the
 * provider refused is not laid over the record: the record shows the provider's copy, and the
 * refusal beside it, with the act kept so the view can offer to send it again.
 *
 * Behind an entry of its own: the phone's engine, which keeps no calendar, never reaches it.
 */
import type {
  CalendarEventAct, CalendarRemoveScope, CalendarEventFields, CalendarEventRecord, CalendarWriteMark, CalendarReason, CalendarTime, CalendarWriteFault, ISODateTime,
} from "@ohmail/wire";

/** The instant a record this device made stands at until our server has it. */
const NOT_YET: ISODateTime = new Date(0).toISOString();

/** How far east of UTC `zone` is at `ms`, in ms, or `null` for a zone the platform does not know. */
function offsetAt(zone: string, ms: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ms));
    const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
    const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
    return Number.isFinite(wall) ? wall - Math.floor(ms / 1000) * 1000 : null;
  } catch {
    // A zone the platform does not know: read as UTC, as every reader of a record's range does.
    return null;
  }
}

/**
 * A time's moment as a record keeps it, for a view's place of an event the server has not ranged
 * yet: a day and a clock with no zone read as UTC, a clock in a zone resolved by the platform.
 */
function momentIso(t: CalendarTime): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(t.value);
  if (m === null) return null;
  const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  let ms = asUtc;
  if (t.kind === "zoned" && t.zone !== undefined) {
    const first = offsetAt(t.zone, asUtc);
    if (first !== null) {
      ms = asUtc - first;
      const second = offsetAt(t.zone, ms);
      if (second !== null && second !== first) ms = asUtc - second;
    }
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A record's fields set from an act's: each field present is written, the times with the moments they make. */
export function withCalendarFields(r: CalendarEventRecord, f: Partial<CalendarEventFields>): CalendarEventRecord {
  const next: CalendarEventRecord = { ...r };
  if (f.title !== undefined) next.title = f.title;
  if (f.notes !== undefined) next.notes = f.notes;
  if (f.place !== undefined) next.place = f.place;
  if (f.callLink !== undefined) next.callLink = f.callLink;
  if (f.busy !== undefined) next.busy = f.busy;
  if (f.private !== undefined) next.private = f.private;
  if (f.start !== undefined && f.end !== undefined) {
    next.start = f.start;
    next.end = f.end;
    next.duration = null;
    next.startsAt = momentIso(f.start) ?? r.startsAt;
    next.endsAt = f.repeat === undefined ? (r.repeat === null ? momentIso(f.end) : r.endsAt) : r.endsAt;
  }
  if (f.repeat !== undefined) {
    next.repeat = f.repeat === null ? null : { rules: [f.repeat], excluded: r.repeat?.excluded ?? [], added: r.repeat?.added ?? [] };
    // A series' last moment is the provider's to say; until then it may run on.
    next.endsAt = f.repeat === null ? momentIso(next.end ?? next.start) : null;
  }
  if (f.invitees !== undefined) {
    const confirmed = new Map(r.invitees.map(({ address, answer }) => [address.toLowerCase(), answer]));
    next.invitees = f.invitees.map((p) => ({ ...p, answer: confirmed.get(p.address.toLowerCase()) ?? "none" }));
  }
  if (f.alarms !== undefined) next.alarms = f.alarms.map((minutesBefore) => ({ minutesBefore, method: "notice" as const }));
  return next;
}

/** A new event as the person made it, before any server has it. */
function made(act: Extract<CalendarEventAct, { kind: "calendar_event_create" }>): CalendarEventRecord {
  const blank: CalendarEventRecord = {
    id: act.eventId, calendarId: act.calendarId, uid: "", recurrenceId: "", thisAndFuture: false, sequence: 0, status: "confirmed",
    title: "", notes: null, place: null, callLink: null, start: act.event.start, end: act.event.end, duration: null,
    startsAt: NOT_YET, endsAt: null, occurrenceAt: null, repeat: null, busy: true, private: false, organizer: null,
    myAnswer: null, heldBack: false, invitees: [], alarms: [], cut: false, writes: [], updatedAt: NOT_YET,
  };
  return withCalendarFields(blank, act.event);
}

function sameAttendeeCopy(record: CalendarEventRecord, act: Extract<CalendarEventAct, {
  kind: "calendar_event_delete" | "calendar_event_answer";
}>): boolean {
  return act.copy?.calendarId === record.calendarId && act.copy.attendee === record.hideAttendee;
}

/**
 * THE ONE OVERLAY: `acts` laid over `records` in order. A new event appears; a change is written onto
 * the record whole; a removal takes it out; a move gives it its new calendar; an answer is the
 * account's own. An existing changed occurrence can take its own edit while it waits.
 */
export function applyCalendarActs(records: readonly CalendarEventRecord[], acts: readonly CalendarEventAct[]): CalendarEventRecord[] {
  const byId = new Map(records.map((r) => [r.id, r] as const));
  for (const act of acts) {
    if (act.kind === "calendar_event_create") {
      if (!byId.has(act.eventId)) byId.set(act.eventId, made(act));
      continue;
    }
    const r = byId.get(act.eventId);
    if (!r) continue;
    if (act.kind === "calendar_event_delete" && act.hide) {
      if (!sameAttendeeCopy(r, act) || r.thisAndFuture || r.heldBack || r.status === "cancelled" || r.myAnswer === "declined") continue;
      const [base, seriesBase] = act.base.split("/");
      const at = act.scope.kind === "record" ? "" : act.scope.at;
      if (base !== r.updatedAt) continue;
      let target = r;
      if (r.recurrenceId) {
        if (act.scope.kind !== "occurrence" || act.scope.at !== r.recurrenceId || !seriesBase) continue;
        const series = [...byId.values()].find((candidate) =>
            candidate.calendarId === r.calendarId && candidate.uid === r.uid && !candidate.recurrenceId &&
            candidate.repeat && candidate.updatedAt === seriesBase && candidate.hideAttendee === r.hideAttendee &&
            candidate.organizer?.address === r.organizer?.address);
        if (!series) continue;
        target = series;
      } else if (seriesBase || act.scope.kind === "following" ||
        act.scope.kind === "occurrence" && records.some((candidate) =>
          candidate.calendarId === r.calendarId && candidate.uid === r.uid && candidate.recurrenceId === at)) continue;
      const prior = target.hiddenOccurrences ?? [];
      if (!prior.includes("") && !prior.includes(at)) {
        byId.set(target.id, { ...target, hiddenOccurrences: at ? [...prior, at] : [""] });
      }
      continue;
    }
    if (act.kind === "calendar_event_answer" && act.copy && !sameAttendeeCopy(r, act)) continue;
    if (act.kind === "calendar_event_update" && r.recurrenceId !== "") {
      if (act.scope.kind === "occurrence" && act.scope.at === r.recurrenceId)
        byId.set(r.id, withCalendarFields(r, act.change));
      continue;
    }
    if ("scope" in act && act.scope.kind !== "record") {
      if (act.kind === "calendar_event_answer" && act.scope.at === r.recurrenceId)
        byId.set(r.id, { ...r, myAnswer: act.answer });
      continue;
    }
    switch (act.kind) {
      case "calendar_event_update": byId.set(r.id, withCalendarFields(r, act.change)); break;
      case "calendar_event_delete":
        byId.delete(r.id);
        if (r.repeat && r.uid) {
          for (const child of byId.values()) {
            if (child.calendarId === r.calendarId && child.uid === r.uid) byId.delete(child.id);
          }
        }
        break;
      case "calendar_event_move": if (!act.copyThenRemove) byId.set(r.id, { ...r, calendarId: act.toCalendarId }); break;
      case "calendar_event_answer": byId.set(r.id, { ...r, myAnswer: act.answer }); break;
    }
  }
  return [...byId.values()];
}

/** One act this device still holds, under the key it was pressed with. */
export interface DeviceAct {
  readonly key: string;
  readonly act: CalendarEventAct;
}

type Update = Extract<CalendarEventAct, { kind: "calendar_event_update" }>;
const occurrenceEdit = (act: CalendarEventAct | null): act is Update & { scope: { kind: "occurrence"; at: string } } =>
  act?.kind === "calendar_event_update" && act.scope.kind === "occurrence";

export interface OccurrenceEdit {
  readonly at: string;
  readonly change: Update["change"];
  readonly waiting: "device" | "provider";
}

/**
 * An answer to one day of a series that has no changed copy of that day yet: it waits, and is refused, on that day
 * alone (`at`, the day's key). `answer` is what the day shows while it waits; null once refused.
 */
export interface DayAnswer {
  readonly at: string;
  readonly answer: CalendarEventRecord["myAnswer"];
  readonly waiting: "device" | "provider" | null;
  readonly refusal: CalendarWriteFault | null;
  readonly refusedWriteId: string | null;
}

/** An answer of one day, named on the series' own record (the day has no record of its own). */
function dayAnswerOf(
  record: CalendarEventRecord | undefined,
  act: CalendarEventAct | null,
): Pick<DayAnswer, "at" | "answer"> | null {
  return act?.kind === "calendar_event_answer" && act.scope.kind === "occurrence" &&
    act.eventId === record?.id && record.recurrenceId === "" && (!act.copy || sameAttendeeCopy(record, act))
    ? { at: act.scope.at, answer: act.answer }
    : null;
}

/** An event as a view draws it: the record with every waiting write laid over, where it waits, and why one was refused. */
export interface EventWithWrites {
  readonly record: CalendarEventRecord;
  readonly waiting: "device" | "provider" | null;
  /** The last refusal: the provider's (on the record's marks) or our server's (of an act from this device). */
  readonly refusal: CalendarWriteFault | CalendarReason | null;
  /** The refused write a view can send again or let go; `null` for a refusal of our server's, which left nothing. */
  readonly refusedWriteId: string | null;
  readonly removals?: readonly CalendarRemoveScope[];
  readonly occurrenceEdits?: readonly OccurrenceEdit[];
  /** Answers to single days of this series, each that day's own: the record's wait and refusal leave them out. */
  readonly answers?: readonly DayAnswer[];
}

/**
 * THE SELECTOR: each event with its writes. The provider's pending writes (the record's marks) are
 * laid over first, then this device's own acts; a refused mark is shown, never laid over. `refused`
 * are this device's acts our server turned away, by event.
 */
export function eventsWithWrites(
  records: readonly CalendarEventRecord[], device: readonly DeviceAct[],
  refused: ReadonlyMap<string, CalendarReason | CalendarWriteFault> = new Map(),
): EventWithWrites[] {
  const original = new Map(records.map((r) => [r.id, r] as const));
  const exceptionMarks = new Map<string, CalendarWriteMark[]>();
  for (const r of records) {
    if (!r.repeat) continue;
    for (const mark of r.writes) {
      const act = mark.act;
      const child = act?.kind === "calendar_event_update" || act?.kind === "calendar_event_answer" ? original.get(act.eventId) : undefined;
      if (!child?.recurrenceId || child.uid !== r.uid || child.calendarId !== r.calendarId) continue;
      const previous = exceptionMarks.get(child.id);
      if (previous) previous.push(mark);
      else exceptionMarks.set(child.id, [mark]);
    }
  }
  const pending = records.flatMap((r) =>
    r.writes.filter((w) => w.state === "pending" && w.act !== null).map((w) => w.act!),
  );
  const base = applyCalendarActs(records, pending);
  const local = device.map((d) => d.act);
  const onDevice = new Set(
    local.filter((act) => {
      const record = original.get(act.eventId);
      return (!occurrenceEdit(act) || record?.recurrenceId) && dayAnswerOf(record, act) === null;
    }).map((act) => act.eventId),
  );
  const edits = pendingOccurrenceEdits(pending, local, original);
  const shown = applyCalendarActs(base, local);
  const hidden = new Map<string, CalendarRemoveScope[]>();
  for (const act of [...pending, ...local]) {
    if (act.kind !== "calendar_event_delete" || act.hide || act.scope.kind === "record") continue;
    const scopes = hidden.get(act.eventId);
    if (scopes) scopes.push(act.scope);
    else hidden.set(act.eventId, [act.scope]);
  }
  return shown.map((record) => {
    const own = original.get(record.id)?.writes ?? [];
    const fromSeries = exceptionMarks.get(record.id);
    const all = fromSeries ? [...own, ...fromSeries].sort((a, b) => a.at.localeCompare(b.at)) : own;
    const days = new Map<string, DayAnswer>();
    for (const w of all) {
      const act = dayAnswerOf(record, w.act);
      if (act === null) continue;
      days.set(act.at, w.state === "pending"
        ? { at: act.at, answer: act.answer, waiting: "provider", refusal: null, refusedWriteId: null }
        : { at: act.at, answer: null, waiting: null, refusal: w.reason, refusedWriteId: w.id });
    }
    for (const { act: done } of device) {
      const act = dayAnswerOf(record, done);
      if (act !== null) days.set(act.at, { at: act.at, answer: act.answer, waiting: "device", refusal: null, refusedWriteId: null });
    }
    const marks = days.size === 0 ? all : all.filter((w) => dayAnswerOf(record, w.act) === null);
    const lastRefused = [...marks].reverse().find((w) => w.state === "refused") ?? null;
    const removals = hidden.get(record.id);
    const occurrenceEdits = edits.get(record.id);
    return {
      record,
      ...(removals && { removals }),
      ...(occurrenceEdits && { occurrenceEdits }),
      ...(days.size > 0 && { answers: [...days.values()] }),
      waiting: onDevice.has(record.id) ? "device" : marks.some((w) =>
        w.state === "pending" && (record.recurrenceId || !occurrenceEdit(w.act))) ? "provider" : null,
      refusal: refused.get(record.id) ?? lastRefused?.reason ?? null,
      refusedWriteId: refused.has(record.id) ? null : lastRefused?.id ?? null,
    };
  });
}

function pendingOccurrenceEdits(
  pending: readonly CalendarEventAct[],
  local: readonly CalendarEventAct[],
  original: ReadonlyMap<string, CalendarEventRecord>,
) {
  const edits = new Map<string, OccurrenceEdit[]>();
  const add = (acts: readonly CalendarEventAct[], waiting: OccurrenceEdit["waiting"]) => {
    for (const act of acts) {
      if (!occurrenceEdit(act) || !original.get(act.eventId)?.repeat) continue;
      const edit = { at: act.scope.at, change: act.change, waiting };
      const list = edits.get(act.eventId);
      if (list) list.push(edit);
      else edits.set(act.eventId, [edit]);
    }
  };
  add(pending, "provider");
  add(local, "device");
  return edits;
}

/**
 * The session's last key per event: an act on an event this device acted on before names that act
 * (`after`), so our server writes it only onto the copy the earlier act made.
 */
export class CalendarActKeys {
  private readonly last = new Map<string, string>();

  /** The act as it is pressed: `after` set where this session acted on the event before. */
  stamp(act: CalendarEventAct, key: string): CalendarEventAct {
    if (act.kind === "calendar_event_delete" && act.hide) return act;
    const eventId = act.eventId;
    const prior = this.last.get(eventId);
    this.last.set(eventId, key);
    if (act.kind === "calendar_event_create" || prior === undefined) return act;
    // A scoped edit must still use the reviewed copies when it reaches the provider.
    if (act.kind === "calendar_event_update" && (act.scope.kind !== "record" || act.base.includes("/"))) return act;
    return { ...act, after: prior };
  }

  /** An act our server refused leaves nothing to follow: the next act on the event names none. */
  forget(eventId: string, key: string): void {
    if (this.last.get(eventId) === key) this.last.delete(eventId);
  }
}
