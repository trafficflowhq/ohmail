import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, folderState, mailboxes, messageBodies, messageInstances, messages, type Tx } from "@trafficflow/db";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { MailboxAdapter, SpecialFolders } from "@trafficflow/core/adapters/imap";
import type { NativeLocator } from "@trafficflow/core";
import {
  adoptSweepWindow, junkSweepPass, sweepStateForPress, SWEEP_SCAN_START,
  SWEEP_MAX_DEFERRED_SCANS,
} from "../src/junk-sweep.js";
import type { MailboxWriteAuthority } from "../src/lease.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * THE SWEEP IS EXPLICIT, DRY-RUN BY DEFAULT, AND CLAIMS NOTHING THE SERVER DID NOT DO.
 *
 * Three properties, one per test: a dry run WRITES NOTHING and MOVES NOTHING (the default an
 * operator lands on); an executed sweep runs the live path's exact completion (parked locator,
 * satisfied folder_state, `junk_filed` husk) for members the move named; a mailbox with no
 * native \Junk moves nothing at all — the sweep never invents a folder.
 *
 * Mutation watched (restored, 2026-08-22): make the dry-run branch fall through into the move
 * loop ⇒ the dry-run test red (adapter asked to move; folder_state rewritten).
 */

const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });

async function seed(db: Awaited<ReturnType<typeof makeTestDb>>) {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `sw-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `sw-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id,
      dedupKey: `mid:<sw-${accountId.slice(0, 8)}-${i}@x>`, bodyHash: `h${i}`,
      subject: `old spam ${i}`, fromAddress: "spammer@example.test",
      nativeLocator: LOC("ohmail/Quarantine", `1:${50 + i}`),
    }).returning();
    await db.insert(messageInstances).values({
      accountId, messageId: m!.id, mailboxId: mb!.id, folder: "ohmail/Quarantine",
      uid: 50 + i, uidvalidity: 1n, isPrimary: true,
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

function adapterOf(junk: string | null) {
  const moves: Array<{ from: string; to: string }> = [];
  const adapter = {
    findSpecialFolders: async (): Promise<SpecialFolders> => ({ junk, trash: null }),
    move: async (loc: NativeLocator, toFolder: string) => {
      moves.push({ from: loc.folder, to: toFolder });
      return { folder: toFolder, ref: `9:${900 + moves.length}` };
    },
    setFlags: async () => {},
  } as unknown as MailboxAdapter;
  return { adapter, moves };
}

const repoOf = (db: Awaited<ReturnType<typeof makeTestDb>>) =>
  makeDrizzleRepo(db as unknown as Tx) as unknown as WorkerRepo & {
    transaction: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T>;
  };

describe("junk-sweep — one-time, explicit, dry-run by default", () => {
  it("a DRY RUN lists the pile and where it would go, and writes/moves NOTHING", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId, ids } = await seed(db);
    const { adapter, moves } = adapterOf("INBOX/Junk");

    const res = await junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(db), adapter, accountId, mailboxId, execute: false, writeAuthority: { lease: FIXTURE_LEASE },
    });
    expect(res.dryRun).toBe(true);
    expect(res.junkFolder).toBe("INBOX/Junk");
    expect(res.candidates.map((c) => c.messageId).sort()).toEqual([...ids].sort());
    expect(res.moved).toEqual([]);
    expect(moves).toEqual([]);
    // Nothing written: folder_state, body and locator all byte-identical.
    for (const id of ids) {
      const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
      expect(fs).toMatchObject({ observedFolder: "ohmail/Quarantine", reconcileStatus: "reconciled" });
      const [body] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, id));
      expect(body!.withheldReason).toBeNull();
      expect(body!.text).not.toBe("");
    }
  });

  it("--execute runs the live completion: moved, parked, satisfied, husked", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId, ids } = await seed(db);
    const { adapter, moves } = adapterOf("INBOX/Junk");

    const res = await junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(db), adapter, accountId, mailboxId, execute: true, writeAuthority: { lease: FIXTURE_LEASE },
    });
    expect(res.moved.sort()).toEqual([...ids].sort());
    expect(moves.every((m) => m.from === "ohmail/Quarantine" && m.to === "INBOX/Junk")).toBe(true);
    for (const id of ids) {
      const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
      expect(fs).toMatchObject({
        desiredFolder: "ohmail/Quarantine", observedFolder: "INBOX/Junk", reconcileStatus: "reconciled",
      });
      const [body] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, id));
      expect(body!.withheldReason).toBe("junk_filed");
      expect(body!.text).toBe("");
      const instances = await db.select().from(messageInstances).where(eq(messageInstances.messageId, id));
      expect(instances).toEqual([]);   // parked — no instance in a folder nothing enumerates
      const [row] = await db.select().from(messages).where(eq(messages.id, id));
      expect((row!.nativeLocator as NativeLocator).folder).toBe("INBOX/Junk");
    }
  });

  it("a mailbox with no native \\Junk moves nothing, even under --execute", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seed(db);
    const { adapter, moves } = adapterOf(null);
    const res = await junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(db), adapter, accountId, mailboxId, execute: true, writeAuthority: { lease: FIXTURE_LEASE },
    });
    expect(res.junkFolder).toBeNull();
    expect(res.moved).toEqual([]);
    expect(moves).toEqual([]);
  });
});

