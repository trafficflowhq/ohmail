/**
 * THE CALENDAR'S WRITES, AS THE SERVER RECORDS THEM. A person's act on an event becomes one
 * `cal_writes` row under the key the device made for the press; nothing here reaches a provider.
 * The worker's drain carries the row out inside the account's binding, and the event's record
 * carries the row (`writes`) until the provider has taken it.
 *
 * `cal_events` stays the provider's copy: an existing event's row is never changed here. The one
 * row this file writes into it is a new event's, made as the person wants it and named by its
 * `create` row (`pending:<row id>`), until the provider's answer names it.
 *
 * A change is only ever written onto the copy it was made on. The device says which copy it held
 * (`base`, the record's `updatedAt`, and `after`, its own previous act on the event); where the
 * store's copy has moved on since, the act is recorded REFUSED (`version_stale`), so the conflict
 * reaches every device the way any write does, and nothing is sent.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { calAlarms, calAttendees, calCalendars, calConnections, calEvents, calWrites, mailboxes } from "@trafficflow/db/mail";
import { fenceErased, fencedAccountOf, recordCalendarChanges, type CalendarChange, type LedgerTx, type Tx } from "@trafficflow/db";
import {
  CALENDAR_WRITE_LIMITS, CalendarConnectionGone, asCalendarWriteFault, holdCalendarConnection, isSeriesRow, isWriteKey, parseCalendarAct,
  parseWritePayload, writePayloadOf, type CalendarWritePayload,
} from "@trafficflow/db/calendar";
import { dialect } from "@trafficflow/db/dialect";
import { formatRRule, parseRRule } from "@ohmail/cal-core/recur/rrule";
import { intlZones } from "@ohmail/cal-core/time/zones";
import type {
  CalendarEventAct, CalendarEventFields, CalendarEventRecord, CalendarTime, CalendarWriteAnswer, CalendarWriteFault,
  CalendarWriteReceipt,
} from "@ohmail/wire";
import { bridgeTx, withAccountTx, type ServiceContext } from "../context.js";
import { ServiceError } from "../errors.js";
import { derivedRange } from "./event-range.js";
import { CALENDAR_BUILDERS } from "./feed.js";
import { requireCalendarOn } from "./settings-service.js";
import { eventTimeOf, momentOrUtc } from "./time.js";

const L = CALENDAR_WRITE_LIMITS;
const ZONES = intlZones();

/**
 * What recording an act came to: its receipt, the events it touched, the changes the caller records
 * as its transaction's last statement, and the connection to wake once that transaction has
 * committed ({@link wakeCalendarConnection}; `null` where nothing waits to be sent).
 */
export interface EnqueuedCalendarWrite {
  readonly receipt: CalendarWriteReceipt;
  readonly eventIds: readonly string[];
  readonly changes: readonly CalendarChange[];
  readonly wake: string | null;
}

const invalid = (message: string): ServiceError => new ServiceError("validation_failed", 400, message);
const notFound = (): ServiceError => new ServiceError("not_found", 404, "no event or calendar of this account under that id");
const readOnly = (message: string): ServiceError => new ServiceError("calendar_read_only", 409, message);
const stopped = (): ServiceError => new ServiceError("calendar_connection_stopped", 409, "the calendar's connection waits for the person");

// ── the act, checked against the calendar's rules ───────────────────────────────

/** A mail address as an invitation may carry it: one at sign, nothing a line or a list could break on. */
const ADDRESS = /^[^\s@<>"?\u0000-\u001f\u007f]+@[^\s@<>"?\u0000-\u001f\u007f]+$/;
const ADDRESS_MAX_CHARS = 254;
const CALL_LINK = /^https:\/\/[^\s\u0000-\u001f\u007f]+$/;

function storedTime(t: CalendarTime): import("@ohmail/cal-core").StoredTime {
  return t.zone === undefined ? { kind: t.kind, value: t.value } : { kind: t.kind, value: t.value, zone: t.zone };
}

