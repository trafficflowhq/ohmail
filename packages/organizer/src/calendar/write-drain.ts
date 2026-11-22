/**
 * THE DRAIN OF THE WRITES OWED TO A PROVIDER: one connection's, inside its turn, on the turn's own
 * bound handle and sign-in, before the reading that would otherwise undo them.
 *
 * In the order they were recorded, strictly: only the oldest owed write of the connection is sent,
 * and while it waits nothing behind it is sent. Each is claimed in a short transaction (one more
 * attempt, a lease), sent with no transaction open, and settled in one transaction with what the
 * provider answered. Every name a provider gets for a new object is made from the row's own id, so
 * a write sent again after a lost answer names the same object, and the provider's own guard makes
 * it one.
 *
 * A word that waits for the person gives the attempt back; one that waits for time keeps the row
 * owed and ends the drain for the turn; every other word refuses the row, and the rows that waited
 * for it, at once. Nothing a provider answered is ever thrown: the drain answers when the
 * connection is next due, and never an invalid time.
 */
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { ZoneSource } from "@ohmail/cal-core";
import {
  asWriteRefusal, proofPlaceOf, storedObjectFacts, type Clock, type ProofPlace, type ProviderWord, type ProvenRepeats, type SeriesContinuation, type WriteAnswer, type WriteTarget,
} from "@ohmail/cal-providers";
import type { Logger } from "@trafficflow/core";
import { calAttendees, calCalendars, calEvents, calWrites, recordCalendarChanges, type CalendarChange, type LedgerTx, type Tx } from "@trafficflow/db";
import {
  appliedPayloadOf, changedDaysOf, endedDayOf, exceptionBaseOf, ownOrganizerAddresses, parseWritePayload, someoneElses, writeRowOf, type CalendarWritePayload, type CalendarTransferProgress,
} from "@trafficflow/db/calendar";
import { dialect } from "@trafficflow/db/dialect";
import { inConnection } from "./connection.js";
import { ownAddressesOf } from "./reading.js";
import { timeOfKey } from "./map.js";
import { calendarEnabledAt } from "./state.js";
import type { CalendarWriteDrain, CalendarWriteDrainInput, CalendarWriteWait } from "./types.js";
import { TURN_MS, WORD_PLAN, type CalendarSyncFault } from "./words.js";
import { pressShaped, secondPartHolds, secondPartIsThePress, writeCallOf, type StoredEvent, type WriteWord } from "./write-request.js";
import { moveRefusal, retryTransfer, transferPersonalEvent } from "./personal-transfer.js";
import { refuseInTx, settleApplied, settleGivenBack, settleLater, settleRefused, type ClaimedWrite, type SettleContext } from "./write-settle.js";

/** A claim's lease: a write claimed and never settled (a crash) is owed again after this. */
export const WRITE_LEASE_MS = 120_000;
/** Attempts a write is given; past them it is refused with its last word. */
export const WRITE_MAX_ATTEMPTS = 8;
/**
 * A write older than this is never sent late: it is refused, `expired` (but a press's second part whose first is done; and a series'
 * end claimed before is looked at at the provider, nothing sent, and closed as applied where it is found its own).
 */
export const WRITE_MAX_AGE_MS = 72 * 3_600_000;
/** A write that waits for time waits at least this, doubling, and at most the ceiling. */
export const WRITE_RETRY_FLOOR_MS = 60_000;
export const WRITE_RETRY_CEILING_MS = 3_600_000;
/** An applied row is kept this long for its key, then pruned, at most `WRITE_PRUNE_PER_TURN` a turn. */
export const WRITE_APPLIED_KEPT_MS = 7 * 24 * 3_600_000;
export const WRITE_PRUNE_PER_TURN = 200;
/** Expired heads one claim refuses before it gives up for the turn. */
const EXPIRED_PER_CLAIM = 20;

export interface WriteDrainDeps {
  readonly clock: Clock;
  readonly zones: ZoneSource;
  readonly log: Logger;
  /** The drain's own bound: no further write starts once it is spent (`TURN_MS` where not said). */
  readonly turnMs?: number;
  /** The repeats proven at each place a proof was run (the providers' own table where not said). */
  readonly proven?: ProvenRepeats;
}

/** The doubling wait of a write's `attempts`-th try, inside the floor and the ceiling, never below the provider's wish. */
export function writeWait(attempts: number, retryAfterMs: number | null): number {
  const n = Math.max(1, Math.min(attempts, 30));
  return Math.max(retryAfterMs ?? 0, Math.min(WRITE_RETRY_CEILING_MS, WRITE_RETRY_FLOOR_MS * 2 ** (n - 1)));
}

/** What a write's call came to: the writer's answer, or the queue's own refusal of an act no call can be made of. */
type Outcome = WriteAnswer | ReturnType<typeof moveRefusal> | typeof retryTransfer | { readonly ok: false; readonly reason: "content_refused"; readonly retryAfterMs: null };

/** The second part of a press, as the first part's claim reads it: its row, and what it asks. */
interface Second {
  readonly id: string;
  readonly payload: CalendarWritePayload;
  readonly createdAt: Date;
  readonly createdVersion: string | null;
}

