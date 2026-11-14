import { accountOfMailbox, accountOfMessage } from "@trafficflow/db";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import {
  accountSettings, folderState, listAddresses, mailboxFolders, messageBodies, messageInstances, messages, messageSearch,
  accountPass, readPassProgress,
} from "@trafficflow/db";
import { reindexMessageSearch } from "@trafficflow/core/mail";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { createSidecar, type Sidecar } from "../src/engine.js";

/**
 * THE LIST-ADDRESS BACKFILL RUNS IN A STANDALONE DRAIN, BEFORE THE RETRO (mail 0150). The store an
 * update finds already holds the person's post to `list@`, a stored message whose `List-Post` names
 * `list@`, and a company claim under `list@` the gate held. The first drain records `list@` as a list
 * address and stamps the store, and the correspondent retro that runs after it in the same drain
 * leaves the claim at the gate: the post is no consent for a name anyone on the list can write. A
 * reader records too — its store becomes the organizer's when it is promoted.
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

const LIST = "list@lists.test";

describe("a standalone drain reads the list addresses before its retro", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function boot(organize: boolean, seed: (s: Sidecar) => Promise<void>): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-list-address-");
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test",
      machineName: "list host",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: quietMailbox(),
      log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    if (organize) await grantOrganizeConsent(sidecar);
    await seed(sidecar);
    await sidecar.start();
    return sidecar;
  }

  let uid = 40;
  /** A stored row: `folder`, its sender, the headers its body kept, and what it claims. */
  async function stored(sidecar: Sidecar, o: {
    folder: string; from: string; name?: string; to?: string; headers?: Record<string, string[]>; claim?: string;
  }): Promise<string> {
    const w = sidecar.world;
    const at = new Date(Date.now() + 60_000);
    const [m] = await sidecar.db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `lb-${uid}`, dedupKey: `lb:${uid}@test`,
      subject: o.claim ? "Ihre Karte" : "Spring meeting", fromAddress: o.from, fromName: o.name ?? null,
      messageIdHeader: `m-${uid}@test`, date: at, arrivedAt: at,
      toAddresses: o.to ? [{ name: null, address: o.to }] : [], ccAddresses: [],
      senderCheck: o.claim ? "impersonation" : null, senderCheckBrand: o.claim ?? null,
      nativeLocator: { folder: o.folder, ref: `9:${uid}` },
    }).returning();
    await sidecar.db.insert(messageInstances).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageId: m!.id, folder: o.folder, uidvalidity: 9n, uid: uid++, isPrimary: true,
    });
    await sidecar.db.insert(folderState).values({
      messageId: m!.id, accountId: accountOfMessage(m!.id), desiredFolder: o.folder, observedFolder: o.folder, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await sidecar.db.insert(messageBodies).values({ messageId: m!.id, accountId: accountOfMessage(m!.id), text: "x", headers: o.headers ?? {} });
    return m!.id;
  }

  async function seedTheUpdate(sc: Sidecar): Promise<string> {
    await sc.db.insert(mailboxFolders).values({ mailboxId: sc.world.mailboxId, accountId: accountOfMailbox(sc.world.mailboxId), folder: "Sent", uidvalidity: 9n, uidnext: 100n })
      .onConflictDoNothing();
    await stored(sc, { folder: "Sent", from: "owner@trafficflow.test", to: LIST });
    await stored(sc, { folder: "INBOX", from: "member@elsewhere.test", headers: { "list-post": [`<mailto:${LIST}>`] } });
    return stored(sc, { folder: "ohmail/Screener", from: LIST, name: "PostFinance", claim: "PostFinance" });
  }

  const listed = async (s: Sidecar) => (await s.db.select({ a: listAddresses.address }).from(listAddresses)).map((r) => r.a);
  const stamp = async (s: Sidecar) => (await readPassProgress(s.db, accountPass("list_address_backfill", s.world.accountId))).doneAt;
  const desiredOf = async (s: Sidecar, id: string): Promise<string> =>
    (await s.db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;

  it("ACCEPTANCE 1j: the drain records the list address and stamps, and its retro leaves the claim held", async () => {
    let claim = "";
    const sidecar = await boot(true, async (sc) => { claim = await seedTheUpdate(sc); });
    await sidecar.syncUntilQuiet();
    expect(await listed(sidecar)).toEqual([LIST]);
    expect(await stamp(sidecar)).not.toBeNull();
    expect(await desiredOf(sidecar, claim), "the retro released a claim under a list address").toBe("ohmail/Screener");
  }, 60_000);

  it("CONTROL: a reader's drain records and stamps too, and moves nothing", async () => {
    let claim = "";
    const sidecar = await boot(false, async (sc) => { claim = await seedTheUpdate(sc); });
    await sidecar.syncUntilQuiet();
    expect(await listed(sidecar)).toEqual([LIST]);
    expect(await stamp(sidecar)).not.toBeNull();
    expect(await desiredOf(sidecar, claim)).toBe("ohmail/Screener");
  }, 60_000);
});

