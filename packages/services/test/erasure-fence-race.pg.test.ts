import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { accounts, snippets } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { UNMETERED_ACCESS } from "@trafficflow/db";
import { deleteAccount } from "../src/account-deletion-service.js";
import { readMailboxAllowance } from "../src/mailbox-allowance.js";
import { dbFor, withAccountTx, type ServiceContext } from "../src/context.js";
import { snippetsService } from "../src/snippets-service.js";
import { kbService } from "../src/kb-service.js";
import { notifyRulesService } from "../src/notify-rules-service.js";
import { ServiceError } from "../src/errors.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE RACE ITSELF — a write already authenticated when the Art. 17 sweep commits
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The window: the session is valid when the request starts, the sweep commits, and the request's
 * write commits afterwards — under the `accounts` row that erasure deliberately KEEPS. The
 * catalogue sweep then reports zero while the account owns rows again.
 *
 * Two arms, because the two orders fail differently and only one of them is visible to PGlite:
 *
 *  ORDERED — the sweep commits first. `withAccountTx` reads `accounts.erased_at` as its first
 *  statement, sees the stamp and refuses 410 before the writer's body runs at all.
 *
 *  CONCURRENT — the request's transaction is ALREADY OPEN, past its fence, when the sweep
 *  arrives. This is the arm the gap row names and the one PGlite cannot run: one connection
 *  serialises two awaited transactions by construction, so a fence that takes no lock passes
 *  there. On real Postgres the fence's `FOR SHARE` on the account row makes the sweep's own first
 *  statement — the exclusive `update accounts` — WAIT; the writer commits its row inside the
 *  sweep's reach, and the sweep then deletes it with everything else.
 *
 * MUTATIONS WATCHED RED, THEN RESTORED:
 *  · the fence removed from `withAccountTx` → all three cases red: the writers accept the write
 *    on an erased account, and the sweep no longer waits for the open request. The gap row's
 *    defect, reproduced;
 *  · `{ mode: "share" }` dropped from `readAccountErasedAt` so the fence reads without locking →
 *    ORDERED still GREEN, CONCURRENT red on "the sweep did not wait". That split is the reason
 *    both arms are here and the reason this file is `.pg.test.ts`: the ordered arm alone would
 *    have passed a fence that reads and locks nothing;
 *  · `lock: "update"` dropped from the third case's door → 40P01 in the first round, reported by
 *    Postgres as two backends `locking tuple … in relation "accounts" … for update`. That is the
 *    regression a fence in front of the allowance gate introduces, which is why the door lets a
 *    caller name the strength it will need.
 */
const PG_UP = await realPgAvailable();

let owned: OwnedDb;
let db: OwnedDb["db"];

const NOW = new Date("2026-09-12T09:00:00.000Z");

/** Rows still standing for this account, per table, out of the catalog rather than a list. */
async function survivors(accountId: string): Promise<string[]> {
  const cols = (await db.execute(sql`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'account_id'
    order by table_name`)) as unknown as Array<{ table_name: string }>;
  const out: string[] = [];
  for (const { table_name: t } of cols) {
    // `accounts` has no `account_id`, so it is not in this list at all; `attachment_staging` is
    // EXPIRED rather than deleted and is exempted by the erasure suite for its own reason.
    if (t === "attachment_staging") continue;
    const r = (await db.execute(
      sql`select count(*)::int as c from ${sql.identifier(t)} where account_id = ${accountId}`,
    )) as unknown as Array<{ c: number }>;
    if ((r[0]?.c ?? 0) > 0) out.push(`${t} (${r[0]!.c})`);
  }
  return out;
}

