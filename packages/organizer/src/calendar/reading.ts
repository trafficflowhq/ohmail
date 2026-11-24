/**
 * ONE CALENDAR'S READING, IN PAGES. Each page is asked with no transaction open, measured against
 * what is stored, and written in its own short transactions; the reading's place (the cursor) and
 * what its pages named live in this process only. The calendar's token moves once, in the
 * reading's last transaction, after its last page and its drop, so a crash anywhere before it
 * loses nothing and the next turn reads again from the token that stands: what is equal writes nothing.
 *
 * A WHOLE reading (from no token, or a provider that keeps none) drops at its end what no page
 * named, and nothing it named in `left`; never a row written since it began, an object a person's
 * write is still owed to, or (Microsoft) one outside the window it read. A drop of most of what a
 * calendar holds waits for a second whole reading that shows the same.
 */
import { createHash } from "node:crypto";
import type { CalEvent, ZoneSource } from "@ohmail/cal-core";
import {
  MAX_MULTISTATUS_RESPONSES, MAX_PAGE_LIMIT, type CalendarProvider, type ChangeItem, type ChangePage, type ChangeToken,
  type ProviderWord,
} from "@ohmail/cal-providers";
import { and, eq, sql } from "drizzle-orm";
import { calCalendars, calConnections, mailboxes, recordCalendarChanges, type LedgerTx, type Tx } from "@trafficflow/db";
import {
  applyChunk, applyChunks, chunksOf, dayCancelled, dropCandidates, objectGone, planItems, storedRowsOf,
  type ApplyContext, type ChunkResult, type Work,
} from "./apply.js";
import type { StoredCalendar } from "./calendars.js";
import { inConnection, type ConnectionDb, type ConnectionKey } from "./connection.js";
import { occurrenceKey, type MapContext } from "./map.js";
import { connectionsKept, hasPlace, keepReading, releaseAllBut, remember } from "./memory.js";
import { cancelledDays } from "./microsoft.js";
import { dueAmong } from "./roster.js";
import type { PassSignIn } from "./sign-in.js";
import { storableKey } from "./storable.js";
import type { CalendarSyncDeps, OpenReading } from "./types.js";
import {
  faultWord, FORCED_REREAD_EVERY_MS, MASS_DROP_FLOOR, MASS_DROP_RETRY_MS, MAX_READING_PAGES, MS_WINDOW_DAYS_AHEAD,
  MS_WINDOW_DAYS_BACK, MS_WINDOW_SLIDE_DAYS, pollAfterRead, turnOverdue, type CalendarSyncFault,
} from "./words.js";

const DAY = 86_400_000;
/** Series one Microsoft reading keeps to compare; past it the reading compares nothing. */
const MAX_MASTERS_KEPT = 5_000;
/**
 * Cancelled days a reading holds for a series not stored yet. Past it a cancelled day whose series
 * comes later in the same reading is not kept: that day stays shown until the provider names it
 * again or the calendar is read whole. A day kept that was cancelled, never a day hidden that was not.
 */
const MAX_HELD_CANCELLATIONS = 10_000;

/** What one turn may still spend: pages, and a moment to end by. */
export interface TurnBudget {
  pagesLeft: number;
  readonly deadline: number;
}

export interface ReadingContext {
  readonly deps: CalendarSyncDeps;
  readonly db: ConnectionDb;
  readonly key: ConnectionKey;
  readonly word: ProviderWord;
  readonly provider: CalendarProvider;
  readonly signIn: PassSignIn;
  readonly map: MapContext;
  readonly signal: AbortSignal;
  readonly budget: TurnBudget;
}

export type ReadingResult =
  | { readonly kind: "done"; readonly pages: number; readonly changed: number; readonly dropped: number }
  /** The turn's budget ended between two pages; the reading stays open in memory. */
  | { readonly kind: "more"; readonly pages: number; readonly changed: number }
  /** The turn's budget ended and no place was free to keep the reading: the calendar stays due and begins again when one is. */
  | { readonly kind: "no_place"; readonly pages: number; readonly changed: number }
  | { readonly kind: "refused"; readonly word: CalendarSyncFault; readonly retryAfterMs: number | null; readonly pages: number; readonly changed: number; readonly continuing?: boolean }
  | { readonly kind: "gone" }
  | { readonly kind: "halted" }
  | { readonly kind: "superseded" };

