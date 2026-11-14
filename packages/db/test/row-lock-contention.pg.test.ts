import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { brandDialect, dialect } from "../src/dialect/index.js";
import { accounts, folderState, mailboxes, messages } from "../src/schema-mail.js";

/**
 * THE ROW LOCK, ON TWO CONNECTIONS — the only place in this repository where `d.forUpdate` can
 * be watched do anything at all.
 *
 * Measured, in this order, and each measurement is the reason for the next:
 *
 *   · making the SERVER's `forUpdate` the identity left the in-process race test green. The
 *     in-process Postgres is one connection and orders transactions itself.
 *   · the device store's harness is a synchronous driver, so removing ITS serialization changed
 *     nothing either.
 *
 * So neither arm of the matrix can tell a correct `d.forUpdate` port from a broken one, and every
 * locking site the port touches was landing on a compile and a green suite. This file is the
 * missing half: two SEPARATE connections, two real transactions, and a read-modify-write that
 * loses an update unless the first transaction's lock makes the second wait.
 *
 * It is `*.pg.test.ts` and stays Postgres-only, deliberately. On the store a device carries there
 * is no second connection to have — a second one does not contend, it fails — which is exactly
 * why the member is the identity there and exactly why that arm cannot host this case.
 *
 * ── WHAT MAKES IT A CONTROL RATHER THAN A DEMONSTRATION ───────────────────────────────────
 *
 * The first case takes the lock and the second does not, and they differ in ONE call. Without the
 * pair, a green here would be equally consistent with the two writers simply never overlapping —
 * which is what the in-process tests turned out to be measuring. The unlocked case failing is the
 * evidence that the locked one is doing something.
 */
const URL = PG_TEST_URL;
const client = postgres(URL, { max: 4 });
// BRANDED, like every production factory: an unbranded handle refuses at the first statement the
// seam composes, and every statement below is one.
const db = brandDialect(drizzle(client), "pg");

const ACCOUNT = randomUUID();
const MAILBOX = randomUUID();
const MESSAGE = randomUUID();
const STATE = randomUUID();

/**
 * RESOLVED BEFORE `describe` RUNS, and the first version was not.
 *
 * `it.runIf(up)` is evaluated at COLLECTION time. With `up` assigned inside `beforeAll` it is
 * still `false` when the runner decides, so both cases SKIPPED and the file reported a pass
 * having opened no connection at all — a guard that cannot fire, in the file whose whole job is
 * being the one guard that can. Top-level await, so the answer exists before anything reads it.
 */
const up = await realPgAvailable(URL);

describe.skipIf(!up)("a row lock across two connections", () => {
  beforeAll(async () => {
    await runMigrations(URL);
    await db.insert(accounts).values({ id: ACCOUNT, name: `lock-${ACCOUNT.slice(0, 8)}` });
    await db.insert(mailboxes).values({
      id: MAILBOX, accountId: ACCOUNT, provider: "imap", address: `lock-${ACCOUNT.slice(0, 8)}@example.test`,
    });
    await db.insert(messages).values({
      id: MESSAGE, accountId: ACCOUNT, mailboxId: MAILBOX,
      bodyHash: "h", dedupKey: `lock-${ACCOUNT}`, subject: "lock", fromAddress: "s@example.test",
    });
    await db.insert(folderState).values({
      id: STATE, messageId: MESSAGE, accountId: ACCOUNT,
      desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us", attempts: 0,
    });
  }, 120_000);

  afterAll(async () => {
    {
      await db.delete(folderState).where(eq(folderState.id, STATE));
      await db.delete(messages).where(eq(messages.id, MESSAGE));
      await db.delete(mailboxes).where(eq(mailboxes.id, MAILBOX));
      await db.delete(accounts).where(eq(accounts.id, ACCOUNT));
    }
    await client.end({ timeout: 5 });
  });

  /** Reset the counter between the two cases so each starts from a known number. */
  const reset = async (): Promise<void> => {
    await db.update(folderState).set({ attempts: 0 }).where(eq(folderState.id, STATE));
  };

  const attempts = async (): Promise<number> => {
    const [row] = await db.select({ attempts: folderState.attempts })
      .from(folderState).where(eq(folderState.id, STATE));
    return Number(row?.attempts ?? -1);
  };

  /**
   * One writer: read the counter, YIELD long enough for the other to have read it too, write
   * what it read plus one. `lock` decides whether the read takes the row.
   */
  const bump = async (lock: boolean): Promise<void> => {
    const d = dialect(db);
    await db.transaction(async (tx) => {
      const page = tx.select({ attempts: folderState.attempts })
        .from(folderState).where(eq(folderState.id, STATE));
      const [row] = lock ? await d.forUpdate(page, { of: folderState }) : await page;
      await new Promise((r) => setTimeout(r, 250));
      await tx.update(folderState).set({ attempts: Number(row?.attempts ?? 0) + 1 })
        .where(eq(folderState.id, STATE));
    });
  };

  it("WITHOUT the lock two overlapping writers lose an update — the race is real", async () => {
    await reset();
    await Promise.all([bump(false), bump(false)]);
    expect(await attempts(),
      "two unlocked read-modify-writes on separate connections did not collide, so the case " +
      "below proves nothing about the lock").toBe(1);
  }, 60_000);

  it("WITH the lock the second writer waits and nothing is lost", async () => {
    await reset();
    await Promise.all([bump(true), bump(true)]);
    expect(await attempts(),
      "a writer's committed increment was lost with `d.forUpdate` in place — the lock is not " +
      "reaching the statement").toBe(2);
  }, 60_000);
});
