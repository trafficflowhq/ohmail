import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { eq } from "drizzle-orm";
import { mailboxes, threads, messages, kbEntries, drafts, clientIdempotencyKey } from "@trafficflow/db";
import { DraftingService, DraftsService, DRAFT_OWN_TEXT_MAX_CHARS, dbFor } from "../src/index.js";
import { fakeSpendPort } from "./helpers/spend-port-fake.js";
import type { ServiceContext } from "../src/index.js";
import type { DraftInput, DraftPort } from "@trafficflow/core";

const NOW = new Date("2026-07-28T12:00:00.000Z");

/** A capturing mock DraftPort: records every input + call-count, never networks. */
function mockDrafter(): DraftPort & { calls: number; inputs: DraftInput[] } {
  const m = {
    calls: 0,
    inputs: [] as DraftInput[],
    async draft(input: DraftInput) {
      m.calls += 1;
      m.inputs.push(input);
      return { subject: "Re: mocked", body: "Mocked reply.", rationale: "mock" };
    },
  };
  return m;
}

async function setup() {
  const db = await makeTestDb();
  const A = randomUUID();
  const B = randomUUID();
  const [mbA] = await db.insert(mailboxes).values({ accountId: A, provider: "imap", address: "a@x-ch.example" }).returning();
  const ctxA: ServiceContext = { db: dbFor(db, A), accountId: A, userId: null, now: () => NOW, requestId: "r" };
  const ctxB: ServiceContext = { db: dbFor(db, B), accountId: B, userId: null, now: () => NOW, requestId: "r" };
  return { db, A, B, mbA: mbA!.id, ctxA, ctxB };
}

interface SeedMsg {
  accountId: string; mailboxId: string; threadId?: string;
  subject?: string; fromAddress?: string; snippet?: string; date?: Date;
  noAi?: boolean; noKb?: boolean; sensitivityCategory?: string | null;
}
async function seedMsg(db: Awaited<ReturnType<typeof setup>>["db"], o: SeedMsg): Promise<string> {
  const [m] = await db.insert(messages).values({
    accountId: o.accountId,
    mailboxId: o.mailboxId,
    bodyHash: "h",
    dedupKey: `seed:${randomUUID()}`,
    subject: o.subject ?? "Seed subject",
    fromAddress: o.fromAddress ?? "sender@example.com",
    snippet: o.snippet ?? "seed snippet",
    threadId: o.threadId ?? null,
    date: o.date ?? NOW,
    noAi: o.noAi ?? false,
    noKb: o.noKb ?? false,
    sensitivityCategory: o.sensitivityCategory ?? null,
  }).returning();
  return m!.id;
}

const svc = new DraftingService();
const draftsSvc = new DraftsService();

describe("DraftingService.draftFromMessage — accepts authentication mail", () => {
  it("drafts a sign-in message with the no_ai flag", async () => {
    const { db, A, mbA, ctxA } = await setup();
    const id = await seedMsg(db, { accountId: A, mailboxId: mbA, noAi: true, subject: "Your sign-in code", snippet: "Use 123456 to sign in." });
    const drafter = mockDrafter();
    await expect(svc.draftFromMessage(ctxA, id, { drafter }))
      .resolves.toHaveProperty("draftId");
    expect(drafter.calls).toBe(1);
  });

  it("drafts a target with a sensitivity category", async () => {
    const { db, A, mbA, ctxA } = await setup();
    const id = await seedMsg(db, { accountId: A, mailboxId: mbA, sensitivityCategory: "otp" });
    const drafter = mockDrafter();
    await expect(svc.draftFromMessage(ctxA, id, { drafter }))
      .resolves.toHaveProperty("draftId");
    expect(drafter.calls).toBe(1);
  });
});

