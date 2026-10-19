import { describe, it, expect } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes, users } from "@trafficflow/db";
import { sql } from "drizzle-orm";
import { StaticKeyProvider } from "@trafficflow/core";
import {
  adminAccountDetail, makeMailboxService, type AdminDb, type ServiceContext,
} from "@trafficflow/services";

/**
 * A BLOCK WHOSE REASON THIS BUILD DOES NOT KNOW MUST STILL LEAVE THE SERVER AS A BLOCK.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────
 * Both projections narrow `sync_blocked_reason` to this build's copy of the closed set and forward
 * `sync_blocked_since` untouched:
 *
 *   admin-service.ts:647-648    isMailboxSyncBlockReason(row.syncBlockedReason) ? … : null
 *   mailbox-service.ts:526-527   isMailboxSyncBlockReason(m.syncBlockedReason)   ? … : null
 *
 * The narrowing is correct and stays — it is what keeps a server-chosen string off an operator's
 * screen (the "Account isolation is absolute, and it binds staff too" invariant). The consequence is that the ONE bit meaning "this mailbox is not being
 * organized" moves into `syncBlockedSince`, because the reason has been erased. Every consumer
 * used to gate on the reason, so under a worker-ahead-of-API deploy (or a Vercel alias ROLLBACK of
 * `ohmail-api` under a newer worker — X-LEGACYAPI is the precedent that this repo's artifact
 * bookkeeping fails in exactly that dimension) a blocked mailbox rendered as healthy on BOTH
 * surfaces. That is the 52 minutes, restored by deploy order.
 *
 * ── WHY THE CHECK CONSTRAINT IS DROPPED HERE ───────────────────────────────────────────────
 * `0029_mailbox_sync_block.sql:113` admits exactly three members, so the future this test is about
 * — the set widened, the worker writing a fourth — is not reachable while the constraint is in
 * force. Dropping it IS the scenario: a later migration widens it and the API has not been
 * redeployed. The drop is per-database and each `makeTestDb()` is a fresh PGlite, so it leaks
 * nowhere.
 *
 * PGlite is adequate and no `*.pg.test.ts` belongs here: nothing below writes concurrently or
 * inside a transaction. This is about which columns one SELECT projects.
 */