describe("junk-sweep — the cycle's leadership guard", () => {
  it("`guard` runs before each chunk's IMAP writes; a refusal aborts BEFORE any move and completes nothing", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId, ids } = await seed(db);
    const { adapter, moves } = adapterOf("INBOX/Junk");
    const calls: string[] = [];
    await expect(junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(db), adapter, accountId, mailboxId, execute: true,
      writeAuthority: {
        fence: async () => { calls.push("guard"); throw new Error("the leader lease is gone"); },
        lease: FIXTURE_LEASE,
      } as MailboxWriteAuthority,
    })).rejects.toThrow("the leader lease is gone");
    expect(calls).toEqual(["guard"]);
    expect(moves).toEqual([]);
    for (const id of ids) {
      const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
      expect(fs).toMatchObject({ observedFolder: "ohmail/Quarantine", reconcileStatus: "reconciled" });
    }
    // ── EVERY IMAP WRITE SITS BEHIND A FRESH READ, AND NOW THE COUNT SAYS SO ────────────────
    //
    // This asserted exactly two guard calls, under a comment that already claimed "every IMAP write
    // sits behind a fresh read". **The claim and the number disagreed and the number was the
    // truthful one**: this adapter has no `moveMany`, so the pass takes the per-message fallback and
    // issues one `adapter.move` PER MESSAGE, and two guards for N moves is one read before a run of
    // writes. A takeover landing after the first move let every later one through. Found by a review
    // round, 2026-09-01.
    //
    // Asserted as the ARITHMETIC rather than as a literal, deliberately: a literal is what let the
    // old expectation stay green while the property it was named for stopped holding. One guard at
    // the chunk top (before `stillDesired` — a process that has lost the lease must not spend a
    // query either), then one before each individual move.
    const ok: string[] = [];
    const res = await junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(db), adapter, accountId, mailboxId, execute: true,
      writeAuthority: {
        fence: async () => { ok.push("guard"); }, lease: FIXTURE_LEASE,
      } as MailboxWriteAuthority,
    });
    expect(res.moved.sort()).toEqual([...ids].sort());
    expect(moves).toHaveLength(res.moved.length);
    expect(ok).toHaveLength(1 + res.moved.length);
  });
});

