import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { createCloudSidecar, type CloudSidecar } from "../../src/cloud-engine.js";
import { createSidecar, type Sidecar } from "../../src/engine.js";
import { createSidecarLog } from "../../src/log.js";

/**
 * `boot_phases` — WHERE THE "OPENING YOUR MAILBOX" SECONDS GO, ON BOTH DOORS.
 *
 * Both sidecar doors serve the bridge only after their constructor returns (`main.ts` awaits
 * `createSidecar` / `createCloudSidecar` before `serveOverStdio`), so the window's opening screen
 * lasts exactly as long as that constructor. This line is the only thing that says which phase
 * inside it owned the wait.
 *
 * ── WHY THIS TEST DRIVES THE REAL LOGGER ──────────────────────────────────────────────────
 *
 * `packages/core/src/log.ts` records the same mistake twice: the worker's six attach-phase
 * durations and the sensitivity pass's eight counts both shipped as call sites WITHOUT their
 * `ALLOWED_FIELDS` entries, so the first live line read `droppedFields=[…]` and every number the
 * change existed to report was refused — and neither package's own tests could see it, because
 * they inject a FAKE logger and therefore assert what the call site hands over, never what the
 * census lets through. So every assertion here goes through `createSidecarLog`, reads the bytes
 * the sink was handed, and checks `droppedFields` explicitly.
 *
 * ── WHAT MAKES IT BITE ────────────────────────────────────────────────────────────────────
 *
 * The field set is asserted EXACTLY, not by presence. Dropping any one of the five phases from
 * either constructor's call turns this red, which is the mutation this guard was watched to fail
 * on; so does adding a sixth without saying so here. A test that only checked
 * `typeof line.totalReadyMs === "number"` would stay green through four of the five going missing.
 */

/** What the logger authors on every line; everything else on the line came from the call site. */
const LOGGER_OWNED = ["ts", "level", "service", "event"];

/** The five, in the order the constructors pass them. Order is not asserted; membership is. */
// `compactMs` joined with the bloat-compaction pass (`reclaimBodyBloat`) — a healthy launch
// reports ~a millisecond of ANALYZE there, and the ONE launch that rewrites a mostly-dead body
// table is exactly the launch whose minutes this line has to attribute.
// `searchSetupMs` joined with the search extensions (`setUpLocalSearch`): the one launch that
// builds the trigram indexes on an existing store pays seconds there, every later one a catalog read.
// `treeSyncMs` joined when a new store stopped syncing per index: its one tree sync, named apart
// from `migrateMs` (0 on every start that did not make the store).
const PHASES = ["pgliteOpenMs", "adoptBaselineMs", "migrateMs", "treeSyncMs", "compactMs", "searchSetupMs", "worldMs", "totalReadyMs"] as const;

/**
 * The schema upgrade, named beside the time it took. `migrateMs` alone read minutes on a large
 * store and said nothing about which of the twelve migrations spent it. These four are NUMBERS OR
 * `null` rather than numbers: nothing ran, or the store does not migrate here at all (the phone's),
 * and a zero would be a measurement nobody took.
 */
const MIGRATIONS = ["migrationsPending", "migrationsApplied", "slowestMigration", "slowestMs"] as const;

const ADDRESS = "mila@example.test";

const dirs: string[] = [];
const local: Sidecar[] = [];
const cloud: CloudSidecar[] = [];

