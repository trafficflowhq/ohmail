import { changedSeriesAudience, type CalendarTransfer, type SeriesCancellation } from "@trafficflow/db/calendar";
import { deleteAudienceOf, sameDeleteAudience } from "@ohmail/cal-core";
import { cloudDeleteMembers } from "@ohmail/cal-providers/series";
import { repeatDeleteScopes } from "@ohmail/cal-providers/repeat-shapes";
/**
 * THE CALENDAR'S WRITES, AS THE SERVER RECORDS THEM. A person's act on an event becomes one
 * `cal_writes` row under the key the device made for the press; nothing here reaches a provider.
 * The worker's drain carries the row out inside the account's binding, and the event's record
 * carries the row (`writes`) until the provider has taken it.
 *
 * Existing rows keep the provider’s copy. Local removal only updates that account’s visibility.
 * New events wait in the store under the create row’s id until the provider names them.
 *
 * A change is only ever written onto the copy it was made on. The device says which copy it held
 * (`base`, the record's `updatedAt`, and `after`, its own previous act on the event); where the
 * store's copy has moved on since, the act is recorded REFUSED (`version_stale`), so the conflict
 * reaches every device the way any write does, and nothing is sent.
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { calAlarms, calAttendees, calCalendars, calConnections, calEvents, calWrites, changeLog, messageInvitations, messages } from "@trafficflow/db/mail";
import { fenceErased, fencedAccountOf, recordCalendarChanges, invitationCalendarId, invitationStanding, readOwnAddresses, sameAddress, storedAuthScreens, type CalendarChange, type LedgerTx, type Tx } from "@trafficflow/db";
import {
  CALENDAR_WRITE_LIMITS, CONTINUED_FIELDS, CalendarConnectionGone, asCalendarWriteFault, changedDaysOf, exceptionBaseOf, holdCalendarConnection, isWriteKey, ownOrganizerAddresses,
  calendarOriginalOf, parseCalendarAct, parseWritePayload, isAttendeeCopy, sharedCopyNeedsProtection, verifiedOrganizer, writeActRefusal, writePayloadOf, writeRowOf, type CalendarWriteException, type CalendarWritePayload, type ContinuedField,
} from "@trafficflow/db/calendar";
import { dialect } from "@trafficflow/db/dialect";
import { formatRRule, parseRRule } from "@ohmail/cal-core/recur/rrule";
import { intlZones } from "@ohmail/cal-core/time/zones";
import { draftRepeatSupported, PROVEN_REPEATS, proofPlaceOf, seriesEditShape, seriesProven, type ProofPlace, type ProvenRepeats } from "@ohmail/cal-providers/repeat-shapes";
import { carriedExclusions, clockOf, continuedSeries, endedRule, isDayOf, movedRule, offItsClock, personalSeriesOf, confirmedDeleteAudience, storedObjectFacts } from "@ohmail/cal-providers/series";
import type {
  CalendarEventAct, CalendarEventFields, CalendarEventRecord, CalendarTime, CalendarWriteAnswer, CalendarWriteFault,
  CalendarWriteReceipt, InvitationAnswer,
} from "@ohmail/wire";
import { bridgeTx, withAccountTx, type ServiceContext } from "../context.js";
import { ServiceError } from "../errors.js";
import { derivedRange, storedOccurrence } from "./event-range.js";
import { CALENDAR_BUILDERS, hideIdentityOf } from "./feed.js";
import { requireCalendarOn } from "./settings-service.js";
import { eventTimeOf, momentOrUtc, storedTimeOf } from "./time.js";
import { pullConnectionDue } from "./wake.js";

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

/** The act as it is recorded: the door's own parser, then the calendar's rules. What a series takes is `writeActRefusal`'s, asked once the row is read. */
export function checkedAct(body: unknown): CalendarEventAct {
  const act = parseCalendarAct(body);
  if (act === null) throw invalid("the act is no calendar act this server takes");
  if (Buffer.byteLength(JSON.stringify(act), "utf8") > L.payloadBytes) throw new ServiceError("payload_too_large", 413, "the act is too large");
  switch (act.kind) {
    case "calendar_event_create":
      return { ...act, event: checkedFields(act.event, true) };
    case "calendar_event_update":
      return { ...act, change: checkedFields(act.change, false) };
    case "calendar_event_delete":
    case "calendar_event_answer":
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
  readonly nativeMove: boolean;
  readonly mailboxId: string | null;
  /** The connection's stored address (CalDAV): where its series are proven. */
  readonly serverUrl: string | null;
  /** Whom the connection signs in as: one of the account's own addresses where it is an address. */
  readonly principal: string | null;
  readonly organizerAddresses: readonly string[] | null;
}

/**
 * The calendar of this account, and its connection held as the fence orders it: a connection that
 * waits for the person (signed out, being removed) takes no write. Another account's id is not found.
 */
async function holdCalendar(tx: Tx, accountId: string, calendarId: string): Promise<HeldCalendar> {
  const [cal] = await tx.select({ id: calCalendars.id, connectionId: calCalendars.connectionId, access: calCalendars.access, nativeMove: calCalendars.nativeMove })
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
  const [conn] = await tx.select({ provider: calConnections.provider, serverUrl: calConnections.serverUrl, principal: calConnections.principal, organizerAddresses: calConnections.organizerAddresses, mailboxId: calConnections.mailboxId })
    .from(calConnections).where(and(eq(calConnections.id, cal.connectionId), eq(calConnections.accountId, accountId))).limit(1);
  if (conn === undefined) throw notFound();
  return { ...cal, provider: conn.provider, serverUrl: conn.serverUrl, principal: conn.principal, organizerAddresses: conn.organizerAddresses, mailboxId: conn.mailboxId };
}

/** A calendar a person may write: owner or writer, and not a subscription. */
function assertWritable(cal: HeldCalendar): void {
  if (cal.provider === "ics" || (cal.access !== "owner" && cal.access !== "writer")) throw readOnly("this calendar takes no writes");
}

/** What the door holds a series against, as the drain does: the repeats proven where the calendar's connection is, and today. */
interface DoorShapes {
  readonly place: ProofPlace | null;
  readonly now: number;
  readonly proven: ProvenRepeats;
}

const shapesOf = (cal: HeldCalendar, o: { readonly now: number; readonly proven: ProvenRepeats }): DoorShapes =>
  ({ place: proofPlaceOf(cal.provider as "google" | "caldav" | "microsoft" | "ics", cal.serverUrl), now: o.now, proven: o.proven });

/** A series that is no shape proven where the calendar's connection is: refused here as the drain refuses it (`repeat_unsupported`). */
function assertProven(d: DoorShapes, rule: import("@ohmail/cal-core").RRule | null, start: import("@ohmail/cal-core").EventTime | null, mode: boolean | "draft" = false): void {
  if (rule === null) return;
  if (start === null || !(mode === "draft"
    ? draftRepeatSupported(d.place, rule, start, ZONES, d.now)
    : mode ? seriesEditShape(d.place, rule, start, ZONES, d.now)
    : seriesProven(d.place, rule, start, ZONES, d.now, d.proven))) {
    throw new ServiceError("validation_failed", 400, "this calendar cannot keep this repeat rule", { reason: "repeat_unsupported" });
  }
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
    await pullConnectionDue(bridgeTx(tx), { accountId: ctx.accountId, connectionId }, null);
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
  exact = false,
): Promise<{ after: string | null; refusal: CalendarWriteFault | null }> {
  if (exact) return { after: null, refusal: Date.parse(act.base) === ms(event.updatedAt) ? null : "version_stale" };
  if (act.kind === "calendar_event_update" && act.personalSeries && Date.parse(act.base) !== ms(event.updatedAt)) return { after: null, refusal: "version_stale" };
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
  mailAnswer: InvitationAnswer | null = null,
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
    repeatRule: f.repeat, busy: f.busy, private: f.private, mailAnswer,
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
  o: {
    /** Now, in epoch milliseconds: a series is held against the clock times its zone skips from today on. */
    readonly now?: number;
    /** The repeats proven at each place (the providers' own table where not said), as the drain takes them. */
    readonly proven?: ProvenRepeats;
  } = {},
): Promise<EnqueuedCalendarWrite> {
  const shapes = { now: o.now ?? Date.now(), proven: o.proven ?? PROVEN_REPEATS };
  const accountId = fencedAccountOf(db);
  if (accountId === undefined) throw new Error("a calendar write is recorded inside its account's fenced transaction");
  if (!isWriteKey(input.key)) throw new ServiceError("idempotency_key_required", 400, "a calendar write carries a key of its own");
  const act = checkedAct(input.act);
  const tx = bridgeTx(db);
  const known = await recorded(tx, accountId, input.key, act);
  if (known !== null) return { receipt: known, eventIds: [], changes: [], wake: null };
  try {
    return act.kind === "calendar_event_create"
      ? await recordCreate(tx, accountId, input.key, act, shapes)
      : await recordOnEvent(tx, accountId, input.key, act, shapes);
  } catch (err) {
    const code = storeCode(err);
    if (code === PARENT_GONE) throw notFound();
    if (code === TAKEN) throw invalid("the new event's id is taken");
    throw err;
  }
}

async function recordCreate(
  tx: Tx, accountId: string, key: string, act: Extract<CalendarEventAct, { kind: "calendar_event_create" }>,
  o: { readonly now: number; readonly proven: ProvenRepeats },
): Promise<EnqueuedCalendarWrite> {
  const cal = await holdCalendar(tx, accountId, act.calendarId);
  assertWritable(cal);
  const mailAnswer = act.invitationMessageId
    ? await reviewedInvitationCopy(tx, accountId, act.invitationMessageId, act)
    : null;
  if (act.invitationMessageId && mailAnswer === null)
    throw readOnly("the invitation is no longer available to add");
  // A new series in a shape proven where the calendar is, from a start its rule names: the drain sends no other.
  assertProven(shapesOf(cal, o), act.event.repeat === null ? null : parseRRule(act.event.repeat), eventTimeOf(storedTime(act.event.start)), act.repeatSelected ? "draft" : false);
  await assertRoom(tx, accountId, null);
  const made = await insertRow(tx, {
    accountId, calendarId: cal.id, eventId: act.eventId, op: "create", payload: writePayloadOf(act, null, null),
    baseVersionTag: null, idempotencyKey: key, state: "pending",
  });
  if (made === null) return { receipt: (await recorded(tx, accountId, key, act))!, eventIds: [], changes: [], wake: null };
  await insertWanted(tx, accountId, cal.id, act.eventId, made.id, act.event, mailAnswer);
  return {
    receipt: { id: made.id, key, state: "pending", reason: null },
    eventIds: [act.eventId],
    changes: [{ kind: "calendar_event", id: act.eventId, op: "create" }],
    wake: cal.connectionId,
  };
}

/** The changed days a series' row has beside it in its calendar: the rows of its UID that each replace one of its days. */
async function changedRows(tx: Tx, accountId: string, calendarId: string, uid: string): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(calEvents).where(and(
    eq(calEvents.accountId, accountId), eq(calEvents.calendarId, calendarId), eq(calEvents.uid, uid), sql`${calEvents.recurrenceId} <> ''`,
  ));
  return Number(row?.n ?? 0);
}

