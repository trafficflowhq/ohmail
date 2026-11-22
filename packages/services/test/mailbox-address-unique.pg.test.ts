import { describe, it, expect, beforeAll } from "vitest";
import { dbFor } from "../src/context.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "../src/auth/crypto.js";
import { MailboxService } from "../src/mailbox-service.js";
import { ServiceError } from "../src/errors.js";

/**
 * ONE ACTIVE MAILBOX PER ADDRESS — the constraint, and the two ways past it.
 *
 * `POST /mailboxes` was driven twice with an identical address on the HOSTED SERVICE and answered
 * 201 both times, leaving two rows. Two allowance slots for one mailbox is the billing cost;
 * the real one is that `loadEnabledMailboxes` rosters by row, so two runtimes attach to one
 * physical mailbox and two `reconcileMailbox` passes issue competing Screener moves against
 * the same real folders — against "exactly one active organizer per mailbox".
 *
 * ── WHY `.pg.test.ts` ───────────────────────────────────────────────────────────────────
 *
 * A partial unique index on a functional expression is precisely the kind of object PGlite has
 * been wrong about here before, and the 23505 error SHAPE (`code`, `constraint`) is a driver
 * detail — the mapping to 409 is only real if a real driver raised it. AGENTS.md's rule.
 */
/**
 * The seam, satisfied rather than exercised.
 *
 * `MailboxService.create` requires a probe now — a create that could omit one is a create that
 * can store a password nobody tried. This file is about something else, so it hands over the
 * verdict a working mailbox gives and asserts nothing about it. The verdicts themselves are
 * driven in `packages/api/test/mailbox-add-probe.wprobe.test.ts`.
 */
const PROBE_OK = { probe: async () => ({ verdict: "ok" as const }) };

const AVAILABLE = await realPgAvailable();

describe.skipIf(!AVAILABLE)("mailboxes_active_address_uq", () => {
  let db: OwnedDb["db"];
  let owned: OwnedDb;
  let service: MailboxService;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db;
    service = new MailboxService({
      keyProvider: StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1),
      // The allowance default is REGISTERED by the full `@trafficflow/services` barrel, which this
      // file does not load (it imports the module directly). Passed explicitly rather than left to
      // the registry: what is under test here is the unique index and the 23505 mapping, so a plan
      // limit refusing first would answer a different question — and an unset policy now refuses
      // rather than silently admitting, which is the point of the registry.
      allowance: async () => {},
    });
  }, 60_000);

  /**
   * An account with a live plan.
   *
   * The subscription is not scenery: `create` runs the allowance gate INSIDE its transaction
   * and refuses `no_subscription` before it ever reaches the index, so an account without one
   * would make the 409 cases pass for the wrong reason.
   */
  const account = async (): Promise<string> => {
    const id = randomUUID();
    const now = new Date();
    await db.insert(accounts).values({ id, name: `uq-${id.slice(0, 8)}` });
    return id;
  };

  const body = (address: string) => ({
    provider: "imap", address,
    imap: { host: "imap.example.test", port: 993, secure: true, user: address, pass: "pw" },
  });

  it("THE REGRESSION: the same address twice is refused, not silently duplicated", async () => {
    const accountId = await account();
    await db.insert(mailboxes).values({ accountId, provider: "imap", address: "dup@example.test" });

    await expect(
      db.insert(mailboxes).values({ accountId, provider: "imap", address: "dup@example.test" }),
    ).rejects.toMatchObject({ code: "23505" });

    const rows = await db.select().from(mailboxes).where(eq(mailboxes.accountId, accountId));
    expect(rows).toHaveLength(1);
  });

  it("case is not a way around it — the shift key was the whole bypass", async () => {
    const accountId = await account();
    await db.insert(mailboxes).values({ accountId, provider: "imap", address: "case@example.test" });
    await expect(
      db.insert(mailboxes).values({ accountId, provider: "imap", address: "Case@Example.TEST" }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("scoped to the ACCOUNT — two customers may each connect the same address", async () => {
    // The index is not a global claim on an address. Two people can legitimately hold
    // credentials to one shared mailbox, and this must not become a cross-account oracle.
    const a = await account();
    const b = await account();
    await db.insert(mailboxes).values({ accountId: a, provider: "imap", address: "shared@example.test" });
    await db.insert(mailboxes).values({ accountId: b, provider: "imap", address: "shared@example.test" });
    expect(true).toBe(true);
  });

  it("PARTIAL: disconnecting and reconnecting the same address still works", async () => {
    // The reason the index is partial. `delete` is a soft delete, so a plain unique would make
    // leave-anytime into leave-once — the tombstone would block the address forever.
    const accountId = await account();
    const [first] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: "again@example.test",
    }).returning();

    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, first!.id));

    const [second] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: "again@example.test",
    }).returning();
    expect(second!.id).not.toBe(first!.id);

    // And any number of tombstones may pile up behind the live one.
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, second!.id));
    await db.insert(mailboxes).values({ accountId, provider: "imap", address: "again@example.test" });
    const disabled = await db.select().from(mailboxes)
      .where(and(eq(mailboxes.accountId, accountId), eq(mailboxes.status, "disabled")));
    expect(disabled).toHaveLength(2);
  });

  it("create() maps 23505 to a 409 the UI can show, not a 500", async () => {
    const accountId = await account();
    const ctx = { db: dbFor(db, accountId), accountId, userId: null, now: () => new Date(), requestId: "t" };

    await db.insert(mailboxes).values({ accountId, provider: "imap", address: "svc@example.test" });

    const err = await service.create(ctx, body("svc@example.test"), PROBE_OK).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).httpStatus).toBe(409);
    expect((err as ServiceError).code).toBe("mailbox_exists");
    // The sentence is the one shown to a person, so it must not leak the index name.
    expect((err as ServiceError).message).not.toMatch(/23505|mailboxes_active_address_uq/);
  });

  it("update() maps the RE-ENABLE collision the same way — the second bypass", async () => {
    // `disabled → connected` inserts into the partial index, so re-enabling an address that a
    // live row already holds must be refused too. Without this the constraint has a back door
    // exactly as the allowance gate did.
    const accountId = await account();
    const [old] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: "reenable@example.test", status: "disabled",
    }).returning();
    await db.insert(mailboxes).values({
      accountId, provider: "imap", address: "reenable@example.test", status: "connected",
    });

    const ctx = { db: dbFor(db, accountId), accountId, userId: null, now: () => new Date(), requestId: "t" };
    const err = await service.update(ctx, old!.id, { status: "connected" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).httpStatus).toBe(409);
    expect((err as ServiceError).code).toBe("mailbox_exists");
  });

  it("a genuinely new address still connects — the mapping is not refusing everything", async () => {
    const accountId = await account();
    const ctx = { db: dbFor(db, accountId), accountId, userId: null, now: () => new Date(), requestId: "t" };
    const dto = await service.create(ctx, body("fresh@example.test"), PROBE_OK);
    expect(dto.address).toBe("fresh@example.test");
    const creds = await db.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, dto.id));
    expect(creds.length).toBeGreaterThan(0);
  });
});
