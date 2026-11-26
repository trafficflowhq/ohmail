/**
 * ONE CALENDAR'S READING, IN PAGES. Each page is asked with no transaction open, measured against
 * what is stored, and written in its own short transactions. Seen objects are marked with the
 * reading's generation. A continuation is saved between turns and can be picked up after a restart.
 * The calendar's token moves once, after the last page and its drop.
 *
 * A WHOLE reading (from no token, or a provider that keeps none) drops at its end what no page
 * named, and nothing it named in `left`; never a row written since it began, an object a person's
 * write is still owed to, or (Microsoft) one outside the window it read. A drop of most of what a
 * calendar holds waits for a second whole reading that shows the same.
 */
import { createHash, randomUUID } from "node:crypto";
import { momentOrUtc, type ZoneSource } from "@ohmail/cal-core";
import {
  MAX_MULTISTATUS_RESPONSES, MAX_PAGE_LIMIT, type Answer, type CalendarProvider, type ChangeItem, type ChangePage, type ChangeToken,
  type ProviderWord, type VerifiedEvent,
} from "@ohmail/cal-providers";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { calCalendars, calEvents, calWrites, recordCalendarChanges, type LedgerTx, type Tx } from "@trafficflow/db";
import { parseWritePayload } from "@trafficflow/db/calendar";
import {
  applyChunk, applyChunks, chunksOf, countStoredObjects, dayCancelled, objectGone, plannedMissingObjects, planMissingObjects, planItems, storedRowsOf,
  hasUnknownGoogleExclusions, settleGoogleExclusions,
  type ApplyContext, type ChunkResult, type Work,
} from "./apply.js";
import type { StoredCalendar } from "./calendars.js";
import { inConnection, type ConnectionDb, type ConnectionKey } from "./connection.js";
import { occurrenceKey, timeOfKey, type MapContext } from "./map.js";
import { connectionsKept, hasPlace, keepReading, releaseAllBut, remember } from "./memory.js";
import { cancelledDays } from "./microsoft.js";
import { advanceCycle, claimProgress, loadProgress, namesInPage, recurrenceMaster, saveProgress } from "./reading-progress.js";
import { dueAmong } from "./roster.js";
import type { PassSignIn } from "./sign-in.js";
import { storableKey } from "./storable.js";
import type { CalendarSyncDeps, OpenReading } from "./types.js";
import { pendingDispatchedReply } from "./write-reply-check.js";
import {
  faultWord, FORCED_REREAD_EVERY_MS, MASS_DROP_FLOOR, MASS_DROP_RETRY_MS, MAX_CALDAV_READING_PAGES, MS_WINDOW_DAYS_AHEAD,
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
const MAX_RECURRENCE_CHARS = 8 * 1024 * 1024;

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
  readonly noticeCoverage?: ReadonlyMap<string, number>;
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
  const credentialGeneration = ms || ctx.word === "google"
    ? ctx.map.principal == null ? null : createHash("sha256").update(ctx.map.principal).digest("hex")
    : ctx.signIn.generation();
  let since: string | null = cal.syncToken;
  let window: { start: number; end: number } | null = null;
  if (ctx.word === "google" && since !== null) {
    const unknown = await hasUnknownGoogleExclusions(ctx.db, ctx.key, cal.id);
    if (unknown === "gone") return { kind: "gone" };
    if (unknown) since = null;
  }
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
  if (reading !== undefined && (reading.since !== since || reading.calendarToken !== cal.syncToken ||
    reading.credentialGeneration !== credentialGeneration)) {
    memory.readings.delete(cal.id);
    reading = undefined;
  }
  let kept = reading !== undefined;
  // Its last reading was longer than a turn and found no place: asking the same pages again would end the same way.
  if (!kept && memory.crowded.has(cal.id) && !(await placeFree(ctx))) return { kind: "no_place", pages: 0, changed: 0 };
  const claim = await claimProgress({ db: ctx.db, key: ctx.key, calendarId: cal.id }, cal.syncToken);
  if (claim === "gone") return { kind: "gone" };
  const { scope: progress, owner, previous } = claim;
  ctx = { ...ctx, db: progress.db };
  if (reading !== undefined) {
    if (reading.owner === previous) {
      reading.owner = owner;
      window = reading.window;
    } else {
      memory.readings.delete(cal.id);
      reading = undefined;
      kept = false;
    }
  }
  let fromNullAgain = false;
  let pages = 0;
  let changed = 0;
  let lastPageMs = 0;
  const named = new Set<string>();
  /** The worker is stopping (a turn whose own time ran out is not: it says so). */
  const stopping = (): boolean => deps.halted() || (ctx.signal.aborted && !turnOverdue(ctx.signal));

  const begin = async (from: string | null, baseToken: string | null): Promise<OpenReading | "gone"> => {
    const r = await loadProgress(progress, baseToken, from, window, credentialGeneration, owner);
    if (r === "gone") return r;
    kept = keepReading(memory, cal.id, r);
    window = r.window;
    const confirmation = memory.massDrop.get(cal.id);
    if (confirmation !== undefined && !confirmation.startsWith(confirmationPrefix(window))) memory.massDrop.delete(cal.id);
    return r;
  };
  if (reading === undefined) {
    const r = await begin(since, cal.syncToken);
    if (r === "gone") return { kind: "gone" };
    reading = r;
  }

  /** The store's side of this reading: of the reading that stands now, since a forgotten token begins another. */
  const applyFor = (r: OpenReading): ApplyContext => ({
    db: ctx.db, key: ctx.key, calendar: { id: cal.id, providerId: cal.providerId }, zones: deps.zones,
    unite: ctx.word === "google" || ctx.word === "microsoft", shown: ms ? r.seen : null, halted: deps.halted,
    ...(ms && { outlook: "mirror" as const }),
    ...(ctx.word === "google" && { googleSnapshot: r.mode === "whole" ? r.generation : null }),
  });

  for (;;) {
    if (stopping()) return { kind: "halted" };
    if (turnOverdue(ctx.signal)) {
      memory.readings.delete(cal.id);
      if (kept && reading.cursor !== null && await saveProgress(progress, reading, named) === "gone") return { kind: "gone" };
      return { kind: "refused", word: "timeout", retryAfterMs: null, pages, changed };
    }
    if (reading.end !== null) {
      const end = await finishReading(ctx, applyFor(reading), cal, reading, reading.end);
      memory.readings.delete(cal.id);
      memory.crowded.delete(cal.id);
      if (end.kind !== "done") return end;
      return { kind: "done", pages, changed: changed + end.changed, dropped: end.dropped };
    }
    if (ctx.word === "caldav" && reading.pagesRead >= MAX_CALDAV_READING_PAGES) {
      memory.readings.delete(cal.id);
      if (await saveProgress(progress, null) === "gone") return { kind: "gone" };
      return { kind: "refused", word: "too_large", retryAfterMs: null, pages, changed };
    }
    const msLeft = ctx.budget.deadline - deps.clock.now();
    // One Outlook page can include many series requests. After two pages, leave room for a
    // page like the last one before starting another, even when the access grant was reused.
    if (ctx.budget.pagesLeft <= 0 || msLeft <= 0 || (ms && pages >= 2 && lastPageMs > msLeft)) {
      // Only now is a place needed: a reading that ended inside its turn never asked for one.
      if (!kept) kept = (await placeFree(ctx)) && keepReading(memory, cal.id, reading);
      if (!kept) {
        remember(memory.crowded, cal.id, true);
        return { kind: "no_place", pages, changed };
      }
      memory.crowded.delete(cal.id);
      if (await saveProgress(progress, reading, named) === "gone") return { kind: "gone" };
      return { kind: "more", pages, changed };
    }
    const token: ChangeToken | null = reading.since === null ? null : { provider: ctx.word, value: reading.since };
    const began = deps.clock.now();
    const answer = await ctx.provider.reader.readChanges(
      ctx.signIn.connection, { id: cal.providerId }, token,
      { limit: MAX_PAGE_LIMIT, cursor: reading.cursor, scope: reading, window: window === null ? null : { start: { kind: "instant", epochMs: window.start }, end: { kind: "instant", epochMs: window.end } } },
      ctx.signal,
    );
    lastPageMs = deps.clock.now() - began;
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
        named.clear();
        if (ms) window = microsoftWindow(deps.clock.now());
        const r = await begin(null, null);
        if (r === "gone") return { kind: "gone" };
        reading = r;
        continue;
      }
      const resume = kept && reading.cursor !== null &&
        (answer.reason === "timeout" || answer.reason === "unavailable" || answer.reason === "throttled");
      if (await saveProgress(progress, resume ? reading : null, named) === "gone") return { kind: "gone" };
      return { kind: "refused", word: faultWord(answer.reason), retryAfterMs: answer.retryAfterMs, pages, changed, continuing: reading.cursor !== null };
    }
    const page = answer.value;
    const names = namesInPage(page);
    const cycle = page.cursor.kind === "more" ? advanceCycle(reading, page.cursor.value) : reading.cycle;
    if (cycle === null || names.length > MAX_MULTISTATUS_RESPONSES) {
      memory.readings.delete(cal.id);
      if (await saveProgress(progress, null) === "gone") return { kind: "gone" };
      return { kind: "refused", word: cycle === null ? "page_link_refused" : "too_large", retryAfterMs: null, pages, changed };
    }
    reading.mode = page.mode;
    if (!page.unchanged && page.items.length > 0) {
      const done = await applyPage(ctx, applyFor(reading), reading, page);
      if ("reason" in done) {
        memory.readings.delete(cal.id);
        if (kept && reading.cursor !== null &&
          await saveProgress(progress, reading, named) === "gone") return { kind: "gone" };
        return { kind: "refused", word: faultWord(done.reason), retryAfterMs: done.retryAfterMs, pages, changed };
      }
      if (!done.ok) return { kind: done.why };
      reading.changed += done.changed;
      changed += done.changed;
    } else {
      note(reading, page, deps.zones);
    }
    reading.cycle = cycle;
    reading.pagesRead += 1;
    if (page.mode === "whole") for (const id of names) named.add(id);
    if (page.cursor.kind === "more") {
      reading.cursor = page.cursor.value;
      continue;
    }
    reading.end = {
      token: page.cursor.token?.value ?? null, unchanged: page.unchanged, refreshMs: page.refreshMs,
    };
    if (await saveProgress(progress, reading, named) === "gone") return { kind: "gone" };
    named.clear();
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
    await tx.update(calCalendars).set({ syncToken: null, readCheckpoint: null })
      .where(and(eq(calCalendars.id, cal.id), eq(calCalendars.accountId, ctx.key.accountId), eq(calCalendars.connectionId, ctx.key.id)));
  });
  return done === "gone" ? "gone" : undefined;
}

