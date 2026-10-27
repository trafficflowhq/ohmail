import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { decideLease, formatClaim, parseClaim, type OrganizerClaim } from "@trafficflow/core/adapters/organizer-lease";
import { folderState, mailboxes, messageInstances, messages, organizerRequests, rules } from "@trafficflow/db";
import { freshDataDir } from "./_datadir.js";
import { createSidecar, type Sidecar } from "../src/engine.js";

/**
 * THE TAKEOVER PATH'S FIRST DECISION IS KEPT. Setup over a mailbox another install
 * holds: "Organize here instead", Agree, then the guided decision, pressed before the claim lands.
 * The door answered 409 (holder stopped) or queued a request to the holder the claim displaces
 * (holder live), so no rule was ever written and the held mail stayed at the gate. Now the door
 * writes the rule at the press, and the first organizing drain after the claim moves the held
 * mail by it (`ruleRetroPass`). To watch it fail: drop the `takeoverPending` arm of
 * `planAccountFanOut`.
 */

class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number | bigint | null { return 4_100; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`)).map((c) => ({ ...c }));
  }
}

const EMPTY: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };

/** How the mail server's claim folder answers the engine: held, failing or lagging reads. */
interface FolderView {
  /** Holds the engine's FIRST look until it resolves — the first look still in flight. */
  firstLook?: Promise<void>;
  /** Holds the GATE's lease read — the claim not landed yet. Agreeing wakes the gate at once. */
  leaseGate?: Promise<void>;
  /** Every look throws: the claim folder cannot be read. */
  looksFail?: boolean;
  /** Every look and every lease read throws: the mail server does not answer. */
  offline?: boolean;
  /** A holder the looks, and the gate's first lease read, do not see: a lagging view of the folder. */
  missing?: { installId: string; looks: boolean; firstLeaseRead: boolean };
  /** Holds the gate's first lease read, once taken, until it resolves. */
  afterFirstLeaseRead?: () => Promise<void>;
  /** Runs after the gate's nth lease read, and before its nth claim append. */
  afterLeaseRead?: (n: number) => Promise<void> | void;
  beforeAppend?: (n: number) => Promise<void>;
  appends?: number;
  /** Looks and lease reads so far. */
  looks?: number;
  leaseReads?: number;
}

function mailbox(meta: MemoryMetaFolder, moves: Array<{ from: string; to: string }>, view: FolderView = {}) {
  const seen = (all: RawClaimMessage[], hide: boolean | undefined) => (hide && view.missing
    ? all.filter((c) => !c.raw.includes(`X-Ohmail-Install-Id: ${view.missing!.installId}`)) : all);
  return (_cfg: ImapConfig): MailboxAdapter & {
    leaseIo(): LeaseIo; leasePeekIo(): { listClaims(): Promise<RawClaimMessage[]> };
  } => ({
    leaseIo: () => new Proxy(meta, {
      get(target, key) {
        if (key === "listClaims") {
          return async () => {
            await view.leaseGate;
            if (view.offline) throw new Error("the mail server did not answer");
            view.leaseReads = (view.leaseReads ?? 0) + 1;
            const read = seen(await target.listClaims(), view.leaseReads === 1 && view.missing?.firstLeaseRead);
            if (view.leaseReads === 1) await view.afterFirstLeaseRead?.();
            await view.afterLeaseRead?.(view.leaseReads);
            return read;
          };
        }
        if (key === "appendClaim") {
          return async (raw: string) => {
            view.appends = (view.appends ?? 0) + 1;
            await view.beforeAppend?.(view.appends);
            await target.appendClaim(raw);
          };
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }),
    leasePeekIo: () => ({
      listClaims: async () => {
        view.looks = (view.looks ?? 0) + 1;
        if (view.looks === 1) await view.firstLook;
        if (view.looksFail || view.offline) throw new Error("the claim folder could not be read");
        return seen(await meta.listClaims(), view.missing?.looks);
      },
    }),
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...EMPTY }; },
    async move(locator: NativeLocator, to: string): Promise<NativeLocator> {
      moves.push({ from: (locator as { folder: string }).folder, to });
      return { ...(locator as object), folder: to } as NativeLocator;
    },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
}

const DAY = 24 * 60 * 60 * 1000;
const SENDER = "b@b.test";

/** Nothing about organizing was written: no consent and no stamp. */
const nothingWritten = (r: { organizeConsentedAt: Date | null; takeoverAuthorizedAt: Date | null }) => {
  expect(r.organizeConsentedAt, "a consent was written").toBeNull();
  expect(r.takeoverAuthorizedAt, "a takeover stamp was written").toBeNull();
};

describe("the takeover path's first decision is kept", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  /** A consent-less reader over a mailbox W-old claimed; `ageMs` 0 is a live holder. */
  async function boot(ageMs: number, leaseGate?: Promise<void>) {
    const meta = new MemoryMetaFolder();
    const at = new Date(Date.now() - ageMs);
    await meta.appendClaim(formatClaim({
      installId: "local:w-old", kind: "local", displayName: "W-old",
      heartbeat: at, claimedAt: at, nonce: "old", authorizedAt: null, capabilities: ["requests"],
    }));
    const moves: Array<{ from: string; to: string }> = [];
    const dataDir = await freshDataDir("ohmail-takeover-decide-");
    const sidecar: Sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test", machineName: "the new laptop",
      pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000,
      adapterFactory: mailbox(meta, moves, { leaseGate }), log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    await sidecar.start();
    // Two messages from the sender, held at the gate by W-old; this reader recorded them as `peer`.
    const held: string[] = [];
    for (const uid of [1, 2]) {
      const dedup = `mid:${uid}@b.test`;
      const [m] = await sidecar.db.insert(messages).values({
        accountId: sidecar.world.accountId, mailboxId: sidecar.world.mailboxId,
        messageIdHeader: dedup, bodyHash: `h-${uid}`, dedupKey: dedup, subject: `held ${uid}`,
        fromAddress: SENDER, date: new Date(Date.now() - uid * 1000),
        nativeLocator: { folder: "ohmail/Screener", ref: `1:${uid}` },
      }).returning();
      await sidecar.db.insert(messageInstances).values({
        accountId: sidecar.world.accountId, mailboxId: sidecar.world.mailboxId, messageId: m!.id,
        folder: "ohmail/Screener", uidvalidity: 1n, uid, isPrimary: true,
      });
      await sidecar.db.insert(folderState).values({
        messageId: m!.id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
        lastSetBy: "peer", reconcileStatus: "reconciled", conflict: false,
      });
      held.push(m!.id);
    }
    const call = (method: string, path: string, body?: unknown) => sidecar.handle(new Request(`http://engine.invalid${path}`, {
      method, headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const row = async () => (await sidecar.db.select().from(mailboxes).where(eq(mailboxes.id, sidecar.world.mailboxId)))[0]!;
    /** The guided decision as the webapp sends it: Ohbox, sender scope. */
    const decide = () => call("POST", `/screener/${held[0]}`, { decision: "yes", dest: "INBOX", scope: "sender" });
    /** "Organize here instead", then Agree, on the desktop's own door: the press names the takeover. */
    const organize = async () => {
      const res = await call("POST", `/local/mailboxes/${sidecar.world.mailboxId}/organize`, {
        screening: { scope: "window" }, intent: "takeover",
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { outcome: string }).outcome).toBe("authorized");
    };
    /** An Agree that did not choose to take over — the door's own answer, unasserted. */
    const join = () => call("POST", `/local/mailboxes/${sidecar.world.mailboxId}/organize`, {
      screening: { scope: "window" }, intent: "join",
    });
    const ruleFor = async () => (await sidecar.db.select().from(rules).where(eq(rules.match, SENDER)));
    const desired = async () => (await sidecar.db.select({ id: folderState.messageId, d: folderState.desiredFolder })
      .from(folderState)).filter((r) => held.includes(r.id)).map((r) => r.d);
    const requests = async () => sidecar.db.select().from(organizerRequests);
    return { sidecar, moves, held, row, decide, organize, join, ruleFor, desired, requests, call };
  }

  it.each([["stopped", 12 * DAY], ["still renewing", 0]] as const)(
    "holder %s: the press before the claim lands is a rule at once, and no request goes to the holder",
    async (_label, age) => {
      /* THE CLAIM HELD BACK BY ITS LEASE READ: Agree now wakes the gate at once (PERF-026), so the
         window this case presses in is held open here, as a first sync in flight holds it. */
      let release!: () => void;
      const w = await boot(age, new Promise<void>((r) => { release = r; }));
      cleanups.push(() => release());
      await w.organize();
      expect((await w.row()).organizerRole, "the claim has not landed yet").toBe("reader");
      expect((await w.row()).takeoverAuthorizedAt).not.toBeNull();

      const res = await w.decide();
      const body = (await res.json()) as { mailboxes?: { filed: string[]; awaiting?: string[] } };
      expect(res.status, "the door took the decision").toBe(200);
      expect(body.mailboxes?.awaiting, "it says the move waits on the claim").toEqual([w.sidecar.world.mailboxId]);
      expect(body.mailboxes?.filed).toEqual([]);
      const [rule] = await w.ruleFor();
      expect(rule?.destination, "the decision is a rule the moment it is made").toBe("INBOX");
      expect(rule?.retroRequestedAt, "and the rule owes its held mail").not.toBeNull();
      expect(await w.requests(), "nothing is asked of the install the claim displaces").toHaveLength(0);
      expect(await w.desired(), "a reader moves nothing before the claim").toEqual(["ohmail/Screener", "ohmail/Screener"]);
    }, 60_000);

  it("after the claim lands, the held mail moves on the first organizing drain, with no second press", async () => {
    const w = await boot(12 * DAY);
    await w.organize();
    expect((await w.decide()).status).toBe(200);

    await w.sidecar.syncUntilQuiet();

    expect((await w.row()).organizerRole, "the claim landed").toBe("organizer");
    expect(await w.ruleFor(), "the rule survives the claim").toHaveLength(1);
    expect(await w.desired(), "the held mail is filed by the rule").toEqual(["INBOX", "INBOX"]);
    expect(w.moves.filter((m) => m.from === "ohmail/Screener" && m.to === "INBOX"),
      "and it reached the mail server").toHaveLength(2);
  }, 60_000);

  it("CONTROL: the same decision from the Screener after the claim files at once", async () => {
    const w = await boot(12 * DAY);
    await w.organize();
    await w.sidecar.syncUntilQuiet();
    expect((await w.row()).organizerRole).toBe("organizer");

    const res = await w.decide();
    const body = (await res.json()) as { mailboxes?: { filed: string[]; awaiting?: string[] } };
    expect(res.status).toBe(200);
    expect(body.mailboxes?.filed).toEqual([w.sidecar.world.mailboxId]);
    expect(body.mailboxes?.awaiting).toBeUndefined();
    expect(await w.desired()).toEqual(["INBOX", "INBOX"]);
  }, 60_000);

  /* THE ACCOUNT DOORS TAKE THE SAME ROAD: a rule, an away reply and a screening choice made
     before the claim lands are written here, with nothing asked of the displaced holder. */
  it.each([["stopped", 12 * DAY], ["still renewing", 0]] as const)(
    "holder %s: a rule, an away reply and a screening choice before the claim lands are written here",
    async (_label, age) => {
      /* THE CLAIM HELD BACK BY ITS LEASE READ: Agree now wakes the gate at once (PERF-026), so the
         window this case presses in is held open here, as a first sync in flight holds it. */
      let release!: () => void;
      const w = await boot(age, new Promise<void>((r) => { release = r; }));
      cleanups.push(() => release());
      await w.organize();
      expect((await w.row()).organizerRole, "the claim has not landed yet").toBe("reader");
      const rule = await w.call("POST", "/rules", { kind: "sender", match: "new@b.test", destination: "INBOX" });
      const away = await w.call("PUT", "/away-responder", { enabled: true, body: "Away until Monday.", audience: "everyone" });
      const screening = await w.call("PATCH", "/account/screening", { ohboxPolicy: "people_only" });
      expect([rule.status, away.status, screening.status], "each door wrote here").toEqual([201, 200, 200]);
      expect((await w.sidecar.db.select().from(rules).where(eq(rules.match, "new@b.test"))).length).toBe(1);
      expect(await w.requests(), "nothing is asked of the install the claim displaces").toHaveLength(0);
    }, 60_000);

  it("CONTROL: a reader nobody asked to organize is refused or asks the holder, as before", async () => {
    const stopped = await boot(12 * DAY);
    const refused = await stopped.decide();
    expect(refused.status, "a stopped holder and no takeover asked for: nothing can take it").toBe(409);
    expect(await stopped.ruleFor()).toHaveLength(0);

    const live = await boot(0);
    const queued = await live.decide();
    expect(queued.status, "a live holder takes it as a request").toBe(202);
    expect(await live.ruleFor()).toHaveLength(0);
    expect(await live.requests()).toHaveLength(1);
  }, 60_000);

  it("CONTROL: a join press over a live holder is refused, so the decision goes to the holder", async () => {
    const w = await boot(0);
    expect((await w.join()).status).toBe(409);
    const res = await w.decide();
    expect(res.status).toBe(202);
    expect(await w.ruleFor()).toHaveLength(0);
    expect(await w.requests()).toHaveLength(1);
  }, 60_000);
});

