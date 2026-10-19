import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { messages } from "@trafficflow/db";
import { SearchService } from "../src/index.js";
import { makeCtx, otherAccount, seedMessage } from "./helpers.js";

/**
 * THE ADDRESS ARM BY RECIPIENT, on whichever store the project runs: PGlite (the desktop's store,
 * mail 0154's expression index) and SQLite (the phone's, 0154's side table kept by triggers). `to`
 * is To and Cc, case-folded, each message once; `any` is that and the From half; the account
 * scopes both. `from` is the positive control: its answer does not move.
 */
type Addr = { name: string | null; address: string };

async function corpus() {
  const w = await makeCtx(new Date("2026-08-01T12:00:00Z"));
  const at = (d: number) => new Date(Date.UTC(2026, 6, d, 9));
  const seed = async (
    accountId: string, mailboxId: string, o: { from: string; to?: unknown[]; cc?: unknown[]; day: number },
  ): Promise<string> => {
    const id = await seedMessage(w.db, accountId, mailboxId, { from: o.from, folder: "INBOX", date: at(o.day) });
    await w.db.update(messages).set({
      toAddresses: (o.to ?? []) as Addr[], ccAddresses: (o.cc ?? []) as Addr[],
    }).where(eq(messages.id, id));
    return id;
  };
  const sent = await seed(w.accountId, w.mailboxId, { from: "info@acme.test", day: 10 });
  const toHer = await seed(w.accountId, w.mailboxId, {
    from: "bob@acme.test", to: [{ name: null, address: "Info@ACME.test" }], cc: [{ name: null, address: "info@acme.test" }], day: 12,
  });
  const ccHer = await seed(w.accountId, w.mailboxId, { from: "carol@acme.test", cc: [{ name: "Info", address: "INFO@acme.test" }], day: 8 });
  const near = await seed(w.accountId, w.mailboxId, { from: "dan@acme.test", to: [{ name: null, address: "info@acme.test.evil" }], day: 11 });
  const b = await otherAccount(w.db);
  const theirs = await seed(b.accountId, b.mailboxId, { from: "eve@acme.test", to: [{ name: null, address: "info@acme.test" }], day: 13 });
  return { ...w, b, sent, toHer, ccHer, near, theirs };
}

const ids = (r: { items: Array<{ id: string }> }) => r.items.map((m) => m.id);

describe("searchByAddress answers `to` and `any` on this store", () => {
  it("`to` is To and Cc, case-folded, once each, newest first, and never the sender half", async () => {
    const c = await corpus();
    const r = await new SearchService().searchByAddress(c.ctx, { address: "info@acme.test", direction: "to" });
    expect(ids(r)).toEqual([c.toHer, c.ccHer]);
    expect(r.total).toBe(2);
    expect(r.direction).toBe("to");
  });

  it("`any` is the union, each message once", async () => {
    const c = await corpus();
    const r = await new SearchService().searchByAddress(c.ctx, { address: "INFO@acme.TEST", direction: "any" });
    expect(ids(r)).toEqual([c.toHer, c.sent, c.ccHer]);
    expect(r.total).toBe(3);
    expect(r.direction).toBe("any");
  });

  it("the account scopes both directions: another account's mail to the same address stays its own", async () => {
    const c = await corpus();
    const svc = new SearchService();
    for (const direction of ["to", "any"] as const) {
      expect(ids(await svc.searchByAddress(c.ctx, { address: "info@acme.test", direction }))).not.toContain(c.theirs);
    }
    const theirs = { ...c.ctx, accountId: c.b.accountId };
    expect(ids(await svc.searchByAddress(theirs, { address: "info@acme.test", direction: "to" }))).toEqual([c.theirs]);
    expect(ids(await svc.searchByAddress(theirs, { address: "info@acme.test", direction: "any" }))).toEqual([c.theirs]);
  });

  it("an equality, a blank address answers empty, and `limit` leaves `total` alone", async () => {
    const c = await corpus();
    const svc = new SearchService();
    for (const q of ["info@acme.tes", "acme.test", "info", "%info@acme.test%"]) {
      expect((await svc.searchByAddress(c.ctx, { address: q, direction: "to" })).total).toBe(0);
    }
    expect(ids(await svc.searchByAddress(c.ctx, { address: "info@acme.test.evil", direction: "to" }))).toEqual([c.near]);
    expect(await svc.searchByAddress(c.ctx, { address: " ", direction: "any" })).toEqual({ items: [], total: 0, direction: "any" });
    const one = await svc.searchByAddress(c.ctx, { address: "info@acme.test", direction: "any", limit: 1 });
    expect(ids(one)).toEqual([c.toHer]);
    expect(one.total).toBe(3);
  });

  it("CONTROL: `from` answers what it answered before", async () => {
    const c = await corpus();
    const r = await new SearchService().searchByAddress(c.ctx, { address: "info@acme.test", direction: "from" });
    expect(ids(r)).toEqual([c.sent]);
    expect(r.total).toBe(1);
    expect(r.direction).toBe("from");
  });

  it("odd recipient entries store fine and match nothing; 254 characters is the bound", async () => {
    const c = await corpus();
    const long = (n: number) => `${"x".repeat(n - "@acme.test".length)}@acme.test`;
    const odd = await seedMessage(c.db, c.accountId, c.mailboxId, { from: "odd@acme.test", folder: "INBOX" });
    await c.db.update(messages).set({
      toAddresses: ["info@acme.test", { name: "no address" }, { name: null, address: long(300) }, { name: null, address: long(3000) }] as never,
      ccAddresses: [{ name: null, address: long(254) }],
    }).where(eq(messages.id, odd));
    const svc = new SearchService();
    expect(ids(await svc.searchByAddress(c.ctx, { address: "info@acme.test", direction: "to" }))).not.toContain(odd);
    expect((await svc.searchByAddress(c.ctx, { address: long(300), direction: "to" })).total).toBe(0);
    expect((await svc.searchByAddress(c.ctx, { address: long(3000), direction: "to" })).total).toBe(0);
    expect(ids(await svc.searchByAddress(c.ctx, { address: long(254), direction: "to" }))).toEqual([odd]);
  });
});
