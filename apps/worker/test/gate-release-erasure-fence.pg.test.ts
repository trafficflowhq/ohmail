import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, accountSettings, mailboxes, passProgress, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { deleteAccount, type ServiceContext } from "@trafficflow/services";
import { gateReleasePass } from "../src/gate-release.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE GATE RELEASE'S COMPLETION STAMP, AGAINST AN ERASURE THAT LANDS MID-SWEEP
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The stamp is an UPSERT into `account_settings`, which the Art. 17 sweep empties — so it CREATES,
 * and a create after the sweep is a row the person was told had gone. The reason this write
 * carried on the erasure-fence census said the pass "reads `mailboxes` first and returns when this
 * install organizes none of them, so a run that STARTS after the sweep never reaches this write".
 * True, and about the wrong run: the one that stamps is the run already past that read, and it
 * pages through an account for as long as the account is large.
 *
 * The window is opened at the seam BOTH versions have — the page transaction. The sweep runs the
 * instant it commits, which is where the stamp then lands. A seam that exists only once the fence
 * does would measure the fix rather than the defect (the away pass's own file records that
 * mistake being made).
 *
 * MUTATION WATCHED RED, THEN RESTORED (pristine copy, `cmp`): the fence deleted from the stamp →
 * ERASED red naming the recreated `account_settings` row.
 */
const PG_UP = await realPgAvailable();
const NOW = new Date("2026-09-14T20:00:00.000Z");

let client: ReturnType<typeof postgres>;
let sweepClient: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let sweepDb: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
  client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
  sweepClient = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
  db = brandDialect(drizzle(client, { schema }), "pg");
  sweepDb = brandDialect(drizzle(sweepClient, { schema }), "pg");
});

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await sweepClient?.end({ timeout: 5 });
});

/** An account this install organizes — enough for the pass to run and reach its stamp. */
async function seed(): Promise<string> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `gr-${accountId.slice(0, 8)}` });
  await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `gr-${accountId.slice(0, 8)}@example.test`,
    organizerRole: "organizer",
  });
  return accountId;
}

const ctxFor = (accountId: string): ServiceContext => ({
  db: sweepDb as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => NOW,
  requestId: `gr-fence-${randomUUID()}`,
} as ServiceContext);

const passRows = async (accountId: string) =>
  db.select().from(passProgress).where(eq(passProgress.accountId, accountId));

describe.skipIf(!PG_UP)("the gate release's completion stamp and the erasure fence", () => {
  it("ERASED — the sweep lands mid-pass, and the stamp is not written", async () => {
    const accountId = await seed();

    // The sweep runs the moment the page transaction commits — the pass is then past its mailbox
    // read, holding an account id, about to stamp.
    let swept = false;
    const handle = db as unknown as { transaction: (f: unknown) => Promise<unknown> };
    const original = handle.transaction.bind(handle);
    const wrapped = new Proxy(db as object, {
      get(target, prop, recv) {
        if (prop !== "transaction") return Reflect.get(target, prop, recv);
        return async (f: unknown) => {
          const out = await original(f);
          if (!swept) { swept = true; await deleteAccount(ctxFor(accountId)); }
          return out;
        };
      },
    });

    const out = await gateReleasePass(wrapped as unknown as Tx, { accountId }, NOW);

    expect(swept, "the pass opened no page transaction — the window did not exist").toBe(true);
    expect(await passRows(accountId), "the completion stamp wrote a row for an erased account")
      .toHaveLength(0);
    // `completed` stays false and that is honest: nothing was stamped. No later cycle selects the
    // account either — it is gone.
    expect(out.completed).toBe(false);
  }, 60_000);

  it("THE POSITIVE CONTROL — a live account is still stamped and still completes", async () => {
    // Without this, a stamp that refused unconditionally would pass the case above.
    const accountId = await seed();

    const out = await gateReleasePass(db as unknown as Tx, { accountId }, NOW);

    expect(out.ran, "the pass did not run — the fixture organizes nothing").toBe(true);
    expect(out.completed).toBe(true);
    const rows = await passRows(accountId);
    expect(rows, "the fence refused a live account").toHaveLength(1);
    expect(rows[0]).toMatchObject({ job: "gate_release", subjectId: accountId });
    expect(rows[0]!.doneAt).not.toBeNull();
  }, 60_000);
});
