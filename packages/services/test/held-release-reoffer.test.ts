import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, folderState, mailboxes, messageBodies, messages, recordChange, rules, type Tx,
} from "@trafficflow/db";
import { dismissHeldRelease, heldReleaseSummary, releaseHeld } from "../src/held-release-service.js";
import type { ServiceContext } from "../src/context.js";

/**
 * "NOT NOW" HOLDS UNTIL NEW HELD MAIL ARRIVES — never because the set shrank.
 *
 * The dismissal named the set's fingerprint over (rule, destination, count), so a held message
 * filed by hand, deleted, or one group released on another device changed the fingerprint and
 * re-offered the rest. The dismissal now records the newest entry of the set it dismissed, and
 * the offer returns only for mail that joined the set after it: placed at the gate later, or
 * claimed by a decision written later. A dismissal over a set that moved since its read stays
 * offered, as before. "Later" is the account's change log, never a clock (HELD-OFFER-ANCHOR-READS-
 * TWO-CLOCKS): the fixture writes the change row every production placement and rule write does.
 */

const GATE = "ohmail/Screener";
const T = Date.parse("2026-09-25T14:00:00.000Z");
const at = (minutes: number) => new Date(T + minutes * 60_000);

async function seed() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `ro-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
    organizerRole: "organizer",
  }).returning();
  let tick = 0;
  let clock = T;
  const ctx: ServiceContext = {
    db: db as never, accountId, userId: null,
    now: () => new Date(clock + ++tick),
    requestId: `ro-${randomUUID().slice(0, 8)}`,
  };
  let n = 0;
  /** The change row a production writer records beside every placement and rule write. */
  const changed = (entityType: "message" | "rule", entityId: string, op: "create" | "move" | "update") =>
    db.transaction(async (tx) => { await recordChange(tx as never, { accountId, entityType, entityId, op, meta: null }); });
  /** A message from `from`, sitting in `folder` since `placed` minutes past T. */
  const message = async (from: string, placed: number, folder = GATE): Promise<string> => {
    const i = n++;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `ro:${randomUUID()}`,
      subject: `Note ${i}`, snippet: "", fromAddress: from, date: at(-600), unread: true,
      createdAt: at(-600), nativeLocator: { folder, ref: `1:${i}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: folder, observedFolder: folder,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false, updatedAt: at(placed),
    });
    await changed("message", m!.id, "create");
    return m!.id;
  };
  const rule = async (match: string, destination: string, created: number): Promise<string> => {
    const [r] = await db.insert(rules).values({
      accountId, kind: "sender", match, destination, provenance: "manual", enabled: true,
      priority: 0, retroRequestedAt: null, createdAt: at(created), updatedAt: at(created),
    }).returning();
    await changed("rule", r!.id, "create");
    return r!.id;
  };
  /** A person files one held message by hand in another client. */
  const fileByHand = async (id: string, minutes: number) => {
    await db.update(folderState).set({
      desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "external", updatedAt: at(minutes),
    }).where(eq(folderState.messageId, id));
  };
  const summary = () => heldReleaseSummary(db as unknown as Tx, accountId);
  const dismiss = async () => dismissHeldRelease(ctx, { fingerprint: (await summary()).fingerprint });
  const setClock = (minutes: number) => { clock = at(minutes).getTime(); };

  const a = [await message("a@x.test", -120), await message("a@x.test", -110), await message("a@x.test", -100)];
  const b = [await message("b@x.test", -90), await message("b@x.test", -80)];
  const ra = await rule("a@x.test", "INBOX", -1_000);
  const rb = await rule("b@x.test", "ohmail/News", -1_000);
  return { db, accountId, ctx, message, rule, fileByHand, summary, dismiss, setClock, changed, a, b, ra, rb };
}