type Claim =
  | {
      readonly kind: "claimed"; readonly write: ClaimedWrite; readonly payload: CalendarWritePayload; readonly event: StoredEvent | null; readonly to: string | null;
      readonly organizer: string | null; readonly own: ReadonlySet<string>;
      /** Whose an event is: the account's mailboxes by the one own set, and the connection's principal; the door asks the same. */
      readonly owners: ReadonlySet<string>;
      /** Where the connection's series are proven: its provider's word, a CalDAV server's own host. */
      readonly place: ProofPlace | null;
      /** The second part of this write's press, where it is the first of two: sent only after it, and only if it can be sent. */
      readonly second: Second | "unreadable" | null;
      /** The series a press's second part comes from, as the store holds it (`null`: gone from the store); `undefined` for any other write. */
      readonly source: StoredEvent | null | undefined;
      readonly exception: WriteTarget["exception"] | "stale";
      /** A series' end found at the provider may be this write's own: an earlier attempt of it was claimed, and no other write may have made it. */
      readonly mayBeDone: boolean;
      /** A series' end claimed before and too old to send: looked at at the provider, never sent. */
      readonly late: boolean;
      readonly finalMove: boolean;
      /** The write's own key; for a press's second part the key of the row it waits for, and the day that row, done, ended the series at. */
      readonly key: string;
      readonly firstKey: string | null;
      readonly firstEnded: string | null;
    }
  | { readonly kind: "wait"; readonly at: Date }
  | { readonly kind: "none" | "off" | "busy" | "gone" };

interface Tally {
  applied: number;
  refused: number;
  expired: number;
  orphaned: number;
  unkept: number;
  reason: string | null;
  /** The provider asked for a wait of its own: the turn ends, and the connection waits it out. */
  wait: CalendarWriteWait | null;
}

/** The drain for a worker's calendar turns, made once from what it reads and nothing else. */
export const calendarWriteDrain = (deps: WriteDrainDeps): CalendarWriteDrain => (input) => drain(deps, input);

/** A time a turn can be due at, or none: never an invalid one, never more than an hour on. */
function dueAt(ms: number | null, now: number): Date | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return new Date(Math.min(Math.max(ms, now), now + WRITE_RETRY_CEILING_MS));
}

async function drain(deps: WriteDrainDeps, input: CalendarWriteDrainInput): ReturnType<CalendarWriteDrain> {
  const started = deps.clock.now();
  const bound = deps.turnMs ?? TURN_MS;
  const word = input.provider.reader.provider;
  const tally: Tally = { applied: 0, refused: 0, expired: 0, orphaned: 0, unkept: 0, reason: null, wait: null };
  let next: number | null = null;
  let more = false;
  for (;;) {
    if (input.signal.aborted) break;
    const used = deps.clock.now() - started;
    if (used >= bound) {
      // Its own time is spent: what it left is owed as soon as the time it took has passed again.
      more = true;
      next = deps.clock.now() + used;
      break;
    }
    const claim = await claimNext(deps, input, tally);
    if (claim.kind === "wait") {
      next = claim.at.getTime();
      break;
    }
    if (claim.kind !== "claimed") break;
    const answer = await carryOut(deps, input, word, claim);
    const ctx: SettleContext = { db: input.db, key: input.key, word, map: { zones: deps.zones, ownAddresses: new Set(claim.own) } };
    const step = await settle(ctx, claim, answer, tally, input.signal.aborted);
    if (step === "stop") break;
    if (typeof step === "number") {
      next = step;
      break;
    }
  }
  await prune(input);
  if (tally.applied + tally.refused + tally.expired + tally.orphaned > 0) {
    deps.log.info("calendar_writes", {
      accountId: input.key.accountId, kind: word, applied: tally.applied, refused: tally.refused, expired: tally.expired,
      count: tally.orphaned, more, ...(tally.reason === null ? {} : { reason: tally.reason }),
    });
  }
  if (tally.unkept > 0) deps.log.warn("calendar_objects_refused", { accountId: input.key.accountId, kind: word, count: tally.unkept });
  return { nextAttemptAt: dueAt(next, deps.clock.now()), ...(tally.wait === null ? {} : { wait: tally.wait }) };
}

/**
 * The oldest owed write of this connection, claimed: one more attempt and a lease, in one short
 * transaction that reads the account's switch again. A head too old or tried too often is refused
 * `expired` and the next one is looked at; a head that waits (its time, its lease) holds the queue.
 */
