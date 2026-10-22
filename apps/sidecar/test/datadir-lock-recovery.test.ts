import { describe, expect, it } from "vitest";
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DataDirLockedError,
  HOLD_FILE,
  LOCK_FILE,
  bootIdFromRegQuery,
  imageFromTasklistCsv,
  lockDataDir,
  normalizedImage,
} from "../src/db.js";

/**
 * ═══ A LOCK WHOSE OWNER IS PROVABLY GONE IS RECLAIMED; ONE THAT MIGHT BE AN ENGINE IS NOT ═══
 *
 * After a hard power-off the desktop's data-dir lock survives its writer, and on a machine that
 * hands the dead engine's pid to some other process `kill(pid, 0)` answers "alive" for ever —
 * measured on the Windows guest as a permanent whole-app lockout whose own advice ("quit ohmail
 * and open it again") could not work. The judge therefore reads WHAT holds the number, and this
 * file drives each reclaim arm and the one refusal through the real `lockDataDir` on real
 * temp directories, with processes the test itself owns:
 *
 *   dead pid            → reclaimed   (the crash residue every platform can prove)
 *   live, not an engine → reclaimed   (a recycled pid on a live system process)
 *   another boot        → reclaimed   (the machine rebooted; nothing survived it)
 *   recorded image ≠ live → reclaimed (recycled within a boot, even onto another engine image)
 *   live engine image, no contrary evidence → REFUSED with the person's class
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ohmail-lockrec-"));
}

/** The verdict, or the refusal's class — never a raw throw through the reporter. */
function outcome(dir: string, log?: (event: string, detail: Record<string, unknown>) => void): "took" | "refused" {
  try {
    lockDataDir(dir, log)();
    return "took";
  } catch (err) {
    if (err instanceof DataDirLockedError) return "refused";
    throw err;
  }
}

/** A pid that HAS exited — a real one, so the liveness probe answers about a real absence. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  expect(child.pid, "the throwaway child never spawned").toBeGreaterThan(0);
  return child.pid!;
}

describe("the data-directory lock reclaims a provably dead owner", () => {
  it("a lock naming a DEAD pid is reclaimed, the engine starts, and the log says so once", () => {
    const dir = tempDir();
    writeFileSync(join(dir, LOCK_FILE), `${JSON.stringify({ pid: deadPid() })}\n`);
    const events: Array<{ event: string; kind: unknown }> = [];
    expect(
      outcome(dir, (event, detail) => events.push({ event, kind: detail.kind })),
      "a lock whose owner exited was refused — the power-loss residue is permanent again",
    ).toBe("took");
    expect(events).toEqual([{ event: "data_dir_lock_reclaimed", kind: "owner-gone" }]);
  });

  it("a lock naming a LIVE process that could not be an engine is reclaimed", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("spawn", resolve));
    try {
      const dir = tempDir();
      // The legacy record shape: a pid and nothing else. Its number is alive — the test owns the
      // process — but what runs there is `sleep`, which no engine ever is.
      writeFileSync(join(dir, LOCK_FILE), `${JSON.stringify({ pid: child.pid })}\n`);
      const events: Array<{ event: string; kind: unknown }> = [];
      expect(
        outcome(dir, (event, detail) => events.push({ event, kind: detail.kind })),
        "a recycled pid on a live non-engine process was refused — the lockout this fix removes",
      ).toBe("took");
      expect(events).toEqual([{ event: "data_dir_lock_reclaimed", kind: "owner-replaced" }]);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("a lock from ANOTHER BOOT is reclaimed even when its pid is live as an engine", () => {
    const dir = tempDir();
    // This very process's pid — alive, image `node` — but the record says it was written under a
    // boot this machine has never had, and a different boot id is evidence enough on its own.
    writeFileSync(
      join(dir, LOCK_FILE),
      `${JSON.stringify({ pid: process.pid, bootId: "00000000-0000-4000-8000-000000000000" })}\n`,
    );
    expect(outcome(dir)).toBe("took");
  });

  it("a RECORDED image that differs from the live one is a different process — reclaimed", () => {
    const dir = tempDir();
    writeFileSync(join(dir, LOCK_FILE), `${JSON.stringify({ pid: process.pid, exe: "greenmail" })}\n`);
    expect(outcome(dir)).toBe("took");
  });

  /** The POSITIVE CONTROL for every arm above: the true "another copy is open" case refuses. */
  it("a live pid wearing an engine image with no contrary evidence is REFUSED by class", () => {
    const dir = tempDir();
    const path = join(dir, LOCK_FILE);
    writeFileSync(path, `${JSON.stringify({ pid: process.pid })}\n`);
    expect(
      outcome(dir),
      "a live node process was reclaimed on no evidence — two engines on one directory corrupt it",
    ).toBe("refused");
    expect(existsSync(path), "the refusal deleted the lock it refused over").toBe(true);
  });

  /**
   * …AND WHAT IT STANDS ON PER PLATFORM. Linux reads a start time out of `/proc`; macOS and Windows
   * have none a reader can trust, so there the OS holds the lock and the record names the file it
   * holds. Either way a second take is refused while it is held and succeeds once it is released.
   */
  it("the record this build writes names its owner: pid, boot, image, start or hold, nonce", () => {
    const dir = tempDir();
    const osHeld = process.platform === "darwin" || process.platform === "win32";
    const release = lockDataDir(dir);
    const rec = JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")) as Record<string, unknown>;
    expect(rec.pid).toBe(process.pid);
    expect(typeof rec.bootId, "no boot id on this host").toBe("string");
    expect(rec.exe).toBe("node");
    if (osHeld) {
      expect(existsSync(join(dir, HOLD_FILE)), "no OS-held lock beside the record on macOS or Windows").toBe(true);
    } else {
      expect(Number.isInteger(rec.startTicks), "no start ticks on a Linux host").toBe(true);
    }
    expect(typeof rec.nonce).toBe("string");
    expect(outcome(dir), "a second take while the lock is held").toBe("refused");
    release();
    expect(existsSync(join(dir, LOCK_FILE)), "release left the lock behind").toBe(false);
    if (osHeld) {
      /* Read once it is let go, through a descriptor as the engine reads its own: Windows opens
         nothing another descriptor holds exclusively. */
      const fd = openSync(join(dir, HOLD_FILE), "r");
      try {
        const st = fstatSync(fd, { bigint: true });
        expect(rec.hold, "the record does not name the file the OS held")
          .toEqual({ dev: String(st.dev), ino: String(st.ino) });
      } finally {
        closeSync(fd);
      }
    }
    expect(outcome(dir), "the lock outlived its release").toBe("took");
  });
});