/** Bounded recurrence information used only at the end of the reading. */
function note(reading: OpenReading, page: ChangePage, zones: ZoneSource, removed?: ReadonlySet<string>): void {
  // What was left out may be a day this reading should have shown: from here its silence about a day proves nothing.
  if (page.left.length > 0) reading.leftOut = true;
  if (page.expanded !== null) {
    for (const day of page.expanded.seen) {
      const source = day.providerId ?? null;
      if (source !== null && removed?.has(source)) continue;
      const previous = reading.seen.get(day.uid);
      const keys = previous ?? new Map<string, Set<string | null>>();
      const key = occurrenceKey(day.originalStart, zones);
      const sources = keys.get(key) ?? new Set<string | null>();
      if (sources.has(source)) continue;
      const cost = JSON.stringify(source).length + 1 +
        (sources.size === 0 ? JSON.stringify(key).length + 5 : 0) +
        (previous === undefined ? JSON.stringify(day.uid).length + 5 : 0);
      if (reading.seenCount >= MAX_MULTISTATUS_RESPONSES || reading.recurrenceChars + cost > MAX_RECURRENCE_CHARS) {
        reading.leftOut = true;
        break;
      }
      reading.recurrenceChars += cost;
      reading.seenCount += 1;
      sources.add(source);
      keys.set(key, sources);
      reading.seen.set(day.uid, keys);
    }
    for (const item of page.items) {
      if (item.kind !== "upsert" || removed?.has(item.id) || item.event.recurrenceId !== null || item.event.rules.length === 0 || item.event.uid === null) continue;
      if (reading.masters.size >= MAX_MASTERS_KEPT && !reading.masters.has(item.event.uid)) {
        reading.noDrop = true;
        continue;
      }
      const master = recurrenceMaster(item.event);
      const previous = reading.masters.get(item.event.uid);
      const cost = previous === undefined
        ? JSON.stringify([item.event.uid, master]).length + 1
        : JSON.stringify(master).length - JSON.stringify(previous).length;
      if (reading.recurrenceChars + cost > MAX_RECURRENCE_CHARS) {
        reading.leftOut = true;
        continue;
      }
      reading.recurrenceChars += cost;
      reading.masters.set(item.event.uid, master);
    }
  }
}

