import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  folderState, mailboxes, messageBodies, messages, unsubscribeDrainState, unsubscribeExamined, unsubscribeRecords, bindDb, UNSUB_DRAIN_PASS,
} from "@trafficflow/db";
import {
  makeUnsubscribeService, type HostResolver, type OneClickPost,
} from "../src/index.js";
import { makeCtx, personScreenedOut, seedMessage } from "./helpers.js";

/**
 * THE DRAIN REMEMBERS — the two rows `fix-0191-unsubscribe-drain-timeout` filed as needing a
 * schema change, closed here and measured rather than argued.
 *
 * A record row is keyed `(mailbox, list)`. The SECOND message of a list already left therefore had
 * no row of its own, so the pass looked at it at every tick — five statements a message, one of
 * them a write to `messages` — and counted it as still owed. And the window walk restarted at the
 * head at every tick, so a candidate the pass can look at and never act on held the head and the
 * rows behind it were reached by nobody.
 */

const PUBLIC_DNS: HostResolver = { async resolve() { return ["93.184.216.34"]; } };
/**
 * The position a Gmail-held mailbox trusts (`providerAuthservIds`), and that provider confirming a
 * row's sender, which the seed writes: the drain asks a list only for a confirmed sender.
 */
const GMAIL: ReadonlySet<string> = new Set(["mx.google.com"]);
const CONFIRMED = { "authentication-results": ["mx.google.com; dmarc=pass"] };

const ONE_CLICK = {
  "list-unsubscribe": ["<https://sender.example/u?t=abc>"],
  "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
};
/**
 * PASSES THE WALK AND IS REFUSED BEFORE THE CLAIM. Both header KEYS are there, which is all the
 * chunk's eligibility asks, and `run()` then finds no `https` route and refuses without writing a
 * record — so this message is a candidate for ever. It is the shape that held the head.
 */
const STICKY = {
  "list-unsubscribe": ["<mailto:leave@sender.example>"],
  "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
};

type Db = Awaited<ReturnType<typeof makeCtx>>["db"];

function spy(): OneClickPost & { calls: string[] } {
  const calls: string[] = [];
  return { calls, async post(url: string) { calls.push(url); return { status: 200 }; } };
}

const svcWith = (post: OneClickPost) =>
  makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => GMAIL });

/** Seed one screened-out candidate at an exact position in the walk's `(updated_at, id)` order. */
async function seedAt(
  db: Db, accountId: string, mailboxId: string,
  headers: Record<string, string[]>, from: string, at: Date,
): Promise<string> {
  const messageId = await seedMessage(db, accountId, mailboxId, { from, folder: "ohmail/Screened" });
  await personScreenedOut(db, accountId, from);
  await db.insert(messageBodies).values({ messageId, accountId, text: "", headers: { ...CONFIRMED, ...headers } });
  await db.update(folderState).set({ updatedAt: at }).where(eq(folderState.messageId, messageId));
  return messageId;
}

const NOW = new Date("2026-07-28T12:00:00Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe("a message from a list already left is examined once", () => {
  it("the second run over that list looks at none of its messages, and says nothing is owed", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      // ONE list: the same `From` with no `List-ID` gives all three the same list key.
      ids.push(await seedAt(db, accountId, mailboxId, ONE_CLICK, "news@sender.example", ago(60_000 - i)));
    }
    const post = spy();
    const svc = svcWith(post);

    const first = await svc.onScreenOut({ ...ctx, now: () => NOW }, ids);
    expect(first.posted, "the list is left once, from the oldest message").toBe(1);
    expect(first.considered, "all three are looked at on the first pass").toBe(3);
    expect(post.calls).toHaveLength(1);

    const second = await svc.drainScreenedOut(bindDb(db, { account: null }), { now: () => NOW, requestId: "d2" });
    expect(second.sweep.considered, "a list already left costs the next run nothing").toBe(0);
    expect(post.calls, "and nothing is posted a second time").toHaveLength(1);
    expect(second.remaining, "…and `remaining` stops naming work nobody will ever do").toBe(0);

    // The mark is per MESSAGE and carries the record it was judged against.
    const marks = await db.select({ m: unsubscribeExamined.messageId, r: unsubscribeExamined.recordId })
      .from(unsubscribeExamined);
    expect(marks.map((x) => x.m).sort()).toEqual([...ids].sort());
    const [record] = await db.select().from(unsubscribeRecords);
    expect(record?.messageId).toBe(ids[0]);
    expect(new Set(marks.map((x) => x.r))).toEqual(new Set([record!.id]));
  });

  it("a newly confirmed message from another list still sends", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const firstId = await seedAt(db, accountId, mailboxId, ONE_CLICK, "a@sender.example", ago(60_000));
    const post = spy();
    const svc = svcWith(post);
    expect((await svc.onScreenOut({ ...ctx, now: () => NOW }, [firstId])).posted).toBe(1);
    expect(post.calls).toHaveLength(1);

    // A DIFFERENT list, arriving after the first pass: the mark closes the list it was written
    // for and nothing else. A refusal rule with no admission is a rule that says "everything".
    const secondId = await seedAt(db, accountId, mailboxId, ONE_CLICK, "b@elsewhere.example", ago(30_000));
    const tick = await svc.drainScreenedOut(bindDb(db, { account: null }), { now: () => NOW, requestId: "d2" });
    expect(tick.sweep.posted).toBe(0);
    expect(post.calls).toHaveLength(1);
    expect((await svc.onScreenOut({ ...ctx, now: () => NOW }, [secondId])).posted).toBe(1);
    expect(post.calls).toHaveLength(2);
  });

  it("a person's press leaves no mark — it is not the pass", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedAt(db, accountId, mailboxId, ONE_CLICK, "c@sender.example", ago(60_000));
    const post = spy();
    await svcWith(post).unsubscribe({ ...ctx, now: () => NOW }, id);
    expect(post.calls).toHaveLength(1);
    expect(await db.select().from(unsubscribeExamined)).toHaveLength(0);
  });
});