const NOW = new Date("2026-08-04T12:00:00.000Z");
const BLOCKED_SINCE = new Date("2026-08-04T11:08:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1);

/** The member no build in this repository has ever heard of — the whole premise. */
const FUTURE_REASON = "a_future_reason";

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function seedBlockedMailbox(db: Db, reason: string): Promise<{ accountId: string; id: string }> {
  // The CHECK admits three members and this test is about the fourth. See the header.
  await db.execute(
    sql`ALTER TABLE mailboxes DROP CONSTRAINT IF EXISTS mailboxes_sync_blocked_reason_closed`,
  );
  const [a] = await db.insert(accounts).values({ name: "sync block" }).returning();
  // `loadRoster` reads the account holder's login address out of `users`; without one the account still
  // projects, but seeding it keeps the fixture a real account rather than a half-built one.
  await db.insert(users).values({
    accountId: a!.id, email: "owner@a0e.test", passwordHash: "x", emailVerifiedAt: NOW,
  });
  const [mb] = await db.insert(mailboxes).values({
    accountId: a!.id,
    provider: "imap",
    address: "blocked@a0e.test",
    // THE COMBINATION IS THE BUG: connected, no error, no backoff — and organized by nobody.
    status: "connected",
    syncBlockedReason: reason,
    syncBlockedSince: BLOCKED_SINCE,
  }).returning();
  return { accountId: a!.id, id: mb!.id };
}

describe("a block survives the projection even when its reason does not", () => {
  it("the premise: an unrecognised reason really is stored, and really is not a known member", async () => {
    // ANTI-VACUITY. If the insert silently coerced the value, or if `a_future_reason` had quietly
    // become a member of the closed set, both assertions below would pass for the wrong reason and
    // this whole file would be decoration.
    const db = await makeTestDb();
    await seedBlockedMailbox(db, FUTURE_REASON);
    const [row] = await db.select().from(mailboxes);
    expect(row!.syncBlockedReason).toBe(FUTURE_REASON);
    expect(row!.syncBlockedSince).not.toBeNull();
    const { MAILBOX_SYNC_BLOCK_REASONS } = await import("@trafficflow/db");
    expect(
      (MAILBOX_SYNC_BLOCK_REASONS as readonly string[]).includes(FUTURE_REASON),
      "`a_future_reason` is now a real member, so this file no longer tests version skew",
    ).toBe(false);
  });

  it("THE ADMIN WIRE: reason narrowed to null, timestamp forwarded — `{null, <ts>}`", async () => {
    const db = await makeTestDb();
    const { accountId } = await seedBlockedMailbox(db, FUTURE_REASON);

    const detail = await adminAccountDetail(db as unknown as AdminDb, NOW, accountId, { roles: ["owner"] });
    expect(detail, "the account did not project at all").not.toBeNull();
    const [health] = detail!.mailboxes;

    expect(
      health!.syncBlockedReason,
      "the narrowing at admin-service.ts:647 was removed — a token the DATABASE chose is now on " +
        "an operator's screen, which is the closed-set boundary this slice deliberately kept",
    ).toBeNull();
    expect(
      health!.syncBlockedSince,
      "`syncBlockedSince` was narrowed too, so a mailbox nobody is organizing now leaves the API " +
        "indistinguishable from a healthy one. That is the defect: the two fields must stay ASYMMETRIC.",
    ).toBe(BLOCKED_SINCE.toISOString());

    // And the row still reports the shape that makes the block invisible to everything else:
    // connected, no error, no backoff. If any of these moved, the block would be findable by
    // other means and `syncBlockedSince` would not have to carry the signal alone.
    expect(health!.status).toBe("connected");
    expect(health!.lastError).toBeNull();
    expect(health!.retryBackoffSeconds).toBeNull();
  });

  it("THE CUSTOMER WIRE: the same asymmetry, from a different projection", async () => {
    // Written twice on purpose. `mailbox-service.ts` and `admin-service.ts` are separate functions
    // over the same columns, and an earlier fix is the precedent for a fix landing on one surface only.
    const db = await makeTestDb();
    const { accountId } = await seedBlockedMailbox(db, FUTURE_REASON);
    const ctx: ServiceContext = { db, accountId, userId: null, now: () => NOW, requestId: "r" };

    const [dto] = await makeMailboxService({ keyProvider: KP }).list(ctx);

    expect(dto!.syncBlockedReason, "an unknown token reached the customer's client").toBeNull();
    expect(
      dto!.syncBlockedSince,
      "the customer's client now has no way to know the mailbox is not being synced — the shell's " +
        "ladder (`apps/webapp/app/shell/mail-state.ts`) gates on exactly this field",
    ).toBe(BLOCKED_SINCE.toISOString());
    expect(dto!.status).toBe("connected");
    expect(dto!.errorCode).toBeNull();
  });

  it("a KNOWN reason is still forwarded verbatim on both wires — the narrowing is not a mute", async () => {
    // The other half. Without it, a projection that hard-coded `syncBlockedReason: null` would
    // satisfy every assertion above and take the console's copy with it.
    const db = await makeTestDb();
    const { accountId } = await seedBlockedMailbox(db, "lease_unreadable");

    const detail = await adminAccountDetail(db as unknown as AdminDb, NOW, accountId, { roles: ["owner"] });
    expect(detail!.mailboxes[0]!.syncBlockedReason).toBe("lease_unreadable");

    const ctx: ServiceContext = { db, accountId, userId: null, now: () => NOW, requestId: "r" };
    const [dto] = await makeMailboxService({ keyProvider: KP }).list(ctx);
    expect(dto!.syncBlockedReason).toBe("lease_unreadable");
  });

  it("no block, no timestamp — `{null, null}` stays the resting state", async () => {
    // The negative control for the pair. A projection that forwarded a timestamp unconditionally
    // from somewhere other than the column would put every healthy mailbox into the blocked branch
    // of both clients, which is a louder failure but a failure all the same.
    const db = await makeTestDb();
    const [a] = await db.insert(accounts).values({ name: "sync block calm" }).returning();
    await db.insert(mailboxes).values({
      accountId: a!.id, provider: "imap", address: "calm@a0e.test", status: "connected",
    });

    const detail = await adminAccountDetail(db as unknown as AdminDb, NOW, a!.id, { roles: ["owner"] });
    expect(detail!.mailboxes[0]!.syncBlockedReason).toBeNull();
    expect(detail!.mailboxes[0]!.syncBlockedSince).toBeNull();

    const ctx: ServiceContext = { db, accountId: a!.id, userId: null, now: () => NOW, requestId: "r" };
    const [dto] = await makeMailboxService({ keyProvider: KP }).list(ctx);
    expect(dto!.syncBlockedReason).toBeNull();
    expect(dto!.syncBlockedSince).toBeNull();
  });
});
