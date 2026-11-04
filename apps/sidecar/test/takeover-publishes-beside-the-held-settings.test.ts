import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import { formatClaim, type LeaseIo, type RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage, profileFingerprint,
  type OrganizerProfileDoc, type ParsedProfileMessage, type ProfileIo, type RawProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import { applyOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import {
  accountSettings, fencedAccountWrite, folderState, lockAccountRuleKeys, mailboxes, messageBodies, messages, organizerRequests, rules as ruleRows, ruleRemovals,
} from "@trafficflow/db";
import { resetScreeningState } from "@trafficflow/services";
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
/** The folder as an unreachable server answers it while `net.offline` holds: every call refused. */
const reachable = <T extends object>(io: T, net: { offline: boolean }): T => new Proxy(io, {
  get(target, prop, receiver) {
    const v = Reflect.get(target, prop, receiver) as unknown;
    if (typeof v !== "function") return v;
    return (...args: unknown[]) => {
      if (net.offline) throw Object.assign(new Error("offline"), { code: "ENOTFOUND" });
      return (v as (...a: unknown[]) => unknown).apply(target, args);
    };
  },
});
const factory = (meta: MemoryMeta, net: { offline: boolean } = { offline: false }) => (_cfg: ImapConfig): MailboxAdapter => ({
  leaseIo: () => reachable(meta, net), leasePeekIo: () => ({ listClaims: () => reachable(meta, net).listClaims() }),
  profileIo: () => reachable(meta, net),
  async connect(): Promise<void> { if (net.offline) throw Object.assign(new Error("offline"), { code: "ENOTFOUND" }); },
  async close(): Promise<void> {},
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

/* A DATA FOLDER RESTORED FROM A BACKUP: the store keeps its install id and mailbox row but not the
   rule made after the backup. That rule's copy stays in the mailbox and the card asks about it. */
describe("a desktop restored from a backup", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
  const launch = async (meta: MemoryMeta, dir: string, net?: { offline: boolean }) => {
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test", machineName: "the laptop",
      pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000, profileFlushIntervalMs: 0,
      keks: { 1: Buffer.alloc(32, 9) }, adapterFactory: factory(meta, net), log: () => {},
    });
    await sidecar.start();
    const call = (method: string, path: string, body?: unknown) => sidecar.handle(new Request(`http://engine.invalid${path}`, {
      method, headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    return { sidecar, call };
  };
  const rule = (match: string) => ({ kind: "sender", match, destination: "INBOX" });
  /** Rule a, a clean stop and a backup; rule b in the later life; then the backup launched, three passes. */
  const lives = async (meta: MemoryMeta, organize: object, offline?: string) => {
    const dataDir = await freshDataDir("ohmail-restore-");
    const backup = mkdtempSync(join(tmpdir(), "ohmail-restore-backup-"));
    cleanups.push(() => { rmSync(dataDir, { recursive: true, force: true }); rmSync(backup, { recursive: true, force: true }); });
    const rules = (): string[][] => meta.docs().map((d) => d.doc!.rules.map((r) => r.match).sort());
    const one = await launch(meta, dataDir);
    expect((await one.call("POST", `/local/mailboxes/${one.sidecar.world.mailboxId}/organize`, organize)).status).toBe(200);
    expect((await one.call("POST", "/rules", rule("a@b.test"))).status).toBe(201);
    await one.sidecar.syncUntilQuiet();
    const first = rules();
    await one.sidecar.stop();
    cpSync(dataDir, backup, { recursive: true });

    // A second apart: a copy's write stamp is whole seconds.
    await new Promise((r) => setTimeout(r, 1_100));
    const two = await launch(meta, dataDir);
    expect((await two.call("POST", "/rules", rule("b@b.test"))).status).toBe(201);
    await two.sidecar.syncUntilQuiet();
    const second = rules();
    await two.sidecar.stop();

    await new Promise((r) => setTimeout(r, 1_100));
    // Opened offline when `offline` names a rule: made on the restored laptop before it first reads the folder.
    const net = { offline: offline !== undefined };
    const three = await launch(meta, backup, net);
    cleanups.push(async () => { await three.sidecar.stop(); });
    if (offline !== undefined) {
      await three.sidecar.syncUntilQuiet().catch(() => undefined);
      expect((await three.call("POST", "/rules", rule(offline))).status).toBe(201);
      net.offline = false;
    }
    for (let i = 0; i < 3; i++) await three.sidecar.syncUntilQuiet();
    const card = await three.call("GET", `/mailboxes/${three.sidecar.world.mailboxId}/profile-import`);
    return { first, second, restored: rules(), card: ((await card.json()) as { state?: string }).state };
  };

  it("keeps the settings it wrote after the backup, and the card asks", async () => {
    expect(await lives(new MemoryMeta(), { screening: { scope: "window" } })).toEqual({
      first: [["a@b.test"]], second: [["a@b.test", "b@b.test"]], restored: [["a@b.test", "b@b.test"]], card: "found",
    });
  }, 120_000);

  /* A RULE MADE BEFORE THE FIRST READ is newer than the later life's copy and still does not make that copy
     the restored store's own: kept, and the card asks. */
  it("a rule made before its first read of the folder: keeps the later settings, and the card asks", async () => {
    expect(await lives(new MemoryMeta(), { screening: { scope: "window" } }, "c@b.test")).toEqual({
      first: [["a@b.test"]], second: [["a@b.test", "b@b.test"]], restored: [["a@b.test", "b@b.test"]], card: "found",
    });
  }, 120_000);

  /* Not now on W-old's settings, a backup, a rule in the later life: the restored laptop's card asks about
     the later settings next, and after Not now on them its own rules reach the mailbox, across a restart. */
  it("Not now on another install's settings before the backup: the card asks about the later settings, then the rules made here reach the mailbox", async () => {
    const meta = new MemoryMeta();
    const at = new Date(Date.now() - 12 * DAY);
    await meta.appendClaim(formatClaim({
      installId: "local:w-old", kind: "local", displayName: "W-old", heartbeat: at, claimedAt: at,
      nonce: "old", authorizedAt: null, capabilities: ["requests", "profile"],
    }));
    await meta.appendProfile(formatProfileMessage(OLD_DOC, { installId: "local:w-old" }));
    const dataDir = await freshDataDir("ohmail-restore-");
    const backup = mkdtempSync(join(tmpdir(), "ohmail-restore-backup-"));
    cleanups.push(() => { rmSync(dataDir, { recursive: true, force: true }); rmSync(backup, { recursive: true, force: true }); });
    const ours = (): string[][] => meta.docs().filter((d) => d.installId !== "local:w-old").map((d) => d.doc!.rules.map((r) => r.match).sort());
    const card = async (s: Awaited<ReturnType<typeof launch>>) =>
      (await (await s.call("GET", `/mailboxes/${s.sidecar.world.mailboxId}/profile-import`)).json()) as { state?: string; fingerprint?: string };
    const decline = async (s: Awaited<ReturnType<typeof launch>>, fingerprint?: string) =>
      (await s.call("POST", `/mailboxes/${s.sidecar.world.mailboxId}/profile-import/decline`, { fingerprint })).status;
    const one = await launch(meta, dataDir);
    expect((await one.call("POST", `/local/mailboxes/${one.sidecar.world.mailboxId}/organize`, { screening: { scope: "window" }, intent: "takeover" })).status).toBe(200);
    expect((await one.call("POST", "/rules", rule("a@b.test"))).status).toBe(201);
    await one.sidecar.syncUntilQuiet();
    const theirs = await card(one);
    expect([theirs.state, await decline(one, theirs.fingerprint)]).toEqual(["found", 200]);
    await one.sidecar.syncUntilQuiet();
    await one.sidecar.stop();
    cpSync(dataDir, backup, { recursive: true });

    await new Promise((r) => setTimeout(r, 1_100));
    const two = await launch(meta, dataDir);
    expect((await two.call("POST", "/rules", rule("b@b.test"))).status).toBe(201);
    await two.sidecar.syncUntilQuiet();
    await two.sidecar.stop();

    await new Promise((r) => setTimeout(r, 1_100));
    const three = await launch(meta, backup);
    cleanups.push(async () => { await three.sidecar.stop(); });
    await three.sidecar.syncUntilQuiet();
    expect((await three.call("POST", "/rules", rule("c@b.test"))).status).toBe(201);
    for (let i = 0; i < 3; i++) await three.sidecar.syncUntilQuiet();
    const later = await card(three);
    const waiting = ours();
    expect(await decline(three, later.fingerprint)).toBe(200);
    for (let i = 0; i < 3; i++) await three.sidecar.syncUntilQuiet();
    const published = ours();
    await three.sidecar.stop();

    const four = await launch(meta, backup);
    cleanups.push(async () => { await four.sidecar.stop(); });
    expect((await four.call("POST", "/rules", rule("d@b.test"))).status).toBe(201);
    for (let i = 0; i < 3; i++) await four.sidecar.syncUntilQuiet();
    expect({ later: [later.state, later.fingerprint !== theirs.fingerprint], waiting, published, restarted: ours(), card: (await card(four)).state }).toEqual({
      later: ["found", true],
      waiting: [["a@b.test", "b@b.test"]],
      published: [["a@b.test", "b@b.test"], ["a@b.test", "c@b.test"]],
      restarted: [["a@b.test", "b@b.test"], ["a@b.test", "c@b.test", "d@b.test"]],
      card: "declined",
    });
  }, 120_000);

  /* Backed up while the card asked about W-old's settings: the later life's copy beside them stays too. */
  it("restored while it asked about another install's settings, keeps both", async () => {
    const meta = new MemoryMeta();
    const at = new Date(Date.now() - 12 * DAY);
    await meta.appendClaim(formatClaim({
      installId: "local:w-old", kind: "local", displayName: "W-old", heartbeat: at, claimedAt: at,
      nonce: "old", authorizedAt: null, capabilities: ["requests", "profile"],
    }));
    await meta.appendProfile(formatProfileMessage(OLD_DOC, { installId: "local:w-old" }));
    expect(await lives(meta, { screening: { scope: "window" }, intent: "takeover" })).toEqual({
      first: [[], ["a@b.test"]], second: [[], ["a@b.test", "b@b.test"]], restored: [[], ["a@b.test", "b@b.test"]], card: "found",
    });
  }, 120_000);

  /* IMPORT OF W-OLD'S SETTINGS ON THE RESTORED LAPTOP, merged where the store is, makes an empty store say
     exactly what they say: the later settings beside them stay and are the card's next question. The press
     handed to the organizer, and a store with a rule of its own, end the same way. */
  it.each([
    ["an empty store, merged where it is", null, "inline"],
    ["a store with a rule of its own, merged where it is", "a@b.test", "inline"],
    ["an empty store, handed to the organizer", null, "route"],
  ] as const)("Import of another install's settings on a restored laptop (%s): the later settings stay and the card asks", async (_, own, via) => {
    const meta = new MemoryMeta();
    const at = new Date(Date.now() - 12 * DAY);
    await meta.appendClaim(formatClaim({
      installId: "local:w-old", kind: "local", displayName: "W-old", heartbeat: at, claimedAt: at,
      nonce: "old", authorizedAt: null, capabilities: ["requests", "profile"],
    }));
    await meta.appendProfile(formatProfileMessage(OLD_DOC, { installId: "local:w-old" }));
    const dataDir = await freshDataDir("ohmail-restore-");
    const backup = mkdtempSync(join(tmpdir(), "ohmail-restore-backup-"));
    cleanups.push(() => { rmSync(dataDir, { recursive: true, force: true }); rmSync(backup, { recursive: true, force: true }); });
    const card = async (s: Awaited<ReturnType<typeof launch>>) =>
      (await (await s.call("GET", `/mailboxes/${s.sidecar.world.mailboxId}/profile-import`)).json()) as { state?: string; fingerprint?: string };
    const one = await launch(meta, dataDir);
    expect((await one.call("POST", `/local/mailboxes/${one.sidecar.world.mailboxId}/organize`, { screening: { scope: "window" }, intent: "takeover" })).status).toBe(200);
    if (own !== null) expect((await one.call("POST", "/rules", rule(own))).status).toBe(201);
    await one.sidecar.syncUntilQuiet();
    await one.sidecar.stop();
    cpSync(dataDir, backup, { recursive: true });

    await new Promise((r) => setTimeout(r, 1_100));
    const two = await launch(meta, dataDir);
    expect((await two.call("POST", "/rules", rule("b@b.test"))).status).toBe(201);
    await two.sidecar.syncUntilQuiet();
    await two.sidecar.stop();
    const later = meta.docs().find((d) => d.installId !== "local:w-old")!.doc!;

    await new Promise((r) => setTimeout(r, 1_100));
    const three = await launch(meta, backup);
    cleanups.push(async () => { await three.sidecar.stop(); });
    for (let i = 0; i < 3; i++) await three.sidecar.syncUntilQuiet();
    const asked = await card(three);
    const { accountId, mailboxId } = three.sidecar.world;
    if (via === "route") {
      expect((await three.call("POST", `/mailboxes/${mailboxId}/profile-import`, { fingerprint: asked.fingerprint })).status).toBe(202);
    } else {
      // The route's own merge, as the import service runs it once its read of the mailbox fits the request.
      await fencedAccountWrite(three.sidecar.db as never, { accountId }, async (tx) => {
        await lockAccountRuleKeys(tx as never, accountId);
        await applyOrganizerProfile(tx as never, { accountId, mailboxId, doc: OLD_DOC, fingerprint: profileFingerprint(OLD_DOC), now: new Date() });
      });
    }
    for (let i = 0; i < 4; i++) await three.sidecar.syncUntilQuiet();
    const next = await card(three);
    expect({
      asked: asked.fingerprint === profileFingerprint(OLD_DOC),
      kept: meta.docs().some((d) => d.installId !== "local:w-old" && profileFingerprint(d.doc!) === profileFingerprint(later)),
      card: [next.state, next.fingerprint === profileFingerprint(later)],
    }).toEqual({ asked: true, kept: true, card: ["found", true] });
  }, 120_000);
});

/* THE STOOD-DOWN ORGANIZER COUNTS WITH THE NEW ORGANIZER'S WINDOW. W-old consented hours before the
   takeover; the new install's window starts at its own consent. A sender whose newest letter lies
   between the two cutoffs waited on W-old's Screener for as long as W-old mirrored its own document,
   which stood as the newest until the new organizer's first decision was published. */
describe("after a takeover, the install that stood down shows the new organizer's Screener count", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
  const HOUR = 60 * 60 * 1000;
  /** Both installs' clock: moved past the reader's settings-mirror cadence, never the lease's staleness alone. */
  const clock = { skew: 0 };
  const at = (ms: number): Date => new Date(Date.now() + clock.skew + ms);

  const launch = async (meta: MemoryMeta, machineName: string) => {
    const dataDir = await freshDataDir("ohmail-takeover-counts-");
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test", machineName,
      pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000, profileFlushIntervalMs: 0,
      adapterFactory: factory(meta), log: () => {}, now: () => at(0), dkimKeys: null,
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    await sidecar.start();
    const call = (method: string, path: string, body?: unknown) => sidecar.handle(new Request(`http://engine.invalid${path}`, {
      method, headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    return { sidecar, call };
  };
  /** The same held mail on both installs: one sender inside both windows, one between the two cutoffs. */
  const held = async (s: Sidecar, between: Date) => {
    const { accountId, mailboxId } = s.world;
    const letters = [["recent@stranger.test", at(-HOUR)], ["between@stranger.test", between]] as const;
    for (const [i, [from, date]] of letters.entries()) {
      const key = `takeover-counts:${from}`;
      const [m] = await s.db.insert(messages).values({
        accountId, mailboxId, bodyHash: key, dedupKey: key, messageIdHeader: key, subject: "Hello", snippet: "",
        fromAddress: from, fromName: from, date, arrivedAt: date, unread: false, createdAt: date,
        nativeLocator: { folder: "ohmail/Screener", ref: `1:${i + 1}` },
      }).returning();
      await s.db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
      await s.db.insert(folderState).values({
        messageId: m!.id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener", lastSetBy: "us",
        reconcileStatus: "reconciled", conflict: false,
      });
    }
  };
  const waiting = async (w: Awaited<ReturnType<typeof launch>>) =>
    ((await (await w.call("GET", "/screener?live=1")).json()) as { total?: number }).total;
  const role = async (s: Sidecar) =>
    (await s.db.select().from(mailboxes).where(eq(mailboxes.id, s.world.mailboxId)))[0]!.organizerRole;

  it("one reader pass after the new organizer's first pass, both installs count the same senders", async () => {
    const meta = new MemoryMeta();
    const old = await launch(meta, "W-old");
    expect((await old.call("POST", `/local/mailboxes/${old.sidecar.world.mailboxId}/organize`, { screening: { scope: "window" } })).status).toBe(200);
    // W-old's settings say something, so the new organizer holds them for the person's answer.
    expect((await old.call("POST", "/rules", { kind: "sender", match: "news@shop.test", destination: "INBOX" })).status).toBe(201);
    // W-old's consent, six hours before the takeover's.
    await old.sidecar.db.update(accountSettings).set({ screeningBaselineAt: at(-6 * HOUR) })
      .where(eq(accountSettings.accountId, old.sidecar.world.accountId));
    await old.sidecar.syncUntilQuiet();
    expect(meta.docs().length, "W-old published its settings").toBe(1);

    const next = await launch(meta, "the new laptop");
    expect((await next.call("POST", `/local/mailboxes/${next.sidecar.world.mailboxId}/organize`, { screening: { scope: "window" }, intent: "takeover" })).status).toBe(200);
    await next.sidecar.syncUntilQuiet();
    await old.sidecar.syncUntilQuiet();
    // Past the mirror's cadence: the new organizer renews its claim, then W-old's reader pass reads the folder.
    clock.skew += 6 * 60_000;
    await next.sidecar.syncUntilQuiet();
    await old.sidecar.syncUntilQuiet();
    // Inside W-old's default 60-day cutoff by three hours, outside the new organizer's.
    const between = at(-60 * 24 * HOUR - 3 * HOUR);
    await held(old.sidecar, between);
    await held(next.sidecar, between);
    expect({
      roles: [await role(old.sidecar), await role(next.sidecar)],
      held: meta.docs().some((d) => d.doc!.rules.length === 1),
      waiting: [await waiting(old), await waiting(next)],
    }).toEqual({ roles: ["reader", "organizer"], held: true, waiting: [1, 1] });
  }, 120_000);
});

/* THE INSTALL THAT STOOD DOWN TAKES THE MAILBOX BACK. The new organizer decided nothing, so its copy says only
   its window. W-old, relaunched, presses "Organize here instead": that copy is no question to import (an Import
   of it would retire every rule W-old made), and W-old's own settings are the mailbox's newest again. */
describe("the install that stood down takes the mailbox back after a relaunch", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
  const HOUR = 60 * 60 * 1000;
  const clock = { skew: 0 };
  const at = (ms: number): Date => new Date(Date.now() + clock.skew + ms);

  const launch = async (meta: MemoryMeta, machineName: string, dataDir: string) => {
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test", machineName,
      pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000, profileFlushIntervalMs: 0,
      keks: { 1: Buffer.alloc(32, 9) }, adapterFactory: factory(meta), log: () => {}, now: () => at(0), dkimKeys: null,
    });
    let stopped = false;
    cleanups.push(async () => { if (!stopped) await sidecar.stop(); });
    await sidecar.start();
    const call = (method: string, path: string, body?: unknown) => sidecar.handle(new Request(`http://engine.invalid${path}`, {
      method, headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    return { sidecar, call, stop: async () => { stopped = true; await sidecar.stop(); } };
  };
  type Install = Awaited<ReturnType<typeof launch>>;
  const organize = async (w: Install, intent?: "takeover") =>
    (await w.call("POST", `/local/mailboxes/${w.sidecar.world.mailboxId}/organize`, { screening: { scope: "window" }, ...(intent === undefined ? {} : { intent }) })).status;
  const passes = async (n: number, ...ws: Install[]) => { for (let i = 0; i < n; i++) for (const w of ws) await w.sidecar.syncUntilQuiet(); };

  it("the new organizer decided nothing: no card, W-old keeps its rules and its copy is the newest", async () => {
    const meta = new MemoryMeta();
    const dir = await freshDataDir("ohmail-take-back-");
    cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }));
    let old = await launch(meta, "W-old", dir);
    expect(await organize(old)).toBe(200);
    for (const match of ["news@shop.test", "bank@bank.test"]) {
      expect((await old.call("POST", "/rules", { kind: "sender", match, destination: "INBOX" })).status).toBe(201);
    }
    await passes(1, old);
    clock.skew += 3 * HOUR;
    await passes(1, old);

    const nextDir = await freshDataDir("ohmail-take-back-");
    cleanups.unshift(() => rmSync(nextDir, { recursive: true, force: true }));
    const next = await launch(meta, "the new laptop", nextDir);
    expect(await organize(next, "takeover")).toBe(200);
    await passes(2, next, old);

    clock.skew += 10 * 60_000;
    await old.stop();
    old = await launch(meta, "W-old", dir);
    await passes(2, old, next);
    expect(await organize(old, "takeover")).toBe(200);
    await passes(1, old, next);
    const card = (await (await old.call("GET", `/mailboxes/${old.sidecar.world.mailboxId}/profile-import`)).json()) as { state?: string };
    const newest = meta.docs().sort((a, b) => Date.parse(b.doc!.updatedAt) - Date.parse(a.doc!.updatedAt))[0]!;
    expect({
      card: card.state,
      rules: (await old.sidecar.db.select().from(ruleRows)).map((r) => r.match).sort(),
      newest: [newest.installId === old.sidecar.world.accountId ? "W-old" : "the new laptop", newest.doc!.rules.map((r) => r.match).sort()],
    }).toEqual({ card: "none", rules: ["bank@bank.test", "news@shop.test"], newest: ["W-old", ["bank@bank.test", "news@shop.test"]] });
  }, 120_000);

  /* A REMOVAL ON THE INTERIM ORGANIZER STICKS. The new laptop imported W-old's settings and the person removed a
     rule there; W-old takes the mailbox back and imports the new laptop's settings: that rule is gone here too. */
  it("a rule removed on the new organizer after its Import stays removed when W-old takes back and imports", async () => {
    clock.skew = 0;
    const meta = new MemoryMeta();
    const dir = await freshDataDir("ohmail-take-back-");
    cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }));
    const card = async (w: Install) =>
      (await (await w.call("GET", `/mailboxes/${w.sidecar.world.mailboxId}/profile-import`)).json()) as { state?: string; fingerprint?: string };
    const importIt = async (w: Install) =>
      (await w.call("POST", `/mailboxes/${w.sidecar.world.mailboxId}/profile-import`, { fingerprint: (await card(w)).fingerprint })).status;
    const rules = async (w: Install) => (await w.sidecar.db.select().from(ruleRows)).map((r) => r.match).sort();
    let old = await launch(meta, "W-old", dir);
    expect(await organize(old)).toBe(200);
    for (const match of ["keep@shop.test", "gone@shop.test"]) {
      expect((await old.call("POST", "/rules", { kind: "sender", match, destination: "ohmail/Screened" })).status).toBe(201);
    }
    await passes(1, old);
    clock.skew += 3 * HOUR;
    await passes(1, old);

    const nextDir = await freshDataDir("ohmail-take-back-");
    cleanups.unshift(() => rmSync(nextDir, { recursive: true, force: true }));
    const next = await launch(meta, "the new laptop", nextDir);
    expect(await organize(next, "takeover")).toBe(200);
    await passes(2, next, old);
    expect(await importIt(next)).toBe(202);
    await passes(3, next, old);
    const imported = await rules(next);
    clock.skew += HOUR;
    const gone = (await next.sidecar.db.select().from(ruleRows)).find((r) => r.match === "gone@shop.test")!;
    expect((await next.call("DELETE", `/rules/${gone.id}`)).status).toBe(204);
    await passes(3, next, old);

    clock.skew += 10 * 60_000;
    await old.stop();
    old = await launch(meta, "W-old", dir);
    await passes(2, old, next);
    expect(await organize(old, "takeover")).toBe(200);
    await passes(2, old, next);
    const asked = (await card(old)).state;
    expect(await importIt(old)).toBe(202);
    await passes(4, old, next);
    const newest = meta.docs().sort((a, b) => Date.parse(b.doc!.updatedAt) - Date.parse(a.doc!.updatedAt))[0]!;
    expect({
      imported, asked,
      rules: await rules(old),
      newest: [newest.installId === old.sidecar.world.accountId ? "W-old" : "the new laptop", newest.doc!.rules.map((r) => r.match).sort()],
      // The removal W-old adopted, with the new laptop's own instant and install.
      removed: newest.doc!.removedRules?.map((r) => [r.match, r.by === next.sidecar.world.accountId ? "the new laptop" : r.by]),
    }).toEqual({
      imported: ["gone@shop.test", "keep@shop.test"], asked: "found", rules: ["keep@shop.test"], newest: ["W-old", ["keep@shop.test"]],
      removed: [["gone@shop.test", "the new laptop"]],
    });
  }, 120_000);

  /* A RULE THE OTHER INSTALL NEVER HAD STAYS. The new laptop never answered W-old's settings and made one rule of its
     own; W-old takes back and imports it: W-old's own rules were never removed anywhere, so they are kept. */
  it("the new organizer never had W-old's rules: an Import there adds its rule and keeps W-old's", async () => {
    clock.skew = 0;
    const meta = new MemoryMeta();
    const dir = await freshDataDir("ohmail-take-back-");
    cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }));
    let old = await launch(meta, "W-old", dir);
    expect(await organize(old)).toBe(200);
    for (const match of ["keep@shop.test", "mine@shop.test"]) {
      expect((await old.call("POST", "/rules", { kind: "sender", match, destination: "ohmail/Screened" })).status).toBe(201);
    }
    await passes(1, old);
    clock.skew += 3 * HOUR;
    await passes(1, old);
    const nextDir = await freshDataDir("ohmail-take-back-");
    cleanups.unshift(() => rmSync(nextDir, { recursive: true, force: true }));
    const next = await launch(meta, "the new laptop", nextDir);
    expect(await organize(next, "takeover")).toBe(200);
    await passes(2, next, old);
    clock.skew += HOUR;
    expect((await next.call("POST", "/rules", { kind: "sender", match: "b-only@shop.test", destination: "INBOX" })).status).toBe(201);
    await passes(3, next, old);

    clock.skew += 10 * 60_000;
    await old.stop();
    old = await launch(meta, "W-old", dir);
    await passes(2, old, next);
    expect(await organize(old, "takeover")).toBe(200);
    await passes(2, old, next);
    const card = (await (await old.call("GET", `/mailboxes/${old.sidecar.world.mailboxId}/profile-import`)).json()) as { state?: string; fingerprint?: string };
    expect(card.state).toBe("found");
    expect((await old.call("POST", `/mailboxes/${old.sidecar.world.mailboxId}/profile-import`, { fingerprint: card.fingerprint })).status).toBe(202);
    await passes(2, old, next);
    expect((await old.sidecar.db.select().from(ruleRows)).map((r) => r.match).sort())
      .toEqual(["b-only@shop.test", "keep@shop.test", "mine@shop.test"]);
  }, 120_000);

  /* EVERY RULE REMOVED IS NOT "DECIDED NOTHING". The new laptop imported W-old's one rule and the person removed it
     there, so its copy names no rule: it still asks, and the Import removes the rule here too. */
  it("the new organizer removed the only rule: the card still asks and the Import removes it here", async () => {
    clock.skew = 0;
    const meta = new MemoryMeta();
    const dir = await freshDataDir("ohmail-take-back-");
    cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }));
    const card = async (w: Install) => (await (await w.call("GET", `/mailboxes/${w.sidecar.world.mailboxId}/profile-import`)).json()) as {
      state?: string; fingerprint?: string; counts?: { rules?: number; removedRules?: number };
    };
    let old = await launch(meta, "W-old", dir);
    expect(await organize(old)).toBe(200);
    expect((await old.call("POST", "/rules", { kind: "sender", match: "gone@shop.test", destination: "ohmail/Screened" })).status).toBe(201);
    await passes(1, old);
    clock.skew += 3 * HOUR;
    await passes(1, old);
    const nextDir = await freshDataDir("ohmail-take-back-");
    cleanups.unshift(() => rmSync(nextDir, { recursive: true, force: true }));
    const next = await launch(meta, "the new laptop", nextDir);
    expect(await organize(next, "takeover")).toBe(200);
    await passes(2, next, old);
    expect((await next.call("POST", `/mailboxes/${next.sidecar.world.mailboxId}/profile-import`, { fingerprint: (await card(next)).fingerprint })).status).toBe(202);
    await passes(3, next, old);
    clock.skew += HOUR;
    const gone = (await next.sidecar.db.select().from(ruleRows)).find((r) => r.match === "gone@shop.test")!;
    expect((await next.call("DELETE", `/rules/${gone.id}`)).status).toBe(204);
    await passes(3, next, old);

    clock.skew += 10 * 60_000;
    await old.stop();
    old = await launch(meta, "W-old", dir);
    await passes(2, old, next);
    expect(await organize(old, "takeover")).toBe(200);
    await passes(2, old, next);
    const asked = await card(old);
    const status = asked.state === "found"
      ? (await old.call("POST", `/mailboxes/${old.sidecar.world.mailboxId}/profile-import`, { fingerprint: asked.fingerprint })).status : null;
    await passes(2, old, next);
    expect({ state: asked.state, counts: asked.counts && { rules: asked.counts.rules, removedRules: asked.counts.removedRules }, status,
      rules: (await old.sidecar.db.select().from(ruleRows)).map((r) => r.match) })
      .toEqual({ state: "found", counts: { rules: 0, removedRules: 1 }, status: 202, rules: [] });
  }, 120_000);

  /* A RULE MADE AGAIN ENDS ITS REMOVAL. On the new laptop the person removed k@, made it again, then started the
     Screener over there, which records nothing: no removal of k@ is left to travel. W-old takes back, is asked
     nothing, and keeps k@, as it would had k@ never been removed. */
  it("a rule removed and made again on the new organizer, then wiped by a start-over there, stays on W-old", async () => {
    clock.skew = 0;
    const meta = new MemoryMeta();
    const dir = await freshDataDir("ohmail-take-back-");
    cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }));
    const card = async (w: Install) =>
      (await (await w.call("GET", `/mailboxes/${w.sidecar.world.mailboxId}/profile-import`)).json()) as { state?: string; fingerprint?: string };
    const importIt = async (w: Install) =>
      (await w.call("POST", `/mailboxes/${w.sidecar.world.mailboxId}/profile-import`, { fingerprint: (await card(w)).fingerprint })).status;
    let old = await launch(meta, "W-old", dir);
    expect(await organize(old)).toBe(200);
    for (const match of ["keep@shop.test", "k@shop.test"]) {
      expect((await old.call("POST", "/rules", { kind: "sender", match, destination: "ohmail/Screened" })).status).toBe(201);
    }
    await passes(1, old);
    clock.skew += 3 * HOUR;
    await passes(1, old);
    const nextDir = await freshDataDir("ohmail-take-back-");
    cleanups.unshift(() => rmSync(nextDir, { recursive: true, force: true }));
    const next = await launch(meta, "the new laptop", nextDir);
    expect(await organize(next, "takeover")).toBe(200);
    await passes(2, next, old);
    expect(await importIt(next)).toBe(202);
    await passes(3, next, old);
    clock.skew += HOUR;
    const k = (await next.sidecar.db.select().from(ruleRows)).find((r) => r.match === "k@shop.test")!;
    expect((await next.call("DELETE", `/rules/${k.id}`)).status).toBe(204);
    await passes(2, next, old);
    clock.skew += HOUR;
    expect((await next.call("POST", "/rules", { kind: "sender", match: "k@shop.test", destination: "ohmail/Screened" })).status).toBe(201);
    await passes(2, next, old);
    const removedAfterMakingAgain = (await next.sidecar.db.select().from(ruleRemovals)).map((r) => r.match);
    clock.skew += HOUR;
    const { rulesDeleted } = await resetScreeningState({
      db: next.sidecar.db as never, accountId: next.sidecar.world.accountId, userId: null, now: () => at(0), requestId: "start-over",
    });
    await passes(3, next, old);
    const nextCopy = meta.docs().filter((d) => d.installId === next.sidecar.world.accountId)
      .sort((a, b) => Date.parse(b.doc!.updatedAt) - Date.parse(a.doc!.updatedAt))[0]!.doc!;

    clock.skew += 10 * 60_000;
    await old.stop();
    old = await launch(meta, "W-old", dir);
    await passes(2, old, next);
    expect(await organize(old, "takeover")).toBe(200);
    await passes(2, old, next);
    const asked = (await card(old)).state;
    const status = asked === "found" ? await importIt(old) : null;
    await passes(2, old, next);
    expect({
      removedAfterMakingAgain, rulesDeleted, nextCopy: { rules: nextCopy.rules.length, removed: nextCopy.removedRules?.map((r) => r.match) ?? [] },
      asked, status, rules: (await old.sidecar.db.select().from(ruleRows)).map((r) => r.match).sort(),
    }).toEqual({
      removedAfterMakingAgain: [], rulesDeleted: 2, nextCopy: { rules: 0, removed: [] }, asked: "none", status: null,
      rules: ["k@shop.test", "keep@shop.test"],
    });
  }, 120_000);

  /* A COPY CARRIES THE REMOVALS OF THE YEAR BEFORE IT WAS WRITTEN, and is written only when the settings change:
     with nothing changed, a removal stays in the mailbox past its year; the next save leaves it out, and the next
     removal recorded here forgets it here too. */
  it("a removal stays in the mailbox's copy until the settings are next saved more than a year later", async () => {
    clock.skew = 0;
    const meta = new MemoryMeta();
    const dir = await freshDataDir("ohmail-removal-age-");
    cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }));
    const w = await launch(meta, "W", dir);
    expect(await organize(w)).toBe(200);
    for (const match of ["keep@shop.test", "clinic@health.test"]) {
      expect((await w.call("POST", "/rules", { kind: "sender", match, destination: "ohmail/Screened" })).status).toBe(201);
    }
    await passes(2, w);
    const byMatch = async (match: string) => (await w.sidecar.db.select().from(ruleRows)).find((r) => r.match === match)!;
    expect((await w.call("DELETE", `/rules/${(await byMatch("clinic@health.test")).id}`)).status).toBe(204);
    await passes(3, w);
    const newest = () => meta.docs().sort((a, b) => Date.parse(b.doc!.updatedAt) - Date.parse(a.doc!.updatedAt))[0]!.doc!;
    const removedAt = newest().removedRules![0]!.removedAt;
    for (const days of [30, 120, 240, 395]) {
      clock.skew = days * 24 * HOUR;
      await passes(2, w);
    }
    const stored = async () => (await w.sidecar.db.select().from(ruleRemovals)).map((r) => r.match);
    expect({ removed: newest().removedRules?.map((r) => [r.match, r.removedAt]), stored: await stored() })
      .toEqual({ removed: [["clinic@health.test", removedAt]], stored: ["clinic@health.test"] });
    expect((await w.call("DELETE", `/rules/${(await byMatch("keep@shop.test")).id}`)).status).toBe(204);
    await passes(3, w);
    expect({ removed: newest().removedRules?.map((r) => r.match), stored: await stored() })
      .toEqual({ removed: ["keep@shop.test"], stored: ["keep@shop.test"] });
  }, 120_000);
});
