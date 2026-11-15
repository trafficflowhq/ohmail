import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  awayReplies, awayResponders, awaySenderState, folderState, mailboxes, messageBodies, messages,
} from "@trafficflow/db";
import type { OutboundMessage, SendAdapter } from "@trafficflow/core";
import { runAwayResponderPass, AWAY_DIAL_MS } from "../src/away-responder-pass.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE TWO THINGS THAT HAPPEN BEFORE AN AWAY REPLY IS SPENT, AND THE ONE BOUND ON THE SEND
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE LEASE, BEFORE THE RESERVATION. An away reply is reserved only by an install that has been
 * TOLD it holds the mailbox. Asked at the send boundary alone — where 0.19.1 left it — a refusal
 * arrives with the reservation already committed, lands in the SMTP catch arm and finalizes the
 * row `unverified`, because an SMTP throw is ambiguous. A lease refusal taken before any dial is
 * not ambiguous at all, and the row it leaves behind is terminal: that install never offers the
 * reply again. Measured at this lane's base through the REAL lease adapter — two `createSidecar`
 * runtimes over one `ohmail/_meta`, `apps/sidecar/test/away-reply-asks-the-lease.test.ts` — which
 * is where the driven half lives. THIS file is the pass's own contract for the question.
 *
 * THE DIAL'S DEADLINE. The erasure fence is re-read immediately before the dial and the dial then
 * sits outside every transaction, so what remains is the dial's own duration. At this lane's base
 * that duration had no bound at all: a `send` that never settled held the reservation past an
 * eight-second test deadline, and would have held it as long as the server cared to. One budget
 * over the whole send makes the residual window a stated number — the project's design notes
 * § A — and a breach takes the same `unverified` ending a throw takes, for the same reason.
 *
 * MUTATIONS WATCHED RED, THEN RESTORED (each by copying back a pristine copy, proved by `cmp`):
 * they are listed in `changes/fix-0192-away-pass-refuses-before-it-reserves.md` with the counts
 * each run reported.
 */

const NOW = new Date("2026-09-02T12:00:00.000Z");
const ENABLED_AT = new Date("2026-09-02T11:00:00.000Z");

type Db = Awaited<ReturnType<typeof makeTestDb>>;
interface World { db: Db; accountId: string; mailboxId: string }

/** A second organizing mailbox on the same account — for the case that one refusal is about one. */
async function secondMailbox(w: World): Promise<string> {
  const [mb] = await w.db.insert(mailboxes).values({
    accountId: w.accountId, provider: "imap", address: "other@away.test",
    organizerRole: "organizer", status: "connected",
  }).returning();
  return mb!.id;
}

/** One account, one organizing mailbox, one live responder that answers everybody, every message. */
async function world(): Promise<World> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "me@away.test",
    organizerRole: "organizer", status: "connected",
  }).returning();
  await db.insert(awayResponders).values({
    accountId, enabled: true, body: "Back Monday.", audience: "everyone",
    throttle: "always", piles: ["INBOX"], enabledAt: ENABLED_AT, updatedAt: ENABLED_AT,
  });
  return { db, accountId, mailboxId: mb!.id };
}

/** One arrived message, filed in the Ohbox — the shape `awayEligibility` admits. */
async function arrive(w: World, subject = "the roof", mailboxId?: string): Promise<string> {
  const at = new Date(NOW.getTime() - 60_000);
  const [m] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: mailboxId ?? w.mailboxId,
    messageIdHeader: `<o-${randomUUID()}@them.test>`,
    bodyHash: randomUUID(), dedupKey: randomUUID(), subject,
    fromAddress: "colleague@them.test", date: at, createdAt: at,
  }).returning();
  await w.db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "hello", headers: {} });
  await w.db.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
  });
  return m!.id;
}

/** Records what reached a transport. `hang` is the submission server that never answers. */
function recorder(opts: { hang?: boolean } = {}) {
  const delivered: OutboundMessage[] = [];
  let opened = 0;
  const factory = async (): Promise<SendAdapter> => {
    opened += 1;
    return {
      send: (m: OutboundMessage) => {
        if (opts.hang) return new Promise<never>(() => { /* never settles */ });
        delivered.push(m);
        return Promise.resolve({ providerMessageId: `<p-${delivered.length}>` });
      },
      messageInSent: async () => false,
      close: async () => {},
    } as unknown as SendAdapter;
  };
  return { factory, delivered, get opened() { return opened; } };
}

