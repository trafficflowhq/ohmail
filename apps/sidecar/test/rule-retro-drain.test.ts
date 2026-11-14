import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { folderState, messageInstances, messages, rules } from "@trafficflow/db";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { createSidecar, type Sidecar, type SidecarConfig } from "../src/engine.js";

/**
 * A SCREENER DECISION MOVES THE BACKLOG IN THE MAILBOX, NOT ONLY ON SCREEN — the local door's half.
 *
 * A decision past the gate is a rule with "apply to existing mail". On the hosted service the
 * worker's `ruleRetroPass` walks the backlog; a standalone install (the phone, the desktop's local
 * door) had no caller for it, so the rule re-presented the old mail under its new place while the
 * mailbox kept it in INBOX, where every other mail app still saw it. The drain now runs the pass
 * and the same drain's reconciler carries the move to IMAP. The pass itself runs on the device
 * store in the sqlite project (`apps/worker/test/rule-retro.test.ts`).
 *
 * To watch it fail: delete the `retroDue` line from `drain()` in `apps/sidecar/src/engine.ts` —
 * the desired folder stays INBOX and the adapter is asked to move nothing.
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

/** A mailbox with nothing new in it that records every move it is asked for. */
function recordingMailbox(moves: Array<{ from: string; to: string }>) {
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
    async move(locator: NativeLocator, to: string): Promise<NativeLocator> {
      moves.push({ from: (locator as { folder: string }).folder, to });
      return { ...(locator as object), folder: to } as NativeLocator;
    },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
}

describe("a rule's 'apply to existing mail' reaches the mailbox on a standalone install", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function boot(moves: Array<{ from: string; to: string }>, extra: Partial<SidecarConfig> = {}): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-rule-retro-");
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test",
      machineName: "retro host",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: recordingMailbox(moves),
      log: () => {},
      ...extra,
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    await grantOrganizeConsent(sidecar);
    await sidecar.start();
    return sidecar;
  }

  /** One message from `from`, filed in INBOX by us and watched there. */
  async function seedInbox(sidecar: Sidecar, from: string, uid: number): Promise<string> {
    const dedup = `mid:${uid}@retro.test`;
    const [m] = await sidecar.db.insert(messages).values({
      accountId: sidecar.world.accountId, mailboxId: sidecar.world.mailboxId,
      messageIdHeader: dedup, bodyHash: `hash-${uid}`, dedupKey: dedup,
      subject: `older mail ${uid}`, fromAddress: from, nativeLocator: { folder: "INBOX", ref: `1:${uid}` },
    }).returning();
    await sidecar.db.insert(messageInstances).values({
      accountId: sidecar.world.accountId, mailboxId: sidecar.world.mailboxId, messageId: m!.id,
      folder: "INBOX", uidvalidity: 1n, uid, isPrimary: true,
    });
    await sidecar.db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  const desiredOf = async (sidecar: Sidecar, id: string): Promise<string> => {
    const [row] = await sidecar.db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id));
    return row!.d;
  };

  it("the backlog of a sender ruled to News moves on the server within one drain", async () => {
    const moves: Array<{ from: string; to: string }> = [];
    const sidecar = await boot(moves);
    const older = await seedInbox(sidecar, "news@sender.test", 7);
    const stranger = await seedInbox(sidecar, "someone@else.test", 8);
    // What a Screener decision past the gate writes: the rule, with the retro apply requested.
    await sidecar.db.insert(rules).values({
      accountId: sidecar.world.accountId, kind: "sender", match: "news@sender.test",
      destination: "ohmail/News", provenance: "manual", enabled: true, retroRequestedAt: new Date(),
    });

    await sidecar.syncUntilQuiet();

    expect(await desiredOf(sidecar, older), "the rule re-presented the mail without moving it").toBe("ohmail/News");
    expect(moves, "the reconciler was asked to move the older mail out of INBOX").toContainEqual({ from: "INBOX", to: "ohmail/News" });
    // CONTROL: mail from a sender the rule does not name stays where it is.
    expect(await desiredOf(sidecar, stranger)).toBe("INBOX");
    expect(moves.filter((m) => m.from === "INBOX")).toHaveLength(1);
    const [rule] = await sidecar.db.select({ done: rules.retroDoneAt }).from(rules).where(eq(rules.match, "news@sender.test"));
    expect(rule!.done, "the rule's backlog is recorded finished").not.toBeNull();
  }, 60_000);

  it("a backlog past 25 letters hands the engine's loop back while it is walked", async () => {
    const moves: Array<{ from: string; to: string }> = [];
    let turns = 0;
    const sidecar = await boot(moves, { loopTurn: async () => { turns++; } });
    const ids: string[] = [];
    for (let uid = 100; uid < 140; uid++) ids.push(await seedInbox(sidecar, "news@sender.test", uid));
    await sidecar.db.insert(rules).values({
      accountId: sidecar.world.accountId, kind: "sender", match: "news@sender.test",
      destination: "ohmail/News", provenance: "manual", enabled: true, retroRequestedAt: new Date(),
    });
    const before = turns;
    await sidecar.syncUntilQuiet();
    for (const id of ids) expect(await desiredOf(sidecar, id)).toBe("ohmail/News");
    expect(turns - before, "40 letters were walked without a turn").toBeGreaterThan(0);
  }, 60_000);

  it("CONTROL — a reader walks nothing: the pass is behind the organizer gate", async () => {
    const moves: Array<{ from: string; to: string }> = [];
    const dataDir = await freshDataDir("ohmail-rule-retro-reader-");
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test", machineName: "retro reader", pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000, adapterFactory: recordingMailbox(moves), log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    await sidecar.start(); // no consent: a reader
    const older = await seedInbox(sidecar, "news@sender.test", 9);
    await sidecar.db.insert(rules).values({
      accountId: sidecar.world.accountId, kind: "sender", match: "news@sender.test",
      destination: "ohmail/News", provenance: "manual", enabled: true, retroRequestedAt: new Date(),
    });
    await sidecar.syncUntilQuiet();
    expect(await desiredOf(sidecar, older)).toBe("INBOX");
    expect(moves).toHaveLength(0);
  }, 60_000);
});
