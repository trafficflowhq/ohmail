import { describe, expect, it } from "vitest";
import { attachments, drafts, messages, outboundSends } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { sendService } from "@trafficflow/services/mail";
import { ServiceError } from "@trafficflow/services/mail";
import type { ServiceContext, AttachmentAdapter, OpenAdapter } from "@trafficflow/services/mail";
import { MessageGoneError } from "@trafficflow/core/adapters/imap";
import type { SendAdapter, OutboundMessage, NativeLocator } from "@trafficflow/core/mail";
import { FIXED_NOW, makeDeps, seedMailbox, seedMessage, seedSession, seedBody } from "../../api/test/helpers.js";

/**
 * ARM 1 — **A MESSAGE THAT WAS NEVER SENT MUST NOT BE BILLED INTO
 * AMBIGUOUS-SEND RECOVERY.**
 *
 * The sequence, which needs no attacker and no concurrency:
 *
 *  1. A person forwards a message that has an attachment.
 *  2. `reserve()` commits — the `outbound_sends` row is `pending`, the draft says `sending` — and
 *     captures the original's locator as the mirror had it.
 *  3. The provider recycles the folder the original lives in (or another client moves it). Its UID
 *     now belongs to a different message, so `ImapAdapter#assertLocatorEpoch` refuses the part
 *     fetch with `MessageGoneError` — correctly, and BEFORE any SMTP socket exists.
 *  4. That threw straight out of `send()`. The reservation stayed `pending`, which this service
 *     reads as an AMBIGUOUS attempt: `in_flight` for ten minutes, then verify-by-Sent, which finds
 *     nothing because nothing was ever sent, and finalizes `unverified` —
 *     *"We couldn't confirm this send. Check your Sent folder before retrying."*
 *
 * So the reader was sent to look for mail that had provably never left the building, over a
 * condition that clears itself. Both halves are asserted below, and the SMTP spy is what makes the
 * claim checkable rather than argued: `sent` stays empty and `messageInSent` is never called.
 *
 * The other half of the fix is that a gone locator on a READ is RE-RESOLVABLE. `messages
 * .native_locator` is repointed by adoption, which keys on Message-ID and fingerprint, so the send
 * re-reads that column once and retries the fetch against whatever it now names. A mutation may
 * not do this — see `core/gone.ts` — but a re-fetch sends nothing, so a read may.
 */

interface SendSpy {
  sent: OutboundMessage[];
  probed: string[];
  openSendAdapter: () => Promise<SendAdapter>;
}
function sendSpy(): SendSpy {
  const spy: SendSpy = {
    sent: [],
    probed: [],
    openSendAdapter: async () => ({
      async send(msg: OutboundMessage) {
        spy.sent.push(msg);
        return { providerMessageId: msg.messageId ?? "<none>" };
      },
      async messageInSent(id: string) { spy.probed.push(id); return false; },
      async close() { /* nothing */ },
    }),
  };
  return spy;
}

/**
 * A fetch adapter that refuses every locator EXCEPT `liveRef`, with the adapter's own
 * `MessageGoneError` — the real class, so what crosses the seam here is what crosses it in
 * production rather than a hand-shaped look-alike.
 *
 * `onRefusal` fires the first time it refuses, which is where a test stands in for the worker's
 * adoption landing between the reservation's read and the retry.
 */
function recycledFetch(opts: { liveRef: string | null; onRefusal?: () => Promise<void> }): {
  openFetchAdapter: OpenAdapter; tried: string[];
} {
  const tried: string[] = [];
  let refusals = 0;
  const openFetchAdapter: OpenAdapter = async (): Promise<AttachmentAdapter> => ({
    async fetchPart(loc: NativeLocator, partId?: string) {
      tried.push(loc.ref);
      if (opts.liveRef === null || loc.ref !== opts.liveRef) {
        refusals++;
        if (refusals === 1 && opts.onRefusal) await opts.onRefusal();
        throw new MessageGoneError(loc);
      }
      return {
        contentType: "application/pdf", filename: "plan.pdf",
        body: new Uint8Array([1, 2, 3, 4]), partId,
      };
    },
    async close() { /* nothing */ },
  });
  return { openFetchAdapter, tried };
}

