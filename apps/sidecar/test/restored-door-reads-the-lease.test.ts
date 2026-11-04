import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import {
  formatClaim, isMalformed, parseClaim, type LeaseIo, type RawClaimMessage,
} from "@trafficflow/core/adapters/organizer-lease";
import { mailboxes } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 2 });

/**
 * A RESTORED LOCAL DOOR RE-TAKES NOTHING IT DID NOT HOLD. A pairing started from the local door
 * that does not finish puts that door back and the shell starts its engine again over the SAME
 * store (`restore_switch` in the desktop shell). That relaunch decides the mailbox by reading the
 * lease in `ohmail/_meta`, never from what the store remembers: an install another one held the
 * mailbox from stays a reader and appends no claim; one that held it takes it again.
 */

/** An empty `ohmail/_meta` that accepts this install's claim — `readMailboxLease` requires one. */
class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  raw(): string[] {
    return this.claims.map((c) => c.raw);
  }
  async listClaims(): Promise<RawClaimMessage[]> {
    return this.claims.map((c) => ({ ...c }));
  }
  async appendClaim(raw: string): Promise<void> {
    this.claims.push({ ref: this.nextUid++, raw });
  }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }

  /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
  uidValidity(): number | bigint | null { return 4_100; }
}

const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

/** Every `\Seen` write the reconciler asked the server to perform. */
interface FlagWrite { locator: NativeLocator; seen: boolean | undefined }

function recordingMailbox(sink: FlagWrite[], meta: MemoryMetaFolder): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  return (_cfg) => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> {
      return { ...EMPTY_BATCH };
    },
    async move(locator: NativeLocator): Promise<NativeLocator> {
      return locator;
    },
    /* THE ASSERTION'S SUBJECT. `reconcileFlags` calls exactly this, and on a mailbox that is the
       user's own copy of their mail it is the only thing that makes a read durable. */
    async setFlags(locator: NativeLocator, flags: { seen?: boolean }): Promise<void> {
      sink.push({ locator, seen: flags.seen });
    },
    async scanSentRecipients(): Promise<string[]> {
      return [];
    },
    async watch(): Promise<() => Promise<void>> {
      return async () => {};
    },
    async send(_m: OutboundMessage): Promise<SendResult> {
      throw new Error("this mailbox cannot send");
    },
    async fetchPart(): Promise<FetchedPart> {
      throw new Error("this mailbox cannot fetchPart");
    },
  });
}


/** Another desktop's claim, fresh: it holds the mailbox while this install reads. */
function anotherDesktopsClaim(): string {
  const at = new Date();
  return formatClaim({
    authorizedAt: null, capabilities: [], installId: "another-desktop", kind: "local",
    displayName: "the other laptop", heartbeat: at, claimedAt: at, nonce: "theirs",
  });
}

describe("the restored local door reads the lease through its one door", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  /** One launch of the local door over `dataDir`, as the shell's plan starts it. */
  async function launch(dataDir: string, meta: MemoryMetaFolder): Promise<Sidecar> {
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test", machineName: "this laptop", pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000, adapterFactory: recordingMailbox([], meta), log: () => {},
    });
    await grantOrganizeConsent(sidecar);
    await sidecar.start();
    return sidecar;
  }

  const holders = (meta: MemoryMetaFolder): string[] =>
    meta.raw().map((raw) => {
      const claim = parseClaim(raw);
      return claim === null || isMalformed(claim) ? "unreadable" : claim.installId;
    }).sort();

  it.each([
    ["another install held it", true],
    ["this install held it", false],
  ] as const)("%s before the pairing", async (_name, heldElsewhere) => {
    const dataDir = await freshDataDir("ohmail-restored-door-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const meta = new MemoryMetaFolder();
    if (heldElsewhere) await meta.appendClaim(anotherDesktopsClaim());

    const first = await launch(dataDir, meta);
    const ours = first.world.mailboxId;
    const organizedBefore = first.organizerState().organizing;
    await first.stop(); // the pairing's switch stops this engine
    const restored = await launch(dataDir, meta); // the restore starts it over the same store
    cleanups.push(() => restored.stop());
    const [row] = await restored.db.select().from(mailboxes).where(eq(mailboxes.id, ours));
    console.info(`RESTORED ${heldElsewhere ? "held elsewhere" : "held here"}: before ${organizedBefore}, `
      + `after ${restored.organizerState().organizing}, role ${row?.organizerRole}, claims ${holders(meta).join(",")}`);

    expect(restored.world.mailboxId, "the restore opened a different store").toBe(ours);
    if (heldElsewhere) {
      expect(organizedBefore).toBe(false);
      expect(restored.organizerState().organizing, "the restored door took a mailbox it did not hold").toBe(false);
      expect(row?.organizerRole).toBe("reader");
      expect(holders(meta), "the restored door appended a claim of its own").toEqual(["another-desktop"]);
    } else {
      expect(organizedBefore).toBe(true);
      expect(restored.organizerState().organizing, "the restored door did not take back what it held").toBe(true);
      expect(holders(meta)).not.toContain("another-desktop");
      expect(holders(meta).length).toBe(1);
    }
  });
});
