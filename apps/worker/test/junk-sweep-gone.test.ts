import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, folderState, mailboxes, messageBodies, messageInstances, messages, type Tx } from "@trafficflow/db";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import {
  MessageGoneError, type MailboxAdapter, type MoveManyResult, type SpecialFolders,
} from "@trafficflow/core/adapters/imap";
import type { NativeLocator } from "@trafficflow/core";
import { junkSweepPass, SWEEP_GONE_REASON, SWEEP_UNMAPPED_REASON } from "../src/junk-sweep.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * ARM 2, PRODUCER HALF — **THE SWEEP MUST DISTINGUISH "THE SERVER REFUSED THIS"
 * FROM "THIS IS NOT WHERE WE THOUGHT".**
 *
 * The consumer half is in `junk-sweep-command.test.ts`: `sync.ts` retires a user's one-time press
 * when a full scan moved nothing, on the reading that the server refuses every member. That
 * reading is what makes the distinction load-bearing here — the sweep is the only thing that knows
 * which of the two happened, and until now it flattened both into an ordinary `skipped` entry
 * carrying `"${err.name}: ${err.message}"`.
 *
 * A provider recreating `ohmail/Quarantine` between the mirror's last scan and the sweep makes
 * EVERY member fail at once, with a refusal that clears itself on the next `changesSince`. Reported
 * as a plain skip that is indistinguishable from a pile the server will not move, and the press was
 * thrown away.
 *
 * Also asserted: the reason string a deferred member carries is the same sentence the BATCHED arm
 * already used for the same fact. Two words for one condition is how an operator comes to believe
 * they are two conditions.
 */

const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });

async function seed(db: Awaited<ReturnType<typeof makeTestDb>>, count = 3) {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `gone-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `gone-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id,
      dedupKey: `mid:<gone-${accountId.slice(0, 8)}-${i}@x>`, bodyHash: `h${i}`,
      subject: `old spam ${i}`, fromAddress: "spammer@example.test",
      nativeLocator: LOC("ohmail/Quarantine", `12:${50 + i}`),
    }).returning();
    await db.insert(messageInstances).values({
      accountId, messageId: m!.id, mailboxId: mb!.id, folder: "ohmail/Quarantine",
      uid: 50 + i, uidvalidity: 12n, isPrimary: true,
    });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/Quarantine", observedFolder: "ohmail/Quarantine",
      lastSetBy: "us", reconcileStatus: "reconciled",
    });
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: `buy things ${i}` });
    ids.push(m!.id);
  }
  return { accountId, mailboxId: mb!.id, ids };
}

/**
 * No `moveMany` at all, so the pass takes its per-message fallback — which is the arm the row
 * named (`junk-sweep.ts:200`) and the one an epoch refusal actually reaches, because `moveMany`
 * DECLINES a mixed-epoch group rather than moving it.
 */
function adapterOf(opts: {
  goneRefs: Set<string>; refuse?: Error;
  /** Give the double a batch, so the sweep's batched arm is the one under test. */
  moveManyAnswer?: MoveManyResult;
}) {
  const moved: string[] = [];
  const adapter = {
    findSpecialFolders: async (): Promise<SpecialFolders> => ({ junk: "INBOX/Junk", trash: null }),
    ...(opts.moveManyAnswer === undefined ? {} : {
      moveMany: async (): Promise<MoveManyResult> => opts.moveManyAnswer!,
    }),
    move: async (loc: NativeLocator, toFolder: string) => {
      if (opts.goneRefs.has(loc.ref)) throw new MessageGoneError(loc);
      if (opts.refuse) throw opts.refuse;
      moved.push(loc.ref);
      return { folder: toFolder, ref: `19:${900 + moved.length}` };
    },
    setFlags: async () => {},
  } as unknown as MailboxAdapter;
  return { adapter, moved };
}

const repoOf = (db: Awaited<ReturnType<typeof makeTestDb>>) =>
  makeDrizzleRepo(db as unknown as Tx) as unknown as WorkerRepo & {
    transaction: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T>;
  };

