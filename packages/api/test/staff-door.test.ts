import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { accounts, bindDb, bindingOf, mailboxes } from "@trafficflow/db";
import { doorDb } from "../src/context.js";
import { staffActOn, staffDb } from "../src/staff-audit.js";
import type { ApiDeps } from "../src/deps.js";
import { makeDeps } from "./helpers.js";

/**
 * THE STAFF DOOR, AND AN ACT THROUGH IT ON ONE ACCOUNT.
 *
 * A staff route reaches the operators' own tables on a handle that names no account and carries
 * the door's word. When staff act on a customer's account, the id the operator typed only finds a
 * row; the act runs on a handle bound to the account that row carries. Neither handle is ever made
 * over a request that a customer's session bound.
 */

let base: ApiDeps;
let accountId = "";
let otherAccountId = "";
let mailboxId = "";

beforeAll(async () => {
  ({ deps: base } = await makeDeps());
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
