import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { folderState, mailboxes, messages } from "@trafficflow/db";
import { makeTestDb } from "../src/testing.js";
import { dialect } from "../src/dialect/index.js";

/**
 * WHAT ORDERS TWO WRITERS ON EACH STORE — asked of the store, and the answer is not the lock.
 *
 * `d.forUpdate` is the identity on the device arm, and the seam says why: the engine store is
 * reached through ONE serialized connection, so there is no second writer for a row lock to
 * exclude. That sentence is the most dangerous one in this port, and this file was written to
 * check it. What it found is that the sentence is right and the REASON is not the one either
 * store's harness can demonstrate.
 *
 * ── FOUR MEASUREMENTS, IN THE ORDER THEY WERE TAKEN ───────────────────────────────────────
 *
 * 1. Two transactions started in the same tick, each a read-modify-write. On the SERVER harness
 *    (PGlite) both commit and the row reads 2. On the DEVICE harness one commits and the other is
 *    REFUSED — `cannot start a transaction within a transaction` — and the row reads 1.
 *
 * 2. The device store does not ORDER the second transaction, it refuses it. That is not what the
 *    seam's comment leads a reader to expect: the comment is about a second CONNECTION
 *    (`database is locked`), and this is ONE connection with two overlapping transactions.
 *    `drizzle-orm/sqlite-proxy` issues `BEGIN`, the statements and `COMMIT` as separate calls, so
 *    a queue that serializes each STATEMENT does not make a TRANSACTION atomic — another
 *    transaction's `BEGIN` lands between them. Loud and nothing written, which is the safe
 *    direction; still a failure the engine must not provoke, and no unit test of a pass can see
 *    it because a pass run alone never overlaps itself.
 *
 * 3. REMOVING THE HARNESS'S SERIALIZATION CHANGES NOTHING, and the reason is the driver.
 *    `node:sqlite`'s `DatabaseSync` is fully synchronous, so a queued job runs to completion
 *    before any other JavaScript. Measured directly: two jobs dispatched in one tick with NO
 *    queue run `A:start A:end B:start B:end` and the counter reaches 2. The same two jobs with a
 *    single `await` inside — the shape an ASYNC driver produces, which is what the phone's
 *    platform half has — run `A:start B:start A:end B:end` and the counter reaches 1. So the
 *    queue in the test factory is inert HERE and load-bearing THERE, and this harness cannot
 *    show the difference.
 *
 * 4. REMOVING THE SERVER'S ROW LOCK ALSO CHANGES NOTHING HERE. PGlite is one connection and
 *    serializes transactions itself, so `FOR UPDATE` is as unexercised on the server harness as
 *    it is on the device one.
 *
 * ── WHAT THIS FILE THEREFORE PROVES, AND WHAT IT DOES NOT ─────────────────────────────────
 *
 * It proves: the race shape is reachable on both stores (the first case, and without it the rest
 * would be vacuous); no writer that reported success has its work silently dropped; the device
 * store's refusal is by name rather than a wrong answer; and two writers that do not overlap both
 * land, which is the half a refusal-only file would never notice was missing.
 *
 * It does NOT prove that `FOR UPDATE` works, on either store, and no in-process harness can:
 * both drivers serialize transactions by construction. The row lock's own exercise is a
 * `*.pg.test.ts` against real Postgres on two connections, which is a different run on a shared
 * box and is owed separately. Saying that here is the point — a green in this file read as
 * "the locking port is finished" is exactly the misreading the port has to survive.
 */

/**
 * Identifiers are UUIDs because the SERVER twin's columns are `uuid` and refuse anything else —
 * the device twin stores the same values as text. Fixed rather than random so a failure names the
 * same row twice.
 */
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const MAILBOX = "22222222-2222-4222-8222-222222222222";
const MESSAGE = "33333333-3333-4333-8333-333333333333";
const STATE = "44444444-4444-4444-8444-444444444444";

/** The ruled table: `folder_state` is where a lost update means mail moves to the wrong folder. */
async function seedOneRow(db: Awaited<ReturnType<typeof makeTestDb>>): Promise<string> {
  await db.insert(mailboxes).values({
    id: MAILBOX, accountId: ACCOUNT, provider: "imap", address: "race@example.test",
  });
  await db.insert(messages).values({
    id: MESSAGE, accountId: ACCOUNT, mailboxId: MAILBOX,
    bodyHash: "h", dedupKey: "d", subject: "race", fromAddress: "s@example.test",
  });
  await db.insert(folderState).values({
    id: STATE, messageId: MESSAGE, accountId: ACCOUNT,
    desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us", attempts: 0,
  });
  return STATE;
}

