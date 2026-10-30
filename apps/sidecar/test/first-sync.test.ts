import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { mailboxes, messageBodies, messageInstances, messages } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { createSidecarLogger, diagnosticFor } from "../src/log.js";
import { createFirstSyncReporter, createFirstSyncTracker } from "../src/first-sync.js";
import { stampSynced } from "../src/sync-stamp.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  HOW LONG A FIRST SYNC TOOK — the pair of lines that did not exist
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The engine marked neither the start nor the end of a first import, so nobody could establish
 * how long one took from a log — every figure on record was read off the product's status bar,
 * which infers "importing" from the mirror's count rising and latches for ninety seconds after
 * the last rise. `sync_drain` cannot stand in: it fires every poll carrying `drained: true`
 * throughout a backfill, because `drained` is per drain call.
 *
 * ── THE ABSENCE IS ASSERTED, NOT ONLY THE PRESENCE ────────────────────────────────────────
 *
 * Two of the cases below are about lines that must NOT appear: a settled mailbox says nothing on
 * every poll for the life of the install, and a launch that finds the import already stamped says
 * nothing either. Those are what stop the instrument becoming the noise it replaces, and the
 * second is the once-ever half that a single-run fixture cannot see.
 *
 * ── WHY THIS DRIVES `createSidecar` AND READS THE BYTES ───────────────────────────────────
 *
 * The subject is a WIRING fact — that a door calls the reporter with the stamps its own write
 * produced, and with a count of its own mirror. Nothing here may build that call: every case goes
 * through `createSidecar` and `syncUntilQuiet`, and the sink is the real `createSidecarLogger`, so
 * a field the census would refuse shows up as a missing field rather than as a green test.
 * `first-sync.ts`'s own state machine is exercised at the bottom of this file, where the clock can
 * be injected.
 */

class MemoryMetaFolder implements LeaseIo {
  private claims: RawClaimMessage[] = [];
  private nextUid = 1;
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> {
    return this.claims.map((c) => ({ ...c }));
  }
  async appendClaim(raw: string): Promise<void> {
    this.claims.push({ ref: this.nextUid++, raw });
  }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }

  /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
  uidValidity(): number | bigint | null { return 4_100; }
}

const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

/**
 * A mailbox that reports a BACKLOG for as long as the test says so.
 *
 * `hasBacklog` is the only lever that matters here: it is what `runSyncCycle` returns to the
 * drain, what keeps `inboundDrained` false, and therefore what holds `initial_import_completed_at`
 * unwritten. The mail itself is seeded straight into the store — what is under test is the pair of
 * lines about an import, not how an import delivers mail, and the ingest half has its own suites.
 */
function backloggedMailbox(state: { backlog: boolean }): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  const meta = new MemoryMetaFolder();
  return (_cfg) => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return {
        move: true, uidplus: true, condstore: true, qresync: false,
        idle: true, specialUse: true, sentFolder: null,
      };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> {
      return { ...EMPTY_BATCH, hasBacklog: state.backlog };
    },
    async move(locator: NativeLocator): Promise<NativeLocator> {
      return locator;
    },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> {
      return [];
    },
    async watch(): Promise<() => Promise<void>> {
      return async () => {};
    },
    async send(_m: OutboundMessage): Promise<SendResult> {
      throw new Error("this mailbox cannot send");
    },
    async fetchPart(): Promise<FetchedPart> {
      throw new Error("this mailbox cannot fetchPart");
    },
  });
}

/** One install key per store — a relaunch must be able to open the credential it sealed. */
const KEKS = new Map<string, Buffer>();
const kekFor = (dir: string): Buffer => {
  const held = KEKS.get(dir);
  if (held) return held;
  const minted = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  KEKS.set(dir, minted);
  return minted;
};

interface Line { event: string; totalMs?: number; messages?: number; mailboxId?: string }

