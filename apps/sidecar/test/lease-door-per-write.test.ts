import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isNull } from "drizzle-orm";
import {
  ImapAdapter, type ChangeBatch, type FetchedPart, type ImapCapabilities, type ImapConfig,
  type MailboxAdapter, type MoveManyResult, type NativeLocator, type OutboundMessage,
  type SendResult,
} from "@trafficflow/core/adapters/imap";
import { randomUUID } from "node:crypto";
import { deriveRequestKey, formatRequest } from "@trafficflow/core/adapters/organizer-lease";
import type {
  LeaseIo, RawClaimMessage, RawMetaMessage, MetaRecordsList, RequestOrganizerIo,
} from "@trafficflow/core/adapters/organizer-lease";
import type { ProfileIo, RawProfileMessage } from "@trafficflow/core/adapters/organizer-profile";
import { folderState, mailboxes, messages } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { createSidecarLogger, diagnosticFor } from "../src/log.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ═══ THE LOCAL ENGINE'S TWIN: A CLAIM THAT AGES OUT MID-BATCH SENDS NO MOVE ══════════════════
 *
 * `apps/worker/test/lease-door-per-write.test.ts` drives the cycle with a permit built by hand.
 * This drives the desktop and phone engine's own composition — its gate, its adopted permit, its
 * clock — into the same seam: the page check is served inside the permit's minute, and the batch's
 * preflight then outlives the claim (a laptop lid closed mid-batch). The adapter's filing verbs are
 * the REAL `ImapAdapter` over a scripted client, so the window is the shipped one.
 */

let nowMs = Date.parse("2026-09-24T09:00:00.000Z");
const now = (): Date => new Date(nowMs);
const ADDRESS = "owner@trafficflow.test";

/** `ohmail/_meta` in memory: the claims, one reader's request, and every write made to it. */
class Meta {
  claims: RawClaimMessage[] = [];
  /** Every `_meta` write other than the gate's own claim, in order — the drain's tail. */
  readonly tail: string[] = [];
  private readonly records = new Map<number, string>();
  private nextUid = 1;
  seedRequest(mailboxId: string, key: string): void {
    this.records.set(this.nextUid++, formatRequest({
      requestId: randomUUID(), kind: "screener.decide", mailboxId,
      installId: "reader-install", organizerKind: "local", decidedAt: new Date(nowMs - 5_000),
      payload: { scope: "sender", address: "person@example.test", appliedFolder: "INBOX", decision: "yes" },
      key,
    }));
  }
  readonly organizer: RequestOrganizerIo = {
    listMetaRecords: async (): Promise<MetaRecordsList> => {
      const records: RawMetaMessage[] = [...this.records.entries()].map(([ref, raw]) => ({ ref, raw }));
      return { records, count: records.length, bytes: records.reduce((n, r) => n + r.raw.length, 0) };
    },
    uidValidity: (): number => 4_100,
    ack: async (raw: string): Promise<void> => { this.tail.push("meta:ack"); this.records.set(this.nextUid++, raw); },
    remove: async (refs: readonly unknown[]): Promise<void> => {
      this.tail.push("meta:expunge");
      for (const r of refs) if (typeof r === "number") this.records.delete(r);
    },
    sweepStaleAcks: async (): Promise<number> => { this.tail.push("meta:sweep"); return 0; },
  };
  readonly lease: LeaseIo = {
    ensureMetaFolder: async (): Promise<void> => undefined,
    listClaims: async (): Promise<RawClaimMessage[]> => this.claims.map((c) => ({ ...c })),
    appendClaim: async (raw: string): Promise<void> => { this.claims.push({ ref: this.nextUid++, raw }); },
    removeClaims: async (refs: readonly unknown[]): Promise<void> => {
      const gone = new Set(refs);
      this.claims = this.claims.filter((c) => !gone.has(c.ref));
    },
    uidValidity: (): number => 4_100,
  };
  readonly profile: ProfileIo = {
    ensureMetaFolder: async (): Promise<void> => undefined,
    listProfileMessages: async (): Promise<RawProfileMessage[]> => [],
    appendProfile: async (): Promise<void> => { this.tail.push("profile:append"); },
    removeProfiles: async (): Promise<void> => undefined,
  };
}

interface Rig { meta: Meta; writes: string[]; armed: boolean; tailAtJump: number | null }

/** The filing verbs' client: one INBOX, MOVE + UIDPLUS, and the clock jump in the FETCH. */
function scriptedClient(rig: Rig) {
  let nextDst = 700;
  const client = {
    usable: true,
    capabilities: new Map<string, boolean>([["IDLE", true], ["UIDPLUS", true], ["MOVE", true]]),
    mailbox: false as unknown,
    async list() {
      return ["INBOX", "ohmail/Screener"]
        .map((path) => ({ path, name: path, delimiter: "/", flags: new Set<string>() }));
    },
    async getMailboxLock(path: string) {
      client.mailbox = { path, exists: 1, uidValidity: 1n };
      return { path, release() { /* nothing */ } };
    },
    async fetchAll(range: string) {
      if (rig.armed) { rig.armed = false; rig.tailAtJump = rig.meta.tail.length; nowMs += 11 * 60 * 1000; }
      return range.split(",").map(Number).map((uid) => ({ uid, envelope: { messageId: `<f${uid}@rig.test>` } }));
    },
    async search() { return [] as number[]; },
    async messageMove(uids: number[], to: string) {
      rig.writes.push(`MOVE ${JSON.stringify(uids)} -> ${to}`);
      return { uidValidity: 3n, uidMap: new Map(uids.map((u) => [u, nextDst++])) };
    },
    async logout() { /* nothing */ },
    close() { /* nothing */ },
  };
  return client;
}