/** A time the core reads, in a zone the one zone source knows; its moment, or `null`. */
function momentOf(t: CalendarTime): number | null {
  const time = eventTimeOf(storedTime(t));
  if (time === null) return null;
  const ms = momentOrUtc(time, ZONES);
  if (!Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) return null;
  if (time.kind === "zoned" && ZONES.offsetAt(time.tzid, ms) === null) return null;
  return ms;
}

/** The fields an act names, held to the calendar's rules and written in their one spelling. */
function checkedFields<F extends Partial<CalendarEventFields>>(f: F, whole: boolean): F {
  const out: Partial<CalendarEventFields> = { ...f };
  if (f.start !== undefined || f.end !== undefined) {
    // A change of times names both: an end is never moved by a start alone.
    if (f.start === undefined || f.end === undefined) throw invalid("start and end are changed together");
    const start = momentOf(f.start);
    const end = momentOf(f.end);
    if (start === null || end === null) throw invalid("a time is no time the calendar can place");
    if ((f.start.kind === "date") !== (f.end.kind === "date")) throw invalid("a whole day ends on a day, a time at a time");
    if (end <= start) throw invalid("an event ends after it starts");
  } else if (whole) throw invalid("a new event has a start and an end");
  if (f.repeat !== undefined && f.repeat !== null) {
    const rule = parseRRule(f.repeat);
    if (rule === null) throw invalid("the repeat is no rule the calendar reads");
    out.repeat = formatRRule(rule);
  }
  if (f.callLink !== undefined && f.callLink !== null) {
    let ok = CALL_LINK.test(f.callLink);
    try {
      ok = ok && new URL(f.callLink).protocol === "https:";
    } catch {
      // No address at all: refused below as a link that is none.
      ok = false;
    }
    if (!ok) throw invalid("a call's link is an https address");
  }
  if (f.invitees !== undefined) {
    out.invitees = f.invitees.map((p) => {
      const address = p.address.trim().toLowerCase();
      if (address.length > ADDRESS_MAX_CHARS || !ADDRESS.test(address)) throw invalid("an invitee is named by a mail address");
      return { address, name: p.name === null || p.name.trim() === "" ? null : p.name.trim(), role: p.role };
    });
    if (new Set(out.invitees.map((p) => p.address)).size !== out.invitees.length) throw invalid("an invitee is named once");
  }
  return out as F;
}

/** The act as it is recorded: the door's own parser, then the calendar's rules; "this and following" waits for its own commit. */
export function checkedAct(body: unknown): CalendarEventAct {
  const act = parseCalendarAct(body);
  if (act === null) throw invalid("the act is no calendar act this server takes");
  if (Buffer.byteLength(JSON.stringify(act), "utf8") > L.payloadBytes) throw new ServiceError("payload_too_large", 413, "the act is too large");
  switch (act.kind) {
    case "calendar_event_create":
      return { ...act, event: checkedFields(act.event, true) };
    case "calendar_event_update":
      if (act.scope.kind !== "record") throw invalid("a change to one day of a series is not taken yet");
      return { ...act, change: checkedFields(act.change, false) };
    case "calendar_event_delete":
    case "calendar_event_answer":
      if (act.scope.kind !== "record") throw invalid("a removal or an answer for one day of a series is not taken yet");
      return act;
    case "calendar_event_move":
      return act;
  }
}

// ── recording ────────────────────────────────────────────────────────────────────

interface Row {
  readonly id: string;
  readonly state: string;
  readonly refusal: string | null;
  readonly payload: unknown;
}

const receiptOf = (key: string, r: Pick<Row, "id" | "state" | "refusal">): CalendarWriteReceipt => ({
  id: r.id,
  key,
  state: r.state === "applied" || r.state === "refused" ? r.state : "pending",
  reason: r.refusal === null ? null : asCalendarWriteFault(r.refusal),
});

/** The row a key already names, or `null`. The same key with another act is refused; the first row stays. */
async function recorded(tx: Tx, accountId: string, key: string, act: CalendarEventAct): Promise<CalendarWriteReceipt | null> {
  const [row] = await tx.select({ id: calWrites.id, state: calWrites.state, refusal: calWrites.refusal, payload: calWrites.payload })
    .from(calWrites).where(and(eq(calWrites.accountId, accountId), eq(calWrites.idempotencyKey, key))).limit(1);
  if (row === undefined) return null;
  const was = parseWritePayload(row.payload);
  // An applied row keeps no act: its key answers what it came to.
  if (was !== null && JSON.stringify(was.act) !== JSON.stringify(act)) {
    throw new ServiceError("idempotency_replay", 409, "this key was used for another calendar act");
  }
  return receiptOf(key, row);
}