describe("the first import's start and finish, on the standalone door", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  interface Booted {
    sidecar: Sidecar;
    /** Every emitted line, parsed — the real logger's bytes, not a fake logger's arguments. */
    lines: Line[];
    seen: (event: string) => Line[];
    state: { backlog: boolean };
    dataDir: string;
  }

  async function boot(dataDir?: string): Promise<Booted> {
    const dir = dataDir ?? await freshDataDir("ohmail-firstsync-");
    const lines: Line[] = [];
    const logger = createSidecarLogger({
      sink: (line) => { lines.push(JSON.parse(line) as Line); },
    });
    const state = { backlog: true };
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "first sync host",
      // No timer fires on its own: every drain below is one a case asked for, so a line is never
      // a coincidence of scheduling.
      pollIntervalMs: 60 * 60 * 1000,
      vitalsIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: backloggedMailbox(state),
      keks: { 1: kekFor(dir) },
      /* BOTH FACES OF ONE LOGGER, exactly as `main.ts` composes them: the engine's own call sites
         write through the two-argument `log`, the hosted sync loop through the `Logger`. A rig
         that passed only `logger` would leave `log` a no-op and every case here would assert an
         absence it had manufactured. */
      log: diagnosticFor(logger),
      logger,
    });
    cleanups.push(async () => {
      await sidecar.stop().catch(() => undefined);
      if (!dataDir) rmSync(dir, { recursive: true, force: true });
    });
    return {
      sidecar, lines, state, dataDir: dir,
      seen: (event) => lines.filter((l) => l.event === event),
    };
  }

  let nextUid = 1;
  /** A message in the mirror, so `messages` on the line is a count of something. */
  async function seed(s: Sidecar, i: number): Promise<void> {
    const dedup = `firstsync:${String(i).padStart(4, "0")}`;
    const [m] = await s.db.insert(messages).values({
      accountId: s.world.accountId,
      mailboxId: s.world.mailboxId,
      bodyHash: `h-${dedup}`,
      dedupKey: dedup,
      subject: `import ${i}`,
      fromAddress: `sender-${i}@example.test`,
      nativeLocator: { folder: "INBOX", ref: `1:${dedup}` },
    }).returning();
    await s.db.insert(messageInstances).values({
      accountId: s.world.accountId,
      mailboxId: s.world.mailboxId,
      messageId: m!.id,
      folder: "INBOX",
      uidvalidity: 1n,
      uid: nextUid++,
      isPrimary: true,
    });
    await s.db.insert(messageBodies).values({
      messageId: m!.id, text: "", html: null, headers: {},
    });
  }

  const importStamp = async (s: Sidecar): Promise<Date | null> => {
    const [row] = await s.db.select({ at: mailboxes.initialImportCompletedAt })
      .from(mailboxes).where(eq(mailboxes.id, s.world.mailboxId)).limit(1);
    return row?.at ?? null;
  };

  it("an import in progress says it started, ONCE, with what the mirror already holds", async () => {
    const b = await boot();
    await seed(b.sidecar, 1);
    await seed(b.sidecar, 2);

    // Two drains, both with the backlog standing: the import is open for both.
    await b.sidecar.syncUntilQuiet();
    await b.sidecar.syncUntilQuiet();

    expect(await importStamp(b.sidecar), "the import was stamped while a backlog stood").toBe(null);
    const started = b.seen("first_sync_started");
    expect(
      started.length,
      "an import in progress produced no start line, or produced one per drain — a line per poll "
      + "is the noise this instrument replaces",
    ).toBe(1);
    expect(started[0]!.mailboxId).toBe(b.sidecar.world.mailboxId);
    expect(
      started[0]!.messages,
      "the floor the import resumes from is not on the line, so a resumed import reads as a cold one",
    ).toBe(2);
    expect(b.seen("first_sync_finished"), "an unfinished import reported a finish").toHaveLength(0);
  });

  it("the import's clock moves while a backlog stands, and stops where the stamp is written", async () => {
    // Search reads `sync_progress_at` past the first day (`search-coverage.ts`); the engine's drain
    // is its writer on this door, through `inboundDrained`.
    const clock = async (s: Sidecar): Promise<Date | null> => {
      const [row] = await s.db.select({ at: mailboxes.syncProgressAt })
        .from(mailboxes).where(eq(mailboxes.id, s.world.mailboxId)).limit(1);
      return row?.at ?? null;
    };
    const b = await boot();
    await seed(b.sidecar, 1);
    expect(await clock(b.sidecar), "a mailbox nothing has drained has no clock").toBe(null);
    await b.sidecar.syncUntilQuiet();
    const owing = await clock(b.sidecar);
    expect(owing, "a drain that ended with the backlog standing left no clock").not.toBe(null);
    b.state.backlog = false;
    await b.sidecar.syncUntilQuiet();
    expect(await importStamp(b.sidecar)).not.toBe(null);
    expect(await clock(b.sidecar), "the drain that stamped the import moved the clock").toEqual(owing);
    await b.sidecar.syncUntilQuiet();
    expect(await clock(b.sidecar), "a settled mailbox's drain moved the clock").toEqual(owing);
  });

  it("the import finishing says so, once, with a count and a duration", async () => {
    const b = await boot();
    await seed(b.sidecar, 1);
    await b.sidecar.syncUntilQuiet();          // open: the start line
    await seed(b.sidecar, 2);
    await seed(b.sidecar, 3);
    b.state.backlog = false;

    await b.sidecar.syncUntilQuiet();          // drains: the finish line

    expect(await importStamp(b.sidecar), "the import drained and was not stamped").not.toBe(null);
    const finished = b.seen("first_sync_finished");
    expect(
      finished.length,
      "the first import finished and the log does not say when — the question this exists to answer",
    ).toBe(1);
    expect(finished[0]!.messages, "the finish line carries no count of what arrived").toBe(3);
    expect(
      typeof finished[0]!.totalMs,
      "the finish line carries no elapsed time, which is the whole of what was asked for",
    ).toBe("number");
    expect(finished[0]!.totalMs).toBeGreaterThanOrEqual(0);
    // ORDER. A finish before a start is not a measurement of anything.
    const order = b.lines.map((l) => l.event).filter((e) => e.startsWith("first_sync_"));
    expect(order).toEqual(["first_sync_started", "first_sync_finished"]);
  });

  it("A SETTLED MAILBOX SAYS NOTHING — every poll, for the life of the install", async () => {
    const b = await boot();
    await seed(b.sidecar, 1);
    b.state.backlog = false;
    await b.sidecar.syncUntilQuiet();          // the import finishes here
    const after = b.lines.length;

    await b.sidecar.syncUntilQuiet();
    await b.sidecar.syncUntilQuiet();
    await b.sidecar.syncUntilQuiet();

    expect(b.seen("first_sync_finished"), "the once-ever line fired again in one launch").toHaveLength(1);
    expect(
      b.lines.slice(after).filter((l) => l.event.startsWith("first_sync_")),
      "a settled mailbox is still reporting on its first import",
    ).toEqual([]);
  });

  it("TWO PASSES FINISHING TOGETHER STAMP ONCE — what the statement's own guard is for", async () => {
    /* THE CASE THAT TELLS THE TWO MECHANISMS APART. Dropping the `IS NULL` guard from the stamp
       write leaves every case above GREEN, because `importWasOpen` — read from the row by the
       pass write's own RETURNING — refuses the second statement before it can run. That measures
       the pair. The guard's own contribution is only observable where the READ says the import is
       open and the row has since been stamped, which is two passes finishing close together: the
       state `sync-stamp.ts` says the guard exists for. Without it both writes match, both RETURN
       a row, and the import reports finishing twice. */
    const b = await boot();
    await seed(b.sidecar, 1);
    const id = b.sidecar.world.mailboxId;

    const both = await Promise.all([
      stampSynced(b.sidecar.db, id, new Date(), true),
      stampSynced(b.sidecar.db, id, new Date(), true),
    ]);

    expect(both.map((r) => r.importWasOpen), "neither pass saw the import as open").toEqual([true, true]);
    expect(
      both.filter((r) => r.importStamped).length,
      "the import reported finishing more than once, or not at all",
    ).toBe(1);
  });

  it("A RELAUNCH OVER A FINISHED IMPORT SAYS NOTHING — the once-ever half a single run cannot see", async () => {
    // The mutation a same-process second drain does not cover: the finish is guarded by the
    // DATABASE, so a flag in the process would re-announce here and this is the only case that
    // would notice.
    const first = await boot();
    await seed(first.sidecar, 1);
    first.state.backlog = false;
    await first.sidecar.syncUntilQuiet();
    expect(first.seen("first_sync_finished")).toHaveLength(1);
    await first.sidecar.stop();

    const again = await boot(first.dataDir);
    await again.sidecar.syncUntilQuiet();
    await again.sidecar.syncUntilQuiet();

    expect(
      again.lines.filter((l) => l.event.startsWith("first_sync_")),
      "a relaunch over a finished import announced it again",
    ).toEqual([]);
    // Stopped first: on Windows a running engine's directory cannot be removed under it.
    await again.sidecar.stop();
    rmSync(first.dataDir, { recursive: true, force: true });
  });

  it("a relaunch over a finished import is not a first sync: finished before any drain and after one", async () => {
    // The phone's Screener reads `pending` as "still reading your mailbox on its first pass".
    const first = await boot();
    await seed(first.sidecar, 1);
    first.state.backlog = false;
    await first.sidecar.syncUntilQuiet();
    expect(await importStamp(first.sidecar)).not.toBeNull();
    await first.sidecar.stop();

    const again = await boot(first.dataDir);
    const said = (): unknown => again.sidecar.connectionStates()[again.sidecar.world.mailboxId]?.firstSync;
    expect(said(), "a relaunch read a stamped import as a first sync still working").toBe("finished");
    await again.sidecar.syncUntilQuiet();
    expect(again.seen("sync_drain"), "control: the relaunch drained").not.toHaveLength(0);
    expect(said()).toBe("finished");
    await again.sidecar.stop();
    rmSync(first.dataDir, { recursive: true, force: true });
  });

  it("CONTROL: a relaunch over an import still open says pending", async () => {
    const first = await boot();
    await seed(first.sidecar, 1);
    await first.sidecar.syncUntilQuiet();
    expect(await importStamp(first.sidecar)).toBeNull();
    await first.sidecar.stop();

    const again = await boot(first.dataDir);
    expect(again.sidecar.connectionStates()[again.sidecar.world.mailboxId]?.firstSync).toBe("pending");
    await again.sidecar.stop();
    rmSync(first.dataDir, { recursive: true, force: true });
  });
});

