import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshDataDir } from "./_datadir.js";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { openLocalDb } from "../src/db.js";
import { nodeLoopDelay } from "../src/loop-delay.js";
import { INGEST_FOLD_WAL_BYTES } from "@trafficflow/db/dialect";

/**
 * ══ A DRAIN FOLDS ITS LOG IN ONCE, BEHIND ITSELF, AND NEVER FROM THE INSIDE ════════════════════
 *
 * PGlite runs Postgres standalone — no checkpointer process — so nothing bounds the write-ahead
 * log except the checkpoints this engine takes itself and the periodic one `db.ts` arms. The drain
 * is where the writing happens, so the drain's END is where the log is folded in.
 *
 * INSIDE the drain it was measured costing what it was meant to save. A checkpoint re-logs every
 * page touched after it as a full page image — megabytes a fold on a warm import — so a fold per
 * cycle, and then a fold per window of log, grew the log by half again a message and the store
 * spent its time writing it: 23.11 transactions a second against 38.53 with nothing folding
 * inside. What a kill replays between folds is bounded by the periodic checkpointer, and that
 * bound is measured rather than assumed — a kill a whole interval deep left 303 MB of log and the
 * next launch answered its first row in 751 ms.
 *
 * ── HOW IT IS OBSERVED ─────────────────────────────────────────────────────────────────────────
 *
 * `pg_control_checkpoint()` is Postgres' own record of the last checkpoint, and `global/pg_control`
 * is the file a launch reads to decide what to replay. Both are asked here, because the claim is
 * about what a crash would replay and neither a spy nor a counter of this file's own is that.
 *
 * WROTE MAIL, and not "wrote": every drain writes its own `last_sync_at`, and a settled install
 * polls for days. That stamp is re-derived by the next drain, so a kill that loses it costs
 * nothing, and a fold is not free — inside the relaxed ingest transaction it is the only flush
 * there is. So the gate is the changes the cycle observed and the change log across the tail.
 *
 * WATCHED FAILING: delete the tail `await opened.checkpoint();` in `apps/sidecar/src/engine.ts`
 * and the mail case goes red with the REDO location unmoved; widen its gate to `cycles > 0` and
 * the quiet case goes red with the location moved for a timestamp; put the per-cycle
 * `opened.foldIfLogGrew()` call back inside the cycle loop and the two cases in the middle go red,
 * one on a REDO location per window and one on the pg_control writes those folds make.
 */

class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
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

function quietMailbox(): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
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
      return { ...EMPTY_BATCH };
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

/**
 * A mailbox with a backlog: `total` messages handed over `batch` at a time, as a real adapter does
 * (`DEFAULT_SYNC_BATCH_MAX_MESSAGES`), then quiet. One drain, many cycles — the shape of a first
 * import, which is the only shape in which the question below has an answer.
 */
function backloggedMailbox(total: number, batch: number): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  const quiet = quietMailbox();
  let served = 0;
  return (cfg) => {
    const base = quiet(cfg);
    return {
      ...base,
      async changesSince(): Promise<ChangeBatch> {
        const n = Math.min(batch, total - served);
        const creates = Array.from({ length: n }, (_, i) => {
          const uid = served + i + 1;
          return {
            type: "create" as const,
            locator: { folder: "INBOX", ref: `1:${uid}` },
            seen: false,
            raw: Buffer.from([
              `Message-ID: <drain-${uid}@x>`, `From: s${uid % 40}@x.example`,
              "To: owner@trafficflow.test", `Subject: msg ${uid}`,
              "Content-Type: text/plain", "", `message ${uid}`,
            ].join("\r\n")),
          };
        });
        served += n;
        return { ...EMPTY_BATCH, creates, hasBacklog: served < total };
      },
    };
  };
}

/** Where the last checkpoint's replay would start, off the database's own control file. */
async function redoLsn(sidecar: Sidecar): Promise<string> {
  const client = (sidecar.db as unknown as {
    $client: { query(sql: string): Promise<{ rows: Array<{ redo_lsn: string }> }> };
  }).$client;
  const { rows } = await client.query("SELECT redo_lsn::text AS redo_lsn FROM pg_control_checkpoint();");
  return rows[0]!.redo_lsn;
}

