import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes, MAILBOX_DISABLED_REASONS, UNMETERED_ACCESS,} from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { StaticKeyProvider } from "@trafficflow/core";
import { makeMailboxService, type ServiceContext } from "@trafficflow/services";

/**
 * THE ORGANIZER LEASE'S VERDICT REACHES THE CLIENT, AND ONLY WHEN IT IS TRUE.
 *
 * `mailboxes.disabled_reason` (mail 0027) is WHY a mailbox is `disabled` when the lease decided
 * it rather than a person. Until this slice it was on NO wire: `MailboxDTO` had no such field
 * and `toDTO` never projected it. Combined with two writes that are individually correct —
 * `markMailboxStoodDown` clears the four `error*` columns AND the two `sync_blocked_*` columns,
 * because a stand-down is neither a failure nor an infrastructure block — the result was a
 * mailbox with `errorCode: null`, `syncBlockedSince: null` and nothing at all to say for itself.
 * Measured on the hosted service: "disconnected" and "No mail yet — added N minutes ago" on
 * one card, under "No mailbox connected, so nothing can arrive".
 *
 * Three rules are under test here and each is a different way to reintroduce a false sentence:
 * the field must be projected; it must be projected ONLY under `disabled`; and a value this
 * build does not recognise must not be narrowed to `null`, because under `disabled` a `null`
 * reason is the ordinary user disconnect.
 *
 * PGlite deliberately: nothing here is about concurrency, only about which columns one statement
 * writes and which values one projection emits. Same reasoning as `mailbox-failure-state.test.ts`.
 */