async function claimNext(deps: WriteDrainDeps, input: CalendarWriteDrainInput, tally: Tally): Promise<Claim> {
  const { key } = input;
  const done = await inConnection(input.db, input.key, async ({ tx, held }): Promise<Claim> => {
    if (await calendarEnabledAt(tx, key.accountId) === null) return { kind: "off" };
    for (let i = 0; i < EXPIRED_PER_CLAIM; i++) {
      const [head] = await tx.select({
        id: calWrites.id, key: calWrites.idempotencyKey, attempts: calWrites.attempts, op: calWrites.op, calendarId: calWrites.calendarId,
        calendarProviderId: calCalendars.providerId, calendarAccess: calCalendars.access,
        eventId: calWrites.eventId, baseVersionTag: calWrites.baseVersionTag,
        payload: calWrites.payload, nextAttemptAt: calWrites.nextAttemptAt, createdAt: calWrites.createdAt,
        waiting: sql<boolean>`coalesce(${calWrites.nextAttemptAt} > now(), false)`,
        aged: sql<boolean>`${calWrites.createdAt} < now() - make_interval(secs => ${WRITE_MAX_AGE_MS / 1000})`,
        spent: sql<boolean>`${calWrites.attempts} >= ${WRITE_MAX_ATTEMPTS}`,
      }).from(calWrites)
        .innerJoin(calCalendars, and(eq(calCalendars.id, calWrites.calendarId), eq(calCalendars.accountId, calWrites.accountId)))
        .where(and(eq(calWrites.accountId, key.accountId), eq(calCalendars.connectionId, key.id), eq(calWrites.state, "pending")))
        .orderBy(asc(calWrites.createdAt), asc(sql`coalesce((${calWrites.payload}->'part'->>'n')::int, 1)`), asc(calWrites.id))
        .limit(1);
      if (head === undefined) return { kind: "none" };
      if (head.waiting) return { kind: "wait", at: head.nextAttemptAt! };
      // Held by another drain this moment: the queue is someone else's for now, and its order is kept.
      const [locked] = await dialect(tx).skipLocked(tx.select({ id: calWrites.id }).from(calWrites)
        .where(and(eq(calWrites.id, head.id), eq(calWrites.accountId, key.accountId), eq(calWrites.state, "pending"), eq(calWrites.attempts, head.attempts))), { mode: "update" });
      if (locked === undefined) return { kind: "busy" };
      const payload = parseWritePayload(head.payload);
      // The second part of a press goes only after its first is done: a first refused takes it along (a row recorded otherwise).
      const [first] = payload?.part?.n === 2 && payload.after !== null
        ? await tx.select({ state: calWrites.state, key: calWrites.idempotencyKey, payload: calWrites.payload }).from(calWrites)
          .where(and(eq(calWrites.id, payload.after), eq(calWrites.accountId, key.accountId))).limit(1)
        : [];
      const write: ClaimedWrite = {
        id: head.id, attempts: head.attempts, op: head.op, calendarId: head.calendarId, calendarProviderId: head.calendarProviderId,
        eventId: head.eventId, baseVersionTag: head.baseVersionTag, provisional: false, copied: payload?.transfer !== undefined,
        toCalendarId: payload?.act.kind === "calendar_event_move" ? payload.act.toCalendarId : null, kept: appliedPayloadOf(payload?.act ?? null),
      };
      // A press's second part whose first is done is the repair of a press half carried out (the series ends at the provider, and
      // the days after it are nowhere else): it is never too old to make. Every other write is never sent late.
      const halfDone = payload?.part?.n === 2 && payload.after !== null && (first === undefined || first.state === "applied");
      // A series' end claimed before and too old now is not sent, and is not refused before it is looked at at the provider: its
      // attempt may have landed unheard. It is claimed to be looked at (`late`): the writer reads the member and sends nothing. Found
      // ended exactly where the press ends it, on another version than the press was made on, and the end maybe its own, the row is
      // closed as applied with its day kept: its second part is then the repair of a press half carried out. Otherwise it expires;
      // a read that fails waits as any attempt does; nothing goes late (the third recheck's third finding; the fourth recheck's, of
      // an end that lands as the turn is cut, then the queue's age).
      const endDay = payload !== null && "scope" in payload.act && payload.act.scope.kind === "following" ? payload.act.scope.at : null;
      const late = !head.spent && head.aged && endDay !== null && head.attempts > 0 && head.eventId !== null;
      const expired = head.spent || (head.aged && !halfDone && !late);
      const finalMove = expired && !!payload?.transfer?.progress;
      if ((expired && !finalMove) || payload === null || (first !== undefined && first.state !== "applied")) {
        const changes: CalendarChange[] = [];
        const word = payload === null ? "content_refused" : expired ? "expired" : "earlier_refused";
        await refuseInTx(tx, key.accountId, write, word, changes);
        await recordCalendarChanges(tx as unknown as LedgerTx, key.accountId, changes);
        if (word === "expired") tally.expired += 1;
        else tally.refused += 1;
        continue;
      }
      const provider = input.provider.reader.provider;
      const readDeleteGuests = payload.act.kind === "calendar_event_update" ||
        ((payload.act.kind === "calendar_event_delete" || payload.act.kind === "calendar_event_move") && (provider === "google" || provider === "microsoft"));
      const event = head.eventId === null ? undefined : await storedEventOf(tx, key.accountId, head.calendarId, head.eventId, readDeleteGuests);
      if (event === undefined && head.op !== "create" && !payload.transfer?.progress) {
        // Its event is gone from the store: a removal is done; anything else has nothing left to change. And so has a removal of
        // days that a press of the queue gave a series of their own since it was recorded (the days from a day on; one day, where a
        // press ended the series at or before it): they stand in that series, and the removal is not shown done.
        const days = payload.act.kind === "calendar_event_delete" && payload.act.scope.kind !== "record" ? payload.act.scope : null;
        const movedOn = days !== null && head.eventId !== null
          && await endedSince(tx, key.accountId, { id: head.id, eventId: head.eventId, createdAt: head.createdAt }, days.kind === "occurrence" ? { day: days.at } : {});
        if (head.op === "delete" && !movedOn) {
          await tx.update(calWrites).set({ state: "applied", payload: write.kept, nextAttemptAt: null, updatedAt: sql`now()` })
            .where(and(eq(calWrites.id, head.id), eq(calWrites.accountId, key.accountId)));
          tally.applied += 1;
        } else {
          await tx.delete(calWrites).where(and(eq(calWrites.id, head.id), eq(calWrites.accountId, key.accountId)));
          tally.orphaned += 1;
        }
        continue;
      }
      // The letting go of the days from a day on, recorded before a press of the queue gave days of this series a series of their own,
      // names days that are no longer this series': it is not sent, and not done as it stands either: refused for its copy, it is
      // made again on what the calendar shows (the fourth recheck's finding of a removal shown done while its days stand). And so
      // is a new repeat for the whole series recorded before a write of the queue ended it at a day (a press, or those days let
      // go): it was made on the series whole, and written onto the ended one it would give it those days back, twice where a
      // press made them a series of their own.
      if (head.eventId !== null && (
        (payload.act.kind === "calendar_event_delete" && payload.act.scope.kind === "following"
        && await endedSince(tx, key.accountId, { id: head.id, eventId: head.eventId, createdAt: head.createdAt }))
        || (payload.act.kind === "calendar_event_update" && payload.act.scope.kind === "record" && payload.act.change.repeat !== undefined
          && await endedSince(tx, key.accountId, { id: head.id, eventId: head.eventId, createdAt: head.createdAt }, { lettingGo: true })))) {
        const changes: CalendarChange[] = [];
        await refuseInTx(tx, key.accountId, write, "version_stale", changes);
        await recordCalendarChanges(tx as unknown as LedgerTx, key.accountId, changes);
        tally.refused += 1;
        continue;
      }
      // The whole series removed while the second part of a press made from it stands refused: that press's days are made a series
      // of their own from this series' record, which the removal would take with it (and, where the press's first part is the one
      // refused, whatever its word, its days themselves): they would be nowhere for good. Refused with it, nothing sent: the press is
      // tried again or let go first, then the removal's retry goes (the fifth recheck's finding; the same behind a press refused whole).
      if (payload.act.kind === "calendar_event_delete" && payload.act.scope.kind === "record" && head.eventId !== null
        && await secondPartRefused(tx, key.accountId, head.eventId)) {
        const changes: CalendarChange[] = [];
        await refuseInTx(tx, key.accountId, write, "earlier_refused", changes);
        await recordCalendarChanges(tx as unknown as LedgerTx, key.accountId, changes);
        tally.refused += 1;
        continue;
      }
      const [claimedRow] = await tx.update(calWrites).set({
        attempts: sql`${calWrites.attempts} + 1`, nextAttemptAt: sql`now() + make_interval(secs => ${WRITE_LEASE_MS / 1000})`, updatedAt: sql`now()`,
      }).where(and(eq(calWrites.id, head.id), eq(calWrites.accountId, key.accountId), eq(calWrites.attempts, head.attempts), eq(calWrites.state, "pending")))
        .returning({ attempts: calWrites.attempts });
      if (claimedRow === undefined) return { kind: "busy" };
      const own = await ownAddressesOf(tx, key.accountId, held.principal);
      const owners = await ownOrganizerAddresses(tx, key.accountId, held.principal);
      const exception = payload.exception === undefined ? undefined : await reviewedExceptionOf(
        tx, key.accountId, head.calendarId, payload, event, owners, head.attempts === 0 && !payload.exception.masterReceipt,
      );
      let ownInvitee: string | null = null;
      if (event !== undefined && head.op === "answer") {
        const people = await tx.select({ address: calAttendees.address }).from(calAttendees)
          .where(and(eq(calAttendees.accountId, key.accountId), eq(calAttendees.eventId, head.eventId!)));
        ownInvitee = people.map((p) => p.address.toLowerCase()).find((a) => own.has(a)) ?? null;
      }
      let to: string | null = null;
      if (write.toCalendarId !== null) {
        const [dest] = await tx.select({ providerId: calCalendars.providerId }).from(calCalendars).where(and(
          eq(calCalendars.id, write.toCalendarId), eq(calCalendars.accountId, key.accountId), eq(calCalendars.connectionId, key.id),
        )).limit(1);
        to = dest?.providerId ?? null;
      }
      const principal = held.principal?.trim().toLowerCase().replace(/^mailto:/, "") ?? "";
      const organizer = principal.includes("@") && !principal.includes("/") ? principal : ([...own][0] ?? null);
      // The first of a press's two parts is sent only where its second could be sent after it: else neither is.
      let second: Second | "unreadable" | null = null;
      if (payload.part?.n === 1) {
        const [next] = await tx.select({ id: calWrites.id, payload: calWrites.payload, createdAt: calWrites.createdAt, createdVersion: calWrites.baseVersionTag }).from(calWrites).where(and(
          eq(calWrites.accountId, key.accountId), eq(calWrites.idempotencyKey, `${payload.part.of}:2`), eq(calWrites.state, "pending"),
        )).limit(1);
        const read = next === undefined ? null : parseWritePayload(next.payload);
        second = next === undefined ? null : read === null ? "unreadable" : { id: next.id, payload: read, createdAt: next.createdAt, createdVersion: next.createdVersion };
      }
      // The second part of a press on a day and the days after it is made from the series it comes from, as the store holds it.
      const from = payload.part?.n === 2 ? payload.part.from : undefined;
      const source = from === undefined ? undefined : ((await storedEventOf(tx, key.accountId, head.calendarId, from.eventId)) ?? null);
      // A series' end found at the provider is this write's own only where an earlier attempt of it may have made it (it was
      // claimed before) and no other write may have: never on a write's first attempt.
      const act = payload.act;
      const endsAt = "scope" in act && act.scope.kind === "following" ? act.scope.at : null;
      const mayBeDone = endsAt !== null && head.attempts > 0 && head.eventId !== null
        && !(await anotherMayHaveEnded(tx, key.accountId, { id: head.id, eventId: head.eventId }, endsAt));
      return {
        kind: "claimed",
        write: { ...write, attempts: claimedRow.attempts, calendarAccess: head.calendarAccess, createdAt: head.createdAt,
          provisional: event !== undefined && event.providerId === `pending:${head.id}`,
          series: event !== undefined && writeRowOf(event) === "series" },
        payload, to, organizer, own, owners, second, source, exception, mayBeDone, late, finalMove, key: head.key, firstKey: first?.key ?? null,
        firstEnded: first !== undefined && first.state === "applied" ? endedDayOf(first.payload) : null,
        place: proofPlaceOf(input.provider.reader.provider, held.serverUrl),
        event: event === undefined ? null : { ...event, ownInvitee },
      };
    }
    return { kind: "busy" };
  });
  return done === "gone" ? { kind: "gone" } : done;
}