/**
 * THE GONE-LETTER TIDY RUNS IN A STANDALONE DRAIN TOO, for every role: an update finds letters an
 * older version emptied when they left the server, still holding their preview, search words and
 * whole header block. The first drain takes them (`goneLetterTidyPass`); a letter still on the
 * server keeps everything. Mutation: drop the drain's call and both reads go red.
 */
describe("a standalone drain tidies the letters that left the server before their words did", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
  const WHOLE = { from: ["Anna <anna@example.test>"], to: ["owner@trafficflow.test"], subject: ["harbour"], received: ["by mx"] };

  it("the first drain empties a gone letter of its words and header lines; a live one keeps them, on a reader too", async () => {
    for (const organize of [true, false]) {
      const dataDir = await freshDataDir("ohmail-gone-tidy-");
      const sidecar = await createSidecar({
        dataDir,
        imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
        address: "owner@trafficflow.test", machineName: "tidy host", pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000,
        adapterFactory: quietMailbox(), log: () => {},
      });
      cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
      if (organize) await grantOrganizeConsent(sidecar);
      const w = sidecar.world;
      const letter = async (key: string, gone: boolean): Promise<string> => {
        const [m] = await sidecar.db.insert(messages).values({
          accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `gt-${key}`, dedupKey: `gt:${key}@test`, subject: "harbour",
          fromAddress: "anna@example.test", snippet: "the preview of the harbour letter", deletedAt: gone ? new Date() : null,
          nativeLocator: { folder: "INBOX", ref: `9:${key.length}` },
        }).returning();
        if (!gone) {
          await sidecar.db.insert(messageInstances).values({
            accountId: w.accountId, mailboxId: w.mailboxId, messageId: m!.id, folder: "INBOX", uidvalidity: 9n, uid: key.length, isPrimary: true,
          });
        }
        await sidecar.db.insert(messageBodies).values({
          messageId: m!.id, accountId: accountOfMessage(m!.id), text: "", headers: WHOLE, withheldReason: gone ? "expunged" : "storage_cap",
        });
        await reindexMessageSearch(sidecar.db as never, w.accountId, m!.id);
        return m!.id;
      };
      const gone = await letter("gone", true);
      const live = await letter("live-one", false);
      await sidecar.start();
      await sidecar.syncUntilQuiet();
      const words = async (id: string) => ({
        snippet: (await sidecar.db.select({ s: messages.snippet }).from(messages).where(eq(messages.id, id)))[0]!.s,
        documents: (await sidecar.db.select({ id: messageSearch.messageId }).from(messageSearch).where(eq(messageSearch.messageId, id))).length,
        headers: (await sidecar.db.select({ h: messageBodies.headers }).from(messageBodies).where(eq(messageBodies.messageId, id)))[0]!.h,
      });
      expect(await words(gone), `the drain left a gone letter's words (organizing: ${organize})`)
        .toEqual({ snippet: "", documents: 0, headers: { to: WHOLE.to } });
      expect(await words(live), "a letter still on the server lost its words")
        .toEqual({ snippet: "the preview of the harbour letter", documents: 1, headers: WHOLE });
    }
  }, 120_000);
});
