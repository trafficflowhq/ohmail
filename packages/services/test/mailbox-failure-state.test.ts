import { describe, it, expect } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes, MAILBOX_SYNC_BLOCK_REASONS } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { StaticKeyProvider } from "@trafficflow/core";
import { dbFor, makeMailboxService, ServiceError, type ServiceContext } from "@trafficflow/services";

/**
 * THE PUBLIC PATCH MAY NOT STEP AROUND THE WORKER'S FAILURE STATE MACHINE.
 *
 * Mail 0023 made `mailboxes` record WHY a mailbox failed, and put the write behind exactly two
 * functions that carry the reason with the status (`markMailboxFailed` / `markMailboxConnected`,
 * `apps/worker/src/mailboxes.ts`). `PATCH /mailboxes/:id` was not one of them and wrote `status`
 * on its own, which produced two half-truths an external `max`-effort review named:
 *
 *  1. a client could DECLARE a mailbox broken — `status='error'` with no code, rendered as
 *     `"unknown"` in the user's Settings and in the admin console's operator queue, about an
 *     outage the product never observed;
 *  2. leaving `error` did not end the episode. `error_code` / `error_detail` / `failed_at` /
 *     `retry_count` survived a reconnect INVISIBLY — `toDTO` projects them only while the row
 *     says `error` — and `markMailboxFailed` COALESCEs `failed_at`, so the next unrelated
 *     failure inherited the old start time and continued the old attempt count.
 *
 * Written against PGlite deliberately: nothing here is about concurrency (the fencing half of
 * this slice is in `apps/worker/test/mailbox-fence.pg.test.ts`, on real Postgres). It is about
 * which columns one statement writes.
 */