interface HeldCalendar {
  readonly id: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly access: string;
}

/**
 * The calendar of this account, and its connection held as the fence orders it: a connection that
 * waits for the person (signed out, being removed) takes no write. Another account's id is not found.
 */
async function holdCalendar(tx: Tx, accountId: string, calendarId: string): Promise<HeldCalendar> {
  const [cal] = await tx.select({ id: calCalendars.id, connectionId: calCalendars.connectionId, access: calCalendars.access })
    .from(calCalendars).where(and(eq(calCalendars.id, calendarId), eq(calCalendars.accountId, accountId))).limit(1);
  if (cal === undefined) throw notFound();
  let status: string;
  try {
    status = (await holdCalendarConnection(tx, dialect(tx), { accountId, connectionId: cal.connectionId })).status;
  } catch (err) {
    if (err instanceof CalendarConnectionGone) throw err.reason === "removing" ? stopped() : notFound();
    throw err;
  }
  if (status !== "active" && status !== "failing") throw stopped();
  const [conn] = await tx.select({ provider: calConnections.provider }).from(calConnections)
    .where(and(eq(calConnections.id, cal.connectionId), eq(calConnections.accountId, accountId))).limit(1);
  if (conn === undefined) throw notFound();
  return { ...cal, provider: conn.provider };
}

/** A calendar a person may write: owner or writer, and not a subscription. */
function assertWritable(cal: HeldCalendar): void {
  if (cal.provider === "ics" || (cal.access !== "owner" && cal.access !== "writer")) throw readOnly("this calendar takes no writes");
}

/** The account's own addresses, as the reading takes them: its mailboxes', and the connection's principal where that is one. */
async function ownAddresses(tx: Tx, accountId: string, connectionId: string): Promise<Set<string>> {
  const rows = await tx.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.accountId, accountId));
  const out = new Set(rows.map((r) => r.address.trim().toLowerCase()).filter((a) => a.includes("@")));
  const [conn] = await tx.select({ principal: calConnections.principal }).from(calConnections)
    .where(and(eq(calConnections.id, connectionId), eq(calConnections.accountId, accountId))).limit(1);
  const p = conn?.principal?.trim().toLowerCase().replace(/^mailto:/, "") ?? "";
  if (p.includes("@") && !p.includes("/")) out.add(p);
  return out;
}

async function openCount(tx: Tx, accountId: string, eventId: string | null): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(calWrites).where(and(
    eq(calWrites.accountId, accountId), inArray(calWrites.state, ["pending", "refused"]),
    ...(eventId === null ? [] : [eq(calWrites.eventId, eventId)]),
  ));
  return Number(row?.n ?? 0);
}

async function assertRoom(tx: Tx, accountId: string, eventId: string | null): Promise<void> {
  if (await openCount(tx, accountId, null) >= L.openPerAccount
    || (eventId !== null && await openCount(tx, accountId, eventId) >= L.openPerEvent)) {
    throw new ServiceError("calendar_writes_full", 409, "too many calendar writes are waiting");
  }
}

/**
 * The provider is asked soon: the connection's next turn is pulled to now, unless it waits for a
 * word or a provider's wish. In a short transaction of its own, once the act's has committed: inside
 * it, this update would wait on the connection row that a press beside it holds for its fence,
 * while that press waits for this one's event. Called at once after that commit: the act's change
 * rang the worker's bell, whose read waits only a moment for this (`CALENDAR_RING_SETTLE_MS`).
 */
export async function wakeCalendarConnection(ctx: ServiceContext, connectionId: string): Promise<void> {
  await withAccountTx(ctx, async (tx) => {
    await bridgeTx(tx).update(calConnections).set({ nextPollAt: sql`now()` }).where(and(
      eq(calConnections.id, connectionId), eq(calConnections.accountId, ctx.accountId),
      eq(calConnections.status, "active"), sql`${calConnections.errorCode} is null`,
    ));
  });
}

