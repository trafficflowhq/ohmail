import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { auditLog, contacts, learningSignals, ruleRemovals, rules } from "@trafficflow/db";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { createSidecar, type Sidecar } from "../src/engine.js";

/**
 * WHAT THE ACT LET IN IS RETIRED BY A STANDALONE STORE'S OWN DRAIN (owner report 2026-11-02). The
 * store an update finds holds what the act on suggestions wrote when it let a cold sender in: its
 * promoted rule into News, an inferred contact and its decision. An organizing drain retires the rule
 * and the contact, once per launch, with one audit row; a reader's drain writes nothing — the store
 * whose install organizes the mailbox does it.
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
  uidValidity(): number | bigint | null { return 4_200; }
}

/** A mailbox with nothing new in it. */
function quietMailbox() {
  const meta = new MemoryMetaFolder();
  const empty: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
  return (_cfg: ImapConfig): MailboxAdapter & { leaseIo(): LeaseIo } => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...empty }; },
    async move(locator: NativeLocator, to: string): Promise<NativeLocator> { return { ...(locator as object), folder: to } as NativeLocator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
}

const COLD = "talent@hire-outreach.example";

describe("a standalone drain retires what the act let in", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function boot(organize: boolean): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-act-retire-");
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test",
      machineName: "retire host",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: quietMailbox(),
      log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    if (organize) await grantOrganizeConsent(sidecar);
    // What the 0.30.28 act wrote when it let the cold sender in.
    const accountId = sidecar.world.accountId;
    await sidecar.db.insert(rules).values({
      accountId, kind: "sender", match: COLD, destination: "ohmail/News", provenance: "promoted", enabled: true, priority: 0,
    });
    await sidecar.db.insert(contacts).values({ accountId, address: COLD, source: "inferred" });
    await sidecar.db.insert(learningSignals).values({
      accountId, triggeringActionId: "screener:auto:00000000-0000-0000-0000-00000000c01d", kind: "screener",
      senderAddress: COLD, destination: "ohmail/News", label: "positive",
    });
    await sidecar.start();
    return sidecar;
  }

  const left = async (s: Sidecar) => ({
    rules: (await s.db.select({ id: rules.id }).from(rules).where(eq(rules.accountId, s.world.accountId))).length,
    contacts: (await s.db.select({ id: contacts.id }).from(contacts)
      .where(and(eq(contacts.accountId, s.world.accountId), eq(contacts.address, COLD)))).length,
    audits: (await s.db.select({ id: auditLog.id }).from(auditLog)
      .where(and(eq(auditLog.accountId, s.world.accountId), eq(auditLog.action, "screener.act_admission_retired")))).length,
    // A policy pass's retire is no person's removal: nothing travels for it.
    removals: (await s.db.select({ key: ruleRemovals.ruleKey }).from(ruleRemovals).where(eq(ruleRemovals.accountId, s.world.accountId))).length,
  });

  it("an organizing drain retires the act's rule and contact, once, with one audit row", async () => {
    const sidecar = await boot(true);
    await sidecar.syncUntilQuiet();
    expect(await left(sidecar)).toEqual({ rules: 0, contacts: 0, audits: 1, removals: 0 });
  }, 60_000);

  it("CONTROL: a reader's drain writes nothing", async () => {
    const sidecar = await boot(false);
    await sidecar.syncUntilQuiet();
    expect(await left(sidecar)).toEqual({ rules: 1, contacts: 1, audits: 0, removals: 0 });
  }, 60_000);
});
