import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { mailSchema } from "@trafficflow/db/mail";
import { MAIL_JOURNAL, readJournalOf, type JournalEntry } from "@trafficflow/db/journal";
import {
  openLocalDb, openPhaseFor, PGDATA_SUBDIR, REPLAY_PHASE_BYTES, SLOW_MIGRATION_MS,
  type LocalDbOpenPhase, type MigrationProgress, type OpenLocalDb,
} from "../src/db.js";
import { createSidecar, type BootPhase, type Sidecar } from "../src/engine.js";
import { FrameDecoder } from "../src/frame.js";
import { bootPhaseEmitter } from "../src/main.js";

/**
 * ══ THE BOOT NARRATES ITSELF — `phase` frames, so the window can say what the wait is ══════════
 *
 * `boot_phases` (the log line) says where the seconds WENT; this says what is happening NOW.
 * The chain is: `openLocalDb`/`createSidecar` call `onPhase` as each phase begins →
 * `main.ts` writes each one as a `{t:"phase"}` frame → the shell records the latest → the window
 * renders it as a sentence. This file pins the first two links; the desktop's
 * `desktop-boot-status.test.tsx` pins the last.
 *
 * The phase VOCABULARY is asserted exactly. It is a wire contract with a hand-written mapping at
 * the far end (`BootStatus.tsx`), so a renamed or added phase must fail a test here rather than
 * silently render as the fallback sentence for every launch.
 */

const ADDRESS = "someone@example.test";

const dirs: string[] = [];
const running: Sidecar[] = [];

afterEach(async () => {
  for (const s of running.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-boot-narration-"));
  dirs.push(d);
  return d;
}

async function boot(dataDir: string): Promise<{ phases: BootPhase[] }> {
  const phases: BootPhase[] = [];
  const sidecar = await createSidecar({
    dataDir,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: ADDRESS } },
    log: () => undefined,
    onPhase: (p) => phases.push(p),
  });
  running.push(sidecar);
  return { phases };
}

describe("the constructor names its phases, in the order they happen", () => {
  it("a first launch: create, migrate, prepare", async () => {
    const dir = tempDir();
    const { phases } = await boot(dir);
    expect(phases).toEqual(["creating_store", "migrating", "preparing"]);
  }, 180_000);

  it("every launch after it: open, migrate, prepare", async () => {
    const dir = tempDir();
    await boot(dir);
    await running.pop()!.stop();

    const { phases } = await boot(dir);
    expect(phases).toEqual(["opening_store", "migrating", "preparing"]);
  }, 180_000);
});

/**
 * THE UPGRADE COUNTS ITSELF, AND NAMES WHAT IT COST. The launch behind this: a large store,
 * twelve migrations and minutes of `migrateMs` at full CPU behind one motionless
 * sentence, reported as "stuck at five minutes". So the phase carries how far it has got, and the
 * open names the migration that paid.
 *
 * Every case here is an UPGRADE: a store migrated through part of the journal, opened against all
 * of it. A fresh temp directory is a first launch — one transaction over an empty database — and
 * it is the first case below precisely so the two are never confused.
 */
