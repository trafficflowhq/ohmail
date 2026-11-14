import { sql } from "drizzle-orm";
import type { Executor, TxRunner } from "../baseline.js";
import { OLD_HEADS, type ServerJournal } from "../journal-heads.js";
import {
  OLD_SEARCH_OWED_BEFORE, expectedCounts, mustBeZero, one, publicTables, recordMoves, recordPerAccount, reported, rowsOf,
  writeLists,
} from "./before.js";
import {
  checkBorrowers, checkCatalog, checkCounts, checkLedger, checkOldSearch, checkPassMarks, checkPerAccount, checkThrottleKeys,
  type CheckInput,
} from "./checks.js";
import { namesOfWindow } from "./entry-names.js";
import type { StoreKind } from "./expected-counts.js";
import { refusal } from "./refuse.js";
import {
  TransitionFailed, TransitionRefused, fieldsOf, type CountLine, type FailureStage, type TransitionLog, type Verdict,
} from "./report.js";
import { compareSealed, fingerprintSealed, openSealed, type SealedOpener } from "./sealed.js";
import { SHIPPED_JOURNALS, oldRoad, readWindow, type TransitionJournals, type WindowEntry } from "./window.js";

/**
 * THE 2.0 TRANSITION: one function, one transaction, on every Postgres store.
 *
 * A store at 1.0.11's heads becomes a 2.0 store by twelve entries (six on a desktop). They take
 * columns the 1.0 code reads, fill a column on every row of six tables and re-key seven more, and
 * a store left between the two shapes starts on neither release. So the ordinary migrator, which
 * commits each journal apart and a desktop's entries one by one, does not run them. This does:
 *
 *   the kind and the heads · the record of before · the refusal · the mail entries · the Cloud
 *   entries (a server) · the ledger rows · the checks · every sealed value opened · the gate
 *
 * all inside one `db.transaction`. A refusal, a failing statement, a red check, a sealed value that
 * does not open and a lost connection all end it the same way: nothing is committed, and the
 * store is the 1.0.11 store it was, its ledgers included, so 1.0 starts on it again.
 *
 * IT FIRES IN EXACTLY ONE STATE ({@link transitionState} `at-old-head`) and asks so again inside
 * the transaction. It writes the ledger rows drizzle would have written (each file's hash, each
 * entry's stamp), so afterwards the heads read the window's last entries, the ordinary migrator
 * finds nothing owed, and a second run finds a store that is no longer at the old heads.
 *
 * No driver and no Cloud schema: it runs on postgres-js under the migration lock and on a
 * desktop's PGlite alike, and reads the entries from the journal's own files.
 */
export type { StoreKind } from "./expected-counts.js";
export { MAP_2_0, accountTablesOf, tablesOf, type MappedTable } from "./expected-counts.js";
export {
  TransitionFailed, TransitionRefused, describeEvent, safeName, safeNames,
  type CountLine, type TransitionEvent, type TransitionLog, type Verdict,
} from "./report.js";
export { NOTHING_OPENS, SEALED_SITES, sealedOpener, type Decrypts, type Opened, type SealedOpener, type SealedSite } from "./sealed.js";
export { SHIPPED_JOURNALS, WINDOW_LENGTH, WindowMalformed, readWindow, type TransitionJournals, type WindowEntry } from "./window.js";
export { namesOfWindow, type EntryName, type EntryNames } from "./entry-names.js";
export { accountTablesFromCatalog } from "./checks.js";

export type TransitionState = "fresh" | "below-old-head" | "at-old-head" | "moved" | { readonly refused: string };

interface Ledger { readonly rows: number; readonly head: number; readonly recorded: ReadonlyMap<number, string> }

async function readLedger(db: Executor, journal: ServerJournal): Promise<Ledger | null> {
  const table = `drizzle_${journal}.__drizzle_migrations`;
  if (!(await one<{ there: boolean }>(db, sql`select to_regclass(${table}) is not null as there`)).there) return null;
  const rows = rowsOf<{ at: string; hash: string }>(await db.execute(sql.raw(
    `select created_at::text as at, hash from "drizzle_${journal}"."__drizzle_migrations"`)));
  if (rows.length === 0) return null;
  const recorded = new Map(rows.map((r) => [Number(r.at), r.hash]));
  return { rows: rows.length, head: Math.max(...recorded.keys()), recorded };
}

type Standing = "below" | "at" | "moved" | { refused: string };

/** Where one journal's ledger stands against the old head and the window. */
function standingOf(journal: ServerJournal, ledger: Ledger, journals: TransitionJournals): Standing {
  const old = OLD_HEADS[journal].when;
  if (ledger.head < old) return "below";
  if (ledger.head === old) {
    // The head, and that every entry of the file is recorded. Never the count: a store that ran
    // entries which later left the journal records more rows than the file has entries.
    const missing = oldRoad(journal, journals[journal]).filter((e) => !ledger.recorded.has(e.when)).length;
    return missing === 0 ? "at" : { refused: `the ${journal} journal's head is 1.0.11's and ${missing} of its entries are not recorded` };
  }
  const window = readWindow(journal, journals[journal]);
  if (window.every((e) => ledger.recorded.get(e.when) === e.hash)) return "moved";
  return { refused: `the ${journal} journal's head is ${ledger.head}: neither 1.0.11's (${old}) nor a store that took the whole 2.0 window` };
}

