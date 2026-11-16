import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openLocalDb } from "../src/db.js";
import { StoreCopiesLeftError, forgetStoreCopies, markProven, oweStoreCopies, removeProvenCopies } from "../src/store-copies.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * A REMOVAL SOMEBODY ASKED FOR. Every copy of the store goes at once, the copy and every folder a
 * store was moved aside into. The asking is on the disk before the first one is touched, so a
 * removal cut short is finished by the next open, before the database opens. A copy that cannot
 * be removed is said by name of the fault, never by a path. And nothing outside the data folder
 * is reached: a link under a copy's name is unlinked, never followed, and the two small files the
 * copies write (the asking, the mark) are never written through one.
 */

const COPY = "store-before-2.0";
const SET_ASIDE = "set-aside-20260926T101323Z";
const REFILL = "set-aside-refill-20261117T000000Z";
const LATCH = "store-copies.owed";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  dirs.push(dir);
  return dir;
}

function plant(dir: string, name: string): void {
  mkdirSync(join(dir, name, "pgdata", "base"), { recursive: true });
  writeFileSync(join(dir, name, "pgdata", "base", "held"), "a store's bytes");
  writeFileSync(join(dir, name, "cloud-cursor.json"), "{}");
}

/** Every file under `dir` with its bytes: what "untouched" is read from. */
function treeOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, rel: string): void => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(at, e.name), `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = readFileSync(join(at, e.name), "latin1");
    }
  };
  walk(dir, "");
  return out;
}

/** The rename that commits a removal fails for one name, as a folder held open elsewhere fails it. */
function failRemovalOf(name: string): void {
  const real = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(from).endsWith(name)) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    return real(from, to);
  });
}

describe("every copy goes when a removal is asked", () => {
  it("removes the copy and every set-aside, and leaves nothing owed", () => {
    const dir = scratch("ohmail-copies-forget-");
    for (const name of [COPY, SET_ASIDE, REFILL, `${COPY}.partial`]) plant(dir, name);
    writeFileSync(join(dir, "install-key"), "kept");
    const lines: Array<{ event: string; detail: Record<string, unknown> }> = [];
    forgetStoreCopies(dir, "signed_out", (event, detail) => lines.push({ event, detail }));
    expect(readdirSync(dir)).toEqual(["install-key"]);
    expect(lines.map((l) => [l.event, l.detail.kind, l.detail.count, l.detail.verdict]))
      .toEqual([["store_copies_removed", "signed_out", 4, "removed"]]);
  });

  it("removes a copy whose files and folders refuse every read", () => {
    const dir = scratch("ohmail-copies-closed-");
    plant(dir, COPY);
    chmodSync(join(dir, COPY, "pgdata", "base", "held"), 0o000);
    chmodSync(join(dir, COPY, "pgdata", "base"), 0o000);
    chmodSync(join(dir, COPY), 0o500);
    forgetStoreCopies(dir, "mailbox_removed");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("writes nothing where no copy stands", () => {
    const dir = scratch("ohmail-copies-none-");
    writeFileSync(join(dir, "install-key"), "kept");
    forgetStoreCopies(dir, "signed_out");
    oweStoreCopies(dir, "taken_back");
    expect(readdirSync(dir)).toEqual(["install-key"]);
  });

  it("refuses by name while one is left, keeps the removal owed, and says no path", () => {
    const dir = scratch("ohmail-copies-left-");
    plant(dir, COPY);
    plant(dir, SET_ASIDE);
    failRemovalOf(COPY);
    const lines: string[] = [];
    let refused: unknown;
    try {
      forgetStoreCopies(dir, "signed_out", (event, detail) => lines.push(JSON.stringify({ event, ...detail })));
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(StoreCopiesLeftError);
    expect(refused).toMatchObject({ code: "store_copy_not_removed", left: 1 });
    // The one that could go went; the one that could not stands whole, and the asking stands with it.
    expect(readdirSync(dir).sort()).toEqual([COPY, LATCH].sort());
    expect(existsSync(join(dir, COPY, "pgdata", "base", "held"))).toBe(true);
    const said = `${(refused as Error).message}\n${lines.join("\n")}`;
    expect(said).not.toContain(dir);
    expect(said).not.toContain(COPY);
    expect(lines.join("\n")).toContain("store_copies_removal_failed");
  });
});

describe("a removal that was cut short", () => {
  it("is finished by the next open, before the database opens", async () => {
    const dir = await freshDataDir("ohmail-copies-owed-");
    dirs.push(dir);
    plant(dir, COPY);
    plant(dir, SET_ASIDE);
    oweStoreCopies(dir, "signed_out");
    expect(existsSync(join(dir, LATCH)), "nothing was written for a removal that is owed").toBe(true);
    let stood: string[] | null = null;
    const opened = await openLocalDb(dir, {
      onPhase: () => { stood ??= [COPY, SET_ASIDE, LATCH].filter((n) => existsSync(join(dir, n))); },
    });
    await opened.close();
    expect(stood).toEqual([]);
  });

  it("does not fail the open while a copy still cannot be removed; the open after it finishes", async () => {
    const dir = await freshDataDir("ohmail-copies-owed-fail-");
    dirs.push(dir);
    plant(dir, COPY);
    oweStoreCopies(dir, "mailbox_removed");
    failRemovalOf(COPY);
    const first = await openLocalDb(dir);
    await first.close();
    expect([COPY, LATCH].filter((n) => existsSync(join(dir, n)))).toEqual([COPY, LATCH]);
    vi.restoreAllMocks();
    const second = await openLocalDb(dir);
    await second.close();
    expect([COPY, LATCH].filter((n) => existsSync(join(dir, n)))).toEqual([]);
  });
});

describe("nothing outside the data folder is reached", () => {
  it("unlinks a link planted under a copy's name and leaves its target as it was", () => {
    const dir = scratch("ohmail-copies-link-");
    const outside = scratch("ohmail-copies-outside-");
    mkdirSync(join(outside, "pgdata"));
    writeFileSync(join(outside, "pgdata", "PG_VERSION"), "16\n");
    writeFileSync(join(outside, "proven"), "");
    const before = treeOf(outside);
    symlinkSync(outside, join(dir, COPY));
    symlinkSync(outside, join(dir, SET_ASIDE));
    // A real copy whose inside links out.
    mkdirSync(join(dir, REFILL));
    symlinkSync(join(outside, "pgdata"), join(dir, REFILL, "pgdata"));

    // No mark is written through a link, and the ordinary rule looks into none.
    markProven(dir, "copy");
    expect(treeOf(outside)).toEqual(before);

    forgetStoreCopies(dir, "signed_out");
    expect(readdirSync(dir)).toEqual([]);
    expect(treeOf(outside)).toEqual(before);
  });

  it("replaces a link planted at the name where an asked removal is written down, and writes nothing through it", () => {
    const dir = scratch("ohmail-copies-link-latch-");
    const outside = scratch("ohmail-copies-outside-latch-");
    writeFileSync(join(outside, "precious.txt"), "precious\n");
    plant(dir, COPY);
    symlinkSync(join(outside, "precious.txt"), join(dir, LATCH));
    forgetStoreCopies(dir, "signed_out");
    expect(readFileSync(join(outside, "precious.txt"), "utf8"), "a file outside the data folder was written through the link").toBe("precious\n");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("makes no mark through a link planted at the mark's own name, and the folder stays", () => {
    const dir = scratch("ohmail-copies-link-mark-");
    const outside = scratch("ohmail-copies-outside-mark-");
    plant(dir, REFILL);
    symlinkSync(join(outside, "made-through-the-link"), join(dir, REFILL, "proven"));
    markProven(dir, "refill");
    expect(readdirSync(outside), "a file outside the data folder was made through the link").toEqual([]);
    // A link is no mark: the ordinary rule leaves the folder where it is.
    removeProvenCopies(dir);
    expect(existsSync(join(dir, REFILL, "pgdata", "base", "held"))).toBe(true);
  });

  it("an open beside a link under a copy's name follows it nowhere", async () => {
    const dir = await freshDataDir("ohmail-copies-link-open-");
    dirs.push(dir);
    const outside = scratch("ohmail-copies-outside-open-");
    writeFileSync(join(outside, "proven"), "");
    mkdirSync(join(outside, "pgdata"));
    writeFileSync(join(outside, "pgdata", "PG_VERSION"), "16\n");
    const before = treeOf(outside);
    symlinkSync(outside, join(dir, COPY));
    const opened = await openLocalDb(dir);
    await opened.close();
    expect(treeOf(outside)).toEqual(before);
  });
});