describe("a dismissed held-mail offer comes back only for new held mail", () => {
  it("the positive control: a fresh set is offered, and dismissing it hides it", async () => {
    const w = await seed();
    expect((await w.summary()).dismissed).toBe(false);
    expect((await w.summary()).total).toBe(5);
    await w.dismiss();
    expect((await w.summary()).dismissed).toBe(true);
  });

  it("a held message filed by hand elsewhere does not bring the offer back", async () => {
    const w = await seed();
    await w.dismiss();
    w.setClock(10);
    await w.fileByHand(w.a[0]!, 10);
    const s = await w.summary();
    expect(s.total, "the set did shrink").toBe(4);
    expect(s.dismissed, "a shrink re-offered the rest").toBe(true);
  });

  it("a held message deleted does not bring the offer back", async () => {
    const w = await seed();
    await w.dismiss();
    await w.db.update(messages).set({ deletedAt: at(10) }).where(eq(messages.id, w.b[0]!));
    expect((await w.summary()).dismissed).toBe(true);
  });

  it("one group released on another device leaves the rest dismissed", async () => {
    const w = await seed();
    await w.dismiss();
    w.setClock(10);
    await releaseHeld(w.ctx, { ruleIds: [w.ra] });
    const s = await w.summary();
    expect(s.groups.map((g) => g.ruleId)).toEqual([w.rb]);
    expect(s.dismissed, "releasing one group re-offered the other").toBe(true);
  });

  it("new held mail placed at the gate after the dismissal re-offers", async () => {
    const w = await seed();
    await w.dismiss();
    await w.message("b@x.test", 10);
    expect((await w.summary()).dismissed).toBe(false);
  });

  it("one message out and one new in re-offers, although the count is the same", async () => {
    const w = await seed();
    await w.dismiss();
    await w.fileByHand(w.a[0]!, 10);
    await w.message("a@x.test", 11);
    const s = await w.summary();
    expect(s.total).toBe(5);
    expect(s.dismissed, "new held mail behind an unchanged count stayed hidden").toBe(false);
  });

  it("a decision written after the dismissal, claiming mail already at the gate, re-offers", async () => {
    const w = await seed();
    await w.message("c@x.test", -60);
    expect((await w.summary()).groups).toHaveLength(2);
    await w.dismiss();
    await w.rule("c@x.test", "INBOX", 10);
    const s = await w.summary();
    expect(s.groups).toHaveLength(3);
    expect(s.dismissed).toBe(false);
  });

  it("an API clock five minutes AHEAD of the organizer's hides nothing placed after the dismissal", async () => {
    const w = await seed();
    w.setClock(5);
    await w.dismiss();
    expect((await w.summary()).dismissed, "premise: the dismissal holds").toBe(true);
    // Two minutes later by the organizer's clock — three minutes BEFORE the API's "now".
    await w.message("a@x.test", 2);
    expect((await w.summary()).dismissed, "new held mail after the dismissal stayed hidden").toBe(false);
  });

  it("a legacy clock anchor is read as it was written until the next dismissal overwrites it", async () => {
    const w = await seed();
    const fp = (await w.summary()).fingerprint;
    await w.db.insert(accountSettings).values({ accountId: w.accountId, heldReleaseDismissed: `${fp}@${at(0).getTime()}` });
    expect((await w.summary()).dismissed).toBe(true);
    await w.message("a@x.test", 10);
    expect((await w.summary()).dismissed, "the legacy arm still sees mail stamped after it").toBe(false);
    await w.dismiss();
    const [row] = await w.db.select().from(accountSettings).where(eq(accountSettings.accountId, w.accountId));
    expect(row!.heldReleaseDismissed, "a new dismissal writes the sequence form").toMatch(/^v1-[0-9a-f]{16}#\d+$/);
  });

  it("a placement stamped by a clock ahead of this one is still covered by the dismissal", async () => {
    const w = await seed();
    await w.message("a@x.test", 1);
    w.setClock(0);
    await w.dismiss();
    expect((await w.summary()).dismissed).toBe(true);
  });

  it("a dismissal pressed over a set that moved since its read stays offered", async () => {
    const w = await seed();
    const shown = (await w.summary()).fingerprint;
    await w.message("b@x.test", -5);
    await dismissHeldRelease(w.ctx, { fingerprint: shown });
    expect((await w.summary()).dismissed).toBe(false);
  });

  it("a dismissal stored as a bare fingerprint still reads by equality", async () => {
    const w = await seed();
    const fp = (await w.summary()).fingerprint;
    await w.db.insert(accountSettings).values({ accountId: w.accountId, heldReleaseDismissed: fp });
    expect((await w.summary()).dismissed).toBe(true);
    await w.fileByHand(w.a[0]!, 10);
    expect((await w.summary()).dismissed).toBe(false);
  });

  it("a fingerprint the server never issued is refused", async () => {
    const w = await seed();
    await expect(dismissHeldRelease(w.ctx, { fingerprint: "v1-0000000000000000@9999999999999" }))
      .rejects.toMatchObject({ httpStatus: 400 });
    const [row] = await w.db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, w.accountId));
    expect(row?.heldReleaseDismissed ?? null).toBeNull();
  });
});
