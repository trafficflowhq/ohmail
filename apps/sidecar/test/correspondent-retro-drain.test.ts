import { accountOfMailbox, accountOfMessage } from "@trafficflow/db";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { contacts, folderState, mailboxFolders, messageBodies, messageInstances, messages } from "@trafficflow/db";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { createSidecar, type Sidecar } from "../src/engine.js";

/**
 * SOMEBODY THIS ACCOUNT WROTE TO IS RELEASED FROM THE GATE ON A STANDALONE INSTALL TOO
 * (STANDALONE-CORRESPONDENT-RETRO-NOT-RUN). The worker's correspondent retro teaches `contacts`
 * our Sent copies and releases the correspondent's held mail to the Ohbox; a standalone install
 * had no caller for it, so mail held before the ingest learned the correspondent waited for the
 * held-release offer. The drain tail now runs the pass behind the organizer gate, and the same
 * drain's reconciler carries the move. The pass itself runs on the device store in the sqlite
 * project (`apps/worker/test/screener-correspondent.test.ts`).
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

describe("a standalone drain releases the held mail of somebody this account wrote to", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  /* THE WORLD IS SEEDED BEFORE THE FIRST DRAIN: the retro is time-gated per launch like the join
     heal, so the launch's first drain is the one that reads it. */
  async function boot(
    moves: Array<{ from: string; to: string }>, organize: boolean, seed: (s: Sidecar) => Promise<void>,
  ): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-correspondent-retro-");
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test",
      machineName: "correspondent host",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: recordingMailbox(moves),
      log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    if (organize) await grantOrganizeConsent(sidecar);
    await seed(sidecar);
    await sidecar.start();
    return sidecar;
  }

  let uid = 20;
  /** Our Sent copy to `to`, written now — after this mailbox was connected. */
  async function wroteTo(sidecar: Sidecar, to: string): Promise<void> {
    const w = sidecar.world;
    await sidecar.db.insert(mailboxFolders).values({ mailboxId: w.mailboxId, accountId: accountOfMailbox(w.mailboxId), folder: "Sent", uidvalidity: 7n, uidnext: 100n })
      .onConflictDoNothing();
    const at = new Date(Date.now() + 60_000);
    const [m] = await sidecar.db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `sent-${uid}`, dedupKey: `sent:${uid}@own.test`,
      subject: "the north elevation", fromAddress: "owner@trafficflow.test", messageIdHeader: `s-${uid}@own.test`,
      date: at, arrivedAt: at, toAddresses: [{ name: null, address: to }], ccAddresses: [],
      nativeLocator: { folder: "Sent", ref: `7:${uid}` },
    }).returning();
    await sidecar.db.insert(messageInstances).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageId: m!.id, folder: "Sent", uidvalidity: 7n, uid: uid++, isPrimary: true,
    });
    await sidecar.db.insert(folderState).values({
      messageId: m!.id, accountId: accountOfMessage(m!.id), desiredFolder: "Sent", observedFolder: "Sent", lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await sidecar.db.insert(messageBodies).values({ messageId: m!.id, accountId: accountOfMessage(m!.id), text: "Shall we?", headers: {} });
  }

  /** Their mail, held at the gate by us before the ingest knew them. */
  async function heldFrom(sidecar: Sidecar, from: string): Promise<string> {
    const w = sidecar.world;
    const [m] = await sidecar.db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `held-${uid}`, dedupKey: `held:${uid}@corr.test`,
      subject: "Re: the north elevation", fromAddress: from, nativeLocator: { folder: "ohmail/Screener", ref: `9:${uid}` },
    }).returning();
    await sidecar.db.insert(messageInstances).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageId: m!.id, folder: "ohmail/Screener", uidvalidity: 9n, uid: uid++, isPrimary: true,
    });
    await sidecar.db.insert(folderState).values({
      messageId: m!.id, accountId: accountOfMessage(m!.id), desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener", lastSetBy: "us",
      reconcileStatus: "reconciled", conflict: false,
    });
    await sidecar.db.insert(messageBodies).values({ messageId: m!.id, accountId: accountOfMessage(m!.id), text: "Thursday works.", headers: {} });
    return m!.id;
  }

  const desiredOf = async (sidecar: Sidecar, id: string): Promise<string> =>
    (await sidecar.db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;

  it("the correspondent's held mail leaves the gate for the Ohbox within one drain, and they are a contact", async () => {
    const moves: Array<{ from: string; to: string }> = [];
    let held = "";
    let stranger = "";
    const sidecar = await boot(moves, true, async (sc) => {
      await wroteTo(sc, "friend@corr.test");
      held = await heldFrom(sc, "friend@corr.test");
      stranger = await heldFrom(sc, "nobody@stranger.test");
    });
    await sidecar.syncUntilQuiet();

    expect(await desiredOf(sidecar, held), "a correspondent waited at the gate").toBe("INBOX");
    expect(moves).toContainEqual({ from: "ohmail/Screener", to: "INBOX" });
    const known = (await sidecar.db.select({ a: contacts.address }).from(contacts)).map((r) => r.a);
    expect(known).toContain("friend@corr.test");
    // CONTROL: somebody this account never wrote to stays where they are.
    expect(await desiredOf(sidecar, stranger)).toBe("ohmail/Screener");
  }, 60_000);

  it("CONTROL — a reader releases nothing: the pass is behind the organizer gate", async () => {
    const moves: Array<{ from: string; to: string }> = [];
    let held = "";
    const sidecar = await boot(moves, false, async (sc) => {
      await wroteTo(sc, "friend@corr.test");
      held = await heldFrom(sc, "friend@corr.test");
    });
    await sidecar.syncUntilQuiet();
    expect(await desiredOf(sidecar, held)).toBe("ohmail/Screener");
    expect(moves).toHaveLength(0);
    // …and it teaches nothing: the contacts are the organizer's to write.
    const known = (await sidecar.db.select({ a: contacts.address }).from(contacts)).map((r) => r.a);
    expect(known).not.toContain("friend@corr.test");
  }, 60_000);
});
