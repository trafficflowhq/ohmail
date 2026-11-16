import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MAIL_JOURNAL, readJournalOf } from "@trafficflow/db/journal";
import { journalThrough } from "../../../packages/db/src/testing-journal.js";
import { LOCAL_STORE_EXTENSIONS, PGDATA_SUBDIR, openLocalDb } from "../src/db.js";
import { OLD_HEAD, folderAtOldHead, ring } from "./_old-head-store.js";

/**
 * WHAT A WINDOW IS TOLD WHILE A STORE IS UPDATED. Two waits get a word of their own: the copy
 * (`copying_store`, during which a quit is safe: nothing of the store has changed) and the move
 * itself (`updating_store`, one transaction over the whole store). Around them the words are the
 * ones every start says. A store that needs no update hears neither.
 */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function phasesOf(dir: string): Promise<string[]> {
  const said: string[] = [];
  const opened = await openLocalDb(dir, {
    onPhase: (phase) => { if (said.at(-1) !== phase) said.push(phase); },
    transition: { way: "copy", openSealed: ring() },
  });
  await opened.close();
  return said;
}

describe("the words of a start that updates a 1.0 store", () => {
  it("at 1.0.11's head: the copy, the store opened again, the move, then the entries after it", async () => {
    const dir = await folderAtOldHead("ohmail-update-phases-");
    dirs.push(dir);
    expect(await phasesOf(dir)).toEqual(["opening_store", "copying_store", "opening_store", "updating_store", "migrating"]);
    // Updated: the next start says neither word.
    expect(await phasesOf(dir)).toEqual(["opening_store", "migrating"]);
  }, 240_000);

  it("below that head: the 1.0 road is walked between the copy and the move", async () => {
    // A store an earlier 1.0 release left: the journal as it stood one entry before 1.0.11's head.
    const below = readJournalOf(MAIL_JOURNAL).filter((e) => e.when < OLD_HEAD).at(-1)!.when;
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-update-phases-below-"));
    dirs.push(dir);
    const client = new PGlite(join(dir, PGDATA_SUBDIR), { extensions: LOCAL_STORE_EXTENSIONS });
    const cut = journalThrough(MAIL_JOURNAL, below);
    try {
      await migrate(drizzle(client), { migrationsFolder: cut.spec.dir, migrationsSchema: cut.spec.migrationsSchema });
    } finally { cut.dispose(); }
    await client.exec(`insert into accounts (id, name) values ('00000000-0000-4000-8000-000000000001', 'desk')`);
    await client.close();
    const kept = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-update-phases-kept-"));
    dirs.push(kept);
    cpSync(join(dir, PGDATA_SUBDIR), join(kept, PGDATA_SUBDIR), { recursive: true });

    expect(await phasesOf(dir)).toEqual(["opening_store", "copying_store", "opening_store", "migrating", "updating_store", "migrating"]);
    // The copy is the store as that release left it, below 1.0.11's head: taken before the road was walked.
    const copy = new PGlite(join(dir, "store-before-2.0", PGDATA_SUBDIR), { extensions: LOCAL_STORE_EXTENSIONS });
    const head = Number((await copy.query<{ head: string }>(`select max(created_at)::text as head from "drizzle_mail"."__drizzle_migrations"`)).rows[0]!.head);
    await copy.close();
    expect(head).toBe(below);
  }, 480_000);
});
