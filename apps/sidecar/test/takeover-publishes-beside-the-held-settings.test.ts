import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import { formatClaim, type LeaseIo, type RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage,
  type OrganizerProfileDoc, type ParsedProfileMessage, type ProfileIo, type RawProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import { mailboxes, organizerRequests } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { freshDataDir } from "./_datadir.js";

/**
 * A TAKEOVER'S EDITS REACH THE MAILBOX, ON THE DESKTOP'S OWN DOOR. W-old organized the mailbox and
 * left its settings in `ohmail/_meta`; this install presses "Organize here instead". A rule made
 * before the claim lands is written here (it answered 409), and once the claim lands this install's
 * document carries it beside W-old's, which stays until the person answers (nothing of this
 * install's reached the mailbox). Nothing is asked of W-old either way.
 */

const GENERATION = 4_100;
function drop<T extends { ref: unknown }>(list: T[], refs: readonly unknown[]): void {
  const gone = new Set(refs);
  for (let i = list.length - 1; i >= 0; i--) if (gone.has(list[i]!.ref)) list.splice(i, 1);
}
class MemoryMeta implements LeaseIo, ProfileIo {
  private nextUid = 1;
  readonly claims: RawClaimMessage[] = [];
  readonly profiles: Array<{ ref: number; raw: string }> = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> { drop(this.claims, refs); }
  uidValidity(): number { return GENERATION; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[]> {
    return this.claims.filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`)).map((c) => ({ ...c }));
  }
  async listProfileMessages(): Promise<RawProfileMessage[]> {
    return this.profiles.map((p) => ({ ref: p.ref, raw: p.raw, generation: GENERATION }));
  }
  async appendProfile(raw: string): Promise<void> { this.profiles.push({ ref: this.nextUid++, raw }); }
  async removeProfiles(refs: readonly unknown[]): Promise<void> { drop(this.profiles, refs); }
  docs(): ParsedProfileMessage[] {
    return this.profiles.map((p) => parseProfileMessage(p.raw, p.ref))
      .filter((r): r is ParsedProfileMessage => r !== null && !isMalformedProfile(r));
  }
}
const EMPTY: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
const factory = (meta: MemoryMeta) => (_cfg: ImapConfig): MailboxAdapter => ({
  leaseIo: () => meta, leasePeekIo: () => ({ listClaims: () => meta.listClaims() }), profileIo: () => meta,
  async connect(): Promise<void> {}, async close(): Promise<void> {},
  async capabilities(): Promise<ImapCapabilities> {
    return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
  },
  async ensureFolders(): Promise<void> {},
  async changesSince(): Promise<ChangeBatch> { return EMPTY; },
  async move(): Promise<never> { throw new Error("nothing is filed here"); },
  async setFlags(): Promise<void> {},
  async scanSentRecipients(): Promise<string[]> { return []; },
  async watch(): Promise<() => Promise<void>> { return async () => {}; },
  async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("no send"); },
  async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart"); },
} as unknown as MailboxAdapter);

const DAY = 24 * 60 * 60 * 1000;
const OLD_DOC = makeProfileDoc({
  screener: [{ address: "friend@elsewhere.example" }], rules: [], notifyRules: [], awayResponder: null,
  tagNames: ["theirs"], signature: null,
}, { updatedAt: new Date(Date.now() - 12 * DAY), producer: { kind: "local", version: "0.25.1" } });

describe("an edit during and after a takeover reaches the mailbox beside the held settings", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  /** `own`: settings this install left under an earlier mailbox row, in place of W-old's claim and settings. */
  async function boot(o: { own?: OrganizerProfileDoc } = {}): Promise<{ sidecar: Sidecar; meta: MemoryMeta; call: (m: string, p: string, b?: unknown) => Promise<Response> }> {
    const meta = new MemoryMeta();
    const at = new Date(Date.now() - 12 * DAY);
    if (o.own === undefined) {
      await meta.appendClaim(formatClaim({
        installId: "local:w-old", kind: "local", displayName: "W-old", heartbeat: at, claimedAt: at,
        nonce: "old", authorizedAt: null, capabilities: ["requests", "profile"],
      }));
      await meta.appendProfile(formatProfileMessage(OLD_DOC, { installId: "local:w-old" }));
    }
    const dataDir = await freshDataDir("ohmail-takeover-publish-");
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test", machineName: "the new laptop",
      pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000, profileFlushIntervalMs: 0,
      // The stored credential the import card's route asks for.
      ...(o.own === undefined ? {} : { keks: { 1: Buffer.alloc(32, 9) } }),
      adapterFactory: factory(meta), log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    // The desktop's install id is its store's account row, which outlives a removed mailbox row.
    if (o.own !== undefined) await meta.appendProfile(formatProfileMessage(o.own, { installId: sidecar.world.accountId }));
    await sidecar.start();
    const call = (method: string, path: string, body?: unknown) => sidecar.handle(new Request(`http://engine.invalid${path}`, {
      method, headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const res = await call("POST", `/local/mailboxes/${sidecar.world.mailboxId}/organize`, { screening: { scope: "window" }, intent: "takeover" });
    expect(res.status).toBe(200);
    return { sidecar, meta, call };
  }
  const RULE = { kind: "sender", match: "new@b.test", destination: "INBOX" };
  const reading = async (w: Awaited<ReturnType<typeof boot>>, status: number) => ({
    status,
    role: (await w.sidecar.db.select().from(mailboxes).where(eq(mailboxes.id, w.sidecar.world.mailboxId)))[0]!.organizerRole,
    requests: (await w.sidecar.db.select().from(organizerRequests)).length,
    docs: w.meta.docs().map((d) => [d.installId === "local:w-old" ? "w-old" : "this install", d.doc!.rules.map((r) => r.match)]),
  });

  it("a rule made BEFORE the claim lands is written here and published once it lands", async () => {
    const w = await boot();
    const res = await w.call("POST", "/rules", RULE);
    await w.sidecar.syncUntilQuiet();
    expect(await reading(w, res.status)).toEqual({
      status: 201, role: "organizer", requests: 0,
      docs: [["w-old", []], ["this install", ["new@b.test"]]],
    });
  }, 60_000);

  it("a rule made AFTER the claim lands is published beside the held settings", async () => {
    const w = await boot();
    await w.sidecar.syncUntilQuiet();
    const res = await w.call("POST", "/rules", RULE);
    await w.sidecar.syncUntilQuiet();
    expect(await reading(w, res.status)).toEqual({
      status: 201, role: "organizer", requests: 0,
      docs: [["w-old", []], ["this install", ["new@b.test"]]],
    });
  }, 60_000);

  /* THE MAILBOX REMOVED AND ADDED AGAIN on this desktop: the new row's store says nothing yet, and
     the settings the earlier row left are kept and offered, never replaced by an empty copy. */
  it("settings this install left under an earlier mailbox row stand, and the card asks about them", async () => {
    const earlier = makeProfileDoc({
      screener: [{ address: "friend@elsewhere.example", source: "person" }],
      rules: [{ kind: "sender", match: "promo@shop.example", destination: "ohmail/Screened", priority: 0, enabled: true, provenance: "manual" }],
      notifyRules: [], awayResponder: null, tagNames: ["kept"], signature: "-- \nfrom this laptop",
    }, { updatedAt: new Date(Date.now() - 2 * DAY), producer: { kind: "local", version: "0.30.16" } });
    const w = await boot({ own: earlier });
    for (let i = 0; i < 3; i++) await w.sidecar.syncUntilQuiet();
    const card = await w.call("GET", `/mailboxes/${w.sidecar.world.mailboxId}/profile-import`);
    expect({
      docs: w.meta.docs().map((d) => [d.doc!.rules.map((r) => r.match), d.doc!.signature]),
      card: ((await card.json()) as { state?: string }).state,
    }).toEqual({ docs: [[["promo@shop.example"], "-- \nfrom this laptop"]], card: "found" });
  }, 60_000);
});
