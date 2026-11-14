import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MAIL_JOURNAL, OLD_HEADS, TransitionFailed, readJournalOf, type Decrypts } from "@trafficflow/db/journal";
import { journalThrough } from "../../../packages/db/src/testing-journal.js";
import { LOCAL_STORE_EXTENSIONS, PGDATA_SUBDIR, openLocalDb } from "../src/db.js";

/**
 * A DATA FOLDER A 1.0 DESKTOP LEFT, OPENED BY THIS ENGINE. Its store stands at 1.0.11's head, and
 * the six entries of the 2.0 window take columns that engine read: they are applied in one
 * transaction at this open, or the store stays what it was. Built here the way 1.0.11 built it:
 * the mail journal as it stood at the old head, by drizzle's own migrator, in the engine's
 * database with the engine's extensions.
 */
/** The install's key ring, as the engine hands it: here every envelope opens. */
const OPENS: Decrypts = { decrypt: async () => "the secret" };
const HEAD_2_0 = readJournalOf(MAIL_JOURNAL).filter((e) => e.tag.startsWith("0205_"))[0]!.when;
let template: string;
const folders: string[] = [];

/** A copy of the 1.0.11 data folder, so each case opens its own. */
function folderAtOldHead(): string {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-old-head-"));
  folders.push(dir);
  cpSync(join(template, PGDATA_SUBDIR), join(dir, PGDATA_SUBDIR), { recursive: true });
  return dir;
}

async function open(dir: string, transition?: { openSealed?: Decrypts; before?: () => Promise<void> }) {
  const lines: { event: string; detail: Record<string, unknown> }[] = [];
  // The floor at zero, so every entry applied says so: which entries ran is what these cases read.
  const opened = await openLocalDb(dir, {
    log: (event, detail) => lines.push({ event, detail }), slowMigrationFloorMs: 0, ...(transition ? { transition } : {}),
  });
  try {
    const one = async <T>(query: ReturnType<typeof sql>): Promise<T> => ((await opened.db.execute(query)) as unknown as { rows: T[] }).rows[0]!;
    const head = Number((await one<{ head: string }>(sql`select max(created_at)::text as head from "drizzle_mail"."__drizzle_migrations"`)).head);
    const passProgress = (await one<{ t: string | null }>(sql`select to_regclass('public.pass_progress')::text as t`)).t !== null;
    const credentials = Number((await one<{ n: number }>(sql`select count(*)::int as n from mailbox_credentials`)).n);
    return { head, lines, passProgress, credentials, applied: opened.migrations?.applied ?? 0 };
  } finally {
    await opened.close();
  }
}

beforeAll(async () => {
  template = mkdtempSync(join(tmpdir(), "ohmail-old-head-template-"));
  folders.push(template);
  const client = new PGlite(join(template, PGDATA_SUBDIR), { extensions: LOCAL_STORE_EXTENSIONS });
  const cut = journalThrough(MAIL_JOURNAL, OLD_HEADS.mail.when);
  try {
    await migrate(drizzle(client), { migrationsFolder: cut.spec.dir, migrationsSchema: cut.spec.migrationsSchema });
  } finally { cut.dispose(); }
  // One mailbox with a sealed credential and a pass mark, in 1.0's columns.
  await client.exec(`
    insert into accounts (id, name) values ('00000000-0000-4000-8000-000000000001', 'desk');
    insert into mailboxes (id, account_id, provider, address, kickstart_at)
      values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'imap', 'desk@planted.test', now());
    insert into mailbox_credentials (mailbox_id, transport, secret_enc, key_version)
      values ('00000000-0000-4000-8000-000000000002', 'imap', 'sealed-by-the-install', 1);`);
  await client.close();
}, 240_000);

afterAll(() => { for (const dir of folders) rmSync(dir, { recursive: true, force: true }); });

describe("a desktop's 1.0.11 data folder, opened by this engine", () => {
  it("is moved to 2.0 at the open, once: the next open applies nothing", async () => {
    const dir = folderAtOldHead();
    const first = await open(dir, { openSealed: OPENS });
    expect(first.head).toBe(HEAD_2_0);
    expect(first.passProgress).toBe(true);
    expect(first.credentials).toBe(1);
    // Each of the six entries is said once, and the open counts them as applied.
    const told = first.lines.filter((l) => l.event === "migration_applied").map((l) => String(l.detail.migration));
    expect(told.map((t) => t.slice(0, 4))).toEqual(["0200", "0201", "0202", "0203", "0204", "0205"]);
    expect(first.applied).toBe(6);
    const second = await open(dir, { openSealed: OPENS });
    expect(second.head).toBe(HEAD_2_0);
    expect(second.applied).toBe(0);
    expect(second.lines.filter((l) => l.event === "migration_applied")).toEqual([]);
  }, 240_000);

  it("an open that cannot open the store's sealed values fails and leaves it at 1.0.11's head; the next open, with the ring, moves it", async () => {
    const dir = folderAtOldHead();
    // No opener handed: the default opens nothing, and this store holds a sealed credential.
    const failed = await open(dir).catch((e: unknown) => e);
    // The engine's own class for a store that would not open, carrying the transition's code and cause.
    expect(failed).toMatchObject({ name: "LocalStoreOpenError", code: "transition_failed" });
    expect((failed as { cause?: unknown }).cause).toBeInstanceOf(TransitionFailed);
    expect(((failed as { cause: TransitionFailed }).cause).at.stage).toBe("sealed");
    const client = new PGlite(join(dir, PGDATA_SUBDIR), { extensions: LOCAL_STORE_EXTENSIONS });
    const head = Number((await client.query<{ head: string }>(`select max(created_at)::text as head from "drizzle_mail"."__drizzle_migrations"`)).rows[0]!.head);
    const marks = (await client.query<{ n: number }>(`select count(*)::int as n from mailboxes where kickstart_at is not null`)).rows[0]!.n;
    await client.close();
    expect([head, marks]).toEqual([OLD_HEADS.mail.when, 1]);
    expect((await open(dir, { openSealed: OPENS })).head).toBe(HEAD_2_0);
  }, 240_000);

  it("is asked nothing more than `before` before anything changes, and a refusal there leaves the store as it was", async () => {
    const dir = folderAtOldHead();
    let asked = 0;
    await expect(open(dir, { openSealed: OPENS, before: async () => { asked += 1; throw new Error("no copy could be made"); } }))
      .rejects.toThrow("no copy could be made");
    expect(asked).toBe(1);
    const moved = await open(dir, { openSealed: OPENS, before: async () => { asked += 1; } });
    expect([asked, moved.head]).toEqual([2, HEAD_2_0]);
    // A store already moved is not asked again.
    await open(dir, { openSealed: OPENS, before: async () => { asked += 1; } });
    expect(asked).toBe(2);
  }, 240_000);
});
