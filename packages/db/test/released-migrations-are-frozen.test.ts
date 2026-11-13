import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIGRATION_ALLOWANCES } from "../src/migration-allowances.js";

/**
 * A RELEASED MIGRATION FILE IS IMMUTABLE — and this is the check, not a convention.
 *
 * drizzle records `sha256(<the .sql file>)` when it applies one, so editing a shipped migration
 * makes every database that ran it disagree with the tree for ever. A publish campaign reworded
 * comments inside many already-applied files and a production deployment refused six weeks later.
 *
 * `scripts/pin-released-migrations.mjs --write --release <x.y.z> --tag <release commit>` writes the
 * pins, which cover exactly the files the three journals (mail, Cloud, device store) named there;
 * `--check` compares without writing. A migration added AFTER it is unpinned.
 *
 * THE ONE DOOR OUT, and it is the same one the DEPLOYMENT uses. `MIGRATION_ALLOWANCES` admits an
 * edited file by naming both hashes — what the row records and what the tree ships — so a pin this
 * lock holds may be superseded by an allowance whose SHIPPED hash is the file's current bytes, for
 * that tag, and by nothing else. Without this the two rules disagreed: the deployment would
 * proceed over a change this lock refused, and a lane would have to choose which gate to believe.
 *
 * THE DEVICE STORE HAS NO SUCH DOOR. Its migrator records an applied entry by FILE NAME alone and
 * applies the directory in name order: there is no recorded hash an allowance could name, a
 * renamed entry is applied a second time, and an entry added below the newest released one runs
 * out of order on every store already past it. So a pinned device file keeps its bytes and its
 * name, and nothing new sorts below the highest pinned name.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const LOCK_PATH = join(REPO, "packages", "db", "released-migrations.lock.json");
const DEVICE = "packages/db-mail/drizzle-sqlite/";
const isDevice = (path: string): boolean => path.startsWith(DEVICE);

interface Lock {
  release: string | null;
  tag: string;
  note: string;
  files: Record<string, string>;
}

const LOCK = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as Lock;

/** The same hash drizzle's migrator computes: the file, decoded utf8, sha256. */
const hashOf = (path: string): string =>
  createHash("sha256").update(readFileSync(join(REPO, path), "utf8")).digest("hex");

/** The pinned files this tree still holds; the ones it lost are the name case's to report. */
const PINNED = Object.entries(LOCK.files).filter(([path]) => existsSync(join(REPO, path)));

