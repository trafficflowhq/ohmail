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
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ZoneSource } from "@ohmail/cal-core";
import { asWriteRefusal, type Clock, type ProviderWord, type RepeatShape, type WriteAnswer } from "@ohmail/cal-providers";
import type { Logger } from "@trafficflow/core";
import { calAttendees, calCalendars, calEvents, calWrites, recordCalendarChanges, type CalendarChange, type LedgerTx } from "@trafficflow/db";
import { parseWritePayload, type CalendarWritePayload } from "@trafficflow/db/calendar";
import { dialect } from "@trafficflow/db/dialect";
import { inConnection } from "./connection.js";
import { ownAddressesOf } from "./reading.js";
import { calendarEnabledAt } from "./state.js";
import type { CalendarWriteDrain, CalendarWriteDrainInput, CalendarWriteWait } from "./types.js";
import { TURN_MS, WORD_PLAN, type CalendarSyncFault } from "./words.js";
import { writeCallOf, type StoredEvent, type WriteWord } from "./write-request.js";
import { refuseInTx, settleApplied, settleGivenBack, settleLater, settleRefused, type ClaimedWrite, type SettleContext } from "./write-settle.js";

/** A claim's lease: a write claimed and never settled (a crash) is owed again after this. */
export const WRITE_LEASE_MS = 120_000;
/** Attempts a write is given; past them it is refused with its last word. */
export const WRITE_MAX_ATTEMPTS = 8;
/** A write older than this is never sent late: it is refused, `expired`. */
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
  /** The repeats each provider was proven to keep (the providers' own table where not said). */
  readonly proven?: Readonly<Record<ProviderWord, readonly RepeatShape[]>>;
}

/** The doubling wait of a write's `attempts`-th try, inside the floor and the ceiling, never below the provider's wish. */
export function writeWait(attempts: number, retryAfterMs: number | null): number {
  const n = Math.max(1, Math.min(attempts, 30));
  return Math.max(retryAfterMs ?? 0, Math.min(WRITE_RETRY_CEILING_MS, WRITE_RETRY_FLOOR_MS * 2 ** (n - 1)));
}

/** What a write's call came to: the writer's answer, or the queue's own refusal of an act no call can be made of. */
type Outcome = WriteAnswer | { readonly ok: false; readonly reason: "content_refused"; readonly retryAfterMs: null };

