import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { accounts, mailboxes, messageFailures } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { pgTestUrl } from "@trafficflow/db/testing";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE CLAIM RACE, AND THE CLOSED `code` SET — the two things PGlite cannot answer here
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `claimMessageFailures` is the mutual exclusion that stops two workers mid-leader-handover both
 * re-reading the same UID. Its correctness is a claim about what a SECOND physical connection sees
 * after the first commits, and PGlite has one connection: on it, a read cannot tell "committed" from
 * "written inside my own open transaction". A PGlite-only guard therefore passes just as happily
 * against a two-round-trip select-then-update, which is the implementation that loses the race.
 *
 * The second half of this file is the CHECK constraint. `message_failures_code_closed` is what makes
 * "a closed set, never free text" structural rather than a comment — the "Account isolation is absolute, and it binds staff too" invariant, the same contract
 * `mailboxes_sync_blocked_reason_closed` holds — and a CHECK is exactly the kind of object an
 * in-memory Postgres can mislead you about.
 */
const URL = pgTestUrl(import.meta.url);

const sqlA = postgres(URL, { max: 5 });
const sqlB = postgres(URL, { max: 5 });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");
const repoA = makeDrizzleRepo(dbA);
const repoB = makeDrizzleRepo(dbB);

async function seedMailbox(): Promise<{ accountId: string; mailboxId: string }> {
  const [acct] = await dbA.insert(accounts).values({ name: "mf-pg" }).returning();
  const accountId = acct!.id;
  const [mb] = await dbA.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `mf-${randomUUID().slice(0, 8)}@tf.example` }).returning();
  return { accountId, mailboxId: mb!.id };
}

