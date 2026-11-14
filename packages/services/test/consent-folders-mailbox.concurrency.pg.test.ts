import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, inArray } from "drizzle-orm";
import { accountSettings, accounts, changeLog, mailboxes, mailboxFolders, accountSyncState } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { setFoldersEnabled, setMailboxFoldersEnabled } from "../src/consent-seed.js";
import { foldersEnabled, userFoldersByIds } from "../src/folders.js";
import type { ServiceContext } from "../src/context.js";

/**
 * THE PER-MAILBOX FOLDERS DIAL RACING THE MASTER, ON REAL POSTGRES — mail 0073
 * (FOLDERS-SPEC.md §17).
 *
 * ── WHY `.pg.test.ts` ────────────────────────────────────────────────────────────────────
 *
 * Both writers append folder change rows through `recordChanges`, whose seq allocation takes
 * the account's `account_sync_state` row lock and holds it to COMMIT. PGlite is one
 * connection, so two `await`ed toggles are sequential by construction and a test there cannot
 * see the interleaving. Under real Postgres the two transactions genuinely overlap, and the
 * property that must survive them is the WIRE's, not the log's:
 *
 *   whatever order the master enable and a mailbox opt-out commit in, a drain that
 *   re-materializes every folder row afterwards ends with NO live entity for the switched-off
 *   mailbox — because materialization re-reads the columns at drain time, a stale create can
 *   only ever drain as a tombstone.
 *
 * The log itself is allowed to hold a create for the switched-off mailbox (the master's
 * listUserFolders may have read before the opt-out's column landed); what it is NOT allowed to
 * hold is a seq hole or a duplicate, and the final columns must both be exactly what their
 * writers stored.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ACCOUNT = randomUUID();
const NOW = new Date("2026-08-26T12:00:00.000Z");

const ctx = (): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId: ACCOUNT,
  userId: null,
  now: () => NOW,
  requestId: `folders-mb-${randomUUID()}`,
} as ServiceContext);

describe.skipIf(!PG_UP)("mail 0073 — per-mailbox folders vs the master, on real Postgres", () => {
  let mb1: string;
  let mb2: string;
  let f1: string;
  let f2: string;

  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await runMigrations(PG_TEST_URL);
    await db.insert(accounts).values({ id: ACCOUNT, name: `fm-${ACCOUNT.slice(0, 8)}` });
    const [a] = await db.insert(mailboxes)
      .values({ id: randomUUID(), accountId: ACCOUNT, provider: "imap", address: `one-${ACCOUNT.slice(0, 8)}@x.example` }).returning();
    const [b] = await db.insert(mailboxes)
      .values({ id: randomUUID(), accountId: ACCOUNT, provider: "imap", address: `two-${ACCOUNT.slice(0, 8)}@x.example` }).returning();
    mb1 = a!.id; mb2 = b!.id;
    const [fa] = await db.insert(mailboxFolders)
      .values({ mailboxId: mb1, accountId: ACCOUNT, folder: "Projects/Acme", uidvalidity: 1n, uidnext: 1n, highestmodseq: 1n }).returning();
    const [fb] = await db.insert(mailboxFolders)
      .values({ mailboxId: mb2, accountId: ACCOUNT, folder: "Clients/Anna", uidvalidity: 1n, uidnext: 1n, highestmodseq: 1n }).returning();
    f1 = fa!.id; f2 = fb!.id;
  });

  afterAll(async () => {
    await db.delete(changeLog).where(eq(changeLog.accountId, ACCOUNT));
    await db.delete(accountSyncState).where(eq(accountSyncState.accountId, ACCOUNT));
    await db.delete(mailboxFolders).where(inArray(mailboxFolders.id, [f1, f2]));
    await db.delete(accountSettings).where(eq(accountSettings.accountId, ACCOUNT));
    await db.delete(mailboxes).where(eq(mailboxes.accountId, ACCOUNT));
    await db.delete(accounts).where(eq(accounts.id, ACCOUNT));
    await client.end();
  });

  it("a master enable racing a mailbox opt-out leaves consistent columns, a gap-free log, and a wire with no live entity for the switched-off mailbox", async () => {
    // The race: both writers in flight at once on separate pooled connections.
    await Promise.all([
      setFoldersEnabled(ctx(), true),
      setMailboxFoldersEnabled(ctx(), mb2, false),
    ]);

    // Columns: both writers' stores landed — neither clobbered the other.
    expect(await foldersEnabled(db as never, ACCOUNT)).toBe(true);
    const [mbRow] = await db.select({ at: mailboxes.foldersDisabledAt })
      .from(mailboxes).where(eq(mailboxes.id, mb2));
    expect(mbRow!.at).not.toBeNull();

    // The log: contiguous seqs, no duplicates — the counter lock's whole promise.
    const rows = await db.select().from(changeLog)
      .where(eq(changeLog.accountId, ACCOUNT)).orderBy(changeLog.seq);
    const seqs = rows.map((r) => Number(r.seq));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[seqs.length - 1]! - seqs[0]!).toBe(seqs.length - 1);

    // The wire: re-materializing EVERY folder row now answers an entity for the participating
    // mailbox's folder and NOTHING for the switched-off one's, whatever the log holds — the
    // drain-time re-read is what makes any interleaving safe.
    const map = await userFoldersByIds(db as never, ACCOUNT, [f1, f2]);
    expect(map.has(f1)).toBe(true);
    expect(map.has(f2)).toBe(false);
  });
});
