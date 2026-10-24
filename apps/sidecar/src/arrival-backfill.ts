import { and, desc, eq, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { folderState, mailboxes, messages, recordChanges, type LedgerTx, type Tx } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { GAP_CLOCK_ALLOWANCE_MS, instantOf } from "@trafficflow/worker/gap-catchup";

/* ARRIVAL TIMES A PHONE LOST. Before the engine read INTERNALDATE by hand, every letter a phone took
   in was stored with `arrived_at` NULL (its JS engine refused the RFC 3501 form), so the gap window
   and the arrival order skipped or misplaced it. This walk asks the server for those letters'
   INTERNALDATE and writes it where the row still has none: only the server's date, never the header
   or the intake time, and only for rows taken in after mail 0119 (older rows keep their header-keyed
   place by design). Read-only on IMAP; each filled row is a message change in its own transaction. */

/** Rows asked per drain: one page of the walk. */
export const ARRIVAL_PAGE = 500;
/** Rows written per store transaction. */
export const ARRIVAL_WRITE_ROWS = 100;
/** An open window's intake asked in one step. */
export const ARRIVAL_WINDOW_ROWS = 2_000;
/** Failed window steps in one process before the window is let go unasked. */
export const ARRIVAL_WINDOW_TRIES = 3;

/** The one IMAP read this walk makes ({@link ImapAdapter.readArrivals}). */
export interface ArrivalReader {
  readArrivals(folder: string, uidValidity: string, uids: readonly number[]): Promise<Map<number, Date>>;
}

export interface ArrivalBackfill {
  /** One bounded step: the open window's intake while it waits, else one page of the walk. */
  step(io: ArrivalReader): Promise<void>;
  /** Does the open window hold letters with no arrival time this process has not asked about yet? */
  withholds(): Promise<boolean>;
}

interface Row { id: string; createdAt: Date; locator: unknown }

/** `{ folder, ref: "<uidvalidity>:<uid>" }`, or null for anything else. */
function placeOf(locator: unknown): { folder: string; epoch: string; uid: number } | null {
  const l = (typeof locator === "string" ? safeJson(locator) : locator) as { folder?: unknown; ref?: unknown } | null;
  if (l === null || typeof l !== "object" || typeof l.folder !== "string" || typeof l.ref !== "string") return null;
  const [epoch, u] = l.ref.split(":");
  const uid = Number(u);
  return epoch && Number.isInteger(uid) && uid > 0 ? { folder: l.folder, epoch, uid } : null;
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

export function arrivalBackfill(o: {
  db: Tx;
  accountId: string;
  mailboxId: string;
  /** Rows taken in before this instant are never asked (mail 0119's own entry). */
  floor: Date;
  /** The store lane the reads and writes run in; the IMAP read never does. */
  lane: <T>(fn: () => Promise<T>) => Promise<T>;
  log: (event: string, detail: Record<string, unknown>) => void;
}): ArrivalBackfill {
  const { db, accountId, mailboxId } = o;
  const d = dialect(db);
  /** Windows (by `gap_since`, ms) whose intake was asked in this process. */
  const asked = new Set<number>();
  const tries = new Map<number, number>();
  /** The walk's keyset: every row older than this was asked once in this process. */
  let cursor: { at: Date; id: string } | null = null;
  let done = false;

  const openWindow = async (): Promise<number | null> => {
    const [r] = await db.select({ since: mailboxes.gapSince }).from(mailboxes)
      .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId)));
    return instantOf(r?.since)?.getTime() ?? null;
  };

  const owed = (): SQL[] => [
    eq(messages.accountId, accountId),
    eq(messages.mailboxId, mailboxId),
    isNull(messages.arrivedAt),
    isNotNull(messages.nativeLocator),
    isNull(messages.serverMissingAt),
    isNull(messages.deletedAt),
    sql`${messages.createdAt} >= ${d.ts(o.floor)}`,
  ];

  /** The window's intake with no arrival: `sayUnarrived`'s predicate, read with the clock allowance. */
  const windowRows = (since: number, limit = ARRIVAL_WINDOW_ROWS): Promise<Row[]> => db.select({
    id: messages.id, createdAt: messages.createdAt, locator: messages.nativeLocator,
  }).from(messages)
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(and(
      ...owed(),
      eq(folderState.lastSetBy, "peer"),
      eq(folderState.observedFolder, "INBOX"),
      sql`${messages.createdAt} >= ${d.ts(new Date(since))} - ${d.interval(GAP_CLOCK_ALLOWANCE_MS)}`,
    ))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit) as Promise<Row[]>;

  const pageRows = (): Promise<Row[]> => db.select({
    id: messages.id, createdAt: messages.createdAt, locator: messages.nativeLocator,
  }).from(messages)
    .where(and(...owed(), ...(cursor === null ? [] : [or(
      lt(messages.createdAt, cursor.at),
      and(eq(messages.createdAt, cursor.at), lt(messages.id, d.castUuid(cursor.id))),
    )!])))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(ARRIVAL_PAGE) as Promise<Row[]>;

  /** Ask the server, per folder and generation, then write what it answered; the count filled. */
  const fill = async (io: ArrivalReader, rows: readonly Row[]): Promise<number> => {
    const groups = new Map<string, { folder: string; epoch: string; byUid: Map<number, string> }>();
    for (const r of rows) {
      const p = placeOf(r.locator);
      if (p === null) continue;
      const key = `${p.epoch}\u0000${p.folder}`;
      const g = groups.get(key) ?? { folder: p.folder, epoch: p.epoch, byUid: new Map<number, string>() };
      g.byUid.set(p.uid, r.id);
      groups.set(key, g);
    }
    const found: Array<{ id: string; at: Date }> = [];
    for (const g of groups.values()) {
      const dates = await io.readArrivals(g.folder, g.epoch, [...g.byUid.keys()]);
      for (const [uid, at] of dates) {
        const id = g.byUid.get(uid);
        if (id !== undefined) found.push({ id, at });
      }
    }
    let filled = 0;
    for (let i = 0; i < found.length; i += ARRIVAL_WRITE_ROWS) {
      const chunk = found.slice(i, i + ARRIVAL_WRITE_ROWS);
      filled += await o.lane(() => db.transaction(async (tx) => {
        const ids: string[] = [];
        for (const f of chunk) {
          const hit = await tx.update(messages).set({ arrivedAt: f.at })
            .where(and(eq(messages.id, f.id), eq(messages.accountId, accountId), eq(messages.mailboxId, mailboxId),
              isNull(messages.arrivedAt)))
            .returning({ id: messages.id });
          if (hit.length > 0) ids.push(f.id);
        }
        await recordChanges(tx as unknown as LedgerTx, ids.map((id) => ({
          accountId, entityType: "message" as const, entityId: id, op: "update" as const,
        })));
        return ids.length;
      }));
    }
    return filled;
  };

  return {
    async withholds(): Promise<boolean> {
      const since = await openWindow();
      return since !== null && !asked.has(since) && (await windowRows(since, 1)).length > 0;
    },

    async step(io: ArrivalReader): Promise<void> {
      const since = await o.lane(openWindow);
      if (since !== null && !asked.has(since)) {
        try {
          const rows = await o.lane(() => windowRows(since));
          const filled = rows.length === 0 ? 0 : await fill(io, rows);
          asked.add(since);
          if (rows.length > 0) {
            o.log("arrival_backfill", { mailboxId, phase: "window", count: rows.length, resolved: filled });
          }
        } catch (err) {
          const n = (tries.get(since) ?? 0) + 1;
          tries.set(since, n);
          if (n >= ARRIVAL_WINDOW_TRIES) asked.add(since);
          o.log("arrival_backfill_failed", {
            err, mailboxId, phase: "window", attempts: n,
            reason: n >= ARRIVAL_WINDOW_TRIES
              ? "the arrival times of the letters in the open gap window could not be read, so the window "
                + "is counted with what it has; letters without one stay in the inbox"
              : "the arrival times of the letters in the open gap window could not be read; the next drain asks again",
          });
        }
        return;
      }
      if (done) return;
      const rows = await o.lane(pageRows);
      if (rows.length < ARRIVAL_PAGE) done = true;
      if (rows.length === 0) return;
      const last = rows[rows.length - 1]!;
      const at = last.createdAt instanceof Date ? last.createdAt : instantOf(last.createdAt);
      try {
        const filled = await fill(io, rows);
        o.log("arrival_backfill", { mailboxId, phase: "walk", count: rows.length, resolved: filled });
        // Asked once per process: a row the server cannot date is not asked again.
        if (at !== null) cursor = { at, id: last.id };
        else done = true;
      } catch (err) {
        done = false;
        o.log("arrival_backfill_failed", {
          err, mailboxId, phase: "walk", attempts: 1,
          reason: "the arrival times of older letters could not be read this drain; the next drain asks again",
        });
      }
    },
  };
}
