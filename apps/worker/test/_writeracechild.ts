/**
 * THE CHILD PROCESS THAT `driver-write-race.pg.test.ts` PUTS THE CRASH CONTRACT INSIDE.
 *
 * The thing under test is `installCrashHandlers` mounted on a REAL `process`, so it cannot be
 * tested in-process: the claim is "this process is still running afterwards", and a fake host that
 * captures listeners can never make that claim. Vitest's own `uncaughtException` handling would
 * also intercept the throw long before the contract saw it.
 *
 * So this file is the deployed shape: real handlers on real `process`, a real postgres.js pool
 * against real Postgres, real transactions, and a TCP proxy that takes the transport away
 * underneath them. Two modes:
 *
 *   guarded — `survivable: driverWriteRaceReason`, i.e. what `index.ts` installs.
 *   bare    — no `survivable`: any driver throw exits 1. With patches/postgres@3.4.9.patch there is
 *             none, so the parent runs this one and requires exit 0.
 *
 * Protocol: NDJSON on stdout. The logger's own lines plus one `child_summary` at the end. The
 * parent reads them; nothing here asserts.
 */
import net from "node:net";
import postgres from "postgres";
import { createLogger } from "@trafficflow/core";
import { installCrashHandlers } from "../src/entry.js";
import { driverWriteRaceReason } from "../src/driver-write-race.js";
import { withPgSocket } from "../../../packages/db/src/pg-socket.js";

const MODE = process.argv[2] === "bare" ? "bare" : "guarded";
const DB_URL = process.env.TF_CHILD_DB_URL ?? "";
const ROUNDS = Number(process.env.TF_CHILD_ROUNDS ?? 60);

/**
 * How many times the contract has survived a throw — counted off the LOG STREAM rather than from a
 * variable this file owns, so it is the same evidence the parent asserts on and cannot report a
 * suppression that was never logged.
 */
let survived = 0;
const log = createLogger({
  service: "worker",
  sink: (line) => {
    if (line.includes("\"uncaught_exception_survived\"")) survived++;
    process.stdout.write(line + "\n");
  },
});

/**
 * The exact contract `index.ts` installs — including `exit`, which is the point of the `bare` arm.
 * `flushExit` is not used: this process must die PROMPTLY and with a code the parent can read,
 * and a 2 s stdout flush deadline inside a test would just be latency. `process.exit` is the
 * honest stand-in because what is under test is WHETHER the contract exits, not how it flushes.
 */
installCrashHandlers({
  log: () => log,
  exit: (code) => { process.exit(code); },
  ...(MODE === "guarded" ? { survivable: driverWriteRaceReason } : {}),
});

/** A pass-through in front of Postgres, with a switch — the same fixture `shared-db-fault` uses. */
class Proxy {
  private server: net.Server | null = null;
  private readonly live = new Set<net.Socket>();
  port = 0;
  constructor(private readonly host: string, private readonly target: number) {}