describe("the platform readings parse exactly what their tools print", () => {
  it("reads Windows' per-boot counter out of reg query's answer, and nothing out of anything else", () => {
    const out =
      "\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters\r\n" +
      "    BootId    REG_DWORD    0x1f\r\n\r\n";
    expect(bootIdFromRegQuery(out)).toBe("winboot-31");
    expect(bootIdFromRegQuery("ERROR: The system was unable to find the specified registry key or value.")).toBe(null);
    expect(bootIdFromRegQuery(null)).toBe(null);
  });

  it("reads exactly the asked pid's image out of tasklist's CSV", () => {
    expect(imageFromTasklistCsv('"node.exe","4816","Console","1","64,772 K"', 4816)).toBe("node");
    expect(imageFromTasklistCsv('"svchost.exe","4816","Services","0","9,120 K"', 4816)).toBe("svchost");
    // The localized no-match sentence is not a row, and a row for a DIFFERENT pid answers
    // nothing rather than the wrong process — both are "cannot tell", which refuses.
    expect(imageFromTasklistCsv("INFO: No tasks are running which match the specified criteria.", 4816)).toBe(null);
    expect(imageFromTasklistCsv('"node.exe","512","Console","1","64,772 K"', 4816)).toBe(null);
    expect(imageFromTasklistCsv(null, 4816)).toBe(null);
  });

  it("normalizes an image to the name two different readers agree on", () => {
    expect(normalizedImage("C:\\Program Files\\ohmail\\resources\\runtime\\node.exe")).toBe("node");
    expect(normalizedImage("/usr/lib/ohmail/node")).toBe("node");
    // `/proc/<pid>/exe` grows this marker when the binary is replaced on disk under a live
    // process; without the strip, upgrading Node under a running engine reads as a thief.
    expect(normalizedImage("/usr/bin/node (deleted)")).toBe("node");
    expect(normalizedImage("/usr/lib/systemd/systemd")).toBe("systemd");
  });
});