/**
 * Which of the states a store is in, read from its two ledgers. `cloud` says whether its runner
 * holds it to be a server; a desktop has no Cloud journal.
 *
 *   fresh           nothing of the product: the ordinary migrator walks the whole road
 *   below-old-head  somewhere on the 1.0 road: it walks to the old heads first, as 1.0 does
 *   at-old-head     1.0.11's shape, every entry recorded: the one state the transition runs in
 *   moved           the whole window is recorded, hash and stamp: the ordinary migrator carries on
 *   refused         anything else. A head between the two, one journal ahead of the other, a
 *                   desktop that holds a Cloud ledger: not a store either road was written for
 */
export async function transitionState(
  db: Executor, expect: { readonly cloud: boolean }, journals: TransitionJournals = SHIPPED_JOURNALS,
): Promise<TransitionState> {
  const mail = await readLedger(db, "mail");
  const cloud = await readLedger(db, "cloud");
  if (!expect.cloud && cloud !== null) return { refused: "the store holds the Cloud journal's ledger and its runner says it is a desktop's" };
  if (mail === null) {
    if (cloud !== null) return { refused: "the store holds a Cloud ledger and no mail ledger" };
    // The product's tables with no ledger of ours: a store from before the journals were split,
    // which the 1.0 road adopts. Nothing at all: a new store.
    const product = (await one<{ there: boolean }>(db, sql`select to_regclass('public.accounts') is not null as there`)).there;
    return product ? "below-old-head" : "fresh";
  }
  const m = standingOf("mail", mail, journals);
  if (typeof m === "object") return m;
  if (!expect.cloud) return m === "below" ? "below-old-head" : m === "at" ? "at-old-head" : "moved";
  // A server whose Cloud journal never ran owes it from the start.
  const c = cloud === null ? "below" : standingOf("cloud", cloud, journals);
  if (typeof c === "object") return c;
  if (m === "moved" || c === "moved") {
    return m === c ? "moved" : { refused: `the mail journal is ${m === "moved" ? "past" : "at or below"} the old head and the Cloud journal is ${c === "moved" ? "past" : "at or below"} its own` };
  }
  return m === "at" && c === "at" ? "at-old-head" : "below-old-head";
}

export interface TransitionInput {
  /** What its runner says the store is. Never guessed from the store. */
  readonly kind: StoreKind;
  /** postgres-js under the migration lock on a server; PGlite on a desktop. */
  readonly db: Executor & TxRunner;
  /** Opens each sealed value. A store with nothing sealed passes under any opener. */
  readonly openSealed: SealedOpener;
  readonly log: TransitionLog;
  /** The journals to read. A deployment has no reason to hand any; a test hands copies. */
  readonly journals?: TransitionJournals;
  /** Inside the transaction, after the ledger rows and before the checks: a rehearsal's own step. */
  readonly afterEntries?: (tx: Executor) => Promise<void>;
}

export interface TransitionReport {
  readonly kind: StoreKind;
  readonly reported: readonly CountLine[];
  /** Tables that are not the product's and were left alone. */
  readonly ownerTables: number;
  readonly entries: readonly { journal: string; tag: string; ms: number }[];
  readonly verdicts: readonly Verdict[];
  readonly sealed: readonly { site: string; rows: number; opened: number; failed: number }[];
  /** The count each table of the map holds, as the checks read it. */
  readonly counts: Readonly<Record<string, number>>;
  /** Each ledger's head afterwards. */
  readonly heads: Readonly<Record<string, number>>;
}

/** An entry's own name for a step: the `-- @name` line above the statement. */
function stepOf(statement: string): string | undefined {
  return /--\s*@([a-z0-9_]+)/.exec(statement)?.[1];
}