const OP: Record<Exclude<CalendarEventAct["kind"], "calendar_event_create">, "update" | "delete" | "move" | "answer"> = {
  calendar_event_update: "update", calendar_event_delete: "delete", calendar_event_move: "move", calendar_event_answer: "answer",
};

async function holdEventCopy(tx: Tx, accountId: string, calendarId: string, match: ReturnType<typeof and>) {
  const [held, second] = await dialect(tx).forUpdate(tx.select({
    id: calEvents.id, versionTag: calEvents.versionTag, updatedAt: calEvents.updatedAt,
    organizer: calEvents.organizer, myAnswer: calEvents.myAnswer, status: calEvents.status, thisAndFuture: calEvents.thisAndFuture, providerId: calEvents.providerId, uid: calEvents.uid, sequence: calEvents.sequence,
    repeatRule: calEvents.repeatRule, recurrenceId: calEvents.recurrenceId, addedDates: calEvents.addedDates, excludedDates: calEvents.excludedDates,
    startKind: calEvents.startKind, startLocal: calEvents.startLocal, startZone: calEvents.startZone, startsAt: calEvents.startsAt,
    endKind: calEvents.endKind, endLocal: calEvents.endLocal, endZone: calEvents.endZone,
    title: calEvents.title, notes: calEvents.notes, place: calEvents.place, callLink: calEvents.callLink, busy: calEvents.busy, private: calEvents.private,
    original: calendarOriginalOf(), portableCopy: calEvents.portableCopy, partial: calEvents.partial, duration: calEvents.duration,
    removedOccurrences: calEvents.removedOccurrences, heldBack: calEvents.heldBack,
  }).from(calEvents).where(and(
    eq(calEvents.accountId, accountId), eq(calEvents.calendarId, calendarId), match,
  )).limit(2), { mode: "update" });
  if (!held || second) return null;
  return { ...held, ...storedObjectFacts(held.original, held.organizer) };
}

async function calendarLetter(tx: Tx, accountId: string, id: string, hold = false) {
  const query = tx.select({ invitation: messageInvitations, sender: messages.fromAddress, auth: messages.authVerdict })
    .from(messageInvitations).innerJoin(messages, and(
      eq(messages.id, messageInvitations.messageId), eq(messages.accountId, accountId)))
    .where(and(eq(messageInvitations.accountId, accountId), eq(messages.id, id), isNull(messages.deletedAt))).limit(1);
  const [letter] = await (hold ? dialect(tx).forUpdate(query, { of: messageInvitations }) : query);
  return letter;
}

async function reviewedInvitationCopy(
  tx: Tx, accountId: string, messageId: string,
  act: Extract<CalendarEventAct, { kind: "calendar_event_create" }>,
): Promise<InvitationAnswer | null> {
  const letter = await calendarLetter(tx, accountId, messageId, true);
  const invitation = letter?.invitation;
  if (!invitation || storedAuthScreens(letter.auth) || invitation.method !== "REQUEST" || !invitation.organizer || !invitation.invitedAddress ||
    invitationCalendarId(invitation) !== act.eventId) return null;
  const answer = invitation.answer;
  if (answer !== "accepted" && answer !== "tentative" && (answer !== "declined" || act.event.busy)) return null;
  const start = eventTimeOf(storedTime(act.event.start));
  if (start === null || (invitation.startsAt && start.kind !== "date" ?
    momentOrUtc(start, ZONES) !== invitation.startsAt.getTime() : invitation.startRaw !== act.event.start.value)) return null;
  const standing = await invitationStanding(tx, invitation);
  if (standing.cancelled || standing.replacedBy) return null;
  const [already] = await tx.select({ id: calEvents.id }).from(calEvents)
    .innerJoin(calCalendars, and(eq(calCalendars.id, calEvents.calendarId), eq(calCalendars.accountId, accountId)))
    .innerJoin(calConnections, and(eq(calConnections.id, calCalendars.connectionId), eq(calConnections.accountId, accountId)))
    .where(and(eq(calEvents.accountId, accountId), eq(calEvents.uid, invitation.uid),
      eq(calEvents.recurrenceId, invitation.recurrenceId),
      sql`lower(${calEvents.organizer}) = ${invitation.organizer.toLowerCase()} and ${calEvents.myAnswer} is not null`,
      or(eq(calConnections.mailboxId, invitation.mailboxId), and(isNull(calConnections.mailboxId),
        sql`exists (select 1 from ${calAttendees} where ${calAttendees.accountId} = ${accountId}
          and ${calAttendees.eventId} = ${calEvents.id} and lower(${calAttendees.address}) = ${invitation.invitedAddress.toLowerCase()})`)),
    )).limit(1);
  return already === undefined ? answer : null;
}

