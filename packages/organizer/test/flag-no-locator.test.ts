import { describe, it, expect } from "vitest";
import type { NativeLocator } from "@trafficflow/core";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { reconcileMailbox } from "../src/sync.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A PENDING `\Seen` WITH NO LOCATOR — THE ARM THAT USED TO BE A BARE `continue`
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `reconcileFlags` had five outcomes and four of them left a record: a completed `STORE` writes a
 * `reconcile.flags` audit row, a gone message writes `reconcile.flags.voided`, a refused one
 * writes `reconcile.flags.failed` AND a deferral, a transport failure writes a `warn` line. The
 * fifth — a row whose message has no `native_locator` — was `if (!p.nativeLocator) continue;`:
 * no audit row, no log line, no deferral, and therefore no bound. The row stayed `pending` and
 * due, so every cycle for the rest of the mailbox's life read it and dropped it in silence.
 *
 * THAT IS THE EXACT SHAPE OF A REPORTED SYMPTOM — "I marked it read on the desktop and my mailbox
 * never saw it". The local row says read, the server was never asked, and nothing anywhere says a
 * request was dropped. It is filed under that change; these are its guards.
 *
 * ── WHY THE STATE EXISTS AT ALL (the assertion below is about a real row, not a hypothetical) ─
 *
 * `messages.native_locator` is REQUIRED at insert — `InsertMessageInput.nativeLocator` is
 * non-optional, so no message is born without one. It is set to NULL at exactly two sites, both
 * inside `DrizzleRepo`'s folder-delete sweep, and both tombstone the row in the same statement
 * group. Beside them the sweep DELETES the message's `folder_state` row — and never its
 * `flag_state` row, which is the asymmetry that leaves this queue holding intents the folder
 * queue does not. A user who marks a message read and then deletes the folder it lived in
 * produces one, and `flag_state` is deleted nowhere in the tree.
 *
 * ── WHAT IS OWED, AND WHY IT IS NOT THE `MessageGoneError` ARM'S IMMEDIATE VOID ─────────────
 *
 * `retireLocatorlessFlag`'s header carries the ruling. In one line: defer on the shared backoff
 * for as long as a copy could still return (the tombstoned header row survives for exactly that),
 * then retire with an audit row that says the convergence was a retirement and not an observation
 * of a server nobody asked.
 */

const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });

interface Deferral { messageId: string; attempts: number; nextAttemptAt: Date }
interface Logged { level: string; event: string; fields: Record<string, unknown> }

interface Recorded {
  /** Locators handed to `setFlags` — the SERVER-facing call, which is the whole question here. */
  stored: NativeLocator[];
  flagged: string[];
  audits: Array<{ action: string; payload: Record<string, unknown> }>;
  deferredFlags: Deferral[];
  logs: Logged[];
}

/**
 * One locator-less intent FIRST, two healthy ones behind it.
 *
 * The order is deliberate: "the two behind it were still written" is then a statement about
 * head-of-line blocking, and not about the iteration order happening to be kind. `attempts` on
 * the locator-less row is the parameter the two arms of the ruling turn on.
 */