/**
 * THE CLAIM OVER A LIVE HOLDER FOLLOWS ONLY "ORGANIZE HERE INSTEAD". Setup's
 * How-far-back step offered Agree for 11-26 s before the claim question landed, and an Agree in
 * that window took a live organizer's mailbox: the door read the missing verb as a takeover. The
 * door now reads it as a join, refuses one over a row showing a live holder, and LOOKS when the
 * row cannot say (never looked, or unreadable): a holder found is a 409, a look that does not land
 * a 503, and neither writes anything. To watch it fail: make the route's `intent` `"takeover"`
 * whatever the body says, or drop the door's look.
 */
describe("the organize door takes a live holder's mailbox only by name", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  /** `ageMs` null: no claim at all. 0: a holder renewing now. */
  async function boot(ageMs: number | null, opts: { holdFirstLook?: boolean; looksFail?: boolean } = {}) {
    const meta = new MemoryMetaFolder();
    if (ageMs !== null) {
      const at = new Date(Date.now() - ageMs);
      await meta.appendClaim(formatClaim({
        installId: "local:w-live", kind: "local", displayName: "W-live",
        heartbeat: at, claimedAt: at, nonce: "live", authorizedAt: null, capabilities: ["requests"],
      }));
    }
    let release: () => void = () => {};
    const view: FolderView = {
      ...(opts.holdFirstLook ? { firstLook: new Promise<void>((r) => { release = r; }) } : {}),
      ...(opts.looksFail ? { looksFail: true } : {}),
    };
    const dataDir = await freshDataDir("ohmail-organize-door-");
    const sidecar: Sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test", machineName: "the second computer",
      pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000,
      adapterFactory: mailbox(meta, [], view), log: () => {},
    });
    cleanups.push(async () => { release(); await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    const started = sidecar.start();
    if (!opts.holdFirstLook) await started;
    const call = (method: string, path: string, body?: unknown) => sidecar.handle(new Request(`http://engine.invalid${path}`, {
      method, headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const organize = (body: Record<string, unknown>, id: string = sidecar.world.mailboxId) =>
      call("POST", `/local/mailboxes/${id}/organize`, { screening: { scope: "window" }, ...body });
    const row = async (id: string = sidecar.world.mailboxId) =>
      (await sidecar.db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;
    const listed = async () => ((await (await call("GET", "/mailboxes")).json()) as { items: Array<Record<string, unknown>> })
      .items.find((m) => m.id === sidecar.world.mailboxId)!;
    const liveClaimStands = () => meta.claims.some((c) => c.raw.includes("local:w-live"));
    return { sidecar, organize, row, listed, liveClaimStands, release, started, meta, view };
  }

  it("a press without the takeover verb over a live holder is refused, the holder named, nothing written", async () => {
    const w = await boot(0);
    expect((await w.row()).organizerState, "the first look saw the live holder").toBe("held");
    const res = await w.organize({});
    expect(res.status, "the door took a live organizer's mailbox on an Agree").toBe(409);
    expect(((await res.json()) as { holder?: { name?: string } }).holder?.name).toBe("W-live");
    const after = await w.row();
    expect(after.organizeConsentedAt, "no consent written").toBeNull();
    expect(after.takeoverAuthorizedAt, "no takeover stamp written").toBeNull();
    await w.sidecar.syncUntilQuiet();
    expect((await w.row()).organizerRole).toBe("reader");
    expect(w.liveClaimStands()).toBe(true);
  }, 60_000);

  it("\"Organize here instead\" names the takeover, and it is admitted", async () => {
    const w = await boot(0);
    const res = await w.organize({ intent: "takeover" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe("authorized");
    expect((await w.row()).takeoverIntent).toBe("takeover");
  }, 60_000);

  it("a press before the first look lands: the door looks, refuses with the holder named, and writes nothing", async () => {
    const w = await boot(0, { holdFirstLook: true });
    await vi.waitFor(() => expect(w.view.looks, "the engine's first look has not started").toBeGreaterThan(0));
    expect((await w.listed()).organizerChecked, "the list says the look has not answered").toBe(false);
    const res = await w.organize({});
    expect(res.status, "the row could not say, and the press was admitted over a live holder").toBe(409);
    expect(((await res.json()) as { holder?: { name?: string } }).holder?.name).toBe("W-live");
    nothingWritten(await w.row());
    w.release();
    await w.started;
    await w.sidecar.syncUntilQuiet();
    expect((await w.row()).organizerRole).toBe("reader");
    expect(w.liveClaimStands(), "the live organizer keeps its mailbox").toBe(true);
    expect((await w.listed()).organizerChecked, "the look answered").toBe(true);
  }, 60_000);

  it("a look that does not land is a 503, and nothing is written", async () => {
    const w = await boot(0, { looksFail: true });
    expect((await w.row()).organizerState, "the row says nothing about the holder").toBeNull();
    const res = await w.organize({});
    expect(res.status, "a press was admitted over a folder nobody could read").toBe(503);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe("organizer_unreadable");
    nothingWritten(await w.row());
  }, 60_000);

  it("a mailbox this install runs no engine for cannot be looked at: a 503, and nothing is written", async () => {
    const w = await boot(0);
    const [orphan] = await w.sidecar.db.insert(mailboxes).values({
      accountId: w.sidecar.world.accountId, provider: "imap", address: "second@trafficflow.test",
      status: "connected", organizerRole: "reader",
    }).returning({ id: mailboxes.id });
    const res = await w.organize({}, orphan!.id);
    expect(res.status, "a press was admitted with nothing to look with").toBe(503);
    nothingWritten(await w.row(orphan!.id));
  }, 60_000);

  it.each([["no holder", null], ["a stopped holder", 12 * DAY]] as const)(
    "CONTROL: %s — Agree still claims", async (_label, age) => {
      const w = await boot(age);
      const res = await w.organize({});
      expect(res.status).toBe(200);
      expect(((await res.json()) as { outcome: string }).outcome).toBe("authorized");
      await w.sidecar.syncUntilQuiet();
      expect((await w.row()).organizerRole).toBe("organizer");
    }, 60_000);
});

/**
 * ADDING A MAILBOX ANOTHER INSTALL ORGANIZES NEVER TAKES IT OVER SILENTLY. Desktop 0.30.5 beside a
 * self-hosted server: Agree pressed straight after Connect, before the new mailbox's first look
 * landed, wrote the desktop's claim and the server became a reader (1 of 4 adds). The door now
 * looks when the row cannot say, and a join that won on a read missing the holder yields at its
 * confirm read.
 */
describe("adding a mailbox a self-hosted server organizes", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  const HOLDER = "cloud:selfhost";
  const installIdOf = (c: RawClaimMessage) => (parseClaim(c.raw) as OrganizerClaim | null)?.installId;

  /** The desktop's own mailbox, and a second one whose server holds the self-host's live claim. */
  async function boot(view: FolderView) {
    const desk = { meta: new MemoryMetaFolder(), view: {} as FolderView };
    const held = { meta: new MemoryMetaFolder(), view };
    await held.meta.appendClaim(formatClaim({
      installId: HOLDER, kind: "cloud", displayName: "localhost:6080",
      heartbeat: new Date(Date.now() - 30_000), claimedAt: new Date(Date.now() - 20 * 60_000), nonce: "sh",
      authorizedAt: new Date(Date.now() - 20 * 60_000), capabilities: ["requests"],
    }));
    const byLogin = new Map([
      ["desk@trafficflow.test", mailbox(desk.meta, [], desk.view)],
      ["second@trafficflow.test", mailbox(held.meta, [], held.view)],
    ]);
    const dataDir = await freshDataDir("ohmail-add-held-");
    const sidecar: Sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "127.0.0.1", port: 993, secure: true,
        auth: { user: "desk@trafficflow.test", pass: "not-dialled-password-password" },
        smtp: { host: "smtp-a.invalid", port: 587, secure: false },
      },
      address: "desk@trafficflow.test", machineName: "the desktop",
      pollIntervalMs: 60 * 60 * 1000,
      keks: { 1: Buffer.alloc(32, 7) },
      adapterFactory: (cfg) => {
        const make = byLogin.get((cfg.auth as { user: string }).user);
        if (make === undefined) throw new Error("a login this case has no server for");
        return make(cfg);
      },
      log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    await sidecar.start();
    const call = (method: string, path: string, body?: unknown) => sidecar.handle(new Request(`http://engine.invalid${path}`, {
      method, headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    /** Connect: Settings → Add mailbox, on this computer's own route. */
    const connect = async (): Promise<string> => {
      const res = await call("POST", "/local/mailboxes", {
        provider: "imap", address: "second@trafficflow.test",
        imap: { host: "127.0.0.1", port: 993, secure: true, user: "second@trafficflow.test", pass: "second-password-second" },
        smtp: { host: "smtp-b.invalid", port: 587, secure: false },
      });
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    /** Agree, as setup's window step sends it before any claim question: a join. */
    const agree = (id: string) => call("POST", `/local/mailboxes/${id}/organize`, { screening: { scope: "window" }, intent: "join" });
    const row = async (id: string) => (await sidecar.db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;
    /** The self-hosted server's own next pass, over the folder as it now stands. */
    const holderNext = () => decideLease({
      self: { installId: HOLDER, kind: "cloud", displayName: "localhost:6080", lastNonce: "sh" },
      claims: held.meta.claims.map((c) => parseClaim(c.raw, c.ref)!).filter(Boolean),
      now: new Date(Date.now() + 30_000),
    }).verdict;
    return { sidecar, connect, agree, row, holderNext, claims: () => held.meta.claims.map(installIdOf) };
  }

  it("Agree straight after Connect, before the first look lands: refused with the holder named, nothing written", async () => {
    let release!: () => void;
    const view: FolderView = { firstLook: new Promise<void>((r) => { release = r; }) };
    const w = await boot(view);
    cleanups.push(() => release());
    const id = await w.connect();
    await vi.waitFor(() => expect(view.looks, "the new mailbox's first look has not started").toBeGreaterThan(0));
    const res = await w.agree(id);
    expect(res.status, "the desktop took over a mailbox the server organizes").toBe(409);
    expect(((await res.json()) as { holder?: unknown }).holder).toEqual({ name: "localhost:6080", kind: "cloud" });
    nothingWritten(await w.row(id));
    release();
    await w.sidecar.syncUntilQuiet();
    expect((await w.row(id)).organizerRole).toBe("reader");
    expect(w.claims(), "the desktop's claim stands beside the server's").toEqual([HOLDER]);
    expect(w.holderNext()).toBe("organize");
  }, 60_000);

  it("a look and a first lease read that both miss the holder: the confirm read yields, and the server keeps organizing", async () => {
    const view: FolderView = { missing: { installId: HOLDER, looks: true, firstLeaseRead: true } };
    const w = await boot(view);
    const id = await w.connect();
    expect((await w.agree(id)).status, "a look that saw nobody admits the join").toBe(200);
    await w.sidecar.syncUntilQuiet();
    expect(view.leaseReads, "the gate never read the folder").toBeGreaterThan(1);
    expect((await w.row(id)).organizerRole, "the desktop organizes beside a live holder").toBe("reader");
    expect(w.claims(), "the desktop's claim stands beside the server's").toEqual([HOLDER]);
    expect(w.holderNext(), "the server stands down on its next pass").toBe("organize");
  }, 60_000);
});

/** TWO INSTALLS AGREE ON ONE MAILBOX NOBODY ORGANIZES, both gates reading the empty folder before either claim lands. */
describe("two installs agree on one mailbox nobody organizes", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  it("exactly one organizes, and the other reads and names it", async () => {
    const meta = new MemoryMetaFolder();
    let arrived = 0;
    let open!: () => void;
    const bothRead = new Promise<void>((r) => { open = r; });
    const afterFirstLeaseRead = async (): Promise<void> => { arrived += 1; if (arrived === 2) open(); await bothRead; };
    const install = async (name: string) => {
      const dataDir = await freshDataDir("ohmail-two-agree-");
      const sidecar: Sidecar = await createSidecar({
        dataDir,
        imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
        address: "owner@trafficflow.test", machineName: name,
        pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000,
        adapterFactory: mailbox(meta, [], { afterFirstLeaseRead }), log: () => {},
      });
      cleanups.push(async () => { open(); await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
      await sidecar.start();
      const agree = () => sidecar.handle(new Request(`http://engine.invalid/local/mailboxes/${sidecar.world.mailboxId}/organize`, {
        method: "POST", headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({ screening: { scope: "window" }, intent: "join" }),
      }));
      const row = async () => (await sidecar.db.select().from(mailboxes).where(eq(mailboxes.id, sidecar.world.mailboxId)))[0]!;
      return { sidecar, agree, row };
    };
    const a = await install("laptop-a");
    const b = await install("laptop-b");
    expect([(await a.agree()).status, (await b.agree()).status]).toEqual([200, 200]);
    await Promise.all([a.sidecar.syncUntilQuiet(), b.sidecar.syncUntilQuiet()]);
    const rows = { "laptop-a": await a.row(), "laptop-b": await b.row() };
    const organizing = Object.entries(rows).filter(([, r]) => r.organizerRole === "organizer").map(([name]) => name);
    expect(organizing, "both presses stood down, or both organize").toHaveLength(1);
    const reader = Object.values(rows).find((r) => r.organizerRole === "reader");
    expect(reader?.organizedByName).toBe(organizing[0]);
    expect(meta.claims.map((c) => (parseClaim(c.raw) as OrganizerClaim).displayName)).toEqual(organizing);
  }, 60_000);

  it("one confirming before the other's claim lands: one install is granted a write permit, and the other names it", async () => {
    const meta = new MemoryMetaFolder();
    const granted = new Set<string>();
    const signal = () => { let fire!: () => void; const p = new Promise<void>((r) => { fire = r; }); return { fire, p }; };
    const install = async (name: string, view: FolderView) => {
      const dataDir = await freshDataDir("ohmail-two-agree-");
      const sidecar: Sidecar = await createSidecar({
        dataDir,
        imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
        address: "owner@trafficflow.test", machineName: name,
        pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000,
        adapterFactory: mailbox(meta, [], view), log: (event: string) => { if (event === "lease_permit_granted") granted.add(name); },
      });
      cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
      await sidecar.start();
      const agree = () => sidecar.handle(new Request(`http://engine.invalid/local/mailboxes/${sidecar.world.mailboxId}/organize`, {
        method: "POST", headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({ screening: { scope: "window" }, intent: "join" }),
      }));
      const row = async () => (await sidecar.db.select().from(mailboxes).where(eq(mailboxes.id, sidecar.world.mailboxId)))[0]!;
      return { sidecar, agree, row };
    };
    /* B agrees first and holds after its election read until A has confirmed over its own claim
       alone; A's press waits for B's next read after its confirm. */
    const bRead = signal(); const aConfirmed = signal(); const bReadAgain = signal();
    const b = await install("laptop-b", {
      afterLeaseRead: async (n) => { if (n === 1) { bRead.fire(); await aConfirmed.p; } if (n === 3) bReadAgain.fire(); },
    });
    const a = await install("laptop-a", {
      afterLeaseRead: (n) => { if (n === 2) aConfirmed.fire(); },
      beforeAppend: async (n) => { if (n === 2) await bReadAgain.p; },
    });
    expect((await b.agree()).status).toBe(200);
    const bPass = b.sidecar.syncUntilQuiet();
    await bRead.p;
    expect((await a.agree()).status).toBe(200);
    await Promise.all([bPass, a.sidecar.syncUntilQuiet()]);
    expect([...granted], "both installs were granted a write permit in one pass").toEqual(["laptop-a"]);
    const rows = { "laptop-a": await a.row(), "laptop-b": await b.row() };
    expect(Object.entries(rows).filter(([, r]) => r.organizerRole === "organizer").map(([name]) => name)).toEqual(["laptop-a"]);
    expect(rows["laptop-b"]).toMatchObject({ organizerRole: "reader", organizedByName: "laptop-a" });
    expect(meta.claims.map((c) => (parseClaim(c.raw) as OrganizerClaim).displayName)).toEqual(["laptop-a"]);
  }, 60_000);
});

/**
 * AN OLDER PRESS NEVER REVERSES A NEWER ONE. "Organize here instead" on a laptop whose mail server
 * does not answer stays on its row, unspent; the person then sets the mailbox up on the desktop
 * and agrees, over a free folder. When the laptop's server answers again, the desktop keeps it.
 */
describe("an older press still unspent on another computer", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  it("does not take the mailbox from the computer the person agreed on later", async () => {
    const meta = new MemoryMetaFolder();
    const install = async (name: string, view: FolderView) => {
      const dataDir = await freshDataDir("ohmail-older-press-");
      const sidecar: Sidecar = await createSidecar({
        dataDir,
        imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
        address: "owner@trafficflow.test", machineName: name,
        pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000,
        adapterFactory: mailbox(meta, [], view), log: () => {},
      });
      cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
      await sidecar.start();
      const press = (intent: "join" | "takeover") => sidecar.handle(new Request(`http://engine.invalid/local/mailboxes/${sidecar.world.mailboxId}/organize`, {
        method: "POST", headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({ screening: { scope: "window" }, intent }),
      }));
      const row = async () => (await sidecar.db.select().from(mailboxes).where(eq(mailboxes.id, sidecar.world.mailboxId)))[0]!;
      return { sidecar, press, row };
    };

    const laptopView: FolderView = { offline: true };
    const laptop = await install("laptop", laptopView);
    expect((await laptop.press("takeover")).status).toBe(200);
    await laptop.sidecar.syncUntilQuiet().catch(() => undefined);
    expect((await laptop.row()).takeoverAuthorizedAt, "the laptop's press was spent").not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));

    const desktop = await install("desktop", {});
    expect((await desktop.press("join")).status).toBe(200);
    await desktop.sidecar.syncUntilQuiet();
    expect((await desktop.row()).organizerRole).toBe("organizer");

    laptopView.offline = false;
    await laptop.sidecar.syncUntilQuiet();
    await desktop.sidecar.syncUntilQuiet();
    expect({
      laptop: (await laptop.row()).organizerRole, desktop: (await desktop.row()).organizerRole,
      claims: meta.claims.map((c) => (parseClaim(c.raw) as OrganizerClaim).displayName),
    }, "the laptop's older press took the mailbox from the newer Agree")
      .toEqual({ laptop: "reader", desktop: "organizer", claims: ["desktop"] });
  }, 60_000);
});