async function cancelledByLetter(
  tx: Tx, accountId: string, id: string,
  event: NonNullable<Awaited<ReturnType<typeof holdEventCopy>>>,
  at: string, mailboxId: string | null,
) {
  const letter = await calendarLetter(tx, accountId, id);
  const cancellation = letter?.invitation;
  if (!cancellation || storedAuthScreens(letter.auth) || cancellation.method !== "CANCEL" || !cancellation.invitedAddress ||
    !sameAddress(cancellation.organizer, letter?.sender)) return false;
  if (cancellation.recurrenceId !== at) return false;
  const standing = await invitationStanding(tx, cancellation);
  if (!standing.cancelled || standing.replacedBy !== null) return false;
  if (invitationCalendarId(cancellation) === event.id) return true;
  if (event.myAnswer === null || event.uid !== cancellation.uid || event.sequence > cancellation.sequence ||
    !sameAddress(event.organizer, cancellation.organizer)) return false;
  if (mailboxId !== null) return mailboxId === cancellation.mailboxId;
  const [invitee] = await tx.select({ address: calAttendees.address }).from(calAttendees).where(and(
    eq(calAttendees.accountId, accountId), eq(calAttendees.eventId, event.id),
    sql`lower(${calAttendees.address}) = ${cancellation.invitedAddress.toLowerCase()}`,
  )).limit(1);
  return invitee !== undefined;
}

async function attendeeIdentityOf(
  tx: Tx, accountId: string, cal: HeldCalendar,
  event: NonNullable<Awaited<ReturnType<typeof holdEventCopy>>>, own: ReadonlySet<string>,
) {
  const guests = await tx.select({ address: calAttendees.address, role: calAttendees.role, answer: calAttendees.answer })
    .from(calAttendees).where(and(eq(calAttendees.accountId, accountId), eq(calAttendees.eventId, event.id)));
  const identity = hideIdentityOf({ ...event, access: cal.access, provider: cal.provider, organizerAddresses: cal.organizerAddresses }, cal.principal, own, guests);
  return identity && { ...identity, answer: guests.find(({ address }) => sameAddress(address, identity.attendee))?.answer };
}

async function recordLocalRemoval(
  tx: Tx, accountId: string, cal: HeldCalendar, key: string,
  act: Extract<CalendarEventAct, { kind: "calendar_event_delete" }>,
  event: NonNullable<Awaited<ReturnType<typeof holdEventCopy>>>,
): Promise<EnqueuedCalendarWrite> {
  const at = act.scope.kind === "record" ? "" : act.scope.at;
  let stale = Date.parse(act.base) !== ms(event.updatedAt);
  let target = event;
  let prior = event.removedOccurrences ?? [];
  let marks = prior;
  if (act.hide) {
    const own = await readOwnAddresses(tx, accountId);
    const identity = await attendeeIdentityOf(tx, accountId, cal, event, own);
    if (!identity || act.copy?.calendarId !== cal.id || act.copy.attendee !== identity.attendee || event.status === "cancelled" || identity.answer === "declined" || event.thisAndFuture)
      throw readOnly("only an active own invitation can be hidden");
    const paired = exceptionBaseOf(act.base);
    if (event.recurrenceId) {
      if (!paired || at !== event.recurrenceId) throw invalid("this occurrence needs its reviewed series and day");
      const master = await holdEventCopy(tx, accountId, cal.id,
        and(eq(calEvents.uid, event.uid), eq(calEvents.recurrenceId, "")));
      const masterIdentity = master && await attendeeIdentityOf(tx, accountId, cal, master, own);
      if (!master || writeRowOf(master) !== "series" || master.status === "cancelled" ||
          !masterIdentity || masterIdentity.attendee !== identity.attendee || masterIdentity.organizer !== identity.organizer)
        throw readOnly("this occurrence belongs to another invitation");
      await refuseWhileMoving(tx, accountId, master.id);
      stale = Date.parse(paired[0]) !== ms(event.updatedAt) || Date.parse(paired[1]) !== ms(master.updatedAt);
      target = master;
      prior = master.removedOccurrences ?? [];
      marks = prior;
      if (!stale && !storedOccurrence({ ...master, excludedDates: [] }, at))
        throw invalid("the series has no such day");
    } else {
      if (paired) throw invalid("only a changed occurrence names two reviewed copies");
      if (!stale && at) {
        if (!storedOccurrence(event, at)) throw invalid("the series has no such day");
        const [changed] = await tx.select({ id: calEvents.id }).from(calEvents)
          .where(and(eq(calEvents.accountId, accountId), eq(calEvents.calendarId, cal.id),
            eq(calEvents.uid, event.uid), eq(calEvents.recurrenceId, at))).limit(1);
        if (changed) throw invalid("this occurrence has its own copy to review");
      }
    }
    const tag = { attendee: identity.attendee, organizer: identity.organizer, uid: event.uid, calendarId: cal.id };
    const sameCopy = (mark: (typeof prior)[number]) => typeof mark === "object" && mark !== null &&
      mark.attendee === tag.attendee && mark.organizer === tag.organizer &&
      mark.uid === tag.uid && mark.calendarId === tag.calendarId;
    if (!stale && !prior.some((mark) => typeof mark !== "string" && sameCopy(mark) && (mark.hide === "" || mark.hide === at)))
      marks = [...prior.filter((mark) => at !== "" || !sameCopy(mark)), { hide: at, ...tag }];

  } else {
    if (cal.access === "busy" || event.heldBack || (event.status !== "cancelled" && event.myAnswer !== "declined" &&
      (!act.cancelledBy || !await cancelledByLetter(tx, accountId, act.cancelledBy, event, at, cal.mailboxId))))
      throw readOnly("only a cancelled or declined event can be removed from this account’s calendar");
    if (!stale && at && !storedOccurrence(event, at)) throw invalid("the series has no such day");
    if (!stale && !prior.includes("") && !prior.includes(at))
      marks = at ? [...prior, at] : [...prior.filter((mark) => typeof mark !== "string"), ""];
  }
  const state = stale ? "refused" : "applied";
  const refusal = stale ? "version_stale" : null;
  const made = await insertRow(tx, {
    accountId, calendarId: cal.id, eventId: stale ? event.id : target.id, op: "delete", payload: writePayloadOf(act, null, null),
    baseVersionTag: event.versionTag, idempotencyKey: key, state, refusal,
  });
  if (made === null) return { receipt: (await recorded(tx, accountId, key, act))!, eventIds: [], changes: [], wake: null };
  if (marks !== prior) {
    await tx.update(calEvents).set({ removedOccurrences: marks })
      .where(and(eq(calEvents.accountId, accountId), eq(calEvents.calendarId, cal.id), eq(calEvents.id, target.id)));
  }
  return {
    receipt: { id: made.id, key, state, reason: refusal },
    eventIds: [stale ? event.id : target.id], changes: [{ kind: "calendar_event", id: stale ? event.id : target.id, op: "update" }], wake: null,
  };
}

async function personalTransferOf(
  tx: Tx, accountId: string, cal: HeldCalendar, to: HeldCalendar,
  event: NonNullable<Awaited<ReturnType<typeof holdEventCopy>>>, days: number,
  act: Extract<CalendarEventAct, { kind: "calendar_event_move" }>,
): Promise<CalendarTransfer> {
  if (!event.portableCopy || event.partial || event.heldBack || event.myAnswer !== null || event.status !== "confirmed" ||
    event.removedOccurrences?.some((mark) => typeof mark === "string") || days || act.after || act.audience?.guests.length ||
    to.provider === "ics" || !event.versionTag) throw readOnly("this event cannot be copied safely to that calendar");
  const [guest] = await tx.select({ address: calAttendees.address }).from(calAttendees)
    .where(and(eq(calAttendees.accountId, accountId), eq(calAttendees.eventId, event.id),
      sql`lower(trim(${calAttendees.address})) is distinct from ${event.organizer?.trim().toLowerCase() ?? null}`)).limit(1);
  if (guest) throw readOnly("events with guests stay in their account’s calendars");
  const alarms = await tx.select({ minutesBefore: calAlarms.minutesBefore, method: calAlarms.method }).from(calAlarms)
    .where(and(eq(calAlarms.accountId, accountId), eq(calAlarms.eventId, event.id))).limit(L.alarms + 1);
  const start = timeOfStored(event.startKind, event.startLocal, event.startZone);
  const end = timeOfStored(event.endKind, event.endLocal, event.endZone);
  if (!start || !end || alarms.some((alarm) => alarm.method !== "notice")) throw readOnly("this event cannot be copied safely");
  const copy = checkedAct({ kind: "calendar_event_create", eventId: event.id, calendarId: to.id, event: {
    title: event.title, notes: event.notes, place: event.place, callLink: event.callLink, busy: event.busy, private: event.private,
    start: storedTimeOf(start), end: storedTimeOf(end), repeat: event.repeatRule, invitees: [], alarms: alarms.map((alarm) => alarm.minutesBefore),
  } });
  if (copy.kind !== "calendar_event_create" || cal.id === to.id) throw invalid("another calendar is required");
  return { source: event.providerId, fields: copy.event };
}