/** A page's items as works for the store, measured against what is stored; the cancelled days whose series is not stored yet held for the end. */
async function applyPage(
  ctx: ReadingContext, apply: ApplyContext, reading: OpenReading, page: ChangePage,
): Promise<ChunkResult | Extract<Answer<VerifiedEvent>, { ok: false }>> {
  const { items } = page;
  const reader = ctx.provider.reader;
  const cal = { id: apply.calendar.providerId };
  const plan = await planItems(apply, items, ctx.map, reader.verifySelfResponse
    ? (id, items, held) => reader.verifySelfResponse!(ctx.signIn.connection, cal, {
      id, items, window: reading.window,
      held: held && { version: held.versionTag, answer: ctx.map.ownCalendar ? held.myAnswer : null },
    }, ctx.signal) : undefined);
  if (plan === "gone") return { ok: false, why: "gone" };
  if ("reason" in plan) return plan;
  if (ctx.word === "microsoft") {
    for (const { id, uid, key } of plan.removedDays) {
      const keys = reading.seen.get(uid);
      const sources = keys?.get(key);
      if (!sources?.delete(id)) continue;
      if (sources.size === 0) keys?.delete(key);
    }
  }
  const removed = new Set([...plan.removed, ...plan.removedDays.map(({ id }) => id)]);
  note(reading, page, ctx.deps.zones, removed);
  if (ctx.word === "microsoft" && (plan.unorderedReply || (reading.mode === "delta" && plan.needsWholeRead))) {
    reading.unknownGone = true;
  }
  for (const c of plan.held) {
    const cost = JSON.stringify(c).length + 1;
    if (reading.heldCancellations.length >= MAX_HELD_CANCELLATIONS || reading.recurrenceChars + cost > MAX_RECURRENCE_CHARS) {
      reading.leftOut = true;
      break;
    }
    reading.recurrenceChars += cost;
    reading.heldCancellations.push(c);
  }
  const done = await written(ctx, apply, plan.works, plan.unkept);
  if (ctx.word === "google" && done.ok && done.refused > 0) reading.leftOut = true;
  if (done.ok && ctx.word === "microsoft") {
    if (plan.removed.length > 0 && await noteRemovedAnswers(apply, [...plan.removed]) === "gone") return { ok: false, why: "gone" };
  }
  return done;
}