// Every case reads this tree alone; the ones reading the commit the lock names run where that history is.
describe("released migration files are frozen", () => {
  it("the lock names a release commit and a non-trivial set of files", () => {
    expect(LOCK.tag, "the lock names no release commit").toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(LOCK.files).length).toBeGreaterThan(100);
  });

  /** The hashes an allowance says this tag's file may now carry, by tag; none for a device file. */
  const admitted = (path: string): string[] => {
    if (isDevice(path)) return [];
    const tag = path.split("/").pop()!.replace(/\.sql$/, "");
    return MIGRATION_ALLOWANCES.filter((a) => a.tag === tag).map((a) => a.shipped);
  };

  it("every pinned migration file is byte-for-byte what it was at the release", () => {
    const moved = PINNED
      .filter(([path, hash]) => hashOf(path) !== hash)
      .filter(([path]) => !admitted(path).includes(hashOf(path)))
      .map(([path]) => path);
    expect(
      moved,
      "a released migration is immutable; write a new migration, or name the pair in " +
        "MIGRATION_ALLOWANCES if the deployment can admit it — these files were edited after " +
        `they shipped at ${LOCK.tag}, and every database that already ran them records the old ` +
        "bytes for ever",
    ).toEqual([]);
  });

  /**
   * THE DOOR IS NARROW, WATCHED. An allowance admits the file it NAMES and no other: the same
   * shipped hash under a different tag must not let a second file through, which is the shape a
   * tag-blind lookup would have.
   */
  it("an allowance admits its own tag's file and nothing else", () => {
    for (const a of MIGRATION_ALLOWANCES) {
      const own = Object.keys(LOCK.files).filter((p) => !isDevice(p) && p.endsWith(`/${a.tag}.sql`));
      expect(own.length, `${a.tag} is not a pinned file`).toBe(1);
      expect(admitted(own[0]!)).toContain(a.shipped);
      const foreign = Object.keys(LOCK.files).find((p) => !isDevice(p) && !p.endsWith(`/${a.tag}.sql`))!;
      expect(admitted(foreign), "an allowance reached another tag's file").not.toContain(a.shipped);
    }
  });

  /**
   * NO ALLOWANCE REACHES A DEVICE STORE. The table's journals are the two a deployment reads, and
   * a device file that shares its name with an allowed server file is still admitted nothing.
   */
  it("an allowance names the mail or the Cloud journal, and never admits a device-store file", () => {
    expect(MIGRATION_ALLOWANCES.filter((a) => a.journal !== "mail" && a.journal !== "cloud")).toEqual([]);
    const device = Object.keys(LOCK.files).filter(isDevice);
    expect(device.length, "the lock pins no device-store file").toBeGreaterThan(0);
    const namesakes = device.filter((p) => MIGRATION_ALLOWANCES.some((a) => p === `${DEVICE}${a.tag}.sql`));
    expect(namesakes.length, "no device file shares a name with an allowed one: this case proves nothing").toBeGreaterThan(0);
    for (const path of device) expect(admitted(path), path).toEqual([]);
  });

  it("every pinned migration file still carries its released name", () => {
    const gone = Object.keys(LOCK.files).filter((path) => !existsSync(join(REPO, path)));
    expect(
      gone,
      "a released migration keeps its file name: a device store knows an applied entry by its " +
        "name alone and applies a renamed one a second time, and a server journal names the file " +
        `in meta/_journal.json — these files shipped at ${LOCK.tag} and are gone from the tree`,
    ).toEqual([]);
  });

  /**
   * THE DEVICE JOURNAL'S HEAD. A device applies the directory's `.sql` files in name order and
   * skips the names it has; a new file below the newest released name is applied AFTER entries
   * written on top of what it was meant to precede. A placeholder (`NNNN.noop`) turned into a
   * `.sql` is that insertion.
   */
  it("no unpinned device-store migration sorts below the highest pinned one", () => {
    const pinned = new Set(Object.keys(LOCK.files).filter(isDevice).map((p) => p.slice(DEVICE.length)));
    const head = [...pinned].sort().pop();
    expect(head, "the lock pins no device-store file").toBeDefined();
    const below = readdirSync(join(REPO, DEVICE)).filter((f) => f.endsWith(".sql") && !pinned.has(f) && f < head!);
    expect(
      below,
      `a new device-store migration takes a name above ${head}: every store that already applied ` +
        "the released entries would run these after them, out of order",
    ).toEqual([]);
  });

  /**
   * Every edited file is admitted BY an allowance, so the door is used and not merely present. An
   * allowance whose shipped hash IS the pin describes a file that was edited before this lock was
   * written and has not moved since — it admits nothing here and is not counted.
   */
  it("the files that moved are exactly the ones an allowance names", () => {
    const moved = PINNED.filter(([path, hash]) => hashOf(path) !== hash);
    const movedTags = moved.map(([path]) => path.split("/").pop()!.replace(/\.sql$/, "")).sort();
    const named = [...new Set(MIGRATION_ALLOWANCES
      .filter((a) => moved.some(([path]) => !isDevice(path) && path.endsWith(`/${a.tag}.sql`) && hashOf(path) === a.shipped))
      .map((a) => a.tag))].sort();
    expect(movedTags, "a file moved with no allowance, or an allowance names no moved file")
      .toEqual(named);
  });
});
