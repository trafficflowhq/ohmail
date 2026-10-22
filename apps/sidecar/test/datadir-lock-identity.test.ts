import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ── THE LOCK IS REMOVED BY IDENTITY, AND A RECORD THIS BUILD CANNOT READ IS NOT EVIDENCE ─────
 *
 * Two halves of one defect. `lockDataDir` judged the lock and then unlinked the PATH, so a
 * process that judged a lock stale could delete the lock another process had already put in its
 * place — after which both hold the directory and two PGlite instances corrupt it. The most
 * reachable spelling needs no scheduler luck at all: the lock is created `O_EXCL` and written a
 * statement later, so a launcher that looks in between reads an EMPTY file, and an empty file
 * was treated as stale.
 *
 * The rule the sibling case already states for the legacy bare pid — "a lock this build cannot
 * read the identity of is not one it may steal on a guess" — is completed here for the record
 * that is not there at all, and the removal is made conditional on the bytes and the inode that
 * were judged.
 */

/**
 * Arms ONE failure of the write that puts the holder record into the lock — the kill, the power
 * loss or the full disk, at the statement where it costs something. Fires once: a rig that kept
 * failing would measure the retry loop instead of the residue.
 */
let onLockWrite: (() => void) | null = null;

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    writeSync: ((...args: unknown[]) => {
      if (onLockWrite !== null) {
        const fire = onLockWrite;
        onLockWrite = null;
        fire();
      }
      return (real.writeSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof real.writeSync,
  };
});

const { DataDirLockedError, HOLD_FILE, LOCK_FILE, lockDataDir } = await import("../src/db.js");

/**
 * What a released directory keeps: on macOS and Windows the OS-held lock's file, which is permanent
 * by design (deleting it would let two launchers lock two different files). Never a temp file.
 */
const KEPT: string[] = process.platform === "darwin" || process.platform === "win32" ? [HOLD_FILE] : [];

/**
 * HOW FAR BACK A CRASH'S RESIDUE IS DATED. Not the module's own window constant, on purpose:
 * these cases are about BEHAVIOUR, and a test that imported the window would stay green on a
 * build that set it to a year. Five minutes is far past anything two adjacent syscalls can
 * occupy, which is the whole of what "empty because a launch is mid-flight" means.
 */
const LONG_AGO_MS = 5 * 60_000;

/** The refusal's own sentence, or the word for what happened instead. */
function refusal(dir: string): string {
  try {
    lockDataDir(dir)();
    return "took";
  } catch (err) {
    if (err instanceof DataDirLockedError) return err.message;
    throw err;
  }
}

/** Back-date a file, as a crash's residue is back-dated by the time since the crash. */
function age(path: string, byMs: number): void {
  const at = (statSync(path).mtimeMs - byMs) / 1000;
  utimesSync(path, at, at);
}

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ohmail-lockid-"));
  return d;
}

/** The refusal, or the word for what happened instead — never a raw throw through the reporter. */
function outcome(dir: string): "refused" | "took" {
  try {
    const release = lockDataDir(dir);
    release();
    return "took";
  } catch (err) {
    if (err instanceof DataDirLockedError) return "refused";
    throw err;
  }
}

