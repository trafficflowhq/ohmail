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
import { createSidecar, type Sidecar } from "../src/engine.js";

/**
 * THE DESKTOP NAMES A `_meta` IT CANNOT CLEAN, A WRONG CLOCK, AND SHRINKS A FULL ONE — each read off
 * the mailbox list through the overlay, from the REAL gate over an in-process server.
 *  · a folder that takes no delete: renewals stop and the row reads `meta_undeletable`;
 *  · a clock an hour behind the server's: the row reads `clock_off` (LOW-2);
 *  · a folder past the read ceiling holding our own day-old claims: the refused arm sweeps it and
 *    the block clears with no press.
 */

const META = "INBOX.ohmail._meta";
const INSTALL = "desk-test";
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

async function until(pred: () => Promise<boolean> | boolean, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => { setTimeout(r, 50); });
  }
  return false;
}

const oursIn = (s: MemoryImapServer): number => s.tree.get(META)!.messages
  .filter((m) => new RegExp(`^X-Ohmail-Install-Id: ${INSTALL}\\r?$`, "m").test(m.raw)).length;

describe("the desktop row names what the gate could not do", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function boot(server: MemoryImapServer) {
    const lines: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const dataDir = await freshDataDir("ohmail-meta-undeletable-");
    const sidecar: Sidecar = await createSidecar({
      dataDir, installId: INSTALL,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test", machineName: "the laptop",
      pollIntervalMs: 100, idlePollCeilingMs: 200, leaseStaleAfterMs: 60_000,
      adapterFactory: adapterOver(server), log: (event, detail) => { lines.push({ event, detail }); },
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    await grantOrganizeConsent(sidecar);
    await sidecar.start();
    const listed = async () => {
      const res = await sidecar.handle(new Request("http://engine.invalid/mailboxes", {
        headers: { authorization: `Bearer ${sidecar.sessionToken}` },
      }));
      const body = (await res.json()) as { items: Array<Record<string, unknown>> };
      return body.items.find((m) => m.id === sidecar.world.mailboxId)!;
    };
    /* Past the bound that turns failing lease cycles into a dead connection (eight): a named
       state is the server ANSWERING, so the row must still name it, never "connection lost". */
    const afterCycles = async (): Promise<Record<string, unknown>> => {
      const failed = (): number => lines.filter((l) => l.event === "sync_cycle_failed").length;
      const from = failed();
      expect(await until(() => failed() >= from + 10), "the poll stopped cycling").toBe(true);
      return listed();
    };
    return { sidecar, listed, lines, afterCycles };
  }

  it("a folder that takes no delete stops the renewals and is listed meta_undeletable", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const w = await boot(server);
    expect(await until(() => oursIn(server) > 0), "the desktop never claimed the mailbox").toBe(true);
    server.startLyingAboutDeletes();
    expect(await until(() => w.sidecar.organizerState().unreadableReason === "meta_undeletable"),
      "a folder that takes no delete was never named").toBe(true);
    const claims = oursIn(server);
    await new Promise((r) => { setTimeout(r, 1_000); });
    expect(oursIn(server), "a blocked desktop kept appending").toBe(claims);
    const row = await w.afterCycles();
    expect([row.status, row.syncBlockedReason]).toEqual(["connected", "meta_undeletable"]);
  }, 60_000);

  it("a clock an hour off the server's is listed clock_off, end to end", async () => {
    const server = memoryImapServer({
      prefix: "INBOX.", folders: ["INBOX.ohmail", META],
      afterAppend: (s, path) => {
        const last = s.tree.get(path)!.messages.at(-1)!;
        last.internalDate = new Date(last.internalDate.getTime() + 3_600_000);
      },
    });
    const w = await boot(server);
    expect(await until(() => w.sidecar.organizerState().unreadableReason === "clock_off"),
      "a wrong clock never reached the runtime").toBe(true);
    const row = await w.afterCycles();
    expect([row.status, row.syncBlockedReason]).toEqual(["connected", "clock_off"]);
  }, 60_000);

  it("a full _meta of our own day-old claims is swept on the refused arm and clears with no press", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const twoDays = Date.now() - 2 * 86_400_000;
    for (let i = 0; i < META_ENUM_RECORDS_MAX - 1_200; i++) server.seed(META, `Subject: filed ${i}\r\n\r\nb`, new Date(twoDays));
    for (let i = 0; i < 1_200; i++) {
      const hb = new Date(twoDays - i * 1_000);
      server.seed(META, formatClaim({ installId: INSTALL, kind: "local", displayName: "the laptop", heartbeat: hb,
        claimedAt: hb, nonce: `old-${i}`, authorizedAt: null, capabilities: [] }), hb);
    }
    /* The server's clock as the folder shows it — the sweep's cutoff is the newest INTERNALDATE
       less a day (SWEEP-CUTOFF-READS-THE-HOST-CLOCK): mail filed there today, last. */
    server.seed(META, "Subject: filed today\r\n\r\nb", new Date());
    const w = await boot(server);
    expect(await until(async () => w.sidecar.organizerState().organizing
      && (await w.listed()).syncBlockedReason === null, 45_000), "the full folder never cleared").toBe(true);
    expect(w.lines.find((l) => l.event === "meta_shrink")?.detail)
      .toMatchObject({ phase: "lease_refused", ran: true, swept: 1_000 });
  }, 60_000);
});