describe("junk-sweep — the review round's two rules", () => {
  it("a member the USER has since moved (a newer desired folder) is NOT a candidate and is not touched", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId, ids } = await seed(db);
    // A third member: physically still in Quarantine, but the user moved it — `desired_folder`
    // is INBOX and the reconciler has not executed the move yet. The sweep must leave it alone.
    const [moved] = await db.insert(messages).values({
      accountId, mailboxId,
      dedupKey: `mid:<sw-${accountId.slice(0, 8)}-moved@x>`, bodyHash: "hm",
      subject: "rescued by the user", fromAddress: "friend@example.test",
      nativeLocator: LOC("ohmail/Quarantine", "1:99"),
    }).returning();
    await db.insert(folderState).values({
      messageId: moved!.id, accountId: moved!.accountId, desiredFolder: "INBOX", observedFolder: "ohmail/Quarantine",
      lastSetBy: "user", reconcileStatus: "pending",
    });
    const { adapter, moves } = adapterOf("INBOX/Junk");
    const res = await junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(db), adapter, accountId, mailboxId, execute: true, writeAuthority: { lease: FIXTURE_LEASE },
    });
    expect(res.candidates.map((c) => c.messageId).sort()).toEqual([...ids].sort());
    expect(res.moved).not.toContain(moved!.id);
    expect(moves).toHaveLength(2);
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, moved!.id));
    expect(fs).toMatchObject({ desiredFolder: "INBOX", observedFolder: "ohmail/Quarantine" });
  });

  it("a COMPLETION failure propagates — never skipped, never a fallback that keeps issuing moves", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seed(db);
    const { adapter, moves } = adapterOf("INBOX/Junk");
    // The worker cycle's repo: its `transaction` IS the fenced group, and a fence refusal
    // throws out of it. Modelled as a transaction that refuses.
    const refusing = {
      ...repoOf(db),
      transaction: async () => { throw new Error("the heartbeat no longer names this instance as the shard leader"); },
    } as unknown as ReturnType<typeof repoOf>;
    await expect(junkSweepPass({
      db: db as unknown as Tx, repo: refusing, adapter, accountId, mailboxId, execute: true, writeAuthority: { lease: FIXTURE_LEASE },
    })).rejects.toThrow("no longer names this instance");
    // ONE move was issued (the first member's), then the refusal stopped the sweep: no second
    // IMAP write from a process that may no longer lead.
    expect(moves).toHaveLength(1);
  });
});

describe("junk-sweep — `afterId` is a KEYSET cursor past a refused prefix", () => {
  it("returns only candidates whose id sorts AFTER the cursor, and stays exact when the set shrinks", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId, ids } = await seed(db);
    const { adapter, moves } = adapterOf("INBOX/Junk");
    const sorted = [...ids].sort();
    // Cursor at the first member: the window is the SECOND member alone (an offset-blind pass
    // would answer the first).
    const res = await junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(db), adapter, accountId, mailboxId, execute: false, writeAuthority: { lease: FIXTURE_LEASE },
      limit: 1, afterId: sorted[0]!,
    });
    expect(res.candidates.map((c) => c.messageId)).toEqual([sorted[1]]);
    // The set SHRINKS (the user moves the first member) and the same cursor still names the
    // second member exactly — where an OFFSET of one would now skip it.
    await db.update(folderState).set({ desiredFolder: "INBOX" }).where(eq(folderState.messageId, sorted[0]!));
    const again = await junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(db), adapter, accountId, mailboxId, execute: true, writeAuthority: { lease: FIXTURE_LEASE },
      limit: 1, afterId: sorted[0]!,
    });
    expect(again.moved).toEqual([sorted[1]]);
    expect(moves).toHaveLength(1);
    // A cursor at the last id sees an EMPTY window — the scan ran off the end.
    const tail = await junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(db), adapter, accountId, mailboxId, execute: true, writeAuthority: { lease: FIXTURE_LEASE },
      limit: 1, afterId: sorted[1]!,
    });
    expect(tail.candidates).toEqual([]);
  });
});

