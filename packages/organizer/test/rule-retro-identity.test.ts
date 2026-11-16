import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, contacts, folderState, mailboxes, messages, rules, type Tx } from "@trafficflow/db";
import { ruleRetroPass } from "../src/rule-retro.js";

/**
 * A NEW DOMAIN RULE NEVER CARRIES A HELD IDENTITY CLAIM INTO THE OHBOX (mail 0148, acceptance 7).
 * The pass rebuilds a message from its row with `name: null`, so a gate that read the display name
 * itself would see no claim here: the pass hands it the stored column (`identityOfRow`), and the
 * function for a row the ingest never checked. The domain is a brand-token lookalike, never a shared
 * provider, so the shared-provider rule (an allow rule on one admits nobody) is not what keeps it.
 */
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();
const NOW = new Date("2026-10-07T12:00:00Z");
const GATE = "ohmail/Screener";
const DOMAIN = "postfinance-sicherheit.invalid";

async function world(o: { personContact?: string; provenance?: "manual" | "promoted" } = {}) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `retro-id-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "me@retro-id.invalid" }).returning();
  const held = async (o: { fromName: string | null; senderCheck: string | null; brand?: string; from?: string; unconfirmed?: true }) => {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject: "Ihre Karte", fromAddress: o.from ?? `kundendienst@${DOMAIN}`, fromName: o.fromName,
      senderCheck: o.senderCheck, senderCheckBrand: o.brand ?? null,
      ...(o.unconfirmed ? { unconfirmedHold: true } : {}),
      nativeLocator: { folder: GATE, ref: "1:1" },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };
  await db.insert(rules).values({
    accountId, kind: "domain", match: DOMAIN, destination: "INBOX", provenance: o.provenance ?? "manual", enabled: true,
    retroRequestedAt: new Date("2026-10-07T10:00:00Z"),
  });
  if (o.personContact) await db.insert(contacts).values({ accountId, address: o.personContact, source: "person" });
  const desired = async (id: string) =>
    (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;
  const pass = () => ruleRetroPass(db as unknown as Tx, { accountId, trustedAuthservIdsFor: NONE }, NOW);
  return { held, desired, pass };
}

describe("rule-retro and the identity fact", () => {
  it("ACCEPTANCE: a held row the ingest marked stays held under a new allow domain rule", async () => {
    const w = await world();
    const marked = await w.held({ fromName: "PostFinance", senderCheck: "impersonation", brand: "PostFinance" });
    const r = await w.pass();
    expect(r.moved).toBe(0);
    expect(await w.desired(marked)).toBe(GATE);
  });

  it("a row the ingest never checked is computed, and held the same way", async () => {
    const w = await world();
    const unchecked = await w.held({ fromName: "PostFinance", senderCheck: null });
    await w.pass();
    expect(await w.desired(unchecked)).toBe(GATE);
  });

  it("CONTROL: a clean row under the same rule moves to the Ohbox", async () => {
    const w = await world();
    const clean = await w.held({ fromName: "Kundendienst Huber", senderCheck: "none", from: `huber@${DOMAIN}` });
    const r = await w.pass();
    expect(r.moved).toBe(1);
    expect(await w.desired(clean)).toBe("INBOX");
  });

  it("a letter held for want of confirmation (mail 0176) stays under a domain rule ohmail inferred; a person's contact lets the walk take it", async () => {
    const from = `service@${DOMAIN}`;
    const w = await world({ provenance: "promoted" });
    const held = await w.held({ fromName: "Kundendienst", senderCheck: "none", from, unconfirmed: true });
    expect((await w.pass()).moved).toBe(0);
    expect(await w.desired(held)).toBe(GATE);
    // CONTROL: the person skip — a person consented to the address, so the gate would not hold it now.
    const consented = await world({ provenance: "promoted", personContact: from });
    const released = await consented.held({ fromName: "Kundendienst", senderCheck: "none", from, unconfirmed: true });
    expect((await consented.pass()).moved).toBe(1);
    expect(await consented.desired(released)).toBe("INBOX");
  });

  it("under a domain rule the person wrote, the walk takes the letter held for want of confirmation, never a claim", async () => {
    const w = await world();
    const unconfirmed = await w.held({ fromName: "Kundendienst", senderCheck: "none", from: `service@${DOMAIN}`, unconfirmed: true });
    const claim = await w.held({ fromName: "PostFinance", senderCheck: "impersonation", brand: "PostFinance", unconfirmed: true });
    expect((await w.pass()).moved).toBe(1);
    expect([await w.desired(unconfirmed), await w.desired(claim)]).toEqual(["INBOX", GATE]);
  });
});
