import { afterEach, describe, expect, it, vi } from "vitest";
import { answer, forwardWorld } from "./_forward-world.js";

/**
 * A FORWARD THAT MEETS OHMAIL'S OWN PER-MAILBOX IMAP CAP IS OFFERED AGAIN, AND ITS REPLAY SENDS IT.
 *
 * A forward on Desktop went only on the third press (2026-10-19). Reading a forward's original
 * takes one of the mailbox's two IMAP slots (`makeOpenAdapter`); with both held by other reads, a
 * download or two inline images, the door waits two seconds and refuses `mailbox_busy`. The send
 * recorded that refusal final: the press failed, its same-key replay met 409 `failed`, and only a
 * press under a new key sent. Through the real route and the real door, as the Desktop and phone
 * engines compose it (the in-process gate; the device store admits every shared slot), on both
 * stores: the press is answered retryable with the door's wait, nothing reaches SMTP, and once a
 * slot is free the same-key replay sends the forward once, the same row and Message-ID. A cap held
 * through every attempt ends final, and a final answer names no wait. The shared counter's refusal
 * (Cloud, Postgres only) is `send-rearm-route.test.ts`'s.
 */

afterEach(() => { vi.restoreAllMocks(); });

const filesOf = (w: Awaited<ReturnType<typeof forwardWorld>>) => w.smtp.delivered.map((m) => m.attachments?.map((a) => a.filename));

describe("POST /drafts/:id/send — a forward while the mailbox's IMAP slots are all in use", () => {
  it("CONTROL: with a slot free the first press sends the forward and its file", async () => {
    const w = await forwardWorld({ admission: "device" });
    const first = await answer(await w.press("k1"));
    expect({ status: first.status, wire: first.wire }).toEqual({ status: 200, wire: "sent" });
    expect(filesOf(w)).toEqual([["plan.pdf"]]);
  });

  it("both held: 429 mailbox_busy, retryable with the door's 2 s wait, nothing offered; freed, the same key sends once", async () => {
    const w = await forwardWorld({ admission: "device" });
    const release = await w.holdBothSlots();
    const first = await answer(await w.press("k1"));
    expect(first).toEqual({ status: 429, code: "mailbox_busy", retryable: true, retryAfter: 2, header: "2", wire: undefined });
    const failed = await w.row();
    expect({ status: failed?.status, attempts: failed?.attempts, retryUntil: failed?.retryUntil != null, retryRefusal: failed?.retryRefusal })
      .toEqual({ status: "failed", attempts: 1, retryUntil: true, retryRefusal: "mailbox_busy" });
    expect(w.smtp.dials, "the refused read reached SMTP").toBe(0);
    expect(await w.draftStatus(), "the draft is an ordinary draft during the wait").toBe("draft");

    await release();
    w.clock.advance(2_000);
    const replay = await answer(await w.press("k1"));
    expect({ status: replay.status, wire: replay.wire }).toEqual({ status: 200, wire: "sent" });
    const sent = await w.row();
    expect({ status: sent?.status, attempts: sent?.attempts }).toEqual({ status: "sent", attempts: 2 });
    expect(filesOf(w), "one forward, with its file").toEqual([["plan.pdf"]]);
    expect(w.smtp.delivered[0]!.messageId, "the replay is the same message").toBe(sent?.mintedMessageId);
  }, 30_000);

  it("held through every attempt: the third is final, says so and names no wait; its replay dials nothing", async () => {
    const w = await forwardWorld({ admission: "device" });
    const release = await w.holdBothSlots();
    const a1 = await answer(await w.press("k1"));
    expect({ retryable: a1.retryable, header: a1.header }).toEqual({ retryable: true, header: "2" });
    w.clock.advance(2_000);
    // The second attempt's own wait (5 s) is the longer one, so it is the one named.
    const a2 = await answer(await w.press("k1"));
    expect({ retryable: a2.retryable, header: a2.header }).toEqual({ retryable: true, header: "5" });
    w.clock.advance(5_000);
    const a3 = await answer(await w.press("k1"));
    expect(a3, "a final answer carried a wait").toEqual({
      status: 429, code: "mailbox_busy", retryable: false, retryAfter: undefined, header: null, wire: undefined,
    });
    const r = await w.row();
    expect({ status: r?.status, attempts: r?.attempts, retryUntil: r?.retryUntil ?? null }).toEqual({ status: "failed", attempts: 3, retryUntil: null });
    await release();
    const replay = await answer(await w.press("k1"));
    expect({ status: replay.status, wire: replay.wire }).toEqual({ status: 409, wire: "failed" });
    expect([w.smtp.dials, w.smtp.delivered.length]).toEqual([0, 0]);
  }, 30_000);
});