/**
 * Did a press of the queue give days of this event's series a series of their own after `head` was recorded: an applied change of
 * the event that keeps the day it ended the series at (`appliedPayloadOf`), closed after it? `o.lettingGo`: or were its days from a
 * day on let go since (an applied removal that keeps that day): any end of the queue's. `o.day`: asked of one day, only a press
 * that ended the series at or before that day took it along (a day whose key tells no moment is taken for one it took).
 */
async function endedSince(
  tx: Tx, accountId: string, head: { readonly id: string; readonly eventId: string; readonly createdAt: Date },
  o: { readonly day?: string; readonly lettingGo?: boolean } = {},
): Promise<boolean> {
  const ends = await tx.select({ op: calWrites.op, payload: calWrites.payload, updatedAt: calWrites.updatedAt }).from(calWrites).where(and(
    eq(calWrites.accountId, accountId), eq(calWrites.eventId, head.eventId), eq(calWrites.state, "applied"), sql`${calWrites.id} <> ${head.id}`,
  ));
  return ends.some((e) => {
    const ended = endedDayOf(e.payload);
    if (ended === null || e.updatedAt.getTime() <= head.createdAt.getTime() || (e.op !== "update" && o.lettingGo !== true)) return false;
    return o.day === undefined || !/^\d{1,16}$/.test(o.day) || Number(ended) <= Number(o.day);
  });
}