const NOW = new Date("2026-08-02T12:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1);
const svc = makeMailboxService({ keyProvider: KP });

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const ctxFor = (db: Db, accountId: string): ServiceContext =>
  ({ db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" });

/** An outage three days old, on its ninth attempt — the state a real quarantine reaches. */
const OUTAGE = {
  status: "error",
  errorCode: "auth",
  errorDetail: "AUTHENTICATIONFAILED",
  failedAt: new Date("2026-07-30T09:00:00.000Z"),
  retryCount: 9,
} as const;

async function seed(db: Db, over: Partial<typeof mailboxes.$inferInsert> = {}) {
  const [a] = await db.insert(accounts).values({ name: "failure state" }).returning();
  const [mb] = await db.insert(mailboxes).values({
    accountId: a!.id, provider: "imap", address: "one@x.test", ...over,
  }).returning();
  return { accountId: a!.id, id: mb!.id };
}

const rowOf = async (db: Db, id: string) =>
  (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;

describe("PATCH /mailboxes/:id and the failure state machine", () => {
  it("REFUSES `status: 'error'` — a client cannot declare a mailbox broken", async () => {
    const db = await makeTestDb();
    const mb = await seed(db);

    // Cast because the TYPE forbids it too. The refusal has to be at runtime as well: the body
    // arrives as `readBody<UpdateMailboxBody>` over untyped JSON, so a `curl` reaches this line
    // whatever the interface says.
    const err = await svc.update(ctxFor(db, mb.accountId), mb.id, { status: "error" } as never)
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).httpStatus).toBe(400);
    expect((err as ServiceError).code).toBe("validation_failed");
    expect((await rowOf(db, mb.id)).status, "the refusal must not have written anything").toBe("connected");
  });

  it("clears the whole outage when a reconnect leaves `error`, in the same statement", async () => {
    const db = await makeTestDb();
    const mb = await seed(db, OUTAGE);

    const dto = await svc.update(ctxFor(db, mb.accountId), mb.id, { status: "connected" });
    expect(dto.status).toBe("connected");

    const row = await rowOf(db, mb.id);
    expect(row.errorCode, "a stale reason survived the reconnect").toBeNull();
    expect(row.errorDetail).toBeNull();
    expect(row.failedAt).toBeNull();
    expect(row.retryCount).toBe(0);
  });

  it("so the NEXT outage is its own episode, not a continuation of the last one", async () => {
    // The consequence, spelled out. `markMailboxFailed` writes
    // `failed_at = coalesce(failed_at, now)` and `retry_count = retry_count + 1`, so anything
    // left behind here is inherited: a mailbox reconnected today and failing tomorrow would
    // report a three-day outage on attempt 10. This is the assertion that would have caught it.
    const db = await makeTestDb();
    const mb = await seed(db, OUTAGE);
    await svc.update(ctxFor(db, mb.accountId), mb.id, { status: "connected" });

    // The worker's failure write, in the form `markMailboxFailed` issues it.
    const later = new Date("2026-08-05T08:00:00.000Z");
    await db.execute(
      `update mailboxes set status = 'error', error_code = 'connect',
         failed_at = coalesce(failed_at, '${later.toISOString()}'::timestamptz),
         retry_count = retry_count + 1
       where id = '${mb.id}'`,
    );

    const row = await rowOf(db, mb.id);
    expect(row.failedAt!.toISOString()).toBe(later.toISOString());
    expect(row.retryCount).toBe(1);
  });

  it("disconnecting an errored mailbox clears it too — a tombstone carries no outage", async () => {
    const db = await makeTestDb();
    const mb = await seed(db, OUTAGE);

    await svc.update(ctxFor(db, mb.accountId), mb.id, { status: "disabled" });

    const row = await rowOf(db, mb.id);
    expect(row.status).toBe("disabled");
    expect(row.failedAt).toBeNull();
    expect(row.retryCount).toBe(0);
  });

  it("a patch that does NOT move the status leaves a live outage alone", async () => {
    // The negative control. Renaming a quarantined mailbox must not silently mark it recovered —
    // the clear is bound to the status transition, not to `update` in general.
    const db = await makeTestDb();
    const mb = await seed(db, OUTAGE);

    await svc.update(ctxFor(db, mb.accountId), mb.id, { displayName: "Work" });

    const row = await rowOf(db, mb.id);
    expect(row.status).toBe("error");
    expect(row.errorCode).toBe("auth");
    expect(row.errorDetail).toBe("AUTHENTICATIONFAILED");
    expect(row.retryCount).toBe(9);
  });

  it("the DTO still hides the outage — the wire contract is unchanged by all of this", async () => {
    const db = await makeTestDb();
    const mb = await seed(db, OUTAGE);
    const dto = await svc.update(ctxFor(db, mb.accountId), mb.id, { displayName: "Work" });
    expect(dto.status).toBe("error");
    expect(dto.errorCode).toBe("auth");
    expect(dto.errorDetail).toBe("AUTHENTICATIONFAILED");
    expect(dto.retryCount).toBe(9);
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     MAIL 0029 — `PATCH` IS THE FOURTH WRITER OF THE SYNC-BLOCK PAIR, AND THE DTO DOES *NOT*
     HIDE IT
     ══════════════════════════════════════════════════════════════════════════════════════════

     `sync_blocked_reason` is the worker's report that it is NOT SERVING a mailbox whose `status`
     is `connected` — an unreadable organizer lease, credentials not yet provisioned, this
     deployment's mailbox cap. Four sites write it, and this file owns the one that is a service.

     The projection assertion below is the one that is easy to get backwards. The four failure
     columns are gated on `status === 'error'`, and applying that rule here would make these two
     fields permanently NULL on the wire — because every state they describe happens while the
     status is `connected`. That is not an inconsistency to be tidied; it is the reason the column
     exists, and a "fix" for the asymmetry would restore the 32-minute silence of 2026-08-03. */

  /** A mailbox nothing is syncing, whose row says so. `status` is `connected` — that is the point. */
  const BLOCKED = {
    status: "connected",
    syncBlockedReason: "lease_unreadable",
    syncBlockedSince: new Date("2026-08-03T10:00:00.000Z"),
  } as const;

  it("projects the block UNCONDITIONALLY — a `connected` mailbox can say why it is not syncing", async () => {
    const db = await makeTestDb();
    const mb = await seed(db, BLOCKED);

    const dto = await svc.update(ctxFor(db, mb.accountId), mb.id, { displayName: "Work" });
    expect(dto.status, "the whole scenario is a CONNECTED mailbox").toBe("connected");
    expect(dto.syncBlockedReason,
      "gated on status like the failure four ⇒ permanently null ⇒ the original defect").toBe("lease_unreadable");
    expect(dto.syncBlockedSince).toBe(BLOCKED.syncBlockedSince.toISOString());
    // …and it is NOT dressed up as a failure. The client must be able to tell "we cannot serve
    // this" from "your provider refused us", because only the second is the user's problem.
    expect(dto.errorCode).toBeNull();
    expect(dto.failedAt).toBeNull();
    expect(dto.retryCount).toBe(0);
  });

  it("a status move CLEARS the block — every reason, and every writer clears every one", async () => {
    // ENUMERATED FROM THE EXPORTED SET, never re-typed: a member added to
    // `MAILBOX_SYNC_BLOCK_REASONS` is checked here for free, which is the only way "every writer
    // clears it" stays true of a set that can grow. The worker's three writers are enumerated the
    // same way in `apps/worker/test/mailbox-fence.pg.test.ts`.
    for (const reason of MAILBOX_SYNC_BLOCK_REASONS) {
      for (const status of ["connected", "disabled"] as const) {
        const db = await makeTestDb();
        const mb = await seed(db, {
          status: "connected", syncBlockedReason: reason, syncBlockedSince: new Date(),
        });

        await svc.update(ctxFor(db, mb.accountId), mb.id, { status });

        const row = await rowOf(db, mb.id);
        expect(row.syncBlockedReason, `PATCH {status:'${status}'} left ${reason} behind`).toBeNull();
        expect(row.syncBlockedSince, `PATCH {status:'${status}'} left the timestamp behind`).toBeNull();
      }
    }
  }, 60_000);

  it("but a patch that does not move the status leaves the block alone", async () => {
    // The negative control, and it is the one that matters more here than for the failure four:
    // the worker re-writes this pair on every roster pass, so a clear on EVERY patch would be
    // harmless-looking churn — but a rename that silently declared a mailbox healthy would show
    // the user a clean row for up to one roster interval, which is exactly long enough to make
    // the panel disagree with itself while they are looking at it.
    const db = await makeTestDb();
    const mb = await seed(db, BLOCKED);

    await svc.update(ctxFor(db, mb.accountId), mb.id, { displayName: "Work" });

    const row = await rowOf(db, mb.id);
    expect(row.syncBlockedReason).toBe("lease_unreadable");
    expect(row.syncBlockedSince!.toISOString()).toBe(BLOCKED.syncBlockedSince.toISOString());
  });
});
