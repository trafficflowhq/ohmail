import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import {
  MetaEnumRefusedError, META_ENUM_RECORDS_MAX, type LeaseIo, type MetaEnumCode, type RawClaimMessage,
} from "@trafficflow/core/adapters/organizer-lease";
import { readFileSync } from "node:fs";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { freshDataDir } from "./_datadir.js";
import { grantOrganizeConsent } from "./_consent.js";
import { createSidecar, type Sidecar } from "../src/engine.js";

/**
 * THE LOCAL DOOR SAYS WHEN IT CANNOT READ ITS OWN FOLDER (CLOCK-SENTENCE-NOT-ON-THE-LOCAL-SURFACE).
 * An organizer whose `ohmail/_meta` read throws organizes nothing, and the list row read `connected`
 * with no block: `unreadableSince` stopped at the runtime. The row now carries `lease_unreadable`
 * from that instant. A READER keeps mirroring when its peek fails, so it gets no "not syncing"
 * sentence; its row says the look did not answer instead of letting a null holder read as nobody.
 * To watch it fail: drop the block from `discloseLocalSyncFailures`, or its `unreadableSince` read.
 */

class Meta implements LeaseIo {
  broken = true;
  /** A folder too full to READ WHOLE: the enumerator's refusal, by record count or by bytes. */
  full: MetaEnumCode | null = null;
  /** A mailbox at its quota: the claim APPEND is refused as Dovecot refuses it. */
  noRoom = false;
  readonly claims: RawClaimMessage[] = [];
  private uid = 1;
  private check(): void { if (this.broken) throw Object.assign(new Error("SEARCH failed"), { code: "ESOCKETFAKE" }); }
  async ensureMetaFolder(): Promise<void> { this.check(); }
  async listClaims(): Promise<RawClaimMessage[]> {
    this.check();
    if (this.full !== null) {
      throw new MetaEnumRefusedError(this.full, { rows: 0, total: META_ENUM_RECORDS_MAX + 1, ceiling: META_ENUM_RECORDS_MAX });
    }
    return this.claims.map((c) => ({ ...c }));
  }
  async appendClaim(raw: string): Promise<void> {
    this.check();
    if (this.noRoom) throw Object.assign(new Error("Command failed"), { responseStatus: "NO", serverResponseCode: "OVERQUOTA" });
    this.claims.push({ ref: this.uid++, raw });
  }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    this.check();
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number | bigint | null { return 7_100; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    this.check();
    return this.claims.filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`)).map((c) => ({ ...c }));
  }
}

const EMPTY: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };

function adapterOver(meta: Meta) {
  return (_cfg: ImapConfig): MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): { listClaims(): Promise<RawClaimMessage[]> } } => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
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
  });
}

describe("the local mailbox list says what the runtime knows about the lease", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function boot(opts: { organizer: boolean; broken: boolean; full?: MetaEnumCode; noRoom?: boolean }) {
    const meta = new Meta();
    meta.broken = opts.broken;
    meta.noRoom = opts.noRoom ?? false;
    meta.full = opts.full ?? null;
    const dataDir = await freshDataDir("ohmail-lease-unreadable-");
    const sidecar: Sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test", machineName: "the laptop",
      pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000,
      adapterFactory: adapterOver(meta), log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    if (opts.organizer) await grantOrganizeConsent(sidecar);
    await sidecar.start();
    const listed = async () => {
      const res = await sidecar.handle(new Request("http://engine.invalid/mailboxes", {
        headers: { authorization: `Bearer ${sidecar.sessionToken}` },
      }));
      const body = (await res.json()) as { items: Array<Record<string, unknown>> };
      return body.items.find((m) => m.id === sidecar.world.mailboxId)!;
    };
    return { sidecar, meta, listed };
  }

  it("an organizer whose lease read throws is listed as blocked, from the runtime's own instant", async () => {
    const w = await boot({ organizer: true, broken: true });
    const since = w.sidecar.organizerState().unreadableSince;
    expect(since, "the lease read never failed, so this case is about nothing").not.toBeNull();
    expect(w.sidecar.organizerState().unreadableReason).toBe("lease_unreadable");
    const row = await w.listed();
    expect(row.status, "an unreadable lease is not a mailbox fault").toBe("connected");
    expect(row.syncBlockedReason).toBe("lease_unreadable");
    expect(row.syncBlockedSince).toBe(since);
  }, 60_000);

  /* A FULL `ohmail/_meta` IS NAMED, not "cannot read": the desktop row reads the reason the
     runtime derived with the worker's own `leaseBlockReason`, through this overlay. */
  it.each(["over_ceiling", "bytes"] as const)("an organizer whose _meta is too full (%s) is listed meta_folder_full", async (full) => {
    const w = await boot({ organizer: true, broken: false, full });
    const since = w.sidecar.organizerState().unreadableSince;
    expect(since, "the lease read never refused, so this case is about nothing").not.toBeNull();
    expect(w.sidecar.organizerState().unreadableReason).toBe("meta_folder_full");
    const row = await w.listed();
    expect(row.status, "a full folder is not a mailbox fault").toBe("connected");
    expect(row.syncBlockedReason).toBe("meta_folder_full");
    expect(row.syncBlockedSince).toBe(since);
  }, 60_000);

  it("an organizer whose claim is refused for room is listed mailbox_full", async () => {
    const w = await boot({ organizer: true, broken: false, noRoom: true });
    const since = w.sidecar.organizerState().unreadableSince;
    expect(since, "the claim was never refused, so this case is about nothing").not.toBeNull();
    expect(w.sidecar.organizerState().unreadableReason).toBe("mailbox_full");
    const row = await w.listed();
    expect([row.status, row.syncBlockedReason, row.syncBlockedSince]).toEqual(["connected", "mailbox_full", since]);
  }, 60_000);

  it("ONE DERIVATION: the engine spells no lease block reason of its own", () => {
    const code = withoutComments(readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8"));
    expect(code.includes("leaseBlockReason("), "the derivation is called").toBe(true);
    // The read's control: a sibling reason the overlay does spell is counted through the same path.
    expect(code.split('"awaiting_credentials"').length - 1).toBeGreaterThan(0);
    expect(code.split('"lease_unreadable"').length - 1).toBe(0);
  });

  it("CONTROL: the same organizer with a readable lease carries no block", async () => {
    const w = await boot({ organizer: true, broken: false });
    expect(w.sidecar.organizerState().unreadableSince).toBeNull();
    const row = await w.listed();
    expect(row.syncBlockedReason).toBeNull();
    expect(row.syncBlockedSince).toBeNull();
  }, 60_000);

  it("a reader whose peek throws gets no block, and its row says the look did not answer", async () => {
    const w = await boot({ organizer: false, broken: true });
    expect(w.sidecar.organizerState().unreadableSince, "the peek never failed").not.toBeNull();
    const row = await w.listed();
    expect(row.organizerRole).toBe("reader");
    expect(row.syncBlockedSince, "a reader keeps mirroring, so 'not syncing' would be false").toBeNull();
    expect(row.organizerChecked, "an unreadable look read as 'nobody holds it'").toBe(false);
  }, 60_000);

  it("CONTROL: a reader whose peek answers nobody has been looked at", async () => {
    const w = await boot({ organizer: false, broken: false });
    const row = await w.listed();
    expect(row.organizerRole).toBe("reader");
    expect(row.organizedBy).toBeNull();
    expect(row.organizerChecked).toBe(true);
  }, 60_000);
});