/**
 * Does the second part of a press made from this series stand refused: refused itself (its first part, done, ended the series), or
 * with its first part where that one was refused, whatever its word (the press's days are then still this series')? Only a second
 * part refused for its own copy bars nothing: its first part is done, its days are not this series' any more, and it is never
 * sent again.
 */
async function secondPartRefused(tx: Tx, accountId: string, eventId: string): Promise<boolean> {
  const refused = await tx.select({ refusal: calWrites.refusal, payload: calWrites.payload }).from(calWrites)
    .where(and(eq(calWrites.accountId, accountId), eq(calWrites.state, "refused")));
  return refused.some((r) => {
    const part = parseWritePayload(r.payload)?.part;
    return part?.n === 2 && part.from?.eventId === eventId && r.refusal !== "version_stale";
  });
}

/**
 * Could a series' end found at the provider be another write's of the queue, not this one's? Where
 * another write of the same event ended the series at that very day itself (its applied row keeps
 * that day, `appliedPayloadOf`), or where another press on that day is owed with an attempt counted
 * (it was claimed, and may be under way or have landed unheard: its own next attempt finds the end).
 * A refused press bars nothing, whatever its word: it stays refused for good, and the day an applied
 * row keeps already stops every double, since whichever press takes the end bars the rest by its row
 * (the third recheck's first finding). A write that ended nothing there (a day cancelled, found done,
 * a title) made no end; a press never claimed never reached the server.
 */
async function anotherMayHaveEnded(tx: Tx, accountId: string, head: { readonly id: string; readonly eventId: string }, at: string): Promise<boolean> {
  const others = await tx.select({ state: calWrites.state, refusal: calWrites.refusal, attempts: calWrites.attempts, payload: calWrites.payload })
    .from(calWrites).where(and(eq(calWrites.accountId, accountId), eq(calWrites.eventId, head.eventId), sql`${calWrites.id} <> ${head.id}`));
  return others.some((o) => {
    if (o.state === "applied") return endedDayOf(o.payload) === at;
    if (o.state !== "pending" || o.attempts <= 0) return false;
    const act = parseWritePayload(o.payload)?.act;
    return act !== undefined && "scope" in act && act.scope.kind === "following" && act.scope.at === at;
  });
}

/**
 * An event of this account's calendar as a write reads it, with its series' changed days counted
 * (the rows of its UID in its calendar that each replace one of its days); `undefined` where the
 * store holds none.
 */
async function storedEventOf(
  tx: Tx, accountId: string, calendarId: string, eventId: string, readDeleteGuests = false,
): Promise<StoredEvent | undefined> {
  const query = tx.select({
    providerId: calEvents.providerId, original: calEvents.original, portableCopy: calEvents.portableCopy, partial: calEvents.partial, uid: calEvents.uid, versionTag: calEvents.versionTag,
    updatedAt: calEvents.updatedAt, status: calEvents.status, thisAndFuture: calEvents.thisAndFuture,
    organizer: calEvents.organizer, myAnswer: calEvents.myAnswer,
    repeatRule: calEvents.repeatRule, recurrenceId: calEvents.recurrenceId, addedDates: calEvents.addedDates, excludedDates: calEvents.excludedDates,
    startKind: calEvents.startKind, startLocal: calEvents.startLocal, startZone: calEvents.startZone,
    endKind: calEvents.endKind, endLocal: calEvents.endLocal, endZone: calEvents.endZone,
  }).from(calEvents).where(and(eq(calEvents.id, eventId), eq(calEvents.accountId, accountId), eq(calEvents.calendarId, calendarId))).limit(1);
  const [held] = await (readDeleteGuests ? dialect(tx).forUpdate(query, { mode: "update" }) : query);
  if (held === undefined) return undefined;
  // What the store keeps no field of is read off the stored text, as the door reads it.
  const event = { ...held, ...storedObjectFacts(held.original, held.organizer) };
  const [changed] = writeRowOf(event) !== "series" ? [] : await tx.select({ n: sql<number>`count(*)::int` }).from(calEvents).where(and(
    eq(calEvents.accountId, accountId), eq(calEvents.calendarId, calendarId), eq(calEvents.uid, event.uid), sql`${calEvents.recurrenceId} <> ''`,
  ));
  const deleteGuests = readDeleteGuests && !held.partial
    ? await tx.select({ address: calAttendees.address, name: calAttendees.name }).from(calAttendees)
      .where(and(eq(calAttendees.accountId, accountId), eq(calAttendees.eventId, eventId)))
    : undefined;
  return { ...event, changedDays: changedDaysOf(event, Number(changed?.n ?? 0)), ownInvitee: null, deleteGuests };
}

/** The named exception is from the same account, calendar and series. Provider writes still use its recorded tag. */
async function reviewedExceptionOf(
  tx: Tx, accountId: string, calendarId: string, payload: CalendarWritePayload,
  master: StoredEvent | undefined, owners: ReadonlySet<string>, first: boolean,
): Promise<NonNullable<WriteTarget["exception"]> | "stale"> {
  const { act, exception } = payload;
  if (!exception || !master || (act.kind !== "calendar_event_update" && act.kind !== "calendar_event_answer") || writeRowOf(master) !== "series") return "stale";
  const occurrence = timeOfKey(exception.occurrence);
  if (!occurrence) return "stale";
  const paired = exceptionBaseOf(act.base);
  if (act.scope.kind !== "occurrence" && paired === null) return "stale";
  const selected = await storedEventOf(tx, accountId, calendarId, exception.id);
  if (!selected && first) return "stale";
  if (selected && (selected.uid !== master.uid || selected.recurrenceId !== exception.occurrence ||
    selected.providerId !== exception.providerId || selected.partial || selected.thisAndFuture ||
    selected.status === "cancelled" ||
    (act.kind === "calendar_event_answer"
      ? !someoneElses(selected, owners) || selected.organizer !== master.organizer || selected.myAnswer === null
      : someoneElses(selected, owners)))) return "stale";
  if (first && (selected?.updatedAt?.getTime() !== Date.parse(paired?.[0] ?? act.base) ||
    selected?.versionTag !== exception.version ||
    (paired && master.updatedAt?.getTime() !== Date.parse(paired[1])))) return "stale";
  return { id: exception.providerId, version: exception.version, occurrence };
}

