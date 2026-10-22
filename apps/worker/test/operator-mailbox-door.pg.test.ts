import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { runMigrations } from "@trafficflow/db/admin";
import { accounts, mailboxes, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { readRunnerMailbox } from "../src/run-cli.js";

/**
 * ═══ A ONE-OFF TOOL DECLINES A MAILBOX THE PERSON ASKED IT TO LET GO ═══════════════════════
 *
 * `release_requested_at` leaves the row `organizer` on purpose — the claim lives in the
 * customer's own IMAP folder and expunging it belongs to the process holding that connection —
 * so every lease-shaped check an operator runner makes still passes. The refusal that stops the
 * runner is this read, and until 0.21 it was two copies with no test on either.
 *
 * A mailbox id that is not one answers `null`, which is NOT the refusal: the union has no
 * `mailbox` on it, so a caller cannot read it as an answer, and each runner says "no mailbox"
 * in its own voice. The source census holds every runner to handling that arm.
 *
 * Real Postgres, not PGlite: the column is a `timestamptz` the always-on organizer writes, and a
 * refusal that keyed on the wrong nullness would be invisible against a hand-built row.
 */

const RUN = await realPgAvailable();

describe.runIf(RUN)("readRunnerMailbox — the release request is a refusal for the CLI too", () => {
  let sql: ReturnType<typeof postgres>;
  let db: Tx;
  const accountId = randomUUID();

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL!);
    sql = postgres(PG_TEST_URL!, { max: 1 });
    db = brandDialect(drizzle(sql, { schema }), "pg") as unknown as Tx;
    await db.insert(accounts).values({ id: accountId, name: `op-${accountId.slice(0, 8)}` });
  });

  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  async function mailbox(releaseRequestedAt: Date | null): Promise<string> {
    const id = randomUUID();
    await db.insert(mailboxes).values({
      id, accountId, provider: "imap", address: `box-${id}@example.test`, status: "connected",
      ...(releaseRequestedAt ? { releaseRequestedAt } : {}),
    });
    return id;
  }

  it("answers the mailbox while no release has been asked for", async () => {
    const id = await mailbox(null);
    const read = await readRunnerMailbox(db, id);
    expect(read !== null && "mailbox" in read && read.mailbox.id).toBe(id);
  });

  it("refuses, by sentence, a mailbox with a standing release request", async () => {
    const id = await mailbox(new Date());
    const read = await readRunnerMailbox(db, id);
    expect(read !== null && "refusal" in read).toBe(true);
    expect(read !== null && "refusal" in read && read.refusal).toContain("has been asked to stop being organized here");
    expect(read !== null && "mailbox" in read).toBe(false);
  });

  it("answers a mailbox id that is not one with null — never a row the caller reads as ok", async () => {
    const read = await readRunnerMailbox(db, randomUUID());
    expect(read).toBeNull();
  });
});