/**
 * The reporter's own three branches, with the clock injected — the half a composition test cannot
 * assert, because `performance.now()` there is real time and a duration is then unfalsifiable.
 */
describe("createFirstSyncReporter — the state machine", () => {
  function rig(): {
    lines: Line[];
    report: ReturnType<typeof createFirstSyncReporter>["report"];
    tick: (ms: number) => void;
    now: () => number;
  } {
    const lines: Line[] = [];
    let clock = 1_000;
    const logger = createSidecarLogger({ sink: (l) => { lines.push(JSON.parse(l) as Line); } });
    const r = createFirstSyncReporter(
      (event, detail) => { logger.info(event, detail); },
      { monotonicMs: () => clock },
    );
    return { lines, report: r.report, tick: (ms) => { clock += ms; }, now: () => clock };
  }

  it("measures the elapsed from the start of the pass that announced, not from the process", async () => {
    const r = rig();
    const firstPass = r.now();
    await r.report("mb-1", { importWasOpen: true, importStamped: false }, async () => 10, firstPass);
    const secondPass = r.now();
    r.tick(90_000);
    await r.report("mb-1", { importWasOpen: true, importStamped: true }, async () => 4_800, secondPass);

    expect(r.lines.map((l) => l.event)).toEqual(["first_sync_started", "first_sync_finished"]);
    expect(r.lines[1]!.totalMs).toBe(90_000);
    expect(r.lines[1]!.messages).toBe(4_800);
  });

  /**
   * THE PASS THAT FOUND THE IMPORT OPEN IS INSIDE THE IMPORT — the figure the whole 0.19.1
   * throughput budget is derived from.
   *
   * The numbers are the rig's own, measured 2026-09-12 over a large corpus: four drains,
   * the first of them a full drain of cycles carrying most of the corpus, and the whole import's
   * wall clock end to end. Anchored on the moment the first pass REPORTED, this line said
   * a duration far short of it, and a message rate well above the one the mailbox actually arrived at.
   */
  it("a first pass that ran for 13.7 minutes is inside the import it announces", async () => {
    const r = rig();
    const firstPass = r.now();
    r.tick(823_740);
    await r.report("mb-1", { importWasOpen: true, importStamped: false }, async () => 20_286, firstPass);
    const laterPass = r.now();
    r.tick(2_022_085);
    await r.report("mb-1", { importWasOpen: true, importStamped: true }, async () => 74_003, laterPass);

    const done = r.lines.find((l) => l.event === "first_sync_finished")!;
    expect(done.totalMs, "the drain that ingested the first messages was left out").toBe(2_845_825);
    expect(Math.round(74_003 / (done.totalMs! / 1_000)), "the msg/s this line licenses").toBe(26);
  });

  it("an import that finishes inside the first observed pass is ONE line, not two", async () => {
    // A `started` here would carry the FINAL count as the floor it began from, which is a wrong
    // number rather than a missing one.
    const r = rig();
    const onlyPass = r.now();
    r.tick(5_000);
    await r.report("mb-1", { importWasOpen: true, importStamped: true }, async () => 120, onlyPass);

    expect(r.lines.map((l) => l.event)).toEqual(["first_sync_finished"]);
    expect(r.lines[0]!.totalMs, "the only anchor available is this pass's own start").toBe(5_000);
  });

  it("does not read the mirror on a settled mailbox's pass — which is nearly every pass", async () => {
    const r = rig();
    let counted = 0;
    await r.report("mb-1", { importWasOpen: false, importStamped: false },
      async () => { counted += 1; return 0; }, r.now());

    expect(counted, "a settled pass paid for a count(*) over the whole mirror").toBe(0);
    expect(r.lines).toEqual([]);
  });

  it("keeps a per-mailbox clock — two imports at once do not share one", async () => {
    const r = rig();
    await r.report("mb-1", { importWasOpen: true, importStamped: false }, async () => 0, r.now());
    r.tick(30_000);
    await r.report("mb-2", { importWasOpen: true, importStamped: false }, async () => 0, r.now());
    r.tick(30_000);
    await r.report("mb-1", { importWasOpen: true, importStamped: true }, async () => 1, r.now());
    await r.report("mb-2", { importWasOpen: true, importStamped: true }, async () => 1, r.now());

    const done = r.lines.filter((l) => l.event === "first_sync_finished");
    expect(done.map((l) => [l.mailboxId, l.totalMs])).toEqual([["mb-1", 60_000], ["mb-2", 30_000]]);
  });

  it("a count that throws is reported, and does not end the drain", async () => {
    const r = rig();
    await expect(r.report("mb-1", { importWasOpen: true, importStamped: true },
      async () => { throw Object.assign(new Error("store gone"), { code: "SQLITE_BUSY" }); }, r.now()))
      .resolves.toBeUndefined();

    expect(r.lines.map((l) => l.event)).toEqual(["first_sync_report_failed"]);
  });
});

describe("createFirstSyncTracker — a mailbox whose import was stamped before this launch", () => {
  it("is finished from the start, through a failed drain, and still says a mirror that holds nothing", async () => {
    const lines: string[] = [];
    const t = createFirstSyncTracker((event) => { lines.push(event); }, "mb-1", { importStamped: true });
    expect(t.state()).toBe("finished");
    await t.noteDrainEnded(async () => ({ hasMessage: true, wroteOff: false }));
    expect(t.state()).toBe("finished");
    expect(lines, "a launch over a settled mailbox announced a move").toEqual([]);

    const empty = createFirstSyncTracker(() => {}, "mb-2", { importStamped: true });
    await empty.noteDrainEnded(async () => ({ hasMessage: false, wroteOff: true }));
    expect(empty.state()).toBe("produced_nothing_readable");
  });

  it("CONTROL: an unstamped mailbox stays pending until its import closes", async () => {
    const t = createFirstSyncTracker(() => {}, "mb-1");
    expect(t.state()).toBe("pending");
    await t.noteDrainEnded(async () => ({ hasMessage: true, wroteOff: false }));
    expect(t.state()).toBe("pending");
    t.noteStamps({ importWasOpen: true, importStamped: true });
    expect(t.state()).toBe("finished");
  });
});
