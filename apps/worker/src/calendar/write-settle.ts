/**
 * WHERE A WRITE ENDS: one transaction for what the provider answered and for the row's own state.
 * The provider's object comes in through the reading's own planner and apply, so the store and the
 * provider meet through one mapper; the row is closed in the same transaction, by its id, its
 * account and the attempt that claimed it, and a close that finds no such row is a fault, never a
 * quiet nothing.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { ChangeItem, ProviderWord } from "@ohmail/cal-providers";
import { calCalendars, calEvents, calWrites, recordCalendarChanges, type CalendarChange, type LedgerTx, type Tx } from "@trafficflow/db";
import { parseWritePayload } from "@trafficflow/db/calendar";
import {
  ObjectRefused, applyChunk, applyChunks, chunksOf, objectWrite, planItems, type ApplyContext, type Work,
} from "./apply.js";
import { inConnection, type ConnectionDb, type ConnectionKey } from "./connection.js";
import { rowsOfObject, type MapContext, type Upsert } from "./map.js";
import type { WriteWord } from "./write-request.js";

/** A write as its claim found it: what closing it needs. */
export interface ClaimedWrite {
  readonly id: string;
  readonly attempts: number;
  readonly op: string;
  readonly calendarId: string;
  readonly calendarProviderId: string;
  readonly eventId: string | null;
  readonly baseVersionTag: string | null;
  /** The stored event is still the one the write stood in for (a new event not yet named by the provider). */
  readonly provisional: boolean;
  readonly toCalendarId: string | null;
}

export interface SettleContext {
  readonly db: ConnectionDb;
  readonly key: ConnectionKey;
  readonly word: ProviderWord;
  readonly map: MapContext;
}

/** The closing statement's guard: this row, this account, the attempt that claimed it, still owed. */
const claimed = (w: ClaimedWrite, accountId: string) => and(
  eq(calWrites.id, w.id), eq(calWrites.accountId, accountId), eq(calWrites.attempts, w.attempts), eq(calWrites.state, "pending"),
);

/** Exactly one row, or a fault of this program (a statement no policy admits changes no row, and says nothing). */
function one(rows: readonly unknown[], what: string): void {
  if (rows.length !== 1) throw new Error(`a calendar write's ${what} changed ${rows.length} rows, not one`);
}

/** The writes that wait for `head`, directly or through another: they were made on what it would write. */
async function followersOf(tx: Tx, accountId: string, eventId: string | null, headId: string): Promise<string[]> {
  if (eventId === null) return [];
  const open = await tx.select({ id: calWrites.id, payload: calWrites.payload }).from(calWrites)
    .where(and(eq(calWrites.accountId, accountId), eq(calWrites.eventId, eventId), eq(calWrites.state, "pending")));
  const chain = new Set([headId]);
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
  chain.delete(headId);
  return [...chain];
}

const eventChange = (changes: CalendarChange[], eventId: string | null): void => {
  if (eventId !== null && !changes.some((c) => c.id === eventId)) changes.push({ kind: "calendar_event", id: eventId, op: "update" });
};

/** A row refused with its word, and the rows that waited for it refused with it, in the caller's transaction. */
export async function refuseInTx(tx: Tx, accountId: string, w: ClaimedWrite, word: WriteWord | "expired", changes: CalendarChange[]): Promise<void> {
  one(await tx.update(calWrites).set({ state: "refused", refusal: word, nextAttemptAt: null, updatedAt: sql`now()` })
    .where(claimed(w, accountId)).returning({ id: calWrites.id }), "refusal");
  const followers = await followersOf(tx, accountId, w.eventId, w.id);
  if (followers.length > 0) {
    await tx.update(calWrites).set({ state: "refused", refusal: "earlier_refused", nextAttemptAt: null, updatedAt: sql`now()` })
      .where(and(eq(calWrites.accountId, accountId), inArray(calWrites.id, followers), eq(calWrites.state, "pending")));
  }
  eventChange(changes, w.eventId);
}

/**
 * The provider refused the write for what it is: the row is refused with its word, and so is what
 * waited for it. A version the provider moved past makes the calendar due, so its copy is read again.
 */
export async function settleRefused(ctx: SettleContext, w: ClaimedWrite, word: WriteWord): Promise<"gone" | void> {
  const done = await inConnection(ctx.db, ctx.key, async ({ tx }) => {
    const changes: CalendarChange[] = [];
    await refuseInTx(tx, ctx.key.accountId, w, word, changes);
    if (word === "version_stale") {
      await tx.update(calCalendars).set({ nextPollAt: sql`now()` })
        .where(and(eq(calCalendars.id, w.calendarId), eq(calCalendars.accountId, ctx.key.accountId)));
    }
    await recordCalendarChanges(tx as unknown as LedgerTx, ctx.key.accountId, changes);
  });
  return done === "gone" ? "gone" : undefined;
}

/** The write waits: owed again at `waitMs` from now, the attempt kept. */
export async function settleLater(ctx: SettleContext, w: ClaimedWrite, waitMs: number): Promise<Date | "gone"> {
  const done = await inConnection(ctx.db, ctx.key, async ({ tx }) => {
    const [row] = await tx.update(calWrites)
      .set({ nextAttemptAt: sql`now() + make_interval(secs => ${Math.ceil(waitMs / 1000)})`, updatedAt: sql`now()` })
      .where(claimed(w, ctx.key.accountId)).returning({ at: calWrites.nextAttemptAt });
    one(row === undefined ? [] : [row], "wait");
    return row!.at!;
  });
  return done;
}