function rigAdapter(rig: Rig): (cfg: ImapConfig) => MailboxAdapter {
  const filing = new ImapAdapter(
    { host: "rig.invalid", port: 0, secure: false, auth: { user: "u", pass: "p" } },
    { client: scriptedClient(rig) as never },
  );
  let connected: Promise<void> | null = null;
  const ready = (): Promise<void> => (connected ??= filing.connect());
  const empty: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
  const adapter: MailboxAdapter & Record<string, unknown> = {
    leaseIo: () => rig.meta.lease,
    requestOrganizerIo: () => rig.meta.organizer,
    profileIo: () => rig.meta.profile,
    async connect(): Promise<void> { await ready(); },
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> { return filing.capabilities(); },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...empty }; },
    async move(...args: unknown[]): Promise<NativeLocator> {
      return (filing.move as (...a: unknown[]) => Promise<NativeLocator>)(...args);
    },
    async moveMany(...args: unknown[]): Promise<MoveManyResult> {
      return (filing.moveMany as (...a: unknown[]) => Promise<MoveManyResult>)(...args);
    },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this rig cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this rig cannot fetchPart"); },
  } as MailboxAdapter & Record<string, unknown>;
  return () => adapter;
}

describe("the local engine asks the lease at the write", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    nowMs = Date.parse("2026-09-24T09:00:00.000Z");
  });

  const events = (lines: readonly string[]): string[] =>
    lines.map((l) => (JSON.parse(l) as { event?: string }).event ?? "");

  async function boot(rig: Rig, lines: string[]): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-leasedoor-");
    const logger = createSidecarLogger({ level: "info", sink: (l) => lines.push(l) });
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: ADDRESS, pass: "mailbox-unreached-password" } },
      address: ADDRESS,
      machineName: "organizing host",
      pollIntervalMs: 60 * 60 * 1000,
      profileFlushIntervalMs: 0,
      adapterFactory: rigAdapter(rig),
      now,
      log: diagnosticFor(logger),
      logger,
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    await sidecar.db.update(mailboxes)
      .set({ organizeConsentedAt: new Date(nowMs), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    await sidecar.start();
    nowMs += 5_000;
    return sidecar;
  }

  async function seedPendingFiling(s: Sidecar, uid: number): Promise<void> {
    const dedup = `mid:leasedoor-${uid}@rig.test`;
    const [m] = await s.db.insert(messages).values({
      accountId: s.world.accountId, mailboxId: s.world.mailboxId,
      messageIdHeader: dedup, bodyHash: `hash-${uid}`, dedupKey: dedup,
      subject: `filing ${uid}`, fromAddress: "person@example.test", snippet: "an extract",
      nativeLocator: { folder: "INBOX", ref: `1:${uid}` }, createdAt: new Date(nowMs),
    }).returning();
    await s.db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, observedFolder: "INBOX", desiredFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "pending",
    });
  }

  const requestKey = (): string => {
    const key = deriveRequestKey({ auth: { user: ADDRESS, pass: "mailbox-unreached-password" }, address: ADDRESS });
    if (key === null) throw new Error("this rig's mailbox has no request key");
    return key;
  };

  it("a claim that ages out inside the batch's preflight sends no UID MOVE", async () => {
    const rig: Rig = { meta: new Meta(), writes: [], armed: false, tailAtJump: null };
    const lines: string[] = [];
    const sidecar = await boot(rig, lines);
    expect(sidecar.organizerState().organizing, "the precondition: this install organizes").toBe(true);
    await seedPendingFiling(sidecar, 61);
    rig.meta.seedRequest(sidecar.world.mailboxId, requestKey());
    rig.armed = true;

    // A decline ends the drain at its page; it is not a failed sync.
    await sidecar.syncMailbox(sidecar.world.mailboxId);

    expect(rig.writes, "a UID MOVE went out on a claim older than its window").toEqual([]);
    expect(rig.tailAtJump, "the claim never aged inside the preflight").not.toBeNull();
    expect(rig.meta.tail.slice(rig.tailAtJump!), "the drain's tail wrote to _meta after the decline")
      .toEqual([]);
    expect(events(lines)).toContain("write_declined_mid_cycle");
    expect(events(lines), "a decline was filed as a failed cycle").not.toContain("sync_cycle_failed");

    // AND THE NEXT PASS'S GATE RENEWS the claim nobody else took, and files the mail.
    await sidecar.syncMailbox(sidecar.world.mailboxId);
    expect(rig.writes).toEqual(["MOVE [61] -> ohmail/Screener"]);
    expect(sidecar.organizerState().organizing).toBe(true);
  });

  it("POSITIVE CONTROL — a claim held throughout files the mail on the first pass", async () => {
    const rig: Rig = { meta: new Meta(), writes: [], armed: false, tailAtJump: null };
    const lines: string[] = [];
    const sidecar = await boot(rig, lines);
    await seedPendingFiling(sidecar, 62);
    rig.meta.seedRequest(sidecar.world.mailboxId, requestKey());

    await sidecar.syncMailbox(sidecar.world.mailboxId);

    expect(rig.writes).toEqual(["MOVE [62] -> ohmail/Screener"]);
    // The tail runs on a held claim: the reader's request is acknowledged.
    expect(rig.meta.tail).toContain("meta:ack");
    expect(events(lines)).not.toContain("write_declined_mid_cycle");
  });
});