describe("the sweep tells a stale locator from a refused move", () => {
  it("a WHOLESALE epoch refusal reports every member as DEFERRED, not as a pile the server refuses", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seed(db);
    const { adapter, moved } = adapterOf({ goneRefs: new Set(["12:50", "12:51", "12:52"]) });

    const res = await junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(db), adapter, accountId, mailboxId, execute: true, writeAuthority: { lease: FIXTURE_LEASE },
    });

    expect(moved).toEqual([]);
    expect(res.moved).toEqual([]);
    // THE NUMBER THE RETIREMENT DECISION READS. Zero here is the shipped defect: `sync.ts` then
    // sees a full scan that moved nothing and retires the user's press.
    expect(res.deferred).toBe(3);
    expect(res.skipped).toHaveLength(3);
    // ONE SENTENCE FOR ONE CONDITION — the same words the batched arm uses when a UID is simply
    // absent from the move map, which is the identical fact arriving by a different route. Shared
    // as a constant so the two arms cannot drift into describing one condition two ways.
    for (const s of res.skipped) {
      expect(s.reason).toBe(SWEEP_GONE_REASON);
    }
    // AND IT IS CONDITIONAL. `MessageGoneError` covers a permanently deleted message as much as a
    // moved one, so a reason asserting that the next scan adopts it — which this said — promises
    // an adoption that may never come. An operator reading a skip needs the possibility, not a
    // guarantee.
    expect(SWEEP_GONE_REASON).toContain("if it still exists");
    expect(SWEEP_GONE_REASON).not.toContain("sync adopts it");
  });

  it("a REFUSED move is still not deferred — the count means one thing", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seed(db, 2);
    const { adapter } = adapterOf({ goneRefs: new Set(), refuse: new Error("[NO] mailbox is read-only") });

    const res = await junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(db), adapter, accountId, mailboxId, execute: true, writeAuthority: { lease: FIXTURE_LEASE },
    });

    expect(res.moved).toEqual([]);
    // ZERO. A server that will not accept these messages is exactly the case the retirement rule
    // was written for, and this arm must keep licensing it — a `deferred` that crept up on any
    // failure would make the command un-retirable and re-kick the mailbox for ever.
    expect(res.deferred).toBe(0);
    expect(res.skipped[0]!.reason).toContain("mailbox is read-only");
  });

  it("a MIXED window counts only the stale ones, and the healthy members still move", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seed(db, 3);
    const { adapter, moved } = adapterOf({ goneRefs: new Set(["12:51"]) });

    const res = await junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(db), adapter, accountId, mailboxId, execute: true, writeAuthority: { lease: FIXTURE_LEASE },
    });

    expect(moved.sort()).toEqual(["12:50", "12:52"]);
    expect(res.moved).toHaveLength(2);
    expect(res.deferred).toBe(1);
  });

  /**
   * THE BATCH'S THIRD ANSWER, which is the same fact as a stale locator reached by a third route:
   * the server moved the group and would not say where. The mail IS in Junk. Re-filing each
   * member would spend a command on an empty source and report landed work as a refusal, and a
   * `deferred` of zero would let `sync.ts` retire the person's one-time press on a scan that
   * "moved nothing".
   */
  it("a batch that MOVED and would not map defers every member and re-files none", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seed(db, 3);
    const { adapter, moved } = adapterOf({
      goneRefs: new Set(),
      moveManyAnswer: { outcome: "moved_unmapped", moved: new Map(), gone: [] },
    });

    const res = await junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(db), adapter, accountId, mailboxId, execute: true, writeAuthority: { lease: FIXTURE_LEASE },
    });

    expect(moved, "the per-message fallback must not run over mail that has moved").toEqual([]);
    expect(res.moved).toEqual([]);
    expect(res.deferred, "zero here retires the press over landed work").toBe(3);
    for (const s of res.skipped) expect(s.reason).toBe(SWEEP_UNMAPPED_REASON);
  });

  it("POSITIVE CONTROL — a DECLINED batch still takes the per-message path and files the mail", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seed(db, 3);
    const { adapter, moved } = adapterOf({
      goneRefs: new Set(),
      moveManyAnswer: { outcome: "declined", moved: new Map(), gone: [] },
    });

    const res = await junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(db), adapter, accountId, mailboxId, execute: true, writeAuthority: { lease: FIXTURE_LEASE },
    });

    expect(moved).toHaveLength(3);
    expect(res.moved).toHaveLength(3);
    expect(res.deferred).toBe(0);
  });

  it("a dry run reports no deferrals because it attempts nothing — the default an operator lands on", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seed(db, 2);
    const { adapter, moved } = adapterOf({ goneRefs: new Set(["12:50", "12:51"]) });

    const res = await junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(db), adapter, accountId, mailboxId, execute: false, writeAuthority: { lease: FIXTURE_LEASE },
    });

    expect(res.dryRun).toBe(true);
    expect(moved).toEqual([]);
    expect(res.deferred).toBe(0);
    expect(res.candidates).toHaveLength(2);
  });
});