/**
 * The row inserted, or the row a concurrent request under the same key inserted first. Nothing
 * else of the act has been written when this runs.
 */
async function insertRow(tx: Tx, values: typeof calWrites.$inferInsert): Promise<{ id: string } | null> {
  // The account's erasure fence, here where the row is written (the caller's transaction took it first; this holds it in sight).
  await fenceErased(tx, dialect(tx), { accountId: values.accountId });
  const [made] = await tx.insert(calWrites).values(values)
    .onConflictDoNothing({ target: [calWrites.accountId, calWrites.idempotencyKey] }).returning({ id: calWrites.id });
  return made ?? null;
}

const ms = (d: Date): number => d.getTime();

/**
 * Was the act made on the copy the store holds? `base` is the record's `updatedAt` as the device
 * held it. Where it is older, the device's own previous act on the event (`after`) may explain it:
 * applied, and closed in the transaction that stamped the event (one `now()` for both), or still
 * owed (this one then waits for it), or refused (and this one is refused with it).
 */
async function standing(
  tx: Tx, accountId: string, event: { id: string; updatedAt: Date }, act: Extract<CalendarEventAct, { base: string }>,
): Promise<{ after: string | null; refusal: CalendarWriteFault | null }> {
  if (Date.parse(act.base) === ms(event.updatedAt) && act.after === undefined) return { after: null, refusal: null };
  if (act.after !== undefined) {
    const [prev] = await tx.select({ id: calWrites.id, state: calWrites.state, updatedAt: calWrites.updatedAt }).from(calWrites)
      .where(and(eq(calWrites.accountId, accountId), eq(calWrites.idempotencyKey, act.after), eq(calWrites.eventId, event.id))).limit(1);
    if (prev !== undefined) {
      if (prev.state === "pending") return { after: prev.id, refusal: null };
      if (prev.state === "refused") return { after: prev.id, refusal: "earlier_refused" };
      if (ms(prev.updatedAt) === ms(event.updatedAt)) return { after: null, refusal: null };
    }
    if (Date.parse(act.base) === ms(event.updatedAt)) return { after: null, refusal: null };
  }
  return { after: null, refusal: "version_stale" };
}

/** A new event's row as the person wants it, named by its `create` row until the provider names it. */
async function insertWanted(
  tx: Tx, accountId: string, calendarId: string, eventId: string, writeId: string, f: CalendarEventFields,
): Promise<void> {
  const range = derivedRange({
    start: storedTime(f.start), end: storedTime(f.end), duration: null,
    rules: f.repeat === null ? [] : [f.repeat], added: [], recurrenceId: "",
  });
  if (range === null || !Number.isFinite(range.startsAt.getTime()) || (range.endsAt !== null && !Number.isFinite(range.endsAt.getTime()))) {
    throw invalid("the event's times derive no range the calendar can keep");
  }
  const name = `pending:${writeId}`;
  await fenceErased(tx, dialect(tx), { accountId });
  await tx.insert(calEvents).values({
    id: eventId, accountId, calendarId, providerId: name, versionTag: null, uid: name, recurrenceId: "",
    title: f.title, notes: f.notes, place: f.place, callLink: f.callLink,
    startKind: f.start.kind, startLocal: f.start.value, startZone: f.start.zone ?? null,
    endKind: f.end.kind, endLocal: f.end.value, endZone: f.end.zone ?? null, duration: null,
    startsAt: range.startsAt, endsAt: range.endsAt, occurrenceAt: null,
    repeatRule: f.repeat, busy: f.busy, private: f.private,
  });
  if (f.invitees.length > 0) {
    await tx.insert(calAttendees).values(f.invitees.map((p) => ({ accountId, eventId, address: p.address, name: p.name, role: p.role, answer: "none" })));
  }
  if (f.alarms.length > 0) {
    await tx.insert(calAlarms).values(f.alarms.map((m) => ({ accountId, eventId, calendarId: null, minutesBefore: m, method: "notice" })));
  }
}

