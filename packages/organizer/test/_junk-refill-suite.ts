import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accounts, folderState, mailboxes, messageBodies, messageInstances, messages, type Tx,
} from "@trafficflow/db";
import { UNMETERED_STORAGE_CAP, type NativeLocator } from "@trafficflow/core/mail";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { reconcileMailbox } from "../src/sync.js";
import { junkRestorePass } from "../src/junk-restore.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * LEAVING JUNK BY A PRESS REFILLS AT THE PRESS (owner defect, 2026-09-23): a spam verdict filed a
 * message to Junk and husked its body; the person moved it to the Ohbox and the reader went on
 * saying the verdict filed it, for minutes, until a later cycle's convergence pass. Here the
 * account's own move is the reconcile, and its completion refills the body — one call, no pass.
 * The other client's move is the belt's: the husk stands until `junkRestorePass`, which still
 * refills it. The adapter is a double of the two production calls; the store is real.
 */

const RAW = [
  "From: sender@spam.invalid", "To: me@own.invalid", "Subject: not spam after all",
  "Message-ID: <junked-1@spam.invalid>", "Date: Wed, 23 Sep 2026 06:19:00 +0000",
  "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "",
  "the whole text of a reply a verdict once filed to Junk", "",
].join("\r\n");
const JUNK = "Junk";

export function defineJunkRefillSuite(label: string, openDb: () => Promise<Tx>): void {
  describe(`${label} — a message moved out of Junk has its text back`, () => {
    let db: Tx;
    beforeAll(async () => { db = await openDb(); }, 120_000);

    /** A verdict-filed husk: parked at Junk, no live instance, body emptied under `junk_filed`. */
    async function husk(desired: string): Promise<{ accountId: string; mailboxId: string; messageId: string }> {
      const accountId = randomUUID();
      await db.insert(accounts).values({ id: accountId, name: `refill-${accountId.slice(0, 8)}` });
      const [mb] = await db.insert(mailboxes).values({
        accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@own.invalid`,
        status: "connected", junkFolder: JUNK,
      }).returning();
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `refill:${randomUUID()}`,
        subject: "not spam after all", fromAddress: "sender@spam.invalid",
        messageIdHeader: "junked-1@spam.invalid", nativeLocator: { folder: JUNK, ref: "5:77" },
      }).returning();
      await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", withheldReason: "junk_filed" });
      await db.insert(folderState).values({
        messageId: m!.id, accountId: m!.accountId, desiredFolder: desired, observedFolder: JUNK, lastSetBy: "us",
        reconcileStatus: desired === JUNK ? "reconciled" : "pending", conflict: false,
      });
      return { accountId, mailboxId: mb!.id, messageId: m!.id };
    }

    function adapter(moves: Array<{ from: string; to: string }>, fetches: string[]): MailboxAdapter {
      return {
        move: async (loc: NativeLocator, to: string) => { moves.push({ from: loc.folder, to }); return { folder: to, ref: "3:41" }; },
        setFlags: async () => {},
        fetchByUid: async (folder: string, uids: readonly number[]) => {
          fetches.push(folder);
          return {
            uidValidity: "3",
            creates: uids.filter((u) => u === 41).map((u) => ({
              type: "create" as const, locator: { folder, ref: `3:${u}` }, raw: Buffer.from(RAW, "utf8"),
            })),
            absent: uids.filter((u) => u !== 41), oversize: [],
          };
        },
      } as unknown as MailboxAdapter;
    }

    const repoOf = (): WorkerRepo => makeDrizzleRepo(db as never) as WorkerRepo;
    const bodyOf = async (messageId: string) =>
      (await db.select().from(messageBodies).where(eq(messageBodies.messageId, messageId)))[0]!;

    it("ACCEPTANCE: the account's own move to the Ohbox refills the body inside that move's completion", async () => {
      const w = await husk("INBOX");
      const moves: Array<{ from: string; to: string }> = [];
      const fetches: string[] = [];
      await reconcileMailbox({ writeAuthority: FIXTURE_LEASE,
        repo: repoOf(), adapter: adapter(moves, fetches), accountId: w.accountId, mailboxId: w.mailboxId,
        storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(),
      } as unknown as Parameters<typeof reconcileMailbox>[0]);
      expect(moves).toEqual([{ from: JUNK, to: "INBOX" }]);
      expect(fetches, "the body is re-read from where the move landed").toEqual(["INBOX"]);
      const b = await bodyOf(w.messageId);
      expect(b.withheldReason, "still a husk after the move landed").toBeNull();
      expect(b.text).toContain("the whole text of a reply");
    });

    it("CONTROL: moved out of Junk in ANOTHER client, the husk stands until the pass — which refills it", async () => {
      const w = await husk(JUNK);
      // What the scan records for a message it finds alive in the Ohbox: a live primary instance.
      await db.insert(messageInstances).values({
        accountId: w.accountId, mailboxId: w.mailboxId, messageId: w.messageId, folder: "INBOX",
        uidvalidity: 3n, uid: 41, isPrimary: true,
      });
      const moves: Array<{ from: string; to: string }> = [];
      const fetches: string[] = [];
      await reconcileMailbox({ writeAuthority: FIXTURE_LEASE,
        repo: repoOf(), adapter: adapter(moves, fetches), accountId: w.accountId, mailboxId: w.mailboxId,
        storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(),
      } as unknown as Parameters<typeof reconcileMailbox>[0]);
      expect(moves, "nothing of ours moved it").toEqual([]);
      expect((await bodyOf(w.messageId)).withheldReason).toBe("junk_filed");

      const repo = repoOf();
      const r = await junkRestorePass({
        repo, adapter: adapter(moves, fetches), accountId: w.accountId, mailboxId: w.mailboxId,
        storageCap: UNMETERED_STORAGE_CAP, write: (fn) => (repo as unknown as { transaction: <T>(f: (r: WorkerRepo) => Promise<T>) => Promise<T> }).transaction(fn),
        refused: new Set(), capDeferred: new Map(), resume: new Map(),
      });
      expect(r.restored).toBe(1);
      expect((await bodyOf(w.messageId)).withheldReason).toBeNull();
    });
  });
}
