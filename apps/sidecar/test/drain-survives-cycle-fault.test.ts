import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, isNull } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import { formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import type {
  LeaseIo, RawClaimMessage, RawMetaMessage, MetaRecordsList, RequestReaderIo,
} from "@trafficflow/core/adapters/organizer-lease";
import { mailboxes } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A MAILBOX WHOSE MAIL PASS FAILS STILL LOOKS AT ITS DECISIONS
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The decision channel is drained AFTER the mail pass, and that ordering is deliberate: the folder
 * it reads is one anyone with append rights can write to, so draining first would let a flood of
 * records delay the pass that reads somebody's mail.
 *
 * The cost of that ordering was that a pass which THREW skipped the drain entirely — the throw
 * escaped straight past it. So a mailbox with a persistent sync fault drained nothing for as long
 * as the fault lasted, and a decision made on another install expired reporting that NOBODY TOOK
 * IT, while an organizer was live and connected the whole time. Telling somebody their decision was
 * dropped when it was merely never looked at is worse than telling them to wait, and it is the one
 * outcome of the three that a person acts on — by pressing again.
 *
 * The failure is now held for exactly as long as the channel takes, and then rethrown untouched, so
 * the pass's own accounting is unchanged. This drives the real engine rather than a model of it.
 */

/** A live claim by another install, so this one settles as a reader and drives the reader's half. */
class ForeignLease implements LeaseIo {
  private nextUid = 2;
  private readonly claims: RawClaimMessage[] = [{
    ref: 1,
    raw: formatClaim({
      authorizedAt: null, capabilities: ["requests"],
      installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
      heartbeat: new Date(), claimedAt: new Date(Date.now() - 86_400_000), nonce: "seeded",
    }),
  }];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }

  /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
  uidValidity(): number | bigint | null { return 4_100; }
}

const EMPTY_CURSOR = { folders: {} };

/** What the test watches: every time the decision folder was read, and every append into it. */
interface DrainWire { reads: number; appends: string[]; cycles: number }

function faultyMailbox(
  drain: DrainWire,
  sync: { fail: boolean },
): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo; requestReaderIo(): RequestReaderIo } {
  const lease = new ForeignLease();
  const reader: RequestReaderIo = {
    async listMetaRecords(): Promise<MetaRecordsList> { drain.reads += 1; return { records: [], count: 0, bytes: 0 }; },
    async append(raw: string): Promise<void> { drain.appends.push(raw); },
  };
  return (_cfg) => ({
    leaseIo: () => lease,
    requestReaderIo: () => reader,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return {
        move: true, uidplus: true, condstore: true, qresync: false, idle: true,
        specialUse: true, sentFolder: null,
      };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> {
      drain.cycles += 1;
      // THE SEAM. A mailbox that attached cleanly and whose every cycle then fails — a storage-cap
      // refusal, an IMAP fault, a fence. The pass is what breaks; the mailbox is reachable.
      if (sync.fail) throw new Error("this mailbox's sync cycle is faulted");
      return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: EMPTY_CURSOR };
    },
    async move(locator: NativeLocator, toFolder: string): Promise<NativeLocator> {
      return { folder: toFolder, ref: locator.ref };
    },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
}

describe("a failed mail pass does not skip the decision channel", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function boot(drain: DrainWire, sync: { fail: boolean }): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-drain-fault-");
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "faulted host",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 24 * 3600 * 1000,
      adapterFactory: faultyMailbox(drain, sync),
      log: () => {},
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    // The precondition every case here shares: somebody agreed to organize on this install once,
    // so the gate reaches the lease at all. The seeded foreign claim then makes it a reader.
    await sidecar.db.update(mailboxes)
      .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    await sidecar.start();
    return sidecar;
  }

  /**
   * MUTATION WATCHED RED, and measured: replace `cycleError = err` with a bare `throw err` — the
   * shape this replaces — and `reads` stays at 1 instead of reaching 2. The channel is skipped for
   * as long as the fault lasts, which is exactly the defect.
   */
  it("the folder is READ even though the pass threw, and the throw still reaches the caller", async () => {
    const drain: DrainWire = { reads: 0, appends: [], cycles: 0 };
    const sync = { fail: false };
    const sidecar = await boot(drain, sync);

    // The precondition, asserted rather than assumed: this install is a reader, so the branch
    // under test is the reader's own half of the channel.
    const [mb] = await sidecar.db.select().from(mailboxes)
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    expect(mb!.organizerRole).toBe("reader");

    // One HEALTHY pass first, so the baseline is a measured number rather than an assumption
    // about what `start()` does — and so the comparison below is against a pass that is known to
    // have reached the channel.
    await sidecar.syncUntilQuiet();
    const before = drain.reads;
    expect(before, "a healthy pass did not reach the decision channel at all").toBeGreaterThan(0);

    sync.fail = true;

    /* ── THE THROW IS ASSERTED, NOT PRINTED ────────────────────────────────────────────────
     *
     * This called `syncUntilQuiet()` and logged what came back. That measured nothing: the
     * sweep aggregates its mailboxes with `Promise.allSettled`, so a mailbox that threw still
     * RESOLVES the sweep — `{ ok: 0 }` — and the title's second half ("the throw still reaches
     * the caller") had no assertion under it at all. Deleting the rethrow being tested left
     * every expectation in this case passing, because the drain read happens either way.
     *
     * `syncMailbox` is the per-mailbox path, where a fault is a rejection rather than one
     * settled result among many, so the throw is observable and is required here.
     */
    await expect(sidecar.syncMailbox(sidecar.world.mailboxId),
      "the pass swallowed its own fault — a failed sync reported as a successful one")
      .rejects.toThrow();

    expect(drain.reads, "a faulted pass skipped the decision channel entirely").toBe(before + 1);
    // The cycle really ran and really failed, rather than the channel being reached by some path
    // that never attempted the mail pass at all.
    expect(drain.cycles, "the mail cycle was never attempted").toBeGreaterThan(0);
    // …and reading is all it did. A reader appends only its OWN queued decisions, and there are
    // none here — "I could not sync" is never a reason to write into somebody's mailbox.
    expect(drain.appends).toEqual([]);
  });

  /** And the healthy path still drains exactly once per pass — not twice, not none. */
  it("a pass that succeeds drains once", async () => {
    const drain: DrainWire = { reads: 0, appends: [], cycles: 0 };
    const sync = { fail: false };
    const sidecar = await boot(drain, sync);

    await sidecar.syncUntilQuiet();
    const before = drain.reads;
    await sidecar.syncUntilQuiet();
    expect(drain.reads).toBe(before + 1);
  });
});
