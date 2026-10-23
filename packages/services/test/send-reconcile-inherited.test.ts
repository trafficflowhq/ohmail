import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drafts, mailboxes, outboundSendFingerprints, outboundSends } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { mintMessageId } from "@trafficflow/core/mail";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { runSendReconcilePass } from "../src/index.js";

/**
 * A RESERVATION AN EARLIER RUN LEFT PENDING IS DECIDED AT ONCE — the one exception to the stale
 * window, and only for the rows the caller names.
 *
 * The window exists because a young `pending` row may have a live attempt behind it. A desktop
 * engine holds its data directory alone (the lock), so the rows already `pending` when it opened
 * the store were left by a process that is gone: nothing can still be sending them. It names them,
 * and the pass takes them whatever their age; every other row keeps the window. Both stores: the
 * claim is one statement that runs on the device store as well.
 */

const NOW = new Date("2026-10-22T12:00:00.000Z");
const MIN = 60_000;

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `owner-${randomUUID().slice(0, 8)}@inherited.test`, status: "connected",
  }).returning();
  return { db, accountId, mailboxId: mb!.id };
}

async function pending(w: Awaited<ReturnType<typeof world>>, ageMs: number, offerState?: "unoffered" | "offered") {
  const minted = mintMessageId("inherited.test");
  const at = new Date(NOW.getTime() - ageMs);
  const [d] = await w.db.insert(drafts).values({
    accountId: w.accountId, mailboxId: w.mailboxId, subject: "pressed before the close", body: "words",
    to: [{ name: null, address: "you@example.com" }], status: "sending", createdAt: at, updatedAt: at,
  }).returning();
  const [s] = await w.db.insert(outboundSends).values({
    accountId: w.accountId, idempotencyKey: randomUUID(), draftId: d!.id,
    mintedMessageId: minted, status: "pending", createdAt: at, ...(offerState ? { offerState } : {}),
  }).returning();
  // An inline press's reservation holds its content claim, as `reserve` writes it.
  await w.db.insert(outboundSendFingerprints).values({
    accountId: w.accountId, mailboxId: w.mailboxId, fingerprint: randomUUID().replace(/-/g, "").repeat(2), sendId: s!.id,
  });
  return { sendId: s!.id, draftId: d!.id, minted };
}

function inSent() {
  const seen = { probed: [] as string[], delivered: [] as OutboundMessage[] };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) { seen.delivered.push(msg); return { providerMessageId: msg.messageId! }; },
    async messageInSent(id: string) { seen.probed.push(id); return true; },
    async close() { /* nothing */ },
  });
  return { factory, seen };
}

const status = async (w: Awaited<ReturnType<typeof world>>, id: string) =>
  (await w.db.select({ status: outboundSends.status }).from(outboundSends).where(eq(outboundSends.id, id)))[0]!.status;

describe("runSendReconcilePass — a reservation an earlier run left pending", () => {
  it("is taken at once when the caller names it; a row it does not name keeps the stale window", async () => {
    const w = await world();
    const left = await pending(w, 1 * MIN);       // the earlier run's, a minute old
    const ours = await pending(w, 1 * MIN);       // this run's own, just as young
    const spy = inSent();

    const r = await runSendReconcilePass(w.db, { openSendAdapter: spy.factory, now: () => NOW, inherited: [left.sendId] });

    expect(r.claimed).toBe(1);
    expect(r.sent).toBe(1);
    expect(spy.seen.probed).toEqual([left.minted]);
    expect(spy.seen.delivered, "the pass sent something").toHaveLength(0);
    expect(await status(w, left.sendId)).toBe("sent");
    expect(await status(w, ours.sendId), "a young row the caller did not name was taken").toBe("pending");
  });

  it("an inherited row that offered nothing is forgotten with no dial charged; an offered one is probed", async () => {
    const w = await world();
    const quiet = await pending(w, 1 * MIN, "unoffered");
    const spoke = await pending(w, 1 * MIN, "offered");
    let dials = 0;
    const spy = inSent();
    const counting: typeof spy.factory = async (id) => { dials += 1; return spy.factory(id); };

    const r = await runSendReconcilePass(w.db, {
      openSendAdapter: counting, now: () => NOW, inherited: [quiet.sendId, spoke.sendId], batch: 1,
    });

    expect({ claimed: r.claimed, forgotten: r.forgotten, sent: r.sent }).toEqual({ claimed: 2, forgotten: 1, sent: 1 });
    expect(spy.seen.probed, "only the offered row was looked for").toEqual([spoke.minted]);
    expect(dials, "the forget charged no login: the one slot went to the offered row").toBe(1);
    expect(spy.seen.delivered, "the pass sent something").toHaveLength(0);
    expect((await w.db.select().from(outboundSends).where(eq(outboundSends.id, quiet.sendId))).length).toBe(0);
    expect((await w.db.select({ s: drafts.status }).from(drafts).where(eq(drafts.id, quiet.draftId)))[0]!.s).toBe("draft");
  });

  it("CONTROL: with no names the window is today's, and a named row already decided is not taken again", async () => {
    const w = await world();
    const young = await pending(w, 1 * MIN);
    const spy = inSent();

    const none = await runSendReconcilePass(w.db, { openSendAdapter: spy.factory, now: () => NOW });
    expect(none.claimed).toBe(0);
    expect(await status(w, young.sendId)).toBe("pending");

    await w.db.update(outboundSends).set({ status: "sent" }).where(eq(outboundSends.id, young.sendId));
    const again = await runSendReconcilePass(w.db, { openSendAdapter: spy.factory, now: () => NOW, inherited: [young.sendId] });
    expect(again.claimed).toBe(0);
    expect(spy.seen.probed).toHaveLength(0);
  });
});
