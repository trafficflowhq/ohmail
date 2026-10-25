import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { accounts, auditAction, auditLog, mailboxCredentials, mailboxes, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { agreeRecordedAt } from "@trafficflow/core/adapters/drizzle-repo";
import { makeMailboxService } from "../src/mailbox-service.js";
import type { ServiceContext } from "../src/context.js";

/**
 * THE AGREE RECORD — what lets the organizer tell a person's first agree from every other press.
 * `organizeHere` writes it in the consent transaction, at the stamp's own instant, only when the press
 * came from the window step (`screenBacklog`) AND this is the first consent. A claim-back over an
 * earlier consent, and a press from a door that stated no rule, leave no record, so their stamps sweep
 * nothing (`agreeSweepSlice`).
 */

const NOW = new Date("2026-10-09T14:00:00.000Z");
const LATER = new Date("2026-10-09T15:00:00.000Z");

async function reader() {
  const pglite = await makeTestDb();
  const tx = pglite as unknown as Tx;
  const accountId = randomUUID();
  await tx.insert(accounts).values({ id: accountId, name: "agree-record" });
  const [mb] = await tx.insert(mailboxes).values({
    accountId, provider: "imap", address: "fresh@example.test", organizerRole: "reader", organizeConsentedAt: null,
  }).returning();
  await tx.insert(mailboxCredentials).values({
    mailboxId: mb!.id, transport: "imap", secretEnc: "not-a-real-secret", keyVersion: 1,
  });
  const svc = makeMailboxService({ allowance: async () => { /* permitted */ } });
  const ctxAt = (now: Date): ServiceContext => ({
    db: pglite as unknown as ServiceContext["db"], accountId, userId: null, now: () => now, requestId: "r",
  });
  const records = async () => tx.select({ at: auditLog.createdAt, payload: auditLog.payload }).from(auditLog)
    .where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, auditAction("organizer.agree_screens_backlog"))));
  const row = async () => (await tx.select({ c: mailboxes.organizeConsentedAt, s: mailboxes.takeoverAuthorizedAt })
    .from(mailboxes).where(eq(mailboxes.id, mb!.id)))[0]!;
  return { tx, svc, ctxAt, accountId, mailboxId: mb!.id, records, row };
}

describe("organizeHere — the agree record", () => {
  it("a first agree from the window step is recorded at the stamp's instant, and reads as an agree", async () => {
    const w = await reader();
    await w.svc.organizeHere(w.ctxAt(NOW), w.mailboxId, {
      intent: "join", screening: { dormancyDays: 365, scope: "window" }, screenBacklog: true,
    });
    const r = await w.row();
    expect(r.c).toEqual(NOW);
    expect(r.s).toEqual(NOW);
    // The window agreed to rides with the record: a later change of the dials never widens the sweep.
    const cutoff = new Date(NOW.getTime() - 365 * 86_400_000).toISOString();
    expect(await w.records()).toEqual([{ at: NOW, payload: { mailboxId: w.mailboxId, cutoff } }]);
    expect(await agreeRecordedAt(w.tx, { accountId: w.accountId, mailboxId: w.mailboxId, stamp: NOW })).toBe(true);
  });

  it("an agree to All time records no cutoff", async () => {
    const w = await reader();
    await w.svc.organizeHere(w.ctxAt(NOW), w.mailboxId, { intent: "join", screening: { scope: "all_time" }, screenBacklog: true });
    expect(await w.records()).toEqual([{ at: NOW, payload: { mailboxId: w.mailboxId, cutoff: null } }]);
  });

  it("CONTROL — a first consent from a press that stated no rule leaves no record", async () => {
    const w = await reader();
    await w.svc.organizeHere(w.ctxAt(NOW), w.mailboxId, { intent: "takeover" });
    expect(await w.records()).toEqual([]);
    expect(await agreeRecordedAt(w.tx, { accountId: w.accountId, mailboxId: w.mailboxId, stamp: NOW })).toBe(false);
  });

  it("a claim-back over an earlier consent writes no second record, and its stamp is no agree", async () => {
    const w = await reader();
    await w.svc.organizeHere(w.ctxAt(NOW), w.mailboxId, {
      intent: "join", screening: { dormancyDays: 365, scope: "window" }, screenBacklog: true,
    });
    // Another install took it: the row is a reader again, consent kept, the stamp spent.
    await w.tx.update(mailboxes).set({ organizerRole: "reader", takeoverAuthorizedAt: null })
      .where(eq(mailboxes.id, w.mailboxId));
    await w.svc.organizeHere(w.ctxAt(LATER), w.mailboxId, { intent: "takeover", screenBacklog: true });
    expect((await w.row()).s).toEqual(LATER);
    expect(await w.records()).toHaveLength(1);
    expect(await agreeRecordedAt(w.tx, { accountId: w.accountId, mailboxId: w.mailboxId, stamp: LATER })).toBe(false);
  });
});