const PARENT_GONE = "23503";
const TAKEN = "23505";
function storeCode(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e !== null && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
  }
  return null;
}

/**
 * Record one act under one key, inside the caller's transaction, which holds the account's fence:
 * the account is the one that transaction is fenced for, never a field of the input. The key made
 * twice is one row. The caller records `changes` last, so a write of its own (a link to a letter)
 * can stand beside the row in the same transaction.
 */
export async function enqueueCalendarWrite(
  db: LedgerTx, input: { readonly key: string; readonly act: CalendarEventAct },
): Promise<EnqueuedCalendarWrite> {
  const accountId = fencedAccountOf(db);
  if (accountId === undefined) throw new Error("a calendar write is recorded inside its account's fenced transaction");
  if (!isWriteKey(input.key)) throw new ServiceError("idempotency_key_required", 400, "a calendar write carries a key of its own");
  const act = checkedAct(input.act);
  const tx = bridgeTx(db);
  const known = await recorded(tx, accountId, input.key, act);
  if (known !== null) return { receipt: known, eventIds: [], changes: [], wake: null };
  try {
    return act.kind === "calendar_event_create"
      ? await recordCreate(tx, accountId, input.key, act)
      : await recordOnEvent(tx, accountId, input.key, act);
  } catch (err) {
    const code = storeCode(err);
    if (code === PARENT_GONE) throw notFound();
    if (code === TAKEN) throw invalid("the new event's id is taken");
    throw err;
  }
}

async function recordCreate(
  tx: Tx, accountId: string, key: string, act: Extract<CalendarEventAct, { kind: "calendar_event_create" }>,
): Promise<EnqueuedCalendarWrite> {
  const cal = await holdCalendar(tx, accountId, act.calendarId);
  assertWritable(cal);
  await assertRoom(tx, accountId, null);
  const made = await insertRow(tx, {
    accountId, calendarId: cal.id, eventId: act.eventId, op: "create", payload: writePayloadOf(act, null, null),
    baseVersionTag: null, idempotencyKey: key, state: "pending",
  });
  if (made === null) return { receipt: (await recorded(tx, accountId, key, act))!, eventIds: [], changes: [], wake: null };
  await insertWanted(tx, accountId, cal.id, act.eventId, made.id, act.event);
  return {
    receipt: { id: made.id, key, state: "pending", reason: null },
    eventIds: [act.eventId],
    changes: [{ kind: "calendar_event", id: act.eventId, op: "create" }],
    wake: cal.connectionId,
  };
}

const OP: Record<Exclude<CalendarEventAct["kind"], "calendar_event_create">, "update" | "delete" | "move" | "answer"> = {
  calendar_event_update: "update", calendar_event_delete: "delete", calendar_event_move: "move", calendar_event_answer: "answer",
};