const attemptsOf = async (db: Awaited<ReturnType<typeof makeTestDb>>, id: string): Promise<number> => {
  const [row] = await db.select({ attempts: folderState.attempts })
    .from(folderState).where(eq(folderState.id, id));
  return Number(row?.attempts ?? -1);
};

describe("two writers over one folder_state row", () => {
  /**
   * THE POSITIVE CONTROL, and without it everything below is vacuous.
   *
   * A guard that only ever asserts "nothing was lost" has no evidence the fixture can lose
   * anything. This one reads, yields to the event loop, and writes what it read plus one — the
   * shape every `FOR UPDATE` in the ported files exists to make safe — with no transaction and no
   * lock. Both stores lose an update, and they must, or the cases after this are testing a race
   * that cannot happen.
   */
  it("loses an update when nothing orders them — on EITHER store", async () => {
    const db = await makeTestDb();
    const id = await seedOneRow(db);

    const bump = async (): Promise<void> => {
      const n = await attemptsOf(db, id);
      await new Promise((r) => setTimeout(r, 5));
      await db.update(folderState).set({ attempts: n + 1 }).where(eq(folderState.id, id));
    };
    await Promise.all([bump(), bump()]);

    expect(await attemptsOf(db, id),
      "two unordered read-modify-writes should collide; if this is 2 the fixture cannot produce " +
      "the race the cases below claim to prevent").toBe(1);
  });

  /**
   * THE INVARIANT, in one form that is true on both stores — and it is NOT a lock test.
   *
   * Not "the counter is 2": that is the server's answer, and asserting it on the device would
   * make this file a Postgres test with a second name. The property both stores must have is that
   * the row agrees with the writers that SUCCEEDED — a writer either commits and is counted, or
   * fails loudly and is not. A store that silently dropped a committed writer's work fails here
   * whichever store it is.
   *
   * On the server both writers commit and the row reads 2. On the device one commits, one is
   * refused by name, and the row reads 1. Both satisfy the invariant; only a silent loss does not.
   *
   * Measurement 4 in the header applies to this case in particular: making the server's
   * `forUpdate` the identity leaves it GREEN, because PGlite serializes transactions on its one
   * connection. That is why the header says what this file does not prove, and why the row lock
   * still owes a two-connection case against real Postgres.
   */
  it("never loses the work of a writer that reported success", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    const id = await seedOneRow(db);

    const bump = async (): Promise<string> => {
      try {
        await db.transaction(async (tx) => {
          const page = tx.select({ attempts: folderState.attempts })
            .from(folderState).where(eq(folderState.id, id));
          // The seam's row lock: the server takes it, the device answers the identity. Which of
          // those happened is not what this case asserts — see the header.
          const [row] = await d.forUpdate(page, { of: folderState });
          const n = Number(row?.attempts ?? 0);
          await new Promise((r) => setTimeout(r, 5));
          await tx.update(folderState).set({ attempts: n + 1 }).where(eq(folderState.id, id));
        });
        return "ok";
      } catch (e) {
        return (e as Error).message;
      }
    };

    const results = await Promise.all([bump(), bump()]);
    const committed = results.filter((r) => r === "ok").length;

    expect(committed, "both writers failed; nothing was exercised").toBeGreaterThanOrEqual(1);
    expect(await attemptsOf(db, id),
      `the row and the writers disagree: ${committed} reported success and the row says ` +
      `${await attemptsOf(db, id)}. A writer's committed work was lost without anybody being told.`,
    ).toBe(committed);

    // A writer that did NOT succeed must have been refused for a reason the store named, not have
    // returned quietly having written nothing. This is what makes the count above trustworthy.
    for (const r of results) {
      if (r === "ok") continue;
      expect(r, "a writer failed for a reason neither store is supposed to produce")
        .toMatch(/cannot start a transaction within a transaction|could not serialize|deadlock/i);
    }
  });

  /**
   * AND THE ORDINARY CASE IS ADMITTED — the half a refusal-only file would never notice was gone.
   *
   * Two writers that do NOT overlap must both land, on both stores. If the device store's answer
   * to overlap were being achieved by refusing writers generally, this is where that shows.
   */
  it("lands both writers when they do not overlap, on either store", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    const id = await seedOneRow(db);

    const bump = async (): Promise<void> => {
      await db.transaction(async (tx) => {
        const page = tx.select({ attempts: folderState.attempts })
          .from(folderState).where(eq(folderState.id, id));
        const [row] = await d.forUpdate(page, { of: folderState });
        await tx.update(folderState).set({ attempts: Number(row?.attempts ?? 0) + 1 })
          .where(eq(folderState.id, id));
      });
    };
    await bump();
    await bump();

    expect(await attemptsOf(db, id), "a sequential pair of writers lost one of its own").toBe(2);
  });
});
