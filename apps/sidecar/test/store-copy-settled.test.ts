import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { OLD_STORE, folderAtOldHead, ring } from "./_old-head-store.js";

/**
 * WHEN THE COPY HAS DONE WHAT IT WAS KEPT FOR. The copy of a 1.0 store stays until the updated
 * store has served every mailbox it holds a login for, in one run: then it is marked, and the next
 * open removes it before the database opens. One mailbox served is not every mailbox; a mailbox
 * with no login here can never be served and does not keep the copy.
 */

const COPY = "store-before-2.0";
const MARK = join(COPY, "proven");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function moved(): Promise<{ dir: string; opened: OpenLocalDb }> {
  const dir = await folderAtOldHead("ohmail-store-settled-");
  dirs.push(dir);
  const opened = await openLocalDb(dir, { transition: { way: "copy", openSealed: ring() } });
  return { dir, opened };
}

/** Open and close once; answers whether the copy still stood when the open first spoke. */
async function copyStoodAtNextOpen(dir: string): Promise<boolean> {
  let stood: boolean | null = null;
  const opened = await openLocalDb(dir, { onPhase: () => { stood ??= existsSync(join(dir, COPY)); } });
  await opened.close();
  return stood ?? false;
}

describe("the copy of a store that was updated", () => {
  it("stays while one of two mailboxes has not been served, and goes at the open after both were", async () => {
    const { dir, opened } = await moved();
    await opened.copySettled!(OLD_STORE.mailboxId);
    await opened.copySettled!(OLD_STORE.mailboxId);
    expect(existsSync(join(dir, MARK)), "marked with a mailbox unserved").toBe(false);
    await opened.close();
    expect(await copyStoodAtNextOpen(dir), "removed with a mailbox unserved").toBe(true);

    // A run is a run: what was served before the restart does not count in this one.
    const second = await openLocalDb(dir);
    await second.copySettled!(OLD_STORE.secondMailboxId);
    expect(existsSync(join(dir, MARK)), "marked on a cycle of an earlier run").toBe(false);
    await second.copySettled!(OLD_STORE.mailboxId);
    expect(existsSync(join(dir, MARK))).toBe(true);
    // Marked, not removed: the store beside it is open.
    expect(existsSync(join(dir, COPY, "copy.json"))).toBe(true);
    await second.close();
    expect(await copyStoodAtNextOpen(dir)).toBe(false);
  }, 240_000);

  it("is not kept by a mailbox that holds no login on this computer", async () => {
    const { dir, opened } = await moved();
    await opened.db.execute(sql`delete from mailbox_credentials where mailbox_id = ${OLD_STORE.secondMailboxId}`);
    await opened.copySettled!(OLD_STORE.mailboxId);
    expect(existsSync(join(dir, MARK))).toBe(true);
    await opened.close();
  }, 240_000);

  it("is asked nothing where no copy stands", async () => {
    const { dir, opened } = await moved();
    await opened.close();
    rmSync(join(dir, COPY), { recursive: true, force: true });
    const again = await openLocalDb(dir);
    await again.copySettled!(OLD_STORE.mailboxId);
    await again.copySettled!(OLD_STORE.secondMailboxId);
    expect(existsSync(join(dir, COPY))).toBe(false);
    await again.close();
  }, 240_000);
});
