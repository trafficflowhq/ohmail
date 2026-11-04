import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { eq, isNull } from "drizzle-orm";
import type {
  ChangeBatch, ImapCapabilities, ImapConfig, MailboxAdapter, MoveManyResult,
} from "@trafficflow/core/adapters/imap";
import type { NativeLocator } from "@trafficflow/core/mail";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { folderState, mailboxes, messages } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE LOCAL DOOR FILES A PENDING MOVE BEFORE ITS DRAIN'S FOLDER WALK. The engine's drain hands
 * `fileBeforeWalk` to the first cycle of every drain, so a Move pressed on this install reaches the
 * server before `changesSince` (the worker's half is `apps/worker/test/move-before-the-walk*.ts`).
 */

class FreeLease implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number { return 7_700; }
}

const letter = Buffer.from([
  "Message-ID: <walk-1@friend.test>", "From: A Friend <friend@nowhere.test>", "To: Owner <owner@trafficflow.test>",
  "Subject: walk", "Date: Sat, 03 Oct 2026 12:00:00 +0000", "Content-Type: text/plain; charset=utf-8", "", "hello",
].join("\r\n"), "utf8");

function mailbox(calls: string[]): (cfg: ImapConfig) => MailboxAdapter {
  const meta = new FreeLease();
  let handed = false;
  let next = 100;
  return (_cfg) => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: false, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> {
      calls.push("changesSince");
      const give = handed ? [] : (handed = true, [1]);
      return {
        creates: give.map((uid) => ({
          type: "create" as const, locator: { folder: "INBOX", ref: `1:${uid}` } as NativeLocator, raw: letter,
        })) as ChangeBatch["creates"],
        moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
      };
    },
    async moveMany(locators: readonly NativeLocator[], toFolder: string): Promise<MoveManyResult> {
      calls.push("moveMany");
      return { outcome: "batched", moved: new Map(locators.map((l) => [l.ref, { folder: toFolder, ref: `1:${next++}` }])), gone: [] };
    },
  } as unknown as MailboxAdapter);
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function settled(calls: string[]): Promise<Sidecar> {
  const dataDir = await freshDataDir("ohmail-walk-");
  const sidecar = await createSidecar({
    dataDir,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
    address: "owner@trafficflow.test",
    machineName: "walk host",
    pollIntervalMs: 60 * 60 * 1000,
    adapterFactory: mailbox(calls),
  });
  cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
  await sidecar.db.update(mailboxes).set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
    .where(isNull(mailboxes.organizeConsentedAt));
  await sidecar.start();
  await sidecar.syncUntilQuiet();
  await sidecar.syncUntilQuiet();
  return sidecar;
}

describe("the local door's drain files a pending move before its folder walk", () => {
  it("the first cycle of the drain moves, then walks", async () => {
    const calls: string[] = [];
    const sidecar = await settled(calls);
    const [m] = await sidecar.db.select({ id: messages.id }).from(messages);
    expect(m, "the precondition: the letter was ingested").toBeTruthy();
    const [st] = await sidecar.db.select().from(folderState).where(eq(folderState.messageId, m!.id));
    expect(st, "the precondition: the letter has a folder state").toBeTruthy();
    // A press: the person moves it to News.
    const target = st!.observedFolder === "ohmail/News" ? "ohmail/Receipts" : "ohmail/News";
    await sidecar.db.update(folderState)
      .set({ desiredFolder: target, lastSetBy: "us", reconcileStatus: "pending", nextAttemptAt: null })
      .where(eq(folderState.messageId, m!.id));

    calls.length = 0;
    await sidecar.syncUntilQuiet();
    expect(calls[0], `the drain's order was ${calls.join(",")}`).toBe("moveMany");
    expect(calls.filter((c) => c === "moveMany")).toHaveLength(1);
    expect(calls).toContain("changesSince");
    const [after] = await sidecar.db.select().from(folderState).where(eq(folderState.messageId, m!.id));
    expect(after).toMatchObject({ desiredFolder: target, observedFolder: target });
  }, 60_000);
});