const replies = (w: World) =>
  w.db.select().from(awayReplies).where(eq(awayReplies.accountId, w.accountId));
const senderState = (w: World) =>
  w.db.select().from(awaySenderState).where(eq(awaySenderState.accountId, w.accountId));

describe("the away pass asks the lease before it spends a reservation", () => {
  it("a refusal leaves the candidate WHOLE — no ledger row, no sender state, nothing sent", async () => {
    const w = await world();
    await arrive(w);
    const r = recorder();

    const out = await runAwayResponderPass(w.db, {
      openSendAdapter: r.factory as never,
      stillOrganizing: async () => false,
      now: () => NOW, mailboxIds: [w.mailboxId],
    });

    expect(r.delivered, "a reply left an install that does not hold the mailbox").toHaveLength(0);
    expect(out).toMatchObject({ sent: 0, examined: 0, refusedNotOrganizer: 1 });
    // The two rows a spent reservation writes. Both absent is what "offered later" means.
    expect(await replies(w), "the refusal spent a reservation").toHaveLength(0);
    expect(await senderState(w), "the refusal spent the sender's throttle").toHaveLength(0);
  });

  it("and the reply is still owed — a later pass that holds the mailbox sends it", async () => {
    const w = await world();
    await arrive(w);

    const refused = recorder();
    await runAwayResponderPass(w.db, {
      openSendAdapter: refused.factory as never,
      stillOrganizing: async () => false,
      now: () => NOW, mailboxIds: [w.mailboxId],
    });

    const held = recorder();
    const out = await runAwayResponderPass(w.db, {
      openSendAdapter: held.factory as never,
      stillOrganizing: async () => true,
      now: () => NOW, mailboxIds: [w.mailboxId],
    });

    expect(held.delivered.map((m) => m.subject),
      "the withheld reply was lost with the pass that refused it").toEqual(["Re: the roof"]);
    expect(out).toMatchObject({ sent: 1, refusedNotOrganizer: 0 });
    const rows = await replies(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("sent");
  });

  it("and the WALK ends there — the answer is about the mailbox, not about one candidate", async () => {
    /* Asking again for the next candidate would spend an IMAP round trip on an answer already
       given, and would go on sending the log line once per row. One refusal, one line, and the
       rest of the page is left for whoever holds the mailbox. */
    const w = await world();
    await arrive(w, "the roof");
    await arrive(w, "the drains");
    const r = recorder();
    let asked = 0;

    const out = await runAwayResponderPass(w.db, {
      openSendAdapter: r.factory as never,
      stillOrganizing: async () => { asked += 1; return false; },
      now: () => NOW, mailboxIds: [w.mailboxId],
    });

    expect(asked, "the lease was read again after it had already said no").toBe(1);
    expect(out).toMatchObject({ refusedNotOrganizer: 1, sent: 0, capped: true });
    expect(await replies(w)).toHaveLength(0);
  });

  it("one refusal is about ONE mailbox — another mailbox on the same account is still answered", async () => {
    /* `return` would have abandoned the account's remaining mailboxes on a refusal about one of
       them. No host injects this question with more than one mailbox in flight today, and the
       contract is still the pass's: a person who moved one mailbox to another computer and kept
       organizing the other here is owed the second one's replies. */
    const w = await world();
    const other = await secondMailbox(w);
    await arrive(w, "the roof");
    await arrive(w, "the drains", other);
    const r = recorder();

    const out = await runAwayResponderPass(w.db, {
      openSendAdapter: r.factory as never,
      stillOrganizing: async (mailboxId) => mailboxId !== w.mailboxId,
      now: () => NOW, mailboxIds: [w.mailboxId, other],
    });

    expect(r.delivered.map((m) => m.subject),
      "the refusal about one mailbox silenced the other one too").toEqual(["Re: the drains"]);
    expect(out).toMatchObject({ sent: 1, refusedNotOrganizer: 1 });
  });

  it("THE POSITIVE CONTROL — a held lease answers every candidate, and asks twice per candidate", async () => {
    /* Without this a `stillOrganizing` that refused unconditionally, or one nobody called, would
       pass the case above. The count is per CANDIDATE and not per pass: the defect it guards is a
       question asked once at the top, which is the shape the connection check had. Twice: before
       the reservation and again at the dial, where the sidecar's transport used to ask it. */
    const w = await world();
    await arrive(w, "the roof");
    await arrive(w, "the drains");
    const r = recorder();
    const asked: string[] = [];

    const out = await runAwayResponderPass(w.db, {
      openSendAdapter: r.factory as never,
      stillOrganizing: async (mailboxId) => { asked.push(mailboxId); return true; },
      now: () => NOW, mailboxIds: [w.mailboxId],
    });

    expect(out.sent).toBe(2);
    expect(r.delivered).toHaveLength(2);
    expect(asked, "the lease was not asked before the reservation and at the dial, per candidate")
      .toEqual([w.mailboxId, w.mailboxId, w.mailboxId, w.mailboxId]);
    expect(out.refusedNotOrganizer).toBe(0);
  });

  it("a caller that asks nothing is unchanged — every hosted host still answers", async () => {
    /* The hosted route and the self-host clock inject no `stillOrganizing`, so BOTH asks — before
       the reservation and at the dial — fall through there, and a release never happens. This is
       the dependency's default branch, and nothing else drives it. */
    const w = await world();
    await arrive(w);
    const r = recorder();

    const out = await runAwayResponderPass(w.db, {
      openSendAdapter: r.factory as never, now: () => NOW, mailboxIds: [w.mailboxId],
    });

    expect(out).toMatchObject({ sent: 1, refusedNotOrganizer: 0 });
    expect(r.delivered).toHaveLength(1);
  });

  it("a candidate with no send path costs no lease read — the ask sits after the transport", async () => {
    /* The order the comment at the call site states, measured rather than asserted in prose: the
       lease read is an IMAP round trip on the desktop door, and a candidate that is going to be
       deferred for want of a transport must not pay for one. */
    const w = await world();
    await arrive(w);
    let asked = 0;

    const out = await runAwayResponderPass(w.db, {
      openSendAdapter: async () => { throw new Error("no credentials for this mailbox"); },
      stillOrganizing: async () => { asked += 1; return true; },
      now: () => NOW, mailboxIds: [w.mailboxId],
    });

    expect(out.deferredCandidates).toBe(1);
    expect(asked, "the lease was read for a candidate that could never be sent").toBe(0);
  });
});

describe("the dial is bounded, and a breach ends where a throw ends", () => {
  it("a submission server that never answers does not hold the reservation open", async () => {
    const w = await world();
    const id = await arrive(w);
    const r = recorder({ hang: true });

    // The dial's bound on a FAKE clock, stepped over an in-memory store: the pass is released by
    // the bound and nothing else, and a pass that sat on the hung dial runs the stepping out.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let out: Awaited<ReturnType<typeof runAwayResponderPass>>;
    let took: number;
    try {
      const started = Date.now();
      let done = false;
      const pass = runAwayResponderPass(w.db, {
        openSendAdapter: r.factory as never,
        dialMs: 120,
        now: () => NOW, mailboxIds: [w.mailboxId],
      }).finally(() => { done = true; });
      for (let at = 0; !done && at < 10_000; at += 10) await vi.advanceTimersByTimeAsync(10);
      out = await pass;
      took = Date.now() - started;
      expect(took, "the pass sat on a hung dial").toBeLessThan(5_000);
    } finally {
      vi.useRealTimers();
    }
    expect(out).toMatchObject({ sent: 0, unverified: 1 });
    /* THE CLAIM STAYS, and that is the point rather than a concession: a send that did not finish
       may still have been delivered, so the ledger row is `unverified` — the same ending an SMTP
       throw takes — and no second copy is ever offered to this correspondent. */
    const [row] = await w.db.select().from(awayReplies).where(eq(awayReplies.messageId, id));
    expect(row!.outcome).toBe("unverified");
    expect(row!.sentAt).toBeNull();
    expect(row!.reason, "the reason does not name the deadline").toMatch(/AwayDialTimeout|within/);
  });

  it("THE POSITIVE CONTROL — a send inside the deadline is `sent`, and the bound refuses nothing", async () => {
    const w = await world();
    await arrive(w);
    const r = recorder();

    const out = await runAwayResponderPass(w.db, {
      openSendAdapter: r.factory as never,
      dialMs: 120,
      now: () => NOW, mailboxIds: [w.mailboxId],
    });

    expect(out).toMatchObject({ sent: 1, unverified: 0 });
    expect(r.delivered).toHaveLength(1);
  });

  it("the shipped deadline is thirty seconds", () => {
    /* The number lives in two places a reader and a gate each look at, and the failure this
       guards is the one `perf-budgets.json`'s own header records: two readers disagreeing about
       one ceiling with nothing to say so. The written half is `test/away-dial-deadline.docs.test.ts`. */
    expect(AWAY_DIAL_MS).toBe(30_000);
  });
});
