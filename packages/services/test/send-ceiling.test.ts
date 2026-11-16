import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, drafts, outboundSends } from "@trafficflow/db";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { SendService, SEND_TIMEOUT_SENTENCE, dbFor } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * THE ATTEMPT CEILING — what a send that runs out of time answers, and what it leaves behind.
 *
 * The ceiling exists because a send is a SEQUENCE of network operations, each with its own
 * deadline and none with a deadline over the whole: a cold IMAP dial and LOGIN, a full SMTP
 * session, an APPEND of the message to Sent. Measured against the three shipped provider shapes,
 * the dial alone varies eightfold between consecutive presses on one account, so "several
 * seconds, sometimes stuck" is the ordinary behaviour of the sequence and not a fault in it.
 *
 * Every case here is about the BOUNDARY the outcome is decided on, which is the same boundary the
 * pre-SMTP window already draws — has anything been offered to a server yet:
 *
 *   before `adapter.send`   a definite non-delivery. The reservation is finalized `failed`, the
 *                           draft comes back with a sentence, and the key is spent.
 *   at or after it          an unknown fate. The reservation is left `pending` WITH ITS KEY, the
 *                           answer is `queued`, and nothing is ever resent.
 *
 * The second is the one that carries the double-send invariant, so it is asserted from both ends:
 * the row that is left, and what a same-key retry does with it.
 */

const NOW = new Date("2026-09-02T12:00:00Z");

/** Never resolves. The point of a hang is that no deadline of its own ever fires. */
const hang = <T,>(): Promise<T> => new Promise<T>(() => { /* deliberately never settles */ });

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "mila@lichtgrat.example",
  }).returning();
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
  const newDraft = async (): Promise<string> => {
    const [d] = await db.insert(drafts).values({
      accountId, mailboxId: mb!.id, subject: "Re: hi", body: "Thanks!",
      to: [{ name: null, address: "you@example.com" }], status: "draft",
    }).returning();
    return d!.id;
  };
  return { db, ctx, newDraft };
}