describe("the data-directory lock removes by identity", () => {
  beforeEach(() => {
    onLockWrite = null;
  });

  it("REFUSES an empty lock file instead of deleting it — that is a lock mid-creation", () => {
    const dir = tempDir();
    const path = join(dir, LOCK_FILE);
    writeFileSync(path, "");
    expect(
      outcome(dir),
      "an empty lock file was read as stale — that is the O_EXCL window of another launcher",
    ).toBe("refused");
    expect(existsSync(path), "the other launcher's lock file was deleted").toBe(true);
  });

  /**
   * ── AND THE SENTENCE IT REFUSES WITH IS THE ONE A PERSON CAN ACT ON ──────────────────────
   *
   * The positive control on the rule above: a refusal that told somebody to delete a file would
   * be telling them to delete a lock another launch is one syscall from writing its record into.
   * This one clears itself within the window, so the remedy is the wait and the path is named so
   * the sentence is about something rather than about nothing.
   */
  it("…and the FRESH refusal names the lock and asks for a minute, never for a deletion", () => {
    const dir = tempDir();
    const path = join(dir, LOCK_FILE);
    writeFileSync(path, "");
    const said = refusal(dir);
    expect(said, "the fresh empty lock was taken").not.toBe("took");
    expect(said, "the refusal does not name the lock it is about").toContain(path);
    expect(said, "the refusal does not say when to try again").toContain("Wait a minute");
    expect(said, "a person was told to delete their own lock file").not.toContain("delete");
  });

  /**
   * ── THE CRASH BETWEEN THE CREATE AND THE RECORD, WHICH USED TO BE PERMANENT ──────────────
   *
   * A build that created the lock `O_EXCL` and wrote the record a statement later could be
   * killed between the two. The empty file it left is what the case above correctly refuses —
   * and before the atomic claim that refusal was for ever: every later launch read the same
   * empty file and the person's only way back into their own mail was deleting a file they had
   * never heard of.
   *
   * AGE IS THE WHOLE DISCRIMINATOR, because it is the only thing that separates the two states:
   * the window a launch is empty for is two adjacent syscalls. Back-dated five minutes this
   * is residue, and it is adopted once.
   */
  it("ADOPTS a zero-byte lock older than the window — the crash a pre-fix build could leave", () => {
    const dir = tempDir();
    const path = join(dir, LOCK_FILE);
    writeFileSync(path, "");
    age(path, LONG_AGO_MS);

    const release = lockDataDir(dir);
    /* NOT merely "it opened": the file now names THIS process, which is what makes the next
       launch after this one an ordinary one rather than a second adoption. */
    const held = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
    expect(held.pid, "the adopted lock was not replaced by this process's own record")
      .toBe(process.pid);
    release();
    expect(existsSync(path)).toBe(false);
  });

  /* …AND THE SAME RESIDUE DATED AHEAD: the clock was set back after the crash, so the file reads
     as written in the future. Five minutes ahead is no launch in progress either. */
  it("ADOPTS a zero-byte lock dated past the window AHEAD — residue the clock stepped back behind", () => {
    const dir = tempDir();
    const path = join(dir, LOCK_FILE);
    writeFileSync(path, "");
    age(path, -LONG_AGO_MS);
    expect(outcome(dir), "a crash residue refused every launch for as long as the clock's step").toBe("took");
  });

  /**
   * …AND UNREADABLE BYTES ARE NOT THAT SHAPE, whatever their age. Something wrote them, and this
   * build cannot say what — so the rule the file's header states is untouched by the adoption
   * above, which is what keeps that adoption a narrowing rather than "trust old locks".
   */
  it("still refuses an OLD lock whose bytes it cannot parse", () => {
    const dir = tempDir();
    const path = join(dir, LOCK_FILE);
    writeFileSync(path, "{not a record\n");
    age(path, LONG_AGO_MS);
    expect(outcome(dir), "an unreadable record was taken because it was old").toBe("refused");
    expect(readFileSync(path, "utf8"), "the unreadable lock was rewritten").toBe("{not a record\n");
  });

  /**
   * ── THE CRASH ITSELF, INJECTED WHERE IT HAPPENS ─────────────────────────────────────────
   *
   * The defect was never the refusal above; it was that a crash could PRODUCE the file that
   * refusal is right about. `openSync(path, "wx")` created the lock and the record was written by
   * the next statement, so a kill between them left an empty lock naming nobody — and the next
   * launch, and every launch after it, refused.
   *
   * The write is made to fail where the kill would have landed. With the record written to a temp
   * file and linked into place there is nothing under `sidecar.lock` to leave behind, so the
   * directory is as it was and the next launch is an ordinary one.
   *
   * MUTATION: put the two-step create back (`openSync(path, "wx")`, then `writeSync`) and this
   * goes red with an empty `sidecar.lock` standing and the launch after it refusing.
   */
  it("A CRASH BETWEEN THE CREATE AND THE RECORD leaves NO lock at all", () => {
    const dir = tempDir();
    onLockWrite = () => {
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    };

    expect(() => lockDataDir(dir), "the refused claim did not report the write's failure")
      .toThrow(/no space/);
    expect(
      readdirSync(dir),
      "the killed launch left a lock file naming nobody — every later launch refuses it",
    ).toEqual(KEPT);

    /* AND THE NEXT LAUNCH OPENS, which is the whole of what the person experiences. */
    const release = lockDataDir(dir);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
    release();
  });

  /**
   * THE CLAIM IS ONE ACT AND LEAVES NOTHING BESIDE IT. The record is written to a temp file in
   * the same directory and linked into place, so the directory would carry that temp name if the
   * link path ever stopped dropping it — litter in somebody's data directory, one file per launch.
   */
  it("leaves NO temporary file behind — before or after the release", () => {
    const dir = tempDir();
    const release = lockDataDir(dir);
    expect(readdirSync(dir).sort(), "the atomic claim left its temp file in the data directory")
      .toEqual([...KEPT, LOCK_FILE].sort());
    release();
    expect(readdirSync(dir)).toEqual(KEPT);
  });

  /** …and a REFUSED claim leaves none either: the temp file is dropped on that path too. */
  it("leaves no temporary file behind when the claim is REFUSED", () => {
    const dir = tempDir();
    writeFileSync(join(dir, LOCK_FILE), `${process.pid}\n`);   // the legacy spelling, alive
    expect(outcome(dir)).toBe("refused");
    expect(readdirSync(dir).sort(), "a refused claim left its temp file behind")
      .toEqual([...KEPT, LOCK_FILE].sort());
  });

  it("REFUSES a lock file whose bytes it cannot parse, and leaves it alone", () => {
    const dir = tempDir();
    const path = join(dir, LOCK_FILE);
    writeFileSync(path, "{not a record\n");
    expect(outcome(dir), "an unreadable record was taken on a guess").toBe("refused");
    expect(readFileSync(path, "utf8"), "the unreadable lock was rewritten").toBe("{not a record\n");
  });

  it("does NOT remove a lock that was replaced while it was being judged", () => {
    const dir = tempDir();
    const path = join(dir, LOCK_FILE);
    /* A record this process must judge STALE: a boot id that is not this boot's. The alive probe
       fires the replacement, so the file under `path` is a different, LIVE lock by the time the
       removal would run. `kill(pid, 0)` and not the boot id's read: that read is a `/proc` file
       on Linux only, and a cached tool's answer on macOS and Windows, where it never fired. */
    writeFileSync(path, `${JSON.stringify({
      pid: process.pid,
      bootId: "00000000-0000-4000-8000-000000000000",
      bootAtMs: Date.now(),
    })}\n`);
    const replacement = `${JSON.stringify({ pid: process.pid })}\n`;
    const realKill = process.kill.bind(process);
    let fired = 0;
    const probe = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      // Once: a second attempt must judge what it finds, not what this armed.
      if (signal === 0 && fired === 0) {
        fired += 1;
        writeFileSync(path, replacement);
      }
      return realKill(pid, signal);
    }) as typeof process.kill);

    try {
      expect(
        outcome(dir),
        "the lock another launcher had already put in place was deleted — two engines on one directory",
      ).toBe("refused");
      expect(fired, "the judgement never probed the holder, so nothing was replaced").toBe(1);
      expect(readFileSync(path, "utf8"), "the replacement lock was removed").toBe(replacement);
    } finally {
      probe.mockRestore();
    }
  });

  /* ── AND THE ORDINARY CASES STILL WORK, so none of the above is "refuse everything" ───────── */

  it("still takes a lock left by a process that is gone", () => {
    const dir = tempDir();
    const path = join(dir, LOCK_FILE);
    writeFileSync(path, "2147483600\n");                       // a pid that cannot exist
    const release = lockDataDir(dir);
    const held = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
    expect(held.pid, "the stale lock was not replaced by this process's own record").toBe(process.pid);
    release();
    expect(existsSync(path)).toBe(false);
  });

  it("still refuses a lock whose identity matches the live process", () => {
    const dir = tempDir();
    writeFileSync(join(dir, LOCK_FILE), `${process.pid}\n`);   // the legacy spelling, alive
    expect(outcome(dir)).toBe("refused");
  });

  it("takes a free directory and releases it", () => {
    const dir = tempDir();
    const release = lockDataDir(dir);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
    release();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
