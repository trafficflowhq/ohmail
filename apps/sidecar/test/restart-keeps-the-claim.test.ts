import { rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { encodeFrame } from "../src/frame.js";
import { serveLocalBridge } from "../src/main.js";
import { requestOrganizerTakeover } from "../src/organize-here.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";

/**
 * A RESTART HOLDS THE CLAIM; A QUIT RELEASES IT (the project's design notes, the restart exception).
 *
 * The shell writes one `leaving` frame with reason `restart` before it closes the engine's input.
 * Only that frame keeps the claim through the window with no process; the relaunch continues it
 * under its own install id. In the window a second install's `join` is refused by the lease, and
 * a person's takeover still wins: the relaunch then stands down.
 * Every other ending — no frame, `quit`, a reason-less frame — gives the claim back as before.
 */

/** An in-memory `ohmail/_meta`, shared by every install a case boots. */
class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }
  uidValidity(): number | bigint | null { return 4_100; }
  /** What a release reads: production's adapter has it, so a double without it is another server. */
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`)).map((c) => ({ ...c }));
  }
  get count(): number { return this.claims.length; }
  /** Every append ever made: a renewal is append-then-expunge, so this counts lease writes. */
  get appends(): number { return this.nextUid - 1; }
}

const EMPTY_BATCH: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };

function quietMailbox(meta: MemoryMetaFolder) {
  return (_cfg: ImapConfig): MailboxAdapter & {
    leaseIo(): LeaseIo; leasePeekIo(): { listClaims(): Promise<RawClaimMessage[]> };
  } => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...EMPTY_BATCH }; },
    async move(_l: NativeLocator, toFolder: string): Promise<NativeLocator> { return { folder: toFolder, ref: "1:1" }; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox never sends"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
}

const HOUR = 60 * 60 * 1000;

describe("a restart keeps the organizer claim; a quit gives it back", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function dataDir(): Promise<string> {
    const dir = await freshDataDir("ohmail-restart-claim-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  async function boot(dir: string, meta: MemoryMetaFolder, events: string[]): Promise<Sidecar> {
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test",
      machineName: "the desktop being restarted",
      pollIntervalMs: 60 * HOUR,
      leaseStaleAfterMs: 60_000,
      adapterFactory: quietMailbox(meta),
      log: (event) => { events.push(event); },
    });
    cleanups.push(() => sidecar.stop().catch(() => undefined));
    await grantOrganizeConsent(sidecar);
    return sidecar;
  }

  /** The shell's half, as `main.ts` composes it: the frames given, then EOF, then the stop. */
  async function leave(sidecar: Sidecar, frames: Record<string, unknown>[]): Promise<unknown[]> {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const fatals: unknown[] = [];
    const host = serveLocalBridge(sidecar, {
      input, output, log: () => undefined, onFatal: (err) => { fatals.push(err); },
    });
    for (const f of frames) input.write(encodeFrame(f));
    input.end();
    await host.finished();
    await sidecar.stop();
    return fatals;
  }

  async function organizing(dir: string, meta: MemoryMetaFolder, events: string[]): Promise<Sidecar> {
    const sidecar = await boot(dir, meta, events);
    await sidecar.start();
    expect(sidecar.organizerState().organizing, "the first launch did not organize").toBe(true);
    expect(meta.count).toBe(1);
    return sidecar;
  }

  it("THE RESTART: the claim stays in ohmail/_meta and the relaunch renews it", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const events: string[] = [];
    const first = await organizing(dir, meta, events);

    const fatals = await leave(first, [{ v: 1, t: "leaving", reason: "restart" }]);

    expect(fatals, "the leaving frame ended the bridge").toHaveLength(0);
    expect(meta.count, "the restart gave the claim back").toBe(1);
    expect(events).toContain("organizer_claim_kept_for_restart");
    expect(events).not.toContain("organizer_claim_released_on_stop");

    const appendsBefore = meta.appends;
    const again = await boot(dir, meta, []);
    await again.start();
    expect(again.organizerState().organizing, "the relaunch did not continue its own claim").toBe(true);
    expect(meta.appends - appendsBefore, "the relaunch did not renew the kept claim").toBe(1);
    expect(meta.count, "the relaunch wrote a second claim beside the kept one").toBe(1);
  }, 60_000);

  it("CONTROL 1: an input that ends with no frame gives the claim back", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const events: string[] = [];
    const first = await organizing(dir, meta, events);

    const fatals = await leave(first, []);

    expect(fatals).toHaveLength(0);
    expect(meta.count, "a quit left its claim to age out").toBe(0);
    expect(events).toContain("organizer_claim_released_on_stop");
    expect(events).not.toContain("organizer_claim_kept_for_restart");
  }, 60_000);

  it("CONTROL 2: in the restart window a second install's join is refused and appends nothing", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const first = await organizing(dir, meta, []);
    await leave(first, [{ v: 1, t: "leaving", reason: "restart" }]);
    expect(meta.count).toBe(1);

    const appendsInWindow = meta.appends;
    const other = await boot(await dataDir(), meta, []);
    await other.start();
    expect(other.organizerState().organizing, "a second install organized beside the kept claim").toBe(false);
    const pressed = await requestOrganizerTakeover(other.db, {
      mailboxId: other.world.mailboxId, now: new Date(), intent: "join",
    });
    expect(pressed.outcome).toBe("authorized");
    await other.syncUntilQuiet();

    expect(other.organizerState().organizing, "a join displaced the kept claim").toBe(false);
    expect((await other.peekOrganizer(other.world.mailboxId)).answer).toBe("held");
    expect(meta.appends, "the second install appended to ohmail/_meta").toBe(appendsInWindow);
    expect(meta.count).toBe(1);
  }, 60_000);

  it("CONTROL 4: a person's Organize here in the restart window wins, and the relaunch stands down", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const first = await organizing(dir, meta, []);
    await leave(first, [{ v: 1, t: "leaving", reason: "restart" }]);
    expect(meta.count).toBe(1);

    const other = await boot(await dataDir(), meta, []);
    await other.start();
    const pressed = await requestOrganizerTakeover(other.db, {
      mailboxId: other.world.mailboxId, now: new Date(), intent: "takeover",
    });
    expect(pressed.outcome).toBe("authorized");
    await other.syncUntilQuiet();
    expect(other.organizerState().organizing, "a kept restart claim beat a person's takeover").toBe(true);

    const relaunch = await boot(dir, meta, []);
    await relaunch.start();
    expect(relaunch.organizerState().organizing, "the relaunch took the mailbox back from the person").toBe(false);
    expect(meta.count, "two claims stand in ohmail/_meta").toBe(1);
  }, 60_000);

  it("CONTROL 3: a quit reason and a reason-less frame give the claim back", async () => {
    for (const frame of [{ v: 1, t: "leaving", reason: "quit" }, { v: 1, t: "leaving" }]) {
      const dir = await dataDir();
      const meta = new MemoryMetaFolder();
      const events: string[] = [];
      const first = await organizing(dir, meta, events);

      const fatals = await leave(first, [frame]);

      expect(fatals).toHaveLength(0);
      expect(meta.count, `${JSON.stringify(frame)} kept the claim`).toBe(0);
      expect(events).not.toContain("organizer_claim_kept_for_restart");
    }
  }, 60_000);
});
