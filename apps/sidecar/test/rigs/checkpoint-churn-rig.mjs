/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  DOES ANYTHING FOLD THE LOG IN WHILE THE MAIL IS STILL COMING IN?
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Two questions, one rig.
 *
 * `why` — WHICH mechanism starves the periodic checkpointer. Three arms over identical churn
 * against one real `openLocalDb`: the loop outside every lane (the scheduler is not in the path —
 * `ingestIsRunning()` is false), the same loop inside `inStoreLane("ingest", …)` (the scheduler
 * hands out one admission per check phase every `TURN_EVERY`), and the engine's own shape (a lane
 * per cycle with `setTimeout(0)` between cycles). A PROBE timer armed at the checkpoint interval
 * counts the timer phase independently of the checkpointer, so "the timer never fired" and "the
 * checkpoint queued behind the ingest" are two different readings and not one.
 *
 * `ingest` — what a real first import costs the log, driving the worker's own `runSyncCycle` over
 * real corpus bytes against the store the desktop opens, in the engine's drain shape. Arms:
 * `baseline` (the log folds in when the drain ENDS), `writes` (a checkpoint every N messages
 * inside the loop), `yield` (a `setImmediate` per batch, the timer bound kept).
 *
 * NOT a test: it prints JSONL, asserts nothing. `.mjs` on purpose — not collected by vitest, not
 * typechecked by the sidecar's ratchet, exactly like `a6-store-lanes-rig.mjs`.
 *
 * Run: node --import tsx apps/sidecar/test/rigs/checkpoint-churn-rig.mjs why   [--interval MS] [--rounds N]
 *      node --import tsx apps/sidecar/test/rigs/checkpoint-churn-rig.mjs ingest --corpus DIR --n N --batch B
 *                                                                              --arm baseline|writes|yield
 *                                                                              [--every N] [--interval MS]
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailboxes, messages } from "@trafficflow/db";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { runSyncCycle } from "@ohmail/organizer/sync";
import { FakeAdapterFleet } from "../../../../packages/organizer/test/_fakeadapter.js";
import { openLocalDb } from "../../src/db.js";
import { inStoreLane } from "../../src/store-lanes.js";

const ACCOUNT = "00000000-0000-4000-8000-00000000a11e";