describe("DraftingService.draftFromMessage — thread context", () => {
  it("the DraftInput carries the normal thread sibling and the previously excluded sibling", async () => {
    const { db, A, mbA, ctxA } = await setup();
    const [th] = await db.insert(threads).values({ accountId: A, subject: "Thread" }).returning();
    const target = await seedMsg(db, {
      accountId: A, mailboxId: mbA, threadId: th!.id, subject: "Please advise",
      snippet: "target snippet", date: new Date(NOW.getTime() + 3000),
    });
    await seedMsg(db, {
      accountId: A, mailboxId: mbA, threadId: th!.id, fromAddress: "normal@x-ch.example",
      snippet: "NORMAL-SIBLING-SNIPPET", date: new Date(NOW.getTime() + 1000),
    });
    await seedMsg(db, {
      accountId: A, mailboxId: mbA, threadId: th!.id, fromAddress: "secret@x-ch.example",
      snippet: "NOKB-SIBLING-SNIPPET", noKb: true, date: new Date(NOW.getTime() + 2000),
    });

    const drafter = mockDrafter();
    await svc.draftFromMessage(ctxA, target, { drafter });

    expect(drafter.calls).toBe(1);
    const snippets = drafter.inputs[0]!.context.threadMessages.map((t) => t.snippet);
    expect(snippets).toContain("NORMAL-SIBLING-SNIPPET");
    expect(snippets).toContain("NOKB-SIBLING-SNIPPET");
    // and never the target itself (ne(id) excludes it)
    expect(snippets).not.toContain("target snippet");
  });
});

describe("DraftingService.draftFromMessage — context assembly + stored-not-sent", () => {
  it("assembles KB + thread context, and STORES a status='draft' row (never sent)", async () => {
    const { db, A, mbA, ctxA } = await setup();
    await db.insert(kbEntries).values({
      accountId: A, title: "Refund policy", content: "We refund purchases within 30 days.",
    });
    const [th] = await db.insert(threads).values({ accountId: A, subject: "Refund" }).returning();
    // KbService.retrieve uses websearch_to_tsquery (AND-semantics), so the query
    // tokens (subject+snippet) must all appear in the KB doc to match. Keep them a
    // subset of "Refund policy … refund purchases within 30 days".
    const target = await seedMsg(db, {
      accountId: A, mailboxId: mbA, threadId: th!.id, subject: "Refund policy",
      snippet: "refund within 30 days", fromAddress: "client@acme-com.example",
    });
    await seedMsg(db, {
      accountId: A, mailboxId: mbA, threadId: th!.id, snippet: "earlier reply", fromAddress: "me@x-ch.example",
      date: new Date(NOW.getTime() - 1000),
    });

    const drafter = mockDrafter();
    const { draftId, seq } = await svc.draftFromMessage(ctxA, target, { drafter });
    expect(seq).toBeGreaterThan(0);

    // The drafter saw the KB entry + the thread sibling.
    const input = drafter.inputs[0]!;
    expect(input.context.kbEntries.map((e) => e.title)).toContain("Refund policy");
    expect(input.context.threadMessages.map((t) => t.snippet)).toContain("earlier reply");
    expect(input.incoming.subject).toBe("Refund policy");

    // Stored, not sent: a 'draft' row with the AI result + linkage.
    const stored = await draftsSvc.get(ctxA, draftId);
    expect(stored.status).toBe("draft");
    expect(stored.body).toBe("Mocked reply.");
    expect(stored.rationale).toBe("mock");
    expect(stored.inReplyToMessageId).toBe(target);
    expect(stored.threadId).toBe(th!.id);
    expect(stored.mailboxId).toBe(mbA);
  });

  it("cross-account target → 404, drafter not called", async () => {
    const { db, A, mbA, ctxB } = await setup();
    const id = await seedMsg(db, { accountId: A, mailboxId: mbA });
    const drafter = mockDrafter();
    await expect(svc.draftFromMessage(ctxB, id, { drafter }))
      .rejects.toMatchObject({ httpStatus: 404 });
    expect(drafter.calls).toBe(0);
  });
});

/**
 * A DRAFT FROM THE PERSON'S OWN WORDS. The doors in their order, each asserted with what did not
 * happen after it: no model call, no spend. The drafter double records every input.
 */