/** The writer's call, made with no transaction open; a throw out of a writer is this program's fault and is answered `unknown`. */
async function carryOut(
  deps: WriteDrainDeps, input: CalendarWriteDrainInput, word: ProviderWord, claim: Extract<Claim, { kind: "claimed" }>,
): Promise<Outcome> {
  const refused = (reason: WriteWord): Outcome => ({ ok: false, reason, retryAfterMs: null } as Outcome);
  const writer = input.provider.writer;
  const writable = claim.write.calendarAccess === "owner" || claim.write.calendarAccess === "writer";
  const progress = claim.payload.transfer?.progress;
  if (writer === null) return claim.finalMove ? moveRefusal("move_unresolved") : progress ? retryTransfer : refused("unsupported");
  if (!writable && !progress) return refused("read_only");
  const part = claim.payload.part;
  // A press's parts go only as the door records them: no part of a press is sent out of its press (a change of a day and the days
  // after it without its second part, their removal with one, a second part after another than its own first).
  if (claim.second === "unreadable") return refused("content_refused");
  if (!pressShaped({ act: claim.payload.act, part, key: claim.key, firstKey: claim.firstKey, second: claim.second !== null, firstEnded: claim.firstEnded })) return refused("content_refused");
  // A press's second part comes from its series: one that does not say where from would be made of the act's fields alone, and is not sent.
  if (part?.n === 2 && claim.payload.act.kind === "calendar_event_create" && (part.from === undefined || claim.source === undefined)) return refused("content_refused");
  const second = claim.second;
  if (claim.payload.transfer) {
    try {
      return await carryTransfer(deps, input, claim, writable);
    } catch {
      return claim.finalMove ? moveRefusal("move_unresolved") : retryTransfer;
    }
  }
  if (claim.exception === "stale") return refused("version_stale");
  const submitted = claim.payload.act;
  const paired = submitted.kind === "calendar_event_create" ? null : exceptionBaseOf(submitted.base);
  if ((!claim.exception && (paired || submitted.eventId !== claim.write.eventId)) ||
    (claim.exception && (!claim.write.eventId || submitted.kind !== "calendar_event_update"))) return refused("content_refused");
  const act = claim.exception && submitted.kind === "calendar_event_update" && claim.write.eventId
    ? { ...submitted, eventId: claim.write.eventId, base: paired?.[1] ?? claim.event?.updatedAt?.toISOString() ?? submitted.base }
    : submitted;
  const call = writeCallOf({
    place: claim.place, act, event: claim.event, base: claim.write.baseVersionTag, organizer: claim.organizer, owners: claim.owners, to: claim.to,
    zones: deps.zones, now: deps.clock.now(), proven: deps.proven,
    cancellationAttempted: claim.write.attempts > 1 || claim.payload.cancellationAttempted === true,
    firstAttempt: claim.write.attempts === 1 && !claim.payload.exception?.masterReceipt,
    confirmedFollowing: second?.payload.part?.from?.confirmed,
    exception: claim.exception,
    seriesCancellation: claim.payload.seriesCancellation,
    ...(part?.from === undefined || claim.source === undefined ? {} : { continuation: { from: part.from, source: claim.source } }),
  });
  if (call.kind === "refuse") return refused(call.reason);
  // What the second part will ask, carried by the first: the writer makes the new series from the copy it ends before it sends
  // anything, so that nothing is sent of a press that cannot be finished.
  let then: SeriesContinuation | null = null;
  if (second !== null) {
    const from = second.payload.part?.from;
    if (from === undefined) return refused("content_refused");
    const after = writeCallOf({
      place: claim.place, act: second.payload.act, event: null, base: null, organizer: claim.organizer, owners: claim.owners, to: null, zones: deps.zones,
      now: deps.clock.now(), proven: deps.proven,
      continuation: { from, source: claim.event },
    });
    if (after.kind === "refuse") return refused(after.reason);
    if (after.kind !== "continue") return refused("content_refused");
    // The second part is the series the press makes of the series it was made on: its start, its end, its repeat (an end on a day
    // moved with a new time). Where the store holds another copy now (this press's own end, taken in after its answer was lost, or
    // someone else's), the first part's own precondition decides, and the second goes only where the first is found done.
    if (act.kind !== "calendar_event_update" || !secondPartIsThePress(act, second.payload)) return refused("content_refused");
    if (claim.event !== null && claim.event.versionTag === claim.write.baseVersionTag && !secondPartHolds(claim.event, act, second.payload, deps.zones)) {
      return refused("content_refused");
    }
    then = { key: { hex: second.id.replaceAll("-", "") }, start: after.start, end: after.end, rule: after.rule, change: after.change,
      event: after.event, requireExisting: after.requireExisting,
      ...(after.requireExisting && { createdAtMs: second.createdAt.getTime() }),
      ...((word === "google" || word === "microsoft") && after.requireExisting && {
        createdVersion: second.createdVersion ?? undefined,
        rememberCreatedVersion: async (version: string | null) => {
          const saved = await inConnection(input.db, input.key, async ({ tx }) => {
            const [holding] = await dialect(tx).forUpdate(tx.select({ id: calWrites.id }).from(calWrites).where(and(
              eq(calWrites.accountId, input.key.accountId), eq(calWrites.id, claim.write.id),
              eq(calWrites.state, "pending"), eq(calWrites.attempts, claim.write.attempts),
            )).limit(1), { mode: "update" });
            if (!holding) return false;
            const [updated] = await tx.update(calWrites).set({ baseVersionTag: version }).where(and(
              eq(calWrites.accountId, input.key.accountId), eq(calWrites.calendarId, claim.write.calendarId),
              eq(calWrites.id, second.id), eq(calWrites.state, "pending"),
            )).returning({ id: calWrites.id });
            return updated !== undefined;
          });
          if (saved !== true) throw new Error("the continuation is no longer queued");
        },
      }) };
  }
  const cal = { id: claim.write.calendarProviderId };
  const exceptionEdit = (word === "google" || word === "microsoft") &&
    claim.exception && act.kind === "calendar_event_update" && act.scope.kind === "record";
  const saveMasterReceipt: NonNullable<WriteTarget["rememberMasterReceipt"]> = async (receipt) => {
    const saved = await inConnection(input.db, input.key, async ({ tx }) => {
      const [updated] = await tx.update(calWrites).set({
        payload: sql`jsonb_set(${calWrites.payload}, '{exception,masterReceipt}', ${JSON.stringify(receipt)}::jsonb)`,
      }).where(and(eq(calWrites.id, claim.write.id), eq(calWrites.accountId, input.key.accountId),
        eq(calWrites.calendarId, claim.write.calendarId), eq(calWrites.attempts, claim.write.attempts), eq(calWrites.state, "pending"),
        sql`${calWrites.payload}->'exception' is not null`,
        sql`coalesce(${calWrites.payload}->'exception'->'masterReceipt', ${JSON.stringify(receipt)}::jsonb) = ${JSON.stringify(receipt)}::jsonb`,
      )).returning({ id: calWrites.id });
      return updated !== undefined;
    });
    if (saved !== true) throw new Error("the master edit is no longer queued");
  };
  try {
    switch (call.kind) {
      case "create": return await writer.create(input.connection, cal, { key: { hex: claim.write.id.replaceAll("-", "") }, event: call.draft }, input.signal);
      case "change": return await writer.change(input.connection, cal, call.target.recurringSeries ?
        { ...call.target, writeKey: { hex: claim.write.id.replaceAll("-", "") },
          ...(exceptionEdit && { masterReceipt: claim.payload.exception?.masterReceipt, rememberMasterReceipt: saveMasterReceipt }),
        } : call.target, call.change, input.signal);
      case "remove": return await writer.remove(input.connection, cal, call.target, input.signal);
      case "answer": return await writer.answer(input.connection, cal, call.target, { as: call.as, reply: call.reply, ...(claim.write.attempts > 1 && { retry: true }) }, input.signal);
      case "move": return writer.moveEvent === null ? refused("unsupported") : await writer.moveEvent(input.connection, cal, { id: call.to }, { ...call.target, ...(claim.write.attempts > 1 && { retryMove: true }) }, input.signal);
      case "end": return await writer.endSeries(input.connection, cal, call.target, { then, mayBeDone: claim.mayBeDone, late: claim.late }, input.signal);
      case "continue": return await writer.continueSeries(input.connection, cal, {
        key: { hex: claim.write.id.replaceAll("-", "") }, from: call.from, start: call.start, end: call.end, rule: call.rule,
        change: call.change, event: call.event, requireExisting: call.requireExisting,
        ...(call.requireExisting && {
          createdAtMs: claim.write.createdAt?.getTime(),
          ...((word === "google" || word === "microsoft") && { createdVersion: claim.write.baseVersionTag ?? undefined }),
        }),
      }, input.signal);
    }
  } catch {
    return { ok: false, reason: "unknown", retryAfterMs: null };
  }
}