const NOW = new Date("2026-08-04T12:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1);
// UNMETERED, explicitly: re-enabling is a CREATE and runs the allowance gate, and the gate
// refuses outright when no reader is configured — a host that runs the paid gate must say where
// the limit comes from. This is the reader a self-host install composes.
const svc = makeMailboxService({ keyProvider: KP, accessOf: async () => UNMETERED_ACCESS });

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const ctxFor = (db: Db, accountId: string): ServiceContext =>
  ({ db, accountId, userId: null, now: () => NOW, requestId: "r" });

/** Exactly what `markMailboxStoodDown` leaves behind — every column, including the cleared ones. */
const STOOD_DOWN = {
  status: "disabled",
  disabledReason: "organized_elsewhere:local",
  errorCode: null,
  errorDetail: null,
  failedAt: null,
  retryCount: 0,
  syncBlockedReason: null,
  syncBlockedSince: null,
} as const;

async function seed(db: Db, over: Partial<typeof mailboxes.$inferInsert> = {}) {
  const [a] = await db.insert(accounts).values({ name: "stand-down dto" }).returning();
  const [mb] = await db.insert(mailboxes).values({
    accountId: a!.id, provider: "imap", address: "person@example.test", ...over,
  }).returning();
  return { accountId: a!.id, id: mb!.id };
}

const rowOf = async (db: Db, id: string) =>
  (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;


describe("MailboxDTO carries WHY a disabled mailbox is disabled", () => {
  it("THE REGRESSION: a stood-down mailbox says so on the wire", async () => {
    const db = await makeTestDb();
    const mb = await seed(db, STOOD_DOWN);

    const dto = await svc.get(ctxFor(db, mb.accountId), mb.id);
    expect(dto.status).toBe("disabled");
    expect(
      dto.disabledReason,
      "the one column that held the fact still never leaves the server",
    ).toBe("organized_elsewhere:local");

    // The premise, asserted rather than assumed: neither of the other two explanation channels
    // carries anything, which is why this field had to exist at all.
    expect(dto.errorCode, "a stand-down is not a failure").toBeNull();
    expect(dto.syncBlockedSince, "a stand-down is not an infrastructure block").toBeNull();
  });

  it("…and `list` projects it too — the pane reads the list, not `get`", async () => {
    const db = await makeTestDb();
    const mb = await seed(db, STOOD_DOWN);
    const [dto] = await svc.list(ctxFor(db, mb.accountId));
    expect(dto!.disabledReason).toBe("organized_elsewhere:local");
  });

  it("an ordinary disconnect projects `null`, and that difference is the whole point", async () => {
    const db = await makeTestDb();
    const mb = await seed(db, { status: "disabled" });
    const dto = await svc.get(ctxFor(db, mb.accountId), mb.id);
    expect(dto.status).toBe("disabled");
    expect(
      dto.disabledReason,
      "a mailbox the user removed would be blamed on another ohmail install",
    ).toBeNull();
  });

  it("GATED ON `disabled`: the re-enable window must not say `connected` and `taken` at once", async () => {
    /**
     * THE REACHABLE ROW THAT KILLED THE UNGATED PROJECTION.
     *
     * `MailboxService.update` deliberately does NOT clear `disabled_reason` on a re-enable —
     * `clearOrganizerStandDown` (`apps/worker/src/mailboxes.ts`) owns that clear and performs it
     * only once the gate has actually won the mailbox back, so the evidence survives the interval
     * in which the worker has not yet answered. That makes
     * `{status: 'connected', disabled_reason: 'organized_elsewhere:local'}` an ordinary state of
     * the table, and an ungated projection would ship it — a mailbox telling its owner it is
     * connected AND that somebody else has claimed it. That is a NEW instance of exactly the
     * contradiction this slice removes.
     */
    const db = await makeTestDb();
    const mb = await seed(db, STOOD_DOWN);

    const dto = await svc.update(ctxFor(db, mb.accountId), mb.id, { status: "connected" });
    expect(dto.status).toBe("connected");
    expect(
      dto.disabledReason,
      "a connected mailbox told its owner another install has claimed it",
    ).toBeNull();
    expect(
      (await rowOf(db, mb.id)).disabledReason,
      "the column must SURVIVE the re-enable — the worker's gate owns the clear, and erasing " +
        "it here would destroy the only explanation while the gate stands the mailbox back down",
    ).toBe("organized_elsewhere:local");
  });

  it("A VALUE THIS BUILD DOES NOT KNOW BECOMES `:unknown`, NEVER `null` (transposed)", async () => {
    /**
     * `syncBlockedReason` may narrow an unrecognised member to `null` because `syncBlockedSince`
     * carries the predicate beside it. This column has no partner: `status` is the predicate, and
     * under `disabled` a `null` reason MEANS the ordinary user disconnect. So narrowing to `null`
     * would file a newer worker's stand-down as "the user removed this" on an older API — the
     * original defect, restored by deploy order. The closed set ships its own catch-all for this
     * and `markMailboxStoodDown` applies the same rule at the write site.
     *
     * The value reaches the column as a newer build's write would: since mail 0202 the column's
     * CHECK holds the shape of a reason word, which a new member fits.
     */
    const db = await makeTestDb();
    const mb = await seed(db, { status: "disabled" });
    await db.update(mailboxes)
      .set({ disabledReason: "organized_elsewhere:quantum" })
      .where(eq(mailboxes.id, mb.id));

    const dto = await svc.get(ctxFor(db, mb.accountId), mb.id);
    expect(
      dto.disabledReason,
      "a stand-down reason from a newer worker was passed off as an ordinary disconnect",
    ).toBe("organized_elsewhere:unknown");
  });

  it("every member of the closed set survives the projection unchanged", async () => {
    const db = await makeTestDb();
    for (const reason of MAILBOX_DISABLED_REASONS) {
      const mb = await seed(db, { status: "disabled", disabledReason: reason, address: `${reason}@x.test` });
      const dto = await svc.get(ctxFor(db, mb.accountId), mb.id);
      expect(dto.disabledReason, `${reason} did not survive toDTO`).toBe(reason);
    }
  });
});

describe("disconnecting a mailbox ends every claim the row was making", () => {
  it("`delete` clears the lease columns, in the same statement as the status", async () => {
    /**
     * FOUND REVIEWING and it is the rule `packages/db/src/mailbox-errors.ts` already states
     * for the column beside it: "every writer that makes the statement untrue clears it in the
     * same statement". `delete` was not one of the writers that did, and it went unnoticed for
     * exactly one reason — nothing rendered the column. The moment the row copy exists, a
     * mailbox the user stood down and then DISCONNECTED tells them for ever that another ohmail
     * install has claimed it.
     */
    const db = await makeTestDb();
    const mb = await seed(db, {
      ...STOOD_DOWN,
      status: "connected",
      takeoverAuthorizedAt: NOW,
      syncBlockedReason: "at_capacity",
      syncBlockedSince: NOW,
    });

    await svc.delete(ctxFor(db, mb.accountId), mb.id);

    const row = await rowOf(db, mb.id);
    expect(row.status).toBe("disabled");
    expect(row.disabledReason, "the tombstone still blames another organizer").toBeNull();
    // §4, "No seize-back": an authorization is permission for ONE becoming, and disconnecting
    // ends the relationship it was granted inside. Left set, it is spent by whatever re-enables
    // the row months later — the standing right the one-shot rule forbids.
    expect(row.takeoverAuthorizedAt, "a spent-by-a-future-re-enable takeover survived").toBeNull();
    // `update` already clears these on any status move and says why: "a tombstone carries no
    // explanation of why it was not syncing". `delete` is a status move.
    expect(row.syncBlockedReason).toBeNull();
    expect(row.syncBlockedSince).toBeNull();
  });

  it("…and the DTO it leaves behind explains nothing, because there is nothing to explain", async () => {
    const db = await makeTestDb();
    const mb = await seed(db, STOOD_DOWN);
    // Re-enable, then disconnect — the sequence a user actually performs after a stand-down.
    await svc.update(ctxFor(db, mb.accountId), mb.id, { status: "connected" });
    await svc.delete(ctxFor(db, mb.accountId), mb.id);
    const dto = await svc.get(ctxFor(db, mb.accountId), mb.id);
    expect(dto.status).toBe("disabled");
    expect(dto.disabledReason).toBeNull();
  });
});