/** An id as the named set keeps it: 64 bits of its digest. A collision can only spare a row, never drop one. */
export function nameOf(id: string): bigint {
  return createHash("sha256").update(id).digest().readBigUInt64BE(0);
}

/** Microsoft's window for a reading begun now: whole UTC days back and ahead of today. */
export function microsoftWindow(nowMs: number): { start: number; end: number } {
  const today = Math.floor(nowMs / DAY) * DAY;
  return { start: today - MS_WINDOW_DAYS_BACK * DAY, end: today + MS_WINDOW_DAYS_AHEAD * DAY };
}

const dayText = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** A stored day (`YYYY-MM-DD`) as its UTC midnight. */
function dayMs(text: string): number {
  const [y, m, d] = text.split("-").map(Number);
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
}

/**
 * The database's own clock, read once at a reading's start, to the millisecond below it: a row
 * written in that same millisecond reads as newer and is spared, the safe side.
 */
async function databaseNow(ctx: ReadingContext): Promise<Date | "gone"> {
  return inConnection(ctx.db, ctx.key, async ({ tx }) => {
    const [row] = await tx.select({ ms: sql<number>`floor(extract(epoch from now()) * 1000)` }).from(calConnections)
      .where(and(eq(calConnections.id, ctx.key.id), eq(calConnections.accountId, ctx.key.accountId))).limit(1);
    return new Date(Number(row!.ms));
  });
}

/**
 * Read `cal` from where it stands, page by page, until its end, the turn's budget, a refusal, or
 * the worker's stop. Goes on with the reading memory keeps for it when that began from the token
 * the row still holds.
 *
 * A reading takes one of the few places memory has for readings that outlast a turn when one is
 * free; with none free it is read all the same, and only if the turn's budget ends before it does
 * is it given up, to begin again once a place is free. A reading that holds a place is never
 * given up for another.
 */