afterEach(async () => {
  for (const s of local.splice(0)) await s.stop().catch(() => undefined);
  for (const s of cloud.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-boot-phases-"));
  dirs.push(d);
  return d;
}

function capture(): { lines: string[]; log: ReturnType<typeof createSidecarLog>; text: () => string } {
  const lines: string[] = [];
  return {
    lines,
    log: createSidecarLog({ sink: (l) => { lines.push(l); } }),
    text: () => lines.join("\n"),
  };
}

/** The one `boot_phases` line, parsed, or a failure that names the door rather than a `undefined`. */
function bootLine(door: string, lines: string[]): Record<string, unknown> {
  const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const found = parsed.filter((l) => l.event === "boot_phases");
  expect(found.length, `${door} emitted ${found.length} boot_phases lines, not 1`).toBe(1);
  return found[0]!;
}

/**
 * Every claim the line makes, checked on the bytes.
 *
 * Split out because the two doors share `openLocalDb` and NOTHING else in their assembly, so the
 * only way this instrumentation is worth reading is if both emit the identical shape — one search
 * across a support log, whichever mode the install is in.
 */
function assertShape(door: string, line: Record<string, unknown>): void {
  expect(line.level, door).toBe("info");
  expect(line.service, door).toBe("sidecar");

  // EXACTLY the five, plus the upgrade census. This is the assertion a dropped phase fails.
  const carried = Object.keys(line).filter((k) => !LOGGER_OWNED.includes(k)).sort();
  expect(carried, `${door} does not carry exactly the six phases and the upgrade census`)
    .toEqual([...PHASES, ...MIGRATIONS].sort());

  // The census refused nothing. Without this, five missing `ALLOWED_FIELDS` entries would show up
  // as an empty line rather than a failure — the attach-phase defect, verbatim.
  expect(line.droppedFields, `${door} had fields refused by the census`).toBeUndefined();

  for (const phase of PHASES) {
    const v = line[phase];
    expect(typeof v, `${door}.${phase} is not a number`).toBe("number");
    expect(Number.isFinite(v as number), `${door}.${phase} is not finite`).toBe(true);
    expect(v as number, `${door}.${phase} is negative`).toBeGreaterThanOrEqual(0);
  }

  // The census: an ordinary launch has nothing pending and nothing slowest, and says so with a
  // number and a null rather than by leaving the field off — a missing field reads as an engine
  // that cannot answer, which is a different fact from "no migration ran".
  expect(typeof line.migrationsPending, `${door}.migrationsPending`).toBe("number");
  expect(typeof line.migrationsApplied, `${door}.migrationsApplied`).toBe("number");
  expect(line.slowestMigration === null || typeof line.slowestMigration === "string",
    `${door}.slowestMigration is neither a tag nor null`).toBe(true);
  expect(line.slowestMs === null || typeof line.slowestMs === "number",
    `${door}.slowestMs is neither a duration nor null`).toBe(true);

  // `totalReadyMs` BRACKETS the other four — it is the whole constructor, they are pieces of it.
  // This is what makes "the remainder is everything else the constructor does" a subtraction a
  // reader can trust rather than a sentence in a comment.
  const named = line.pgliteOpenMs as number
    + (line.adoptBaselineMs as number)
    + (line.migrateMs as number)
    + (line.treeSyncMs as number)
    + (line.worldMs as number);
  expect(line.totalReadyMs as number, `${door}: the phases do not fit inside the total`)
    .toBeGreaterThanOrEqual(named);
}

describe("boot_phases — the constructor the window waits on says which phase it spent", () => {
  it("the LOCAL door emits it, with the five phases and nothing else", async () => {
    const dir = tempDir();
    const c = capture();
    // Assembly only: `adapterFactory` means no IMAP connection is opened, and `createSidecar` is
    // where the whole boot is decided, so this is the real call site rather than an imitation.
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: ADDRESS, pass: "app-password-9f3a" } },
      log: c.log,
      adapterFactory: () => ({ close: async () => undefined }) as unknown as MailboxAdapter,
    });
    local.push(sidecar);

    const line = bootLine("local", c.lines);
    assertShape("local", line);
    // This start made the store, so its one tree sync is on the line.
    expect(line.treeSyncMs as number, "a first start named no tree sync").toBeGreaterThan(0);

    // The line is a timing, so it must name no mailbox and no machine. `serving` dropped `dataDir`
    // for exactly this reason: a data directory is a path under the user's home and carries the OS
    // account name. A temp dir here contains a random suffix, so this also catches a path arriving
    // under some other key.
    const boot = c.lines.find((l) => l.includes("boot_phases"))!;
    expect(boot).not.toContain(dir);
    expect(boot).not.toContain(ADDRESS);
    expect(boot).not.toContain("app-password-9f3a");
  }, 180_000);

  it("the CLOUD door emits the identical shape", async () => {
    const dir = tempDir();
    const c = capture();
    // Pre-auth: no tokens, so nothing reaches a network and `fetchImpl` is never called. The boot
    // this measures is the one an install does on every launch regardless of session state.
    const sidecar = await createCloudSidecar({
      dataDir: dir,
      cloudUrl: "https://cloud.invalid",
      address: ADDRESS,
      log: c.log,
      fetchImpl: (() => { throw new Error("cloud mode reached the network during assembly"); }) as unknown as typeof fetch,
    });
    cloud.push(sidecar);

    assertShape("cloud", bootLine("cloud", c.lines));

    const boot = c.lines.find((l) => l.includes("boot_phases"))!;
    expect(boot).not.toContain(dir);
    expect(boot).not.toContain(ADDRESS);
  }, 180_000);

  it("a SECOND launch on the same directory is measured too — the upgrade path, not just first run", async () => {
    // A first launch creates the schema; every launch after it replays nothing and opens an
    // established mirror. That second shape is the one a person waiting on "Opening your mailbox"
    // is actually in, so a guard that only ever saw a fresh directory would be measuring the case
    // that does not matter.
    const dir = tempDir();
    const first = await createCloudSidecar({
      dataDir: dir, cloudUrl: "https://cloud.invalid", address: ADDRESS, log: capture().log,
    });
    await first.stop();

    const c = capture();
    const second = await createCloudSidecar({
      dataDir: dir, cloudUrl: "https://cloud.invalid", address: ADDRESS, log: c.log,
    });
    cloud.push(second);

    const line = bootLine("cloud/relaunch", c.lines);
    assertShape("cloud/relaunch", line);
    // Nothing to replay, but the migrator still reads the journal and the ledger table, so this is
    // a bound on the phase rather than an assertion that it is free.
    expect(line.migrateMs as number).toBeLessThan(line.totalReadyMs as number);
    expect(line.treeSyncMs, "a reopen synced a tree it did not make").toBe(0);
  }, 240_000);
});
