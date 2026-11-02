import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, accountSettings, contacts, LIST_ADDRESSES_PER_ACCOUNT_MAX, listAddresses, listBrandsOf, mailboxes, messageBodies,
  messages, type Tx,
} from "@trafficflow/db";
import { createLogger } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { listAddressBackfillPass } from "../src/list-address-backfill.js";

/**
 * THE LIST-ADDRESS BACKFILL (mail 0150), on the in-process store (PGlite here, the device's SQLite
 * in the `sqlite` project): every stored message's `List-Post` that did not fail authentication,
 * through the one parser, recorded once, then the stamp. A second run reads nothing, and mail
 * stored after the stamp is ingest's. It writes no contact.
 */
async function world() {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `lb-${accountId.slice(0, 8)}` });
  await db.insert(accountSettings).values({ accountId });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@own.invalid`, status: "connected",
  }).returning();
  let n = 0;
  const stored = async (headers: Record<string, string[]>, auth: string | null = null) => {
    n += 1;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `lb:${randomUUID()}`, subject: `m${n}`,
      fromAddress: `sender${n}@elsewhere.invalid`, authVerdict: auth, nativeLocator: { folder: "INBOX", ref: `1:${n}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "hi", headers });
  };
  const rows = async () => (await db.select({ address: listAddresses.address, brands: listAddresses.consentedBrands })
    .from(listAddresses).where(eq(listAddresses.accountId, accountId)))
    .map((r) => ({ address: r.address, brands: listBrandsOf(r.brands) }))
    .sort((a, b) => a.address.localeCompare(b.address));
  const stamp = async () => (await db.select({ at: accountSettings.listAddressesScannedAt }).from(accountSettings)
    .where(eq(accountSettings.accountId, accountId)))[0]?.at ?? null;
  const contactCount = async () => (await db.select({ a: contacts.address }).from(contacts)
    .where(and(eq(contacts.accountId, accountId)))).length;
  return { db, accountId, stored, rows, stamp, contactCount, me: `me-${accountId.slice(0, 8)}@own.invalid` };
}

describe("the list-address backfill", () => {
  it("ACCEPTANCE 1j: records every list address once, stamps, and a second run changes nothing", async () => {
    const w = await world();
    await w.stored({ "list-post": ["<mailto:list@lists.invalid>"] });
    await w.stored({ "list-post": ["<mailto:list@lists.invalid>"] });
    await w.stored({ "list-post": ["<mailto:Club@Lists.invalid?subject=post>"] });
    await w.stored({ "list-post": ["NO"] });
    await w.stored({ "list-post": ["<mailto:forged@lists.invalid>"] }, "fail");
    await w.stored({ "subject": ["no list here"] });

    const first = await listAddressBackfillPass(w.db, { accountId: w.accountId });
    expect(first.ran).toBe(true);
    expect(await w.rows()).toEqual([
      { address: "club@lists.invalid", brands: [] }, { address: "list@lists.invalid", brands: [] },
    ]);
    expect(await w.stamp(), "the stamp is written LAST").not.toBeNull();
    expect(await w.contactCount(), "a header is never a contact").toBe(0);

    await w.stored({ "list-post": ["<mailto:later@lists.invalid>"] });
    const second = await listAddressBackfillPass(w.db, { accountId: w.accountId });
    expect(second).toEqual({ ran: false, values: 0, addresses: 0 });
    expect((await w.rows()).map((r) => r.address), "mail stored after the stamp is ingest's").toEqual([
      "club@lists.invalid", "list@lists.invalid",
    ]);
  });

  it("an account with no list mail is stamped too, so the next tail reads one row and stops", async () => {
    const w = await world();
    await w.stored({ "subject": ["nothing"] });
    const r = await listAddressBackfillPass(w.db, { accountId: w.accountId });
    expect(r).toEqual({ ran: true, values: 0, addresses: 0 });
    expect(await w.stamp()).not.toBeNull();
  });

  it("its line through the real logger keeps both counts and names no address", async () => {
    const w = await world();
    await w.stored({ "list-post": ["<mailto:list@lists.invalid>"] });
    await w.stored({ "list-post": ["<mailto:club@lists.invalid>"] });
    const raw: string[] = [];
    await listAddressBackfillPass(w.db, {
      accountId: w.accountId, log: createLogger({ service: "worker", sink: (l) => { raw.push(l); } }),
    });
    const lines = raw.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "list_address_backfill");
    expect(lines.map((l) => [l.scanned, l.written, l.droppedFields])).toEqual([[2, 2, undefined]]);
    expect(raw.join("\n")).not.toContain("lists.invalid");
  });

  it("LOW-4: a List-Post naming the account's own address is never recorded (the store's own door)", async () => {
    const w = await world();
    await w.stored({ "list-post": [`<mailto:${w.me}>`] });
    await w.stored({ "list-post": ["<mailto:list@lists.invalid>"] });
    await listAddressBackfillPass(w.db, { accountId: w.accountId });
    expect((await w.rows()).map((r) => r.address)).toEqual(["list@lists.invalid"]);
  });

  it("an address already recorded keeps the brands a press consented there", async () => {
    const w = await world();
    await w.db.insert(listAddresses).values({ accountId: w.accountId, address: "list@lists.invalid", consentedBrands: ["PostFinance"] });
    await w.stored({ "list-post": ["<mailto:list@lists.invalid>"] });
    await listAddressBackfillPass(w.db, { accountId: w.accountId });
    expect(await w.rows()).toEqual([{ address: "list@lists.invalid", brands: ["PostFinance"] }]);
  });
});

