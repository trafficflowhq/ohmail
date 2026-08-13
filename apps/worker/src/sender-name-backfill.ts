import { and, asc, eq, sql } from "drizzle-orm";
import { messageBodies, messages, recordChanges, type LedgerTx, type Tx } from "@trafficflow/db";
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

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE SENDER-NAME / RECIPIENTS BACKFILL — DB-only, over whichever store is authoritative
   ══════════════════════════════════════════════════════════════════════════════════════════

   ── WHAT IT REPAIRS ────────────────────────────────────────────────────────────────────────

   Three columns went in after the rows that need them, all for the same reason: the parser had
   produced the value since it was written and ingest had nowhere to put it.

     · `messages.from_name`     — added by a later migration. Every message stored before it
                                  reached the reader as a bare address, because the message
                                  projection hardcoded `from: { name: null, … }` for want of a
                                  column to read.
     · `messages.to_addresses`  — the columns have existed since the mail schema landed and the
     · `messages.cc_addresses`    projection has always read them, but no ingest wrote either
                                  until `commitChange` named them, so every earlier message
                                  rendered no "To" line at all.

   The migration that added `from_name` deliberately left the repair to a separate pass: filling
   historical rows means re-parsing the headers those rows still carry, which is not something a
   schema change can express, and each touched row owes a `change_log` update or no mirror ever
   re-reads it. This is that pass. All three columns together, because they come from one read of
   one header bag and one row deserves one change-log entry, not two passes' worth.

   ── THE SOURCE IS STILL THERE, WHICH IS THE ONLY REASON THIS IS POSSIBLE ───────────────────

   A historical row can only be repaired from something the store still holds. It holds the
   headers: `message_bodies.headers` is the RAW header-value bag `normalizeMime` wrote on the
   way past, so a message stored long before the column existed still carries
   `from: ["Papierwerk Studio <hello@papierwerk.example>"]` whatever its `messages` row says.

   What is NOT possible is inventing a name for the rows whose `From` is a bare address with no
   display name in it. Those stay NULL, which is the same NULL the reader already falls back on.
   A name derived from an address would be a value no sender ever wrote, and it would be
   indistinguishable afterwards from one they did.

   ── THE PARSE IS INGEST'S PARSE ────────────────────────────────────────────────────────────

   `parseStoredAddressHeaders` is in `packages/core/src/mime.ts` beside `normalizeMime` and
   shares `simpleParser`, `PARSE_OPTIONS`, `toAddr` and `addrList` with it — a backfill whose
   names disagreed with ingest's would leave two populations of rows decided by different rules,
   and the disagreement would be invisible per row. Its own suite pins the round trip
   (`parseStoredAddressHeaders(normalizeMime(raw).headers)` equals that same `normalizeMime`'s
   `from`/`to`/`cc`) rather than pinning hand-written expectations.

   It matters that it is a real parse and not a string split. A stored `From` may be an RFC 2047
   encoded word rather than the characters it stands for, a quoted display name containing a
   comma that a naive split would tear in half, or a folded line stored with its newlines intact.

   ── ONLY EVER FILLS, NEVER OVERWRITES ──────────────────────────────────────────────────────

   Each column is written only from its own unset state — `from_name IS NULL`, `to_addresses =
   '[]'`, `cc_addresses = '[]'` — and the UPDATE repeats that predicate, so a value written by
   ingest, by a mirror or by a concurrent run of this pass wins over anything computed here.
   A row where the parse yields nothing new is not written at all and costs no change-log entry.

   ── KEYSET PAGINATION, NOT PREDICATE EXTINCTION ────────────────────────────────────────────

   The obvious loop — "select the candidates until none are left" — cannot terminate here, in
   BOTH modes and for two different reasons. A dry run writes nothing, so it would re-read page
   one for ever. And an APPLY leaves rows in the candidate set on purpose: a message whose
   sender set no display name still has a NULL `from_name` and a `from` header afterwards, and a
   message genuinely addressed to nobody still has an empty `to_addresses`. The cursor
   (`id > last`) is what makes both modes walk the same pages exactly once, and it is why the
   honest "is it done?" number is `written`, not the size of the candidate set.

   THE SAME SENTENCE IS WHY THE CURSOR IS AN INPUT AND AN OUTPUT. A caller that runs this in
   BOUNDED VISITS rather than in one sitting — the local engine does, so that a repair cannot
   delay the mail — has to be able to say where the last visit stopped. Restarting each visit at
   the beginning would be correct and would still converge on a store with nothing unfillable in
   it; on a real one it degrades until it stalls, because the rows that stay candidates for ever
   accumulate at the FRONT of the walk and eventually fill a whole visit's budget on their own.
   {@link SenderNameBackfillDeps.startAfterId} and {@link SenderNameBackfillResult.cursor} are
   that handover, and {@link SenderNameBackfillResult.exhausted} is the only honest "there is
   nothing after this point" — a page can come back empty at any budget.

   ── MIRRORS LEARN THROUGH THE CHANGE LOG ───────────────────────────────────────────────────

   Every written row appends a `message` update in the same transaction. The sync service
   re-materializes each changed message through the one projection, and every mirror above this
   store upserts `fromName`, `toAddresses` and `ccAddresses` from the result unconditionally, so
   a mirror converges on its next ordinary `/sync`. Without the change-log row the columns would
   be correct in the store and wrong on every mirror above it until someone re-bootstrapped
   them, which is the failure the migration wrote down in advance. That holds on a LOCAL store
   too, and there for a nearer reason: the window's own view of the mail is a mirror driven by
   this feed, so the change-log row is what repaints a message in the same session rather than
   after the next launch.

   Lock order matches ingest and the other passes: all `messages` row locks first,
   `allocateSeq`'s account row lock last, one allocation per account per page.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

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
   * Called with the page's ids after it is read and parsed, before the write transaction opens.
   *
   * A TEST SEAM, and it exists because the property it opens up cannot be observed any other
   * way. The page SELECT deliberately runs outside the transaction (a read of hundreds of rows
   * holding locks would block ingest for its whole duration), so there is a real window in which
   * another writer can fill a column this pass has already decided to write. The guarded UPDATE
   * is what makes that harmless, and a guard nobody has watched fail is not evidence — this hook
   * is how the pg test lands a competing write inside that exact window. Production passes
   * nothing and pays one `undefined` check per page.
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
    const page = await db
      .select({
        id: messages.id,
        accountId: messages.accountId,
        fromName: messages.fromName,
        toEmpty: sql<boolean>`${messages.toAddresses} = '[]'::jsonb`,
        ccEmpty: sql<boolean>`${messages.ccAddresses} = '[]'::jsonb`,
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
          (${messages.fromName} is null and ${messageBodies.headers} ? 'from')
          or (${messages.toAddresses} = '[]'::jsonb and ${messageBodies.headers} ? 'to')
          or (${messages.ccAddresses} = '[]'::jsonb and ${messageBodies.headers} ? 'cc')
        )`,
        cursor === null ? undefined : sql`${messages.id} > ${cursor}::uuid`,
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
        /* Guarded on the SAME unset state every value was computed from — one predicate per
           column being written, ANDed. A concurrent ingest, mirror write or second run of this
           pass wins; this pass never overwrites.

           THE GUARD IS PER ROW, NOT PER COLUMN, AND THAT IS THE DELIBERATE CHOICE. If a
           competitor fills `from_name` between the page read and here, the whole UPDATE matches
           nothing — so this row's recipients are not written either, even though that column is
           still empty and still fillable. The alternative (three statements, each guarded
           separately) buys one round trip's worth of freshness and costs the property that makes
           this pass safe to kill: as written, a row is either wholly as this pass computed it or
           wholly untouched, never a mixture of one run's parse and another's. The row is
           reported as `skipped` and the next run picks it up with the competitor's `from_name`
           now visible — which is what resumability is for. */
        const guards = [eq(messages.id, w.row.id)];
        if (w.fill.fromName !== undefined) guards.push(sql`${messages.fromName} is null`);
        if (w.fill.toAddresses !== undefined) guards.push(sql`${messages.toAddresses} = '[]'::jsonb`);
        if (w.fill.ccAddresses !== undefined) guards.push(sql`${messages.ccAddresses} = '[]'::jsonb`);
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
