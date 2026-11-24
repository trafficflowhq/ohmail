import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransitionRefused } from "@trafficflow/db/journal";
import { LocalStoreOpenError, PGDATA_SUBDIR, StoreUpdateRefusedError, openLocalDb } from "../src/db.js";
import { STORE_NOT_UPDATED_MESSAGE, runOrganizeHere } from "../src/organize-here.js";
import { OLD_HEAD, OLD_STORE, folderAtOldHead, readAsOneOh, ring } from "./_old-head-store.js";

/**
 * NO WAY NAMED, NO CROSSING. A store 1.0 made is moved to 2.0 only by a caller that names how: a
 * caller that names nothing is refused before anything changes, whatever else it hands the open.
 * Nothing converts a store in place on a caller's silence, and no copy is made for one either.
 */

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const entriesOf = (dir: string): string[] => readdirSync(dir).filter((n) => !n.startsWith("sidecar.")).sort();

describe("a 1.0 store opened by a caller that names no way", () => {
  it("is refused with the store as it was and no copy made, with or without a key ring", async () => {
    const dir = await folderAtOldHead("ohmail-store-no-way-");
    dirs.push(dir);
    for (const opts of [{}, { transition: { openSealed: ring() } }]) {
      const refused: unknown = await openLocalDb(dir, opts).then(
        async (opened) => { await opened.close(); return "OPENED"; }, (err: unknown) => err);
      expect(refused).toBeInstanceOf(StoreUpdateRefusedError);
      expect(refused).not.toBeInstanceOf(LocalStoreOpenError);
      expect(refused).toMatchObject({ code: "transition_refused" });
      expect((refused as Error).cause).toBeInstanceOf(TransitionRefused);
      expect((refused as Error).message).not.toContain(dir);
      expect(entriesOf(dir)).toEqual([PGDATA_SUBDIR]);
    }
    expect(await readAsOneOh(join(dir, PGDATA_SUBDIR))).toMatchObject({ head: OLD_HEAD, subject: OLD_STORE.subject, password: OLD_STORE.password });
  }, 240_000);

  it("the command-line door says so and changes nothing", async () => {
    const dir = await folderAtOldHead("ohmail-store-no-way-cli-");
    dirs.push(dir);
    const said: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { said.push(String(chunk)); return true; }) as never);
    const code = await runOrganizeHere({ OHMAIL_DATA_DIR: dir, OHMAIL_MAILBOX_ADDRESS: OLD_STORE.address });
    vi.restoreAllMocks();
    expect(code).toBe(3);
    expect(said.join("")).toContain(STORE_NOT_UPDATED_MESSAGE);
    expect(said.join("")).not.toContain(dir);
    expect(entriesOf(dir)).toEqual([PGDATA_SUBDIR]);
    expect((await readAsOneOh(join(dir, PGDATA_SUBDIR))).head).toBe(OLD_HEAD);
  }, 240_000);
});