export async function readCalendar(ctx: ReadingContext, cal: StoredCalendar): Promise<ReadingResult> {
  const { deps } = ctx;
  const memory = deps.memory;
  const ms = ctx.word === "microsoft";
  let since: string | null = cal.syncToken;
  let window: { start: number; end: number } | null = null;
  if (ms) {
    const fresh = microsoftWindow(deps.clock.now());
    const stored = cal.windowStart !== null && cal.windowEnd !== null ? { start: dayMs(cal.windowStart), end: dayMs(cal.windowEnd) + DAY } : null;
    // A window that slid too far is read anew from no token: a wider window is a new reading.
    if (stored === null || fresh.start - stored.start >= MS_WINDOW_SLIDE_DAYS * DAY || since === null) {
      window = fresh;
      since = null;
    } else {
      window = stored;
    }
  }

  let reading = memory.readings.get(cal.id);
  if (reading !== undefined && reading.since !== since) {
    memory.readings.delete(cal.id);
    reading = undefined;
  }
  // A kept reading goes on in the window it began with: the day turning under a long first reading is no new reading.
  if (reading !== undefined) window = reading.window;
  let kept = reading !== undefined;
  // Its last reading was longer than a turn and found no place: asking the same pages again would end the same way.
  if (!kept && memory.crowded.has(cal.id) && !(await placeFree(ctx))) return { kind: "no_place", pages: 0, changed: 0 };
  let fromNullAgain = false;
  let pages = 0;
  let changed = 0;
  /** The worker is stopping (a turn whose own time ran out is not: it says so). */
  const stopping = (): boolean => deps.halted() || (ctx.signal.aborted && !turnOverdue(ctx.signal));

  const begin = async (from: string | null): Promise<OpenReading | "gone"> => {
    const startedAt = await databaseNow(ctx);
    if (startedAt === "gone") return "gone";
    const r: OpenReading = {
      connectionId: ctx.key.id, since: from, cursor: null, mode: null, startedAt, named: new Set(), heldCancellations: [],
      window, seen: new Map(), masters: new Map(), pages: 0, changed: 0, unknownGone: false, noDrop: false, leftOut: false,
    };
    kept = keepReading(memory, cal.id, r);
    return r;
  };
  if (reading === undefined) {
    const r = await begin(since);
    if (r === "gone") return { kind: "gone" };
    reading = r;
  }

  /** The store's side of this reading: of the reading that stands now, since a forgotten token begins another. */
  const applyFor = (r: OpenReading): ApplyContext => ({
    db: ctx.db, key: ctx.key, calendar: { id: cal.id, providerId: cal.providerId }, zones: deps.zones,
    unite: ctx.word === "google" || ctx.word === "microsoft", shown: ms ? r.seen : null, halted: deps.halted,
  });

  for (;;) {
    if (stopping()) return { kind: "halted" };
    if (turnOverdue(ctx.signal)) {
      memory.readings.delete(cal.id);
      return { kind: "refused", word: "timeout", retryAfterMs: null, pages, changed };
    }
    if (ctx.budget.pagesLeft <= 0 || deps.clock.now() >= ctx.budget.deadline) {
      // Only now is a place needed: a reading that ended inside its turn never asked for one.
      if (!kept) kept = (await placeFree(ctx)) && keepReading(memory, cal.id, reading);
      if (!kept) {
        remember(memory.crowded, cal.id, true);
        return { kind: "no_place", pages, changed };
      }
      memory.crowded.delete(cal.id);
      return { kind: "more", pages, changed };
    }
    if (reading.pages >= MAX_READING_PAGES) {
      memory.readings.delete(cal.id);
      return { kind: "refused", word: "too_large", retryAfterMs: null, pages, changed };
    }
    const token: ChangeToken | null = reading.since === null ? null : { provider: ctx.word, value: reading.since };
    const answer = await ctx.provider.reader.readChanges(
      ctx.signIn.connection, { id: cal.providerId }, token,
      { limit: MAX_PAGE_LIMIT, cursor: reading.cursor, window: window === null ? null : { start: { kind: "instant", epochMs: window.start }, end: { kind: "instant", epochMs: window.end } } },
      ctx.signal,
    );
    ctx.budget.pagesLeft -= 1;
    pages += 1;
    // A call the stop ended answers as a late one does: that is the worker's word, not the provider's, and nothing is written for it.
    if (stopping()) return { kind: "halted" };
    if (ctx.signIn.superseded()) return { kind: "superseded" };
    if (!answer.ok) {
      memory.readings.delete(cal.id);
      // The token names no state the provider keeps: read from no token once in this turn, then wait.
      if (answer.reason === "token_gone" && !fromNullAgain && reading.since !== null) {
        fromNullAgain = true;
        since = null;
        // Forgotten on the row first, so that the next turn goes on with this reading instead of asking the dead token again.
        if (await forgetToken(ctx, cal) === "gone") return { kind: "gone" };
        if (ms) window = microsoftWindow(deps.clock.now());
        const r = await begin(null);
        if (r === "gone") return { kind: "gone" };
        reading = r;
        continue;
      }
      return { kind: "refused", word: faultWord(answer.reason), retryAfterMs: answer.retryAfterMs, pages, changed, continuing: reading.cursor !== null };
    }
    const page = answer.value;
    reading.pages += 1;
    reading.mode = page.mode;
    if (!note(reading, page, deps.zones)) {
      memory.readings.delete(cal.id);
      return { kind: "refused", word: "too_large", retryAfterMs: null, pages, changed };
    }
    if (!page.unchanged && page.items.length > 0) {
      const done = await applyPage(ctx, applyFor(reading), reading, page.items);
      if (!done.ok) return { kind: done.why };
      reading.changed += done.changed;
      changed += done.changed;
    }
    if (page.cursor.kind === "more") {
      reading.cursor = page.cursor.value;
      continue;
    }
    const end = await finishReading(ctx, applyFor(reading), cal, reading, page, page.cursor.token);
    memory.readings.delete(cal.id);
    memory.crowded.delete(cal.id);
    if (end.kind !== "done") return end;
    return { kind: "done", pages, changed: changed + end.changed, dropped: end.dropped };
  }
}

