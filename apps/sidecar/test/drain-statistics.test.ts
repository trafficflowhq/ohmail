import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { freshDataDir } from "./_datadir.js";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { createSidecar } from "../src/engine.js";
import { openLocalDb } from "../src/db.js";
import { STATISTICS_INGEST_ROWS } from "../src/store-statistics.js";

/**
 * A DRAIN THAT TOOK MAIL ASKS FOR THE SEARCH'S STATISTICS — once per {@link STATISTICS_INGEST_ROWS}
 * changes summed over drains, at the drain's end, through the store's own stale rule. Observed on
 * the shipped engine over a store whose `analyzeSearchIfStale` counts its callers. Watched red: the
 * drain-end call removed (the second drain asks nothing), the upkeep bypassed for a direct look
 * (the first drain asks).
 */
class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number | bigint | null { return 4_100; }
}

const EMPTY: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };

/** A mailbox that hands over only the messages released so far, one batch a cycle. */
function releasedMailbox(): { factory: (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo }; release(n: number): void } {
  const meta = new MemoryMetaFolder();
  let released = 0;
  let served = 0;
  const factory = (_cfg: ImapConfig): MailboxAdapter & { leaseIo(): LeaseIo } => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> {
      const n = Math.min(100, released - served);
      const creates = Array.from({ length: n }, (_, i) => {
        const uid = served + i + 1;
        return {
          type: "create" as const, locator: { folder: "INBOX", ref: `1:${uid}` }, seen: false,
          raw: Buffer.from([`Message-ID: <stats-${uid}@x>`, `From: s${uid % 40}@x.example`, "To: owner@trafficflow.test",
            `Subject: msg ${uid}`, "Content-Type: text/plain", "", `message ${uid}`].join("\r\n")),
        };
      });
      served += n;
      return { ...EMPTY, creates, hasBacklog: served < released };
    },
    async move(locator: NativeLocator): Promise<NativeLocator> { return locator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
  return { factory, release: (n) => { released += n; } };
}

describe("a drain that took mail keeps the search's statistics", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  it("asks once the drains' changes pass the threshold, and not before", async () => {
    const half = STATISTICS_INGEST_ROWS / 2 + 100;
    const mailbox = releasedMailbox();
    mailbox.release(half);
    let asked = 0;
    const dataDir = await freshDataDir("ohmail-drain-stats-");
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: mailbox.factory,
      // The backfill's own look after its rounds is not the subject: its first tick waits an hour.
      searchBackfillTiming: { waitMs: 60 * 60 * 1000 },
      store: async (dir, opts) => {
        const o = await openLocalDb(dir, opts);
        return { ...o, analyzeSearchIfStale: async () => { asked += 1; return o.analyzeSearchIfStale(); } };
      },
      log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    await sidecar.start();
    await sidecar.syncUntilQuiet();
    expect(asked, `${half} changes are under ${STATISTICS_INGEST_ROWS}`).toBe(0);
    mailbox.release(half);
    expect(await sidecar.syncUntilQuiet(), "the second drain never ran").toBeGreaterThan(0);
    expect(asked, "the two drains together passed the threshold").toBe(1);
  }, 300_000);
});