describe("confirmed requests bypass the retired cursor", () => {
  async function window3(db: Db, accountId: string, mailboxId: string): Promise<[string, string, string]> {
    return [
      await seedAt(db, accountId, mailboxId, STICKY, "stuck@sender.example", ago(600_000)),
      await seedAt(db, accountId, mailboxId, ONE_CLICK, "one@sender.example", ago(599_000)),
      await seedAt(db, accountId, mailboxId, ONE_CLICK, "two@sender.example", ago(598_000)),
    ];
  }

  it("an ineligible head does not hold up later, separately confirmed requests", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx(NOW);
    const [head, first, second] = await window3(db, accountId, mailboxId);
    const post = spy();
    const svc = svcWith(post);
    const tick = () => svc.drainScreenedOut(bindDb(db, { account: null }), { now: () => NOW, requestId: "tick" });

    expect(await svc.onScreenOut(ctx, [head])).toEqual({ considered: 1, posted: 0, skipped: 1, failed: 0, remaining: 0 });
    expect((await tick()).sweep.posted).toBe(0);
    expect(post.calls).toEqual([]);
    expect(await svc.onScreenOut(ctx, [first])).toEqual({ considered: 1, posted: 1, skipped: 0, failed: 0, remaining: 0 });
    expect(await svc.onScreenOut(ctx, [second])).toEqual({ considered: 1, posted: 1, skipped: 0, failed: 0, remaining: 0 });
    expect((await tick()).sweep.posted).toBe(0);
    expect(post.calls).toHaveLength(2);

    const sent = await db.select({ messageId: unsubscribeRecords.messageId }).from(unsubscribeRecords);
    expect(sent.map((row) => row.messageId).sort()).toEqual([first, second].sort());
    expect(await db.select().from(unsubscribeDrainState)).toEqual([]);
  });

  it("polling to the end of a retired window leaves its stored cursor untouched", async () => {
    const { db, accountId, mailboxId } = await makeCtx(NOW);
    const [id] = await window3(db, accountId, mailboxId);
    const [old] = await db.insert(unsubscribeDrainState).values({
      pass: UNSUB_DRAIN_PASS, cursorMessageId: id, cursorAt: ago(600_000), updatedAt: ago(300_000),
    }).returning();
    const post = spy();
    const svc = svcWith(post);
    for (const requestId of ["d0", "d1"]) {
      const run = await svc.drainScreenedOut(bindDb(db, { account: null }), { now: () => NOW, requestId, accounts: 1, perAccount: 1 });
      expect(run).toEqual({ accounts: 0, sweep: { considered: 0, posted: 0, skipped: 0, failed: 0, remaining: 0 }, remaining: 0, elapsedMs: 0 });
      expect(await db.select().from(unsubscribeDrainState)).toEqual([old]);
    }
    expect(post.calls).toEqual([]);
    expect(await db.select().from(unsubscribeRecords)).toEqual([]);
  });

  it("a failed confirmed delivery records the failure without advancing a stored cursor", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx(NOW);
    const [head, first] = await window3(db, accountId, mailboxId);
    const [old] = await db.insert(unsubscribeDrainState).values({
      pass: UNSUB_DRAIN_PASS, cursorMessageId: head, cursorAt: ago(600_000), updatedAt: ago(300_000),
    }).returning();
    let attempted = 0;
    const svc = svcWith({ async post() { attempted += 1; throw new Error("the confirmed delivery died"); } });

    expect(await svc.onScreenOut(ctx, [first])).toEqual({ considered: 1, posted: 0, skipped: 0, failed: 1, remaining: 0 });
    const records = await db.select({ messageId: unsubscribeRecords.messageId, state: unsubscribeRecords.state }).from(unsubscribeRecords);
    expect(records).toEqual([{ messageId: first, state: "failed" }]);
    const tick = await svc.drainScreenedOut(bindDb(db, { account: null }), { now: () => NOW, requestId: "tick" });
    expect(tick.sweep.posted).toBe(0);
    expect(attempted).toBe(1);
    expect(await db.select().from(unsubscribeDrainState)).toEqual([old]);
  });
});

