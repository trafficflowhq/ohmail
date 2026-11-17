import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { EmptySourceError, UNMETERED_STORAGE_CAP, createLogger, type Change } from "@trafficflow/core/mail";
import type { ChangeBatch, ImapCursor, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { accounts, contacts, mailboxes, messageInstances, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { classifyIngestFault } from "../src/dead-letter.js";
import { runSyncCycle } from "../src/sync.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * THE PIPELINE'S OWN REFUSAL OF AN EMPTY SOURCE, THROUGH A CYCLE (IMAP-STREAMING-FETCH-TAKES-
 * UNSOLICITED-FLAGS). The adapter no longer makes an empty create; if one ever reaches the cycle
 * again (another adapter, another driver), it is deferred like any unclassified fault — nothing
 * stored, no folder_state, no server move, the folder's cursor held — and the next read of the UID
 * stores the real letter once. On the old pipeline the empty create was stored as a blank message
 * at the UID and the real letter was refused its place.
 */

describe("classifyIngestFault names the empty source", () => {
  it("as the message's, unclassified and not deterministic: retried, never written off on sight", () => {
    expect(classifyIngestFault(new EmptySourceError(5))).toEqual({ domain: "message", code: "unclassified", deterministic: false });
  });
});

const RAW = Buffer.from([
  "Message-ID: <real-5@x.example>", "From: Anna <anna@x.example>", "To: mila@lichtgrat.example",
  "Subject: the real letter", "Date: Mon, 19 Oct 2026 09:00:00 +0000", "Content-Type: text/plain; charset=utf-8", "", "hello",
].join("\r\n"));

describe("a cycle handed an empty create", () => {
  it("defers it once, stores nothing for it, and stores the real letter once on the next read", async () => {
    const db = (await makeTestDb()) as unknown as Tx;
    const [a] = await db.insert(accounts).values({ name: "empty-source" }).returning();
    const accountId = a!.id;
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "mila@lichtgrat.example" }).returning();
    const mailboxId = mb!.id;
    await db.insert(contacts).values({ accountId, address: "anna@x.example" });
    const repo = makeDrizzleRepo(db);

    const answers: Buffer[] = [Buffer.alloc(0), RAW];
    const adapter = {
      changesSince: async (_c: ImapCursor): Promise<ChangeBatch> => {
        const raw = answers.shift()!;
        const create: Change = { type: "create", locator: { folder: "INBOX", ref: "100:5" }, raw, seen: false };
        return {
          creates: [create], moves: [], flagChanges: [], deletes: [], hasBacklog: false,
          newCursor: { folders: { INBOX: { uidValidity: "100", uidNext: 6, highestModseq: "0" } } },
        } as ChangeBatch;
      },
    } as unknown as MailboxAdapter;
    const lines: string[] = [];
    const cycle = () => runSyncCycle({
      repo, adapter, accountId, mailboxId, role: "organizer", writeAuthority: FIXTURE_LEASE,
      storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(),
      log: createLogger({ service: "worker", level: "info", sink: (l) => lines.push(l) }),
    });

    await expect(cycle()).rejects.toBeInstanceOf(EmptySourceError);
    expect(await db.select().from(messages).where(eq(messages.mailboxId, mailboxId))).toEqual([]);
    const events = lines.map((l) => JSON.parse(l) as { event: string; uid?: number });
    expect(events.filter((e) => e.event === "ingest_empty_source_refused").map((e) => e.uid)).toEqual([5]);
    expect(events.some((e) => e.event === "sync_message_deferred")).toBe(true);

    await cycle();
    const rows = await db.select({ id: messages.id, mid: messages.messageIdHeader }).from(messages)
      .where(eq(messages.mailboxId, mailboxId));
    expect(rows.map((r) => r.mid)).toEqual(["real-5@x.example"]);
    const places = await db.select({ folder: messageInstances.folder, uid: messageInstances.uid }).from(messageInstances)
      .where(eq(messageInstances.mailboxId, mailboxId));
    expect(places).toEqual([{ folder: "INBOX", uid: 5 }]);
  });
});