async function recordOnEvent(
  tx: Tx, accountId: string, key: string, act: Exclude<CalendarEventAct, { kind: "calendar_event_create" }>,
): Promise<EnqueuedCalendarWrite> {
  const [seen] = await tx.select({ calendarId: calEvents.calendarId }).from(calEvents)
    .where(and(eq(calEvents.id, act.eventId), eq(calEvents.accountId, accountId))).limit(1);
  if (seen === undefined) throw notFound();
  const cal = await holdCalendar(tx, accountId, seen.calendarId);
  assertWritable(cal);
  const [event] = await dialect(tx).forUpdate(tx.select({
    id: calEvents.id, versionTag: calEvents.versionTag, updatedAt: calEvents.updatedAt,
    organizer: calEvents.organizer, myAnswer: calEvents.myAnswer, providerId: calEvents.providerId,
    repeatRule: calEvents.repeatRule, recurrenceId: calEvents.recurrenceId, addedDates: calEvents.addedDates,
  }).from(calEvents).where(and(
    eq(calEvents.id, act.eventId), eq(calEvents.accountId, accountId), eq(calEvents.calendarId, cal.id),
  )).limit(1), { mode: "update" });
  if (event === undefined) throw notFound();

  // An invitation: the account answers it, and changes nothing else of someone else's event.
  const invited = event.myAnswer !== null
    && (event.organizer === null || !(await ownAddresses(tx, accountId, cal.connectionId)).has(event.organizer.toLowerCase()));
  if (act.kind === "calendar_event_answer" ? !invited : invited) {
    throw readOnly(act.kind === "calendar_event_answer" ? "the account is not invited to this event" : "this event is someone else's invitation");
  }
  // A series, or one day of one, waits for series to be written, whatever the act and its scope.
  if (isSeriesRow(event)) throw invalid("a repeating event, or one day of it, is not written yet");
  if (act.kind === "calendar_event_move") {
    if (cal.provider !== "google") throw invalid("a move between calendars of this provider is not taken yet");
    const to = await holdCalendar(tx, accountId, act.toCalendarId);
    if (to.connectionId !== cal.connectionId || to.id === cal.id) throw invalid("an event moves to another calendar of the same connection");
    assertWritable(to);
  }
  await assertRoom(tx, accountId, event.id);
  const { after, refusal } = await standing(tx, accountId, event, act);
  const payload: CalendarWritePayload = writePayloadOf(act, after, null);
  const made = await insertRow(tx, {
    accountId, calendarId: cal.id, eventId: event.id, op: OP[act.kind], payload, baseVersionTag: event.versionTag,
    idempotencyKey: key, state: refusal === null ? "pending" : "refused", refusal,
  });
  if (made === null) return { receipt: (await recorded(tx, accountId, key, act))!, eventIds: [], changes: [], wake: null };
  return {
    receipt: { id: made.id, key, state: refusal === null ? "pending" : "refused", reason: refusal },
    eventIds: [event.id],
    changes: [{ kind: "calendar_event", id: event.id, op: "update" }],
    wake: refusal === null ? cal.connectionId : null,
  };
}

// ── the routes' doors ────────────────────────────────────────────────────────────

async function echo(ctx: ServiceContext, write: CalendarWriteReceipt | null, eventIds: readonly string[]): Promise<CalendarWriteAnswer> {
  const built = await CALENDAR_BUILDERS.calendar_event(ctx.db, ctx.accountId, eventIds);
  const events: CalendarEventRecord[] = eventIds.flatMap((id) => built.get(id) ?? []);
  return { write, events };
}

/**
 * `POST /calendar/writes`: the act recorded under the press's key, answered with where it stands
 * and the records of the events it touched (the device's read-your-writes echo). `seq` is the
 * change recorded, `null` for a key already recorded.
 */
export async function recordCalendarWrite(
  ctx: ServiceContext, key: string, body: unknown,
): Promise<{ answer: CalendarWriteAnswer; seq: bigint | null }> {
  const act = checkedAct(body);
  await requireCalendarOn(ctx);
  const done = await withAccountTx(ctx, async (tx) => {
    const q = await enqueueCalendarWrite(tx, { key, act });
    const seqs = q.changes.length > 0 ? await recordCalendarChanges(tx, ctx.accountId, q.changes) : [];
    return { q, seq: seqs.at(-1) ?? null };
  });
  if (done.q.wake !== null) await wakeCalendarConnection(ctx, done.q.wake);
  const ids = done.q.eventIds.length > 0 ? done.q.eventIds : await eventsOfWrite(ctx, done.q.receipt.id);
  return { answer: await echo(ctx, done.q.receipt, ids), seq: done.seq };
}

async function eventsOfWrite(ctx: ServiceContext, writeId: string): Promise<string[]> {
  const [row] = await ctx.db.select({ eventId: calWrites.eventId }).from(calWrites)
    .where(and(eq(calWrites.id, writeId), eq(calWrites.accountId, ctx.accountId))).limit(1);
  return row?.eventId == null ? [] : [row.eventId];
}

interface WriteRowHeld {
  readonly id: string;
  readonly key: string;
  readonly eventId: string | null;
  readonly calendarId: string;
  readonly op: string;
  readonly state: string;
  readonly refusal: string | null;
  readonly attempts: number;
  readonly payload: unknown;
}