function flag(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const scratch = flag("scratch", join(tmpdir(), "ckpt-churn-rig"));
mkdirSync(scratch, { recursive: true });
const tempDir = () => realpathSync(mkdtempSync(join(scratch, "store-")));

/** WAL segment files on disk, and their bytes. `pg_wal` also holds `archive_status/`. */
function wal(pgDataDir) {
  let files = 0;
  let bytes = 0;
  try {
    for (const f of readdirSync(join(pgDataDir, "pg_wal"))) {
      if (/^[0-9A-F]{24}$/.test(f)) {
        files += 1;
        bytes += statSync(join(pgDataDir, "pg_wal", f)).size;
      }
    }
  } catch { /* the directory is gone; the caller reads zero */ }
  return { files, bytes };
}

/** Where a recovery would start replaying from — Postgres' own record of the last checkpoint. */
async function redoLsn(o) {
  const r = await o.db.execute("select redo_lsn::text as redo_lsn from pg_control_checkpoint()");
  return String(Object.values(r.rows[0] ?? {})[0]);
}

const round = (x, d = 3) => Number(x.toFixed(d));
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

/* ── why ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * One round of the ingest's write shape: a batch of rows in ONE transaction, per-row hex so
 * Postgres cannot compress the fixture down to nothing before it reaches the log.
 */
async function churnRound(o, round_) {
  await o.db.transaction(async (tx) => {
    await tx.execute(
      "insert into wal_churn (id, blob) select g, (select string_agg(md5(g::text || s::text || " +
      `${round_}), '') from generate_series(1, 200) s) from generate_series(1, 100) g ` +
      "on conflict (id) do update set blob = excluded.blob",
    );
  });
}

async function armWhy(arm, opts) {
  const dir = tempDir();
  const o = await openLocalDb(dir, { checkpointIntervalMs: opts.interval });
  await o.db.execute("create table if not exists wal_churn (id int primary key, blob text)");

  /* THE PROBE, ARMED LIKE THE CHECKPOINTER AND TOUCHING NOTHING. It counts the TIMER PHASE, so a
     zero here is "the loop never got a turn" and a non-zero beside an unmoved redo location is
     "the turn happened and the checkpoint did not land". */
  let fires = 0;
  let probe = null;
  const rearm = () => {
    probe = setTimeout(() => { fires += 1; rearm(); }, opts.interval);
    probe.unref?.();
  };

  const seen = new Set();
  let peakFiles = 0;
  let peakBytes = 0;
  const sample = async () => {
    const w = wal(o.pgDataDir);
    peakFiles = Math.max(peakFiles, w.files);
    peakBytes = Math.max(peakBytes, w.bytes);
    seen.add(await redoLsn(o));
  };

  const before = await redoLsn(o);
  rearm();
  const t0 = performance.now();

  if (arm === "no-lane") {
    for (let r = 0; r < opts.rounds; r++) { await churnRound(o, r); await sample(); }
  } else if (arm === "ingest-lane") {
    await inStoreLane("ingest", async () => {
      for (let r = 0; r < opts.rounds; r++) { await churnRound(o, r); await sample(); }
    });
  } else if (arm === "ingest-lane-cycle-yield") {
    /* The engine's own shape: a lane per CYCLE, and `setTimeout(0)` between cycles
       (`engine.ts`, "Yield, so a backlog drain cannot starve the request handler"). */
    const perCycle = 10;
    for (let c = 0; c * perCycle < opts.rounds; c++) {
      await inStoreLane("ingest", async () => {
        for (let r = 0; r < perCycle; r++) { await churnRound(o, c * perCycle + r); await sample(); }
      });
      await new Promise((r) => setTimeout(r, 0));
    }
  } else throw new Error(`no such arm: ${arm}`);

  const wallMs = performance.now() - t0;
  if (probe) clearTimeout(probe);
  const after = await redoLsn(o);
  const end = wal(o.pgDataDir);
  await o.close();
  rmSync(dir, { recursive: true, force: true });

  out({
    cmd: "why", arm, intervalMs: opts.interval, rounds: opts.rounds,
    wallMs: round(wallMs, 1),
    timerFires: fires,
    redoMoved: after !== before,
    distinctRedoDuringChurn: seen.size,
    peakWalFiles: peakFiles, peakWalMiB: round(peakBytes / 1024 / 1024, 1),
    endWalFiles: end.files, endWalMiB: round(end.bytes / 1024 / 1024, 1),
    load1: readFileSync("/proc/loadavg", "utf8").split(" ")[0],
  });
}

/* ── ingest ───────────────────────────────────────────────────────────────────────────────── */

function loadCorpus(dir, n) {
  return readdirSync(dir).sort().slice(0, n).map((f) => readFileSync(join(dir, f)));
}

async function armIngest(opts) {
  const raws = loadCorpus(opts.corpus, opts.n);
  const dir = tempDir();
  /* Every checkpoint this store takes is counted through its own log line, the TIMER's included,
     so an arm cannot be credited with a fold somebody else made. */
  const logged = [];
  const o = await openLocalDb(dir, {
    checkpointIntervalMs: opts.interval,
    log: (event, fields) => { if (event.startsWith("local_db_checkpoint")) logged.push({ event, ...fields }); },
  });

  const [mb] = await o.db.insert(mailboxes)
    .values({ accountId: ACCOUNT, provider: "imap", address: `mb-${randomUUID().slice(0, 8)}@lichtgrat.example` })
    .returning();
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId: ACCOUNT, mailboxId: mb.id, onConnectionError: () => {} },
  );
  /* Real corpus bytes in place of the fake's four-word body, exactly as the parked ingest rig
     does it. */
  const inner = adapter.changesSince.bind(adapter);
  let next = 0;
  adapter.changesSince = async (c) => {
    const b = await inner(c);
    for (const cr of b.creates) { cr.raw = raws[next % raws.length]; next += 1; }
    return b;
  };
  fleet.behave(mb.id, {
    batchSize: opts.batch,
    deliver: Array.from({ length: opts.n }, (_, i) => ({
      from: `s${i % 40}@x.example`, subject: `msg ${i}`, messageId: `m-${i}-${randomUUID().slice(0, 8)}@x`,
      seen: i % 10 < 3,
    })),
  });

  const deps = {
    repo: makeDrizzleRepo(o.db), adapter, accountId: ACCOUNT, mailboxId: mb.id,
    storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set(),
  };

  let checkpoints = 0;
  let checkpointMs = 0;
  const checkpoint = async () => {
    const t = performance.now();
    await o.checkpoint();
    checkpointMs += performance.now() - t;
    checkpoints += 1;
  };

  let peakFiles = 0;
  let peakBytes = 0;
  const trace = [];
  const redoSeen = new Set();
  const sample = async () => {
    const w = wal(o.pgDataDir);
    peakFiles = Math.max(peakFiles, w.files);
    peakBytes = Math.max(peakBytes, w.bytes);
    redoSeen.add(await redoLsn(o));
    trace.push(w.files);
  };

  let fires = 0;
  let probe = null;
  const rearm = () => {
    probe = setTimeout(() => { fires += 1; rearm(); }, opts.interval);
    probe.unref?.();
  };

  await sample();
  rearm();
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  let cycles = 0;
  let sinceCheckpoint = 0;
  /* THE ENGINE'S DRAIN LOOP (`engine.ts`): the cycle in the ingest lane, a `setTimeout(0)` between
     cycles, and the log folded in when the drain ENDS. The arms differ only inside it. */
  for (;;) {
    const o_ = await inStoreLane("ingest", () => runSyncCycle(deps));
    cycles += 1;
    sinceCheckpoint += opts.batch;
    await sample();
    if (opts.arm === "writes" && sinceCheckpoint >= opts.every) {
      await checkpoint();
      sinceCheckpoint = 0;
      await sample();
    }
    if (opts.arm === "yield") await new Promise((r) => setImmediate(r));
    if (!o_.hasBacklog) break;
    if (cycles > 2000) throw new Error("the fixture never drained");
    await new Promise((r) => setTimeout(r, 0));
  }
  const drainMs = performance.now() - t0;
  const cpu = process.cpuUsage(c0);
  const peakDuringDrain = { files: peakFiles, bytes: peakBytes };
  /* The per-drain checkpoint every arm keeps (`engine.ts`, "Checkpoint behind every drain that
     wrote"), so the arms are compared with the same ending. */
  await checkpoint();
  const wallMs = performance.now() - t0;
  if (probe) clearTimeout(probe);
  await sample();

  const rows = await o.db.select({ id: messages.id }).from(messages);
  const n = rows.length;
  const end = wal(o.pgDataDir);
  await o.close();
  rmSync(dir, { recursive: true, force: true });

  out({
    cmd: "ingest", arm: opts.arm, every: opts.arm === "writes" ? opts.every : null,
    intervalMs: opts.interval, delivered: opts.n, ingested: n, cycles, batch: opts.batch,
    wallMs: round(wallMs, 1), drainMs: round(drainMs, 1),
    wallPerMsgMs: round(wallMs / n), drainPerMsgMs: round(drainMs / n),
    cpuUserPerMsgMs: round(cpu.user / 1000 / n),
    checkpointsAskedDuringDrain: checkpoints - 1,
    checkpointsAskedTotal: checkpoints, checkpointMs: round(checkpointMs, 1),
    distinctRedoDuringDrain: redoSeen.size, checkpointLines: logged.length,
    walTrace: trace,
    checkpointPerMsgMs: round(checkpointMs / n),
    timerFires: fires,
    peakWalFilesDuringDrain: peakDuringDrain.files,
    peakWalMiBDuringDrain: round(peakDuringDrain.bytes / 1024 / 1024, 1),
    walMiBPerMsg: round(peakDuringDrain.bytes / 1024 / 1024 / n, 4),
    endWalFiles: end.files, endWalMiB: round(end.bytes / 1024 / 1024, 1),
    load1: readFileSync("/proc/loadavg", "utf8").split(" ")[0],
  });
}

/* ── entry ────────────────────────────────────────────────────────────────────────────────── */

const cmd = process.argv[2];
if (cmd === "why") {
  const opts = { interval: Number(flag("interval", "250")), rounds: Number(flag("rounds", "60")) };
  for (const arm of (flag("arms", "no-lane,ingest-lane,ingest-lane-cycle-yield")).split(",")) {
    await armWhy(arm, opts);
  }
} else if (cmd === "ingest") {
  await armIngest({
    corpus: flag("corpus"), n: Number(flag("n", "400")), batch: Number(flag("batch", "100")),
    arm: flag("arm", "baseline"), every: Number(flag("every", "500")),
    interval: Number(flag("interval", String(5 * 60_000))),
  });
} else {
  process.stderr.write("usage: checkpoint-churn-rig.mjs why|ingest [flags]\n");
  process.exit(2);
}