describe("the schema upgrade says how far it has got", () => {
  /** Every phase this open announced, payload included, plus what it logged. */
  async function open(
    dir: string,
    opts: { slowMigrationFloorMs?: number } = {},
  ): Promise<{
    phases: Array<{ phase: LocalDbOpenPhase; progress: MigrationProgress | undefined }>;
    lines: Array<{ event: string; detail: Record<string, unknown> }>;
    migrations: OpenLocalDb["migrations"];
  }> {
    const phases: Array<{ phase: LocalDbOpenPhase; progress: MigrationProgress | undefined }> = [];
    const lines: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const opened = await openLocalDb(dir, {
      ...opts,
      log: (event, detail) => lines.push({ event, detail }),
      onPhase: (phase, progress) => phases.push({ phase, progress }),
    });
    const { migrations } = opened;
    await opened.close();
    return { phases, lines, migrations };
  }

  /**
   * A store as an OLDER INSTALL left it: migrated through a PREFIX of the journal, so opening it
   * with the real one is an upgrade with `owed` migrations to run — which is the only shape the
   * counting is about. Built with drizzle's own migrator over a COPY of the journal folder whose
   * `_journal.json` stops early: the SQL, the order and the ledger are the product's own, and the
   * only thing this fixture decides is where the old install stopped. Answers the entries it
   * owes, so a test names them rather than recomputing the arithmetic it is checking.
   */
  /** Three entries of the 1.0 road and the six of the 2.0 window, which an open takes as one step. */
  const OWED = 9;
  async function oldInstall(dataDir: string, owed: number): Promise<JournalEntry[]> {
    const entries = readJournalOf(MAIL_JOURNAL);
    const folder = tempDir();
    cpSync(MAIL_JOURNAL.dir, folder, { recursive: true });
    const path = join(folder, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(path, "utf8")) as { entries: JournalEntry[] };
    journal.entries = entries.slice(0, entries.length - owed);
    writeFileSync(path, JSON.stringify(journal));

    const client = new PGlite(join(dataDir, PGDATA_SUBDIR));
    await client.waitReady;
    await migrate(drizzle(client, { schema: mailSchema }), {
      migrationsFolder: folder,
      migrationsSchema: MAIL_JOURNAL.migrationsSchema,
    });
    await client.close();
    return entries.slice(entries.length - owed);
  }

  it("a first launch is not an upgrade: one pass, one phase, nothing to count", async () => {
    const journal = readJournalOf(MAIL_JOURNAL);
    const fresh = await open(tempDir());
    // Byte-for-byte the launch this file has always read here — a first launch has no data for a
    // migration to rewrite, so counting it would buy a person nothing and cost a flush each.
    expect(fresh.phases.map((p) => p.phase)).toEqual(["creating_store", "migrating"]);
    expect(fresh.phases[1]!.progress, "a creation counted itself").toBeUndefined();
    expect(fresh.migrations).toEqual({
      pending: journal.length, applied: journal.length, slowest: null,
    });
  }, 180_000);

  it("an upgrade counts 0 to N, and the launch after it has nothing to count", async () => {
    const dir = tempDir();
    // Three entries short of 1.0.11's head, so this open owes those three and the six of the 2.0 window.
    const owed = await oldInstall(dir, OWED);
    // Not vacuous: with one owed migration a counter and a constant would read alike.
    expect(owed.length).toBeGreaterThan(1);

    const upgrade = await open(dir);
    expect(upgrade.phases[0]!.phase).toBe("opening_store");
    const counted = upgrade.phases.filter((p) => p.phase === "migrating");
    // 0 before the first migration, N after the last: the sequence the window renders as
    // "(3 of 9)", and the one thing a counter that never advanced could not produce. The three
    // entries of the 1.0 road are a step each; the 2.0 window's six are applied together in one
    // transaction, so the count goes from 3 to 9 at once.
    expect(counted.map((p) => p.progress?.applied)).toEqual([0, 1, 2, 3, 9]);
    expect([...new Set(counted.map((p) => p.progress?.pending))]).toEqual([owed.length]);
    expect(upgrade.migrations).toEqual({
      pending: owed.length,
      applied: owed.length,
      slowest: { migration: expect.any(String), ms: expect.any(Number) },
    });
    // The slowest is a journal TAG, and one of the ones this upgrade actually ran.
    expect(owed.map((e) => e.tag)).toContain(upgrade.migrations!.slowest!.migration);

    const again = await open(dir);
    expect(again.phases.map((p) => p.phase)).toEqual(["opening_store", "migrating"]);
    expect(again.phases[1]!.progress, "an empty pass carries no count").toBeUndefined();
    expect(again.migrations).toEqual({ pending: 0, applied: 0, slowest: null });
  }, 300_000);

  it("a migration a person waited for gets a line of its own; one nobody waited for never does", async () => {
    // THE FLOOR, DRIVEN FROM BOTH SIDES. At zero every applied migration crosses it, in journal
    // order, each naming its own tag and what it cost.
    const admitDir = tempDir();
    const owed = await oldInstall(admitDir, OWED);
    const admitted = await open(admitDir, { slowMigrationFloorMs: 0 });
    const spoken = admitted.lines.filter((l) => l.event === "migration_applied");
    expect(spoken.map((l) => l.detail.migration)).toEqual(owed.map((e) => e.tag));
    for (const line of spoken) expect(typeof line.detail.totalMs).toBe("number");

    // …and under the floor that SHIPS — no option at all, {@link SLOW_MIGRATION_MS} — the same
    // migrations say nothing, which is the half that keeps the log worth reading: these take
    // milliseconds each, and nobody waited for any of them.
    const quietDir = tempDir();
    await oldInstall(quietDir, OWED);
    const quiet = await open(quietDir);
    expect(quiet.lines.filter((l) => l.event === "migration_applied")).toEqual([]);
    expect(quiet.migrations!.applied, "the pass still ran").toBe(owed.length);
    expect(SLOW_MIGRATION_MS, "a floor of zero would speak for every migration").toBeGreaterThan(0);
  }, 300_000);
});