async function refuseWhileMoving(tx: Tx, accountId: string, eventId: string) {
  const [move] = await tx.select({ id: calWrites.id }).from(calWrites).where(and(
    eq(calWrites.accountId, accountId), eq(calWrites.eventId, eventId), eq(calWrites.state, "pending"),
    eq(calWrites.op, "move"), sql`${calWrites.payload} ? 'transfer'`,
  )).limit(1);
  if (move) throw new ServiceError("calendar_write_left", 409, "the move is still under way");
}

async function recordOnEvent(
  tx: Tx, accountId: string, key: string, act: Exclude<CalendarEventAct, { kind: "calendar_event_create" }>,
  o: { readonly now: number; readonly proven: ProvenRepeats },
): Promise<EnqueuedCalendarWrite> {
  const [seen] = await tx.select({ calendarId: calEvents.calendarId }).from(calEvents)
    .where(and(eq(calEvents.id, act.eventId), eq(calEvents.accountId, accountId))).limit(1);
  if (seen === undefined) throw notFound();
  const cal = await holdCalendar(tx, accountId, seen.calendarId);
  if (act.kind === "calendar_event_delete" && act.hide) {
    const [access] = await dialect(tx).forUpdate(tx.select({ role: calCalendars.access })
      .from(calCalendars).where(and(eq(calCalendars.accountId, accountId), eq(calCalendars.id, cal.id),
        eq(calCalendars.connectionId, cal.connectionId))).limit(1), { mode: "share" });
    if (!access || access.role !== "owner") throw readOnly("this calendar’s invitations cannot be hidden");
  }
  const selected = await holdEventCopy(tx, accountId, cal.id, eq(calEvents.id, act.eventId));
  if (selected === null) throw notFound();
  await refuseWhileMoving(tx, accountId, selected.id);
  if (act.kind === "calendar_event_delete" && act.localOnly)
    return recordLocalRemoval(tx, accountId, cal, key, act, selected);
  assertWritable(cal);
  if (act.kind === "calendar_event_answer" && writeRowOf(selected) === "day") {
    throw readOnly("this occurrence cannot be answered separately");
  }
  const paired = exceptionBaseOf(act.base);
  const exceptionEdit = act.kind === "calendar_event_update" && act.audience && writeRowOf(selected) === "day";
  const own = await ownOrganizerAddresses(tx, accountId, cal.principal, cal.organizerAddresses);
  let event = selected;
  let exception: CalendarWriteException | undefined;
  if (exceptionEdit) {
    const unavailable = selected.partial || selected.status === "cancelled" || selected.heldBack;
    const invited = isAttendeeCopy(selected, own, cal.access);
    if (unavailable || invited) throw readOnly("this occurrence is view only");
    if (selected.thisAndFuture || !selected.versionTag || act.after !== undefined ||
      (act.scope.kind !== "record" && act.scope.at !== selected.recurrenceId) ||
      (act.scope.kind !== "occurrence" && paired === null)) throw invalid("this occurrence needs its reviewed series and day");
    const master = await holdEventCopy(tx, accountId, cal.id, and(eq(calEvents.uid, selected.uid), eq(calEvents.recurrenceId, "")));
    if (!master || writeRowOf(master) !== "series" || master.partial || !master.versionTag || master.status === "cancelled" ||
      (cal.provider === "caldav" && (master.providerId !== selected.providerId || master.versionTag !== selected.versionTag))) throw readOnly("this occurrence has no writable series");
    await refuseWhileMoving(tx, accountId, master.id);
    event = master;
    exception = { id: selected.id, providerId: selected.providerId, version: selected.versionTag, occurrence: selected.recurrenceId };
  } else if (paired) {
    throw invalid("only a changed occurrence names two reviewed copies");
  }

  // An attendee copy takes only the account's answer. A series is written as a whole or by the days it names.
  // The drain asks the same rule of what it sends, so what it would not send is not recorded.
  if (act.kind === "calendar_event_update" && act.personalSeries) {
    const [guest] = await tx.select({ id: calAttendees.eventId }).from(calAttendees)
      .where(and(eq(calAttendees.accountId, accountId), eq(calAttendees.eventId, event.id))).limit(1);
    if (cal.provider !== "caldav" || writeRowOf(event) !== "series" || event.myAnswer !== null || guest || !personalSeriesOf(event.original)) {
      throw readOnly("this series is no longer a personal whole-day series");
    }
  }
  const series = writeRowOf(event) === "series";
  const days = changedDaysOf(event, series ? await changedRows(tx, accountId, cal.id, event.uid) : 0);
  const seriesEdit = series && act.kind === "calendar_event_update" && act.audience !== undefined;
  if (act.kind === "calendar_event_answer" && (event.heldBack || event.status === "cancelled"))
    throw readOnly("this invitation is no longer open for an answer");
  if (act.kind === "calendar_event_answer" && act.scope.kind === "occurrence" && !exception) {
    const changed = await holdEventCopy(tx, accountId, cal.id, and(eq(calEvents.uid, event.uid), eq(calEvents.recurrenceId, act.scope.at)));
    if (changed) throw readOnly("this occurrence has its own copy to review");
  }
  if (act.kind === "calendar_event_answer" && act.copy) {
    const addresses = await readOwnAddresses(tx, accountId);
    const identity = await attendeeIdentityOf(tx, accountId, cal, selected, addresses);
    const master = selected.id === event.id ? identity : await attendeeIdentityOf(tx, accountId, cal, event, addresses);
    if (act.copy.calendarId !== cal.id || identity?.attendee !== act.copy.attendee || master?.attendee !== act.copy.attendee)
      throw readOnly("this invitation is no longer the reviewed attendee copy");
  }
  const why = writeActRefusal(event, act, days, own, cal.access, exception !== undefined);
  if (why !== null) throw why.word === "read_only" ? readOnly(why.why) : invalid(why.why);
  if (act.kind === "calendar_event_update" && cal.access === "writer") {
    if (event.partial || !event.versionTag) throw readOnly("this shared copy is incomplete");
    if (cal.provider === "caldav" && event.original === null && event.organizer === null &&
        sharedCopyNeedsProtection(event, own, cal.access)) {
      const [guest] = await tx.select({ id: calAttendees.eventId }).from(calAttendees)
        .where(and(eq(calAttendees.accountId, accountId), eq(calAttendees.eventId, event.id))).limit(1);
      if (guest) throw readOnly("this shared copy is missing its reviewed calendar data");
    }
  }
  if (!exception && seriesEdit && act.scope.kind === "following" && cal.provider !== "caldav" &&
    (days > 0 || excludedOf(event).length > 0)) {
    throw invalid("this calendar cannot carry changed or cancelled occurrences to a new series");
  }
  // A whole series' new start moves its end (UNTIL) with it, as the drain writes it: where it cannot be moved, nothing is recorded.
  const moved = act.kind === "calendar_event_update" && act.scope.kind === "record" && writeRowOf(event) === "series" ? endMovedOf(event, act.change) : undefined;
  if (moved === null) throw invalid("a series that ends on a day keeps its last day: its end cannot be moved with this start");
  // A series is written only in a shape proven where the calendar is, as the drain asks it: the series as it stands, as a change of
  // it leaves it, and as its end before a day leaves it; and a day it names is one of its own.
  const d = shapesOf(cal, o);
  const first = timeOfStored(event.startKind, event.startLocal, event.startZone);
  const rule = writeRowOf(event) === "series" && event.repeatRule !== null ? parseRRule(event.repeatRule) : null;
  if (writeRowOf(event) === "series") {
    if (rule === null || first === null) throw invalid("the repeat is not one this calendar's server was proven to keep");
    const cloud = d.place === "google" || d.place === "microsoft";
    const checkingStoredCloudSeries = cloud && (act.kind === "calendar_event_answer" || (act.kind === "calendar_event_move" && act.audience !== undefined));
    const reviewedDelete = act.kind === "calendar_event_delete" && act.audience !== undefined;
    if (!reviewedDelete) assertProven(d, rule, first, seriesEdit || checkingStoredCloudSeries);
  }
  if (act.kind === "calendar_event_update" && act.scope.kind === "record") {
    const c = act.change;
    const after = c.repeat !== undefined ? (c.repeat === null ? null : parseRRule(c.repeat)) : moved !== undefined ? parseRRule(moved) : rule;
    assertProven(d, after, c.start === undefined ? first : eventTimeOf(storedTime(c.start)), seriesEdit);
  }
  if (act.kind === "calendar_event_delete" && rule !== null && first !== null &&
    !repeatDeleteScopes(d.place, rule, first, ZONES, d.now, d.proven).includes(act.scope.kind)) {
    throw invalid("this delete scope is not supported for the stored series");
  }
  const firstEnd = timeOfStored(event.endKind, event.endLocal, event.endZone);
  if ("scope" in act && act.scope.kind !== "record" && rule !== null && first !== null && firstEnd !== null) {
    // A day of it at a clock time that is not its own (the night the clocks go forward over that time) is named by no write, one day
    // or the days from it on, whatever today is: where it would be written is a guess. The drain refuses the same.
    if (offItsClock({ first, firstEnd, rule }, act.scope.at, ZONES)) {
      throw invalid("a day at a clock time that does not exist that night (the clocks go forward over it) is not written");
    }
    // A day it names is one of its own: one its rule names, not one it excludes. (A day's cancel of a day it does not have is done
    // as it stands, as the drain finds it done.)
    if (act.kind !== "calendar_event_delete" || act.scope.kind === "following") {
      if (isDayOf({ first, firstEnd, rule }, exception ? [] : excludedOf(event), act.scope.at, ZONES) === false) throw invalid("the series has no such day");
    }
    if (act.scope.kind === "following") {
      const at = /^\d{1,16}$/.test(act.scope.at) ? Number(act.scope.at) : Number.NaN;
      assertProven(d, Number.isSafeInteger(at) ? endedRule(rule, first, at, ZONES) : null, first, seriesEdit);
    }
  }
  let transfer: CalendarTransfer | undefined;
  if (act.kind === "calendar_event_move") {
    const to = await holdCalendar(tx, accountId, act.toCalendarId);
    if (to.id === cal.id) throw invalid("another calendar is required");
    if (to.access !== "owner") throw readOnly("an event can only move to a calendar the account owns");
    const native = to.connectionId === cal.connectionId &&
      (cal.provider === "google" || (cal.provider === "caldav" && cal.nativeMove && to.nativeMove));
    if (native && !act.copyThenRemove && cal.provider === "google" && !verifiedOrganizer(event.organizer, own))
      throw readOnly("only the verified organizer can move this Google event to another calendar");
    if (!native || act.copyThenRemove) transfer = await personalTransferOf(tx, accountId, cal, to, event, days, act);
  }
  // While a press on a day and the days after it is half carried out on this series (its first part is not done, and the series'
  // record ends exactly where it ends it), no other write may end, remove or re-shape the series: that press's own end could no
  // longer be found its own, and its days would be nowhere for good. It is tried again, or let go, first (the fourth recheck's
  // finding of a later press on an earlier day; the fifth's, of the whole series removed: that ends it too).
  const reshapes = ("scope" in act && act.scope.kind === "following")
    || (act.kind === "calendar_event_update" && act.scope.kind === "record" && (act.change.repeat !== undefined || act.change.start !== undefined))
    || act.kind === "calendar_event_move"
    || (act.kind === "calendar_event_delete" && act.scope.kind === "record");
  if (reshapes && rule !== null && first !== null && await halfCarriedOut(tx, accountId, event, rule, first)) {
    throw new ServiceError("calendar_write_left", 409, "a change of the days from a day on is half done on this series: it is tried again or let go first");
  }
  await assertRoom(tx, accountId, event.id);
  const standingWrite = exception
    ? { after: null, refusal: (Date.parse(paired?.[0] ?? act.base) !== ms(selected.updatedAt) ||
      (paired && Date.parse(paired[1]) !== ms(event.updatedAt))) ? "version_stale" as const : null }
    : await standing(tx, accountId, event, act, seriesEdit);
  const { after } = standingWrite;
  let refusal = standingWrite.refusal;
  if (series && act.kind === "calendar_event_update" &&
      !(event.versionTag && (exception && cal.provider !== "caldav"
        ? await confirmedSeriesEdit(tx, accountId, cal, selected, act, d) &&
          (act.scope.kind === "occurrence" || await confirmedSeriesEdit(tx, accountId, cal, event, act, d))
        : await confirmedSeriesEdit(tx, accountId, cal, event, act, d)))) {
    refusal = "version_stale";
  }
  let seriesCancellation: SeriesCancellation | undefined;
  if (act.kind === "calendar_event_delete" || (act.kind === "calendar_event_move" && !transfer)) {
    const deleteGuests = !event.partial && (cal.provider === "google" || cal.provider === "microsoft")
      ? await tx.select({ address: calAttendees.address, name: calAttendees.name }).from(calAttendees)
        .where(and(eq(calAttendees.accountId, accountId), eq(calAttendees.eventId, event.id)))
      : undefined;
    const wholeChangedCloud = act.kind === "calendar_event_delete" && act.scope.kind === "record" &&
      rule !== null && days > 0 && act.audience && (cal.provider === "google" || cal.provider === "microsoft");
    if (wholeChangedCloud && act.kind === "calendar_event_delete" && act.audience) {
      const changed = await changedSeriesAudience(tx, accountId, { ...event, calendarId: cal.id });
      const master = cloudDeleteMembers(d.place, { ...event, deleteGuests, unchangedSeries: true }, true, { kind: "record" });
      const union = master && changed && deleteAudienceOf([...master, ...changed.members], { kind: "record" });
      if (changed && union && sameDeleteAudience(union.audience, act.audience)) {
        seriesCancellation = { overrides: changed.overrides, message: act.cancellationMessage ?? "" };
      }
    }
    if (!event.versionTag || Date.parse(act.base) !== ms(event.updatedAt) ||
      !(seriesCancellation || confirmedDeleteAudience(d.place, { ...event, deleteGuests, unchangedSeries: days === 0 }, rule !== null,
        act.kind === "calendar_event_delete" ? act.scope : { kind: "record" }, act.audience, ZONES))) {
      refusal = "version_stale";
    }
  }
  if ((act.kind === "calendar_event_update" || act.kind === "calendar_event_delete") && act.scope.kind === "following") {
    return recordFollowing(tx, accountId, key, act, event, cal, { after, refusal }, d, seriesEdit, exception);
  }
  const payload: CalendarWritePayload = { ...writePayloadOf(act, after, null, exception), ...(seriesCancellation && { seriesCancellation }), ...(transfer && { transfer }) };
  const made = await insertRow(tx, {
    accountId, calendarId: cal.id, eventId: event.id, op: OP[act.kind], payload, baseVersionTag: event.versionTag,
    idempotencyKey: key, state: refusal === null ? "pending" : "refused", refusal,
  });
  if (made === null) return { receipt: (await recorded(tx, accountId, key, act))!, eventIds: [], changes: [], wake: null };
  return {
    receipt: { id: made.id, key, state: refusal === null ? "pending" : "refused", reason: refusal },
    eventIds: exception ? [event.id, exception.id] : [event.id],
    changes: [{ kind: "calendar_event", id: event.id, op: "update" }],
    wake: refusal === null ? cal.connectionId : null,
  };
}