/**
 * A REFUSAL OF THE PROVIDER'S WORD LEAVES THE WINDOW. The automatic arm refuses a sender its
 * mailbox's provider did not confirm BEFORE the claim, so no record and no examined mark is written:
 * eligibility alone has to drop it, or the same oldest refusals take the account's slots at every
 * run and a confirmed letter behind them in another mailbox is never reached.
 */
describe("confirmed batches check sender identity under each mailbox", () => {
  const NOBODY: ReadonlySet<string> = new Set<string>();

  async function twoMailboxes() {
    const { db, ctx, accountId, mailboxId: unmapped } = await makeCtx();
    const [g] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "mila@gmail.example" }).returning();
    const gmail = g!.id;
    const post = spy();
    const svc = makeUnsubscribeService({
      post, resolver: PUBLIC_DNS,
      trustedAuthservIdsFor: async (_tx, mb) => (mb === gmail ? GMAIL : NOBODY),
    });
    return { db, ctx: { ...ctx, now: () => NOW }, accountId, unmapped, gmail, post, svc };
  }

  /** A screened-out one-click letter, its verdict as ingest stored it (NULL: never asked). */
  async function letter(
    db: Db, accountId: string, mailboxId: string, from: string, tag: string, at: Date, authVerdict: string | null,
  ): Promise<string> {
    const messageId = await seedMessage(db, accountId, mailboxId, { from, folder: "ohmail/Screened", authVerdict });
    await personScreenedOut(db, accountId, from);
    await db.insert(messageBodies).values({ messageId, accountId, text: "", headers: {
      ...CONFIRMED,
      "list-unsubscribe": [`<https://sender.example/u?t=${tag}>`],
      "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
    } });
    await db.update(folderState).set({ updatedAt: at }).where(eq(folderState.messageId, messageId));
    return messageId;
  }

  it("a confirmed letter can send while older unverified letters remain untouched", async () => {
    const w = await twoMailboxes();
    for (let i = 0; i < 12; i += 1) {
      await letter(w.db, w.accountId, w.unmapped, `news${i}@list-${i}.example`, `u${i}`, ago(3_600_000 - i), "unavailable");
    }
    const confirmed = await letter(w.db, w.accountId, w.gmail, "letters@confirmed.example", "gmail", ago(1_800_000), "pass");

    const tick = await w.svc.drainScreenedOut(bindDb(w.db, { account: null }), { now: () => NOW, requestId: "d1" });
    expect(tick.sweep.considered).toBe(0);
    expect(w.post.calls).toEqual([]);
    const run = await w.svc.onScreenOut(w.ctx, [confirmed]);
    expect(w.post.calls).toEqual(["https://sender.example/u?t=gmail"]);
    expect(run).toMatchObject({ considered: 1, posted: 1 });
    expect(run.remaining, "a refused letter is not counted as owed").toBe(0);
  });

  it("only the named confirmation batches change the stored sender verdicts", async () => {
    const w = await twoMailboxes();
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      ids.push(await letter(w.db, w.accountId, w.unmapped, `news${i}@list-${i}.example`, `u${i}`, ago(3_600_000 - i), null));
    }
    const confirmed = await letter(w.db, w.accountId, w.gmail, "letters@confirmed.example", "gmail", ago(1_800_000), null);

    for (const batch of [ids.slice(0, 5), ids.slice(5, 10)]) {
      expect(await w.svc.onScreenOut(w.ctx, batch)).toMatchObject({ considered: 5, posted: 0, skipped: 5 });
    }
    const verdict = async (id: string) =>
      (await w.db.select({ value: messages.authVerdict }).from(messages).where(eq(messages.id, id)))[0]?.value;
    expect(await Promise.all(ids.slice(0, 10).map(verdict))).toEqual(Array<string>(10).fill("unavailable"));
    expect(await Promise.all([...ids.slice(10), confirmed].map(verdict))).toEqual([null, null, null]);
    const second = await w.svc.onScreenOut(w.ctx, [...ids.slice(10), confirmed]);
    expect(second).toMatchObject({ considered: 3, posted: 1, skipped: 2 });
    expect(await Promise.all([...ids.slice(10), confirmed].map(verdict))).toEqual(["unavailable", "unavailable", "pass"]);
    expect(w.post.calls).toEqual(["https://sender.example/u?t=gmail"]);
    expect(second.remaining).toBe(0);
    const third = await w.svc.drainScreenedOut(bindDb(w.db, { account: null }), { now: () => NOW, requestId: "d3" });
    expect(third.sweep.considered).toBe(0);
  });
});