describe("openPhaseFor — what the coming open is, read from the directory alone", () => {
  it("no database yet is creating_store", () => {
    expect(openPhaseFor(tempDir())).toBe("creating_store");
  });

  it("a big write-ahead log is replaying_wal; a small one is an ordinary open", () => {
    /* A directory SHAPED like a crashed install, without paying for one: PG_VERSION marks an
       initialized store, and sparse files named like WAL segments carry the size without the
       bytes. `openPhaseFor` must never open the database to answer — a probe that opened a
       corrupt directory would BE the wait it is trying to describe — so a fake this shallow is
       exactly as good as 2 GB of real churn, and these files would crash a real recovery. */
    const dir = tempDir();
    const pgWal = join(dir, PGDATA_SUBDIR, "pg_wal");
    mkdirSync(pgWal, { recursive: true });
    writeFileSync(join(dir, PGDATA_SUBDIR, "PG_VERSION"), "17\n");

    const segment = (name: string, bytes: number): void => {
      const path = join(pgWal, name);
      writeFileSync(path, "");
      truncateSync(path, bytes);
    };
    segment("000000010000000000000001", REPLAY_PHASE_BYTES / 2);
    expect(openPhaseFor(dir), "half the threshold is an ordinary open").toBe("opening_store");

    segment("000000010000000000000002", REPLAY_PHASE_BYTES / 2);
    expect(openPhaseFor(dir), "at the threshold the honest word is replaying").toBe("replaying_wal");

    // Only segment-named files count: `archive_status` and friends are not the log.
    rmSync(join(pgWal, "000000010000000000000002"));
    segment("not-a-segment", REPLAY_PHASE_BYTES);
    expect(openPhaseFor(dir)).toBe("opening_store");
  });
});

describe("the emitter writes frames an actual decoder reads back", () => {
  it("one phase in, one well-formed bodyless phase frame out", () => {
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (c: Buffer) => chunks.push(c));

    const emit = bootPhaseEmitter(out);
    emit("replaying_wal");
    emit("preparing");

    const decoder = new FrameDecoder();
    const frames = decoder.push(Buffer.concat(chunks));
    expect(frames.map((f) => f.header)).toEqual([
      { v: 1, t: "phase", phase: "replaying_wal" },
      { v: 1, t: "phase", phase: "preparing" },
    ]);
    for (const f of frames) expect(f.body.byteLength, "a phase frame carries no body").toBe(0);
    expect(decoder.idle, "the emitter left a partial frame in the stream").toBe(true);
  });

  it("a dead pipe is swallowed — narration must never be able to fail a boot", () => {
    const out = new PassThrough();
    out.destroy();
    const emit = bootPhaseEmitter(out);
    expect(() => emit("opening_store")).not.toThrow();
  });
});
