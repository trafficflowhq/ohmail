import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drafts, messageInvitations, outboundSends } from "@trafficflow/db";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { answerInvitation } from "../src/invitation-answer-service.js";
import { dbFor, type ServiceContext } from "../src/context.js";
import { invitationLetter, mailboxAt, outbox, stampOf } from "./_invitation-answer.js";

/**
 * TWO DEVICES PRESS AT ONCE, ON REAL POSTGRES: two connections, each its own transactions, the way
 * a phone and a desktop reach one server. The same answer pressed on both is one letter, whichever
 * wins the draft and whichever the reservation; two different answers are two letters whose stamps
 * order them, and the row ends on the later one. PGlite runs one connection and cannot show this.
 */
const PG_UP = await realPgAvailable();

/** A pool of the factory's, named by its address (a parameter of the address is one of the connection). */
const conn = (name: string) => {
  const address = new URL(PG_TEST_URL);
  address.searchParams.set("application_name", name);
  return makeOwnedDb(address.toString());
};
const ownedA = conn("invitation-answer-a");
const ownedB = conn("invitation-answer-b");
const dbA = ownedA.db;
const dbB = ownedB.db;

const NOW = new Date("2026-11-15T09:30:00.000Z");

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await Promise.all([ownedA.close(), ownedB.close()]); });

async function world() {
  const accountId = randomUUID();
  const address = `mila-${accountId.slice(0, 8)}@lichtgrat.example`;
  const mailboxId = await mailboxAt(dbA, accountId, address);
  const messageId = await invitationLetter(dbA, accountId, mailboxId, { attendees: [address] });
  const box = outbox();
  const ctx = (db: typeof dbA, id: string): ServiceContext => ({ db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: id });
  const press = (db: typeof dbA, answer: string, key: string) =>
    answerInvitation(ctx(db, key), { messageId, answer, basis: null, key }, { send: { openSendAdapter: box.factory } });
  return { accountId, messageId, box, press };
}

describe.skipIf(!PG_UP)("two devices pressing at once", () => {
  it("the same answer on both is one letter, one draft, one reservation sent", async () => {
    for (let round = 0; round < 6; round++) {
      const w = await world();
      const outs = await Promise.all([w.press(dbA, "accepted", `phone-${round}`), w.press(dbB, "accepted", `desk-${round}`)]);
      expect(w.box.sent, `round ${round}`).toHaveLength(1);
      expect(outs.map((o) => o.result.status), `round ${round}`).toContain("sent");
      expect(await dbA.select().from(drafts).where(eq(drafts.accountId, w.accountId))).toHaveLength(1);
      const sends = await dbA.select().from(outboundSends).where(eq(outboundSends.accountId, w.accountId));
      expect(sends.filter((s) => s.status === "sent"), `round ${round}`).toHaveLength(1);
    }
  });

  it("two different answers at once are two letters, stamped apart, and the row ends on the later", async () => {
    const w = await world();
    await Promise.all([w.press(dbA, "accepted", "phone"), w.press(dbB, "declined", "desk")]);
    expect(w.box.sent).toHaveLength(2);
    const [a, b] = w.box.sent.map((m) => ({ stamp: stampOf(m.calendar!.text), partstat: /PARTSTAT=(\w+)/.exec(m.calendar!.text)![1] }));
    expect(a!.stamp).not.toBe(b!.stamp);
    const later = a!.stamp > b!.stamp ? a! : b!;
    const [row] = await dbA.select().from(messageInvitations).where(eq(messageInvitations.messageId, w.messageId));
    expect([row!.answer?.toUpperCase(), row!.answeredAt?.getTime()]).toEqual([later.partstat, later.stamp]);
  });

  it("another account's letter is the missing letter's 404, and nothing is made", async () => {
    const w = await world();
    const stranger = randomUUID();
    const err = await answerInvitation(
      { db: dbFor(dbB, stranger), accountId: stranger, userId: null, now: () => NOW, requestId: "x" },
      { messageId: w.messageId, answer: "accepted", basis: null, key: "k" }, { send: { openSendAdapter: w.box.factory } },
    ).then(() => null, (e: unknown) => e as { code?: string; httpStatus?: number });
    expect([err?.code, err?.httpStatus]).toEqual(["not_found", 404]);
    expect(w.box.sent).toHaveLength(0);
    expect(await dbA.select().from(drafts).where(eq(drafts.accountId, w.accountId))).toEqual([]);
  });
});
