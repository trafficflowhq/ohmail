import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ═══ ON macOS AND WINDOWS THE OS HOLDS THE DATA DIRECTORY ═══
 *
 * Off Linux no start time can be read, so a live holder was judged by its image alone, and macOS
 * read that image from argv[0]: an engine whose argv[0] was not its executable's name read as "a
 * different process", its live lock was taken, and two engines opened one store. The engine now
 * opens `sidecar.hold` exclusively for as long as it runs (an flock on macOS, sharing mode 0 on
 * Windows). A second engine is refused without judging anything; an engine the kernel let go of is
 * reclaimed whatever its pid names now. Linux keeps the identity rule, and every case here holds
 * there by that rule, so the file runs everywhere.
 *
 * The holders are real processes (`fixtures/hold-the-lock.ts`), spawned with argv[0] renamed.
 */

/** Every tool the lock spawned, by name. */
const tools: string[] = [];
/** Arms ONE failure of the record's removal, for the release that must still let the hold go. */
let failNextRemoval = false;
/** While set, exclusive opens of the hold file are not exclusive: a runtime that drops the flag. */
let dropExclusive = false;

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    execFileSync: ((file: string, ...rest: unknown[]) => {
      tools.push(file);
      return (real.execFileSync as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof real.execFileSync,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    rmSync: ((path: unknown, ...rest: unknown[]) => {
      if (failNextRemoval && typeof path === "string" && path.endsWith("sidecar.lock")) {
        failNextRemoval = false;
        throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
      }
      return (real.rmSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof real.rmSync,
    openSync: ((path: unknown, flags?: unknown, ...rest: unknown[]) => {
      // libuv's exclusive-open bit on macOS (0x20) and Windows (0x10000000), dropped.
      const asked = dropExclusive && typeof path === "string" && path.endsWith("sidecar.hold")
        && typeof flags === "number" ? flags & ~(0x20 | 0x10000000) : flags;
      return (real.openSync as (...a: unknown[]) => unknown)(path, asked, ...rest);
    }) as typeof real.openSync,
  };
});

const { DataDirLockedError, HOLD_FILE, LOCK_FILE, lockDataDir, processImageOf } = await import("../src/db.js");

const SIDECAR_DIR = fileURLToPath(new URL("..", import.meta.url));
/** Where the OS holds the lock. */
const OS_HELD = process.platform === "darwin" || process.platform === "win32";

type Logged = { event: string; kind: unknown };

const children: ChildProcess[] = [];
const dirs: string[] = [];

beforeEach(() => {
  failNextRemoval = false;
  dropExclusive = false;
});

afterEach(async () => {
  for (const child of children.splice(0)) await ended(child);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-lockhold-"));
  dirs.push(dir);
  return dir;
}

/** "took", or the refusal itself — never a raw throw through the reporter. */
function outcome(dir: string, logged?: Logged[]): "took" | InstanceType<typeof DataDirLockedError> {
  try {
    lockDataDir(dir, logged === undefined ? undefined : (event, detail) => logged.push({ event, kind: detail.kind }))();
    return "took";
  } catch (err) {
    if (err instanceof DataDirLockedError) return err;
    throw err;
  }
}

/** Another engine's lock on `dir`, held by a process of its own whose argv[0] is not "node". */
async function holderOn(dir: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["--conditions=ohmail-source", "--import", "tsx", "test/fixtures/hold-the-lock.ts", dir],
    { cwd: SIDECAR_DIR, argv0: "ohmail-engine", stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  let said = "";
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      said += chunk.toString("utf8");
      if (said.includes("held\n")) resolve();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      said += chunk.toString("utf8");
    });
    child.once("exit", (code, signal) => {
      reject(new Error(`the holder ended (${String(code ?? signal)}) before it held the lock: ${said.slice(-800)}`));
    });
  });
  return child;
}

/** A live node process that holds nothing. */
async function bystander(argv0?: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
    stdio: "ignore", ...(argv0 === undefined ? {} : { argv0 }),
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

/** Killed and reaped: once `exit` is out, the kernel has let go of everything it held. */
async function ended(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await gone;
}

/** This boot's id, as this build writes it into a record of its own. */
function thisBoot(): string | undefined {
  const dir = tempDir();
  const release = lockDataDir(dir);
  const rec = JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")) as { bootId?: string };
  release();
  return rec.bootId;
}

describe("the data-directory lock against another live engine", () => {
  /**
   * THE REACHABLE PATH. An engine whose argv[0] is not its executable's name (a renamed runtime
   * link, a title) holds the directory. Refused while it runs, by name; taken once it is gone.
   */
  it("REFUSES while another engine holds it, whatever its argv[0] says, and takes it once that engine is gone", async () => {
    const dir = tempDir();
    const holder = await holderOn(dir);

    const refused = outcome(dir);
    expect(refused, "a second engine opened a directory a live engine holds — two PGlite instances corrupt it")
      .toBeInstanceOf(DataDirLockedError);
    expect((refused as InstanceType<typeof DataDirLockedError>).holder, "the refusal names the running engine")
      .toBe(`pid ${holder.pid}`);

    await ended(holder);
    const logged: Logged[] = [];
    expect(outcome(dir, logged), "a crashed engine's directory stayed locked").toBe("took");
    expect(logged).toEqual([{ event: "data_dir_lock_reclaimed", kind: OS_HELD ? "hold-released" : "owner-gone" }]);
  }, 60_000);

  /** …and the refusal asks the system nothing: no `ps`, no `tasklist`, no `sysctl`, no `reg`. */
  it("refuses a held directory without spawning a tool to judge the holder", async () => {
    const dir = tempDir();
    await holderOn(dir);
    tools.length = 0;
    expect(outcome(dir)).toBeInstanceOf(DataDirLockedError);
    expect(tools, "the refusal judged the holder by asking the system about it").toEqual([]);
  }, 60_000);

  /**
   * A HOLD FILE REPLACED UNDER A LIVE HOLDER is not that holder's hold: the record names the file
   * it held, a fresh one does not match it, and the identity rule refuses. macOS lets the file go
   * while it is locked; Windows refuses the delete itself; Linux has none.
   */
  it("judges by identity, and REFUSES, when the hold file was replaced under a live holder", async () => {
    const dir = tempDir();
    const holder = await holderOn(dir);
    const hold = join(dir, HOLD_FILE);
    expect(existsSync(hold), "the holder holds no file the OS could hold for it").toBe(OS_HELD);
    if (process.platform === "win32") {
      let refused: unknown = null;
      try {
        unlinkSync(hold);
      } catch (err) {
        refused = (err as NodeJS.ErrnoException).code;
      }
      expect(["EBUSY", "EPERM"], "Windows deleted a file another process holds exclusively").toContain(refused);
    } else if (OS_HELD) {
      unlinkSync(hold);
    }
    const refused = outcome(dir);
    expect(refused, "a fresh hold file was trusted over a live holder's record").toBeInstanceOf(DataDirLockedError);
    expect((refused as InstanceType<typeof DataDirLockedError>).holder).toBe(`pid ${holder.pid}`);
  }, 60_000);
});

describe("the data-directory lock after its engine is gone", () => {
  /**
   * AVAILABILITY: the crashed engine's pid now names ANOTHER live node, which is what Windows'
   * fast pid reuse produces. With the hold that pid is never asked about; on Linux the start time
   * tells the two apart.
   */
  it("takes a dead engine's lock even when its pid now names another live node", async () => {
    const dir = tempDir();
    const holder = await holderOn(dir);
    await ended(holder);
    const other = await bystander();
    const path = join(dir, LOCK_FILE);
    const rec = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({ ...rec, pid: other.pid })}\n`);

    const logged: Logged[] = [];
    expect(outcome(dir, logged), "a dead engine's lock refused the launch because its pid came back as node")
      .toBe("took");
    expect(logged).toEqual([{ event: "data_dir_lock_reclaimed", kind: OS_HELD ? "hold-released" : "owner-replaced" }]);
  }, 60_000);

  it("releases the record, keeps the hold file, and lets the hold go", () => {
    const dir = tempDir();
    const release = lockDataDir(dir);
    release();
    expect(existsSync(join(dir, LOCK_FILE)), "the release left the record behind").toBe(false);
    expect(existsSync(join(dir, HOLD_FILE)), "the hold file is permanent where the OS holds the lock")
      .toBe(OS_HELD);
    expect(outcome(dir), "the released directory could not be taken again").toBe("took");
  });

  it.runIf(OS_HELD)("lets the hold go even when removing the record fails", () => {
    const dir = tempDir();
    const release = lockDataDir(dir);
    failNextRemoval = true;
    expect(() => release(), "the failed removal was swallowed").toThrow(/busy/);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
    const logged: Logged[] = [];
    expect(outcome(dir, logged), "the hold outlived a release whose removal failed").toBe("took");
    expect(logged).toEqual([{ event: "data_dir_lock_reclaimed", kind: "hold-released" }]);
  });
});

describe("a record with no hold is judged by identity", () => {
  /**
   * THE FALLBACK READER (a record from a build before the hold, or a filesystem without one). The
   * holder is live node under another argv[0]; macOS must read the name the kernel set at exec.
   */
  it("REFUSES a live node whose argv[0] was renamed", async () => {
    const live = await bystander("ohmail-engine");
    const bootId = thisBoot();
    const dir = tempDir();
    const path = join(dir, LOCK_FILE);
    writeFileSync(path, `${JSON.stringify({
      pid: live.pid, ...(bootId === undefined ? {} : { bootId }), exe: "node", nonce: "n",
    })}\n`);
    expect(outcome(dir), "a live engine's lock was read by its argv[0] and taken").toBeInstanceOf(DataDirLockedError);
    expect(existsSync(path), "the refusal deleted the lock it refused over").toBe(true);
  }, 60_000);

  /** The positive control on that reader: a title a process gives itself never renames it. */
  it("reads the image the kernel names, not a title the process gave itself", () => {
    const title = process.title;
    process.title = "ohmail renamed itself";
    try {
      expect(processImageOf(process.pid)).toBe("node");
    } finally {
      process.title = title;
    }
  });

  /**
   * A HOLD THE OS DOES NOT MAKE EXCLUSIVE is no hold: the take proves itself with a second open, and
   * a runtime that dropped the flag is logged once and judged by identity instead of read as free.
   */
  it.runIf(OS_HELD)("does not trust a hold a second open was not refused", () => {
    const dir = tempDir();
    dropExclusive = true;
    const logged: Logged[] = [];
    const release = lockDataDir(dir, (event, detail) => logged.push({ event, kind: detail.kind }));
    try {
      expect(logged).toEqual([{ event: "data_dir_hold_skipped", kind: "not-exclusive" }]);
      const rec = JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")) as Record<string, unknown>;
      expect(rec.hold, "an unproven hold was written into the record").toBeUndefined();
      expect(outcome(dir), "with no hold, a live engine's record must still refuse").toBeInstanceOf(DataDirLockedError);
    } finally {
      release();
    }
  });
});
