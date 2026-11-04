import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, organizerRequests } from "@trafficflow/db";
import {
  CLAIM_PROTOCOL, deriveRequestKey, formatClaim, makeRequestReaderIo, parseClaim,
  readMetaFolderWindow, type LeaseImapClient,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { memoryImapServer, type MemoryImapServer } from "../../../packages/core/test/adapters/_metaworld.js";
import { driveOutstandingRequests } from "../src/request-drain.js";

const META = "INBOX.ohmail._meta";
const toServer = (c: string): string => c.replace(/\//g, ".");
const NOW = new Date("2026-10-02T09:00:00.000Z");
const ACCT = "00000000-0000-0000-0000-000000000a11";

async function oldBuildReads(server: MemoryImapServer): Promise<string> {
  const lock = await server.getMailboxLock(META);
  try {
    const read = await readMetaFolderWindow(server as unknown as LeaseImapClient, META);
    if (read.truncated) return "meta_folder_full";
    const holders = read.records.map((r) => parseClaim(r.raw)).filter((c) => c !== null);
    return holders.length === 0 ? "free" : "held";
  } finally { lock.release(); }
}

/**
 * A STATUS COUNT OLDER THAN THE WINDOW IT PRECEDES (LOW-1). Another
 * writer's records can land between the door's STATUS and its FETCH, so the window holds more than
 * STATUS said. The reader's append headroom is counted from the door's `count`, which must be the
 * larger of the two, or this install's own appends take the folder past the window an old build reads.
 */
describe("a STATUS count older than the window it precedes", () => {
  it("leaves the folder at or under the window after the reader's appends", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, formatClaim({
      installId: "the-holder", kind: "cloud", displayName: "Cloud", claimedAt: NOW, heartbeat: NOW,
      nonce: "n", authorizedAt: NOW, capabilities: ["requests"], protocol: CLAIM_PROTOCOL,
    }), NOW);
    for (let i = 0; i < 494; i++) server.seed(META, `Subject: stray ${i}\r\n\r\nbody`, NOW);
    // Between this read's STATUS and its FETCH, another writer (the holder's acks) lands 5 records.
    let raced = false;
    const client = new Proxy(server as unknown as Record<string | symbol, unknown>, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop === "fetch" && typeof v === "function") {
          return (...args: unknown[]) => {
            if (!raced) { raced = true; for (let i = 0; i < 5; i++) server.seed(META, `Subject: ack-ish ${i}\r\n\r\nb`, NOW); }
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as LeaseImapClient;
    const db = await makeTestDb();
    const [mb] = await db.insert(mailboxes).values({
      accountId: ACCT, provider: "imap", address: `${randomUUID()}@x.example`,
      organizerRole: "reader", organizerState: "held", organizedByCapabilities: "requests",
      organizedByKind: "cloud", organizedByName: "ohmail Cloud",
    }).returning({ id: mailboxes.id });
    for (let i = 0; i < 10; i++) {
      await db.insert(organizerRequests).values({
        id: randomUUID(), accountId: ACCT, mailboxId: mb!.id, kind: "screener.decide",
        payload: { scope: "sender", address: `s${i}@example.com`, appliedFolder: "INBOX", decision: "yes", match: `s${i}@example.com` },
        decidedAt: NOW, state: "pending",
      });
    }
    const out = await driveOutstandingRequests(db, {
      mailboxId: mb!.id, accountId: ACCT, installId: "reader-install",
      adapter: { requestReaderIo: () => makeRequestReaderIo(client, toServer) } as unknown as MailboxAdapter,
      requestKey: deriveRequestKey({ auth: { user: "u@x.example", pass: "basic-account-password" }, address: "u@x.example" })!,
    }, { installId: "reader-install", kind: "local" }, NOW, () => undefined);
    const total = server.tree.get(META)!.messages.length;
    expect(total, `sent ${out.sent}: this install's appends took the folder past the window`).toBeLessThanOrEqual(500);
    expect(await oldBuildReads(server), "an old build no longer reads the holder").toBe("held");
  });
});
