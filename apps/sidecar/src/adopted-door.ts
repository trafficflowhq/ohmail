import { randomBytes } from "node:crypto";
import {
  closeSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * THE DOOR A PENDING ENGINE ADOPTS — this install's `config.json`, CREATED once by the first
 * approval claim. The shell starts the identity-pending door only on an install with no door, so
 * the file's absence is the precondition and its creation is the commit: a private staging file,
 * fsynced, then hard-linked into place, which fails when any door is there. A door chosen during
 * the wait therefore wins, and a claim that finds a file is told so. The shape is `config.rs`'s own
 * (`parse` reads it at the next spawn): mode, the base the shell composed, the adopted address.
 */

/** A refusal with the code the window renders a sentence for. */
export class DoorFileError extends Error {
  readonly code: "door_changed" | "door_not_saved";
  /** What the filesystem said, for the log line and never for the window. */
  readonly underlying: unknown;

  constructor(code: "door_changed" | "door_not_saved", message: string, underlying?: unknown) {
    super(message);
    this.name = "DoorFileError";
    this.code = code;
    this.underlying = underlying;
  }
}

const same = (a: unknown, b: string): boolean =>
  typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Is the door already on disk exactly the one this claim would write? A retried claim's case. */
function isThisDoor(doorFile: string, cloudUrl: string, address: string): boolean {
  try {
    const on = JSON.parse(readFileSync(doorFile, "utf8")) as Record<string, unknown>;
    return on.mode === "cloud" && on.cloudUrl === cloudUrl && same(on.address, address)
      && on.identityPending === undefined && on.flavor === undefined && on.hostPin === undefined;
  } catch {
    return false;
  }
}

/**
 * Create `doorFile` naming `address` on `cloudUrl`, or say why not. `"created"` is the commit,
 * `"same"` an identical door already there; any other file is `door_changed`.
 */
export function createAdoptedDoor(doorFile: string, cloudUrl: string, address: string): "created" | "same" {
  const body = `${JSON.stringify({ mode: "cloud", cloudUrl, address }, null, 2)}\n`;
  const staged = join(
    dirname(doorFile),
    `.${basename(doorFile)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = openSync(staged, "wx", 0o600);
    writeSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    try {
      linkSync(staged, doorFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (isThisDoor(doorFile, cloudUrl, address)) return "same";
      throw new DoorFileError(
        "door_changed",
        "this install was set up another way while the browser was being confirmed",
      );
    }
    // The NAME's durability, best effort: some platforms refuse fsync on a directory.
    try {
      const dir = openSync(dirname(doorFile), "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch {
      /* the link is already atomic; what is at risk is only a power cut in the next instant */
    }
    return "created";
  } catch (err) {
    if (err instanceof DoorFileError) throw err;
    throw new DoorFileError("door_not_saved", "ohmail could not save which account this install is for", err);
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { unlinkSync(staged); } catch { /* never created, or already gone */ }
  }
}
