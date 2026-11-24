import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  auditLog, changeLog, contacts, folderState, mailboxes, messageBodies, messages, type Tx,
  mailboxPass, readPassProgress,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { runKickstart } from "../src/kickstart.js";

/**
 * ATTACHING A MAILBOX DECIDES NOTHING AND MOVES NOTHING.
 *
 * This file replaces the four that proved the opposite. The connect-time pass they covered read
 * the server's Sent folder, wrote every recipient into `contacts`, and re-filed the held
 * Screener mail of the senders it had just invented — consent taken from a folder listing, and
 * a physical move on connect. Both are now the product's stated opposite: the sent-mail seed
 * SHOWS that list and acts only on a confirmation, and import is read-only.
 *
 * So the assertions are absences, and absences are the easy thing to write and to be wrong
 * about. Every one of them below was watched fail against the old pass before this landed: with
 * the previous body restored, the contacts assertion reports 3 rows where it wants 0 and the
 * re-route assertion finds the held message moved to INBOX.
 *
 * The adapter is deliberately a LOADED one — a Sent folder with three real recipients in it —
 * because the interesting claim is not "an empty mailbox writes nothing" but "a mailbox with
 * plenty to harvest is still left alone".
 */

const SCREENER = "ohmail/Screener";

interface World {
  db: Tx; repo: WorkerRepo; accountId: string; mailboxId: string; address: string;
  adapter: MailboxAdapter; scans: () => number;
}

/** A Sent folder with recipients in it, that COUNTS whether anybody asked. */
function loadedSentAdapter(recipients: string[]): { adapter: MailboxAdapter; scans: () => number } {
  let scans = 0;
  const adapter = {
    async scanSentRecipients(limit?: number): Promise<string[]> {
      scans++;
      return recipients.slice(0, limit ?? recipients.length);
    },
  } as unknown as MailboxAdapter;
  return { adapter, scans: () => scans };
}

async function world(recipients: string[]): Promise<World> {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  const address = `owner-${randomUUID().slice(0, 8)}@lichtgrat.example`;
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address }).returning();
  const { adapter, scans } = loadedSentAdapter(recipients);
  return { db, repo: makeDrizzleRepo(db), accountId, mailboxId: mb!.id, address, adapter, scans };
}

async function seedHeld(w: World, from: string): Promise<string> {
  const [m] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h",
    dedupKey: `seed:${randomUUID()}`, subject: "hello",
    fromAddress: from, nativeLocator: { folder: SCREENER, ref: "1:1" },
  }).returning();
  await w.db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {} });
  await w.db.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, desiredFolder: SCREENER, observedFolder: SCREENER,
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  return m!.id;
}

describe("the connect-time kickstart is retired", () => {
  it("reads no Sent folder and invents no contacts", async () => {
    const w = await world(["lena@atelier.example", "ben@studio.example", "pia@studio.example"]);

    const r = await runKickstart({
      repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId,
    });

    expect(r.ran).toBe(false);
    // The Sent folder was never opened. Consent is not read off a folder listing.
    expect(w.scans()).toBe(0);
    // …and nobody became a known sender without being shown to their own mailbox's owner.
    expect(await w.db.select().from(contacts).where(eq(contacts.accountId, w.accountId)))
      .toHaveLength(0);
  });

  it("moves no held mail, emits no change, and writes no audit row", async () => {
    const w = await world(["lena@atelier.example"]);
    const held = await seedHeld(w, "lena@atelier.example");

    await runKickstart({
      repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId,
    });

    // The sender the OLD pass would have released — it is in the Sent folder above — stays
    // exactly where the mail server has her. A decision about her is the Screener's to ask for.
    const [fs] = await w.db.select().from(folderState).where(eq(folderState.messageId, held));
    expect(fs!.desiredFolder).toBe(SCREENER);
    expect(fs!.lastSetBy).toBe("us");

    expect(await w.db.select().from(changeLog).where(eq(changeLog.accountId, w.accountId)))
      .toHaveLength(0);
    expect(await w.db.select().from(auditLog).where(eq(auditLog.accountId, w.accountId)))
      .toHaveLength(0);
  });

  it("never stamps the fossil marker, so a re-attach cannot be told apart by it", async () => {
    const w = await world(["lena@atelier.example"]);

    await runKickstart({
      repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId,
    });
    await runKickstart({
      repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId,
    });

    // The pass's done mark stands for every mailbox attached before the retirement and is absent
    // for every one since. Nothing may gate work on it — see the module header.
    expect((await readPassProgress(w.db, mailboxPass("kickstart", w.accountId, w.mailboxId))).doneAt).toBeNull();
  });
});