const acknowledgedDecline = (apply: ApplyContext) => and(
  eq(calWrites.accountId, apply.key.accountId), eq(calWrites.calendarId, apply.calendar.id),
  eq(calWrites.op, "answer"),
  or(eq(calWrites.state, "pending"), and(eq(calWrites.state, "refused"), eq(calWrites.refusal, "answer_unconfirmed"))),
  sql`${calWrites.payload} #>> '{answerDispatch,phase}' = 'accepted'`,
  sql`${calWrites.payload} #>> '{act,answer}' = 'declined'`,
  sql`${calWrites.payload} #>> '{answerDispatch,removed}' is null`,
);

const dispatchedId = sql<string>`${calWrites.payload} #>> '{answerDispatch,id}'`;

async function noteRemovedAnswers(apply: ApplyContext, removed: string[]) {
  return inConnection(apply.db, apply.key, async ({ tx }) => {
    await tx.update(calWrites).set({
      payload: sql`jsonb_set(${calWrites.payload}, '{answerDispatch,removed}', 'true'::jsonb)`,
      nextAttemptAt: sql`case when ${calWrites.state} = 'pending' then now() else ${calWrites.nextAttemptAt} end`,
    }).where(and(acknowledgedDecline(apply), inArray(dispatchedId, removed)));
  });
}