async function confirmedSeriesEdit(
  tx: Tx,
  accountId: string,
  cal: HeldCalendar,
  event: { readonly id: string; readonly original: string | null; readonly organizer: string | null; readonly partial: boolean },
  act: Extract<CalendarEventAct, { kind: "calendar_event_update" }>,
  d: DoorShapes,
): Promise<boolean> {
  if (event.partial) return false;
  const people = await tx.select({ address: calAttendees.address }).from(calAttendees)
    .where(and(eq(calAttendees.accountId, accountId), eq(calAttendees.eventId, event.id)));
  const organizer = event.organizer?.trim().toLowerCase() ?? null;
  const guests = [...new Set(people.map((p) => p.address.trim().toLowerCase()).filter((address) => address !== organizer))].sort();
  if (!act.audience) return guests.length === 0 &&
    (cal.provider !== "caldav" || event.original === null ||
      confirmedDeleteAudience(d.place, event, true, act.scope, undefined, ZONES) !== null);
  if (cal.provider === "caldav" && event.original !== null) {
    return confirmedDeleteAudience(d.place, event, true, act.scope, act.audience, ZONES) !== null;
  }
  return organizer === act.audience.organizer &&
    JSON.stringify(guests) === JSON.stringify([...act.audience.guests].sort());
}