/** A write of this account under lock, its calendar's connection held first; another account's id is not found. */
async function heldWrite(tx: Tx, accountId: string, writeId: string): Promise<WriteRowHeld> {
  const [seen] = await tx.select({ calendarId: calWrites.calendarId }).from(calWrites)
    .where(and(eq(calWrites.id, writeId), eq(calWrites.accountId, accountId))).limit(1);
  if (seen === undefined) throw notFound();
  await holdCalendar(tx, accountId, seen.calendarId);
  const [row] = await dialect(tx).forUpdate(tx.select({
    id: calWrites.id, key: calWrites.idempotencyKey, eventId: calWrites.eventId, calendarId: calWrites.calendarId, op: calWrites.op,
    state: calWrites.state, refusal: calWrites.refusal, attempts: calWrites.attempts, payload: calWrites.payload,
  }).from(calWrites).where(and(eq(calWrites.id, writeId), eq(calWrites.accountId, accountId))).limit(1), { mode: "update" });
  if (row === undefined) throw notFound();
  return row;
}

/**
 * Was this refused write refused for the copy it was made on (`version_stale`), itself or through
 * the write it waited for? Such a change is never sent again: its row's version is the one it was
 * refused against, or (refused at the door) one the device never held.
 */
async function refusedForItsCopy(tx: Tx, accountId: string, row: Pick<WriteRowHeld, "refusal" | "payload">): Promise<boolean> {
  let at = row;
  for (let hops = 0; hops <= L.openPerEvent; hops++) {
    if (at.refusal === "version_stale") return true;
    const after = at.refusal === "earlier_refused" ? parseWritePayload(at.payload)?.after ?? null : null;
    if (after === null) return false;
    const [prev] = await tx.select({ refusal: calWrites.refusal, payload: calWrites.payload }).from(calWrites)
      .where(and(eq(calWrites.id, after), eq(calWrites.accountId, accountId))).limit(1);
    if (prev === undefined) return false;
    at = prev;
  }
  return false;
}

/** The open writes that wait for `head`, directly or through another: they were made on what it would write. */
async function followersOf(tx: Tx, accountId: string, head: WriteRowHeld): Promise<string[]> {
  if (head.eventId === null) return [];
  const open = await tx.select({ id: calWrites.id, payload: calWrites.payload }).from(calWrites).where(and(
    eq(calWrites.accountId, accountId), eq(calWrites.eventId, head.eventId), inArray(calWrites.state, ["pending", "refused"]),
  ));
  const chain = new Set([head.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of open) {
      const after = parseWritePayload(r.payload)?.after ?? null;
      if (after !== null && chain.has(after) && !chain.has(r.id)) {
        chain.add(r.id);
        grew = true;
      }
    }
  }
  chain.delete(head.id);
  return [...chain];
}

/**
 * `POST /calendar/writes/:id/retry`: a refused write is owed again, with the writes that were
 * refused only because they waited for it. A write still owed answers as it stands. A change
 * refused for the copy it was made on is not retried ("keep mine" is a new act, made on the copy
 * the store holds now), and neither is a write that waited for one. A write refused only because
 * the one it waited for was is not retried alone while that one stays refused: its version is the
 * one the store held when it was recorded, which its device may never have held. It goes again
 * with that one's retry.
 */
