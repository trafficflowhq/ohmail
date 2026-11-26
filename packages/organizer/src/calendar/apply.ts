/**
 * THE STORE'S SIDE OF A PAGE: what a page asks of `cal_events`, measured first and written in
 * transactions of at most `CALENDAR_CHANGES_PER_TRANSACTION` changes, each its own, each ending with
 * the changes it made (`recordCalendarChanges`, the one door). A transaction holds the account's
 * counter row only for its own few statements, so a person's press on the same account waits at
 * most one of them, never a whole first read.
 *
 * Every transaction reads the rows it changes again under lock and decides from what it finds, so
 * a page applied twice, or out of order, writes what once would have and then nothing: the
 * provider's version decides whether an object changed, and an equal one writes nothing.
 */
import { and, eq, getTableName, gt, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { eventTimeOf, storedTimeOf, type EventTime, type StoredTime, type ZoneSource } from "@ohmail/cal-core";
import type { Answer, ChangeItem, VerifiedEvent } from "@ohmail/cal-providers";
import {
  CALENDAR_CHANGES_PER_TRANSACTION, calAlarms, calAttendees, calEvents, calWrites, recordCalendarChanges,
  type CalendarChange, type LedgerTx, type Tx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { inConnection, type ConnectionDb, type ConnectionKey } from "./connection.js";
import { occurrenceKey, rowsOfObject, timeOfKey, type MapContext, type MappedRow, type Upsert } from "./map.js";
import { storableKey } from "./storable.js";

/** A calendar as its row names it: the store's id, and the provider's. */
export interface CalendarOfTurn {
  readonly id: string;
  readonly providerId: string;
}

export interface ApplyContext {
  readonly db: ConnectionDb;
  readonly key: ConnectionKey;
  readonly calendar: CalendarOfTurn;
  readonly zones: ZoneSource;
  /**
   * Google and Microsoft store changed days separately from their masters. Where the provider keeps
   * the object's text (CalDAV, a subscription), a complete object owns its components together.
   */
  readonly unite: boolean;
  /** A stale exact read cannot confirm an Outlook reply against a newer mirrored answer. */
  readonly outlook?: "mirror" | "confirmation";
  /** A whole Google inventory's generation, `null` for a Google delta or write answer. */
  readonly googleSnapshot?: string | null;
  /**
   * The days this reading's pages showed so far, by UID and occurrence key (Microsoft), or `null`
   * where the provider shows none. A day shown is there: it is never excluded, and it comes back
   * where it was excluded before.
   */
  readonly shown: ReadonlyMap<string, Pick<ReadonlySet<string>, "has">> | null;
  readonly halted: () => boolean;
}

/**
 * One object to write: the rows to write, the occurrences it names (`keep`), and how many unnamed
 * stored rows to finalize. An incomplete object marks unnamed rows partial and retains them.
 */
export interface ObjectWrite {
  readonly kind: "object";
  readonly providerId: string;
  readonly rows: readonly MappedRow[];
  readonly keep: ReadonlySet<string>;
  readonly missing: number;
  readonly incomplete?: true;
  readonly changes: number;
}
/**
 * Every row of one stored object goes, at most `rows` of them in this transaction.
 *
 * Where a changed day is an object of its own (Google, Microsoft), two more things can follow, and
 * the planner says which:
 * - `withDays`: the provider itself named a series as gone. It names the series alone, so the
 *   series' changed days, stored under ids of their own, go with it.
 * - `dayLeaves`: a changed day goes and its series stays. Its day leaves the series too (it joins
 *   the excluded days), or the rule would bring it back at its first time; unless this reading's
 *   pages showed that day, which is then an ordinary day again.
 */
export interface ObjectGone {
  readonly kind: "gone";
  readonly providerId: string;
  readonly rows: number;
  readonly withDays: boolean;
  readonly dayLeaves: boolean;
  /** A whole reading's silence can only remove objects unchanged since it started. */
  readonly absence?: { readonly startedAt: Date; readonly plan: string };
  readonly changes: number;
}

/** The work of removing an object of `rows` rows; a row that may take its day out of a series counts for two changes. */
export function objectGone(providerId: string, rows: number, o: Pick<ObjectGone, "withDays" | "dayLeaves" | "absence">): ObjectGone {
  return {
    kind: "gone", providerId, rows, withDays: o.withDays, dayLeaves: o.dayLeaves,
    ...(o.absence === undefined ? {} : { absence: o.absence }), changes: rows * (o.dayLeaves ? 2 : 1),
  };
}
/** One day of a series cancelled: its key joins the series' excluded days, a changed row of that day goes. */
export interface DayCancelled {
  readonly kind: "cancelled";
  readonly uid: string;
  readonly key: string;
  readonly time: EventTime;
  readonly changes: number;
}
/** The excluded days of a series grow by those its whole reading did not show (Microsoft). */
export interface DaysExcluded {
  readonly kind: "excluded";
  readonly eventId: string;
  readonly times: readonly EventTime[];
  readonly changes: number;
}
/** Days a reading's pages showed for a series: those of them it has among its excluded days come back. */
export interface DaysShown {
  readonly kind: "shown";
  readonly uid: string;
  readonly keys: ReadonlySet<string>;
  readonly changes: number;
}
/**
 * A new event a person made, named by the provider at last: the row its write stood in takes the
 * provider's id and UID, after any other row of the calendar that already holds that id (a reading
 * that got there first) goes with its delete. The object's own write then finds the row by its id.
 */
export interface Repointed {
  readonly kind: "repoint";
  readonly eventId: string;
  readonly providerId: string;
  readonly uid: string;
  readonly changes: number;
}
export type Work = ObjectWrite | ObjectGone | DayCancelled | DaysExcluded | DaysShown | Repointed;

/**
 * What a transaction, or a run of them, ended as: the changes recorded and the works the store
 * refused for what they hold (left out, each alone), or the turn must stop (`gone`, `halted`).
 */
export type ChunkResult =
  | { readonly ok: true; readonly changed: number; readonly refused: number }
  | { readonly ok: false; readonly why: "gone" | "halted" };

/** Values one statement names at once, well under what the driver carries (65,534). */
const SLICE = 1_000;

/** `all` in runs of at most `SLICE`. */
function slicesOf<T>(all: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < all.length; i += SLICE) out.push(all.slice(i, i + SLICE));
  return out;
}

/** The stored rows of a page's objects, as one read finds them. */
export interface StoredRow {
  readonly id: string;
  readonly providerId: string;
  readonly recurrenceId: string;
  readonly versionTag: string | null;
  readonly providerModifiedAt: Date | null;
  readonly uid: string;
  readonly partial: boolean;
  readonly portableCopy: boolean;
  readonly googleDefaultEvent: boolean;
  readonly myAnswer: string | null;
  /** Whether the row keeps any excluded day. */
  readonly excludes: boolean;
  readonly unknownGoogleExclusions: boolean;
}

/** A stored time's occurrence key, or `null` for one no writer of this product wrote. */
export function keyOfStored(t: StoredTime, zones: ZoneSource): string | null {
  const time = eventTimeOf(t);
  return time === null ? null : occurrenceKey(time, zones);
}

const times = (v: unknown): StoredTime[] => (Array.isArray(v) ? (v as StoredTime[]) : []);

interface GoogleExclusionSources {
  readonly master: readonly StoredTime[] | null;
  readonly cancelled: readonly StoredTime[];
  /** Older merged exclusions stay until a complete Google inventory has classified them. */
  readonly legacy?: string | null;
}

const unknownGoogleExclusions = sql<boolean>`
  case when ${calEvents.googleExclusionSources} is null then ${calEvents.excludedDates} is not null
  else ${calEvents.googleExclusionSources} ? 'legacy' end`;

type GoogleExclusionRow = { readonly excludedDates: unknown; readonly googleExclusionSources: unknown };

function googleSources(ctx: ApplyContext, row: GoogleExclusionRow | undefined): GoogleExclusionSources {
  const previous = row?.googleExclusionSources as GoogleExclusionSources | null | undefined;
  const legacy = previous?.legacy !== undefined || (previous == null && times(row?.excludedDates).length > 0);
  if (!legacy) return previous ?? { master: null, cancelled: [] };
  const snapshot = ctx.googleSnapshot ?? previous?.legacy ?? null;
  // Cancellation evidence from an abandoned inventory cannot classify a later inventory.
  return previous?.legacy === snapshot ? previous : { master: null, cancelled: [], legacy: snapshot };
}

function combinedGoogleExclusions(
  ctx: ApplyContext, sources: GoogleExclusionSources, held: readonly StoredTime[],
): StoredTime[] {
  const known = united(sources.master ?? [], sources.cancelled, ctx.zones);
  return sources.legacy === undefined ? known : united(known, held, ctx.zones);
}

/** `a` and every member of `b` whose key `a` lacks, in that order; each key once. */
function united(a: readonly StoredTime[], b: readonly StoredTime[], zones: ZoneSource): StoredTime[] {
  const out: StoredTime[] = [];
  const keys = new Set<string>();
  for (const t of [...a, ...b]) {
    const k = keyOfStored(t, zones) ?? JSON.stringify(t);
    if (keys.has(k)) continue;
    keys.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Is an object as a page names it already stored as it is? Every stored row carries the
 * provider's same version, which is not empty, and the rows are the same occurrences.
 */
export function storedAsIs(rows: readonly MappedRow[], stored: readonly Pick<StoredRow, "versionTag" | "providerModifiedAt" | "recurrenceId" | "partial" | "portableCopy" | "googleDefaultEvent" | "myAnswer">[], keepOutlookRevision = false): boolean {
  const version = rows[0]?.values.versionTag ?? null;
  if (version === null || stored.length !== rows.length) return false;
  const byDay = new Map(rows.map(({ values }) => [values.recurrenceId, values]));
  return stored.every((s) => {
    const row = byDay.get(s.recurrenceId);
    return s.versionTag === version && row?.partial === s.partial && row.portableCopy === s.portableCopy &&
      row.googleDefaultEvent === s.googleDefaultEvent && row.myAnswer === s.myAnswer &&
      (!keepOutlookRevision || row.providerModifiedAt === null ||
        (s.providerModifiedAt !== null && s.providerModifiedAt >= row.providerModifiedAt));
  });
}

/**
 * The work of writing an object: each row written, each stored row it leaves out, and where the
 * a changed day's series that may be needed for a separately stored moved occurrence, or lose
 * that day from its excluded ones.
 */
export function objectWrite(
  providerId: string, rows: readonly MappedRow[], stored: readonly Pick<StoredRow, "recurrenceId" | "partial">[],
  unite: boolean, incomplete = false,
): ObjectWrite {
  const keep = new Set(rows.map((r) => r.values.recurrenceId));
  const missing = stored.filter((s) => !keep.has(s.recurrenceId) && (!incomplete || !s.partial)).length;
  const series = (unite || !keep.has("")) && rows.some((r) => r.values.recurrenceId !== "");
  return {
    kind: "object", providerId, rows, keep, missing, changes: rows.length * (series ? 2 : 1) + missing,
    ...(incomplete && { incomplete: true }),
  };
}

/** A cancelled day as a work: one change for its series, one for each changed row of that day (one, where none is known yet). */
export const dayCancelled = (c: { readonly uid: string; readonly key: string; readonly time: EventTime }, rows: number): Work =>
  ({ kind: "cancelled", uid: c.uid, key: c.key, time: c.time, changes: 1 + Math.max(rows, 1) });

/** What the planner made of a page's items, or of a write's answer: the works, and what the caller decides about. */
export interface PlannedItems {
  readonly works: readonly Work[];
  /** Objects named by a text no row can hold, or that no row could keep: left out, said as a count. */
  readonly unkept: number;
  /** Cancelled days whose series is neither stored nor in these items: the caller holds them or lets them go. */
  readonly held: readonly { readonly uid: string; readonly key: string; readonly time: EventTime }[];
  /** A delta removal needs a fresh window. */
  readonly needsWholeRead: boolean;
  /** A reply could not be ordered, even if this page was already reading the whole window. */
  readonly unorderedReply: boolean;
  readonly removed: readonly string[];
  readonly removedDays: readonly { readonly id: string; readonly uid: string; readonly key: string }[];
}

/**
 * Items as works for the store, measured against what is stored: each object mapped and written
 * unless it is stored as it is, each removal with what goes with it, each cancelled day where its
 * series is known. The one planner for a reading's page and for a write's answer, so the store
 * and the provider meet through one mapper and one apply.
 */
type VerifyResponse = (
  id: string, items: readonly Upsert[], held: StoredRow | undefined,
) => Promise<Answer<VerifiedEvent>>;

export function planItems(
  apply: ApplyContext, items: readonly ChangeItem[], map: MapContext,
): Promise<PlannedItems | "gone">;
export function planItems(
  apply: ApplyContext, items: readonly ChangeItem[], map: MapContext,
  verifyResponse: VerifyResponse | undefined,
): Promise<PlannedItems | "gone" | Extract<Answer<VerifiedEvent>, { ok: false }>>;
export async function planItems(
  apply: ApplyContext, items: readonly ChangeItem[], map: MapContext,
  verifyResponse?: VerifyResponse,
): Promise<PlannedItems | "gone" | Extract<Answer<VerifiedEvent>, { ok: false }>> {
  const objects = new Map<string, Upsert[]>();
  const gone = new Set<string>();
  const cancels: { uid: string; key: string; time: EventTime }[] = [];
  /** What the items name by a text no row can hold: left out, and said as a count. No stored row can carry such a name. */
  let unkept = 0;
  for (const item of items) {
    if (item.kind === "upsert") {
      const list = objects.get(item.id) ?? [];
      list.push(item);
      objects.set(item.id, list);
    } else if (item.kind === "gone") {
      // Kept in the list all the same: the read of stored rows passes it over, and it is then a removal of something nobody stores.
      gone.add(item.id);
      if (!storableKey(item.id)) unkept += 1;
    } else {
      // The key carries the zone's name, a stranger's text like the UID, only where the platform does not know the zone. A known
      // one (a vendor's prefix too) keys by the moment; a name the store cannot hold is then refused in the day's own write, and counted.
      const key = occurrenceKey(item.originalStart, apply.zones);
      if (storableKey(item.uid) && storableKey(key)) cancels.push({ uid: item.uid, key, time: item.originalStart });
      else unkept += 1;
    }
  }
  const stored = await storedRowsOf(apply, [...objects.keys(), ...gone], cancels.map((c) => c.uid));
  if (stored === "gone") return "gone";
  const byProvider = new Map<string, StoredRow[]>();
  for (const s of stored) byProvider.set(s.providerId, [...(byProvider.get(s.providerId) ?? []), s]);

  const works: Work[] = [];
  const seriesHere = new Set<string>();
  let needsWholeRead = false;
  let unorderedReply = false;
  for (const [id, items] of objects) {
    const was = byProvider.get(id) ?? [];
    const incoming = verifyResponse ? revisionCopies(items) : items;
    let mapped = rowsOfObject(incoming, map);
    if (verifyResponse && (gone.has(id) || incoming.length > 1 || (mapped.ok && changedSelfResponse(mapped.rows, was)))) {
      const checked = await verifyResponse(id, incoming, was[0]);
      if (!checked.ok) return checked;
      if (checked.value.kind !== "current") continue;
      if (checked.value.reread) unorderedReply = true;
      gone.delete(id);
      if (checked.value.item === null) continue;
      mapped = rowsOfObject([checked.value.item], map);
    }
    if (!mapped.ok) {
      if (mapped.reason === "unstorable") unkept += 1;
      continue;
    }
    for (const r of mapped.rows) if (r.values.recurrenceId === "") seriesHere.add(r.values.uid);
    const work = objectWrite(id, mapped.rows, was, apply.unite, incoming.some((item) => item.resourceIncomplete));
    const comparable = work.incomplete ? was.filter((s) => work.keep.has(s.recurrenceId)) : was;
    const needsGoogleSources = apply.googleSnapshot != null && comparable.some((s) => s.unknownGoogleExclusions);
    if (work.missing === 0 && !needsGoogleSources && storedAsIs(mapped.rows, comparable, apply.outlook !== undefined)) continue;
    works.push(work);
  }
  const outside = new Set<string>();
  if (verifyResponse) {
    for (const id of gone) {
      if (objects.has(id)) continue;
      const held = byProvider.get(id)?.find(({ myAnswer }) =>
        myAnswer === "accepted" || myAnswer === "tentative" || myAnswer === "declined");
      if (!held) continue;
      const checked = await verifyResponse(id, [], held);
      if (!checked.ok) return checked;
      if (checked.value.kind === "missing") continue;
      if (checked.value.kind === "outside") outside.add(id);
      if (checked.value.kind === "reread") needsWholeRead = true;
      gone.delete(id);
    }
  }
  // Where a changed day is an object of its own, a series named as gone takes its days' rows with it: how many, for the works' count.
  const goneSeries = apply.unite ? [...gone].flatMap((id) => (byProvider.get(id) ?? []).filter((s) => s.recurrenceId === "").map((s) => s.uid)) : [];
  const ofGoneSeries = await storedRowsOf(apply, [], goneSeries);
  if (ofGoneSeries === "gone") return "gone";
  const removedDays: { id: string; uid: string; key: string }[] = [];
  for (const id of [...gone, ...outside]) {
    const was = byProvider.get(id) ?? [];
    for (const row of was) if (row.recurrenceId !== "") removedDays.push({ id, uid: row.uid, key: row.recurrenceId });
    const uids = new Set(was.filter((s) => s.recurrenceId === "").map((s) => s.uid));
    const days = ofGoneSeries.filter((s) => uids.has(s.uid) && s.recurrenceId !== "" && s.providerId !== id).length;
    if (was.length > 0) works.push(objectGone(id, was.length + days, { withDays: apply.unite, dayLeaves: apply.unite }));
    if (was.length === 0 || was.some((s) => s.recurrenceId !== "")) needsWholeRead = true;
  }
  const seriesStored = new Set(stored.filter((s) => s.recurrenceId === "").map((s) => s.uid));
  const held: { uid: string; key: string; time: EventTime }[] = [];
  for (const c of cancels) {
    // The day's own changed rows go with it, also where their series is not stored.
    const rows = stored.filter((s) => s.uid === c.uid && s.recurrenceId === c.key).length;
    if (seriesStored.has(c.uid) || seriesHere.has(c.uid) || rows > 0) works.push(dayCancelled(c, rows));
    else held.push(c);
  }
  return { works, unkept, held, needsWholeRead, unorderedReply, removed: [...gone], removedDays };
}

/** Repeated representations of one Graph revision are one candidate for that provider ID. */
function revisionCopies(items: readonly Upsert[]): readonly Upsert[] {
  const byRevision = new Map<string, Upsert>();
  for (const item of items) {
    const key = JSON.stringify([item.version, item.selfResponse]);
    byRevision.set(key, item);
  }
  return [...byRevision.values()];
}

/** Opaque revisions cannot order a changing self-response across a readback and a streamed page. */
function changedSelfResponse(rows: readonly MappedRow[], stored: readonly StoredRow[]): boolean {
  return rows.some(({ values }) => values.status !== "cancelled" && stored.some((row) =>
    row.uid === values.uid && row.recurrenceId === values.recurrenceId &&
    row.myAnswer !== null && row.myAnswer !== values.myAnswer));
}

/**
 * Works in transactions of at most the store's bound of changes, in order, an object kept
 * together where it fits. One larger than the bound alone is cut into parts; each part reads the
 * object's rows again, so each is right on its own.
 */
export function chunksOf(works: readonly Work[]): Work[][] {
  const out: Work[][] = [];
  let chunk: Work[] = [];
  let size = 0;
  const close = (): void => {
    if (chunk.length > 0) out.push(chunk);
    chunk = [];
    size = 0;
  };
  for (const w of works) {
    for (const part of partsOf(w)) {
      if (size + part.changes > CALENDAR_CHANGES_PER_TRANSACTION) close();
      chunk.push(part);
      size += part.changes;
    }
  }
  close();
  return out;
}

/** An object past the bound as parts that each fit: its rows a bound at a time, then the stored rows it leaves out. */
function partsOf(w: Work): Work[] {
  if (w.changes <= CALENDAR_CHANGES_PER_TRANSACTION) return [w];
  if (w.kind === "object") {
    const parts: Work[] = [];
    for (let i = 0; i < w.rows.length; i += CALENDAR_CHANGES_PER_TRANSACTION / 2) {
      const rows = w.rows.slice(i, i + CALENDAR_CHANGES_PER_TRANSACTION / 2);
      parts.push({ ...w, rows, missing: 0, changes: rows.length * 2 });
    }
    // The stored rows no occurrence of the object names are finalized last, a bound at a time.
    for (let n = w.missing; n > 0; n -= CALENDAR_CHANGES_PER_TRANSACTION) {
      const missing = Math.min(n, CALENDAR_CHANGES_PER_TRANSACTION);
      parts.push({ ...w, rows: [], missing, changes: missing });
    }
    return parts;
  }
  if (w.kind === "gone") {
    const parts: Work[] = [];
    // Each part reads the object's rows again and takes the next of them, the series' own row last.
    const most = CALENDAR_CHANGES_PER_TRANSACTION / (w.dayLeaves ? 2 : 1);
    for (let n = w.rows; n > 0; n -= most) parts.push(objectGone(w.providerId, Math.min(n, most), w));
    return parts;
  }
  return [w];
}

/**
 * The stored rows of these provider ids, and of these UIDs, in one read of one bound transaction:
 * a slice of ids a statement, since a subscription's one page may name a hundred thousand. An id or
 * a UID the store cannot hold as it is names no row of it, and is not asked for: the question
 * itself would be refused, and the turn with it.
 */
export async function storedRowsOf(
  ctx: ApplyContext, providerIds: readonly string[], uids: readonly string[],
): Promise<StoredRow[] | "gone"> {
  if (providerIds.length === 0 && uids.length === 0) return [];
  return inConnection(ctx.db, ctx.key, async ({ tx }) => {
    const pick = {
      id: calEvents.id, providerId: calEvents.providerId, recurrenceId: calEvents.recurrenceId,
      providerModifiedAt: calEvents.providerModifiedAt,
      versionTag: calEvents.versionTag, uid: calEvents.uid, myAnswer: calEvents.myAnswer, partial: calEvents.partial, portableCopy: calEvents.portableCopy, googleDefaultEvent: calEvents.googleDefaultEvent, excludes: sql<boolean>`${calEvents.excludedDates} is not null`, unknownGoogleExclusions,
    };
    const mine = and(eq(calEvents.accountId, ctx.key.accountId), eq(calEvents.calendarId, ctx.calendar.id));
    const found = new Map<string, StoredRow>();
    for (const ids of slicesOf([...new Set(providerIds)].filter(storableKey))) {
      for (const r of await tx.select(pick).from(calEvents).where(and(mine, inArray(calEvents.providerId, ids)))) found.set(r.id, r);
    }
    for (const some of slicesOf([...new Set(uids)].filter(storableKey))) {
      for (const r of await tx.select(pick).from(calEvents).where(and(mine, inArray(calEvents.uid, some)))) found.set(r.id, r);
    }
    return [...found.values()];
  });
}

/**
 * Run `chunks` each in its own transaction, in order. A chunk the store refuses for what one of
 * its rows holds is run again work by work, each alone, and the one refused is left out: a stored
 * object nobody can keep costs itself, never the turn. `gone` and `halted` end the run.
 */
export async function applyChunks(ctx: ApplyContext, chunks: readonly (readonly Work[])[]): Promise<ChunkResult> {
  let changed = 0;
  let refused = 0;
  for (const chunk of chunks) {
    if (ctx.halted()) return { ok: false, why: "halted" };
    const done = await applyOrSplit(ctx, chunk);
    if (!done.ok) return done;
    changed += done.changed;
    refused += done.refused;
  }
  return { ok: true, changed, refused };
}

/**
 * One chunk in one transaction. Where the store refuses one of its works for what a row of that
 * work holds, nothing of the chunk was written: its works are then run each alone, and the one
 * the store refuses alone is left out. Any other failure is thrown as it came.
 */
async function applyOrSplit(ctx: ApplyContext, chunk: readonly Work[]): Promise<ChunkResult> {
  try {
    return await applyChunk(ctx, chunk, null);
  } catch (err) {
    if (!(err instanceof ObjectRefused)) throw err;
  }
  if (chunk.length <= 1) return { ok: true, changed: 0, refused: chunk.length };
  let changed = 0;
  let refused = 0;
  for (const work of chunk) {
    if (ctx.halted()) return { ok: false, why: "halted" };
    const one = await applyOrSplit(ctx, [work]);
    if (!one.ok) return one;
    changed += one.changed;
    refused += one.refused;
  }
  return { ok: true, changed, refused };
}

/**
 * The store refused a statement of one work's own for what its rows hold. The one failure that is
 * answered by leaving an object out; `cause` is the store's error.
 */
export class ObjectRefused extends Error {
  constructor(cause: unknown) {
    super("the store refused an object's own row", { cause });
    this.name = "ObjectRefused";
  }
}

/** One work's own statements, in the caller's transaction. */
async function applyWork(tx: Tx, ctx: ApplyContext, w: Work, changes: CalendarChange[]): Promise<void> {
  if (w.kind === "object") await writeObject(tx, ctx, w, changes);
  else if (w.kind === "gone") await removeObject(tx, ctx, w, changes);
  else if (w.kind === "cancelled") await cancelDay(tx, ctx, w, changes);
  else if (w.kind === "excluded") await excludeDays(tx, ctx, w, changes);
  else if (w.kind === "repoint") await repoint(tx, ctx, w, changes);
  else await bringBack(tx, ctx, w.uid, w.keys, changes);
}

/**
 * One transaction: the works in order, then `last` (the reading's bookkeeping, where this is its
 * last transaction), then the changes as the transaction's last statement. A calendar removed
 * meanwhile refuses the rows by its key: that is `gone`, never a retry.
 *
 * Only a refusal raised by a work's own statements can be that work's content (`ObjectRefused`).
 * The same error from anywhere else in the transaction (its fences, `last`, the change log) is no
 * object's, and is thrown as it came: leaving objects out for it would leave out every one.
 */
export async function applyChunk(
  ctx: ApplyContext, works: readonly Work[], last: ((tx: Tx, changes: CalendarChange[]) => Promise<void>) | null,
): Promise<ChunkResult> {
  try {
    const done = await inConnection(ctx.db, ctx.key, async ({ tx }) => {
      const changes: CalendarChange[] = [];
      for (const w of works) {
        try {
          await applyWork(tx, ctx, w, changes);
        } catch (err) {
          throw isDataRefusal(err) ? new ObjectRefused(err) : err;
        }
      }
      if (last !== null) await last(tx, changes);
      if (changes.length > 0) await recordCalendarChanges(tx as unknown as LedgerTx, ctx.key.accountId, changes);
      return changes.length;
    });
    return done === "gone" ? { ok: false, why: "gone" } : { ok: true, changed: done, refused: 0 };
  } catch (err) {
    if (storeErrorOf(err)?.code === PARENT_GONE) return { ok: false, why: "gone" };
    throw err;
  }
}

/** Postgres' refusal of a row whose parent is gone. */
const PARENT_GONE = "23503";
/** Postgres' refusal of a row that leaves a required column empty: this program's own omission, never one object's content. */
const COLUMN_EMPTY = "23502";

/** The tables an object's own rows are written to. */
const OBJECT_TABLES: ReadonlySet<string> = new Set([calEvents, calAttendees, calAlarms].map((t) => getTableName(t)));

/** The store's own error under what a driver wraps around it: its code and, where the server names one, the table. */
function storeErrorOf(err: unknown): { readonly code: string; readonly table: string | null } | null {
  for (let e: unknown = err, depth = 0; e !== null && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const { code, table_name: table } = e as { code?: unknown; table_name?: unknown };
    if (typeof code === "string" && code !== "") return { code, table: typeof table === "string" ? table : null };
  }
  return null;
}

/**
 * Is this failure of a work's own statement a refusal for what its rows hold? A value no column
 * takes (class 22), or more of them than an index or a statement carries (class 54, and the
 * driver's own count of values); or a rule of one of the tables an object's own rows go to (class
 * 23 there), but neither a parent that is gone nor a required column left empty. Anything else is
 * not about one object and is never answered by leaving one out: a lock, a lost connection, a
 * column this program does not fill. Those are thrown, and a thrown turn says so on its
 * connection. Asked only of what a work's own statements raised ({@link applyChunk}).
 */
function isDataRefusal(err: unknown): boolean {
  const e = storeErrorOf(err);
  if (e === null) return false;
  if (e.code.startsWith("22") || e.code.startsWith("54") || e.code === "MAX_PARAMETERS_EXCEEDED") return true;
  return e.code.startsWith("23") && e.code !== PARENT_GONE && e.code !== COLUMN_EMPTY && e.table !== null && OBJECT_TABLES.has(e.table);
}

/** The columns of an event row as `cal_events` takes them. */
function columnsOf(row: MappedRow, excluded: readonly StoredTime[]) {
  const v = row.values;
  return {
    providerId: v.providerId, versionTag: v.versionTag, uid: v.uid, recurrenceId: v.recurrenceId,
    sequence: v.sequence, status: v.status, title: v.title, notes: v.notes, place: v.place, callLink: v.callLink,
    startKind: v.startKind, startLocal: v.startLocal, startZone: v.startZone,
    endKind: v.endKind, endLocal: v.endLocal, endZone: v.endZone, duration: v.duration,
    thisAndFuture: v.thisAndFuture, startsAt: v.startsAt, endsAt: v.endsAt, occurrenceAt: v.occurrenceAt,
    repeatRule: v.repeatRule, excludedDates: excluded.length > 0 ? [...excluded] : null,
    addedDates: v.addedDates === null ? null : [...v.addedDates],
    busy: v.busy, private: v.private, organizer: v.organizer, organizerName: v.organizerName,
    myAnswer: v.myAnswer, original: v.original, partial: v.partial, portableCopy: v.portableCopy, googleDefaultEvent: v.googleDefaultEvent,
  };
}

/** An event's invitees and reminders, replaced with it. */
async function replaceChildren(tx: Tx, ctx: ApplyContext, eventId: string, row: MappedRow | null): Promise<void> {
  const account = ctx.key.accountId;
  await tx.delete(calAttendees).where(and(eq(calAttendees.accountId, account), eq(calAttendees.eventId, eventId)));
  await tx.delete(calAlarms).where(and(eq(calAlarms.accountId, account), eq(calAlarms.eventId, eventId)));
  if (row === null) return;
  // A slice a statement: nothing bounds how many invitees an event names, and one statement carries only so many values.
  for (const some of slicesOf(row.invitees)) {
    await tx.insert(calAttendees).values(some.map((p) => ({ accountId: account, eventId, ...p })));
  }
  for (const some of slicesOf(row.alarms)) {
    await tx.insert(calAlarms).values(some.map((a) => ({ accountId: account, eventId, calendarId: null, ...a })));
  }
}

/** The object's stored rows under lock, in this calendar of this account. */
async function lockedRows(tx: Tx, ctx: ApplyContext, where: ReturnType<typeof and>, limit?: number) {
  const query = tx.select({
    id: calEvents.id, providerId: calEvents.providerId, recurrenceId: calEvents.recurrenceId,
    providerModifiedAt: calEvents.providerModifiedAt,
    versionTag: calEvents.versionTag, uid: calEvents.uid, myAnswer: calEvents.myAnswer, partial: calEvents.partial, portableCopy: calEvents.portableCopy, googleDefaultEvent: calEvents.googleDefaultEvent, excludedDates: calEvents.excludedDates,
    startsAt: calEvents.startsAt, endsAt: calEvents.endsAt, repeatRule: calEvents.repeatRule,
    updatedAt: calEvents.updatedAt, seenInReading: calEvents.seenInReading,
    googleExclusionSources: calEvents.googleExclusionSources, unknownGoogleExclusions,
  }).from(calEvents).where(and(eq(calEvents.accountId, ctx.key.accountId), eq(calEvents.calendarId, ctx.calendar.id), where));
  return dialect(tx).forUpdate(limit === undefined ? query : query.limit(limit), { mode: "update" });
}

export class StaleOutlookReply extends Error {
  constructor(readonly older: boolean) {
    super();
  }
}

async function writeObject(tx: Tx, ctx: ApplyContext, w: ObjectWrite, changes: CalendarChange[]): Promise<void> {
  const stored = await lockedRows(tx, ctx, eq(calEvents.providerId, w.providerId));
  const needsGoogleSources = ctx.googleSnapshot != null && stored.some((s) => s.unknownGoogleExclusions);
  if (!needsGoogleSources && w.rows.length === w.keep.size && storedAsIs(w.rows, stored, ctx.outlook !== undefined)) return;
  const byKey = new Map(stored.map((s) => [s.recurrenceId, s]));
  for (const row of w.rows) {
    const was = byKey.get(row.values.recurrenceId);
    const modified = row.values.providerModifiedAt;
    const sameObject = was?.uid === row.values.uid;
    const heldModified = sameObject ? was.providerModifiedAt : null;
    if (ctx.outlook && sameObject) {
      const older = heldModified !== null && modified !== null && heldModified > modified;
      const newer = heldModified !== null && modified !== null && heldModified < modified;
      const conflict = ctx.outlook === "confirmation" && was.myAnswer !== null && row.values.myAnswer !== was.myAnswer;
      if (conflict && (older || (was.myAnswer !== "none" && !newer))) {
        throw new StaleOutlookReply(older);
      }
      if (older) continue;
      if (modified !== null && (heldModified === null || newer) && storedAsIs([row], [was])) {
        await tx.update(calEvents).set({ providerModifiedAt: modified })
          .where(and(eq(calEvents.id, was.id), eq(calEvents.accountId, ctx.key.accountId)));
        continue;
      }
    }
    const google = ctx.googleSnapshot !== undefined && row.values.recurrenceId === ""
      ? { ...googleSources(ctx, was), master: row.values.excludedDates }
      : undefined;
    const held = times(was?.excludedDates);
    const excluded = google !== undefined ? combinedGoogleExclusions(ctx, google, held)
      : ctx.unite && was !== undefined ? united(row.values.excludedDates, held, ctx.zones) : row.values.excludedDates;
    const columns = {
      ...columnsOf(row, excluded), ...(google === undefined ? {} : { googleExclusionSources: google }),
      ...(ctx.outlook && { providerModifiedAt: modified ?? heldModified }),
    };
    let eventId: string;
    if (was === undefined) {
      const [made] = await tx.insert(calEvents).values({
        ...columns, accountId: ctx.key.accountId, calendarId: ctx.calendar.id,
      }).returning({ id: calEvents.id });
      eventId = made!.id;
      changes.push({ kind: "calendar_event", id: eventId, op: "create" });
    } else {
      eventId = was.id;
      await tx.update(calEvents).set({ ...columns, updatedAt: sql`now()` })
        .where(and(eq(calEvents.id, eventId), eq(calEvents.accountId, ctx.key.accountId)));
      changes.push({ kind: "calendar_event", id: eventId, op: "update" });
    }
    await replaceChildren(tx, ctx, eventId, row);
    if (row.values.recurrenceId !== "" && (ctx.unite || !w.keep.has("")))
      await reflectException(tx, ctx, row.values, changes);
  }
  let budget = w.missing;
  for (const s of stored) {
    if (w.keep.has(s.recurrenceId) || budget <= 0) continue;
    if (w.incomplete) {
      if (s.partial) continue;
      await tx.update(calEvents).set({ partial: true, updatedAt: sql`now()` })
        .where(and(eq(calEvents.id, s.id), eq(calEvents.accountId, ctx.key.accountId)));
      changes.push({ kind: "calendar_event", id: s.id, op: "update" });
    } else await removeRow(tx, ctx, s.id, changes);
    budget -= 1;
  }
}

async function repoint(tx: Tx, ctx: ApplyContext, w: Repointed, changes: CalendarChange[]): Promise<void> {
  for (const held of await lockedRows(tx, ctx, eq(calEvents.providerId, w.providerId))) {
    if (held.id !== w.eventId) await removeRow(tx, ctx, held.id, changes);
  }
  await tx.update(calEvents).set({ providerId: w.providerId, uid: w.uid, versionTag: null, providerModifiedAt: null, updatedAt: sql`now()` })
    .where(and(eq(calEvents.id, w.eventId), eq(calEvents.accountId, ctx.key.accountId), eq(calEvents.calendarId, ctx.calendar.id)));
  if (!changes.some((c) => c.id === w.eventId)) changes.push({ kind: "calendar_event", id: w.eventId, op: "update" });
}

/** The series' own row of a UID, under lock, or none. */
async function seriesRow(tx: Tx, ctx: ApplyContext, uid: string) {
  const [series] = await lockedRows(tx, ctx, and(eq(calEvents.uid, uid), eq(calEvents.recurrenceId, "")));
  return series;
}

/** The series' excluded days written, with the one change a transaction records for the row. */
async function writeExcluded(
  tx: Tx, ctx: ApplyContext, seriesId: string, now: readonly StoredTime[], changes: CalendarChange[],
  google?: { readonly sources: GoogleExclusionSources; readonly visible: boolean },
): Promise<void> {
  const visible = google?.visible ?? true;
  await tx.update(calEvents).set({
    ...(visible && { excludedDates: now.length > 0 ? [...now] : null, updatedAt: sql`now()` }),
    ...(google && { googleExclusionSources: google.sources }),
  })
    .where(and(eq(calEvents.id, seriesId), eq(calEvents.accountId, ctx.key.accountId)));
  if (visible && !changes.some((c) => c.id === seriesId)) changes.push({ kind: "calendar_event", id: seriesId, op: "update" });
}

/** Save provenance even when the user-facing set of dates has stayed the same. */
async function writeGoogleExclusions(
  tx: Tx, ctx: ApplyContext, row: GoogleExclusionRow & { readonly id: string },
  sources: GoogleExclusionSources, held: readonly StoredTime[], changes: CalendarChange[],
): Promise<void> {
  const now = combinedGoogleExclusions(ctx, sources, held);
  const was = times(row.excludedDates);
  const keys = new Set(was.map((day) => keyOfStored(day, ctx.zones)));
  const visible = now.length !== was.length || now.some((day) => !keys.has(keyOfStored(day, ctx.zones)));
  await writeExcluded(tx, ctx, row.id, now, changes, { sources, visible });
}

export async function hasUnknownGoogleExclusions(db: ConnectionDb, key: ConnectionKey, calendarId: string): Promise<boolean | "gone"> {
  return inConnection(db, key, async ({ tx }) => {
    const [row] = await tx.select({ id: calEvents.id }).from(calEvents).where(and(
      eq(calEvents.accountId, key.accountId), eq(calEvents.calendarId, calendarId),
      eq(calEvents.recurrenceId, ""), unknownGoogleExclusions,
    )).limit(1);
    return row !== undefined;
  });
}

/** Drop historical exclusions only after every page of the inventory has been accepted. */
export async function settleGoogleExclusions(ctx: ApplyContext, generation: string): Promise<ChunkResult> {
  let changed = 0;
  for (;;) {
    if (ctx.halted()) return { ok: false, why: "halted" };
    let remaining = false;
    const done = await applyChunk(ctx, [], async (tx, changes) => {
      const rows = await lockedRows(tx, ctx, and(eq(calEvents.seenInReading, generation),
        sql`${calEvents.googleExclusionSources}->>'legacy' = ${generation}`,
        sql`jsonb_typeof(${calEvents.googleExclusionSources}->'master') = 'array'`), CALENDAR_CHANGES_PER_TRANSACTION);
      remaining = rows.length === CALENDAR_CHANGES_PER_TRANSACTION;
      for (const row of rows) {
        const { master, cancelled } = googleSources(ctx, row);
        await writeGoogleExclusions(tx, ctx, row, { master, cancelled }, [], changes);
      }
    });
    if (!done.ok) return done;
    changed += done.changed;
    if (!remaining) return { ok: true, changed, refused: 0 };
  }
}

/** Let the device recover the series of an exception that can be visible outside its range. */
async function reflectException(
  tx: Tx, ctx: ApplyContext, row: MappedRow["values"], changes: CalendarChange[],
): Promise<void> {
  const series = await seriesRow(tx, ctx, row.uid);
  if (!series) return;
  if (ctx.unite) await restoreExcluded(tx, ctx, series, new Set([row.recurrenceId]), changes);
  if (series.repeatRule === null || row.status === "cancelled" || row.thisAndFuture) return;
  const outside = row.startsAt < series.startsAt ||
    (series.endsAt !== null && (row.endsAt === null || row.endsAt > series.endsAt));
  if (outside && !changes.some((change) => change.id === series.id))
    changes.push({ kind: "calendar_event", id: series.id, op: "update" });
}

/** These days back among a series' days: their keys out of its excluded days, where they stood there. */
async function bringBack(tx: Tx, ctx: ApplyContext, uid: string, keys: ReadonlySet<string>, changes: CalendarChange[]): Promise<void> {
  const series = await seriesRow(tx, ctx, uid);
  if (series) await restoreExcluded(tx, ctx, series, keys, changes);
}

async function restoreExcluded(
  tx: Tx, ctx: ApplyContext, series: NonNullable<Awaited<ReturnType<typeof seriesRow>>>,
  keys: ReadonlySet<string>, changes: CalendarChange[],
): Promise<void> {
  const was = times(series.excludedDates);
  const retain = (t: StoredTime): boolean => {
    const key = keyOfStored(t, ctx.zones);
    return key === null || !keys.has(key);
  };
  const now = was.filter(retain);
  if (ctx.googleSnapshot !== undefined) {
    if (now.length === was.length) return;
    const sources = googleSources(ctx, series);
    await writeGoogleExclusions(tx, ctx, series, { ...sources, cancelled: sources.cancelled.filter(retain) }, now, changes);
    return;
  }
  if (now.length !== was.length) await writeExcluded(tx, ctx, series.id, now, changes);
}

/** One day out of a series' days: `time`, whose key is `key`, among its excluded days, once. */
async function leaveOut(tx: Tx, ctx: ApplyContext, uid: string, key: string, time: EventTime, changes: CalendarChange[]): Promise<void> {
  const series = await seriesRow(tx, ctx, uid);
  if (series === undefined) return;
  const was = times(series.excludedDates);
  if (ctx.googleSnapshot !== undefined) {
    const sources = googleSources(ctx, series);
    if (sources.cancelled.some((day) => keyOfStored(day, ctx.zones) === key)) return;
    await writeGoogleExclusions(tx, ctx, series, { ...sources, cancelled: [...sources.cancelled, storedTimeOf(time)] }, was, changes);
    return;
  }
  if (was.some((t) => keyOfStored(t, ctx.zones) === key)) return;
  await writeExcluded(tx, ctx, series.id, [...was, storedTimeOf(time)], changes);
}

async function removeRow(tx: Tx, ctx: ApplyContext, eventId: string, changes: CalendarChange[]): Promise<void> {
  await replaceChildren(tx, ctx, eventId, null);
  await tx.delete(calEvents).where(and(eq(calEvents.id, eventId), eq(calEvents.accountId, ctx.key.accountId)));
  changes.push({ kind: "calendar_event", id: eventId, op: "delete" });
}

/**
 * The rows of an object, at most `w.rows` of them in this transaction, and what follows from their
 * going where a changed day is an object of its own (see {@link ObjectGone}). A series' own row
 * goes last, so that a removal cut in parts still finds the series' days by it.
 */
async function removeObject(tx: Tx, ctx: ApplyContext, w: ObjectGone, changes: CalendarChange[]): Promise<void> {
  const own = await lockedRows(tx, ctx, eq(calEvents.providerId, w.providerId));
  if (w.absence !== undefined) {
    const { startedAt, plan } = w.absence;
    if (own.length === 0 || own.some((row) => row.seenInReading !== plan || row.updatedAt >= startedAt)) return;
    // The write service also locks these event rows before queuing an act.
    const [waiting] = await tx.select({ id: calWrites.id }).from(calWrites)
      .innerJoin(calEvents, and(eq(calEvents.accountId, calWrites.accountId), eq(calEvents.id, calWrites.eventId)))
      .where(and(eq(calEvents.accountId, ctx.key.accountId), eq(calEvents.calendarId, ctx.calendar.id),
        eq(calEvents.providerId, w.providerId), owedWrite())).limit(1);
    if (waiting !== undefined) return;
  }
  const series = own.find((s) => s.recurrenceId === "");
  const days = ctx.unite && w.withDays && series !== undefined
    ? (await lockedRows(tx, ctx, and(eq(calEvents.uid, series.uid), ne(calEvents.recurrenceId, "")))).filter((d) => d.providerId !== w.providerId)
    : [];
  const going = [...days, ...own.filter((s) => s !== series), ...(series === undefined ? [] : [series])];
  for (const s of going.slice(0, w.rows)) {
    await removeRow(tx, ctx, s.id, changes);
    // A changed day whose series stays: its day leaves the series too, unless this reading showed that day.
    if (!ctx.unite || !w.dayLeaves || series !== undefined || s.recurrenceId === "") continue;
    if (ctx.shown?.get(s.uid)?.has(s.recurrenceId)) continue;
    const time = timeOfKey(s.recurrenceId);
    if (time !== null && occurrenceKey(time, ctx.zones) === s.recurrenceId) await leaveOut(tx, ctx, s.uid, s.recurrenceId, time, changes);
  }
}

/** A cancelled day: out of its series' days where the series is stored, and the changed rows of that day go, at most as many as the work counted. */
async function cancelDay(tx: Tx, ctx: ApplyContext, w: DayCancelled, changes: CalendarChange[]): Promise<void> {
  await leaveOut(tx, ctx, w.uid, w.key, w.time, changes);
  const changed = await lockedRows(tx, ctx, and(eq(calEvents.uid, w.uid), eq(calEvents.recurrenceId, w.key)));
  for (const c of changed.slice(0, w.changes - 1)) await removeRow(tx, ctx, c.id, changes);
}

async function excludeDays(tx: Tx, ctx: ApplyContext, w: DaysExcluded, changes: CalendarChange[]): Promise<void> {
  const [series] = await lockedRows(tx, ctx, eq(calEvents.id, w.eventId));
  if (series === undefined) return;
  const was = times(series.excludedDates);
  const now = united(was, w.times.map(storedTimeOf), ctx.zones);
  if (now.length !== was.length) await writeExcluded(tx, ctx, series.id, now, changes);
}

/** An object selected for removal during a whole reading. */
export interface DropCandidate {
  readonly providerId: string;
  readonly rows: number;
}

function owedWrite() {
  return or(eq(calWrites.state, "pending"), and(eq(calWrites.state, "refused"), eq(calWrites.op, "create")));
}

const calendarEvents = (ctx: ApplyContext) => and(eq(calEvents.accountId, ctx.key.accountId), eq(calEvents.calendarId, ctx.calendar.id));

export async function countStoredObjects(ctx: ApplyContext): Promise<number | "gone"> {
  return inConnection(ctx.db, ctx.key, async ({ tx }) => {
    const [row] = await tx.select({ count: sql<number>`count(distinct ${calEvents.providerId})::int` })
      .from(calEvents).where(calendarEvents(ctx));
    return row!.count;
  });
}

interface AbsencePlan {
  readonly generation: string;
  readonly plan: string;
  readonly startedAt: Date;
  readonly window: { readonly start: number; readonly end: number } | null;
}

/** Mark each planned group in provider ID order. Only rows missing from the reading get a plan mark. */
export async function planMissingObjects(ctx: ApplyContext, scope: AbsencePlan, after: string | null): Promise<DropCandidate[] | "gone"> {
  return inConnection(ctx.db, ctx.key, async ({ tx }) => {
    const at = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;
    const stillMissing = sql`${calEvents.seenInReading} is distinct from ${scope.generation}::uuid`;
    const old = sql`${calEvents.updatedAt} < ${at(scope.startedAt)}`;
    const touches = scope.window === null ? undefined : sql`
      bool_or(${calEvents.startsAt} < ${at(new Date(scope.window.end))}
        and (${calEvents.endsAt} is null or ${calEvents.endsAt} > ${at(new Date(scope.window.start))}))`;
    const rows = await objectBatch(tx, ctx, after)
      .leftJoin(calWrites, and(eq(calWrites.accountId, ctx.key.accountId), eq(calWrites.eventId, calEvents.id), owedWrite()))
      .having(and(sql`bool_and(${stillMissing} and ${old})`, touches, sql`count(${calWrites.id}) = 0`));
    if (rows.length > 0) {
      await tx.update(calEvents).set({ seenInReading: scope.plan }).where(and(
        calendarEvents(ctx), inArray(calEvents.providerId, rows.map((row) => row.providerId)), stillMissing, old,
      ));
    }
    return rows;
  });
}

/** Walk only the marked plan. A newly eligible object cannot join a confirmed deletion set. */
export async function plannedMissingObjects(ctx: ApplyContext, plan: string, after: string | null): Promise<DropCandidate[] | "gone"> {
  return inConnection(ctx.db, ctx.key, ({ tx }) => objectBatch(tx, ctx, after, eq(calEvents.seenInReading, plan)));
}

function objectBatch(tx: Tx, ctx: ApplyContext, after: string | null, where?: SQL) {
  return tx.select({ providerId: calEvents.providerId, rows: sql<number>`count(*)::int` })
    .from(calEvents).where(and(calendarEvents(ctx), after === null ? undefined : gt(calEvents.providerId, after), where))
    .groupBy(calEvents.providerId).orderBy(calEvents.providerId).limit(CALENDAR_CHANGES_PER_TRANSACTION);
}