async function world() {
  const { db } = await makeDeps(FIXED_NOW);
  const s = await seedSession(db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(db, { accountId: s.accountId, address: "me@atelier.example" });

  // THE ORIGINAL, under the epoch the mirror recorded. `12` is its UIDVALIDITY.
  const orig = await seedMessage(db, {
    accountId: s.accountId, mailboxId, subject: "Q3 plan",
    fromAddress: "lena@atelier.example", date: FIXED_NOW,
    nativeLocator: { folder: "INBOX", ref: "12:7" },
  });
  await seedBody(db, { messageId: orig.id, text: "Here is the plan.", html: null });
  await db.insert(attachments).values({
    accountId: s.accountId, messageId: orig.id, filename: "plan.pdf",
    contentType: "application/pdf", sizeBytes: 4, partId: "2", inline: false,
  });

  const [draft] = await db.insert(drafts).values({
    accountId: s.accountId, mailboxId, subject: "Fwd: Q3 plan",
    body: "Passing this along.", to: [{ name: null, address: "sam@example.test" }],
    cc: [], bcc: [], status: "draft", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).returning();

  const ctx: ServiceContext = {
    db, accountId: s.accountId, userId: s.userId, now: () => FIXED_NOW, requestId: "test-gone",
  };
  return { db, ctx, accountId: s.accountId, draftId: draft!.id, originalId: orig.id };
}

describe("a forward whose original moved before its bytes were read", () => {
  it("RE-RESOLVES the source once and completes: the same message under a NEW uid, the file delivered", async () => {
    const w = await world();
    const smtp = sendSpy();
    // The recycled folder re-issued this message as `19:3`. The mirror still says `12:7` when the
    // reservation reads it; adoption repoints it while the first fetch is refused, which is
    // exactly the ordering the worker produces.
    const fetch = recycledFetch({
      liveRef: "19:3",
      onRefusal: async () => {
        await w.db.update(messages)
          .set({ nativeLocator: { folder: "INBOX", ref: "19:3" } })
          .where(eq(messages.id, w.originalId));
      },
    });

    const res = await sendService.send(
      w.ctx, w.draftId, "key-reresolve",
      { openSendAdapter: smtp.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter },
      { forwardOf: w.originalId },
    );

    expect(res.status).toBe("sent");
    // TRIED THE STALE ONE, THEN THE RE-RESOLVED ONE. Two entries and no more: the retry is once,
    // not a loop.
    expect(fetch.tried).toEqual(["12:7", "19:3"]);
    // The forwarded file actually reached the outgoing message — a re-resolution that "succeeded"
    // while dropping the attachment would be the wrong-send this path refuses to make.
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]!.attachments?.map((a) => a.filename)).toEqual(["plan.pdf"]);

    const [row] = await w.db.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect(row!.status).toBe("sent");
  });

  it("REFUSES honestly when the mirror has not caught up — nothing sent, nothing ambiguous, and the words say so", async () => {
    const w = await world();
    const smtp = sendSpy();
    // No live ref anywhere and the mirror is not repointed: the re-read returns the same locator
    // that just failed, which earns no second attempt.
    const fetch = recycledFetch({ liveRef: null });

    const err = await sendService.send(
      w.ctx, w.draftId, "key-unresolvable",
      { openSendAdapter: smtp.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter },
      { forwardOf: w.originalId },
    ).then(() => null, (e: unknown) => e);

    // ── THE REFUSAL ────────────────────────────────────────────────────────────────────────
    expect(err).toBeInstanceOf(ServiceError);
    const se = err as ServiceError;
    expect(se.code).toBe("forward_source_moved");
    expect(se.httpStatus).toBe(409);
    // THE CLAIMS TREATMENT, asserted one clause at a time because each is a separate promise:
    // the state (nothing was sent), the cause (the forwarded message moved), and a recovery that
    // is real. And the sentence the old path produced must not be anywhere near it.
    expect(se.message).toContain("Nothing was sent");
    expect(se.message).toContain("no longer where your mail server said it was");
    // THE RECOVERY IS OFFERED CONDITIONALLY, and the condition is load-bearing rather than
    // hedging. `MessageGoneError` covers a permanently DELETED original as much as a moved one,
    // and for that one no amount of waiting makes the forward work — so a flat "try again once
    // your mailbox has caught up", which this said first, promises a recovery in exactly the case
    // where the reader needs to be told the original is gone.
    expect(se.message).toContain("If it has moved, trying again");
    expect(se.message).toContain("may also have been deleted");
    expect(se.message).not.toMatch(/sent folder/i);

    // ── AND IT REALLY WAS NEVER SENT. The strong half of the claim. ────────────────────────
    expect(smtp.sent).toEqual([]);
    expect(smtp.probed).toEqual([]);
    // One attempt, then the re-read, then the refusal — the same locator is not tried twice.
    expect(fetch.tried).toEqual(["12:7"]);

    // ── THE RESERVATION IS `failed`, NOT `pending`. THIS IS THE ROW'S WHOLE POINT. ─────────
    //
    // A `pending` row here is what routes the next request into verify-by-Sent, so this single
    // assertion is the difference between "your message was not sent" and "go and check whether
    // it was". `failed` is also the state the client releases the send key on, so the reader's
    // next press is a genuinely new send rather than a replay.
    const [row] = await w.db.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect(row!.status).toBe("failed");

    // The composer is not left saying "Sending…" for a message that will never go.
    const [d] = await w.db.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect(d!.status).toBe("draft");
  });

  it("the retry an hour later replays `failed` — it NEVER becomes `unverified`, and Sent is never probed", async () => {
    const w = await world();
    const smtp = sendSpy();
    const fetch = recycledFetch({ liveRef: null });

    await sendService.send(
      w.ctx, w.draftId, "key-stale",
      { openSendAdapter: smtp.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter },
      { forwardOf: w.originalId },
    ).catch(() => { /* refused above; this case is about what happens NEXT */ });

    // An hour later — comfortably past `SEND_STALE_AFTER_MS`, which is the window in which a
    // `pending` row stops being read as in-flight and starts being probed against Sent.
    const later: ServiceContext = {
      ...w.ctx, now: () => new Date(FIXED_NOW.getTime() + 60 * 60 * 1000),
    };
    const res = await sendService.send(
      later, w.draftId, "key-stale",
      { openSendAdapter: smtp.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter },
      { forwardOf: w.originalId },
    );

    // BEFORE THE FIX this was `unverified` — the route's *"Check your Sent folder before
    // retrying"* — for a message no server was ever offered.
    expect(res.status).toBe("failed");
    expect(smtp.probed).toEqual([]);
    expect(smtp.sent).toEqual([]);
  });

  it("a RE-RESOLVED locator that is stale too still gets the honest sentence, not a raw adapter error", async () => {
    // Found by reviewing my own arm rather than by a test failing: the retry sat outside the
    // translation, so a locator that moved TWICE — the mirror repointed, and the message moved
    // again before the second fetch — threw `MessageGoneError` straight out. The send would still
    // have been recorded `failed` by the window handler, so nothing was mis-sent; but the route
    // maps `ServiceError` and blankets everything else into a 500, so the reader would have got
    // "something went wrong" instead of the sentence. The honest outcome must not depend on how
    // many times the locator moved.
    const w = await world();
    const smtp = sendSpy();
    // `liveRef` is a ref nothing will ever present, and the mirror IS repointed on the first
    // refusal — so the re-resolution happens, is attempted, and fails again.
    const fetch = recycledFetch({
      liveRef: "never:0",
      onRefusal: async () => {
        await w.db.update(messages)
          .set({ nativeLocator: { folder: "INBOX", ref: "19:3" } })
          .where(eq(messages.id, w.originalId));
      },
    });

    const err = await sendService.send(
      w.ctx, w.draftId, "key-twice-gone",
      { openSendAdapter: smtp.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter },
      { forwardOf: w.originalId },
    ).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("forward_source_moved");
    expect((err as ServiceError).message).toContain("Nothing was sent");
    // Both locators really were tried — the re-resolution ran, so this is the two-moves case and
    // not the one-move case wearing its name.
    expect(fetch.tried).toEqual(["12:7", "19:3"]);
    expect(smtp.sent).toEqual([]);
    const [row] = await w.db.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect(row!.status).toBe("failed");
  });

  /**
   * REVIEW FINDING — THE BOUNDARY IS "HAS ANYTHING BEEN OFFERED TO A SERVER", NOT "ASSEMBLY".
   *
   * The window first covered the two assembly steps and stopped one line short of
   * `openSendAdapter`. Decrypting the stored credential, dialling and authenticating all happen
   * before any envelope exists, so a failure there is just as definite — and it was leaving the
   * reservation `pending`, which is the state that becomes `unverified` ten minutes later. The old
   * line was arbitrary, and that is what the finding pointed at.
   */
  it("a transport that will not OPEN is `failed` too — the line is 'nothing was offered yet'", async () => {
    const w = await world();
    const boom = new Error("SMTP authentication was refused");

    const err = await sendService.send(
      w.ctx, w.draftId, "key-noopen",
      { openSendAdapter: async () => { throw boom; } },
    ).then(() => null, (e: unknown) => e);

    // A fault nobody classified is ours: the window answers 500 with its own sentence, explicitly
    // not retryable (the key's failure is final), and the error rides as the cause for the log.
    expect(err).toBeInstanceOf(ServiceError);
    expect({ code: (err as ServiceError).code, httpStatus: (err as ServiceError).httpStatus, retryable: (err as ServiceError).retryable, cause: (err as { cause?: unknown }).cause })
      .toEqual({ code: "internal", httpStatus: 500, retryable: false, cause: boom });
    // `pending` here is the whole defect: it is what routes the next request into verify-by-Sent.
    const [row] = await w.db.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect(row!.status).toBe("failed");
    const [d] = await w.db.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect(d!.status).toBe("draft");

    // AND NO `send_error`, BECAUSE THIS DRAFT HAD NO APPOINTMENT.
    //
    // The terminal finalize writes a sentence for the SCHEDULED path, where the throw above is
    // caught by a loop and the row is the only channel a reader has. This is the interactive
    // path: the caller already has the refusal, and the route maps it. Writing the field anyway would
    // be read as a schedule failure by both clients, neither of which has any other meaning for
    // it — `en.json#scheduleFailedNote` says "wasn't sent at its SCHEDULED TIME", which never
    // happened here, and `live.ts#liveScheduled` lists any `draft` row carrying the field on the
    // phone's Scheduled screen, where a message nobody scheduled would simply not belong.
    expect(d!.sendAt, "no appointment — which is what gates the sentence").toBeNull();
    expect(d!.sendError).toBeNull();
  });

  it("`adapter.send` failing stays AMBIGUOUS — the boundary must not swallow the one genuine unknown", async () => {
    // The mirror image, and it is the assertion that stops the fix above from going too far. Once
    // the envelope has been offered, SMTP may have accepted it before the error, so this MUST keep
    // the Sent-folder probe and the `unverified` outcome. A window that reached one call further
    // would report a possibly-delivered message as definitely-not-sent, which is the same class of
    // lie in the opposite direction — and the worse one, because it invites a second delivery.
    const w = await world();
    const probed: string[] = [];
    const err = await sendService.send(
      w.ctx, w.draftId, "key-smtp-threw",
      {
        openSendAdapter: async () => ({
          async send() { throw new Error("connection reset mid-DATA"); },
          async messageInSent(id: string) { probed.push(id); return false; },
          async close() { /* nothing */ },
        }),
      },
    ).then((r) => r, (e: unknown) => e);

    expect((err as { status?: string }).status).toBe("unverified");
    expect(probed).toHaveLength(1);
    const [row] = await w.db.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect(row!.status).toBe("unverified");
  });

  it("the whole PRE-SMTP WINDOW is definite, not just the forward: a staged-bytes failure is `failed` too", async () => {
    const w = await world();
    const smtp = sendSpy();
    const boom = new Error("object storage is unreachable");

    const err = await sendService.send(
      w.ctx, w.draftId, "key-staged",
      {
        openSendAdapter: smtp.openSendAdapter,
        // The ticket DECLARES fine — the reservation weighs it against the cap and commits — and
        // the bytes are what cannot be pulled. That ordering is the point: the failure lands
        // strictly inside the pre-SMTP window.
        stagedAttachments: {
          declare: async () => [{ id: "stg_1", sizeBytes: 4, expiresAt: new Date(FIXED_NOW.getTime() + 3_600_000) }],
          fetch: async () => { throw boom; },
        } as never,
      },
      { stagedAttachmentIds: ["stg_1"] },
    ).then(() => null, (e: unknown) => e);

    // The original error rides as the cause: this window records the OUTCOME and answers it as our
    // own fault, explicitly not retryable — a staged send is never offered again under its key.
    expect(err).toBeInstanceOf(ServiceError);
    expect({ code: (err as ServiceError).code, retryable: (err as ServiceError).retryable, cause: (err as { cause?: unknown }).cause })
      .toEqual({ code: "internal", retryable: false, cause: boom });
    expect(smtp.sent).toEqual([]);
    expect(smtp.probed).toEqual([]);
    const [row] = await w.db.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect(row!.status).toBe("failed");
  });
});

describe("a forward whose original cannot be read because the mail server cannot be reached", () => {
  // The original lives on the person's own mail server: a refused dial, or a connection that drops
  // mid-read, is the send's own 424 refusal — not a 500, and never the "message moved" sentence.
  const cases: Array<[string, OpenAdapter]> = [
    ["the dial is refused", async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); }],
    ["the connection drops mid-read", async () => ({
      async fetchPart() { throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }); },
      async close() { /* nothing */ },
    })],
  ];
  for (const [what, openFetchAdapter] of cases) {
    it(`${what}: send_unreachable at 424, nothing offered, the send failed`, async () => {
      const w = await world();
      const smtp = sendSpy();
      const err = await sendService.send(
        w.ctx, w.draftId, `key-${what.length}`,
        { openSendAdapter: smtp.openSendAdapter, openFetchAdapter },
        { forwardOf: w.originalId },
      ).then(() => null, (e: unknown) => e as ServiceError);
      expect(err).toBeInstanceOf(ServiceError);
      expect({ code: err!.code, status: err!.httpStatus }).toEqual({ code: "send_unreachable", status: 424 });
      expect(smtp.sent).toEqual([]);
      const [row] = await w.db.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
      expect(row!.status).toBe("failed");
    });
  }
});