async function carryTransfer(
  deps: WriteDrainDeps, input: CalendarWriteDrainInput, claim: Extract<Claim, { kind: "claimed" }>, sourceWritable: boolean,
): Promise<Outcome> {
  const { write, payload } = claim;
  const transfer = payload.transfer!;
  if (!write.toCalendarId || !write.baseVersionTag || !input.provider.writer) return moveRefusal("move_unresolved");
  if (!transfer.progress && (!claim.event || payload.act.kind !== "calendar_event_move" || payload.act.eventId !== write.eventId ||
      claim.event.versionTag !== write.baseVersionTag ||
      claim.event.partial || claim.event.providerId !== transfer.source || someoneElses(claim.event, claim.owners))) {
    return { ok: false, reason: "version_stale", retryAfterMs: null };
  }
  const destination = await input.moveDestination?.(write.toCalendarId) ?? null;
  const remember = async (progress: CalendarTransferProgress) => {
    const saved = await inConnection(input.db, input.key, async ({ tx }) => {
      const [row] = await tx.update(calWrites).set({
        payload: { ...payload, transfer: { ...transfer, progress } },
      }).where(and(eq(calWrites.accountId, input.key.accountId), eq(calWrites.id, write.id),
        eq(calWrites.attempts, write.attempts), eq(calWrites.state, "pending"))).returning({ id: calWrites.id });
      return row !== undefined;
    });
    return saved === true;
  };
  return transferPersonalEvent({
    source: { writer: input.provider.writer, connection: input.connection, cal: { id: write.calendarProviderId } },
    destination, transfer, originalVersion: write.baseVersionTag,
    sourceWritable: sourceWritable && (input.provider.writer.provider !== "microsoft" || claim.event?.portableCopy === true), final: claim.finalMove,
    key: { hex: write.id.replaceAll("-", "") }, zones: deps.zones, signal: input.signal, remember,
  });
}

/**
 * The write's end, as its answer has it. `"next"`: the drain goes on; `"stop"`: it ends for the
 * turn; a number: it ends, and the connection is owed its next turn then.
 */
