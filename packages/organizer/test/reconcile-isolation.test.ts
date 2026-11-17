import { describe, it, expect } from "vitest";
import type { NativeLocator } from "@trafficflow/core";
// The SAME module `sync.ts` imports it from — an `instanceof` against a second copy of the class
// would answer false and this file would be testing nothing.
import {
  DestinationMissingError, MessageGoneError, SameFolderMoveError, type MailboxAdapter,
} from "@trafficflow/core/adapters/imap";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { reconcileMailbox } from "../src/sync.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * ONE MUTATION THE SERVER WILL NOT PERFORM MUST NOT STOP EVERY OTHER MUTATION.
 *
 * `reconcileFolders` used to rethrow anything that was not a `MessageGoneError`, which abandoned
 * the whole pass: every other pending move, and — because `reconcileFlags` runs after it — every
 * pending `\Seen` push as well.
 *
 * That was survivable only while a stuck move erased itself. It no longer does: a move is complete
 * when the SOURCE disappears, so a message whose expunge keeps failing stays pending cycle after
 * cycle, and rethrowing would turn one unhappy message into a mailbox-wide outage that never
 * clears on its own.
 *
 * ── THE HALF THAT WAS STILL MISSING, AND WAS WORSE ──────────────────────────────────────────
 *
 * The FLAG pass never got the same treatment. It rethrew every non-`MessageGoneError`, so one
 * message whose `\Seen` the server refused failed the entire cycle — every other pending
 * read-state unwritten, the folder pass's `owesMore` re-kick discarded on the way out (it is
 * returned by the call BEFORE the throw), and a mailbox failure counted against the mailbox until
 * it was detached and quarantined. Restart reconciliation reached the same row and did it again.
 *
 * A refused STORE was therefore strictly more destructive than a refused MOVE, which is the
 * asymmetry these tests now close: both loops isolate, both record, both DEFER.
 *
 * ── AND THE DEFERRAL, WHICH IS NOT A DROP ──────────────────────────────────────────────────
 *
 * Isolation alone still retries a permanently refused mutation on every cycle for ever — one IMAP
 * round trip per stuck row per cycle, and, because the pending queue is oldest-first under a fixed
 * budget, eventually the whole budget. So a refusal also writes `attempts` and `next_attempt_at`.
 * The intent is untouched and the row stays pending: this is about how OFTEN we ask, never about
 * whether we still owe it.
 */

const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });

interface Deferral {
  messageId: string; attempts: number; nextAttemptAt: Date; errorClass?: string;
}

interface Recorded {
  moved: string[];
  flagged: string[];
  folderStates: string[];
  audits: Array<{ action: string; payload: unknown }>;
  deferredMoves: Deferral[];
  deferredFlags: Deferral[];
}

/**
 * A repo holding two pending moves and three pending `\Seen` writes, recording only what was
 * written.
 *
 * Hand-built rather than a `FakeRepo`: the property under test is which writes SURVIVE a throw
 * from the adapter, and a repo that computed state would let the assertion pass on that state
 * instead of on the sequence.
 *
 * `transaction` runs the callback against this same object, which is all an unfenced write group
 * needs from a stub — the ATOMICITY of that group is not a claim a stub can make, and it is proven
 * against real Postgres in `reconcile-atomicity.pg.test.ts` instead.
 */
