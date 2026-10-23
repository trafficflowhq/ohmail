import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { accounts, auditLog, folderState, mailboxes, messageInstances, messages } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { applyReconcileAction } from "@trafficflow/core/mail";
import type { AdapterPort, NativeLocator } from "@trafficflow/core";
import { prepareIsolatedDb, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { brandDialect } from "@trafficflow/db/dialect";

/**
 * THE MOVE'S COMPLETION MAY NOT WRITE BACK THE DESIRE IT READ
 * PROVED ACROSS TWO SESSIONS.
 *
 * `applyReconcileAction` is the write path behind the Screener's verdict, an approval and the
 * rules re-route. Its success arm used to write `desired = observed = action.to` after
 * `adapter.move` returned, so a decision another door committed DURING the round trip was
 * reverted — no error, no log line, the mail where the older decision said.
 *
 * The competing write is issued from a SECOND CONNECTION from inside `adapter.move`, which is the
 * only window that reaches the arm, and it must be a second connection: the claim is that one
 * UPDATE's `CASE` sees another session's COMMITTED row under READ COMMITTED, which a
 * single-connection PGlite cannot represent at all.
 *
 * A PRIVATE database (`prepareIsolatedDb`), so the shared accumulator's journal watermark and its
 * thousands of mailbox rows are not in play.
 */
const SOURCE = "ohmail/News";
const OLD = "INBOX";
const NEWER = "ohmail/Screener";
const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });

describe("applyReconcileAction — a desire committed during the move survives (real Postgres)", () => {
  let url: string;
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let otherSql: ReturnType<typeof postgres>;
  let otherDb: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    url = await prepareIsolatedDb("trafficflow_reconciler_cas");
    sql = postgres(url, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
    otherSql = postgres(url, { max: 2, onnotice: () => {} });
    otherDb = brandDialect(drizzle(otherSql, { schema }), "pg");
  }, ISOLATED_DB_RESET_BUDGET_MS);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await otherSql?.end({ timeout: 5 });
  });

  async function seed() {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    await db.insert(accounts).values({ id: accountId, name: `pcas-${tag}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `pcas-${tag}@example.test`, status: "connected",
    }).returning();
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id,
      dedupKey: `mid:<pcas-${tag}@example.test>`, messageIdHeader: `pcas-${tag}@example.test`,
      fromAddress: "someone@example.test", subject: "s", bodyHash: `pcas-${tag}`,
      nativeLocator: LOC(SOURCE, "1:10"),
    }).returning();
    await db.insert(messageInstances).values({
      accountId, messageId: m!.id, mailboxId: mb!.id, folder: SOURCE, uid: 10,
      uidvalidity: 1n, isPrimary: true,
    });
    // The intent the door committed before the move — every production caller writes one.
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: OLD, observedFolder: SOURCE,
      lastSetBy: "us", reconcileStatus: "pending", conflict: false, attempts: 0,
    });
    return { accountId, messageId: m!.id, repo: makeDrizzleRepo(db as never) };
  }

  /** An adapter whose `move` lands, and optionally lets another session commit while it is away. */
  const adapterThatMoves = (duringFlight?: () => Promise<void>): AdapterPort => ({
    async move(_locator: NativeLocator, to: string): Promise<NativeLocator> {
      await duringFlight?.();
      return LOC(to, "1:99");
    },
  } as unknown as AdapterPort);

  const stateOf = async (messageId: string) => {
    const [row] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    return row!;
  };
  const actionsOf = async (accountId: string) =>
    (await db.select().from(auditLog).where(eq(auditLog.accountId, accountId))).map((r) => r.action);

  it("the newer desire STANDS, the landed folder is recorded, and the refusal is on the log", async () => {
    const { accountId, messageId, repo } = await seed();
    const out = await applyReconcileAction(
      {
        repo,
        adapter: adapterThatMoves(async () => {
          await otherDb.update(folderState)
            .set({ desiredFolder: NEWER, reconcileStatus: "pending", updatedAt: new Date() })
            .where(eq(folderState.messageId, messageId));
          // The newer intent's own schedule, written as a deferral writes it (no desired folder), so
          // mail 0163's fresh-intent trigger keeps it.
          await otherDb.update(folderState).set({ attempts: 3 }).where(eq(folderState.messageId, messageId));
        }),
        accountId, mailboxId: "",
      },
      { messageId, locator: LOC(SOURCE, "1:10"), state: { desiredFolder: OLD, observedFolder: SOURCE, lastSetBy: "us" } },
      { type: "move", to: OLD },
    );

    const row = await stateOf(messageId);
    expect(row.desiredFolder).toBe(NEWER);       // before the fix this read INBOX
    expect(row.observedFolder).toBe(OLD);        // the physical fact is still recorded
    expect(row.reconcileStatus).toBe("pending"); // …and the row self-heals toward the newer desire
    expect(row.attempts).toBe(3);               // the newer intent's own schedule is untouched
    expect(row.lastSetBy).toBe("us");           // unchanged by the declined completion
    expect(out.state.desiredFolder).toBe(NEWER); // the caller is told what stands
    const [msg] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect((msg!.nativeLocator as NativeLocator).folder).toBe(OLD);
    expect(await actionsOf(accountId)).toEqual(["move", "move_superseded"]);
  }, 60_000);

  it("POSITIVE CONTROL — with nothing interleaved the pair converges and no supersede is logged", async () => {
    const { accountId, messageId, repo } = await seed();
    const out = await applyReconcileAction(
      { repo, adapter: adapterThatMoves(), accountId, mailboxId: "" },
      { messageId, locator: LOC(SOURCE, "1:10"), state: { desiredFolder: OLD, observedFolder: SOURCE, lastSetBy: "us" } },
      { type: "move", to: OLD },
    );
    const row = await stateOf(messageId);
    expect(row.desiredFolder).toBe(OLD);
    expect(row.observedFolder).toBe(OLD);
    expect(row.reconcileStatus).toBe("reconciled");
    expect(out.state).toEqual({ desiredFolder: OLD, observedFolder: OLD, lastSetBy: "us" });
    expect(await actionsOf(accountId)).toEqual(["move"]);
  }, 60_000);
});