describe.skipIf(!PG_UP)("the erasure fence, against a write already in flight", () => {
  beforeAll(async () => {
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db;
    await runMigrations(PG_TEST_URL);
  });
  afterAll(async () => { await owned?.close(); });

  const ctxFor = (accountId: string): ServiceContext => ({
    db: dbFor(db, accountId),
    accountId,
    userId: null,
    now: () => NOW,
    requestId: `fence-race-${randomUUID()}`,
  } as ServiceContext);

  async function seedAccount(): Promise<string> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `race-${accountId.slice(0, 8)}` });
    return accountId;
  }

  it("ORDERED — the sweep commits, then three request-scoped writers each refuse 410", async () => {
    const accountId = await seedAccount();
    const ctx = ctxFor(accountId);
    await snippetsService.create(ctx, { title: "before", body: "still allowed" });

    await deleteAccount(ctx);

    // Each of these opens through `withAccountTx`, so the refusal belongs to the door and not to
    // three remembered call sites. The code is asserted, not just the rejection: a 404 or a
    // foreign-key error would satisfy `.rejects` and mean something else entirely.
    for (const attempt of [
      () => snippetsService.create(ctx, { title: "after", body: "must not land" }),
      () => kbService.create(ctx, { title: "after", content: "must not land", tags: [] }),
      () => notifyRulesService.create(ctx, { target: "someone@example.test", kind: "sender" }),
    ]) {
      const err = await attempt().then(() => null, (e: unknown) => e);
      expect(err, "an erased account accepted a write").toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("account_erased");
      expect((err as ServiceError).httpStatus).toBe(410);
    }

    expect(await survivors(accountId), "personal data survived erasure").toEqual([]);
  }, 60_000);

  it("CONCURRENT — the sweep waits for the open transaction, and sweeps the row it wrote", async () => {
    const accountId = await seedAccount();
    const ctx = ctxFor(accountId);

    let opened!: () => void;
    const isOpen = new Promise<void>((r) => { opened = r; });
    let release!: () => void;
    const mayWrite = new Promise<void>((r) => { release = r; });

    // The request. Its fence has already run and read `accounts FOR SHARE` by the time the body
    // below starts — which is exactly the state the gap row describes: authenticated, past its
    // check, not yet committed.
    const request = withAccountTx(ctx, async (tx) => {
      opened();
      await mayWrite;
      await tx.insert(snippets).values({
        accountId, title: "in flight", body: "written after the sweep began",
        shortcut: null, createdAt: NOW, updatedAt: NOW,
      });
      return "committed";
    });
    await isOpen;

    // The sweep, on its own backend. Its FIRST statement is the exclusive stamp on the same row
    // the request holds shared, so it blocks here rather than racing past.
    let sweepDone = false;
    const sweep = deleteAccount(ctxFor(accountId)).then((r) => { sweepDone = true; return r; });
    await new Promise((r) => setTimeout(r, 400));
    expect(sweepDone, "the sweep did not wait for the open request — the fence took no lock")
      .toBe(false);

    release();
    await expect(request).resolves.toBe("committed");
    await sweep;

    // The row the request wrote is INSIDE the sweep's reach, so nothing of the account stands.
    expect(await survivors(accountId), "an in-flight write outlived the erasure").toEqual([]);
    expect(await db.select().from(snippets).where(eq(snippets.accountId, accountId)))
      .toHaveLength(0);
  }, 60_000);

  it("takes the account row at the strength the body needs, so two writers queue", async () => {
    // `mailbox.create` fences and THEN reaches the allowance gate, whose serializer is
    // `accounts FOR UPDATE` on the row the fence just read. A fence that took it SHARED would make
    // every create an upgrade and two concurrent ones a 40P01 — so the door takes the strong lock
    // at the head instead (`withAccountTx`'s `lock`). Driven through `readMailboxAllowance`
    // itself, not a copy of its statement. With `lock` dropped this goes red with 40P01 in the
    // first round; the ordinary `share` default stays right for every writer that never upgrades.
    for (let round = 0; round < 4; round++) {
      const accountId = await seedAccount();
      const ctx = ctxFor(accountId);
      const both = [0, 1].map((i) => withAccountTx(ctx, async (tx) => {
        // Long enough that under a SHARE fence both transactions are past it — which is the
        // state the upgrade needs — before either asks for the gate.
        await new Promise((r) => setTimeout(r, 150));
        await readMailboxAllowance(tx, accountId, NOW, { access: UNMETERED_ACCESS });
        return i;
      }, { lock: "update" }));
      await expect(Promise.all(both), `round ${round} deadlocked`).resolves.toEqual([0, 1]);
    }
  }, 60_000);

  it("leaves the pseudonymous row, stamped, carrying nothing of the person", async () => {
    const accountId = await seedAccount();
    const ctx = ctxFor(accountId);
    await snippetsService.create(ctx, { title: "a snippet", body: "someone's own words" });
    await deleteAccount(ctx);
    await snippetsService.create(ctx, { title: "late", body: "refused" }).catch(() => null);

    const [row] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(row, "the billing subject must survive").toBeDefined();
    expect(row!.name).toBe("");
    expect(row!.erasedAt).not.toBeNull();
    expect(await survivors(accountId)).toEqual([]);
  }, 60_000);
});