describe("the durable failure ledger against real Postgres, on two connections", () => {
  beforeAll(async () => { await runMigrations(URL); }, 60000);
  afterAll(async () => { await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); });

  it("two workers claim the SAME due UID and exactly one wins", async () => {
    const { accountId, mailboxId } = await seedMailbox();
    await repoA.recordMessageFailure(mailboxId, {
      accountId, folder: "Sent", uidValidity: "42", uid: 9001,
      code: "mime_too_large", version: "old-build", nextAttemptAt: null,
    });

    // ── THE OVERLAP IS FORCED, AND WITHOUT FORCING IT THIS TEST PROVES NOTHING ───────────────
    //
    // A bare `Promise.all` of the two claims was the first version of this test, and it passed with
    // the mutual exclusion REMOVED: two statements on two pools do not reliably overlap, so B's
    // sub-select usually ran after A had already committed and saw nothing due. A guard that has
    // never been seen to reject anything is a guard nobody knows the state of.
    //
    // So A's claim is held open inside a transaction while B's runs. B's sub-select is a plain SELECT
    // and does NOT block — it reads the pre-A snapshot and returns the id — and B's UPDATE then
    // blocks on A's row lock. When A commits, B re-evaluates its qual against the COMMITTED new row.
    // That re-evaluation is the thing under test, and it is unreachable without the overlap.
    const now = new Date();
    let bClaim: Promise<Awaited<ReturnType<typeof repoB.claimMessageFailures>>> | null = null;
    let a: Awaited<ReturnType<typeof repoA.claimMessageFailures>> = [];
    await dbA.transaction(async (tx) => {
      a = await makeDrizzleRepo(tx as unknown as Parameters<typeof makeDrizzleRepo>[0])
        .claimMessageFailures(mailboxId, { version: "new-build", now, limit: 5, nextAttemptAt: null });
      // Both processes are the SAME new build — the real handover shape: two instances of one
      // deploy, both seeing `attempted_version = 'old-build'` and both entitled to a probe.
      bClaim = repoB.claimMessageFailures(mailboxId, { version: "new-build", now, limit: 5, nextAttemptAt: null });
      // Long enough for B to have issued its sub-select and be parked on the row lock.
      await new Promise((r) => setTimeout(r, 400));
    });
    const b = await bClaim!;

    // EXACTLY ONE. Two claims mean two targeted fetches and two ingests of one message per handover —
    // which converges on the dedup key, but doubles the IMAP traffic of every failover and counts two
    // attempts against a message that was probed once.
    expect(a.length, "the first claimant must win").toBe(1);
    expect(b, "both claimed the same UID — the update's own predicate did not bite").toEqual([]);

    // …and the attempt was counted ONCE, not twice.
    const [row] = await dbA.select().from(messageFailures)
      .where(and(eq(messageFailures.mailboxId, mailboxId), eq(messageFailures.uid, 9001)));
    expect(row!.attempts).toBe(2);
    expect(row!.attemptedVersion).toBe("new-build");
  }, 60000);

  it("a SECOND claim on the same build claims nothing — one probe per build, not one per cycle", async () => {
    const { accountId, mailboxId } = await seedMailbox();
    await repoA.recordMessageFailure(mailboxId, {
      accountId, folder: "Sent", uidValidity: "42", uid: 9002,
      code: "mime_unparseable", version: "v1", nextAttemptAt: null,
    });

    const now = new Date();
    expect(await repoA.claimMessageFailures(mailboxId, { version: "v2", now, limit: 5, nextAttemptAt: null }))
      .toHaveLength(1);
    // The version arm is self-disarming: the claim stamped `v2`, so nothing is due until `v3`.
    expect(await repoB.claimMessageFailures(mailboxId, { version: "v2", now, limit: 5, nextAttemptAt: null }))
      .toEqual([]);
    expect(await repoA.claimMessageFailures(mailboxId, { version: "v3", now, limit: 5, nextAttemptAt: null }))
      .toHaveLength(1);
  }, 60000);

  it("a CLOCK-scheduled row is not due before its instant, and is after it", async () => {
    const { accountId, mailboxId } = await seedMailbox();
    const t0 = new Date("2026-08-05T10:00:00Z");
    await repoA.recordMessageFailure(mailboxId, {
      accountId, folder: "INBOX", uidValidity: "7", uid: 9003,
      code: "unclassified", version: "v1", nextAttemptAt: new Date(t0.getTime() + 60 * 60 * 1000),
    });

    // Same build, before the hour: neither arm fires.
    expect(await repoA.claimMessageFailures(mailboxId, {
      version: "v1", now: t0, limit: 5, nextAttemptAt: null,
    })).toEqual([]);
    // Same build, after the hour: the clock arm fires. This is the assertion that would go silently
    // false if the `Date` were bound through a raw `sql` fragment — postgres.js describes a bare
    // parameter as TEXT and the comparison never happens.
    expect(await repoA.claimMessageFailures(mailboxId, {
      version: "v1", now: new Date(t0.getTime() + 2 * 60 * 60 * 1000), limit: 5, nextAttemptAt: null,
    })).toHaveLength(1);
  }, 60000);

  it("a resolved row is never claimed again", async () => {
    const { accountId, mailboxId } = await seedMailbox();
    await repoA.recordMessageFailure(mailboxId, {
      accountId, folder: "Sent", uidValidity: "42", uid: 9004,
      code: "mime_too_large", version: "v1", nextAttemptAt: null,
    });
    await repoA.resolveMessageFailure(mailboxId, { folder: "Sent", uidValidity: "42", uid: 9004 });
    expect(await repoA.listMessageFailures(mailboxId)).toEqual([]);
    expect(await repoB.claimMessageFailures(mailboxId, {
      version: "v9", now: new Date(), limit: 5, nextAttemptAt: null,
    })).toEqual([]);
  }, 60000);

  it("the SAME UID under a DIFFERENT epoch is a different row", async () => {
    // The uniqueness claim, and it is not pedantry: a folder that resets its UIDVALIDITY commonly
    // re-allocates from low numbers, so a failure written off under epoch V must not silence — nor be
    // silenced by — a different message that reuses that number under V′.
    const { accountId, mailboxId } = await seedMailbox();
    for (const epoch of ["100", "200"]) {
      await repoA.recordMessageFailure(mailboxId, {
        accountId, folder: "Sent", uidValidity: epoch, uid: 9005,
        code: "mime_too_large", version: "v1", nextAttemptAt: null,
      });
    }
    const rows = await repoA.listMessageFailures(mailboxId);
    expect(rows.map((r) => r.uidValidity).sort()).toEqual(["100", "200"]);
    await repoA.resolveMessageFailure(mailboxId, { folder: "Sent", uidValidity: "100", uid: 9005 });
    expect(await repoA.listMessageFailures(mailboxId)).toEqual([
      { folder: "Sent", uid: 9005, uidValidity: "200", code: "mime_too_large", attempts: 1 },
    ]);
  }, 60000);

  it("a deterministic code keeps NULL scheduling THROUGH a claim that stamps the clock codes", async () => {
    // The production row retried hundreds of times: the targeted retry claims with the generic
    // hourly instant, and the claim used to stamp it onto EVERY row regardless of code — so a
    // `mime_too_large` message, deterministic in its bytes, was size-probed once an hour for ever.
    // `holdScheduleForCodes` is the fix, and it lives in the claim statement itself so it is
    // exactly as atomic as the claim. Mutation evidence: dropping the `holdScheduleForCodes`
    // argument from the worker's call (or the CASE from the repo) turns the hour-later
    // re-claim assertion red — watched fail on 2026-08-26 when the fix landed.
    const { accountId, mailboxId } = await seedMailbox();
    const t0 = new Date("2026-08-05T10:00:00Z");
    await repoA.recordMessageFailure(mailboxId, {
      accountId, folder: "INBOX", uidValidity: "7", uid: 9200,
      code: "mime_too_large", version: "v1", nextAttemptAt: null,
    });
    await repoA.recordMessageFailure(mailboxId, {
      accountId, folder: "INBOX", uidValidity: "7", uid: 9201,
      code: "unclassified", version: "v1", nextAttemptAt: new Date(t0.getTime() - 1000),
    });

    // A new build claims both — exactly the targeted retry's shape: one generic hourly instant,
    // with the deterministic codes named as schedule-exempt.
    const hourly = new Date(t0.getTime() + 60 * 60 * 1000);
    const claimed = await repoA.claimMessageFailures(mailboxId, {
      version: "v2", now: t0, limit: 5, nextAttemptAt: hourly,
      holdScheduleForCodes: ["mime_too_large", "mime_unparseable", "data_exception"],
    });
    expect(claimed.map((r) => r.uid).sort()).toEqual([9200, 9201]);

    // The rows now disagree on schedule, per code: NULL for the deterministic one, the hour for
    // the clock one — read raw, because the schedule IS the claim under test.
    const rows = await dbA.select({
      uid: messageFailures.uid, nextAttemptAt: messageFailures.nextAttemptAt,
    }).from(messageFailures).where(and(
      eq(messageFailures.mailboxId, mailboxId), eq(messageFailures.uidvalidity, 7n),
    ));
    const byUid = new Map(rows.map((r) => [r.uid, r.nextAttemptAt]));
    expect(byUid.get(9200), "the deterministic row took the hourly schedule").toBeNull();
    expect(byUid.get(9201)?.getTime()).toBe(hourly.getTime());

    // An hour later, same build: the clock row is due again; the deterministic row is NOT —
    // its next look is a new build, never a later hour. This is the exact re-claim that ran hundreds of
    // times in production.
    const later = new Date(t0.getTime() + 2 * 60 * 60 * 1000);
    const reclaimed = await repoA.claimMessageFailures(mailboxId, {
      version: "v2", now: later, limit: 5, nextAttemptAt: new Date(later.getTime() + 60 * 60 * 1000),
      holdScheduleForCodes: ["mime_too_large", "mime_unparseable", "data_exception"],
    });
    expect(reclaimed.map((r) => r.uid)).toEqual([9201]);

    // …and a NEW build reaches the deterministic row exactly once, as always.
    const v3 = await repoA.claimMessageFailures(mailboxId, {
      version: "v3", now: later, limit: 5, nextAttemptAt: new Date(later.getTime() + 60 * 60 * 1000),
      holdScheduleForCodes: ["mime_too_large", "mime_unparseable", "data_exception"],
    });
    expect(v3.map((r) => r.uid).sort()).toEqual([9200, 9201]);
  }, 60000);

  it("the database REFUSES a code outside the closed set", async () => {
    const { accountId, mailboxId } = await seedMailbox();
    // Not through the repo — the repo's parameter is typed, and a type is not a constraint. This is
    // the raw INSERT a future caller, a migration or a hand-run statement would make.
    await expect(dbA.insert(messageFailures).values({
      accountId, mailboxId, folder: "Sent", uidvalidity: 1n, uid: 9006,
      code: "Subject: your one-time code is 481920",
    })).rejects.toThrow(/message_failures_code_closed|violates check constraint/);
    // …and every legitimate member is accepted, so the CHECK is a closed set rather than a
    // one-value column that happens to reject everything else.
    for (const [i, code] of ["mime_too_large", "mime_unparseable", "data_exception", "data_too_large",
      "constraint_violation", "unclassified"].entries()) {
      await expect(dbA.insert(messageFailures).values({
        accountId, mailboxId, folder: "Sent", uidvalidity: 1n, uid: 9100 + i, code,
      })).resolves.toBeTruthy();
    }
  }, 60000);
});
