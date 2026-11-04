import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, organizerRequests } from "@trafficflow/db";
import {
  CLAIM_PROTOCOL, META_RECORDS_MAX_PER_FETCH, deriveRequestKey, formatClaim, makeRequestReaderIo,
  parseClaim, readMetaFolderWindow, requestAppendHeadroom, type LeaseImapClient,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { memoryImapServer, type MemoryImapServer } from "../../../packages/core/test/adapters/_metaworld.js";
import { driveOutstandingRequests } from "../src/request-drain.js";

/**
 * THE OLD BUILD'S READING STAYS TRUE (the mixed-fleet rule). A build up to 0.25.4 reads claims by
 * the newest record window and refuses a truncated one as `meta_folder_full`. After this
 * build's reader appends: at or under the window the folder stays readable to that shape and it
 * reads the holder; past the window it was blind already and refuses, never `free`. The old shape
 * is rebuilt here from the shipped read (window, then the truncation refusal), never remembered.
 */
const META = "INBOX.ohmail._meta";
const toServer = (canonical: string): string => canonical.replace(/\//g, ".");
const NOW = new Date("2026-10-02T09:00:00.000Z");
const ACCT = "00000000-0000-0000-0000-000000000a11";

/** The old build's lease read: one window; truncated refuses; else the holder, or nobody. */
async function oldBuildReads(server: MemoryImapServer): Promise<string> {
  const lock = await server.getMailboxLock(META);
  try {
    const read = await readMetaFolderWindow(server as unknown as LeaseImapClient, META);
    if (read.truncated) return "meta_folder_full";
    const holders = read.records.map((r) => parseClaim(r.raw)).filter((c) => c !== null);
    return holders.length === 0 ? "free" : `held:${(holders[0] as { installId: string }).installId}`;
  } finally {
    lock.release();
  }
}

async function world(o: { strays: number; strayBytes?: number; pending: number }) {
  const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
  server.seed(META, formatClaim({
    installId: "the-holder", kind: "cloud", displayName: "Cloud", claimedAt: NOW, heartbeat: NOW,
    nonce: "n", authorizedAt: NOW, capabilities: ["requests"], protocol: CLAIM_PROTOCOL,
  }), NOW);
  const pad = o.strayBytes === undefined ? "" : "x".repeat(o.strayBytes);
  for (let i = 0; i < o.strays; i++) server.seed(META, `Subject: stray ${i} ${pad}\r\n\r\nbody`, NOW);
  const db = await makeTestDb();
  const [mb] = await db.insert(mailboxes).values({
    accountId: ACCT, provider: "imap", address: `${randomUUID()}@x.example`,
    organizerRole: "reader", organizerState: "held", organizedByCapabilities: "requests",
    organizedByKind: "cloud", organizedByName: "ohmail Cloud",
  }).returning({ id: mailboxes.id });
  for (let i = 0; i < o.pending; i++) {
    await db.insert(organizerRequests).values({
      id: randomUUID(), accountId: ACCT, mailboxId: mb!.id, kind: "screener.decide",
      payload: { scope: "sender", address: `s${i}@example.com`, appliedFolder: "INBOX", decision: "yes", match: `s${i}@example.com` },
      decidedAt: NOW, state: "pending",
    });
  }
  const lines: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const drive = () => driveOutstandingRequests(
    db,
    {
      mailboxId: mb!.id, accountId: ACCT, installId: "reader-install",
      adapter: { requestReaderIo: () => makeRequestReaderIo(server as unknown as LeaseImapClient, toServer) } as unknown as MailboxAdapter,
      requestKey: deriveRequestKey({ auth: { user: "u@x.example", pass: "basic-account-password" }, address: "u@x.example" })!,
    },
    { installId: "reader-install", kind: "local" }, NOW,
    (event, detail) => { lines.push({ event, detail }); },
  );
  const appended = (): number => server.tree.get(META)!.messages.filter((m) => /^X-Ohmail-Request: 1/m.test(m.raw)).length;
  return { server, drive, lines, appended };
}

describe("the reader's appends keep the old build's reading true", () => {
  it("at 480 records with 100 queued: appends 4, defers 96 naming 484 (the holder's reserve kept), and the old shape reads the holder", async () => {
    const w = await world({ strays: 479, pending: 100 });
    expect(w.server.tree.get(META)!.messages).toHaveLength(480);
    const out = await w.drive();
    expect(out.sent).toBe(4);
    expect(w.appended()).toBe(4);
    const deferred = w.lines.find((l) => l.event === "meta_request_append_deferred");
    expect(deferred?.detail).toMatchObject({ queued: 100, appending: 4, ceiling: META_RECORDS_MAX_PER_FETCH - 16, boundBy: "records" });
    expect(await oldBuildReads(w.server)).toBe("held:the-holder");
  });

  it("past the window already: appends inside the enumeration's bound, and the old shape refuses, never free", async () => {
    const w = await world({ strays: META_RECORDS_MAX_PER_FETCH + 20, pending: 100 });
    expect(await oldBuildReads(w.server)).toBe("meta_folder_full");
    const out = await w.drive();
    expect(out.sent).toBe(100);
    expect(await oldBuildReads(w.server)).toBe("meta_folder_full");
  });

  it("the byte half binds before the count half, and the deferral says bytes", async () => {
    // Ten records whose headers come to more than the window's byte ceiling less the append reserve.
    const strayBytes = Math.ceil(requestAppendHeadroom({ count: 0, bytes: 0 }).byteCeiling / 10) + 1024;
    const w = await world({ strays: 10, strayBytes, pending: 5 });
    const out = await w.drive();
    expect(out.sent).toBe(0);
    expect(w.appended()).toBe(0);
    const deferred = w.lines.find((l) => l.event === "meta_request_append_deferred");
    expect(deferred?.detail.boundBy).toBe("bytes");
    expect(await oldBuildReads(w.server)).toBe("held:the-holder");
  });
});