async function settle(
  ctx: SettleContext, claim: Extract<Claim, { kind: "claimed" }>, answer: Outcome, tally: Tally, aborted: boolean,
): Promise<"next" | "stop" | number> {
  const w = claim.write;
  if ("moveRefusal" in answer || (claim.finalMove && ("pending" in answer || !answer.ok))) {
    const word = "moveRefusal" in answer ? answer.moveRefusal : "expired";
    tally.refused += 1;
    tally.reason = word;
    return (await settleRefused(ctx, w, word)) === "gone" ? "stop" : "next";
  }
  if ("pending" in answer) {
    const due = await settleLater(ctx, w, writeWait(w.attempts, null));
    return due === "gone" ? "stop" : due.getTime();
  }
  if (answer.ok) {
    const done = await settleApplied(ctx, w, answer.items, claim.event?.providerId ?? null, answer.written === true);
    if (done === "gone") return "stop";
    tally.applied += 1;
    tally.unkept += done.unkept;
    return "next";
  }
  // A series' end too old to send, looked at and not found its own: expired, nothing sent.
  if (claim.late && answer.reason === "version_stale") {
    tally.expired += 1;
    tally.reason = "expired";
    return (await settleRefused(ctx, w, "expired")) === "gone" ? "stop" : "next";
  }
  // The act itself is no shape this version writes: refused at once, nothing was sent.
  if (answer.reason === "content_refused") {
    tally.refused += 1;
    tally.reason = answer.reason;
    return (await settleRefused(ctx, w, "content_refused")) === "gone" ? "stop" : "next";
  }
  const word = asWriteRefusal(answer.reason);
  tally.reason = word;
  // The worker stopping, or the turn out of time: the attempt was the turn's, not the write's; but it is never given back to zero,
  // of any write: its request may have been carried out as the turn ended (the fourth recheck's finding of a day's cancel so cut).
  if (aborted && word === "timeout") {
    await settleGivenBack(ctx, w, true);
    return "stop";
  }
  const plan = Object.hasOwn(WORD_PLAN, word) ? WORD_PLAN[word as keyof typeof WORD_PLAN] : null;
  if (plan === "reconnect") {
    await settleGivenBack(ctx, w);
    return "stop";
  }
  if (plan === "retry") {
    // A wait the provider named is the connection's, not this write's alone: nothing more of it is asked before it passes.
    if (answer.retryAfterMs !== null && answer.retryAfterMs > 0) tally.wait = { word: word as CalendarSyncFault, retryAfterMs: answer.retryAfterMs };
    if (w.attempts >= WRITE_MAX_ATTEMPTS) {
      tally.refused += 1;
      await settleRefused(ctx, w, word);
      return "stop";
    }
    const at = await settleLater(ctx, w, writeWait(w.attempts, answer.retryAfterMs));
    return at === "gone" ? "stop" : at.getTime();
  }
  tally.refused += 1;
  return (await settleRefused(ctx, w, word)) === "gone" ? "stop" : "next";
}


/**
 * Applied rows past the days their keys are kept for, and refused rows whose event the store no
 * longer holds (no record carries their mark, so nobody could let them go, and the door's bound
 * would count them for good): each at most a bound a turn. An applied row that an owed or refused
 * write still names as the one it waits for (`after`: a press's first part, its second still to be
 * made) is kept while it does: its second part asks it (the second recheck's second finding). And
 * an applied row that keeps the day it ended a series at (a press's first part, or the letting go
 * of the days from a day on) is kept while a write of the same event, recorded before that row was
 * closed, stands owed or refused: that write's claim asks it, and tried again without it would take
 * this end for its own (the sixth recheck's finding of the cleanup after seven days).
 */
async function prune(input: CalendarWriteDrainInput): Promise<void> {
  await inConnection(input.db, input.key, async ({ tx }) => {
    const own = and(eq(calWrites.accountId, input.key.accountId), eq(calCalendars.connectionId, input.key.id));
    const onCalendar = and(eq(calCalendars.id, calWrites.calendarId), eq(calCalendars.accountId, calWrites.accountId));
    const named = (await tx.select({ after: sql<string | null>`${calWrites.payload}->>'after'` }).from(calWrites)
      .where(and(eq(calWrites.accountId, input.key.accountId), inArray(calWrites.state, ["pending", "refused"]))))
      .flatMap((r) => (r.after === null ? [] : [r.after]))
      .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id));
    const old = await tx.select({ id: calWrites.id }).from(calWrites)
      .innerJoin(calCalendars, onCalendar)
      .where(and(
        own, eq(calWrites.state, "applied"), sql`${calWrites.updatedAt} < now() - make_interval(secs => ${WRITE_APPLIED_KEPT_MS / 1000})`,
        ...(named.length === 0 ? [] : [notInArray(calWrites.id, named)]),
        sql`not (${calWrites.payload} ->> 'ended' is not null and exists (select 1 from cal_writes o where o.account_id = ${calWrites.accountId} and o.event_id = ${calWrites.eventId} and o.state in ('pending', 'refused') and o.created_at < ${calWrites.updatedAt}))`,
      ))
      .limit(WRITE_PRUNE_PER_TURN);
    const unseen = await tx.select({ id: calWrites.id }).from(calWrites)
      .innerJoin(calCalendars, onCalendar)
      .leftJoin(calEvents, and(eq(calEvents.id, calWrites.eventId), eq(calEvents.accountId, calWrites.accountId)))
      .where(and(own, eq(calWrites.state, "refused"), isNull(calEvents.id)))
      .limit(WRITE_PRUNE_PER_TURN);
    const ids = [...old, ...unseen].map((r) => r.id);
    if (ids.length > 0) await tx.delete(calWrites).where(and(eq(calWrites.accountId, input.key.accountId), inArray(calWrites.id, ids)));
  });
}