/**
 * Is a press on a day and the days after it half carried out on this series: its first part not done (owed with an attempt
 * counted, or shown refused and not for its copy), and the series' record, on another version than the press was made on, ending
 * exactly where that press ends it?
 */
async function halfCarriedOut(
  tx: Tx, accountId: string, event: { readonly id: string; readonly versionTag: string | null },
  rule: import("@ohmail/cal-core").RRule, first: import("@ohmail/cal-core").EventTime,
): Promise<boolean> {
  if (rule.until === null) return false;
  const rows = await tx.select({ state: calWrites.state, refusal: calWrites.refusal, attempts: calWrites.attempts, payload: calWrites.payload, base: calWrites.baseVersionTag })
    .from(calWrites).where(and(eq(calWrites.accountId, accountId), eq(calWrites.eventId, event.id), or(eq(calWrites.state, "pending"), eq(calWrites.state, "refused"))));
  for (const r of rows) {
    if (r.attempts <= 0 || r.base === event.versionTag) continue;
    const p = parseWritePayload(r.payload);
    if (p === null || p.part?.n !== 1 || p.act.kind !== "calendar_event_update" || p.act.scope.kind !== "following") continue;
    if (r.state === "refused" && await refusedForItsCopy(tx, accountId, r)) continue;
    const at = /^\d{1,16}$/.test(p.act.scope.at) ? Number(p.act.scope.at) : Number.NaN;
    const ended = Number.isSafeInteger(at) ? endedRule(rule, first, at, ZONES) : null;
    if (ended !== null && formatRRule(ended) === formatRRule(rule)) return true;
  }
  return false;
}

/** The series' row as a press on a day and the days after it reads it. */
interface FollowingRow {
  readonly id: string;
  readonly versionTag: string | null;
  readonly repeatRule: string | null;
  readonly excludedDates: unknown;
  /** The days the series cancels by a component of their own, read off its stored text. */
  readonly cancelled: readonly import("@ohmail/cal-core").EventTime[];
  readonly startKind: string;
  readonly startLocal: string;
  readonly startZone: string | null;
  readonly startsAt: Date;
  readonly endKind: string | null;
  readonly endLocal: string | null;
  readonly endZone: string | null;
  readonly title: string;
  readonly notes: string | null;
  readonly place: string | null;
  readonly callLink: string | null;
  readonly busy: boolean;
  readonly private: boolean;
}

const stored = (kind: string, value: string, zone: string | null): CalendarTime =>
  (zone === null ? { kind: kind as CalendarTime["kind"], value } : { kind: kind as CalendarTime["kind"], value, zone });

/** A stored time as the calendar core reads it. */
const timeOfStored = (kind: string | null, value: string | null, zone: string | null) =>
  (kind === null || value === null ? null : eventTimeOf(stored(kind, value, zone)));

/**
 * Every day a stored series excludes, as the writer reads them off its text: the days its EXDATE
 * lines name (the store's field), and the days it cancels by a component of their own (read off
 * the stored text, `storedObjectFacts`).
 */
const excludedOf = (
  row: { readonly excludedDates: unknown; readonly cancelled: readonly import("@ohmail/cal-core").EventTime[] },
): import("@ohmail/cal-core").EventTime[] => [
  ...(Array.isArray(row.excludedDates) ? row.excludedDates as import("@ohmail/cal-core").StoredTime[] : []).flatMap((t) => eventTimeOf(t) ?? []),
  ...row.cancelled,
];

/**
 * The rule a whole series' change writes where it names a new start and no repeat: the series' own,
 * its end (UNTIL) moved with the start so that its last day stays its last (`movedRule`, the drain's
 * own reckoning); `undefined` where the change moves no start; `null` where the end cannot be moved.
 */
function endMovedOf(
  row: Pick<FollowingRow, "repeatRule" | "startKind" | "startLocal" | "startZone" | "endKind" | "endLocal" | "endZone">,
  change: Partial<CalendarEventFields>,
): string | undefined | null {
  if (change.start === undefined || change.repeat !== undefined || row.repeatRule === null) return undefined;
  const first = timeOfStored(row.startKind, row.startLocal, row.startZone);
  const firstEnd = timeOfStored(row.endKind, row.endLocal, row.endZone);
  const rule = parseRRule(row.repeatRule);
  const to = eventTimeOf(storedTime(change.start));
  if (first === null || firstEnd === null || rule === null || to === null) return null;
  const moved = movedRule(rule, first, firstEnd, first, to, ZONES);
  return moved === null ? null : moved === rule ? undefined : formatRRule(moved);
}

/**
 * The series a day and the days after it become: the series' own fields as the store holds them,
 * from that day (`at`, the moment it was first at) on, with the person's change over them; its
 * start, end and repeat as the drain reckons them (`continuedSeries`: a count goes on with what is
 * left of it, an end on a day moves with a new time). `null` where the days cannot be carried so: a
 * series that is neither whole days nor a clock time in a zone, a count with nothing left, or an end
 * that cannot be moved (a new start on another day than the one pressed, with no repeat named).
 */
function followingFields(row: FollowingRow, at: number, change: Partial<CalendarEventFields>, alarms: readonly number[]): CalendarEventFields | null {
  const first = timeOfStored(row.startKind, row.startLocal, row.startZone);
  const firstEnd = timeOfStored(row.endKind, row.endLocal, row.endZone);
  const rule = row.repeatRule === null ? null : parseRRule(row.repeatRule);
  if (first === null || firstEnd === null || rule === null) return null;
  const named = {
    ...(change.start === undefined ? {} : { start: eventTimeOf(storedTime(change.start)) ?? undefined }),
    ...(change.end === undefined ? {} : { end: eventTimeOf(storedTime(change.end)) ?? undefined }),
    ...(change.repeat === undefined || change.repeat === null ? {} : { rule: parseRRule(change.repeat) ?? undefined }),
  };
  const next = continuedSeries({ first, firstEnd, rule }, at, named, ZONES);
  if (next === null) return null;
  // The days the series excludes from that day on go with those days, moved as the writer moves them; where they cannot go (a start
  // on another day, or whole days going on at a clock time or on another day), the writer would make no series of them, and nothing
  // of the press is recorded (the writer refuses the same, from the same reckoning, before it sends anything).
  const cut = clockOf(first, at, ZONES);
  if (cut === null || carriedExclusions(cut, excludedOf(row), next.start, ZONES) === null) {
    throw invalid("the days the series excludes from that day on go with them only on that day: a new start on another day, or whole days going on at a clock time, is not taken");
  }
  return {
    title: change.title ?? row.title,
    start: storedTimeOf(next.start) as CalendarTime,
    end: storedTimeOf(next.end) as CalendarTime,
    notes: change.notes !== undefined ? change.notes : row.notes,
    place: change.place !== undefined ? change.place : row.place,
    callLink: change.callLink !== undefined ? change.callLink : row.callLink,
    busy: change.busy ?? row.busy,
    private: change.private ?? row.private,
    repeat: formatRRule(next.rule),
    invitees: [],
    alarms: change.alarms ?? [...alarms],
  };
}

