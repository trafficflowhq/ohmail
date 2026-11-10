import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import {
  makeLeaseIo, makeLeasePeekIo, makeRequestOrganizerIo, META_ENUM_RECORDS_MAX,
} from "@trafficflow/core/adapters/organizer-lease";
import { memoryImapServer, type MemoryImapServer } from "../../../packages/core/test/adapters/_metaworld.js";
import { freshDataDir } from "./_datadir.js";
import { grantOrganizeConsent } from "./_consent.js";
import { LOCAL_CONNECTION_DEAD_AFTER_CYCLES, createSidecar } from "../src/engine.js";

/**
 * AN ORGANIZING PHONE WHOSE POLL GATE STARTS REFUSING (HIGH-1, its probe kept):
 * the engine keeps `organizing` — Stop and Start read it — and carries the reason beside it, which
 * the phone reads first (`apps/mobile/test/meta-blocked-said.test.ts`); a healthy pass clears it.
 */
const META = "INBOX.ohmail._meta";
const INSTALL = "phone-poll";
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


describe("the poll arm over a folder that fills while this install organizes", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  it("three refused polls carry meta_folder_full beside organizing, and a healthy pass clears it", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const lines: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const dataDir = await freshDataDir("ohmail-poll-arm-");
    const sidecar = await createSidecar({
      dataDir, installId: INSTALL,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test", machineName: "the phone",
      pollIntervalMs: 200, idlePollCeilingMs: 200, leaseStaleAfterMs: 600_000,
      adapterFactory: adapterOver(server), log: (event, detail) => { lines.push({ event, detail }); },
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    await grantOrganizeConsent(sidecar);
    await sidecar.start();
    const state = () => Object.values(sidecar.organizerStates())[0]!;
    expect(state().organizing, "the fixture never organized").toBe(true);
    for (let i = 0; i < META_ENUM_RECORDS_MAX + 50; i++) server.seed(META, `Subject: filed ${i}\r\n\r\nb`, new Date());
    const refused = (): number => lines.filter((l) => l.event === "sync_cycle_failed").length;
    const end = Date.now() + 20_000;
    while (Date.now() < end && refused() < 3) await new Promise((r) => setTimeout(r, 50));
    expect(refused(), "three polls never ran").toBeGreaterThanOrEqual(3);
    expect(lines.some((l) => l.event === "lease_enum_refused")).toBe(true);
    expect([state().organizing, state().claimed, state().unreadableReason]).toEqual([true, true, "meta_folder_full"]);
    const f = server.tree.get(META)!;
    f.messages = f.messages.filter((m) => !m.raw.includes("Subject: filed"));
    const healed = Date.now() + 20_000;
    while (Date.now() < healed && state().unreadableReason !== null) await new Promise((r) => setTimeout(r, 50));
    expect([state().organizing, state().unreadableReason], "a healthy pass left the reason standing").toEqual([true, null]);
  }, 60_000);

  /* A MAILBOX THAT FILLS TO ITS QUOTA while this install organizes: the renew is refused for room,
     a named block, so past the dead-connection bound's cycle arm nothing re-dials and the row keeps
     the reason; room returned clears it. */
  it("a mailbox at its quota stays mailbox_full past the dead-connection bound, and room clears it", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const lines: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const dataDir = await freshDataDir("ohmail-poll-arm-full-");
    const sidecar = await createSidecar({
      dataDir, installId: INSTALL,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test", machineName: "the laptop",
      pollIntervalMs: 200, idlePollCeilingMs: 200, leaseStaleAfterMs: 600_000,
      adapterFactory: adapterOver(server), log: (event, detail) => { lines.push({ event, detail }); },
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    await grantOrganizeConsent(sidecar);
    await sidecar.start();
    const state = () => Object.values(sidecar.organizerStates())[0]!;
    expect(state().organizing, "the fixture never organized").toBe(true);
    server.seed("INBOX", `Subject: a letter\r\n\r\n${"x".repeat(8_192)}`);
    server.misbehave({ quota: { limit: server.usage() } });
    const refused = (): number => lines.filter((l) => l.event === "sync_cycle_failed").length;
    const end = Date.now() + 30_000;
    while (Date.now() < end && refused() < LOCAL_CONNECTION_DEAD_AFTER_CYCLES + 2) await new Promise((r) => setTimeout(r, 50));
    expect(refused(), "the polls never passed the cycle bound").toBeGreaterThanOrEqual(LOCAL_CONNECTION_DEAD_AFTER_CYCLES + 2);
    expect(state().unreadableReason).toBe("mailbox_full");
    expect(lines.map((l) => l.event), "a full mailbox was read as a dead connection").not.toContain("mailbox_connection_unavailable");
    const res = await sidecar.handle(new Request("http://engine.invalid/mailboxes", {
      headers: { authorization: `Bearer ${sidecar.sessionToken}` },
    }));
    const row = ((await res.json()) as { items: Array<Record<string, unknown>> }).items[0]!;
    expect([row.status, row.syncBlockedReason, row.errorCode ?? null]).toEqual(["connected", "mailbox_full", null]);
    server.misbehave({ quota: { limit: server.usage() + 4_096 } });
    const healed = Date.now() + 20_000;
    while (Date.now() < healed && state().unreadableReason !== null) await new Promise((r) => setTimeout(r, 50));
    expect([state().organizing, state().unreadableReason], "room returned left the reason standing").toEqual([true, null]);
  }, 60_000);
});
