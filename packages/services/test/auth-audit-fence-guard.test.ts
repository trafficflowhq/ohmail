import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, users, fencedAccountOf, inTransactionHandle, type Tx } from "@trafficflow/db";
import { authEvents } from "@trafficflow/db/cloud";
import { AuthService, dbFor, makeTestAuthDeps, ServiceError, type ServiceContext } from "@trafficflow/services";

/**
 * THE AUDIT'S GUARD AND THE OPENER'S NESTING RULES, driven as a service body drives them. Inside a
 * transaction the hosted audit no longer reads the account itself (that read came after the
 * writer's row locks, the erasure's deadlock): the transaction must have been opened with the
 * fence, and one that was not is refused by name. A fenced opener inside an unfenced transaction
 * is refused too, because its read would not be the transaction's first statement.
 */
type Db = Awaited<ReturnType<typeof makeTestDb>>;
type User = typeof users.$inferSelect;
type Fence<T> = { accountId: string; onErased?: () => T };

class Probe extends AuthService {
  auditIn(ctx: ServiceContext, user: User | null, event: "logout" | "login" = "logout"): Promise<void> {
    return this.audit(ctx.db as unknown as Tx, user, event, undefined, ctx);
  }
  open<T>(ctx: ServiceContext, fn: (txCtx: ServiceContext) => Promise<T>, fence?: Fence<T>): Promise<T> {
    return this.inTransaction(ctx, fn, fence ? { fence } : {});
  }
}

let db: Db;
let probe: Probe;
let user: User;
const ctxOn = (handle: Db): ServiceContext => ({
  db: dbFor(handle, user.accountId), accountId: user.accountId, userId: user.id, sessionId: null,
  now: () => new Date(), requestId: randomUUID(), ip: "10.26.7.7",
});
const rows = async (): Promise<number> =>
  (await db.select({ id: authEvents.id }).from(authEvents).where(eq(authEvents.userId, user.id))).length;

beforeEach(async () => {
  db = await makeTestDb();
  probe = new Probe(makeTestAuthDeps());
  const [a] = await db.insert(accounts).values({ name: "guard" }).returning();
  [user] = (await db.insert(users).values({ accountId: a!.id, email: `guard-${randomUUID().slice(0, 8)}@erase.test` }).returning()) as [User];
});

describe("the hosted audit inside a transaction", () => {
  it("a plain transaction around the audit is refused by name, and writes nothing", async () => {
    await expect(probe.open(ctxOn(db), (tx) => probe.auditIn(tx, user)))
      .rejects.toThrow("auth audit inside a transaction the fence did not open: logout");
    expect(await rows()).toBe(0);
  });

  it("CONTROL: a fenced transaction's audit writes its row", async () => {
    await probe.open(ctxOn(db), (tx) => probe.auditIn(tx, user), { accountId: user.accountId });
    expect(await rows()).toBe(1);
  });

  it("a transaction fenced for another account is refused by the audit", async () => {
    const [other] = await db.insert(accounts).values({ name: "other" }).returning();
    await expect(probe.open(ctxOn(db), (tx) => probe.auditIn(tx, user), { accountId: other!.id }))
      .rejects.toThrow("auth audit in a transaction fenced for another account: logout");
    expect(await rows()).toBe(0);
  });

  it("CONTROL: outside any transaction the audit asks the stamp, as before", async () => {
    await probe.auditIn(ctxOn(db), user);
    expect(await rows()).toBe(1);
    await db.update(accounts).set({ erasedAt: new Date() }).where(eq(accounts.id, user.accountId));
    await probe.auditIn(ctxOn(db), user);
    expect(await rows(), "a stamped account takes no new row").toBe(1);
  });
});

describe("the fenced opener", () => {
  it("a fenced opener inside an unfenced transaction is refused by name", async () => {
    await expect(probe.open(ctxOn(db), (tx) => probe.open(tx, async () => "ran", { accountId: user.accountId })))
      .rejects.toThrow("a fenced transaction was opened inside a transaction the fence did not open");
  });

  it("CONTROL: inside a transaction fenced for the same account it carries the brand", async () => {
    const seen = await probe.open(ctxOn(db), (tx) =>
      probe.open(tx, async (inner) => [fencedAccountOf(inner.db), inTransactionHandle(inner.db)] as const,
        { accountId: user.accountId }), { accountId: user.accountId });
    expect(seen).toEqual([user.accountId, true]);
  });

  it("inside a transaction fenced for another account it is refused", async () => {
    const [other] = await db.insert(accounts).values({ name: "other" }).returning();
    await expect(probe.open(ctxOn(db), (tx) => probe.open(tx, async () => "ran", { accountId: other!.id }),
      { accountId: user.accountId })).rejects.toThrow("a transaction fenced for one account cannot open one fenced for another");
  });

  it("a stamp refuses 410 account_erased without running the body, or answers onErased", async () => {
    await db.update(accounts).set({ erasedAt: new Date() }).where(eq(accounts.id, user.accountId));
    let ran = false;
    const refused = await probe.open(ctxOn(db), async () => { ran = true; return "ran"; }, { accountId: user.accountId })
      .then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(ServiceError);
    expect([(refused as ServiceError).code, (refused as ServiceError).httpStatus]).toEqual(["account_erased", 410]);
    expect(await probe.open(ctxOn(db), async () => { ran = true; return "ran"; },
      { accountId: user.accountId, onErased: () => "nothing to do" })).toBe("nothing to do");
    expect(ran, "the body never runs on a stamp").toBe(false);
  });

  it("CONTROL: the handle it hands out is a fenced transaction; the pool is neither", async () => {
    const seen = await probe.open(ctxOn(db), async (tx) => [fencedAccountOf(tx.db), inTransactionHandle(tx.db)] as const,
      { accountId: user.accountId });
    expect(seen).toEqual([user.accountId, true]);
    expect([fencedAccountOf(db), inTransactionHandle(db)]).toEqual([undefined, false]);
  });
});