describe("an account's list addresses stop growing at the ceiling (the store's own door)", () => {
  /** `count` rows the account already holds, last seen at the epoch. */
  async function holding(w: Awaited<ReturnType<typeof world>>, count: number): Promise<void> {
    const rows = Array.from({ length: count }, (_, i) => ({
      accountId: w.accountId, address: `held${String(i).padStart(4, "0")}@lists.invalid`, lastSeenAt: new Date(0),
    }));
    for (let at = 0; at < rows.length; at += 250) await w.db.insert(listAddresses).values(rows.slice(at, at + 250));
  }
  const record = (w: Awaited<ReturnType<typeof world>>, addresses: string[]) =>
    makeDrizzleRepo(w.db as never).recordListAddresses(w.accountId, addresses);
  const seenAt = async (w: Awaited<ReturnType<typeof world>>, address: string) => (await w.db.select({ at: listAddresses.lastSeenAt })
    .from(listAddresses).where(and(eq(listAddresses.accountId, w.accountId), eq(listAddresses.address, address))))[0]?.at ?? null;

  it("past it a fresh address nobody consented to is not recorded; one the person wrote to is, and a known one is seen again", async () => {
    const w = await world();
    await holding(w, LIST_ADDRESSES_PER_ACCOUNT_MAX);
    // The person's Sent copy taught the address it went to as a person's contact.
    await w.db.insert(contacts).values({ accountId: w.accountId, address: "wrote@lists.invalid", source: "person" });
    await record(w, ["forged@lists.invalid", "wrote@lists.invalid", "held0000@lists.invalid"]);
    const held = new Set((await w.rows()).map((r) => r.address));
    expect(held.has("forged@lists.invalid"), "a forged header grew the account past its ceiling").toBe(false);
    expect(held.has("wrote@lists.invalid"), "an address the person wrote to is a list fact past the ceiling").toBe(true);
    expect(held.size).toBe(LIST_ADDRESSES_PER_ACCOUNT_MAX + 1);
    expect((await seenAt(w, "held0000@lists.invalid"))!.getTime(), "a known address was not seen again").toBeGreaterThan(0);
  });

  it("CONTROL: under it fresh addresses are recorded up to the ceiling, in order", async () => {
    const w = await world();
    await holding(w, LIST_ADDRESSES_PER_ACCOUNT_MAX - 1);
    await record(w, ["a-new@lists.invalid", "b-new@lists.invalid"]);
    const held = new Set((await w.rows()).map((r) => r.address));
    expect([held.has("a-new@lists.invalid"), held.has("b-new@lists.invalid")]).toEqual([true, false]);
  });
});