function repoOf(rec: Recorded): WorkerRepo {
  const stub = {
    listPendingFolderStates: async () => [
      { messageId: "stuck", desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us" as const, nativeLocator: LOC("INBOX", "1:10") },
      { messageId: "healthy", desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us" as const, nativeLocator: LOC("INBOX", "1:11") },
    ],
    // The stuck flag is FIRST, so "the two behind it were written" is a statement about
    // head-of-line blocking and not about iteration order being kind.
    listPendingFlagStates: async () => [
      { messageId: "stuck-flag", desiredSeen: true, observedSeen: false, lastSetBy: "us" as const, nativeLocator: LOC("INBOX", "1:12"), attempts: 2 },
      { messageId: "flag-a", desiredSeen: true, observedSeen: false, lastSetBy: "us" as const, nativeLocator: LOC("INBOX", "1:13") },
      { messageId: "flag-b", desiredSeen: true, observedSeen: false, lastSetBy: "us" as const, nativeLocator: LOC("INBOX", "1:14") },
    ],
    updateLocator: async (messageId: string) => { rec.moved.push(messageId); },
    upsertFolderState: async (messageId: string) => { rec.folderStates.push(messageId); },
    /** The completion path's conditional write — this file counts settlements, not their shape. */
    completeFolderState: async (messageId: string) => { rec.folderStates.push(messageId); return true; },
    /** The read-state completion, conditional like its folder twin; this file counts settlements. */
    completeFlagState: async (messageId: string) => { rec.flagged.push(messageId); return true; },
    // No disappearance on record: the gone case here is the mid-move RACE, which must stay
    // pending. The expunged-outright shape (vanished ⇒ voided) has its own tests in
    // `filing-batch.test.ts`.
    primaryInstanceVanished: async () => false,
    recordAudit: async (_a: string, action: string, payload: unknown) => {
      rec.audits.push({ action, payload });
    },
    deferFolderReconcile: async (messageId: string, n: { attempts: number; nextAttemptAt: Date }) => {
      rec.deferredMoves.push({ messageId, ...n });
    },
    deferFlagReconcile: async (messageId: string, n: { attempts: number; nextAttemptAt: Date }) => {
      rec.deferredFlags.push({ messageId, ...n });
    },
    transaction: async <T>(fn: (r: WorkerRepo) => Promise<T>): Promise<T> => fn(stub as unknown as WorkerRepo),
    // The removal fence reads this inside every write transaction; the double answers what a live
    // mailbox answers (see `assertMailboxStillHere`), because absent it the fence is a TypeError.
    mailboxStatusForWrite: async (): Promise<string> => "connected",
  };
  return stub as unknown as WorkerRepo;
}

/**
 * Moves fail for `1:10` and `\Seen` writes fail for `1:12`, with the given error; everything else
 * succeeds.
 */
function adapterOf(failWith: Error): MailboxAdapter {
  return {
    move: async (locator: NativeLocator, toFolder: string) => {
      if (locator.ref === "1:10") throw failWith;
      return LOC(toFolder, "7:41");
    },
    setFlags: async (locator: NativeLocator) => {
      if (locator.ref === "1:12") throw failWith;
    },
  } as unknown as MailboxAdapter;
}

const run = async (failWith: Error) => {
  const rec: Recorded = {
    moved: [], flagged: [], folderStates: [], audits: [], deferredMoves: [], deferredFlags: [],
  };
  await reconcileMailbox({ writeAuthority: FIXTURE_LEASE,
    repo: repoOf(rec), adapter: adapterOf(failWith),
    accountId: "acct-1", mailboxId: "mb-1",
  } as never);
  return rec;
};

describe("reconcileFolders — a failure is isolated to its own message", () => {
  it("a move that throws does not abandon the other move or the flag pass", async () => {
    // Not a `MessageGoneError`: that one was already tolerated. This is the class that used to
    // rethrow — a refused EXPUNGE, a read-only source folder, a destination we cannot verify.
    const rec = await run(new Error("EXPUNGE refused"));

    expect(rec.moved, "the healthy move must still land").toEqual(["healthy"]);
    expect(rec.folderStates).toEqual(["healthy"]);
    // `reconcileFlags` runs AFTER `reconcileFolders`, so a rethrow above took this with it.
    expect(rec.flagged, "the pending \\Seen pushes must still run").toEqual(["flag-a", "flag-b"]);
  });

  it("records the failure rather than swallowing it", async () => {
    const rec = await run(new Error("EXPUNGE refused"));

    const failures = rec.audits.filter((a) => a.action === "reconcile.move.failed");
    expect(failures, "a stuck message must be visible, not silent").toHaveLength(1);
    expect(failures[0]!.payload).toMatchObject({
      messageId: "stuck",
      to: "ohmail/News",
      error: "Error: EXPUNGE refused",
      attempts: 1,
    });
  });

  it("DEFERS the stuck move instead of re-asking every cycle", async () => {
    const before = Date.now();
    const rec = await run(new Error("EXPUNGE refused"));

    expect(rec.deferredMoves).toHaveLength(1);
    const [d] = rec.deferredMoves;
    expect(d!.messageId).toBe("stuck");
    // First refusal ⇒ the FIRST step of the schedule, not the last. A transient `NO` during a
    // provider's maintenance window must not cost hours.
    expect(d!.attempts).toBe(1);
    expect(d!.nextAttemptAt.getTime()).toBeGreaterThan(before);
    expect(d!.nextAttemptAt.getTime()).toBeLessThanOrEqual(before + 61_000 + 5_000);
    // The healthy message is never deferred — deferral is a property of the refusal, not of the
    // pass it happened in.
    expect(rec.deferredMoves.map((x) => x.messageId)).not.toContain("healthy");
  });

  /**
   * ── WHY IT WAS REFUSED, AS A CLASS (mail 0097) ────────────────────────────────────────────
   *
   * The deferral recorded the SCHEDULE and the schedule alone, so the only honest sentence a
   * client could build from it was "1 message waits · retrying at 14:20" — true, and useless to
   * whoever has to do something about it. The class is what turns that into "the folder is not
   * there", which names the screen that fixes it.
   *
   * FOUR WORDS, from the server's own structured response code and never from its message text:
   * `folder_state`'s schema comment forbids storing a mail server's wording, and this keeps that
   * rule rather than bending it — the free text still goes to the audit row these assertions read
   * beside the deferral.
   *
   * The class and the schedule are ONE GROUP at the write site, which is why every case here
   * asserts both: a class without its schedule is a reason for nothing, and a schedule without
   * its class is the sentence that could not be written.
   */
  it("STAMPS the refusal's class from the server's own response code", async () => {
    const rec = await run(Object.assign(
      new Error("NO [NONEXISTENT] Mailbox does not exist"), { serverResponseCode: "NONEXISTENT" },
    ));
    expect(rec.deferredMoves).toHaveLength(1);
    expect(rec.deferredMoves[0]!.errorClass).toBe("no_such_folder");
    // On the audit row too, beside the server's verbatim words — the two records answer different
    // questions and a class on one of them only is a class somebody will read from the wrong one.
    const failed = rec.audits.find((a) => a.action === "reconcile.move.failed");
    expect((failed!.payload as { errorClass?: string }).errorClass).toBe("no_such_folder");
  });

  it("maps [TRYCREATE] to the SAME class — the same fact and the same remedy", async () => {
    // The server offering to accept a CREATE is telling us the destination is not there. A person
    // reading the strip cannot act on the difference, and two sentences for one situation is the
    // defect this whole field exists to end.
    const rec = await run(Object.assign(
      new Error("NO [TRYCREATE] no such folder"), { serverResponseCode: "TRYCREATE" },
    ));
    expect(rec.deferredMoves[0]!.errorClass).toBe("no_such_folder");
  });

  it("maps [OVERQUOTA] and [NOPERM] to their own classes", async () => {
    const full = await run(Object.assign(
      new Error("NO [OVERQUOTA] Quota exceeded"), { serverResponseCode: "OVERQUOTA" },
    ));
    expect(full.deferredMoves[0]!.errorClass).toBe("over_quota");
    const locked = await run(Object.assign(
      new Error("NO [NOPERM] Permission denied"), { serverResponseCode: "NOPERM" },
    ));
    expect(locked.deferredMoves[0]!.errorClass).toBe("read_only");
  });

  it("a bare NO with no response code is `refused`, which is a real answer and not a fallback", async () => {
    // A server that refuses a move without saying why HAS refused it: imapflow's tagged NO carries
    // `responseStatus`. There is deliberately no message-text probe.
    const rec = await run(Object.assign(new Error("Command failed"), { responseStatus: "NO" }));
    expect(rec.deferredMoves[0]!.errorClass).toBe("refused");
  });

  it("a failure that is not the server's answer is `unconfirmed`, never the server's refusal", async () => {
    // Our own check that could not prove the move, or a throw nobody classified (mail 0164).
    const rec = await run(new Error("EXPUNGE refused"));
    expect(rec.deferredMoves[0]!.errorClass).toBe("unconfirmed");
    const failed = rec.audits.find((a) => a.action === "reconcile.move.failed");
    expect((failed!.payload as { errorClass?: string }).errorClass).toBe("unconfirmed");
  });

  it.each(["NoConnection", "EConnectionClosed", "StateLogout", "EIMAPCLOSED"])(
    "imapflow's %s is a dropped connection: no deferral, no class, no audit row", async (code) => {
      const rec = await run(Object.assign(new Error("Connection not available"), { code }));
      expect(rec.deferredMoves).toEqual([]);
      expect(rec.audits.filter((a) => a.action === "reconcile.move.failed")).toHaveLength(0);
      expect(rec.moved).toEqual(["healthy"]);
    });

  it("a HOST OUTAGE stamps NOTHING — the socket is not the message's refusal", async () => {
    // The other half of the transport rule the case below states for the schedule: an unreachable
    // host leaves the row exactly as it was, and a class stamped here would blame the message for
    // the network and then be rendered as its reason for ever after.
    const rec = await run(Object.assign(
      new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT", serverResponseCode: "NONEXISTENT" },
    ));
    expect(rec.deferredMoves, "an unreachable host earns no deferral and no class").toEqual([]);
  });

  it("a MessageGoneError stays silent — it is an ordinary race, not a failure", async () => {
    // The message left the locator between the database read and the move. The next
    // `changesSince` adopts the completed move; there is nothing to report.
    const rec = await run(new MessageGoneError(LOC("INBOX", "1:10")));

    expect(rec.moved).toEqual(["healthy"]);
    expect(rec.flagged).toEqual(["flag-a", "flag-b"]);
    expect(rec.audits.filter((a) => a.action === "reconcile.move.failed")).toHaveLength(0);
    expect(rec.deferredMoves, "a race is not a refusal — nothing to defer").toEqual([]);
  });

  it("a SameFolderMoveError completes the row where it is: no refusal, no deferral, one audit row", async () => {
    const rec = await run(new SameFolderMoveError(LOC("INBOX", "1:10"), "ohmail/News"));

    expect(rec.folderStates, "the row was left pending").toEqual(["stuck", "healthy"]);
    expect(rec.moved, "the stuck row's locator was rewritten").toEqual(["healthy"]);
    expect(rec.audits.filter((a) => a.action === "reconcile.move.same_folder").map((a) => a.payload))
      .toMatchObject([{ messageId: "stuck", to: "ohmail/News" }]);
    expect(rec.audits.filter((a) => a.action === "reconcile.move.failed")).toHaveLength(0);
    expect(rec.deferredMoves, "a same-folder move is not a refusal").toEqual([]);
  });

  it("a HOST OUTAGE is not deferred: the row stays due so the backlog drains when it returns", async () => {
    // The distinction that decides whether a deferral is earned. Every pending row fails during an
    // outage, so deferring on this class would put a whole mailbox's filing queue to sleep for
    // hours because of a fault none of its messages caused.
    const rec = await run(Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:993"), { code: "ECONNREFUSED" }));

    expect(rec.deferredMoves, "an unreachable host is not evidence about a message").toEqual([]);
    expect(rec.deferredFlags).toEqual([]);
    expect(rec.audits.filter((a) => a.action === "reconcile.move.failed"), "no per-message record either").toHaveLength(0);
    // …and the pass still keeps going, which is what makes the outage cost one cycle rather than
    // a quarantine.
    expect(rec.moved).toEqual(["healthy"]);
  });
});

describe("reconcileFlags — the loop that used to fail the whole cycle", () => {
  const REFUSED = () => new Error("STORE failed: mailbox is read-only");

  it("one refused \\Seen does not throw, and the flags behind it are still written", async () => {
    // BEFORE: this threw out of `reconcileMailbox` and `index.ts` counted a mailbox failure. The
    // two flags behind the stuck one were never attempted, this cycle or any other.
    const rec = await run(REFUSED());

    expect(rec.flagged, "the queue behind the refusal must drain").toEqual(["flag-a", "flag-b"]);
  });

  it("reconcileMailbox does not throw — a refused STORE is not a mailbox fault", async () => {
    await expect(run(REFUSED())).resolves.toBeDefined();
  });

  it("records and defers the refused flag, carrying the attempt count forward", async () => {
    const rec = await run(REFUSED());

    const failures = rec.audits.filter((a) => a.action === "reconcile.flags.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload).toMatchObject({
      messageId: "stuck-flag",
      seen: true,
      error: "Error: STORE failed: mailbox is read-only",
      attempts: 3,
    });

    expect(rec.deferredFlags).toHaveLength(1);
    // The row arrived with two refusals on record, so this is the THIRD — the schedule reads the
    // durable count, not a per-process one, which is what makes a worker restart not reset it.
    expect(rec.deferredFlags[0]).toMatchObject({ messageId: "stuck-flag", attempts: 3 });
  });

  it("the user's intent is untouched: the flag it writes is still the one they asked for", async () => {
    // Deferral must never edit `desired_seen`. `upsertFlagState` is called for the two that
    // SUCCEEDED and for nothing else — a refused row is written only through the defer statement,
    // which names two columns and no intent column.
    const rec = await run(REFUSED());

    expect(rec.flagged).not.toContain("stuck-flag");
    expect(rec.deferredFlags.map((d) => d.messageId)).toEqual(["stuck-flag"]);
  });
});

/* FOLDER-MISSING-FILINGS: imapflow hands neither `[TRYCREATE]` nor `[NONEXISTENT]` to the
   reconciler on this path, so the class comes from the adapter's own reading — and a lock refused
   for a missing SOURCE carries imapflow's `mailboxMissing` too, which must stay a plain refusal. */
describe("a filing whose folder is gone", () => {
  const logged = async (failWith: Error) => {
    const rec: Recorded = {
      moved: [], flagged: [], folderStates: [], audits: [], deferredMoves: [], deferredFlags: [],
    };
    const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const at = (event: string, fields?: Record<string, unknown>) => { lines.push({ event, fields: fields ?? {} }); };
    const log = { level: "info", child: () => log, debug: at, info: at, warn: at, error: at };
    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE,
      repo: repoOf(rec), adapter: adapterOf(failWith), accountId: "acct-1", mailboxId: "mb-1", log,
    } as never);
    return { rec, lines };
  };

  it("the adapter's missing destination is `no_such_folder`, with its audit row and a log line", async () => {
    const { rec, lines } = await logged(new DestinationMissingError("ohmail/News"));
    expect(rec.deferredMoves.map((d) => [d.messageId, d.errorClass])).toEqual([["stuck", "no_such_folder"]]);
    const failed = rec.audits.find((a) => a.action === "reconcile.move.failed");
    expect((failed!.payload as { errorClass?: string }).errorClass).toBe("no_such_folder");
    expect(lines.find((l) => l.event === "reconcile_move_failed")?.fields)
      .toMatchObject({ kind: "no_such_folder", attempts: 1, toFolder: "ohmail/News", state: "deferred" });
    expect(rec.moved, "the healthy letter still filed").toEqual(["healthy"]);
  });

  it("a SOURCE lock imapflow refused as missing stays `refused`", async () => {
    const { rec } = await logged(Object.assign(new Error("Command failed"), { responseStatus: "NO", mailboxMissing: true }));
    expect(rec.deferredMoves[0]!.errorClass).toBe("refused");
  });
});