  async listen(port = 0): Promise<void> {
    const server = net.createServer((client) => {
      const upstream = net.createConnection({ host: this.host, port: this.target });
      this.live.add(client); this.live.add(upstream);
      const drop = (): void => { this.live.delete(client); this.live.delete(upstream); };
      const kill = (): void => { client.destroy(); upstream.destroy(); drop(); };
      for (const s of [client, upstream]) { s.on("error", kill); s.on("close", kill); }
      client.pipe(upstream); upstream.pipe(client);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    const addr = server.address();
    this.port = typeof addr === "object" && addr !== null ? addr.port : port;
    this.server = server;
  }

  /**
   * `destroy()`, NOT `end()` — and this is the one line that differs from `shared-db-fault.pg.test.ts`,
   * where the same fixture deliberately uses `end()` to CLOSE this race so that file can measure
   * something else. Here the race is the subject, so the transport is yanked with a write still
   * buffered rather than allowed to flush.
   */
  cut(): void {
    this.server?.close();
    this.server = null;
    for (const s of this.live) s.destroy();
    this.live.clear();
  }

  async restore(): Promise<void> { if (!this.server) await this.listen(this.port); }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

async function main(): Promise<void> {
  const proxy = new Proxy("127.0.0.1", Number(new URL(DB_URL).port || 5432));
  await proxy.listen();
  const url = new URL(DB_URL);
  url.hostname = "127.0.0.1";
  url.port = String(proxy.port);
  // The worker's pools dial through pg-socket.ts (makeOwnedDb). Without it this measured the raw
  // driver: a race left every connection's handshake queued behind stale bytes for ~5 min, longer
  // than the resume budget (2 of 60 runs, CI 39012201863).
  const sql = postgres(url.toString(), withPgSocket({ max: 5 }));

  let stop = false;
  let committed = 0;

  /**
   * TRANSACTIONS, not bare statements, and that is what makes the race reachable at all: measured
   * over tens of thousands of plain statements across 20 cut rounds it never fired once, and over thousands of
   * transactions across 15 rounds it fired four times. `sql.begin` captures the connection object
   * by reference and sends every statement straight to `c.execute(q)`, bypassing the pool's queues
   * — so a connection whose socket died is still written to. Six small statements per transaction
   * because "small" is what postgres.js defers through `setImmediate`.
   */
  async function txnTask(id: number): Promise<void> {
    while (!stop) {
      try {
        await sql.begin(async (tx) => {
          for (let k = 0; k < 6; k++) await tx`select ${id}::int as i, ${k}::int as k`;
        });
        committed++;
      } catch { /* every statement in flight when the transport dies rejects; that is expected */ }
      if (committed % 7 === 0) await sleep(0);
    }
  }
  const tasks = Array.from({ length: 6 }, (_, i) => txnTask(i));

  await sleep(500);
  const warm = committed;

  let rounds = 0;
  for (let r = 0; r < ROUNDS; r++) {
    rounds++;
    await sleep(60 + Math.floor(Math.random() * 90));
    proxy.cut();
    await sleep(150 + Math.floor(Math.random() * 150));
    await proxy.restore();
    await sleep(700);
  }

  // ── RESUME. The survival claim is worthless without it: a process that is technically alive but
  //    no longer talking to Postgres has not ridden out the outage, it has just failed quietly.
  //
  //    POLLED, WITH A LARGE BUDGET, AND THE BUDGET IS THE DRIVER'S. postgres.js backs its
  //    reconnects off as `(0.5 + rand/2) · min(3^retries / 100, 20)` seconds on a counter SHARED
  //    across the pool, so five pooled connections reach the twenty-second cap within the first
  //    second of an outage — `shared-db-fault.pg.test.ts` measured that and gives its own recovery
  //    wait 90 s for it. A fixed 2.5 s window was tried first and reported "did not resume" on a
  //    process that was merely waiting out that backoff: a fixture failure wearing the costume of
  //    a product one. `resumeMs` is reported so the parent's failure message can tell the two
  //    apart if this ever goes red.
  const atRestore = committed;
  const resumeStart = Date.now();
  while (committed === atRestore && Date.now() - resumeStart < 60_000) await sleep(100);
  const afterRestore = committed;
  const resumeMs = Date.now() - resumeStart;

  // Every task must finish: a transaction that waits for ever is the phantom-rollback hang, reported
  // here rather than as the parent's test timeout. 30 s covers the driver's 20 s backoff cap.
  stop = true;
  const settled = await Promise.race([Promise.allSettled(tasks).then(() => true), sleep(30_000).then(() => false)]);
  try { await sql.end({ timeout: 2 }); } catch { /* the pool may already be in pieces */ }

  process.stdout.write(JSON.stringify({
    event: "child_summary", mode: MODE, rounds, warm, resumeMs, settled,
    survived, committedAtRestore: atRestore, committedAfterRestore: afterRestore,
  }) + "\n");
  process.exit(0);
}

void main();