describe("the send attempt ceiling", () => {
  it("a dial that never answers is a DEFINITE non-delivery: failed, with the sentence, nothing offered", async () => {
    const { db, ctx, newDraft } = await setup();
    const draftId = await newDraft();
    let opens = 0;
    const openSendAdapter: OpenSendAdapter = async () => { opens += 1; return hang(); };

    // Caught rather than matched: `message` is a non-enumerable own property of an Error, so
    // `toMatchObject` cannot see it — and the sentence is half of what this case is about.
    const thrown = await new SendService()
      .send(ctx, draftId, "k-open", { openSendAdapter, attemptCeilingMs: 20 })
      .then(() => null, (e: unknown) => e as { code?: string; message?: string });
    expect(thrown, "a ceiling breach before anything was offered must refuse, not resolve").not.toBeNull();
    expect(thrown!.code).toBe("send_timeout");
    expect(thrown!.message).toBe(SEND_TIMEOUT_SENTENCE);

    expect(opens, "the dial was attempted").toBe(1);
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect(row!.status, "nothing was offered, so the reservation is terminal").toBe("failed");
    const [d] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(d!.status, "the draft comes back so the message is not lost").toBe("draft");
    // The SENTENCE reaches an interactive sender as the HTTP answer, asserted above.
    // `drafts.send_error` is written only when an APPOINTMENT was standing (`finalizeFailed`'s
    // `case when send_at is not null`), because that is the path where the row is the only
    // channel — nobody is holding a response. Asserted in both directions rather than assumed.
    expect(d!.sendError, "an interactive refusal is answered, not filed").toBeNull();
  });

  it("a SCHEDULED send that times out on the dial files the sentence on the row — nobody is holding a response", async () => {
    const { db, ctx, newDraft } = await setup();
    const draftId = await newDraft();
    // The shape `runScheduledSendPass` hands `send`: the appointment's own key, still standing.
    await db.update(drafts).set({ sendAt: NOW, sendKey: "appt-1" }).where(eq(drafts.id, draftId));
    const openSendAdapter: OpenSendAdapter = async () => hang();

    await new SendService()
      .send(ctx, draftId, "appt-1", { openSendAdapter, attemptCeilingMs: 20 })
      .catch(() => { /* the refusal is the point; the row is what this case reads */ });

    const [d] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(d!.sendError, "a scheduled sender reads the row or nothing").toBe(SEND_TIMEOUT_SENTENCE);
    expect(d!.sendKey, "a terminal outcome ends the appointment's bookkeeping").toBeNull();
  });

  it("a submission that never answers is an UNKNOWN fate: queued, reservation pending, key kept", async () => {
    const { db, ctx, newDraft } = await setup();
    const draftId = await newDraft();
    let sendCalls = 0;
    const openSendAdapter: OpenSendAdapter = async () => ({
      async send(): Promise<{ providerMessageId: string }> { sendCalls += 1; return hang(); },
      async messageInSent(): Promise<boolean> { return false; },
      async close(): Promise<void> { /* the abandoned submission still owns this */ },
    });

    const res = await new SendService().send(
      ctx, draftId, "k-submit", { openSendAdapter, attemptCeilingMs: 20 },
    );

    expect(res.status).toBe("queued");
    expect(res.providerMessageId, "nothing is known to have been delivered").toBeNull();
    expect(res.seq, "the reservation's own draft change is a committed row the client drains past")
      .toBeGreaterThan(0);
    expect(sendCalls).toBe(1);

    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect(row!.status, "an abandoned attempt may not be written up as an ending").toBe("pending");
    expect(row!.idempotencyKey, "the key is what makes the retry safe and it is kept").toBe("k-submit");
    expect(row!.mintedMessageId, "verify-by-Sent has an id to search for").toMatch(/^<.+@.+>$/);
  });

  it("a same-key retry after a `queued` answer NEVER resends — it reports the live attempt", async () => {
    const { ctx, newDraft } = await setup();
    const draftId = await newDraft();
    let sendCalls = 0;
    let probes = 0;
    const openSendAdapter: OpenSendAdapter = async () => ({
      async send(): Promise<{ providerMessageId: string }> { sendCalls += 1; return hang(); },
      async messageInSent(): Promise<boolean> { probes += 1; return false; },
      async close(): Promise<void> { /* nothing */ },
    });
    const svc = new SendService();

    const first = await svc.send(ctx, draftId, "k-retry", { openSendAdapter, attemptCeilingMs: 20 });
    expect(first.status).toBe("queued");

    // The impatient retry, under the SAME key and well inside SEND_STALE_AFTER_MS.
    const second = await svc.send(ctx, draftId, "k-retry", { openSendAdapter, attemptCeilingMs: 20 });

    expect(second.status, "a reservation this young may still have a live sender behind it").toBe("in_flight");
    expect(sendCalls, "the retry offered a second envelope to a real recipient").toBe(1);
    expect(probes, "a fresh pending row must not be probed — the first attempt may still be mid-SMTP")
      .toBe(0);
  });

  it("a submission that lands AFTER the ceiling still finalizes `sent` — the standalone door's recovery", async () => {
    const { db, ctx, newDraft } = await setup();
    const draftId = await newDraft();
    let release!: (v: { providerMessageId: string }) => void;
    let closes = 0;
    const openSendAdapter: OpenSendAdapter = async () => ({
      send: (msg: OutboundMessage) =>
        new Promise<{ providerMessageId: string }>((resolve) => {
          release = () => resolve({ providerMessageId: msg.messageId! });
        }),
      async messageInSent(): Promise<boolean> { return false; },
      async close(): Promise<void> { closes += 1; },
    });

    const res = await new SendService().send(
      ctx, draftId, "k-late", { openSendAdapter, attemptCeilingMs: 20 },
    );
    expect(res.status).toBe("queued");

    // The process outlived the answer — the desktop's own engine, where the abandoned promise is
    // still running. It lands, and it is the SAME attempt: no second envelope, one finalize.
    release({ providerMessageId: "ignored" });
    await new Promise((r) => { setTimeout(r, 50); });

    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect(row!.status, "the late landing must settle the row it reserved").toBe("sent");
    const [d] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(d!.status, "and the draft's own flip is what /sync carries to the client").toBe("sent");
    expect(closes, "the abandoned submission owns its adapter and still closes it").toBe(1);
  });

  it("an abandoned submission that FAILS after the ceiling is handled, not thrown into the void", async () => {
    // The third fate of an abandoned promise, and the only one with no caller left to catch it.
    // `send` has already returned `queued`; if the submission then rejects — the socket dies, the
    // Sent probe throws, `finalizeSent` loses its connection — that rejection belongs to nobody.
    // On Node an unhandled rejection takes the PROCESS down, which on the standalone door is the
    // whole app, and it would be triggered by a send that merely ran slow.
    //
    // Asserted through the LOG rather than by watching for a crash: the handler's whole job is to
    // say which reservation was left behind and why, so a row nobody can explain has a line
    // somebody can find. The reservation must also still be `pending` with its key — the abandoned
    // attempt failing is not evidence about delivery, and writing it up as failed would claim an
    // ending this process cannot prove.
    const { db, ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const warned: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const log = {
      info: () => { /* the phase line is another case */ },
      warn: (event: string, fields: Record<string, unknown>) => warned.push({ event, fields }),
      error: () => { /* not this case */ }, debug: () => { /* not this case */ },
    };
    let fail!: (e: Error) => void;
    const openSendAdapter: OpenSendAdapter = async () => ({
      send: () => new Promise<{ providerMessageId: string }>((_res, rej) => { fail = rej; }),
      async messageInSent(): Promise<boolean> { throw new Error("the probe's socket is gone too"); },
      async close(): Promise<void> { /* nothing */ },
    });

    const res = await new SendService().send(
      ctx, draftId, "k-late-fail", { openSendAdapter, attemptCeilingMs: 20, log: log as never },
    );
    expect(res.status).toBe("queued");

    fail(new Error("the socket died after the caller was answered"));
    await new Promise((r) => { setTimeout(r, 50); });

    const line = warned.find((l) => l.event === "send_abandoned_after_ceiling");
    expect(line, "the abandoned failure went nowhere a person can find it").toBeDefined();
    expect(line!.fields.draftId).toBe(draftId);

    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect(row!.status, "an abandoned attempt's failure is not evidence about delivery").toBe("pending");
    expect(row!.idempotencyKey, "the key must survive for the recovery to be safe").toBe("k-late-fail");
  });

  it("a send that beats the ceiling is untouched by it — no timer left running, no state changed", async () => {
    const { ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const openSendAdapter: OpenSendAdapter = async () => ({
      async send(msg: OutboundMessage): Promise<{ providerMessageId: string }> {
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent(): Promise<boolean> { return false; },
      async close(): Promise<void> { /* nothing */ },
    });

    const res = await new SendService().send(
      ctx, draftId, "k-fast", { openSendAdapter, attemptCeilingMs: 20 },
    );
    expect(res.status).toBe("sent");
    expect(res.providerMessageId).toMatch(/^<.+@lichtgrat\.example>$/);
  });

  it("does not double-count: the dial's number is the dial, not assembly plus the dial", async () => {
    // The phases were first timed as two reads off ONE start, so `openMs` silently reported
    // assembly + dial. On an ordinary send assembly is zero and the error is invisible; on the
    // sends that HAVE assembly — a staged attachment, a forward's parts — the number that
    // matters most is inflated by exactly the phase beside it, which is how a reader ends up
    // looking in the wrong place. Both phases are made expensive here so the two cannot be
    // confused by accident.
    const { ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const SLOW = 80;
    const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
    const lines: Array<Record<string, unknown>> = [];
    const log = {
      info: (_e: string, f: Record<string, unknown>) => lines.push(f),
      warn: () => { /* not this case */ }, error: () => { /* not this case */ },
      debug: () => { /* not this case */ },
    };
    const openSendAdapter: OpenSendAdapter = async () => {
      await sleep(SLOW);
      return {
        async send(msg: OutboundMessage): Promise<{ providerMessageId: string }> {
          return { providerMessageId: msg.messageId! };
        },
        async messageInSent(): Promise<boolean> { return false; },
        async close(): Promise<void> { /* nothing */ },
      };
    };
    const stagedAttachments = {
      declare: async (_a: string, ids: readonly string[]) =>
        ids.map((id) => ({ id, sizeBytes: 8, expiresAt: new Date(NOW.getTime() + 60_000) })),
      fetch: async () => {
        await sleep(SLOW);
        return [{ filename: "a.txt", contentType: "text/plain", content: Buffer.from("hi") }];
      },
    };

    await new SendService().send(ctx, draftId, "k-split", {
      openSendAdapter, log: log as never, stagedAttachments: stagedAttachments as never,
      surfaceMaxTotalBytes: null,
    }, { stagedAttachmentIds: ["s1"] });

    const p = lines.find((l) => typeof l.openMs === "number")!;
    expect(p, "no phase line was emitted").toBeDefined();
    expect(p.assembleMs, "the staged fetch is not being timed").toBeGreaterThanOrEqual(SLOW - 20);
    expect(p.openMs, "the dial is not being timed").toBeGreaterThanOrEqual(SLOW - 20);
    expect(
      p.openMs,
      "`openMs` is carrying the assembly beside it — the two phases share one start",
    ).toBeLessThan(SLOW * 2 - 20);
  });

  it("names every phase in one log line, so a slow send is read rather than investigated", async () => {
    const { ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const log = {
      info: (event: string, fields: Record<string, unknown>) => lines.push({ event, fields }),
      warn: () => { /* not this case */ },
      error: () => { /* not this case */ },
      debug: () => { /* not this case */ },
    };
    const openSendAdapter: OpenSendAdapter = async () => ({
      async send(msg: OutboundMessage): Promise<{ providerMessageId: string }> {
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent(): Promise<boolean> { return false; },
      async close(): Promise<void> { /* nothing */ },
    });

    await new SendService().send(ctx, draftId, "k-log", { openSendAdapter, log: log as never });

    const phases = lines.find((l) => l.event === "send_phases");
    expect(phases, "there is no other record of how long a person waited").toBeDefined();
    for (const field of ["reserveMs", "assembleMs", "openMs", "submitMs", "finalizeMs", "projectMs", "totalMs"]) {
      expect(phases!.fields[field], `the line does not name ${field}`).toBeTypeOf("number");
    }
    expect(phases!.fields.status).toBe("sent");
    expect(
      JSON.stringify(phases!.fields),
      "a log line about a message may not quote the message",
    ).not.toContain("Thanks!");
  });
});