/**
 * A press on a day of a series and the days after it: two rows under one press. The first (`K`)
 * ends the series before that day; the second (`K:2`, after the first) makes the series those days
 * become, under the device's `newEventId`, whose row stands in the store as the person wants it
 * until the provider names it. A removal of those days is the first alone. Refused at the door, the
 * press is the first row alone, refused, and nothing is made.
 */
async function recordFollowing(
  tx: Tx, accountId: string, key: string, act: Exclude<CalendarEventAct, { kind: "calendar_event_create" | "calendar_event_move" | "calendar_event_answer" }>,
  event: FollowingRow & { readonly uid: string; readonly organizer: string | null }, cal: HeldCalendar, standing: { readonly after: string | null; readonly refusal: CalendarWriteFault | null },
  d: DoorShapes, editing = false, exception?: CalendarWriteException,
): Promise<EnqueuedCalendarWrite> {
  if (act.scope.kind !== "following") throw invalid("a day and the days after it are named by a following scope");
  const at = /^\d{1,16}$/.test(act.scope.at) ? Number(act.scope.at) : Number.NaN;
  if (!Number.isSafeInteger(at) || at <= event.startsAt.getTime()) throw invalid("a day and the days after it are named by a moment after the series' first day");
  // The new series keeps the series' invitees as they are invited (each hears of it from the provider, as of the series' end);
  // its organizer's own line is no invitee of it: the writer keeps it as it is.
  const people = (await tx.select({ address: calAttendees.address, name: calAttendees.name, role: calAttendees.role }).from(calAttendees)
    .where(and(eq(calAttendees.accountId, accountId), eq(calAttendees.eventId, event.id))))
    .filter((p) => event.organizer === null || p.address.toLowerCase() !== event.organizer.toLowerCase());
  // The writer carries each invitee's line as the series has it, its role among it; the new series' wanted record shows a chair
  // as required and one there for information as optional.
  const invitees = people.map((p) => ({ address: p.address, name: p.name, role: p.role === "optional" || p.role === "info" ? "optional" as const : "required" as const }));
  const twoParts = act.kind === "calendar_event_update";
  let made: {
    readonly act: Extract<CalendarEventAct, { kind: "calendar_event_create" }>; readonly fields: CalendarEventFields; readonly named: readonly ContinuedField[];
  } | null = null;
  if (twoParts) {
    if (act.scope.kind !== "following" || key.length > L.keyChars - 2) throw new ServiceError("idempotency_key_required", 400, "a press of two parts carries a key of at most 62 characters");
    const alarms = await tx.select({ m: calAlarms.minutesBefore }).from(calAlarms).where(and(eq(calAlarms.accountId, accountId), eq(calAlarms.eventId, event.id)));
    const carried = followingFields(event, at, act.change, [...new Set(alarms.map((a) => a.m))].sort((x, y) => x - y));
    const fields = carried === null ? null : { ...carried, invitees };
    const create = fields === null ? null : parseCalendarAct({ kind: "calendar_event_create", eventId: act.scope.newEventId, calendarId: cal.id, event: fields });
    if (fields === null || create === null || create.kind !== "calendar_event_create") throw invalid("the days from that day on cannot be carried as a series of their own");
    // The new series in a shape proven where the calendar is, from its own start: the drain asks it before the series' end goes.
    assertProven(d, fields.repeat === null ? null : parseRRule(fields.repeat), eventTimeOf(storedTime(fields.start)), editing);
    // The new series is made from the series' own component: of the act's fields, only the ones the person named are written anew.
    const named = CONTINUED_FIELDS.filter((f) => act.change[f] !== undefined);
    made = { act: checkedAct(create) as Extract<CalendarEventAct, { kind: "calendar_event_create" }>, fields, named };
    if (await openCount(tx, accountId, null) + 2 > L.openPerAccount) throw new ServiceError("calendar_writes_full", 409, "too many calendar writes are waiting");
  }
  const { after, refusal } = standing;
  const first = await insertRow(tx, {
    accountId, calendarId: cal.id, eventId: event.id, op: OP[act.kind], payload: writePayloadOf(act, after, twoParts ? { of: key, n: 1 } : null, exception),
    baseVersionTag: event.versionTag, idempotencyKey: key, state: refusal === null ? "pending" : "refused", refusal,
  });
  if (first === null) return { receipt: (await recorded(tx, accountId, key, act))!, eventIds: [], changes: [], wake: null };
  const receipt: CalendarWriteReceipt = { id: first.id, key, state: refusal === null ? "pending" : "refused", reason: refusal };
  if (made === null || refusal !== null) {
    return { receipt, eventIds: [event.id], changes: [{ kind: "calendar_event", id: event.id, op: "update" }], wake: refusal === null ? cal.connectionId : null };
  }
  const second = await insertRow(tx, {
    accountId, calendarId: cal.id, eventId: made.act.eventId, op: "create",
    payload: writePayloadOf(made.act, first.id, { of: key, n: 2, from: { eventId: event.id, at: act.scope.at, named: made.named,
      ...(act.kind === "calendar_event_update" && act.personalSeries && { personalSeries: true }),
      confirmed: true } }),
    baseVersionTag: null, idempotencyKey: `${key}:2`, state: "pending",
  });
  if (second === null) throw invalid("the second part of this press is recorded already");
  await insertWanted(tx, accountId, cal.id, made.act.eventId, second.id, made.act.event);
  return {
    receipt,
    eventIds: [event.id, made.act.eventId],
    changes: [{ kind: "calendar_event", id: event.id, op: "update" }, { kind: "calendar_event", id: made.act.eventId, op: "create" }],
    wake: cal.connectionId,
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
 * change recorded, including the event sequence on an applied Hide replay.
 */
export async function recordCalendarWrite(
  ctx: ServiceContext, key: string, body: unknown,
  o: { readonly proven?: ProvenRepeats } = {},
): Promise<{ answer: CalendarWriteAnswer; seq: bigint | null }> {
  const act = checkedAct(body);
  await requireCalendarOn(ctx);
  const done = await withAccountTx(ctx, async (tx) => {
    const q = await enqueueCalendarWrite(tx, { key, act }, { now: ctx.now().getTime(), ...(o.proven === undefined ? {} : { proven: o.proven }) });
    const seqs = q.changes.length > 0 ? await recordCalendarChanges(tx, ctx.accountId, q.changes) : [];
    if (seqs.length === 0 && act.kind === "calendar_event_delete" && act.hide && q.receipt.state === "applied") {
      const [write] = await tx.select({ eventId: calWrites.eventId }).from(calWrites)
        .where(and(eq(calWrites.id, q.receipt.id), eq(calWrites.accountId, ctx.accountId)));
      if (write?.eventId) {
        const [change] = await tx.select({ seq: changeLog.seq }).from(changeLog)
          .where(and(eq(changeLog.accountId, ctx.accountId), eq(changeLog.entityType, "calendar_event"),
            eq(changeLog.entityId, write.eventId))).orderBy(desc(changeLog.seq)).limit(1);
        return { q, seq: change?.seq ?? null };
      }
    }
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

/**
 * The open writes that wait for `head`, directly or through another: they were made on what it would
 * write. Of any event: the second part of a press on a day and the days after it is the new series'.
 */
async function followersOf(tx: Tx, accountId: string, head: WriteRowHeld): Promise<string[]> {
  const open = await tx.select({ id: calWrites.id, payload: calWrites.payload }).from(calWrites).where(and(
    eq(calWrites.accountId, accountId), inArray(calWrites.state, ["pending", "refused"]),
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
 * The refusals after which an attempt of a write may have landed at the provider unheard: the words that wait for time (the
 * worker's word plan: a provider throttling, down, or never heard back), and `expired` (too old, after an attempt of that kind).
 */
const UNHEARD: readonly CalendarWriteFault[] = ["throttled", "unavailable", "timeout", "connection_failed", "host_unresolved", "unknown", "expired"];
const MAY_HAVE_LANDED: ReadonlySet<string> = new Set(UNHEARD);

/** Does this write wait for one (`after`) that is not done: owed or refused? */
async function waitsOnUndone(tx: Tx, accountId: string, row: Pick<WriteRowHeld, "payload">): Promise<boolean> {
  const after = parseWritePayload(row.payload)?.after ?? null;
  if (after === null) return false;
  const [prev] = await tx.select({ state: calWrites.state }).from(calWrites).where(and(eq(calWrites.id, after), eq(calWrites.accountId, accountId))).limit(1);
  return prev !== undefined && prev.state !== "applied";
}

/**
 * `POST /calendar/writes/:id/retry`: a refused write is owed again, with the writes that were
 * refused only because they waited for it. A write still owed answers as it stands. A change
 * refused for the copy it was made on is not retried ("keep mine" is a new act, made on the copy
 * the store holds now), and neither is a write that waited for one. A write refused only because
 * the one it waited for was is not retried alone while that one stays refused: its version is the
 * one the store held when it was recorded, which its device may never have held. It goes again
 * with that one's retry. A series' end claimed before goes again as a later attempt (one attempt
 * counted) only where an attempt of it may have landed unheard: where it was refused with a word that
 * waits for time, or `expired`, or more than one attempt of it was claimed. Owed so, it is not let go
 * until the drain answers it. Refused with any other word on its only attempt (the provider answered
 * it, or nothing of it was sent), it goes again from its first attempt, and takes no end it finds at
 * the provider for its own.
 */
export async function retryCalendarWrite(ctx: ServiceContext, writeId: string): Promise<{ answer: CalendarWriteAnswer; seq: bigint | null }> {
  await requireCalendarOn(ctx);
  const done = await withAccountTx(ctx, async (tx) => {
    const t = bridgeTx(tx);
    const row = await heldWrite(t, ctx.accountId, writeId);
    if (row.state === "applied") throw new ServiceError("calendar_write_left", 409, "the write is done");
    if (row.state !== "refused") return { receipt: receiptOf(row.key, row), eventIds: row.eventId === null ? [] : [row.eventId], seq: null, wake: null };
    if (parseWritePayload(row.payload)?.transfer)
      throw new ServiceError("calendar_write_left", 409, "a refused move is reviewed again on the calendar");
    if (await refusedForItsCopy(t, ctx.accountId, row)) {
      throw new ServiceError("calendar_write_left", 409, "a change made on an older copy is made again as a new act");
    }
    // A write that waits for another goes again only once that one is done: retry the one it waits for (which takes it along).
    if (await waitsOnUndone(t, ctx.accountId, row)) throw new ServiceError("calendar_write_left", 409, "the write it waits for is not done");
    const followers = await followersOf(t, ctx.accountId, row);
    const again = { state: "pending", refusal: null, attempts: 0, nextAttemptAt: null, updatedAt: sql`now()` } as const;
    // A series' end that was claimed before may have landed, its answer never heard: it goes again as a later attempt, so that
    // the drain may find that end its own (the second recheck's first finding); but only where an attempt of it may have landed
    // unheard: its refusal is a word that waits for time, or `expired`, or more than one attempt of it was claimed (a row reaches
    // a second attempt only after one that ended so, or was cut: the fourth recheck's first finding). Refused with any other word on its only
    // attempt, the provider answered it and nothing of it landed: counted as one, the retry would take an end someone else made
    // since for its own, and make their days a second time (the third recheck's fourth finding). Its followers were never claimed
    // (a write is claimed only once the one it waits for is done), and go again from their first.
    const payload = parseWritePayload(row.payload);
    const act = payload?.act;
    const mayHaveLanded = row.attempts > 0 && (row.attempts > 1 || (row.refusal !== null && MAY_HAVE_LANDED.has(row.refusal)));
    const claimedEnd = row.attempts > 0 && act !== undefined && "scope" in act && act.scope.kind === "following"
      && mayHaveLanded;
    const cancellation = mayHaveLanded && payload?.act.kind === "calendar_event_delete"
      ? { payload: { ...payload, cancellationAttempted: true } } : {};
    await t.update(calWrites).set({ ...again, ...cancellation, attempts: claimedEnd ? 1 : 0 })
      .where(and(eq(calWrites.id, row.id), eq(calWrites.accountId, ctx.accountId)));
    // Each event whose mark changes is told: the write's own, and its followers' (the second half of a press is the new series').
    const touched = new Set(row.eventId === null ? [] : [row.eventId]);
    if (followers.length > 0) {
      const back = await t.update(calWrites).set(again).where(and(
        eq(calWrites.accountId, ctx.accountId), inArray(calWrites.id, followers), eq(calWrites.refusal, "earlier_refused"),
      )).returning({ eventId: calWrites.eventId });
      for (const r of back) if (r.eventId !== null) touched.add(r.eventId);
    }
    const [cal] = await t.select({ connectionId: calCalendars.connectionId }).from(calCalendars)
      .where(and(eq(calCalendars.id, row.calendarId), eq(calCalendars.accountId, ctx.accountId))).limit(1);
    const seqs = touched.size === 0 ? [] : await recordCalendarChanges(tx, ctx.accountId, [...touched].map((id) => ({ kind: "calendar_event" as const, id, op: "update" as const })));
    return {
      receipt: { id: row.id, key: row.key, state: "pending" as const, reason: null }, eventIds: [...touched], seq: seqs.at(-1) ?? null,
      wake: cal?.connectionId ?? null,
    };
  });
  if (done.wake !== null) await wakeCalendarConnection(ctx, done.wake);
  return { answer: await echo(ctx, done.receipt, done.eventIds), seq: done.seq };
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
    // The second part of a press goes alone only once the first is done (the half-done state); before, the first is let go, with it.
    if (parseWritePayload(row.payload)?.part?.n === 2 && await waitsOnUndone(t, ctx.accountId, row)) {
      throw new ServiceError("calendar_write_left", 409, "the press's first part is not done: it is let go, with this one");
    }
    const followers = await followersOf(t, ctx.accountId, row);
    const going = [row.id, ...followers];
    const changes: CalendarChange[] = [];
    let gone = false;
    // A new event a write let go stood in for, never at the provider (the write's own, or the second part's of a press
    // on a day and the days after it): it goes with every write of it.
    const made = await t.select({ id: calWrites.id, eventId: calWrites.eventId }).from(calWrites)
      .where(and(eq(calWrites.accountId, ctx.accountId), inArray(calWrites.id, going), eq(calWrites.op, "create")));
    for (const m of made) {
      if (m.eventId === null) continue;
      const [event] = await t.select({ providerId: calEvents.providerId }).from(calEvents)
        .where(and(eq(calEvents.id, m.eventId), eq(calEvents.accountId, ctx.accountId))).limit(1);
      if (event === undefined || event.providerId !== `pending:${m.id}`) continue;
      await t.delete(calWrites).where(and(eq(calWrites.accountId, ctx.accountId), eq(calWrites.eventId, m.eventId), inArray(calWrites.state, ["pending", "refused"])));
      await t.delete(calAttendees).where(and(eq(calAttendees.accountId, ctx.accountId), eq(calAttendees.eventId, m.eventId)));
      await t.delete(calAlarms).where(and(eq(calAlarms.accountId, ctx.accountId), eq(calAlarms.eventId, m.eventId)));
      await t.delete(calEvents).where(and(eq(calEvents.id, m.eventId), eq(calEvents.accountId, ctx.accountId)));
      changes.push({ kind: "calendar_event", id: m.eventId, op: "delete" });
      if (m.id === row.id) gone = true;
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