/**
 * Is there a place to keep one more reading? With every place taken, the readings whose connection
 * the roster no longer hands over are let go first: nobody goes on with those. One whose connection
 * is still due is being read, however long ago its last turn was, and is never given up.
 */
async function placeFree(ctx: ReadingContext): Promise<boolean> {
  const { memory, db, clock } = ctx.deps;
  if (hasPlace(memory)) return true;
  const read = await dueAmong(db, new Date(clock.now()), connectionsKept(memory));
  // The connection whose turn this is, is being read whatever its row says.
  releaseAllBut(memory, read.add(ctx.key.id));
  return hasPlace(memory);
}

/**
 * The token the provider no longer knows, taken off the calendar's row in a transaction of its
 * own. Bookkeeping: no change is recorded and nothing a person sees moves. From here the row says
 * what is true, "read from the beginning", to this process's next turn and to any other's.
 */
async function forgetToken(ctx: ReadingContext, cal: StoredCalendar): Promise<"gone" | void> {
  const done = await inConnection(ctx.db, ctx.key, async ({ tx }) => {
    await tx.update(calCalendars).set({ syncToken: null })
      .where(and(eq(calCalendars.id, cal.id), eq(calCalendars.accountId, ctx.key.accountId), eq(calCalendars.connectionId, ctx.key.id)));
  });
  return done === "gone" ? "gone" : undefined;
}

/** What a page named, into the reading's memory. `false`: the reading is past what it may remember. */
function note(reading: OpenReading, page: ChangePage, zones: ZoneSource): boolean {
  for (const item of page.items) {
    if (item.kind === "upsert" || item.kind === "gone") reading.named.add(nameOf(item.id));
  }
  for (const left of page.left) reading.named.add(nameOf(left.id));
  // What was left out may be a day this reading should have shown: from here its silence about a day proves nothing.
  if (page.left.length > 0) reading.leftOut = true;
  if (reading.named.size > MAX_MULTISTATUS_RESPONSES) return false;
  if (page.expanded !== null) {
    for (const day of page.expanded.seen) {
      const keys = reading.seen.get(day.uid) ?? new Set<string>();
      keys.add(occurrenceKey(day.originalStart, zones));
      reading.seen.set(day.uid, keys);
    }
    for (const item of page.items) {
      if (item.kind !== "upsert" || item.event.recurrenceId !== null || item.event.rules.length === 0 || item.event.uid === null) continue;
      if (reading.masters.size >= MAX_MASTERS_KEPT && !reading.masters.has(item.event.uid)) {
        reading.noDrop = true;
        continue;
      }
      reading.masters.set(item.event.uid, item.event as CalEvent);
    }
  }
  return true;
}

/** A page's items as works for the store, measured against what is stored; the cancelled days whose series is not stored yet held for the end. */
async function applyPage(
  ctx: ReadingContext, apply: ApplyContext, reading: OpenReading, items: readonly ChangeItem[],
): Promise<ChunkResult> {
  const plan = await planItems(apply, items, ctx.map);
  if (plan === "gone") return { ok: false, why: "gone" };
  // Microsoft names a removed day by the day's own id. One nobody stores was an ordinary day of its series; one
  // that is stored was a changed day. Either way a day is gone that only the window read whole can confirm.
  if (ctx.word === "microsoft" && reading.mode === "delta" && plan.goneOfDays) reading.unknownGone = true;
  for (const c of plan.held) {
    if (reading.heldCancellations.length < MAX_HELD_CANCELLATIONS) reading.heldCancellations.push(c);
  }
  return written(ctx, apply, plan.works, plan.unkept);
}

