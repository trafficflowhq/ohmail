import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  folderState, mailboxes, messageBodies, unsubscribeDrainState, unsubscribeExamined, unsubscribeRecords,
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
  await db.insert(messageBodies).values({ messageId, text: "", headers: { ...CONFIRMED, ...headers } });
  await db.update(folderState).set({ updatedAt: at }).where(eq(folderState.messageId, messageId));
  return messageId;
}

const NOW = new Date("2026-07-28T12:00:00Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe("a message from a list already left is examined once", () => {
  it("the second run over that list looks at none of its messages, and says nothing is owed", async () => {
    const { db, accountId, mailboxId } = await makeCtx();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      // ONE list: the same `From` with no `List-ID` gives all three the same list key.
      ids.push(await seedAt(db, accountId, mailboxId, ONE_CLICK, "news@sender.example", ago(60_000 - i)));
    }
    const post = spy();
    const svc = svcWith(post);

    const first = await svc.drainScreenedOut(db, { now: () => NOW, requestId: "d1" });
    expect(first.sweep.posted, "the list is left once, from the oldest message").toBe(1);
    expect(first.sweep.considered, "all three are looked at on the first pass").toBe(3);
    expect(post.calls).toHaveLength(1);

    const second = await svc.drainScreenedOut(db, { now: () => NOW, requestId: "d2" });
    // THE ROW, CLOSED. Before this change the second run considered 2, spent five statements on
    // each of them — the loads, the organizer read, an `update messages set auth_verdict`, the
    // conflicting insert and its read-back — and answered `remaining` 2 for ever.
    expect(second.sweep.considered, "a list already left costs the next run nothing").toBe(0);
    expect(post.calls, "and nothing is posted a second time").toHaveLength(1);
    expect(second.remaining, "…and `remaining` stops naming work nobody will ever do").toBe(0);

    // The mark is per MESSAGE and carries the record it was judged against.
    const marks = await db.select({ m: unsubscribeExamined.messageId, r: unsubscribeExamined.recordId })
      .from(unsubscribeExamined);
    expect(marks.map((x) => x.m).sort()).toEqual([...ids].sort());
    const [record] = await db.select().from(unsubscribeRecords);
    expect(new Set(marks.map((x) => x.r))).toEqual(new Set([record!.id]));
  });

  it("a message nobody has judged yet is still a candidate — the admitting half", async () => {
    const { db, accountId, mailboxId } = await makeCtx();
    await seedAt(db, accountId, mailboxId, ONE_CLICK, "a@sender.example", ago(60_000));
    const post = spy();
    const svc = svcWith(post);
    await svc.drainScreenedOut(db, { now: () => NOW, requestId: "d1" });
    expect(post.calls).toHaveLength(1);

    // A DIFFERENT list, arriving after the first pass: the mark closes the list it was written
    // for and nothing else. A refusal rule with no admission is a rule that says "everything".
    await seedAt(db, accountId, mailboxId, ONE_CLICK, "b@elsewhere.example", ago(30_000));
    const second = await svc.drainScreenedOut(db, { now: () => NOW, requestId: "d2" });
    expect(second.sweep.posted).toBe(1);
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

describe("the window walk resumes where it stopped", () => {
  /**
   * The head is a candidate the pass looks at and can never act on, and `accounts * perAccount` is
   * 1 — so one run takes exactly that row and stops. Before the cursor every run took the same
   * row, posted nothing, and the two real candidates behind it were reached by nobody.
   */
  async function window3(db: Db, accountId: string, mailboxId: string): Promise<string[]> {
    return [
      await seedAt(db, accountId, mailboxId, STICKY, "stuck@sender.example", ago(600_000)),
      await seedAt(db, accountId, mailboxId, ONE_CLICK, "one@sender.example", ago(599_000)),
      await seedAt(db, accountId, mailboxId, ONE_CLICK, "two@sender.example", ago(598_000)),
    ];
  }

  it("reaches the rows behind a head it cannot act on, one run at a time", async () => {
    const { db, accountId, mailboxId } = await makeCtx();
    await window3(db, accountId, mailboxId);
    const post = spy();
    const svc = svcWith(post);

    const posted: number[] = [];
    for (let r = 0; r < 4; r += 1) {
      const out = await svc.drainScreenedOut(db, {
        now: () => NOW, requestId: `d${r}`, accounts: 1, perAccount: 1,
      });
      posted.push(out.sweep.posted);
    }
    // Run 0 spends its one slot on the head and posts nothing; runs 1 and 2 reach the two behind
    // it; run 3 finds the lap over. Before the cursor this read [0, 0, 0, 0].
    expect(posted).toEqual([0, 1, 1, 0]);
    expect(post.calls).toHaveLength(2);
  });

  it("a lap that reaches the end of the window clears the cursor, so the next one starts at the head", async () => {
    const { db, accountId, mailboxId } = await makeCtx();
    await seedAt(db, accountId, mailboxId, STICKY, "stuck@sender.example", ago(600_000));
    const svc = svcWith(spy());
    // One row, one slot: the walk takes it and stops, so the cursor points at it.
    await svc.drainScreenedOut(db, { now: () => NOW, requestId: "d0", accounts: 1, perAccount: 1 });
    const [afterTake] = await db.select().from(unsubscribeDrainState);
    expect(afterTake!.cursorMessageId, "the walk stopped on the row it took").not.toBeNull();
    expect(afterTake!.cursorAt).not.toBeNull();

    // The next run finds nothing past it and reaches the end of the window: the lap is over.
    await svc.drainScreenedOut(db, { now: () => NOW, requestId: "d1", accounts: 1, perAccount: 1 });
    const [afterLap] = await db.select().from(unsubscribeDrainState);
    expect(afterLap!.cursorMessageId, "a finished lap starts the next one at the head").toBeNull();
    expect(afterLap!.cursorAt).toBeNull();
  });

  it("a run that dies in its walk leaves the cursor where the last run ENDED", async () => {
    const { db, accountId, mailboxId } = await makeCtx();
    await window3(db, accountId, mailboxId);
    const svc = svcWith(spy());
    await svc.drainScreenedOut(db, { now: () => NOW, requestId: "d0", accounts: 1, perAccount: 1 });
    const [ended] = await db.select().from(unsubscribeDrainState);
    const at = ended!.cursorAt;
    const messageId = ended!.cursorMessageId;
    expect(messageId).not.toBeNull();

    /**
     * A RUN THAT DIES INSIDE ITS WALK. The window read is failed, so the pass throws before it has
     * looked at anything and before its closing write — and the cursor is the last END, not this
     * run's guess. Written at the END and never at the start, which is the mutation this arm
     * watches; the per-page half needs a walk of more than one chunk and lives in the pg twin,
     * where a window of more than one page of rows can be seeded.
     */
    let walkReads = 0;
    const realSelect = db.select.bind(db) as (...a: never[]) => unknown;
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "select") return Reflect.get(target, prop, receiver);
        return (...args: never[]) => {
          // The chunk's OUTER read is the only select naming `eligible`, and the work walk takes
          // the first of them.
          const fields = args[0] as Record<string, unknown> | undefined;
          if (fields !== undefined && "eligible" in fields && (walkReads += 1) === 1) {
            return { from: () => { throw new Error("the window read died"); } };
          }
          return realSelect(...args);
        };
      },
    }) as typeof db;

    await expect(svc.drainScreenedOut(failing, {
      now: () => NOW, requestId: "d1", accounts: 1, perAccount: 1,
    })).rejects.toThrow("the window read died");

    const [afterDeath] = await db.select().from(unsubscribeDrainState);
    expect(afterDeath!.cursorMessageId, "a dead run does not move the cursor").toBe(messageId);
    expect((afterDeath!.cursorAt as Date).getTime()).toBe((at as Date).getTime());
  });
});

