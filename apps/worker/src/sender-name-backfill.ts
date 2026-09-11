import { and, asc, eq, sql } from "drizzle-orm";
import { messageBodies, messages, recordChanges, type LedgerTx, type Tx } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
/* `@trafficflow/core/mail` AND NOT THE BARE BARREL, which is a packaging constraint rather than a
   style one and it was measured here rather than inherited. The desktop engine bundles this module,
   and the barrel's index re-exports the AI half: importing four symbols through it pulled the
   classifier, the drafter and the workflow runner into the bundle, and the runner reaches the
   hosted half of the database — the billing tables, the staff grants and a server-side driver the
   desktop has no use for. The engine build refuses an artifact carrying any of that, correctly, and
   the refusal named two dozen extra inputs for four symbols that live in the mail half all along.
   `mail.ts` re-exports `mime.ts` and `log.ts`, which is where all four are. */
import {
  parseStoredAddressHeaders, silentLogger, type EmailAddress, type Logger,
} from "@trafficflow/core/mail";

/* THE SENDER-NAME / RECIPIENTS BACKFILL — DB-only. Three columns went in after the rows that need them:
 * `messages.from_name` (a later migration; earlier rows reached the reader as a bare address) and
 * `messages.to_addresses`/`cc_addresses` (columns existed, but no ingest wrote them until `commitChange`
 * named them). Repaired from the source the store still holds — `message_bodies.headers`, the raw bag
 * `normalizeMime` wrote — via `parseStoredAddressHeaders` (`packages/core/src/mime.ts`, sharing
 * `simpleParser`/`PARSE_OPTIONS` with ingest so the two populations cannot disagree, and a real parse, not
 * a split — RFC 2047 words, quoted commas, folded lines). ONLY FILLS, never overwrites (guarded on
 * `from_name IS NULL`/`to_addresses = '[]'`/`cc_addresses = '[]'`, repeated in the UPDATE). KEYSET
 * pagination (`id > last`), not predicate extinction, because unfillable rows stay candidates;
 * {@link SenderNameBackfillDeps.startAfterId}/`cursor`/`exhausted` are the handover. Each written row appends a `change_log` `message` update; lock order: `messages` first, `allocateSeq` last. */

/** Rows read per page — one transaction per page in apply mode. */
export const SENDER_NAME_BACKFILL_BATCH = 200;

export interface SenderNameBackfillDeps {
  db: Tx;
  /** False ⇒ dry run: count and report, write nothing. */
  apply: boolean;
  log?: Logger;
  batch?: number;
  /** Stop after reading this many candidate rows. Absent ⇒ the whole table. */
  maxRows?: number;
  /**
   * Begin the keyset walk strictly AFTER this message id. Absent ⇒ from the beginning.
   *
   * The resume handover for a caller that runs this in bounded visits — see the header. It is a
   * position in the `id` ordering and nothing else: it is not a claim that everything below it is
   * repaired (a visit may have lost rows to a competing writer), so a caller that wants those back
   * starts a fresh walk rather than trusting this. Which is precisely what a relaunch does.
   */
  startAfterId?: string;
  /**
   * Restrict the walk to one account. Absent ⇒ every account.
   *
   * An operator lever before it is a test one: the change-log rows this pass writes are the
   * user-visible half of it, and one account at a time is how you watch a mirror converge before
   * committing the rest of the table to the same treatment.
   */
  accountId?: string;
  /**
   * Called with the page's ids after it is read and parsed, before the write transaction opens. A TEST
   * SEAM, and it exists because the property cannot be observed otherwise: the page SELECT runs OUTSIDE the
   * transaction (a read of hundreds of rows holding locks would block ingest), so there is a real window in
   * which another writer can fill a column this pass has already decided to write. The guarded UPDATE makes
   * that harmless, and a guard nobody has watched fail is not evidence — this hook is how the pg test lands
   * a competing write inside that exact window. Production passes nothing and pays one `undefined` check per page.
   */
  onPageRead?: (ids: readonly string[]) => Promise<void> | void;
}