/**
 * Works written, in transactions of the store's bound. What the store would not keep, and the
 * `unkept` its page named by a text no row can hold, is left out and said as one count: which
 * objects, and what they held, is nobody's to log.
 */
async function written(ctx: ReadingContext, apply: ApplyContext, works: readonly Work[], unkept = 0): Promise<ChunkResult> {
  const done = await applyChunks(apply, chunksOf(works));
  if (!done.ok) return done;
  const refused = done.refused + unkept;
  if (refused > 0) ctx.deps.log.warn("calendar_objects_refused", { accountId: ctx.key.accountId, kind: ctx.word, count: refused });
  return { ...done, refused };
}

/**
 * The reading's end: the cancelled days held for their series, Microsoft's cancelled days, the
 * drop, and last the token with the calendar's own row, in the reading's last transaction.
 */
async function finishReading(
  ctx: ReadingContext, apply: ApplyContext, cal: StoredCalendar, reading: OpenReading, page: ChangePage, token: ChangeToken | null,
): Promise<{ readonly kind: "done"; readonly changed: number; readonly dropped: number } | { readonly kind: "gone" | "halted" }> {
  const { deps } = ctx;
  let changed = 0;
  let dropped = 0;
  const works: Work[] = [];

  if (reading.heldCancellations.length > 0) {
    const stored = await storedRowsOf(apply, [], reading.heldCancellations.map((c) => c.uid));
    if (stored === "gone") return { kind: "gone" };
    const series = new Set(stored.filter((s) => s.recurrenceId === "").map((s) => s.uid));
    for (const c of reading.heldCancellations) {
      const rows = stored.filter((s) => s.uid === c.uid && s.recurrenceId === c.key).length;
      if (series.has(c.uid) || rows > 0) works.push(dayCancelled(c, rows));
    }
  }

  // A reading that ended on "nothing changed" names nothing, and so drops nothing.
  const whole = reading.mode === "whole" && !page.unchanged;
  if (ctx.word === "microsoft") {
    // What the pages showed, against what is stored of those series.
    const stored = reading.seen.size + reading.masters.size === 0 ? [] : await storedRowsOf(apply, [], [...reading.seen.keys(), ...reading.masters.keys()]);
    if (stored === "gone") return { kind: "gone" };
    const seriesOf = new Map(stored.filter((s) => s.recurrenceId === "").map((s) => [s.uid, s]));
    // A day the pages showed is there: where a series keeps it among its excluded days, it comes back.
    for (const [uid, keys] of reading.seen) {
      if (seriesOf.get(uid)?.excludes === true) works.push({ kind: "shown", uid, keys, changes: 1 });
    }
    // A day the window should show and no page did was cancelled: only on a whole reading, and only on one that left nothing out.
    if (whole && reading.window !== null && !reading.noDrop && !reading.leftOut) {
      for (const lost of cancelledDays(reading.masters, reading.seen, reading.window, deps.zones)) {
        const series = seriesOf.get(lost.uid);
        if (series !== undefined) works.push({ kind: "excluded", eventId: series.id, times: lost.days, changes: 1 });
      }
    }
  }
  if (works.length > 0) {
    const done = await written(ctx, apply, works);
    if (!done.ok) return { kind: done.why };
    changed += done.changed;
  }

  // A token the store could not hand back letter for letter is none: the calendar is then read whole each round, which is slow and never wrong.
  let keepToken: string | null = token !== null && storableKey(token.value) ? token.value : null;
  let nextAt = deps.clock.now() + pollAfterRead({ provider: ctx.word, refreshMs: page.refreshMs, notices: false, random: deps.random });

  if (whole && !reading.noDrop) {
    const candidates = await dropCandidates(apply, reading.startedAt, ctx.word === "microsoft" ? reading.window : null);
    if (candidates === "gone") return { kind: "gone" };
    const goes = candidates.filter((c) => !reading.named.has(nameOf(c.providerId)) && c.old && !c.owed && c.touches);
    const massive = candidates.length >= MASS_DROP_FLOOR && goes.length * 2 > candidates.length;
    if (massive && !deps.memory.massDrop.has(cal.id)) {
      // Most of the calendar would go at once: not on one reading's word. Read it whole again soon, and drop then.
      remember(deps.memory.massDrop, cal.id, true);
      keepToken = null;
      nextAt = deps.clock.now() + MASS_DROP_RETRY_MS;
    } else {
      deps.memory.massDrop.delete(cal.id);
      // No page named these. A changed day among them takes its day out of its series only where the pages say which
      // days there are (Microsoft) and left none of them out: silence is no word of the provider's otherwise.
      const dayLeaves = apply.unite && apply.shown !== null && !reading.leftOut;
      const gone: Work[] = goes.map((c) => objectGone(c.providerId, c.rows, { withDays: false, dayLeaves }));
      const done = await written(ctx, apply, gone);
      if (!done.ok) return { kind: done.why };
      dropped += done.changed;
    }
  }

  // Microsoft named a removed day nobody stores: the window is read whole again, at most every quarter of an hour.
  if (ctx.word === "microsoft" && !whole && reading.unknownGone) {
    keepToken = null;
    const last = deps.memory.forcedAt.get(cal.id) ?? 0;
    const at = Math.max(deps.clock.now(), last + FORCED_REREAD_EVERY_MS);
    remember(deps.memory.forcedAt, cal.id, at);
    nextAt = at;
  }

  const wrote = changed + dropped > 0 || reading.changed > 0;
  const cleared = cal.errorCode !== null;
  const last = await applyChunk(apply, [], async (tx, changes) => {
    await tx.update(calCalendars).set({
      syncToken: keepToken,
      nextPollAt: new Date(nextAt),
      ...(reading.window === null ? {} : { windowStart: dayText(reading.window.start), windowEnd: dayText(reading.window.end - DAY) }),
      ...(wrote || cleared ? { errorCode: null, lastSyncedAt: sql`now()`, updatedAt: sql`now()` } : {}),
    }).where(and(eq(calCalendars.id, cal.id), eq(calCalendars.accountId, ctx.key.accountId), eq(calCalendars.connectionId, ctx.key.id)));
    if (wrote || cleared) changes.push({ kind: "calendar", id: cal.id, op: "update" });
  });
  if (!last.ok) return { kind: last.why };
  return { kind: "done", changed, dropped };
}