async function noteAbsentAnswers(apply: ApplyContext, reading: OpenReading) {
  const window = reading.window;
  if (window === null) return;
  const lookup = await inConnection(apply.db, apply.key, async ({ tx }) => {
    const pending = await tx.select({
      id: dispatchedId, payload: calWrites.payload, uid: calEvents.uid, startsAt: calEvents.startsAt,
      endsAt: calEvents.endsAt, updatedAt: calEvents.updatedAt,
    }).from(calWrites).leftJoin(calEvents, and(eq(calEvents.id, calWrites.eventId),
      eq(calEvents.accountId, calWrites.accountId), eq(calEvents.calendarId, calWrites.calendarId),
      sql`${calEvents.providerId} = ${calWrites.payload} #>> '{answerDispatch,source}'`))
      .where(acknowledgedDecline(apply));
    if (pending.length === 0) return { pending, seen: new Set<string>() };
    const seen = await tx.select({ providerId: calEvents.providerId }).from(calEvents).where(and(
      eq(calEvents.accountId, apply.key.accountId), eq(calEvents.calendarId, apply.calendar.id),
      eq(calEvents.seenInReading, reading.generation), inArray(calEvents.providerId, pending.map(({ id }) => id)),
    ));
    return { pending, seen: new Set(seen.map(({ providerId }) => providerId)) };
  });
  if (lookup === "gone") return lookup;
  const missing = lookup.pending.filter(({ id, uid, payload, startsAt, endsAt, updatedAt }) => {
    if (lookup.seen.has(id)) return false;
    const write = parseWritePayload(payload);
    if (write?.act.kind !== "calendar_event_answer") return false;
    if (write.act.scope.kind === "record") {
      if (updatedAt && updatedAt >= reading.startedAt) return false;
      const start = startsAt?.getTime() ?? write.answerTarget?.startsAt;
      const end = startsAt ? endsAt?.getTime() ?? null : write.answerTarget?.endsAt ?? null;
      return start !== undefined && start < window.end && (end === null || end > window.start);
    }
    const at = write.act.scope.at;
    const time = timeOfKey(at);
    const series = uid ?? write.answerTarget?.uid;
    if (time === null || series === undefined || reading.seen.get(series)?.has(at)) return false;
    const when = momentOrUtc(time, apply.zones);
    return when >= window.start && when < window.end;
  }).map(({ id }) => id);
  if (missing.length > 0) return noteRemovedAnswers(apply, missing);
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
  ctx: ReadingContext, apply: ApplyContext, cal: StoredCalendar, reading: OpenReading, page: NonNullable<OpenReading["end"]>,
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
      if (seriesOf.get(uid)?.excludes === true) works.push({ kind: "shown", uid, keys: new Set(keys.keys()), changes: 1 });
    }
    // A day the window should show and no page did was cancelled: only on a whole reading, and only on one that left nothing out.
    if (whole && reading.window !== null && !reading.noDrop && !reading.leftOut) {
      if (await noteAbsentAnswers(apply, reading) === "gone") return { kind: "gone" };
      for (const lost of cancelledDays(reading.masters, reading.seen, reading.window, deps.zones)) {
        const series = seriesOf.get(lost.uid);
        if (series !== undefined) works.push({ kind: "excluded", eventId: series.id, times: lost.days, changes: 1 });
      }
    }
  }
  if (works.length > 0) {
    const done = await written(ctx, apply, works);
    if (!done.ok) return { kind: done.why };
    if (ctx.word === "google" && done.refused > 0) reading.leftOut = true;
    changed += done.changed;
  }

  // A token the store could not hand back letter for letter is none: the calendar is then read whole each round, which is slow and never wrong.
  let keepToken: string | null = page.token !== null && storableKey(page.token) ? page.token : null;
  const now = deps.clock.now();
  const coveredUntil = keepToken === null ? undefined : ctx.noticeCoverage?.get(cal.id);
  const covered = coveredUntil !== undefined && coveredUntil > now;
  const poll = { provider: ctx.word, refreshMs: page.refreshMs, random: deps.random };
  const fallbackAt = now + pollAfterRead({ ...poll, notices: false });
  let nextAt = covered ? Math.min(now + pollAfterRead({ ...poll, notices: true }), coveredUntil) : fallbackAt;
  let reconcileGoogle = ctx.word === "google" && whole && !reading.noDrop && !reading.leftOut;
  let confirmingAbsence = false;

  if (whole && !reading.noDrop) {
    const clean = await removeAbsentObjects(ctx, apply, reading);
    if (!clean.ok) return { kind: clean.why };
    if (clean.confirming) {
      confirmingAbsence = true;
      keepToken = null;
      nextAt = deps.clock.now() + MASS_DROP_RETRY_MS;
      reconcileGoogle = false;
    }
    dropped += clean.changed;
  } else deps.memory.massDrop.delete(cal.id);

  if (reconcileGoogle) {
    const settled = await settleGoogleExclusions(apply, reading.generation);
    if (!settled.ok) return { kind: settled.why };
    changed += settled.changed;
  }

  // Recheck an unresolved removal or reply by reading the full window again.
  if (ctx.word === "microsoft" && reading.unknownGone && !confirmingAbsence) {
    keepToken = null;
    const last = deps.memory.forcedAt.get(cal.id) ?? 0;
    const at = Math.max(deps.clock.now(), last + FORCED_REREAD_EVERY_MS);
    remember(deps.memory.forcedAt, cal.id, at);
    nextAt = at;
  }

  // A calendar's first reading says it was read even when it holds nothing: a device learns by it that the calendar is in.
  const wrote = changed + dropped > 0 || reading.changed > 0 || cal.lastSyncedAt === null;
  const cleared = cal.errorCode !== null;
  const expectedPoll = cal.nextPollAt?.toISOString() ?? null;
  const last = await applyChunk(apply, [], async (tx, changes) => {
    let pollAt = nextAt;
    if (ctx.word === "microsoft" && covered && pollAt > fallbackAt) {
      const [reply] = await tx.select({ id: calWrites.id }).from(calWrites).where(and(
        eq(calWrites.accountId, ctx.key.accountId), eq(calWrites.calendarId, cal.id),
        eq(calWrites.op, "answer"), pendingDispatchedReply(),
      )).limit(1);
      if (reply !== undefined) pollAt = fallbackAt;
    }
    const scheduledPoll = new Date(pollAt).toISOString();
    await tx.update(calCalendars).set({
      syncToken: keepToken,
      readCheckpoint: null,
      readOwner: null,
      nextPollAt: sql`case
        when ${cal.nextPollAt !== null && cal.nextPollAt.getTime() > now}
          or date_trunc('milliseconds', ${calCalendars.nextPollAt}) is distinct from ${expectedPoll}::timestamptz
        then least(coalesce(${calCalendars.nextPollAt}, now()), ${scheduledPoll}::timestamptz)
        else ${scheduledPoll}::timestamptz end`,
      ...(reading.window === null ? {} : { windowStart: dayText(reading.window.start), windowEnd: dayText(reading.window.end - DAY) }),
      ...(wrote || cleared ? { errorCode: null, lastSyncedAt: sql`now()`, updatedAt: sql`now()` } : {}),
    }).where(and(eq(calCalendars.id, cal.id), eq(calCalendars.accountId, ctx.key.accountId), eq(calCalendars.connectionId, ctx.key.id)));
    if (wrote || cleared) changes.push({ kind: "calendar", id: cal.id, op: "update" });
  });
  if (!last.ok) return { kind: last.why };
  return { kind: "done", changed, dropped };
}

