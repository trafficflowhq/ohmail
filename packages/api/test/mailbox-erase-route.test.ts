import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, SENT_COPIES_CRON_PATH, type ApiDeps } from "@trafficflow/api";
import { eraseOwedMailbox, mailboxes, messages, outboundSends, outboundSentCopies, threads } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { makeDeps, seedSession, seedMailbox, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

/**
 * `DELETE /mailboxes/:id?erase=1` THROUGH THE ROUTE, not through the service.
 *
 * The confirmation is a refusal rule, and a refusal is only as real as the pipeline the route
 * runs: the operands are a body (or an older client's query) this handler parses and a column the
 * service reads, so a rule proven only against `MailboxService.delete` says nothing about whether the
 * route supplies either. The transactional properties — the sibling surviving, the receipts, the
 * foreign keys — belong to the pg twin (`services/test/mailbox-erasure.pg.test.ts`); what this
 * file owns is which requests reach the sweep at all.
 */
describe("DELETE /mailboxes/:id?erase=1 — the second confirmation, at the door", () => {
  const world = async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const mailboxId = await seedMailbox(db, {
      accountId: s.accountId, address: "mila@lichtgrat.example", folders: [{ folder: "INBOX" }],
    });
    const [thread] = await db.insert(threads).values({ accountId: s.accountId }).returning();
    const dedup = `mid:${mailboxId}`;
    await db.insert(messages).values({
      accountId: s.accountId, mailboxId, threadId: thread!.id, messageIdHeader: dedup,
      bodyHash: dedup, dedupKey: dedup, subject: "Glaze order",
      fromAddress: "giulia@example.test", date: FIXED_NOW, snippet: "ciao",
    });
    return { db, deps, s, mailboxId };
  };
  const mailCount = async (db: Awaited<ReturnType<typeof world>>["db"], mailboxId: string) =>
    (await db.select().from(messages).where(eq(messages.mailboxId, mailboxId))).length;

  it("stamps with the address echoed back, answers 202 with what it will erase, and the pass erases it",
    async () => {
    const { db, deps, s, mailboxId } = await world();
    expect(await mailCount(db, mailboxId)).toBe(1);

    const res = await H(req(
      "DELETE", `/mailboxes/${mailboxId}?erase=1&confirm=mila%40lichtgrat.example`,
      { bearer: s.token },
    ), deps);

    expect(res.status).toBe(202);
    const dto = await res.json();
    expect(dto).toMatchObject({ erasing: true, mailboxId, messages: 1, drafts: 0 });
    // The request stamps; the sweep is the pass's, run here the way the worker runs it.
    expect(await mailCount(db, mailboxId)).toBe(1);
    const run = await eraseOwedMailbox(db as never, dialect(db as never), {
      accountId: s.accountId, mailboxId, now: () => FIXED_NOW, maxSteps: 10,
    });
    expect(run.done).toBe(true);
    expect(await mailCount(db, mailboxId)).toBe(0);
    // The receipt names no address, no subject and no correspondent — it is counts and a verdict.
    const flat = JSON.stringify(dto);
    expect(flat).not.toContain("giulia@example.test");
    expect(flat).not.toContain("Glaze order");
  });

  it("a server door's owed Sent copy is never dialled once the mailbox is stamped, and the sweep removes it", async () => {
    const { db, deps, s, mailboxId } = await world();
    const minted = "<owed@lichtgrat.example>";
    const [send] = await db.insert(outboundSends).values({
      accountId: s.accountId, idempotencyKey: "owed-erase", mintedMessageId: minted, providerMessageId: minted, status: "sent",
    }).returning();
    await db.insert(outboundSentCopies).values({
      sendId: send!.id, accountId: s.accountId, mailboxId, rawB64: "cmF3", nextAttemptAt: FIXED_NOW,
    });
    expect((await H(req("DELETE", `/mailboxes/${mailboxId}?erase=1&confirm=mila%40lichtgrat.example`, { bearer: s.token }), deps)).status)
      .toBe(202);
    const dials: string[] = [];
    deps.alerts = { secret: "mailbox-erase-route-test-secret-abcdefghij-fixture" };
    deps.services = { ...deps.services!, sendAdapter: async (id: string) => { dials.push(id); throw new Error("never dialled"); } };
    const pass = await (await H(req("GET", SENT_COPIES_CRON_PATH, { bearer: "mailbox-erase-route-test-secret-abcdefghij-fixture" }), deps)).json();
    expect({ claimed: pass.claimed, dials }).toEqual({ claimed: 0, dials: [] });
    await eraseOwedMailbox(db as never, dialect(db as never), { accountId: s.accountId, mailboxId, now: () => FIXED_NOW, maxSteps: 10 });
    expect(await db.select().from(outboundSentCopies).where(eq(outboundSentCopies.mailboxId, mailboxId))).toEqual([]);
  });

  it("takes the typed address from the BODY, so the URL carries no address", async () => {
    // ERASE-CONFIRM-RIDES-THE-QUERY-STRING: the address rode `?confirm=`, where request logs that
    // record URLs keep it.
    const { db, deps, s, mailboxId } = await world();
    const res = await H(req("DELETE", `/mailboxes/${mailboxId}?erase=1`, {
      bearer: s.token, body: JSON.stringify({ confirm: " Mila@Lichtgrat.example " }),
    }), deps);
    expect(res.status, await res.clone().text()).toBe(202);
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(row!.erasedAt, "the body's confirmation stamped the row").not.toBeNull();
  });

  it("a body naming another mailbox's address refuses, whatever the URL says", async () => {
    const { db, deps, s, mailboxId } = await world();
    const res = await H(req("DELETE", `/mailboxes/${mailboxId}?erase=1&confirm=mila%40lichtgrat.example`, {
      bearer: s.token, body: JSON.stringify({ confirm: "work@lichtgrat.example" }),
    }), deps);
    expect(res.status).toBe(400);
    expect(await mailCount(db, mailboxId)).toBe(1);
  });

  it("case and surrounding space are not part of the answer", async () => {
    const { db, deps, s, mailboxId } = await world();
    const res = await H(req(
      "DELETE", `/mailboxes/${mailboxId}?erase=1&confirm=%20MILA%40LichtGrat.example%20`,
      { bearer: s.token },
    ), deps);
    expect(res.status).toBe(202);
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(row!.erasedAt, "the confirmed erase stamped the row").not.toBeNull();
  });

  it("refuses `?erase=1` with no confirmation and erases nothing", async () => {
    const { db, deps, s, mailboxId } = await world();
    const res = await H(req("DELETE", `/mailboxes/${mailboxId}?erase=1`, { bearer: s.token }), deps);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("erase_not_confirmed");
    expect(await mailCount(db, mailboxId)).toBe(1);
    // The refusal rolls back the removal too: no tombstone from a request that erased nothing.
    const row = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(row[0]!.status).not.toBe("disabled");
  });

  it("refuses another mailbox's address — the confirmation is bound to the row being erased",
    async () => {
      const { db, deps, s, mailboxId } = await world();
      await seedMailbox(db, { accountId: s.accountId, address: "work@lichtgrat.example" });
      const res = await H(req(
        "DELETE", `/mailboxes/${mailboxId}?erase=1&confirm=work%40lichtgrat.example`,
        { bearer: s.token },
      ), deps);
      expect(res.status).toBe(400);
      expect(await mailCount(db, mailboxId)).toBe(1);
    });

  it("the ORDINARY removal is unchanged: 204, and the mail is still there", async () => {
    // The positive control. Every case above asserts a refusal, which is no evidence that the
    // route still does what it did — and an `?erase=1` that leaked into the plain path would be
    // the worst possible regression here.
    const { db, deps, s, mailboxId } = await world();
    const res = await H(req("DELETE", `/mailboxes/${mailboxId}`, { bearer: s.token }), deps);
    expect(res.status).toBe(204);
    expect(await mailCount(db, mailboxId)).toBe(1);
    const row = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(row[0]!.status).toBe("disabled");
  });

  it("`?erase=0` and `?erase=true` are not the erase flag", async () => {
    const { db, deps, s, mailboxId } = await world();
    for (const q of ["erase=0", "erase=true", "erase=yes"]) {
      const w = await world();
      const res = await H(req("DELETE", `/mailboxes/${w.mailboxId}?${q}`, { bearer: w.s.token }), w.deps);
      expect(res.status, q).toBe(204);
      expect(await mailCount(w.db, w.mailboxId), q).toBe(1);
    }
    expect(await mailCount(db, mailboxId)).toBe(1);
  });
});
