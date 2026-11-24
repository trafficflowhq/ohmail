import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, bindDb, bindingOf, carryBinding, mailboxes } from "@trafficflow/db";
import { staffAuditEvents } from "@trafficflow/db/cloud";
import type { Db } from "@trafficflow/services";
import { doorDb } from "../src/context.js";
import { recordStaffEvents, staffActOn, staffDb, type StaffEventInput } from "../src/staff-audit.js";
import type { ApiDeps } from "../src/deps.js";
import { FIXED_NOW, makeDeps, seedStaffSession } from "./helpers.js";

/**
 * THE STAFF DOOR, AND AN ACT THROUGH IT ON ONE ACCOUNT.
 *
 * A staff route reaches the operators' own tables on a handle that names no account and carries
 * the door's word. When staff act on a customer's account, the id the operator typed only finds a
 * row; the act runs on a handle bound to the account that row carries. Neither handle is ever made
 * over a request that a customer's session bound.
 */

let base: ApiDeps;
/** The store's own handle: what a host mints over, and what no route holds. */
let plain: Db;
let staffId = "";
let accountId = "";
let otherAccountId = "";
let mailboxId = "";

beforeAll(async () => {
  ({ deps: base, db: plain } = await makeDeps());
  ({ staffId } = await seedStaffSession(plain, { now: FIXED_NOW }));
  const [a] = await base.db.insert(accounts).values({ name: "Acme Ltd" }).returning();
  const [b] = await base.db.insert(accounts).values({ name: "Other Ltd" }).returning();
  accountId = a!.id;
  otherAccountId = b!.id;
  const [mb] = await base.db.insert(mailboxes).values({ accountId, provider: "imap", address: "door@example.test" }).returning();
  mailboxId = mb!.id;
});

/** A request's container as a host builds it: the handle minted bound to nothing. */
const minted = (over: Partial<ApiDeps> = {}): ApiDeps => ({ ...base, db: bindDb(base.db, { account: null }), ...over });

describe("staffDb: the staff door's handle", () => {
  it("names no account and carries a key", () => {
    expect(bindingOf(staffDb(minted()))).toEqual({ account: null, keyed: true });
  });

  it("leaves the request's own handle as its host minted it", () => {
    const deps = minted();
    const before = deps.db;
    staffDb(deps);
    expect(deps.db).toBe(before);
    expect(bindingOf(deps.db)).toEqual({ account: null, keyed: false });
  });

  it("is refused on a request bound to a customer's account: the door's word never rides beside a session", () => {
    const deps = minted();
    deps.db = bindDb(deps.db, { account: accountId });
    expect(() => staffDb(deps)).toThrow(expect.objectContaining({ code: "binding_refused" }));
  });

  it("is refused on a handle that already carries a key", () => {
    const deps = minted();
    deps.db = bindDb(deps.db, { account: null, key: "a-token's-digest" });
    expect(() => staffDb(deps)).toThrow(expect.objectContaining({ code: "binding_refused" }));
  });

  it("reads through to the store: a staff route's statements run on it", async () => {
    const rows = await staffDb(minted()).select({ id: accounts.id }).from(accounts);
    expect(rows.map((r) => r.id).sort()).toEqual([accountId, otherAccountId].sort());
  });
});

describe("staffActOn: the account a staff act runs for is the target row's", () => {
  it("a mailbox the operator names binds the account its row carries", async () => {
    const act = await staffActOn(minted(), { mailboxId });
    expect(act).not.toBeNull();
    expect(act!.accountId).toBe(accountId);
    expect(bindingOf(act!.db)).toEqual({ account: accountId, keyed: false });
  });

  it("an account the operator names binds its row's own id, also when it was typed in upper case", async () => {
    for (const typed of [accountId, accountId.toUpperCase()]) {
      const act = await staffActOn(minted(), { accountId: typed });
      expect(act!.accountId).toBe(accountId);
      expect(bindingOf(act!.db)?.account).toBe(accountId);
    }
  });

  it("an id no row answers binds nothing", async () => {
    expect(await staffActOn(minted(), { mailboxId: randomUUID() })).toBeNull();
    expect(await staffActOn(minted(), { accountId: randomUUID() })).toBeNull();
    // A mailbox's id is no account's, and an account's id is no mailbox's.
    expect(await staffActOn(minted(), { accountId: mailboxId })).toBeNull();
    expect(await staffActOn(minted(), { mailboxId: accountId })).toBeNull();
  });

  it("the act's handle carries no key: the door's word stays at the door", async () => {
    const act = await staffActOn(minted(), { accountId });
    expect(bindingOf(act!.db)?.keyed).toBe(false);
  });

  it("is refused on a request bound to a customer's account", async () => {
    const deps = minted();
    deps.db = bindDb(deps.db, { account: otherAccountId });
    await expect(staffActOn(deps, { accountId })).rejects.toMatchObject({ code: "binding_refused" });
  });

  it("the door without an account is the request's handle as minted, and is spent once a session bound it", () => {
    const deps = minted();
    expect(bindingOf(doorDb(deps))).toEqual({ account: null, keyed: false });
    deps.db = bindDb(deps.db, { account: accountId });
    expect(() => doorDb(deps)).toThrow(expect.objectContaining({ code: "binding_refused" }));
  });
});

