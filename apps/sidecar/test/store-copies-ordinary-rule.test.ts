import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openLocalDb } from "../src/db.js";
import { markProven } from "../src/store-copies.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * WHEN A COPY OF THE STORE LEAVES ON ITS OWN. A copy kept from before the update goes at the first
 * open after it was marked as done with, before the database opens, and by nothing else: not by a
 * missing mark, not by a mark that does not read as one, and never by a clock.
 */

const COPY = "store-before-2.0";
const REFILL = "set-aside-refill-20260101T000000Z";
const OLD_KIND = "set-aside-20250101T000000Z";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const dir = await freshDataDir("ohmail-copies-rule-");
  dirs.push(dir);
  return dir;
}

/** A copy by name, holding one file a test can look for. */
function plant(dir: string, name: string): void {
  mkdirSync(join(dir, name, "pgdata"), { recursive: true });
  writeFileSync(join(dir, name, "pgdata", "held"), "a store's bytes");
}

/** Open and close once; answers which of `names` still stood when the open first spoke, before the database opened. */
async function openOnce(dir: string, names: readonly string[]): Promise<string[]> {
  let stoodAtFirstWord: string[] | null = null;
  const opened = await openLocalDb(dir, {
    onPhase: () => { stoodAtFirstWord ??= names.filter((n) => existsSync(join(dir, n))); },
  });
  await opened.close();
  return stoodAtFirstWord ?? ["THE OPEN SAID NO PHASE"];
}

describe("a copy of the store that carries its mark", () => {
  it("is gone at the next open, before the database opens; one without the mark stays", async () => {
    const dir = await folder();
    plant(dir, COPY);
    plant(dir, REFILL);
    plant(dir, OLD_KIND);
    expect(await openOnce(dir, [COPY, REFILL, OLD_KIND]), "an unmarked copy left at an open").toEqual([COPY, REFILL, OLD_KIND]);

    markProven(dir, "refill");
    expect(await openOnce(dir, [COPY, REFILL, OLD_KIND])).toEqual([COPY, OLD_KIND]);

    markProven(dir, "copy");
    expect(await openOnce(dir, [COPY, REFILL, OLD_KIND])).toEqual([OLD_KIND]);
    expect(existsSync(join(dir, `${COPY}.removing`)), "half a removal was left").toBe(false);
  });

  it("stays when its mark does not read as one", async () => {
    const dir = await folder();
    plant(dir, COPY);
    plant(dir, REFILL);
    // Not the empty file the engine writes: words under the mark's name, and a folder under it.
    writeFileSync(join(dir, COPY, "proven"), "prove");
    mkdirSync(join(dir, REFILL, "proven"));
    expect(await openOnce(dir, [COPY, REFILL])).toEqual([COPY, REFILL]);
    expect(existsSync(join(dir, COPY, "pgdata", "held"))).toBe(true);
  });

  it("is not removed by a clock: a year later an unmarked copy stands", async () => {
    const dir = await folder();
    plant(dir, COPY);
    plant(dir, REFILL);
    const longAgo = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000);
    for (const name of [COPY, REFILL]) utimesSync(join(dir, name), longAgo, longAgo);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 365 * 24 * 3600 * 1000 });
    expect(await openOnce(dir, [COPY, REFILL])).toEqual([COPY, REFILL]);
  });
});

describe("what a kill left of a copy being made or removed", () => {
  it("is removed at the next open and is never taken for a copy", async () => {
    const dir = await folder();
    plant(dir, `${COPY}.partial`);
    plant(dir, `${COPY}.removing`);
    plant(dir, `${REFILL}.removing`);
    const names = [`${COPY}.partial`, `${COPY}.removing`, `${REFILL}.removing`];
    expect(await openOnce(dir, names)).toEqual([]);
    // A half copy was never marked: marking finds no copy to mark.
    plant(dir, `${COPY}.partial`);
    markProven(dir, "copy");
    expect(existsSync(join(dir, `${COPY}.partial`, "proven"))).toBe(false);
  });
});