/**
 * A REFUSAL OF THE PROVIDER'S WORD LEAVES THE WINDOW. The automatic arm refuses a sender its
 * mailbox's provider did not confirm BEFORE the claim, so no record and no examined mark is written:
 * eligibility alone has to drop it, or the same oldest refusals take the account's slots at every
 * run and a confirmed letter behind them in another mailbox is never reached.
 */
describe("a sender the provider did not confirm is not a drain candidate", () => {
  const NOBODY: ReadonlySet<string> = new Set<string>();

  async function twoMailboxes() {
    const { db, accountId, mailboxId: unmapped } = await makeCtx();
    const [g] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "mila@gmail.example" }).returning();
    const gmail = g!.id;
    const post = spy();
    const svc = makeUnsubscribeService({
      post, resolver: PUBLIC_DNS,
      trustedAuthservIdsFor: async (_tx, mb) => (mb === gmail ? GMAIL : NOBODY),
    });
    return { db, accountId, unmapped, gmail, post, svc };
  }

  /** A screened-out one-click letter, its verdict as ingest stored it (NULL: never asked). */
  async function letter(
    db: Db, accountId: string, mailboxId: string, from: string, tag: string, at: Date, authVerdict: string | null,
  ): Promise<string> {
    const messageId = await seedMessage(db, accountId, mailboxId, { from, folder: "ohmail/Screened", authVerdict });
    await personScreenedOut(db, accountId, from);
    await db.insert(messageBodies).values({ messageId, text: "", headers: {
      ...CONFIRMED,
      "list-unsubscribe": [`<https://sender.example/u?t=${tag}>`],
      "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
    } });
    await db.update(folderState).set({ updatedAt: at }).where(eq(folderState.messageId, messageId));
    return messageId;
  }

  it("refusals at an unmapped host ahead of a confirmed letter: the confirmed one posts on the first run", async () => {
    const w = await twoMailboxes();
    for (let i = 0; i < 12; i += 1) {
      await letter(w.db, w.accountId, w.unmapped, `news${i}@list-${i}.example`, `u${i}`, ago(3_600_000 - i), "unavailable");
    }
    await letter(w.db, w.accountId, w.gmail, "letters@confirmed.example", "gmail", ago(1_800_000), "pass");

    const run = await w.svc.drainScreenedOut(w.db, { now: () => NOW, requestId: "d1" });
    expect(w.post.calls).toEqual(["https://sender.example/u?t=gmail"]);
    expect(run.sweep).toMatchObject({ considered: 1, posted: 1 });
    expect(run.remaining, "a refused letter is not counted as owed").toBe(0);
  });

  it("a letter nobody judged yet is looked at once, then leaves the window with the verdict it got", async () => {
    const w = await twoMailboxes();
    for (let i = 0; i < 12; i += 1) {
      await letter(w.db, w.accountId, w.unmapped, `news${i}@list-${i}.example`, `u${i}`, ago(3_600_000 - i), null);
    }
    await letter(w.db, w.accountId, w.gmail, "letters@confirmed.example", "gmail", ago(1_800_000), null);

    const first = await w.svc.drainScreenedOut(w.db, { now: () => NOW, requestId: "d1" });
    expect(first.sweep).toMatchObject({ considered: 10, posted: 0, skipped: 10 });
    const second = await w.svc.drainScreenedOut(w.db, { now: () => NOW, requestId: "d2" });
    expect(second.sweep, "the ten refused at the first look are not looked at again").toMatchObject({ considered: 3, posted: 1 });
    expect(w.post.calls).toEqual(["https://sender.example/u?t=gmail"]);
    expect(second.remaining).toBe(0);
    const third = await w.svc.drainScreenedOut(w.db, { now: () => NOW, requestId: "d3" });
    expect(third.sweep.considered).toBe(0);
  });
});