async function removeAbsentObjects(
  ctx: ReadingContext, apply: ApplyContext, reading: OpenReading,
): Promise<{ readonly ok: true; readonly confirming: boolean; readonly changed: number } | Extract<ChunkResult, { ok: false }>> {
  const calendarId = apply.calendar.id;
  const total = await countStoredObjects(apply);
  if (total === "gone") return { ok: false, why: "gone" };
  const { generation, startedAt } = reading;
  const plan = randomUUID();
  const window = ctx.word === "microsoft" ? reading.window : null;
  const hash = createHash("sha256");
  let after: string | null = null;
  let missing = 0;
  for (;;) {
    if (ctx.deps.halted()) return { ok: false, why: "halted" };
    const batch = await planMissingObjects(apply, { generation, startedAt, window, plan }, after);
    if (batch === "gone") return { ok: false, why: "gone" };
    if (batch.length === 0) break;
    for (const { providerId } of batch) hash.update("\n").update(JSON.stringify(providerId));
    missing += batch.length;
    after = batch.at(-1)!.providerId;
  }
  const fingerprint = confirmationPrefix(window) + hash.digest("hex");
  const confirmation = ctx.deps.memory.massDrop;
  if (total >= MASS_DROP_FLOOR && missing * 2 > total && confirmation.get(calendarId) !== fingerprint) {
    // Repeat a whole reading before deleting most of a calendar. Both readings must select the same objects.
    remember(confirmation, calendarId, fingerprint);
    return { ok: true, confirming: true, changed: 0 };
  }
  confirmation.delete(calendarId);
  if (missing === 0) return { ok: true, confirming: false, changed: 0 };
  // An absent exception leaves its series only when the complete Microsoft window also omitted its day.
  const dayLeaves = apply.unite && apply.shown !== null && !reading.leftOut;
  let changed = 0;
  after = null;
  for (;;) {
    if (ctx.deps.halted()) return { ok: false, why: "halted" };
    const batch = await plannedMissingObjects(apply, plan, after);
    if (batch === "gone") return { ok: false, why: "gone" };
    if (batch.length === 0) break;
    const gone = batch.map(({ providerId, rows }) => objectGone(providerId, rows, { withDays: false, dayLeaves, absence: { startedAt, plan } }));
    const done = await written(ctx, apply, gone);
    if (!done.ok) return done;
    changed += done.changed;
    after = batch.at(-1)!.providerId;
  }
  return { ok: true, confirming: false, changed };
}

function confirmationPrefix(window: OpenReading["window"]): string {
  return `${window?.start ?? ""}:${window?.end ?? ""}:`;
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
      ...(opts.resetToken ? { syncToken: null, readCheckpoint: null, readOwner: null } : {}),
      ...(moved ? { errorCode: word, updatedAt: sql`now()` } : {}),
    }).where(and(eq(calCalendars.id, cal.id), eq(calCalendars.accountId, key.accountId), eq(calCalendars.connectionId, key.id)));
    if (moved) await recordCalendarChanges(tx as unknown as LedgerTx, key.accountId, [{ kind: "calendar", id: cal.id, op: "update" }]);
  });
  return done === "gone" ? "gone" : undefined;
}