/**
 * WHAT A CRASH RIGHT NOW WOULD COST, in bytes of log standing behind the last fold.
 *
 * The INSERT location and not `pg_current_wal_lsn()`, which is where the log has been WRITTEN OUT:
 * inside the ingest's relaxed transaction nothing flushes, so under a small fixture the write
 * pointer can sit still inside `wal_buffers` for a whole drain while every commit piles up behind
 * it — a reading that would report a loss window of nothing while the mail was going into memory.
 * The insert pointer is every record the store has generated, which is what a kill takes and what
 * a launch then has to make good. Both come back from ONE statement so the pair cannot be read
 * either side of a fold.
 */
async function logReading(sidecar: Sidecar): Promise<{ unfolded: number; at: number }> {
  const client = (sidecar.db as unknown as {
    $client: { query(sql: string): Promise<{ rows: Array<{ unfolded: string; at: string }> }> };
  }).$client;
  const { rows } = await client.query(
    "SELECT (pg_current_wal_insert_lsn() - redo_lsn)::bigint::text AS unfolded, " +
    "(pg_current_wal_insert_lsn() - '0/0'::pg_lsn)::bigint::text AS at FROM pg_control_checkpoint();",
  );
  return { unfolded: Number(rows[0]!.unfolded), at: Number(rows[0]!.at) };
}

/**
 * A small import with a 512 kB fold window, counting the distinct states of `pg_control`'s
 * header (it carries the checkpoint's REDO location, so a new state IS a checkpoint written). The
 * file is read by a 15 ms poller, right after every fold or checkpoint the engine asks the store
 * for, and once after `start()`, so the reading is the same wherever the poller's ticks land.
 * `holdAfterTailMs` keeps the store after each asked-for checkpoint, which hands the poller the
 * tail's state — the timing that read two against a bound of one.
 */