/** A calendar's word and its wait, written with the change a device learns the word by. */
export async function holdCalendar(
  db: ConnectionDb, key: ConnectionKey, cal: StoredCalendar, word: CalendarSyncFault | null, until: Date,
  opts: { readonly resetToken?: boolean } = {},
): Promise<"gone" | void> {
  const done = await inConnection(db, key, async ({ tx }) => {
    const moved = word !== cal.errorCode;
    await (tx as Tx).update(calCalendars).set({
      nextPollAt: until,
      ...(opts.resetToken ? { syncToken: null } : {}),
      ...(moved ? { errorCode: word, updatedAt: sql`now()` } : {}),
    }).where(and(eq(calCalendars.id, cal.id), eq(calCalendars.accountId, key.accountId), eq(calCalendars.connectionId, key.id)));
    if (moved) await recordCalendarChanges(tx as unknown as LedgerTx, key.accountId, [{ kind: "calendar", id: cal.id, op: "update" }]);
  });
  return done === "gone" ? "gone" : undefined;
}

/** The account's own addresses in lower case: its mailboxes', and the connection's principal where that is an address. */
export async function ownAddressesOf(tx: Tx, accountId: string, principal: string | null): Promise<Set<string>> {
  const rows = await tx.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.accountId, accountId));
  const out = new Set(rows.map((r) => r.address.trim().toLowerCase()).filter((a) => a.includes("@")));
  const p = principal?.trim().toLowerCase().replace(/^mailto:/, "") ?? "";
  if (p.includes("@") && !p.includes("/")) out.add(p);
  return out;
}