/** The attempt was not the write's: it is given back, and the write is owed at once again. */
export async function settleGivenBack(ctx: SettleContext, w: ClaimedWrite): Promise<"gone" | void> {
  const done = await inConnection(ctx.db, ctx.key, async ({ tx }) => {
    one(await tx.update(calWrites).set({ attempts: sql`${calWrites.attempts} - 1`, nextAttemptAt: null, updatedAt: sql`now()` })
      .where(claimed(w, ctx.key.accountId)).returning({ id: calWrites.id }), "give-back");
  });
  return done === "gone" ? "gone" : undefined;
}

/** The provider's version of the object as its answer names it, for the writes that wait behind this one. */
function versionIn(items: readonly ChangeItem[], providerId: string | null): string | null {
  const ups = items.filter((i): i is Upsert => i.kind === "upsert");
  const own = ups.find((u) => u.id === providerId && u.event.recurrenceId === null) ?? ups.find((u) => u.event.recurrenceId === null) ?? ups[0];
  return own === undefined || own.version === "" ? null : own.version;
}

/**
 * The provider took the write: its answer goes into the store through the reading's planner, the
 * row is closed as applied with nothing of the act kept, the event's row is stamped in the same
 * transaction (one `now()` for both, which the door's `after` rule reads), and the writes that
 * waited on the old version take the new one.
 */
export async function settleApplied(
  ctx: SettleContext, w: ClaimedWrite, items: readonly ChangeItem[], targetProviderId: string | null,
): Promise<{ readonly changed: number; readonly unkept: number } | "gone"> {
  const apply: ApplyContext = {
    db: ctx.db, key: ctx.key, calendar: { id: w.calendarId, providerId: w.calendarProviderId }, zones: ctx.map.zones,
    unite: ctx.word === "google" || ctx.word === "microsoft", shown: null, halted: () => false,
  };
  let works: readonly Work[] = [];
  let unkept = 0;
  let named = targetProviderId;
  if (w.op === "move") {
    // The provider moved the object: both calendars are read at once, and the readings carry it across.
  } else if (w.provisional && w.eventId !== null) {
    const ups = items.filter((i): i is Upsert => i.kind === "upsert");
    const id = ups[0]?.id ?? null;
    const uid = ups.find((u) => u.event.recurrenceId === null)?.event.uid ?? ups[0]?.event.uid ?? null;
    if (id !== null && uid !== null) {
      named = id;
      const mapped = rowsOfObject(ups.filter((u) => u.id === id), ctx.map);
      works = [
        { kind: "repoint", eventId: w.eventId, providerId: id, uid, changes: 2 },
        ...(mapped.ok ? [objectWrite(id, mapped.rows, [], apply.unite)] : []),
      ];
      if (!mapped.ok) unkept += 1;
    }
  } else {
    const plan = await planItems(apply, items, ctx.map);
    if (plan === "gone") return "gone";
    works = plan.works;
    unkept += plan.unkept;
  }
  const version = versionIn(items, named);
  const close = async (tx: Tx, changes: CalendarChange[]): Promise<void> => {
    one(await tx.update(calWrites).set({ state: "applied", refusal: null, payload: {}, nextAttemptAt: null, updatedAt: sql`now()` })
      .where(claimed(w, ctx.key.accountId)).returning({ id: calWrites.id }), "close");
    if (w.eventId === null) return;
    if (version !== null) {
      await tx.update(calWrites).set({ baseVersionTag: version, updatedAt: sql`now()` }).where(and(
        eq(calWrites.accountId, ctx.key.accountId), eq(calWrites.eventId, w.eventId), eq(calWrites.state, "pending"),
        sql`${calWrites.id} <> ${w.id}`, sql`${calWrites.baseVersionTag} is not distinct from ${w.provisional ? null : w.baseVersionTag}`,
      ));
    }
    const stamped = await tx.update(calEvents).set({ updatedAt: sql`now()` })
      .where(and(eq(calEvents.id, w.eventId), eq(calEvents.accountId, ctx.key.accountId))).returning({ id: calEvents.id });
    if (stamped.length > 0) eventChange(changes, w.eventId);
    if (w.op === "move") {
      await tx.update(calCalendars).set({ nextPollAt: sql`now()` }).where(and(
        eq(calCalendars.accountId, ctx.key.accountId), inArray(calCalendars.id, [w.calendarId, ...(w.toCalendarId === null ? [] : [w.toCalendarId])]),
      ));
    }
  };
  // An object past one transaction's bound is written in parts first; the close rides the last part.
  const chunks = chunksOf(works);
  const head = chunks.slice(0, -1);
  if (head.length > 0) {
    const done = await applyChunks(apply, head);
    if (!done.ok) return "gone";
  }
  try {
    const done = await applyChunk(apply, chunks.at(-1) ?? [], close);
    if (!done.ok) return "gone";
    return { changed: done.changed, unkept };
  } catch (err) {
    if (!(err instanceof ObjectRefused)) throw err;
    // The provider holds the write and the store cannot hold its answer: the write is done all the same.
    const done = await applyChunk(apply, [], close);
    if (!done.ok) return "gone";
    return { changed: done.changed, unkept: unkept + 1 };
  }
}