describe("DraftingService.draftFromText — the person's words, the doors in order", () => {
  const key = clientIdempotencyKey("press-text-1");
  const metered = () => ({ credits: fakeSpendPort(), obligations: { async owe() { /* recorded nowhere */ }, async settle() { /* nothing */ } } });

  it("stores a draft from the words alone: the model is asked with the words and no letter, the person's subject kept", async () => {
    const { db, mbA, ctxA } = await setup();
    const drafter = mockDrafter();
    const { draftId } = await svc.draftFromText(ctxA, { text: "  tell the board the review moves to Friday  ", mailboxId: mbA, subject: "Review" }, { drafter });
    expect(drafter.inputs).toHaveLength(1);
    expect(drafter.inputs[0]!.own).toEqual({ text: "tell the board the review moves to Friday", replying: false, subject: "Review" });
    expect(drafter.inputs[0]!.incoming).toEqual({ subject: "", from: "", snippet: "" });
    expect(drafter.inputs[0]!.context.threadMessages).toEqual([]);
    const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect({ mailbox: row!.mailboxId, replyTo: row!.inReplyToMessageId, subject: row!.subject, status: row!.status })
      .toEqual({ mailbox: mbA, replyTo: null, subject: "Review", status: "draft" });
  });

  it("answering a letter: its preview and its thread ground the words, and the draft answers it", async () => {
    const { db, A, mbA, ctxA } = await setup();
    const [t] = await db.insert(threads).values({ accountId: A, subject: "Plans" }).returning();
    await seedMsg(db, { accountId: A, mailboxId: mbA, threadId: t!.id, snippet: "the earlier note", date: new Date(NOW.getTime() - 60_000) });
    const letter = await seedMsg(db, { accountId: A, mailboxId: mbA, threadId: t!.id, subject: "Plans", snippet: "can we meet?" });
    const drafter = mockDrafter();
    const { draftId } = await svc.draftFromText(ctxA, { text: "yes, Thursday", inReplyToMessageId: letter }, { drafter });
    expect(drafter.inputs[0]!.own).toEqual({ text: "yes, Thursday", replying: true });
    expect(drafter.inputs[0]!.incoming.snippet).toBe("can we meet?");
    expect(drafter.inputs[0]!.context.threadMessages.map((m) => m.snippet)).toEqual(["the earlier note"]);
    const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect([row!.inReplyToMessageId, row!.threadId, row!.subject]).toEqual([letter, t!.id, "Re: mocked"]);
  });

  it("the words: absent, blank, too long or not text is a 400, and nothing is asked or charged", async () => {
    const { mbA, ctxA } = await setup();
    for (const text of [undefined, "", "   ", "x".repeat(DRAFT_OWN_TEXT_MAX_CHARS + 1), 42]) {
      const drafter = mockDrafter();
      const m = metered();
      await expect(svc.draftFromText(ctxA, { text, mailboxId: mbA } as never, { drafter, ...m, attemptKey: key }))
        .rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
      expect([drafter.calls, m.credits.spends.length]).toEqual([0, 0]);
    }
    await expect(svc.draftFromText(ctxA, { text: "hi", mailboxId: mbA, subject: 7 } as never, { drafter: mockDrafter() }))
      .rejects.toMatchObject({ httpStatus: 400 });
    expect((await svc.draftFromText(ctxA, { text: "x".repeat(DRAFT_OWN_TEXT_MAX_CHARS), mailboxId: mbA }, { drafter: mockDrafter() })).draftId).toBeTruthy();
  });

  it("the letter: another account's is a 404, a sign-in message drafts, another mailbox a 400, none and no mailbox a 400", async () => {
    const { db, A, B, mbA, ctxA } = await setup();
    const [mbB] = await db.insert(mailboxes).values({ accountId: B, provider: "imap", address: "b@x-ch.example" }).returning();
    const theirs = await seedMsg(db, { accountId: B, mailboxId: mbB!.id });
    const sensitive = await seedMsg(db, { accountId: A, mailboxId: mbA, sensitivityCategory: "otp" });
    const mine = await seedMsg(db, { accountId: A, mailboxId: mbA });
    const [other] = await db.insert(mailboxes).values({ accountId: A, provider: "imap", address: "a2@x-ch.example" }).returning();
    const drafter = mockDrafter();
    const m = metered();
    const deps = { drafter, ...m, attemptKey: key };
    await expect(svc.draftFromText(ctxA, { text: "hi", inReplyToMessageId: theirs }, deps)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(svc.draftFromText(ctxA, { text: "hi", inReplyToMessageId: sensitive }, deps)).resolves.toHaveProperty("draftId");
    await expect(svc.draftFromText(ctxA, { text: "hi", inReplyToMessageId: mine, mailboxId: other!.id }, deps)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(svc.draftFromText(ctxA, { text: "hi" }, deps)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(svc.draftFromText(ctxA, { text: "hi", mailboxId: mbB!.id }, deps)).rejects.toMatchObject({ httpStatus: 400 });
    expect([drafter.calls, m.credits.spends.length]).toEqual([1, 1]);
  });

  it("drafts and charges once for words about a verification code", async () => {
    const { mbA, ctxA } = await setup();
    const drafter = mockDrafter();
    const m = metered();
    const result = await svc.draftFromText(ctxA, { text: "Ask them where to find the verification code", mailboxId: mbA }, { drafter, ...m, attemptKey: key });
    expect(result.draftId).toBeTruthy();
    expect([drafter.calls, m.credits.spends.length]).toEqual([1, 1]);
  });

  it("an empty balance is refused before the model; a disconnected mailbox before the charge", async () => {
    const { db, mbA, ctxA } = await setup();
    const drafter = mockDrafter();
    const m = metered();
    m.credits.answer({ verdict: "insufficient", reason: "out_of_credits" });
    await expect(svc.draftFromText(ctxA, { text: "hi", mailboxId: mbA }, { drafter, ...m, attemptKey: key }))
      .rejects.toMatchObject({ httpStatus: 402 });
    expect(drafter.calls).toBe(0);
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mbA));
    const n = metered();
    await expect(svc.draftFromText(ctxA, { text: "hi", mailboxId: mbA }, { drafter, ...n, attemptKey: key }))
      .rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
    expect(n.credits.spends).toEqual([]);
  });

  it("a failed model gives the spend back; a metered host without a key or a refund memory is refused before it", async () => {
    const { mbA, ctxA } = await setup();
    const m = metered();
    m.credits.exclusive();
    const failing: DraftPort = { async draft() { throw new Error("the model refused"); } };
    await expect(svc.draftFromText(ctxA, { text: "hi", mailboxId: mbA }, { drafter: failing, ...m, attemptKey: key }))
      .rejects.toMatchObject({ code: "ai_draft_failed", details: { credits: "returned" } });
    expect(m.credits.releases.map((r) => r.refund)).toEqual([true]);
    await expect(svc.draftFromText(ctxA, { text: "hi", mailboxId: mbA }, { drafter: mockDrafter(), credits: fakeSpendPort(), attemptKey: key }))
      .rejects.toMatchObject({ httpStatus: 500 });
    await expect(svc.draftFromText(ctxA, { text: "hi", mailboxId: mbA }, { drafter: mockDrafter(), ...metered() }))
      .rejects.toMatchObject({ httpStatus: 500 });
  });

  it("one Idempotency-Key on both routes is two pieces of work: each charged once, never one free", async () => {
    const { db, A, mbA, ctxA } = await setup();
    const letter = await seedMsg(db, { accountId: A, mailboxId: mbA });
    const m = metered();
    m.credits.exclusive();
    await svc.draftFromMessage(ctxA, letter, { drafter: mockDrafter(), ...m, attemptKey: key });
    await svc.draftFromText(ctxA, { text: "yes", inReplyToMessageId: letter }, { drafter: mockDrafter(), ...m, attemptKey: key });
    expect(m.credits.spends.map((s) => s.outcome.verdict)).toEqual(["ok", "ok"]);
    expect(new Set(m.credits.spends.map((s) => s.source)).size).toBe(2);
    // The same key again on the words is the same work: never charged a second time (the route replays the stored answer).
    await svc.draftFromText(ctxA, { text: "yes", inReplyToMessageId: letter }, { drafter: mockDrafter(), ...m, attemptKey: key }).catch(() => undefined);
    expect(m.credits.spends.at(-1)!.outcome.verdict).not.toBe("ok");
    expect(m.credits.spends.at(-1)!.source).toBe(m.credits.spends[1]!.source);
  });
});
