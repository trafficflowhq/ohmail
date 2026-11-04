import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { freshDataDir } from "./_datadir.js";
import { eq, isNull } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import { DEFAULT_STALE_AFTER_MS } from "@trafficflow/worker/lease";
import { mailboxes } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { releaseRefusal } from "./_release-refusal.js";

/**
 * WHAT THE PHONE READS ABOUT A HOLDER COMES FROM THE ENGINE'S OWN STATE. The standalone card
 * reads `organizerStates()` and never the row, so the sibling refusal the row carried and the
 * occupancy the peek read never reached it: a stop waiting on a copy of this install said nothing,
 * and a holder that let go was named for a cadence. To watch it fail: drop `releaseRefusal` from
 * the release arm's state, or `holderState: seen.state` from the peek's.
 */

class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  /** The release's read refused the way the real io refuses it — see `_release-refusal.ts`. */
  releaseRefused = false;
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }
  uidValidity(): number | bigint | null { return 4_100; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    if (this.releaseRefused) throw releaseRefusal();
    return this.claims
      .filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`))
      .map((c) => ({ ...c }));
  }
  /** This install's own id, read off the claim its first organizing pass appended. */
  ownInstallId(): string {
    const m = /^X-Ohmail-Install-Id: (.+)$/m.exec(this.claims[0]?.raw ?? "");
    if (!m) throw new Error("no claim in the folder to read an install id from");
    return m[1]!.trim();
  }
  /**
   * The restored image's state: OUR record is out (the clone's renew expunges same-id older
   * records — the gate's own id-scoped expunge), and the clone's stands under a nonce this
   * install never wrote. `heartbeat` decides whether it is LIVE or LAPSED.
   */
  async replaceWithSibling(installId: string, heartbeat: Date): Promise<void> {
    this.claims.length = 0;
    await this.appendClaim(formatClaim({
      installId, kind: "local", displayName: "the same computer, restored",
      heartbeat, claimedAt: heartbeat, nonce: "n-clone-not-ours",
      authorizedAt: null, capabilities: [],
    }));
  }
  /** Another install's claim, appended BESIDE ours: live, and authorized by a press, so it outranks. */
  async appendForeign(installId: string, heartbeat: Date): Promise<void> {
    await this.appendClaim(formatClaim({
      installId, kind: "local", displayName: "the other computer",
      heartbeat, claimedAt: heartbeat, nonce: "n-theirs",
      authorizedAt: heartbeat, capabilities: [],
    }));
  }
  get count(): number { return this.claims.length; }
}

const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

function quietMailbox(meta: MemoryMetaFolder) {
  const factory = (_cfg: ImapConfig): MailboxAdapter & {
    leaseIo(): LeaseIo; leasePeekIo(): { listClaims(): Promise<RawClaimMessage[]> };
  } => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return {
        move: true, uidplus: true, condstore: true, qresync: false,
        idle: true, specialUse: true, sentFolder: null,
      };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...EMPTY_BATCH }; },
    async move(locator: NativeLocator): Promise<NativeLocator> { return locator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> {
      throw new Error("this test's mailbox must never be asked to send");
    },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
  return { factory };
}

const HOUR = 60 * 60 * 1000;
const STALE_AFTER_MS = 60_000;

describe("the engine state the phone reads carries the refusal and the look", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function dataDir(): Promise<string> {
    const dir = await freshDataDir("ohmail-sibling-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  /** A log line as the engine wrote it — the event, and the detail the stand-down case reads. */
  type Line = { event: string; detail?: Record<string, unknown> };
  async function boot(
    dir: string, mailbox: ReturnType<typeof quietMailbox>, lines: Line[],
  ): Promise<Sidecar> {
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "the machine that pressed stop",
      pollIntervalMs: 60 * HOUR, // every poll below is one the test asked for
      leaseStaleAfterMs: STALE_AFTER_MS,
      adapterFactory: mailbox.factory,
      log: (event, detail) => { lines.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
    });
    cleanups.push(() => sidecar.stop().catch(() => undefined));
    // The precondition, written the way `reader-no-auto-resume.test.ts` argues it: this file is
    // about an install that was asked to organize, and only on a fresh store.
    await sidecar.db.update(mailboxes)
      .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    return sidecar;
  }

  const mailboxRow = async (sidecar: Sidecar) => {
    const [row] = await sidecar.db.select().from(mailboxes)
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    return row!;
  };
  const said = (lines: { event: string }[], event: string): number =>
    lines.filter((l) => l.event === event).length;

  it("a stop refused over a live sibling claim says so in the state, and the heal clears it", async () => {
    const lines: { event: string }[] = [];
    const meta = new MemoryMetaFolder();
    const sidecar = await boot(await dataDir(), quietMailbox(meta), lines);
    await sidecar.start();
    await meta.replaceWithSibling(meta.ownInstallId(), new Date());
    await sidecar.db.update(mailboxes).set({ releaseRequestedAt: new Date() })
      .where(eq(mailboxes.id, sidecar.world.mailboxId));
    await sidecar.syncUntilQuiet();
    expect((await mailboxRow(sidecar)).releaseRefusal, "premise: the row carries it").toBe("sibling_lapse");
    const waiting = sidecar.organizerStates()[sidecar.world.mailboxId]!;
    expect({ releaseRefusal: waiting.releaseRefusal, stop: waiting.releaseRequestedAt !== null })
      .toEqual({ releaseRefusal: "sibling_lapse", stop: true });

    await meta.replaceWithSibling(meta.ownInstallId(), new Date(Date.now() - DEFAULT_STALE_AFTER_MS - 60_000));
    await sidecar.syncUntilQuiet();
    const healed = sidecar.organizerStates()[sidecar.world.mailboxId]!;
    expect({ releaseRefusal: healed.releaseRefusal, stop: healed.releaseRequestedAt })
      .toEqual({ releaseRefusal: null, stop: null });
  }, 60_000);

  it("after the holder lets go, the state says the look found nobody, keeping the reason apart", async () => {
    const lines: { event: string }[] = [];
    const meta = new MemoryMetaFolder();
    const sidecar = await boot(await dataDir(), quietMailbox(meta), lines);
    await sidecar.start();
    await meta.appendForeign("another-computer-install", new Date());
    await sidecar.syncUntilQuiet();
    const stood = sidecar.organizerStates()[sidecar.world.mailboxId]!;
    expect({ organizing: stood.organizing, heldBy: stood.heldBy, holderState: stood.holderState },
      "premise: stood down behind a live holder")
      .toEqual({ organizing: false, heldBy: "the other computer", holderState: "held" });

    await meta.removeClaims([...(await meta.listClaims()).map((c) => c.ref)]);
    await sidecar.syncUntilQuiet();
    const after = sidecar.organizerStates()[sidecar.world.mailboxId]!;
    expect({ inFolder: meta.count, organizing: after.organizing, reason: after.reason, heldBy: after.heldBy, holderState: after.holderState })
      .toEqual({ inFolder: 0, organizing: false, reason: "organized_elsewhere:local", heldBy: null, holderState: "none" });
  }, 60_000);
});
