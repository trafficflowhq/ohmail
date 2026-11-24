import { describe, it, expect } from "vitest";
import type { NativeLocator } from "@trafficflow/core";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { WorkerRepo, PendingFlagState } from "@trafficflow/core/adapters/drizzle-repo";
import { reconcileMailbox, RECONCILE_FLAGS_PER_CYCLE } from "../src/sync.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * ── THE `\Seen` QUEUE HAS A BUDGET, LIKE THE FILING QUEUE BESIDE IT ─────────────────────────
 *
 * `listPendingFolderStates` was bounded after one production screening session left a long queue of rows and
 * held a SERIAL cycle for minutes, during which every other mailbox received no mail. Its
 * read-state twin was left unbounded and its own port doc said so — "this queue is unbounded" was
 * written as a reason to filter the DUE rows, not as a state anybody wanted. A `\Seen` write is one
 * IMAP STORE per message, the same per-message round trip, and this queue is the one a person can
 * fill fastest: select-all-and-mark-read in another client, or a retro pass.
 *
 * Same three properties as the filing budget: one row MORE than the budget is read so "there is
 * more" is a fact rather than a guess, exactly the budget is worked, and the pass says it still
 * owes work so the caller re-kicks instead of waiting out `pollIntervalMs`.
 */

const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });

interface Recorded {
  /** The limit `reconcileFlags` asked the repo for. */
  askedLimit: number | undefined;
  /** Every `setFlags` the adapter was asked to make. */
  stores: string[];
}

/** `count` rows whose desire disagrees with the server — the only shape that costs a STORE. */
function flagRows(count: number): PendingFlagState[] {
  return Array.from({ length: count }, (_, i) => ({
    messageId: `m-${i}`,
    desiredSeen: true,
    observedSeen: false,
    lastSetBy: "us" as const,
    nativeLocator: LOC("INBOX", `1:${i + 1}`),
    attempts: 0,
  })) as unknown as PendingFlagState[];
}

function repoOf(rec: Recorded, pendingFlags: PendingFlagState[]): WorkerRepo {
  const stub: Record<string, unknown> = {
    // No folder work at all: this file's subject is the read-state queue, and a folder backlog
    // would make `owesMore` true for the other pass's reason.
    listPendingFolderStates: async () => [],
    listPendingFlagStates: async (_mailboxId: string, limit?: number) => {
      rec.askedLimit = limit;
      return limit != null ? pendingFlags.slice(0, limit) : pendingFlags;
    },
    upsertFlagState: async () => {},
    primaryInstanceVanished: async () => false,
    recordAudit: async () => {},
    deferFlagReconcile: async () => {},
    transaction: async (fn: (r: WorkerRepo) => Promise<unknown>) => fn(stub as unknown as WorkerRepo),
  };
  return stub as unknown as WorkerRepo;
}

function adapterOf(rec: Recorded): MailboxAdapter {
  return {
    setFlags: async (locator: NativeLocator) => { rec.stores.push(locator.ref); },
  } as unknown as MailboxAdapter;
}

const run = async (repo: WorkerRepo, adapter: MailboxAdapter, role?: "reader") =>
  reconcileMailbox({
    repo, adapter, accountId: "acct-1", mailboxId: "mb-1", ...(role ? { role } : {}),
    writeAuthority: role === "reader" ? { noLease: "reader" as const } : FIXTURE_LEASE,
  } as never);

describe("reconcileFlags — the per-cycle read-state budget", () => {
  it("asks the repo for one row more than the budget, so 'there is more' is a fact", async () => {
    const rec: Recorded = { askedLimit: undefined, stores: [] };
    await run(repoOf(rec, flagRows(4)), adapterOf(rec));
    expect(rec.askedLimit).toBe(RECONCILE_FLAGS_PER_CYCLE + 1);
  });

  it("writes exactly the budget and reports that it owes more, so the caller re-kicks", async () => {
    const rec: Recorded = { askedLimit: undefined, stores: [] };
    const { owesMore } = await run(
      repoOf(rec, flagRows(RECONCILE_FLAGS_PER_CYCLE + 60)), adapterOf(rec),
    );

    expect(owesMore, "a queue past the budget must announce itself or the mailbox stalls").toBe(true);
    // EXACTLY the budget — never the probe row, which is read to be counted and not worked.
    expect(rec.stores).toHaveLength(RECONCILE_FLAGS_PER_CYCLE);
  });

  /**
   * THE POSITIVE CONTROL. An ordinary queue is pushed whole and the pass says it owes nothing, so
   * the case above is a ceiling firing rather than the pass having stopped working.
   */
  it("pushes an ordinary queue whole and owes nothing after it", async () => {
    const rec: Recorded = { askedLimit: undefined, stores: [] };
    const { owesMore } = await run(repoOf(rec, flagRows(9)), adapterOf(rec));
    expect(rec.stores).toHaveLength(9);
    expect(owesMore).toBe(false);
  });

  /**
   * A READER runs this pass by design — `\Seen` is the one verb that keeps its mirror honest — so
   * its backlog is outbound intent like anyone's. The `owesMore` a reader returns for FOLDERS is
   * forced false because it may not move mail; that is a different sentence from this one.
   */
  it("a reader's own read-state backlog is announced too", async () => {
    const rec: Recorded = { askedLimit: undefined, stores: [] };
    const { owesMore } = await run(
      repoOf(rec, flagRows(RECONCILE_FLAGS_PER_CYCLE + 1)), adapterOf(rec), "reader",
    );
    expect(owesMore).toBe(true);
    expect(rec.stores).toHaveLength(RECONCILE_FLAGS_PER_CYCLE);
  });
});
