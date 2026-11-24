import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, contacts, learningSignals, mailboxes, type Tx } from "@trafficflow/db";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { Logger } from "@trafficflow/core/mail";
import { markLegacyActContacts, senderCheckBackfillPass } from "../src/sender-check-backfill.js";

/**
 * THE ACT'S CONTACTS FROM BEFORE THE COLUMN ARE INFERRED (mail 0148). A contact
 * the act on suggestions wrote before `contacts.source` existed reads NULL, a person's; the cycle
 * tail marks inferred each one whose every Screener decision came from the act, and writes person
 * — the reading NULL had — on every other contact it examined, so none is read twice. A stated
 * source is never touched. It logs a count, moves no mail, and a second run finds nothing.
 */
const ACT = "screener:auto:";

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `lac-${accountId.slice(0, 8)}` });
  await db.insert(mailboxes).values({ accountId, provider: "imap", address: "me@lac.invalid" });
  const contact = (address: string, source: "person" | "inferred" | null) =>
    db.insert(contacts).values({ accountId, address, source });
  const decided = (address: string, trigger: string) => db.insert(learningSignals).values({
    accountId, triggeringActionId: `${trigger}${randomUUID()}`, kind: "screener",
    senderAddress: address, destination: "INBOX", label: "positive",
  });
  const sourceOf = async (address: string) => (await db.select({ s: contacts.source }).from(contacts)
    .where(and(eq(contacts.accountId, accountId), eq(contacts.address, address))))[0]!.s;
  const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const log = { info: (event: string, fields: Record<string, unknown>) => { lines.push({ event, fields }); } } as unknown as Logger;
  const pass = () => senderCheckBackfillPass(db as unknown as Tx, { accountId, log });
  return { db, accountId, contact, decided, sourceOf, lines, pass };
}

describe("the act's contacts from before the column", () => {
  it("marks the act-only contact inferred and every other examined one person, logs the count, and a second run finds nothing", async () => {
    const w = await world();
    await w.contact("act@karten-service.test", null);
    await w.decided("act@karten-service.test", ACT);
    await w.contact("pressed@firma.test", null);
    await w.decided("pressed@firma.test", ACT);
    await w.decided("pressed@firma.test", "screener:");
    await w.contact("quiet@firma.test", null);
    await w.contact("stated@firma.test", "person");
    await w.decided("stated@firma.test", ACT);

    await w.pass();
    expect(await w.sourceOf("act@karten-service.test")).toBe("inferred");
    expect(await w.sourceOf("pressed@firma.test")).toBe("person");
    expect(await w.sourceOf("quiet@firma.test")).toBe("person");
    expect(await w.sourceOf("stated@firma.test")).toBe("person");
    expect(w.lines.filter((l) => l.event === "act_contacts_inferred").map((l) => l.fields.count)).toEqual([1]);
    const known = await makeDrizzleRepo(w.db as never).knownSenders(w.accountId);
    expect(known.inferred.has("act@karten-service.test")).toBe(true);

    await w.pass();
    expect(w.lines.filter((l) => l.event === "act_contacts_inferred")).toHaveLength(1);
    const left = await w.db.select({ id: contacts.id }).from(contacts)
      .where(and(eq(contacts.accountId, w.accountId), isNull(contacts.source)));
    expect(left).toEqual([]);
  });

  it("examines a NULL contact once: a second call finds no row left to read", async () => {
    const w = await world();
    for (let i = 0; i < 30; i++) {
      await w.contact(`p${i}@firma.test`, null);
      await w.decided(`p${i}@firma.test`, i % 3 === 0 ? ACT : "screener:");
    }
    expect(await markLegacyActContacts(w.db as unknown as Tx, { accountId: w.accountId, batch: 50 })).toBe(10);
    expect(await markLegacyActContacts(w.db as unknown as Tx, { accountId: w.accountId, batch: 50 })).toBe(0);
    const sources = await w.db.select({ s: contacts.source }).from(contacts).where(eq(contacts.accountId, w.accountId));
    expect(sources.filter((r) => r.s === null)).toEqual([]);
    expect(sources.filter((r) => r.s === "inferred")).toHaveLength(10);
  });
});