/**
 * A SENDER INGEST CONFIRMED BY ITS OWN SIGNATURE. Where a mailbox's provider writes nothing ohmail
 * believes, the plan step stores the local check's `pass`; the request re-derives the verdict from
 * the stored headers, which say nothing there, and must keep that `pass` rather than overwrite it.
 * A mailbox whose provider is named re-derives from its header exactly as before.
 */
describe("a letter whose sender's signature ingest checked", () => {
  const NOBODY: ReadonlySet<string> = new Set<string>();
  const ONE_CLICK_TO = (tag: string) => ({
    "list-unsubscribe": [`<https://sender.example/u?t=${tag}>`],
    "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
  });

  async function world() {
    const { db, accountId, mailboxId: unmapped, ctx } = await makeCtx();
    const [g] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "mila@gmail.example" }).returning();
    const gmail = g!.id;
    const post = spy();
    const svc = makeUnsubscribeService({
      post, resolver: PUBLIC_DNS,
      trustedAuthservIdsFor: async (_tx, mb) => (mb === gmail ? GMAIL : NOBODY),
    });
    return { db, accountId, unmapped, gmail, post, svc, ctx };
  }

  async function screenedOut(
    db: Db, accountId: string, mailboxId: string, from: string, tag: string, authVerdict: string | null,
  ): Promise<string> {
    const messageId = await seedMessage(db, accountId, mailboxId, { from, folder: "ohmail/Screened", authVerdict });
    await personScreenedOut(db, accountId, from);
    await db.insert(messageBodies).values({ messageId, accountId, text: "", headers: ONE_CLICK_TO(tag) });
    await db.update(folderState).set({ updatedAt: ago(60_000) }).where(eq(folderState.messageId, messageId));
    return messageId;
  }

  const stored = async (db: Db, id: string) =>
    (await db.select({ v: messages.authVerdict }).from(messages).where(eq(messages.id, id)))[0]!.v;

  it("at a mailbox no provider entry names, a stored pass is unsubscribed for and kept", async () => {
    const w = await world();
    const id = await screenedOut(w.db, w.accountId, w.unmapped, "news@signed.example", "signed", "pass");
    const run = await w.svc.onScreenOut({ ...w.ctx, now: () => NOW }, [id]);
    expect(w.post.calls).toEqual(["https://sender.example/u?t=signed"]);
    expect(run).toMatchObject({ considered: 1, posted: 1 });
    expect(await stored(w.db, id), "the request overwrote the signature's pass").toBe("pass");
  });

  it("a stored NULL there is still refused, and reads unavailable", async () => {
    const w = await world();
    const id = await screenedOut(w.db, w.accountId, w.unmapped, "news@unsigned.example", "unsigned", null);
    const run = await w.svc.onScreenOut({ ...w.ctx, now: () => NOW }, [id]);
    expect(w.post.calls).toEqual([]);
    expect(run).toMatchObject({ considered: 1, posted: 0, skipped: 1 });
    expect(await stored(w.db, id)).toBe("unavailable");
  });

  it("at a Gmail mailbox a stored pass is read from the stored headers, as before", async () => {
    const w = await world();
    const id = await screenedOut(w.db, w.accountId, w.gmail, "news@gmail-held.example", "gmail", "pass");
    await w.svc.onScreenOut({ ...w.ctx, now: () => NOW }, [id]);
    expect(w.post.calls, "Gmail's header is not on the letter, so its provider did not confirm it").toEqual([]);
    expect(await stored(w.db, id)).toBe("unavailable");
  });

  it("a person's press on the signed letter keeps the pass too", async () => {
    const w = await world();
    const id = await screenedOut(w.db, w.accountId, w.unmapped, "news@pressed.example", "pressed", "pass");
    const res = await w.svc.unsubscribe({ ...w.ctx, now: () => NOW }, id);
    expect(res).toMatchObject({ posted: true, authVerdict: "pass" });
    expect(await stored(w.db, id)).toBe("pass");
  });
});