export async function retryCalendarWrite(ctx: ServiceContext, writeId: string): Promise<{ answer: CalendarWriteAnswer; seq: bigint | null }> {
  await requireCalendarOn(ctx);
  const done = await withAccountTx(ctx, async (tx) => {
    const t = bridgeTx(tx);
    const row = await heldWrite(t, ctx.accountId, writeId);
    if (row.state === "applied") throw new ServiceError("calendar_write_left", 409, "the write is done");
    if (row.state !== "refused") return { receipt: receiptOf(row.key, row), eventId: row.eventId, seq: null, wake: null };
    if (await refusedForItsCopy(t, ctx.accountId, row)) {
      throw new ServiceError("calendar_write_left", 409, "a change made on an older copy is made again as a new act");
    }
    const waitedFor = row.refusal === "earlier_refused" ? parseWritePayload(row.payload)?.after ?? null : null;
    if (waitedFor !== null) {
      const [head] = await t.select({ state: calWrites.state }).from(calWrites)
        .where(and(eq(calWrites.id, waitedFor), eq(calWrites.accountId, ctx.accountId))).limit(1);
      if (head?.state === "refused") throw new ServiceError("calendar_write_left", 409, "a write that waited for a refused one goes again with it");
    }
    const followers = await followersOf(t, ctx.accountId, row);
    const again = { state: "pending", refusal: null, attempts: 0, nextAttemptAt: null, updatedAt: sql`now()` } as const;
    await t.update(calWrites).set(again).where(and(eq(calWrites.id, row.id), eq(calWrites.accountId, ctx.accountId)));
    if (followers.length > 0) {
      await t.update(calWrites).set(again).where(and(
        eq(calWrites.accountId, ctx.accountId), inArray(calWrites.id, followers), eq(calWrites.refusal, "earlier_refused"),
      ));
    }
    const [cal] = await t.select({ connectionId: calCalendars.connectionId }).from(calCalendars)
      .where(and(eq(calCalendars.id, row.calendarId), eq(calCalendars.accountId, ctx.accountId))).limit(1);
    const seqs = row.eventId === null ? [] : await recordCalendarChanges(tx, ctx.accountId, [{ kind: "calendar_event", id: row.eventId, op: "update" }]);
    return {
      receipt: { id: row.id, key: row.key, state: "pending" as const, reason: null }, eventId: row.eventId, seq: seqs.at(-1) ?? null,
      wake: cal?.connectionId ?? null,
    };
  });
  if (done.wake !== null) await wakeCalendarConnection(ctx, done.wake);
  return { answer: await echo(ctx, done.receipt, done.eventId === null ? [] : [done.eventId]), seq: done.seq };
}

/**
 * `DELETE /calendar/writes/:id`: a refused write, or one not tried yet, let go with the writes that
 * wait for it. A new event's write takes the event with it. A write under way or done is not let go.
 */
export async function dismissCalendarWrite(ctx: ServiceContext, writeId: string): Promise<{ answer: CalendarWriteAnswer; seq: bigint | null }> {
  await requireCalendarOn(ctx);
  const done = await withAccountTx(ctx, async (tx) => {
    const t = bridgeTx(tx);
    const row = await heldWrite(t, ctx.accountId, writeId);
    if (!(row.state === "refused" || (row.state === "pending" && row.attempts === 0))) {
      throw new ServiceError("calendar_write_left", 409, "the write is under way or done");
    }
    const going = [row.id, ...await followersOf(t, ctx.accountId, row)];
    const changes: CalendarChange[] = [];
    let gone = false;
    if (row.op === "create" && row.eventId !== null) {
      const [event] = await t.select({ providerId: calEvents.providerId }).from(calEvents)
        .where(and(eq(calEvents.id, row.eventId), eq(calEvents.accountId, ctx.accountId))).limit(1);
      if (event !== undefined && event.providerId === `pending:${row.id}`) {
        // Never at the provider: every write of the event goes with it.
        await t.delete(calWrites).where(and(eq(calWrites.accountId, ctx.accountId), eq(calWrites.eventId, row.eventId), inArray(calWrites.state, ["pending", "refused"])));
        await t.delete(calAttendees).where(and(eq(calAttendees.accountId, ctx.accountId), eq(calAttendees.eventId, row.eventId)));
        await t.delete(calAlarms).where(and(eq(calAlarms.accountId, ctx.accountId), eq(calAlarms.eventId, row.eventId)));
        await t.delete(calEvents).where(and(eq(calEvents.id, row.eventId), eq(calEvents.accountId, ctx.accountId)));
        changes.push({ kind: "calendar_event", id: row.eventId, op: "delete" });
        gone = true;
      }
    }
    if (!gone) {
      await t.delete(calWrites).where(and(eq(calWrites.accountId, ctx.accountId), inArray(calWrites.id, going)));
      if (row.eventId !== null) changes.push({ kind: "calendar_event", id: row.eventId, op: "update" });
    }
    const seqs = changes.length > 0 ? await recordCalendarChanges(tx, ctx.accountId, changes) : [];
    return { eventId: gone ? null : row.eventId, seq: seqs.at(-1) ?? null };
  });
  return { answer: await echo(ctx, null, done.eventId === null ? [] : [done.eventId]), seq: done.seq };
}