type Claim =
  | { readonly kind: "claimed"; readonly write: ClaimedWrite; readonly payload: CalendarWritePayload; readonly event: StoredEvent | null; readonly to: string | null; readonly organizer: string | null; readonly own: ReadonlySet<string> }
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
    const claim = await claimNext(input, tally);
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
async function claimNext(input: CalendarWriteDrainInput, tally: Tally): Promise<Claim> {
  const { key } = input;
  const done = await inConnection(input.db, input.key, async ({ tx, held }): Promise<Claim> => {
    if (await calendarEnabledAt(tx, key.accountId) === null) return { kind: "off" };
    for (let i = 0; i < EXPIRED_PER_CLAIM; i++) {
      const [head] = await tx.select({
        id: calWrites.id, attempts: calWrites.attempts, op: calWrites.op, calendarId: calWrites.calendarId,
        calendarProviderId: calCalendars.providerId, eventId: calWrites.eventId, baseVersionTag: calWrites.baseVersionTag,
        payload: calWrites.payload, nextAttemptAt: calWrites.nextAttemptAt,
        waiting: sql<boolean>`coalesce(${calWrites.nextAttemptAt} > now(), false)`,
        expired: sql<boolean>`${calWrites.createdAt} < now() - make_interval(secs => ${WRITE_MAX_AGE_MS / 1000}) or ${calWrites.attempts} >= ${WRITE_MAX_ATTEMPTS}`,
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
      const write: ClaimedWrite = {
        id: head.id, attempts: head.attempts, op: head.op, calendarId: head.calendarId, calendarProviderId: head.calendarProviderId,
        eventId: head.eventId, baseVersionTag: head.baseVersionTag, provisional: false,
        toCalendarId: payload?.act.kind === "calendar_event_move" ? payload.act.toCalendarId : null,
      };
      if (head.expired || payload === null) {
        const changes: CalendarChange[] = [];
        await refuseInTx(tx, key.accountId, write, payload === null ? "content_refused" : "expired", changes);
        await recordCalendarChanges(tx as unknown as LedgerTx, key.accountId, changes);
        if (payload === null) tally.refused += 1;
        else tally.expired += 1;
        continue;
      }
      const [event] = head.eventId === null ? [] : await tx.select({
        providerId: calEvents.providerId, original: calEvents.original,
        repeatRule: calEvents.repeatRule, recurrenceId: calEvents.recurrenceId, addedDates: calEvents.addedDates,
      }).from(calEvents).where(and(eq(calEvents.id, head.eventId), eq(calEvents.accountId, key.accountId), eq(calEvents.calendarId, head.calendarId))).limit(1);
      if (event === undefined && head.op !== "create") {
        // Its event is gone from the store: a removal is done; anything else has nothing left to change.
        if (head.op === "delete") {
          await tx.update(calWrites).set({ state: "applied", payload: {}, nextAttemptAt: null, updatedAt: sql`now()` })
            .where(and(eq(calWrites.id, head.id), eq(calWrites.accountId, key.accountId)));
          tally.applied += 1;
        } else {
          await tx.delete(calWrites).where(and(eq(calWrites.id, head.id), eq(calWrites.accountId, key.accountId)));
          tally.orphaned += 1;
        }
        continue;
      }
      const [claimedRow] = await tx.update(calWrites).set({
        attempts: sql`${calWrites.attempts} + 1`, nextAttemptAt: sql`now() + make_interval(secs => ${WRITE_LEASE_MS / 1000})`, updatedAt: sql`now()`,
      }).where(and(eq(calWrites.id, head.id), eq(calWrites.accountId, key.accountId), eq(calWrites.attempts, head.attempts), eq(calWrites.state, "pending")))
        .returning({ attempts: calWrites.attempts });
      if (claimedRow === undefined) return { kind: "busy" };
      const own = await ownAddressesOf(tx, key.accountId, held.principal);
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
      return {
        kind: "claimed",
        write: { ...write, attempts: claimedRow.attempts, provisional: event !== undefined && event.providerId === `pending:${head.id}` },
        payload, to, organizer, own,
        event: event === undefined ? null : { ...event, ownInvitee },
      };
    }
    return { kind: "busy" };
  });
  return done === "gone" ? { kind: "gone" } : done;
}

/** The writer's call, made with no transaction open; a throw out of a writer is this program's fault and is answered `unknown`. */
async function carryOut(
  deps: WriteDrainDeps, input: CalendarWriteDrainInput, word: ProviderWord, claim: Extract<Claim, { kind: "claimed" }>,
): Promise<Outcome> {
  const refused = (reason: WriteWord): Outcome => ({ ok: false, reason, retryAfterMs: null } as Outcome);
  const writer = input.provider.writer;
  if (writer === null) return refused("unsupported");
  const call = writeCallOf({
    provider: word, act: claim.payload.act, event: claim.event, base: claim.write.baseVersionTag, organizer: claim.organizer, to: claim.to, proven: deps.proven,
  });
  if (call.kind === "refuse") return refused(call.reason);
  const cal = { id: claim.write.calendarProviderId };
  try {
    switch (call.kind) {
      case "create": return await writer.create(input.connection, cal, { key: { hex: claim.write.id.replaceAll("-", "") }, event: call.draft }, input.signal);
      case "change": return await writer.change(input.connection, cal, call.target, call.change, input.signal);
      case "remove": return await writer.remove(input.connection, cal, call.target, input.signal);
      case "answer": return await writer.answer(input.connection, cal, call.target, { as: call.as, reply: call.reply }, input.signal);
      case "move": return writer.moveEvent === null ? refused("unsupported") : await writer.moveEvent(input.connection, cal, { id: call.to }, call.target, input.signal);
    }
  } catch {
    return { ok: false, reason: "unknown", retryAfterMs: null };
  }
}

/**
 * The write's end, as its answer has it. `"next"`: the drain goes on; `"stop"`: it ends for the
 * turn; a number: it ends, and the connection is owed its next turn then.
 */
async function settle(
  ctx: SettleContext, claim: Extract<Claim, { kind: "claimed" }>, answer: Outcome, tally: Tally, aborted: boolean,
): Promise<"next" | "stop" | number> {
  const w = claim.write;
  if (answer.ok) {
    const done = await settleApplied(ctx, w, answer.items, claim.event?.providerId ?? null);
    if (done === "gone") return "stop";
    tally.applied += 1;
    tally.unkept += done.unkept;
    return "next";
  }
  // The act itself is no shape this version writes: refused at once, nothing was sent.
  if (answer.reason === "content_refused") {
    tally.refused += 1;
    tally.reason = answer.reason;
    return (await settleRefused(ctx, w, "content_refused")) === "gone" ? "stop" : "next";
  }
  const word = asWriteRefusal(answer.reason);
  tally.reason = word;
  // The worker stopping, or the turn out of time: the attempt was the turn's, not the write's.
  if (aborted && word === "timeout") {
    await settleGivenBack(ctx, w);
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
 * would count them for good): each at most a bound a turn.
 */
async function prune(input: CalendarWriteDrainInput): Promise<void> {
  await inConnection(input.db, input.key, async ({ tx }) => {
    const own = and(eq(calWrites.accountId, input.key.accountId), eq(calCalendars.connectionId, input.key.id));
    const onCalendar = and(eq(calCalendars.id, calWrites.calendarId), eq(calCalendars.accountId, calWrites.accountId));
    const old = await tx.select({ id: calWrites.id }).from(calWrites)
      .innerJoin(calCalendars, onCalendar)
      .where(and(own, eq(calWrites.state, "applied"), sql`${calWrites.updatedAt} < now() - make_interval(secs => ${WRITE_APPLIED_KEPT_MS / 1000})`))
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