describe("recordStaffEvents: the operators' trail is written at the staff door and on no other handle", () => {
  const event = (): StaffEventInput => ({
    requestId: randomUUID(), at: FIXED_NOW, action: "staff.stepup", outcome: "ok",
    actor: { staffId, sessionId: null, email: "operator@example.test", roles: ["support"] },
  });
  const written = async (e: StaffEventInput): Promise<number> =>
    (await plain.select({ id: staffAuditEvents.id }).from(staffAuditEvents).where(eq(staffAuditEvents.requestId, e.requestId))).length;

  it("writes on the staff door's handle", async () => {
    const e = event();
    await recordStaffEvents(staffDb(minted()), [e]);
    expect(await written(e)).toBe(1);
  });

  it("writes inside a transaction the staff door's handle opened: the act's event commits with the act", async () => {
    const e = event();
    const door = staffDb(minted());
    await door.transaction(async (tx) => { await recordStaffEvents(carryBinding(door, tx), [e]); });
    expect(await written(e)).toBe(1);
    // And leaves with it: nothing of a transaction that rolled back stays on the trail.
    const gone = event();
    await expect(door.transaction(async (tx) => {
      await recordStaffEvents(carryBinding(door, tx), [gone]);
      throw new Error("the act failed");
    })).rejects.toThrow("the act failed");
    expect(await written(gone)).toBe(0);
  });

  it("is refused on a customer's handle and inside a customer's transaction, and writes nothing there", async () => {
    const bound = bindDb(plain, { account: accountId });
    const direct = event();
    // @ts-expect-error — the type refuses it too; the case is what happens at run time
    await expect(recordStaffEvents(bound, [direct])).rejects.toMatchObject({ code: "binding_refused" });
    const inside = event();
    // @ts-expect-error — the type refuses it too; the case is what happens at run time
    await expect(bound.transaction(async (tx) => { await recordStaffEvents(tx, [inside]); }))
      .rejects.toMatchObject({ code: "binding_refused" });
    expect(await written(direct)).toBe(0);
    expect(await written(inside)).toBe(0);
  });

  it("is refused without the door's word: the request's handle as minted, and the store's own", async () => {
    for (const handle of [minted().db, plain]) {
      const e = event();
      // @ts-expect-error — the type refuses it too; the case is what happens at run time
      await expect(recordStaffEvents(handle, [e])).rejects.toMatchObject({ code: "binding_refused" });
      expect(await written(e)).toBe(0);
      // A transaction on such a handle carries no more than the handle does.
      const inside = event();
      // @ts-expect-error — the type refuses it too; the case is what happens at run time
      await expect((handle as Db).transaction(async (tx) => { await recordStaffEvents(tx, [inside]); }))
        .rejects.toMatchObject({ code: "binding_refused" });
      expect(await written(inside)).toBe(0);
    }
  });

  it("refuses the handle before it reads the rows: an empty list on a customer's handle is refused too", async () => {
    // @ts-expect-error — the type refuses it too; the case is what happens at run time
    await expect(recordStaffEvents(bindDb(plain, { account: accountId }), [])).rejects.toMatchObject({ code: "binding_refused" });
    await expect(recordStaffEvents(staffDb(minted()), [])).resolves.toBeUndefined();
  });

  it("names no account and no key in its refusal", async () => {
    // @ts-expect-error — the type refuses it too; the case is what happens at run time
    const refusal = await recordStaffEvents(bindDb(plain, { account: accountId }), [event()]).then(() => null, (err: Error) => err);
    expect(refusal?.message).toContain("not the staff door's");
    expect(refusal?.message).not.toContain(accountId);
  });
});