export interface SenderNameBackfillResult {
  /** Candidate rows read (a column unset AND the header that would fill it present). */
  scanned: number;
  /** Rows where the parse produced at least one fillable value (dry run: would produce). */
  fillable: number;
  /** Rows actually written (dry run: 0). One `change_log` `message` update each. */
  written: number;
  /** Of `fillable`, how many offered each column. Counted per column, so they overlap. */
  fromName: number;
  toAddresses: number;
  ccAddresses: number;
  /** Rows whose `from` header carried no display name — correctly left NULL. */
  noDisplayName: number;
  /** Rows whose headers would not parse. Skipped, never guessed at. */
  parseFailures: number;
  /** Rows a concurrent writer took between the read and the guarded UPDATE. */
  skipped: number;
  /**
   * The last candidate id this run READ, or `null` when it read none.
   *
   * Feed it back as {@link SenderNameBackfillDeps.startAfterId} to continue the same walk. Note
   * "read", not "wrote": a page whose rows were all unfillable still advances this, which is the
   * whole point — the unfillable rows are exactly what a restarting walk would re-read for ever.
   */
  cursor: string | null;
  /**
   * Did the walk end because a page came back EMPTY — i.e. there is nothing after {@link cursor}?
   *
   * False means it ended on its `maxRows` budget with the table possibly unfinished. This is the
   * only completion signal, and it is deliberately not derivable from the counts: `written === 0`
   * happens on a page of rows a competitor took, and `scanned < maxRows` cannot happen at all when
   * the budget is a multiple of the batch and the last page is full.
   */
  exhausted: boolean;
}

/** One candidate row, with only the three header keys pulled out of the jsonb server-side. */
interface Candidate {
  id: string;
  accountId: string;
  fromName: string | null;
  toEmpty: boolean;
  ccEmpty: boolean;
  hFrom: string[] | null;
  hTo: string[] | null;
  hCc: string[] | null;
}

/** The subset of columns a row turned out to be able to fill. Empty ⇒ nothing to write. */
interface Fill {
  fromName?: string;
  toAddresses?: EmailAddress[];
  ccAddresses?: EmailAddress[];
}

function asStringArray(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
}

/**
 * Fill `from_name`, `to_addresses` and `cc_addresses` on every message whose stored headers can
 * supply them and whose column is still unset. Idempotent, resumable (re-run it), and safe to
 * kill: each page is its own transaction and a killed run leaves the pages it committed.
 */
