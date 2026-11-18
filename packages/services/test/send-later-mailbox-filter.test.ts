import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { drafts, mailboxes, bindDb } from "@trafficflow/db";
import type { OutboundMessage, SendAdapter } from "@trafficflow/core";
import { DraftsService, ScheduleService, dbFor, runScheduledSendPass, SEND_STALE_AFTER_MS } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * WHICH MAILBOXES A SCHEDULED-SEND PASS MAY CLAIM FOR.
 *
 * The scan is store-wide, and for the hosted clock that is exactly right: one host, one pass,
 * every due appointment in reach is its business. The standalone desktop breaks that assumption
 * the moment an install holds more than one mailbox, because two mailboxes in one store do not
 * share a ROLE. A machine can be the organizer of one and a plain reader of another at the same
 * moment, and a reader must not send an appointment — its own were closed when it was demoted,
 * and the close is explicitly best-effort, so a survivor is not a hypothetical.
 *
 * Without a narrowing, the organizer mailbox's drain would claim and deliver the READER
 * mailbox's appointment: mail leaving from an install the real organizer knows nothing about, at
 * a time nobody re-chose. Gating the whole pass on "every mailbox here organizes" avoids that and
 * introduces a second fault — it withholds the organizer's OWN appointments because an unrelated
 * mailbox was taken over — which is why the answer is a filter and not a gate.
 *
 * ── THE THREE VALUES, AND WHY `[]` IS NOT `undefined` ────────────────────────────────────────
 *
 * `undefined` claims anything (the hosted clock and the self-host clock, byte-identical to
 * before); a list claims only those mailboxes; `[]` claims NOTHING. The last is the one worth a
 * test of its own: it is the "absent config selects the dangerous branch" shape, and collapsing
 * it into the first with a truthiness check would make an install with no organizer runtime
 * behave like the hosted clock and send every appointment in the store.
 *
 * Mutation-checked, watched red and restored: delete the `mailboxIds` predicate from the paged
 * scan in `schedule-send-pass.ts` and the first two tests go red — the reader's appointment is
 * claimed and delivered.
 */

const schedules = new ScheduleService();
const draftsSvc = new DraftsService();

const NOW = new Date("2026-09-02T12:00:00.000Z");
const AT = new Date("2026-09-02T18:00:00.000Z");
const AFTER = new Date(AT.getTime() + 30_000);

/** No network. Records which drafts were actually handed to a transport. */
function fakeAdapter() {
  const delivered: OutboundMessage[] = [];
  const factory = async (): Promise<SendAdapter> => ({
    send: async (m: OutboundMessage) => { delivered.push(m); return { providerMessageId: `<x-${delivered.length}>` }; },
    messageInSent: async () => false,
    close: async () => {},
  }) as unknown as SendAdapter;
  return { factory, delivered };
}

/** One account, two mailboxes, one due appointment on each. */
async function twoMailboxes() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [organizer] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "organizer@filter.test",
  }).returning();
  const [reader] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "reader@filter.test",
  }).returning();
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };

  const mk = async (mailboxId: string, subject: string): Promise<string> => {
    const { draft } = await draftsSvc.create(ctx, {
      mailboxId, subject, body: subject, to: [{ name: null, address: "you@example.com" }],
    });
    await schedules.schedule(ctx, draft.id, AT.toISOString());
    return draft.id;
  };
  return {
    db, ctx, accountId,
    organizerId: organizer!.id, readerId: reader!.id,
    organizerDraft: await mk(organizer!.id, "from the organizer"),
    readerDraft: await mk(reader!.id, "from the reader"),
  };
}

const statusOf = async (db: Awaited<ReturnType<typeof makeTestDb>>, id: string): Promise<string> => {
  const [row] = await db.select().from(drafts).where(eq(drafts.id, id));
  return row!.status;
};

describe("the scheduled-send pass claims only the mailboxes it was given", () => {
  it("claims the named mailbox's appointment and leaves the other one standing", async () => {
    const t = await twoMailboxes();
    const fake = fakeAdapter();
    const r = await runScheduledSendPass(bindDb(t.db, { account: null }), {
      openSendAdapter: fake.factory, now: () => AFTER, mailboxIds: [t.organizerId],
    });

    expect(r).toMatchObject({ claimed: 1, sent: 1 });
    expect(fake.delivered.map((m) => m.subject)).toEqual(["from the organizer"]);
    expect(await statusOf(t.db, t.organizerDraft)).toBe("sent");
    /* THE WHOLE POINT. The reader's appointment is untouched — not failed, not deferred, not
       cancelled. It still says it will send, because the mailbox it belongs to may yet be
       organized again, and closing it here would be this install deciding something about a
       mailbox it does not hold. */
    expect(await statusOf(t.db, t.readerDraft)).toBe("scheduled");
  });

  it("an EMPTY list claims nothing at all — it is not the same as no filter", async () => {
    const t = await twoMailboxes();
    const fake = fakeAdapter();
    const r = await runScheduledSendPass(bindDb(t.db, { account: null }), {
      openSendAdapter: fake.factory, now: () => AFTER, mailboxIds: [],
    });
    expect(r.claimed).toBe(0);
    expect(fake.delivered).toHaveLength(0);
    expect(await statusOf(t.db, t.organizerDraft)).toBe("scheduled");
    expect(await statusOf(t.db, t.readerDraft)).toBe("scheduled");
  });

  it("NO filter claims everything — the hosted clock is byte-identical to before", async () => {
    const t = await twoMailboxes();
    const fake = fakeAdapter();
    const r = await runScheduledSendPass(bindDb(t.db, { account: null }), { openSendAdapter: fake.factory, now: () => AFTER });
    expect(r).toMatchObject({ claimed: 2, sent: 2 });
    expect(fake.delivered.map((m) => m.subject).sort())
      .toEqual(["from the organizer", "from the reader"]);
  });

  it("narrows the STALE-RECOVERY arm too, not only the due one", async () => {
    const t = await twoMailboxes();
    /* A row the sender died half-way through: the claim committed and the finalizer never ran, so
       it sits at 'draft' with its key still on it and is picked up by the recovery arm rather than
       the due arm. The narrowing has to reach that arm as well — the appointment belongs to the
       same mailbox whichever arm finds it, and a filter that covered one and not the other would
       be a hole that only opens after a crash. */
    const stale = new Date(AFTER.getTime() - SEND_STALE_AFTER_MS - 60_000);
    await t.db.update(drafts).set({ status: "draft", sendAt: stale })
      .where(eq(drafts.id, t.readerDraft));

    const fake = fakeAdapter();
    const r = await runScheduledSendPass(bindDb(t.db, { account: null }), {
      openSendAdapter: fake.factory, now: () => AFTER, mailboxIds: [t.organizerId],
    });
    expect(fake.delivered.map((m) => m.subject)).toEqual(["from the organizer"]);
    expect(r.claimed).toBe(1);
    // Still recoverable by the runtime that owns it, whenever that mailbox organizes again.
    expect(await statusOf(t.db, t.readerDraft)).toBe("draft");
  });

  it("claims for several named mailboxes at once", async () => {
    const t = await twoMailboxes();
    const fake = fakeAdapter();
    const r = await runScheduledSendPass(bindDb(t.db, { account: null }), {
      openSendAdapter: fake.factory, now: () => AFTER,
      mailboxIds: [t.organizerId, t.readerId],
    });
    expect(r.claimed).toBe(2);
  });
});
