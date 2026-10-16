import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { realPgAvailable } from "@trafficflow/db/testing";
import { checkoutKey, claimRunSlot, dropIsolatedDb, openAdmin, prepareIsolatedDb } from "./_isolateddb.js";
import { checkoutRoot, isolatedDbName } from "./_isolateddb-name.js";
import { DB_URL, refuseDriftedSharedDb } from "./_workerdb.js";

/*
 * THE TWO PROMISES THE KEYED DOOR'S EXEMPTION RESTS ON, read on a real server. A second run of this
 * checkout never gets the name a live run holds, and the door's DROP runs with no statement timeout
 * even on a session that starts with one. `scripts/box-files.mjs` takes the door's DDL off the
 * cluster class on both, so both are measured here rather than argued.
 */
const UP = await realPgAvailable();
const HELD = "trafficflow_worker_runslot";
const DROPPED = "trafficflow_worker_runslot_drop";
const opened: ReturnType<typeof postgres>[] = [];

/** Claim `logical` from a SECOND process of this checkout, print the name it got, and exit. */
function claimFromAnotherRun(logical: string): string {
  const door = pathToFileURL(join(import.meta.dirname, "_isolateddb.ts")).href;
  const script = `import(${JSON.stringify(door)}).then(async (m) => {` +
    `console.log(await m.claimRunSlot(${JSON.stringify(logical)}, m.checkoutKey())); process.exit(0);` +
    `}).catch((e) => { console.error(String(e)); process.exit(3); })`;
  const r = spawnSync(join(checkoutRoot(), "node_modules/.bin/tsx"), ["--conditions=ohmail-source", "-e", script],
    { cwd: checkoutRoot(), encoding: "utf8", timeout: 60_000 });
  expect(r.status, String(r.stderr).slice(-400)).toBe(0);
  return r.stdout.trim().split("\n").pop()!;
}

afterAll(async () => { await Promise.all(opened.map((c) => c.end({ timeout: 5 }))); });

describe.skipIf(!UP)("the keyed door, on a real server", () => {
  it("gives a second run of this checkout its own name while this run holds the plain one", async () => {
    const key = checkoutKey();
    const mine = await claimRunSlot(HELD, key);
    expect(mine).toBe(isolatedDbName(HELD, key));
    expect(await claimRunSlot(HELD, key), "this run asking again keeps its own slot").toBe(mine);
    const other = claimFromAnotherRun(HELD);
    expect(other, "the second run took the name this run holds").toBe(isolatedDbName(`${HELD}_run1`, key));
    expect(claimFromAnotherRun(HELD), "a run that ended gave its slot back").toBe(other);
  }, 120_000);

  it("drops with no statement timeout, even on a session that starts with one", async () => {
    const startsWithOne = { connection: { statement_timeout: 5 } };
    await refuseDriftedSharedDb();
    // The control: the startup setting does reach a session nobody cleared.
    const raw = postgres(DB_URL, { max: 1, ...startsWithOne });
    opened.push(raw);
    expect((await raw`show statement_timeout`)[0]).toEqual({ statement_timeout: "5ms" });

    const admin = await openAdmin(startsWithOne);
    opened.push(admin);
    expect((await admin`show statement_timeout`)[0]).toEqual({ statement_timeout: "0" });
    expect((await admin`show lock_timeout`)[0]).toEqual({ lock_timeout: "0" });

    await prepareIsolatedDb(DROPPED);
    expect(await dropIsolatedDb(DROPPED, startsWithOne)).toBe("absent");
  }, 180_000);
});