export async function runTransition(input: TransitionInput): Promise<TransitionReport> {
  const { kind, log } = input;
  const journals = input.journals ?? SHIPPED_JOURNALS;
  const entries: WindowEntry[] = [...readWindow("mail", journals.mail), ...(kind === "desktop" ? [] : readWindow("cloud", journals.cloud))];
  const names = namesOfWindow(entries.map((e) => ({ journal: e.journal, tag: e.tag, statements: e.statements })));
  const journalsRun: ServerJournal[] = kind === "desktop" ? ["mail"] : ["mail", "cloud"];

  let stage: FailureStage = "before";
  let running: WindowEntry | undefined;
  let step: string | undefined;
  try {
    const report = await input.db.transaction(async (tx): Promise<TransitionReport> => {
      // The kind and the heads, asked again where nothing can move under the answer.
      const state = await transitionState(tx, { cloud: kind !== "desktop" }, journals);
      if (state !== "at-old-head") {
        throw new TransitionRefused([{ what: typeof state === "object" ? state.refused : `the store is ${state}, not at 1.0.11's heads`, n: 1 }]);
      }
      const ledgerBefore: Record<string, { rows: number; head: number }> = {};
      for (const j of journalsRun) { const l = (await readLedger(tx, j))!; ledgerBefore[j] = { rows: l.rows, head: l.head }; }

      // The record of before.
      await writeLists(tx, kind, names);
      const expected = await expectedCounts(tx, kind, new Set(await publicTables(tx)));
      await recordPerAccount(tx, "before");
      await recordMoves(tx, kind);
      await fingerprintSealed(tx, kind, "before");
      const oldSearchOwed = Number((await one<{ n: string }>(tx, sql.raw(OLD_SEARCH_OWED_BEFORE))).n);
      const said = await reported(tx, kind);
      for (const line of said) log({ type: "reported", what: line.what, n: line.n });

      // The refusal, before the first entry.
      const refused = await refusal(tx, kind, names, await mustBeZero(tx, kind));
      for (const f of refused.foreign) log({ type: "owner-table", name: f.name, outcome: f.refuses === null ? "left" : "refused" });
      for (const subjects of Object.values(refused.subjects)) {
        for (const name of subjects.slice(0, 20)) log({ type: "owner-table", name, outcome: "refused" });
      }
      if (refused.lines.length > 0) {
        log({ type: "refused", lines: refused.lines });
        throw new TransitionRefused(refused.lines);
      }

      // The entries, as the ordinary migrator would run them, and the rows it would have recorded.
      stage = "entry";
      const ran: { journal: string; tag: string; ms: number }[] = [];
      for (const e of entries) {
        running = e;
        const began = Date.now();
        for (const statement of e.statements) {
          step = stepOf(statement) ?? step;
          await tx.execute(sql.raw(statement));
        }
        step = undefined;
        ran.push({ journal: e.journal, tag: e.tag, ms: Date.now() - began });
        log({ type: "entry", journal: e.journal, name: e.tag, ms: Date.now() - began });
      }
      for (const e of entries) {
        running = e;
        await tx.execute(sql`insert into ${sql.raw(`"drizzle_${e.journal}"."__drizzle_migrations"`)} ("hash", "created_at") values (${e.hash}, ${e.when})`);
      }
      running = undefined;
      stage = "check";
      await input.afterEntries?.(tx);

      // The checks.
      const check: CheckInput = {
        kind, expected, foreign: refused.foreign, entries, ledgerBefore, oldSearchOwed,
        gone: names.dropped.filter((n) => n.kind === "table").map((n) => n.name),
      };
      await fingerprintSealed(tx, kind, "after");
      const verdicts: Verdict[] = [
        ...await checkCounts(tx, check), ...await checkBorrowers(tx, check), ...await checkPerAccount(tx),
        ...await checkPassMarks(tx), ...await compareSealed(tx), ...await checkCatalog(tx, check),
        ...await checkOldSearch(tx, check), ...await checkThrottleKeys(tx, check), ...await checkLedger(tx, check),
      ];

      // Every sealed value, opened under the ring.
      stage = "sealed";
      const sealed = await openSealed(tx, kind, input.openSealed);
      for (const s of sealed) {
        log({ type: "sealed", ...s });
        verdicts.push({ check: "sealed values that do not open under the key ring", subject: s.site, expected: "0", found: String(s.failed), ok: s.failed === 0 });
      }

      // The gate.
      stage = "check";
      const red = verdicts.filter((v) => !v.ok);
      for (const v of red) log({ type: "check", name: v.check, subject: v.subject, expected: v.expected, found: v.found, ok: false });
      log({ type: "reported", what: "checks", n: verdicts.length });
      log({ type: "reported", what: "checks that are red", n: red.length });
      if (red.length > 0) {
        throw new TransitionFailed({
          stage: red.some((v) => v.check.startsWith("sealed values that do not open")) && red.every((v) => v.check.startsWith("sealed values")) ? "sealed" : "check",
          lines: red.map((v) => ({ what: `${v.check} / ${v.subject}: expected ${v.expected}, found ${v.found}`, n: 1 })),
        });
      }

      const counts: Record<string, number> = {};
      for (const v of verdicts) if (v.check === "count against the map's formula") counts[v.subject] = Number(v.found);
      const heads: Record<string, number> = {};
      for (const j of journalsRun) heads[j] = entries.filter((e) => e.journal === j).at(-1)!.when;
      return {
        kind, reported: said, ownerTables: refused.foreign.filter((f) => f.refuses === null).length,
        entries: ran, verdicts, sealed, counts, heads,
      };
    });
    log({ type: "committed", heads: report.heads });
    return report;
  } catch (err) {
    if (err instanceof TransitionRefused || err instanceof TransitionFailed) throw err;
    // A driver's error: its class and what it was about, never its text. No SQLSTATE: the
    // connection went, or something that is not the database failed; either way nothing committed.
    const fields = fieldsOf(err);
    const failed = running as WindowEntry | undefined;
    throw new TransitionFailed({
      stage: fields.sqlState === undefined ? "lost" : stage,
      ...(failed ? { entry: `${failed.journal} ${failed.tag}` } : {}),
      ...(step !== undefined ? { step } : {}),
      ...fields,
    });
  }
}