describe("adoptSweepWindow — the scan's state across cycles (review round 4)", () => {
  const LIMIT = 3;
  /** A scan at the top with nothing carried — the two deferral fields joined in a later round. */
  const TOP = { ...SWEEP_SCAN_START, command: "press-1" };
  it("a fully refused pile LARGER than one window is examinedAll at its tail — across cycles", () => {
    // Cycle 1: a full window, nothing moved → advance, not examined.
    let r = adoptSweepWindow(TOP,
      { movedCount: 0, candidates: LIMIT, lastId: "m3", junkFolder: "J" }, LIMIT);
    expect(r.state).toEqual({ ...TOP, after: "m3" });
    expect(r.examinedAll).toBe(false);
    // Cycle 2: the short tail, still nothing moved → the WHOLE scan moved nothing: examinedAll.
    r = adoptSweepWindow(r.state, { movedCount: 0, candidates: 1, lastId: "m4", junkFolder: "J" }, LIMIT);
    expect(r.state).toEqual(TOP);
    expect(r.examinedAll).toBe(true);
  });

  it("one move ANYWHERE in the scan blocks examinedAll until a fresh top-to-end scan says otherwise", () => {
    let r = adoptSweepWindow(TOP,
      { movedCount: 2, candidates: LIMIT, lastId: "m3", junkFolder: "J" }, LIMIT);
    expect(r.examinedAll).toBe(false);
    expect(r.state).toEqual({ ...TOP, after: "m3", movedSinceTop: true });
    // The tail moved nothing, but the scan DID move — not examined-all-refused.
    r = adoptSweepWindow(r.state, { movedCount: 0, candidates: 0, lastId: null, junkFolder: "J" }, LIMIT);
    expect(r.state).toEqual(TOP);
    expect(r.examinedAll).toBe(false);
    // The NEXT scan runs top-to-end with nothing moved → now it is examined.
    r = adoptSweepWindow(r.state, { movedCount: 0, candidates: 1, lastId: "m9", junkFolder: "J" }, LIMIT);
    expect(r.examinedAll).toBe(true);
  });

  /**
   * REVIEW FINDING — A DEFERRAL IN AN EARLY WINDOW IS A FACT ABOUT THE WHOLE SCAN.
   *
   * The cursor moves past a deferred member, so the FINAL window can honestly report zero
   * deferrals while the row it deferred is still sitting in the pile. Reading only the last
   * window's count therefore retired the user's press over exactly the mail the deferral was
   * protecting. Every earlier case in this file fits inside one window, where the two readings are
   * identical — which is why nothing caught it.
   */
  it("a deferral in an EARLY window survives to the tail of the scan", () => {
    // Window 1: full, nothing moved, one member deferred → carried.
    let r = adoptSweepWindow(TOP,
      { movedCount: 0, candidates: LIMIT, lastId: "m3", junkFolder: "J", deferredCount: 1 }, LIMIT);
    expect(r.deferredSinceTop).toBe(true);
    expect(r.state.deferredSinceTop).toBe(true);
    // Window 2: the short tail, nothing moved, NOTHING deferred here. The scan still holds one.
    r = adoptSweepWindow(r.state,
      { movedCount: 0, candidates: 1, lastId: "m4", junkFolder: "J", deferredCount: 0 }, LIMIT);
    expect(r.examinedAll).toBe(true);
    // THE ASSERTION THE FINDING IS ABOUT. Before the fix this was false and the command retired.
    expect(r.deferredSinceTop).toBe(true);
    expect(r.deferralsHold).toBe(true);
    // A fresh scan starts clean — the carry is per scan, like `movedSinceTop`.
    expect(r.state.deferredSinceTop).toBe(false);
  });

  /**
   * REVIEW FINDING — THE EXEMPTION IS BOUNDED, OR IT RE-OPENS THE HOLE IT WAS CARVED OUT OF.
   *
   * Making deferrals exempt from retirement means a stale locator nothing will ever repoint keeps
   * the command queued and the mailbox re-kicked for ever: the folder is recreated, the message no
   * longer exists, its instance row still satisfies the candidate predicate, and the old-epoch
   * delete is deliberately never enumerated — so the pile never empties and every scan defers the
   * same row. Three consecutive completed scans is the bound.
   */
  it("three consecutive barren scans exhaust the deferral exemption", () => {
    let st = TOP;
    for (const scan of [1, 2, 3]) {
      const r = adoptSweepWindow(st,
        { movedCount: 0, candidates: 1, lastId: "m1", junkFolder: "J", deferredCount: 1 }, LIMIT);
      expect(r.examinedAll).toBe(true);
      expect(r.state.deferredScans).toBe(scan);
      // The exemption holds for the first two and is spent on the third.
      expect(r.exhaustedDeferrals).toBe(scan >= 3);
      // AND THE GATE THE CYCLE READS reflects both halves. Asserted here because a mutation
      // proved the conjunction was unguarded while it was assembled at the call site: each half
      // was covered alone and their combination by nothing.
      expect(r.deferralsHold).toBe(scan < 3);
      st = r.state;
    }
  });

  it("a scan that MOVED something resets the bound — the pile is draining, deferrals are not what holds it", () => {
    let r = adoptSweepWindow(TOP,
      { movedCount: 0, candidates: 1, lastId: "m1", junkFolder: "J", deferredCount: 1 }, LIMIT);
    expect(r.state.deferredScans).toBe(1);
    // Progress: this scan moved mail. The command is being served, so the counter goes back to
    // zero rather than creeping towards a retirement the pile has not earned.
    r = adoptSweepWindow(r.state,
      { movedCount: 2, candidates: 1, lastId: "m2", junkFolder: "J", deferredCount: 1 }, LIMIT);
    expect(r.state.deferredScans).toBe(0);
    expect(r.exhaustedDeferrals).toBe(false);
    expect(r.deferralsHold).toBe(true);
  });

  /**
   * REVIEW FINDING — SCAN STATE BELONGS TO ONE PRESS.
   *
   * The cursor, the moved-since-top flag and the deferral allowance are progress through ONE
   * command. Keyed to nothing they outlived it: a command that spent its allowance and retired
   * left the counter at its ceiling on a live mailbox attachment, so the person's NEXT press
   * inherited a spent allowance and its very first barren scan retired it immediately.
   */
  it("a NEW press starts from a clean scan — it does not inherit a spent allowance", () => {
    // Press one burns its whole allowance.
    let st = { ...SWEEP_SCAN_START, command: "press-1" };
    for (let i = 0; i < SWEEP_MAX_DEFERRED_SCANS; i++) {
      st = adoptSweepWindow(st,
        { movedCount: 0, candidates: 1, lastId: "m1", junkFolder: "J", deferredCount: 1 }, LIMIT).state;
    }
    expect(st.deferredScans).toBe(SWEEP_MAX_DEFERRED_SCANS);

    // Press two arrives. Before the fix it inherited the count above and was retired on its first
    // barren scan; now it gets the retries it is entitled to.
    const fresh = sweepStateForPress(st, "press-2");
    expect(fresh.deferredScans).toBe(0);
    expect(fresh.after).toBeNull();
    expect(fresh.command).toBe("press-2");
    const r = adoptSweepWindow(fresh,
      { movedCount: 0, candidates: 1, lastId: "m1", junkFolder: "J", deferredCount: 1 }, LIMIT);
    expect(r.deferralsHold).toBe(true);
  });

  it("the SAME press keeps its place — the reset is not a reset every cycle", () => {
    const mid = { ...SWEEP_SCAN_START, command: "press-1", after: "m3", movedSinceTop: true };
    // Byte-identical, and by identity: a cursor rebuilt every cycle would re-walk the pile from
    // the top for ever, which is the opposite failure.
    expect(sweepStateForPress(mid, "press-1")).toBe(mid);
  });

  it("no Junk folder is examinedAll immediately — there is nowhere to move anything", () => {
    const r = adoptSweepWindow({ ...TOP, after: "m3" },
      { movedCount: 0, candidates: 0, lastId: null, junkFolder: null }, LIMIT);
    expect(r.state).toEqual(TOP);
    expect(r.examinedAll).toBe(true);
  });
});