async function controlStatesOverImport(
  cleanups: Array<() => Promise<void> | void>, holdAfterTailMs: number,
): Promise<{ newStates: number; cycles: number; earned: number }> {
  const WINDOW = 512 * 1024;
  const drains: number[] = [];
  const dataDir = await freshDataDir("ohmail-drain-control-");
  const control = join(dataDir, "pgdata", "global", "pg_control");
  const states = new Set<string>();
  const sample = (): void => {
    try { states.add(readFileSync(control).subarray(0, 64).toString("hex")); } catch { /* not open yet */ }
  };
  const sidecar = await createSidecar({
    dataDir,
    imap: {
      host: "imap.invalid", port: 993, secure: true,
      auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
    },
    address: "owner@trafficflow.test",
    pollIntervalMs: 60 * 60 * 1000,
    leaseStaleAfterMs: 60_000,
    adapterFactory: backloggedMailbox(600, 10),
    store: async (dir, opts) => {
      const store = await openLocalDb(dir, { ...opts, ingestFoldWalBytes: WINDOW });
      const fold = store.foldIfLogGrew;
      const checkpoint = store.checkpoint;
      return Object.assign(store, {
        foldIfLogGrew: async () => { const out = await fold(); sample(); return out; },
        checkpoint: async () => {
          const out = await checkpoint();
          sample();
          if (holdAfterTailMs > 0) await new Promise((h) => setTimeout(h, holdAfterTailMs));
          return out;
        },
      });
    },
    log: (event, fields) => {
      if (event === "sync_drain") drains.push((fields as { cycles: number }).cycles);
    },
  });
  cleanups.push(async () => {
    await sidecar.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const start = await logReading(sidecar);
  let polling = true;
  const poller = (async () => {
    while (polling) {
      sample();
      await new Promise((h) => setTimeout(h, 15));
    }
  })();
  await sidecar.start();
  polling = false;
  await poller;
  sample();
  const end = await logReading(sidecar);
  return {
    newStates: states.size - 1,
    cycles: Math.max(0, ...drains),
    earned: Math.ceil((end.at - start.at) / WINDOW),
  };
}

describe("the drain folds its own write-ahead log in", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  /**
   * ── A DRAIN THAT TOOK MAIL FOLDS ────────────────────────────────────────────────────────────
   *
   * The half that must never be lost: mail landed, and what a kill would replay is bounded by the
   * fold behind the drain that took it.
   */
  it("a drain that took mail moves the checkpoint's REDO location past where it stood", async () => {
    const dataDir = await freshDataDir("ohmail-drain-ckpt-");
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      // The poll timer must never fire on its own: every drain here is one this test asked for.
      // (The periodic checkpointer cannot green this by accident either — its first tick is five
      // minutes out, and this test is over in seconds.)
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: backloggedMailbox(20, 100),
      log: () => {},
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    // BEFORE `start()`, because `start()` IS the drain that takes the mail.
    const before = await redoLsn(sidecar);
    await sidecar.start();
    const after = await redoLsn(sidecar);
    expect(after, "the drain took mail and no checkpoint followed — a kill here replays it all")
      .not.toBe(before);
  }, 180_000);

  /* A loop monitor's 10 ms timer wakes the engine, so one runs only while a drain does; the vitals
     line carries the drains' reading and holds none of its own. */
  it("holds a loop monitor only while a drain runs, and the vitals line carries the drain's reading", async () => {
    let enables = 0;
    let stops = 0;
    const vitals: Record<string, unknown>[] = [];
    const dataDir = await freshDataDir("ohmail-drain-loop-");
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      vitalsIntervalMs: 30,
      adapterFactory: backloggedMailbox(20, 10),
      loopDelay: () => {
        enables += 1;
        return { read: () => ({ p99Ms: 7, maxMs: 42 }), stop: () => { stops += 1; } };
      },
      log: (event, fields) => { if (event === "engine_vitals") vitals.push(fields as Record<string, unknown>); },
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    expect(enables, "a loop monitor runs with no drain").toBe(0);
    await sidecar.start();
    await sidecar.syncUntilQuiet();
    expect(enables, "no drain read the loop").toBeGreaterThan(0);
    expect(stops, "a loop monitor outlived its drain").toBe(enables);
    await vi.waitFor(() => expect(vitals.at(-1)!.loopReading).toBe("no_drain"), { timeout: 5_000, interval: 20 });
    expect(vitals.filter((l) => l.loopReading === "drains").map((l) => [l.loopDelayP99Ms, l.loopDelayMaxMs]),
      "the drain's reading never reached the vitals line").toContainEqual([7, 42]);
    expect(vitals.at(-1)!.loopDelayMaxMs, "a line with no drain behind it repeats an old reading").toBeNull();
  }, 180_000);

  /**
   * ── AND A DRAIN OVER A QUIET MAILBOX DOES NOT ───────────────────────────────────────────────
   *
   * The other half, and it used to be the opposite claim: every drain folded, because every drain
   * writes its own `last_sync_at`. That stamp is the whole of a settled mailbox's tail — the next
   * drain re-derives it, so a kill that loses it costs nothing — and a fold is the one thing in
   * this file that is not free: inside the relaxed ingest transaction it is the only flush there
   * is. A settled install polls for days; paying a WAL fold per poll for a timestamp is the cost
   * this gate removes, and the case above is what keeps the removal honest.
   *
   * The FIRST drain is not the subject: a launch creates the `ohmail/*` tree and writes change
   * rows for it, and a drain that wrote mail-bearing rows folds, as it should.
   */
  it("a drain over a quiet mailbox folds nothing for its own timestamp", async () => {
    const dataDir = await freshDataDir("ohmail-drain-ckpt-quiet-");
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: quietMailbox(),
      log: () => {},
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    await sidecar.start();
    await sidecar.syncUntilQuiet();      // the launch's own tail is behind us

    const before = await redoLsn(sidecar);
    const cycles = await sidecar.syncUntilQuiet();
    expect(cycles, "the drain never ran, so this test measured nothing").toBeGreaterThan(0);
    expect(await redoLsn(sidecar), "a quiet drain folded the log for its own stamp")
      .toBe(before);
  }, 180_000);

  /**
   * ── AND NOTHING FOLDS WHILE THE DRAIN RUNS ──────────────────────────────────────────────────
   *
   * A first import is ONE drain of up to its cycle ceiling, and asking for a fold inside it was
   * measured costing what it was meant to save: a checkpoint re-logs every page touched after it
   * as a full page image — megabytes a fold on a warm import — so the log grew by half again a
   * message and the store spent its time writing it, 23.11 transactions a second against 38.53
   * with no fold inside the drain. What a kill would replay is bounded between the drain's own
   * folds by the store's five-minute checkpointer, and that bound was measured, not assumed: a
   * kill a whole interval deep left 303 MB to replay and the next launch answered its first row
   * within a second.
   *
   * Observed from the SECOND lane — an ordinary interactive read, polled while the ingest holds
   * the connection — because the reading has to be taken WHILE the drain runs, which is the whole
   * of the claim. `store-lanes.ts` is what makes it possible to take at all.
   *
   * WATCHED FAILING: put `if ((await opened.foldIfLogGrew()).folded) checkpoints += 1;` back
   * inside the cycle loop in `apps/sidecar/src/engine.ts` and this goes red with a REDO location
   * for every window the drain crossed.
   */
  it("folds nothing while the drain runs, however much log the drain writes", async () => {
    const TOTAL = 600;
    const BATCH = 10;
    /** Small enough to be crossed several times by the drain of `TOTAL` messages. Derived below, not pinned. */
    const WINDOW = 512 * 1024;
    /** Every drain's cycle count, off the engine's own `sync_drain` line. */
    const drains: number[] = [];
    /** …and what that same line counted as folds — the SHIPPED counter, not this test's. */
    const folded: number[] = [];
    const drainLines: Record<string, unknown>[] = [];
    const dataDir = await freshDataDir("ohmail-drain-ckpt-loop-");
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: backloggedMailbox(TOTAL, BATCH),
      store: (dir, opts) => openLocalDb(dir, { ...opts, ingestFoldWalBytes: WINDOW }),
      loopDelay: nodeLoopDelay,
      log: (event, fields) => {
        if (event !== "sync_drain") return;
        drains.push((fields as { cycles: number }).cycles);
        folded.push((fields as { checkpoints: number }).checkpoints);
        drainLines.push(fields as Record<string, unknown>);
      },
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    const start = await logReading(sidecar);
    const during = new Set<string>();
    let polling = true;
    const poller = (async () => {
      while (polling) {
        during.add(await redoLsn(sidecar));
        await new Promise((r2) => setTimeout(r2, 15));
      }
    })();

    await sidecar.start();
    polling = false;
    await poller;
    during.add(await redoLsn(sidecar));
    const cycles = Math.max(0, ...drains);
    const end = await logReading(sidecar);
    const drainWrote = end.at - start.at;
    /** The folds a gate inside the drain would have taken — what this case exists to refuse. */
    const earned = Math.ceil(drainWrote / WINDOW);

    expect(cycles, "the backlog drained in one cycle, so there was no during to measure")
      .toBeGreaterThan(2);
    expect(
      drainWrote,
      `the drain wrote ${drainWrote} bytes of log against a ${WINDOW}-byte window — it never `
        + "crossed it, so a fold inside the drain would not have fired either",
    ).toBeGreaterThan(4 * WINDOW);
    expect(
      earned,
      `${earned} windows of log over ${cycles} cycles — too few for a fold inside the drain to be `
        + "visible against the one behind it",
    ).toBeGreaterThan(3);

    /* ── THE RULE: ONE location for the cycles, and the drain's two checkpoints behind them ────
       Where it started, then the log's fold and the tail's own checkpoint at its end, read once
       more after `start()` so the tail's is never missed. A fold per window of log would leave
       `earned + 1`, which is what the mutation produces. */
    expect(
      during.size - 1,
      `${during.size - 1} folds across ${cycles} cycles and ${earned} windows of log — the log is `
        + "being folded in from inside the drain, and every fold re-logs the pages after it",
    ).toBeLessThanOrEqual(2);

    /* ── AND THE SHIPPED COUNTER SAYS THE SAME ──────────────────────────────────────────────
       `sync_drain` counts the folds the drain itself took, which is the reading an install can be
       asked for: the one behind the drain, and no more, however much log the drain wrote. */
    const took = Math.max(0, ...folded);
    expect(took, "the drain's own line counted no fold at all, tail included").toBeGreaterThan(0);
    expect(
      took,
      `sync_drain counted ${took} folds over ${cycles} cycles for ${earned} windows of log`,
    ).toBeLessThanOrEqual(2);
    /* …with what the store's own disk work cost the engine's turns over the drain. */
    const big = drainLines.find((l) => l.cycles === cycles)!;
    expect(big.storeFsyncs as number, "the drain's line counts none of the store's fsyncs").toBeGreaterThan(0);
    expect(typeof big.storeFsyncMs).toBe("number");
    expect(typeof big.loopDelayMaxMs).toBe("number");
  }, 300_000);

  /**
   * ── THE SAME CLAIM, COUNTED AT THE FILE RECOVERY ACTUALLY READS ─────────────────────────────
   *
   * The case above asks Postgres where its REDO location is; this counts the WRITES to
   * `global/pg_control`, the file a checkpoint updates and a launch reads to decide what to replay.
   * The drain ends on two checkpoints, the log's fold and the tail's own, so the count is EXACTLY
   * two: a third is a checkpoint from inside the drain, and one is a drain that skipped a fold.
   *
   * WATCHED FAILING: the per-cycle call back inside the loop takes this to one write per window.
   */
  it("writes pg_control twice for the whole import, the fold and the tail, not once per window", async () => {
    const r = await controlStatesOverImport(cleanups, 0);
    expect(r.cycles, "the backlog drained in one cycle, so there was nothing to count").toBeGreaterThan(2);
    expect(r.earned, "the drain never crossed the window, so a per-cycle fold would not show")
      .toBeGreaterThan(3);
    expect(r.newStates, `pg_control took ${r.newStates} new states over ${r.cycles} cycles and `
      + `${r.earned} windows of log — two is the fold and the tail, more is a fold from the inside`)
      .toBe(2);
  }, 300_000);

  /**
   * ── AND THE COUNT DOES NOT DEPEND ON WHEN THE SAMPLER LANDS ────────────────────────────────
   *
   * The poller alone stopped when `start()` returned, so it saw the tail's checkpoint only when a
   * tick happened to land after it: a drain with a little more work behind that checkpoint read
   * two where the bound said one. Here the store holds after the tail so every tick lands there.
   */
  it("reads the same two writes when the store holds after the tail checkpoint", async () => {
    const r = await controlStatesOverImport(cleanups, 60);
    expect(r.newStates, `pg_control took ${r.newStates} new states with the poller given the tail`)
      .toBe(2);
  }, 300_000);

  /**
   * ── AND A DRAIN THAT NEVER FILLS THE WINDOW FOLDS EXACTLY ONCE ──────────────────────────────
   *
   * The other side of the gate, at the SHIPPED bound: sixty cycles of real mail whose log stays
   * far under {@link INGEST_FOLD_WAL_BYTES}, and the only fold is the one behind the drain. This
   * is the case the per-cycle call got wrong sixty times over, and the case a gate that simply
   * never fires would also pass — which is why the assertion is `1` and not `≤ 1`: a drain that
   * took mail and folded NOTHING leaves the whole of it to be replayed.
   */
  it("a drain whose log never fills the window folds once, behind itself", async () => {
    const drains: number[] = [];
    const folded: number[] = [];
    const dataDir = await freshDataDir("ohmail-drain-ckpt-under-");
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: backloggedMailbox(600, 10),
      log: (event, fields) => {
        if (event !== "sync_drain") return;
        drains.push((fields as { cycles: number }).cycles);
        folded.push((fields as { checkpoints: number }).checkpoints);
      },
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    const start = await logReading(sidecar);
    await sidecar.start();
    const end = await logReading(sidecar);
    const cycles = Math.max(0, ...drains);

    expect(cycles, "the backlog drained in one cycle, so there was no gate to leave shut")
      .toBeGreaterThan(2);
    expect(
      end.at - start.at,
      `the drain wrote ${end.at - start.at} bytes of log, at or above the ${INGEST_FOLD_WAL_BYTES}-`
        + "byte window — it is not the under-the-window case this asks about",
    ).toBeLessThan(INGEST_FOLD_WAL_BYTES);
    expect(
      Math.max(0, ...folded),
      `${Math.max(0, ...folded)} folds over ${cycles} cycles of mail that never filled the window`,
    ).toBe(1);
  }, 300_000);
});