function repoOf(rec: Recorded, attempts: number | undefined): WorkerRepo {
  const stub = {
    listPendingFolderStates: async () => [],
    listPendingFlagStates: async () => [
      {
        messageId: "no-locator", desiredSeen: true, observedSeen: false,
        lastSetBy: "us" as const, nativeLocator: null,
        ...(attempts === undefined ? {} : { attempts }),
      },
      { messageId: "flag-a", desiredSeen: true, observedSeen: false, lastSetBy: "us" as const, nativeLocator: LOC("INBOX", "1:13") },
      { messageId: "flag-b", desiredSeen: true, observedSeen: false, lastSetBy: "us" as const, nativeLocator: LOC("INBOX", "1:14") },
    ],
    /** The retirement goes through the conditional writer now — no competing press here, so it matches. */
    completeFlagState: async (messageId: string) => { rec.flagged.push(messageId); return true; },
    primaryInstanceVanished: async () => false,
    recordAudit: async (_a: string, action: string, payload: Record<string, unknown>) => {
      rec.audits.push({ action, payload });
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

function adapterOf(rec: Recorded): MailboxAdapter {
  return {
    setFlags: async (locator: NativeLocator) => { rec.stored.push(locator); },
  } as unknown as MailboxAdapter;
}

const run = async (attempts?: number): Promise<Recorded> => {
  const rec: Recorded = { stored: [], flagged: [], audits: [], deferredFlags: [], logs: [] };
  const record = (level: string) => (event: string, fields?: Record<string, unknown>): void => {
    rec.logs.push({ level, event, fields: fields ?? {} });
  };
  await reconcileMailbox({ writeAuthority: FIXTURE_LEASE,
    repo: repoOf(rec, attempts), adapter: adapterOf(rec),
    accountId: "acct-1", mailboxId: "mb-1",
    log: {
      level: "info", child: () => undefined,
      debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error"),
    },
  } as never);
  return rec;
};

describe("a pending \\Seen with no locator is bounded and audited, never silently skipped", () => {
  it("is never sent to the server, and does not block the intents behind it", async () => {
    const rec = await run();

    // The SERVER-facing call, which is the only thing that can be wrong here in either direction:
    // a locator-less row must not reach `setFlags` (there is no UID to name), and the two rows
    // behind it must.
    expect(rec.stored.map((l) => l.ref), "the healthy \\Seen pushes must still reach IMAP")
      .toEqual(["1:13", "1:14"]);
  });

  it("writes an audit row naming the reason — the record that did not exist", async () => {
    const rec = await run();

    const rows = rec.audits.filter((a) => a.action === "reconcile.flags.no_locator");
    expect(rows, "a dropped read-state intent must be visible in the audit log").toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ messageId: "no-locator", seen: true, attempts: 1 });
    // The sentence is the half a person reads. It must say the server was not asked, or the row
    // is as uninformative as the `continue` it replaced.
    expect(String(rows[0]!.payload.reason)).toContain("no locator");
  });

  it("DEFERS on the first sighting rather than re-reading the row every cycle", async () => {
    const before = Date.now();
    const rec = await run();

    expect(rec.deferredFlags).toHaveLength(1);
    const [d] = rec.deferredFlags;
    expect(d!.messageId).toBe("no-locator");
    expect(d!.attempts, "the first sighting takes the FIRST step of the schedule").toBe(1);
    expect(d!.nextAttemptAt.getTime()).toBeGreaterThan(before);
    expect(d!.nextAttemptAt.getTime()).toBeLessThanOrEqual(before + 60_000 + 5_000);
    // Deferral is not retirement: the user's intent is untouched and the row stays pending, so a
    // copy that returns still converges.
    expect(rec.flagged, "a deferral must not converge the row").not.toContain("no-locator");
  });

  it("logs a warn line — the standalone door has no other witness", async () => {
    const rec = await run();

    const line = rec.logs.find((l) => l.event === "reconcile_flag_no_locator");
    expect(line, "the sync loop must say it dropped a read-state write").toBeDefined();
    expect(line!.level, "a write the mailbox never received is not `info`").toBe("warn");
    expect(line!.fields).toMatchObject({
      mailboxId: "mb-1", accountId: "acct-1", messageId: "no-locator",
      attempts: 1, state: "deferred",
    });
    // Every field on this line must be one `ALLOWED_FIELDS` emits, or the line reports
    // `droppedFields` and says nothing. `seen` is deliberately NOT here — it is not on the census
    // and belongs to the audit row, which has no allowlist.
    expect(Object.keys(line!.fields).sort())
      .toEqual(["accountId", "attempts", "mailboxId", "messageId", "reason", "state"]);
  });

  it("RETIRES the intent once the deferral schedule is spent — the bound", async () => {
    // `RECONCILE_BACKOFF_MINUTES` has five steps, so a row arriving with four refusals on record
    // is taking its fifth and last.
    const rec = await run(4);

    expect(rec.deferredFlags, "a spent schedule must not defer again for ever").toEqual([]);
    expect(rec.flagged, "the row must leave the pending queue").toContain("no-locator");

    const retired = rec.audits.filter((a) => a.action === "reconcile.flags.retired");
    expect(retired, "the convergence is only honest beside the row that explains it").toHaveLength(1);
    expect(retired[0]!.payload).toMatchObject({ messageId: "no-locator", seen: true, attempts: 5 });
    expect(String(retired[0]!.payload.reason)).toContain("never asked");

    // It is a RETIREMENT and not a completion. An auditor reading `reconcile.flags` would read
    // this row as "the server took the write", which is the one thing that did not happen.
    expect(rec.audits.map((a) => a.action)).not.toContain("reconcile.flags.no_locator");
    expect(
      rec.audits.filter((a) => a.action === "reconcile.flags"
        && (a.payload as { messageId?: string }).messageId === "no-locator"),
      "a retired intent must never be recorded as a completed STORE",
    ).toHaveLength(0);

    const line = rec.logs.find((l) => l.event === "reconcile_flag_no_locator");
    expect(line!.fields).toMatchObject({ state: "retired", attempts: 5 });
  });

  it("the schedule is a ladder, not a cliff — the fourth sighting still defers", async () => {
    const rec = await run(3);

    expect(rec.deferredFlags.map((d) => d.attempts)).toEqual([4]);
    expect(rec.flagged).not.toContain("no-locator");
    expect(rec.audits.map((a) => a.action)).toContain("reconcile.flags.no_locator");
  });
});
