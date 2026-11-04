import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import {
  formatClaim, makeLeaseIo, makeLeasePeekIo, makeRequestOrganizerIo, META_ENUM_RECORDS_MAX,
} from "@trafficflow/core/adapters/organizer-lease";
import { memoryImapServer, type MemoryImapServer } from "../../../packages/core/test/adapters/_metaworld.js";
import { freshDataDir } from "./_datadir.js";
import { grantOrganizeConsent } from "./_consent.js";
import { createSidecar } from "../src/engine.js";

/**
 * THE DESKTOP'S LAUNCH ARM SHRINKS A FULL `_meta` (DESKTOP-LAUNCH-ARM-DOES-NOT-SHRINK): a folder too
 * full to read at launch is swept by the launch itself, not one poll later, and a sweep that fails
 * there says why — its line carries the thrown value, so the class and the code reach the log.
 * The poll interval is a minute, so nothing in these cases is the poll's doing.
 */
const META = "INBOX.ohmail._meta";
const INSTALL = "desk-launch";
const toPath = (c: string): string => c.replace(/\//g, ".");
const EMPTY: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };

function adapterOver(server: MemoryImapServer) {
  return (_cfg: ImapConfig): MailboxAdapter => ({
    leaseIo: (id: { installId: string; mailboxId: string }) => makeLeaseIo(server, toPath, id),
    leasePeekIo: () => makeLeasePeekIo(server, toPath),
    requestOrganizerIo: (id: { installId: string; mailboxId: string }) => makeRequestOrganizerIo(server, toPath, id),
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...EMPTY }; },
    async move(): Promise<never> { throw new Error("nothing moves here"); },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  } as unknown as MailboxAdapter);
}

/** Past the ceiling: filed mail, our own day-old claims on top, and today's filed mail last. */
function fullServer(): MemoryImapServer {
  const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
  const twoDays = Date.now() - 2 * 86_400_000;
  for (let i = 0; i < META_ENUM_RECORDS_MAX - 1_200; i++) server.seed(META, `Subject: filed ${i}\r\n\r\nb`, new Date(twoDays));
  for (let i = 0; i < 1_200; i++) {
    const hb = new Date(twoDays - i * 1_000);
    server.seed(META, formatClaim({ installId: INSTALL, kind: "local", displayName: "the laptop", heartbeat: hb,
      claimedAt: hb, nonce: `old-${i}`, authorizedAt: null, capabilities: [] }), hb);
  }
  server.seed(META, "Subject: filed today\r\n\r\nb", new Date());
  return server;
}

describe("the desktop's launch arm", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function launch(server: MemoryImapServer) {
    const lines: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const dataDir = await freshDataDir("ohmail-launch-shrink-");
    const sidecar = await createSidecar({
      dataDir, installId: INSTALL,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test", machineName: "the laptop",
      pollIntervalMs: 60_000, idlePollCeilingMs: 60_000, leaseStaleAfterMs: 60_000,
      adapterFactory: adapterOver(server), log: (event, detail) => { lines.push({ event, detail }); },
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    await grantOrganizeConsent(sidecar);
    await sidecar.start();
    return lines;
  }

  it("sweeps a folder too full to read at launch, before any poll", async () => {
    const server = fullServer();
    const lines = await launch(server);
    expect(lines.some((l) => l.event === "start_lease_unavailable"), "the launch was not refused, so this case is about nothing")
      .toBe(true);
    expect(lines.find((l) => l.event === "meta_shrink")?.detail, "a full folder seen at launch waited for the poll")
      .toMatchObject({ phase: "lease_refused", ran: true, swept: 1_000 });
    expect(server.tree.get(META)!.messages.length).toBeLessThanOrEqual(META_ENUM_RECORDS_MAX);
  }, 60_000);

  it("a sweep that fails at launch names its class and code", async () => {
    const server = fullServer();
    server.startLyingAboutDeletes();
    const lines = await launch(server);
    const note = lines.find((l) => l.event === "organizer_requests_note" && l.detail.outcome === "meta_ack_sweep_failed");
    expect(note, "the launch's failed sweep was not reported").toBeDefined();
    const said = JSON.stringify(note!.detail);
    expect(said, "the line named the event and not the fault").toMatch(/LeaseUnavailableError|RequestUnavailableError/);
  }, 60_000);
});