export async function runSenderNameBackfill(
  deps: SenderNameBackfillDeps,
): Promise<SenderNameBackfillResult> {
  const { db, apply } = deps;
  const log = deps.log ?? silentLogger;
  const batch = deps.batch ?? SENDER_NAME_BACKFILL_BATCH;

  const r: SenderNameBackfillResult = {
    scanned: 0, fillable: 0, written: 0,
    fromName: 0, toAddresses: 0, ccAddresses: 0,
    noDisplayName: 0, parseFailures: 0, skipped: 0,
    // `cursor` starts at the caller's resume point so that a visit which reads NOTHING hands back
    // the position it was given rather than `null`. Handing back `null` would restart the next
    // visit at the beginning of the table, which is the exact degradation `startAfterId` exists to
    // avoid — and it would do it silently, on the one visit that looks like it did no work.
    cursor: deps.startAfterId ?? null,
    exhausted: false,
  };
  let cursor: string | null = deps.startAfterId ?? null;

  for (;;) {
    if (deps.maxRows !== undefined && r.scanned >= deps.maxRows) break;
    const limit = deps.maxRows === undefined
      ? batch
      : Math.min(batch, deps.maxRows - r.scanned);

    // The three header keys are projected OUT of the jsonb in the database rather than the whole
    // bag being shipped. A header bag holds the whole received header block; the three address
    // headers are a few hundred bytes of it. Selecting `headers` would move an entire table of
    // stored bodies over the wire to read three keys out of each one.
    /**
     * THE ONE CONSTRUCT HERE THE CENSUS COULD NOT SEE, and the dangerous one. `${headers} ? 'from'` is the
     * jsonb KEY-EXISTS operator; the construct table catches its two-character forms and not the single
     * one, so these three sites read clean. On the device store `?` is a PARAMETER PLACEHOLDER, not an
     * operator — so it would not fail, it would bind the next value into the wrong position and shift every
     * binding after it. `d.jsonHasAny(col, [key])` asks the same question in each store's own terms. The
     * empty-array comparisons go through the seam for the ordinary reason: the column is `jsonb` on one
     * store and JSON-in-text on the other, and the literal has to be cast to whichever it is.
     */
    const d = dialect(db);
    const emptyJson = d.castJsonb(sql`'[]'`);
    const page = await db
      .select({
        id: messages.id,
        accountId: messages.accountId,
        fromName: messages.fromName,
        toEmpty: sql<boolean>`${messages.toAddresses} = ${emptyJson}`,
        ccEmpty: sql<boolean>`${messages.ccAddresses} = ${emptyJson}`,
        hFrom: sql<unknown>`${messageBodies.headers} -> 'from'`,
        hTo: sql<unknown>`${messageBodies.headers} -> 'to'`,
        hCc: sql<unknown>`${messageBodies.headers} -> 'cc'`,
      })
      .from(messages)
      .innerJoin(messageBodies, eq(messageBodies.messageId, messages.id))
      .where(and(
        // A row is only a candidate where a column is unset AND the header that would fill it
        // exists. `?` is jsonb key-presence; a row with no body headers matches nothing.
        sql`(
          (${messages.fromName} is null and ${await d.jsonHasAny(messageBodies.headers, ["from"])})
          or (${messages.toAddresses} = ${emptyJson} and ${await d.jsonHasAny(messageBodies.headers, ["to"])})
          or (${messages.ccAddresses} = ${emptyJson} and ${await d.jsonHasAny(messageBodies.headers, ["cc"])})
        )`,
        cursor === null ? undefined : sql`${messages.id} > ${d.castUuid(cursor)}`,
        deps.accountId === undefined ? undefined : eq(messages.accountId, deps.accountId),
      ))
      .orderBy(asc(messages.id))
      .limit(limit);
    if (page.length === 0) { r.exhausted = true; break; }
    cursor = page[page.length - 1]!.id;
    r.cursor = cursor;
    r.scanned += page.length;

    const work: Array<{ row: Candidate; fill: Fill }> = [];
    for (const raw of page) {
      const row: Candidate = {
        id: raw.id,
        accountId: raw.accountId,
        fromName: raw.fromName,
        toEmpty: raw.toEmpty,
        ccEmpty: raw.ccEmpty,
        hFrom: asStringArray(raw.hFrom),
        hTo: asStringArray(raw.hTo),
        hCc: asStringArray(raw.hCc),
      };
      let parsed;
      try {
        parsed = await parseStoredAddressHeaders({ from: row.hFrom, to: row.hTo, cc: row.hCc });
      } catch (err) {
        // A header bag mailparser will not read is REPORTED and left alone. The row keeps the
        // NULL it already had, which renders exactly as it has always rendered.
        r.parseFailures++;
        log.warn("sender_name_backfill_parse_failed", {
          messageId: row.id, reason: err instanceof Error ? err.name : "unknown",
        });
        continue;
      }
      const fill: Fill = {};
      if (row.fromName === null) {
        if (parsed.from?.name) fill.fromName = parsed.from.name;
        else if (row.hFrom !== null) r.noDisplayName++;
      }
      if (row.toEmpty && parsed.to.length > 0) fill.toAddresses = parsed.to;
      if (row.ccEmpty && parsed.cc.length > 0) fill.ccAddresses = parsed.cc;
      if (fill.fromName === undefined && fill.toAddresses === undefined && fill.ccAddresses === undefined) {
        continue;
      }
      r.fillable++;
      if (fill.fromName !== undefined) r.fromName++;
      if (fill.toAddresses !== undefined) r.toAddresses++;
      if (fill.ccAddresses !== undefined) r.ccAddresses++;
      work.push({ row, fill });
    }

    if (!apply) {
      // COUNTS AND ROW IDS ONLY, on every line this file emits. A pass over display names and
      // recipients must never put one in a log — that value is somebody's mail, and it is the
      // single thing this pass handles that a log line has no business holding. The census in
      // `log.ts` would drop a stray `fromName` key rather than print it, but the census is the
      // second line of defence and this is the first. `scanned`/`fillable`/`written` are on
      // `ALLOWED_FIELDS`; `messageId` (here, the page cursor) already was.
      log.info("sender_name_backfill_dry_page", {
        scanned: r.scanned, fillable: r.fillable, messageId: cursor,
      });
      continue;
    }
    if (work.length === 0) continue;
    if (deps.onPageRead) await deps.onPageRead(work.map((w) => w.row.id));

    const page_result = await db.transaction(async (tx) => {
      const done: typeof work = [];
      for (const w of work) {
        /* Guarded on the SAME unset state every value was computed from — one predicate per column being
           written, ANDed. A concurrent ingest, mirror write or second run of this pass wins; this pass
           never overwrites. THE GUARD IS PER ROW, NOT PER COLUMN, deliberately: if a competitor fills
           `from_name` between the page read and here, the whole UPDATE matches nothing — so this row's
           recipients are not written either, even though still fillable. The alternative (three separately
           guarded statements) buys one round trip's freshness and costs the property that makes this pass
           safe to kill: a row is either wholly as this pass computed it or wholly untouched, never a
           mixture. The row is reported `skipped` and the next run picks it up with the competitor's
           `from_name` visible — which is what resumability is for. */
        const guards = [eq(messages.id, w.row.id)];
        if (w.fill.fromName !== undefined) guards.push(sql`${messages.fromName} is null`);
        if (w.fill.toAddresses !== undefined) guards.push(sql`${messages.toAddresses} = ${d.castJsonb(sql`'[]'`)}`);
        if (w.fill.ccAddresses !== undefined) guards.push(sql`${messages.ccAddresses} = ${d.castJsonb(sql`'[]'`)}`);
        const updated = await tx.update(messages)
          .set({ ...w.fill, updatedAt: new Date() })
          .where(and(...guards))
          .returning({ id: messages.id });
        if (updated.length > 0) done.push(w);
      }
      // All `messages` locks are held; only now the per-account seq lock.
      const byAccount = new Map<string, string[]>();
      for (const w of done) {
        const list = byAccount.get(w.row.accountId) ?? [];
        list.push(w.row.id);
        byAccount.set(w.row.accountId, list);
      }
      for (const [accountId, ids] of byAccount) {
        await recordChanges(tx as LedgerTx, ids.map((id) => ({
          accountId, entityType: "message" as const, entityId: id, op: "update" as const, meta: null,
        })));
      }
      return { done: done.length, missed: work.length - done.length };
    });

    r.written += page_result.done;
    r.skipped += page_result.missed;
    log.info("sender_name_backfill_page", {
      scanned: r.scanned, fillable: r.fillable, written: r.written, messageId: cursor,
    });
  }

  // NOT `{ ...r }`. The full census reaches the operator through the runner's console summary;
  // spreading the result here would hand the logger keys named `fromName`, `toAddresses` and
  // `ccAddresses` — counts today, and a name away from being the values themselves.
  log.info(apply ? "sender_name_backfill_complete" : "sender_name_backfill_dry_complete", {
    scanned: r.scanned, fillable: r.fillable, written: r.written,
  });
  return r;
}
