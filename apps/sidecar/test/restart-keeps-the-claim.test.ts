import { rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import {
  isMalformedProfile, parseProfileMessage, type ProfileIo, type RawProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import { eq } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
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

/** An in-memory `ohmail/_meta`, shared by every install a case boots: claims and settings documents. */
class MemoryMetaFolder implements LeaseIo, ProfileIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  readonly profiles: RawProfileMessage[] = [];
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
  async listProfileMessages(): Promise<RawProfileMessage[]> { return this.profiles.map((p) => ({ ...p })); }
  async appendProfile(raw: string): Promise<void> { this.profiles.push({ ref: this.nextUid++, raw, generation: 4_100 }); }
  async removeProfiles(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.profiles.length - 1; i >= 0; i--) {
      if (gone.has(this.profiles[i]!.ref)) this.profiles.splice(i, 1);
    }
  }
  get count(): number { return this.claims.length; }
  /** Every append ever made: a renewal is append-then-expunge, so this counts lease writes. */
  get appends(): number { return this.nextUid - 1; }
}

const EMPTY_BATCH: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };

/** `settings: false` is a server whose install never writes a settings document. */
function quietMailbox(meta: MemoryMetaFolder, settings = true) {
  return (_cfg: ImapConfig): MailboxAdapter & {
    leaseIo(): LeaseIo; leasePeekIo(): { listClaims(): Promise<RawClaimMessage[]> };
  } => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
    ...(settings ? { profileIo: () => meta } : {}),
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

  /** Every install's clock; a case moves it past the staleness window. */
  let skewMs = 0;
  afterEach(() => { skewMs = 0; });

  async function boot(
    dir: string, meta: MemoryMetaFolder, events: string[], o: { consent?: boolean; settings?: boolean } = {},
  ): Promise<Sidecar> {
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test",
      machineName: "the desktop being restarted",
      pollIntervalMs: 60 * HOUR,
      leaseStaleAfterMs: 60_000,
      profileFlushIntervalMs: 0,
      adapterFactory: quietMailbox(meta, o.settings ?? true),
      now: () => new Date(Date.now() + skewMs),
      log: (event) => { events.push(event); },
      dkimKeys: null,
    });
    cleanups.push(() => sidecar.stop().catch(() => undefined));
    if (o.consent ?? true) await grantOrganizeConsent(sidecar);
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

  /* A QUIT EMPTIES THE CLAIM FOLDER UNTIL THE RELAUNCH'S FIRST GATE, and a setup in that stretch
     read "nobody organizes this", asked no claim question, and its join organized. The quit's
     let-go key in the settings document names the organizer that just left. */
  const press = (s: Sidecar, intent?: "takeover") => s.handle(new Request(
    `http://engine.invalid/local/mailboxes/${s.world.mailboxId}/organize`, {
      method: "POST",
      headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ screening: { scope: "window" }, ...(intent === undefined ? {} : { intent }) }),
    }));
  const holderRow = async (s: Sidecar) => {
    const [r] = await s.db.select().from(mailboxes).where(eq(mailboxes.id, s.world.mailboxId));
    return { state: r!.organizerState, kind: r!.organizedByKind, holder: r!.organizedByInstallId, name: r!.organizedByName };
  };
  /** An install that agreed through setup's own door, with a window, so its settings say something. */
  async function agreed(dir: string, meta: MemoryMetaFolder, settings = true): Promise<Sidecar> {
    const sidecar = await boot(dir, meta, [], { consent: false, settings });
    await sidecar.start();
    expect((await press(sidecar)).status).toBe(200);
    await sidecar.syncUntilQuiet();
    expect(sidecar.organizerState().organizing, "the first install did not organize").toBe(true);
    return sidecar;
  }
  /** A organizes and quits; `afterMs` later a fresh install sets up on the same mailbox. */
  async function setupAfterQuit(o: { afterMs: number; settings?: boolean }) {
    const meta = new MemoryMetaFolder();
    const first = await agreed(await dataDir(), meta, o.settings);
    const quitter = first.world.accountId;
    await leave(first, []);
    expect(meta.count, "the quit kept its claim").toBe(0);
    expect(meta.profiles.length, "the quit left no settings").toBe(o.settings === false ? 0 : 1);
    skewMs += o.afterMs;
    const setup = await boot(await dataDir(), meta, [], { consent: false });
    await setup.start();
    return { meta, quitter, setup };
  }

  it("A SETUP RIGHT AFTER THE ORGANIZER QUIT is shown it as organizing, and its join is refused", async () => {
    const { meta, quitter, setup } = await setupAfterQuit({ afterMs: 30_000 });
    expect(await holderRow(setup), "setup was told nobody organizes this mailbox")
      .toEqual({ state: "held", kind: "local", holder: quitter, name: null });
    const appends = meta.appends;
    const res = await press(setup);
    expect(res.status, "a join over the organizer that just quit was admitted").toBe(409);
    expect((await res.json() as { holder?: unknown }).holder).toEqual({ name: "", kind: "local" });
    expect(meta.appends, "the refused join wrote a claim").toBe(appends);
    expect(setup.organizerState().organizing).toBe(false);
  }, 60_000);

  it("A PRESS THAT BEATS THE FIRST LOOK is refused by the door's own look", async () => {
    const { setup } = await setupAfterQuit({ afterMs: 30_000 });
    await setup.db.update(mailboxes).set({ organizerState: null, organizedByKind: null, organizedByInstallId: null })
      .where(eq(mailboxes.id, setup.world.mailboxId));
    expect((await press(setup)).status, "an unlooked-at row let the join through").toBe(409);
  }, 60_000);

  it("CONTROL: past the staleness window the quit organizer shows as stopped and the join is admitted", async () => {
    const { quitter, setup } = await setupAfterQuit({ afterMs: 61_000 });
    expect(await holderRow(setup)).toEqual({ state: "stopped", kind: "local", holder: quitter, name: null });
    expect((await press(setup)).status).toBe(200);
  }, 60_000);

  it("CONTROL: with no settings document setup shows nobody, and the join is admitted", async () => {
    const { setup } = await setupAfterQuit({ afterMs: 30_000, settings: false });
    expect(await holderRow(setup)).toEqual({ state: null, kind: null, holder: null, name: null });
    expect((await press(setup)).status).toBe(200);
  }, 60_000);

  /* A PERSON'S STOP FREES THE MAILBOX AT ONCE: its let-go key never says the install resumes. */
  it("A SETUP RIGHT AFTER THE ORGANIZER'S STOP is shown nobody holding it, and its join is admitted", async () => {
    const meta = new MemoryMetaFolder();
    const first = await agreed(await dataDir(), meta);
    const stop = await first.handle(new Request(`http://engine.invalid/mailboxes/${first.world.mailboxId}/release`, {
      method: "POST", headers: { authorization: `Bearer ${first.sessionToken}`, "content-type": "application/json" }, body: "{}",
    }));
    expect(stop.status, await stop.clone().text()).toBe(202);
    await first.syncUntilQuiet();
    expect(first.organizerState().organizing, "premise: the Stop was honoured").toBe(false);
    expect(meta.count, "premise: the Stop gave the claim back").toBe(0);
    const left = meta.profiles.map((p) => parseProfileMessage(p.raw))
      .flatMap((r) => (r === null || isMalformedProfile(r) || r.doc === undefined ? [] : [r.doc]))
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt)).at(-1);
    expect(left?.gap, "premise: the Stop left its key").toMatchObject({ by: first.world.accountId });
    expect(left?.gap?.resumes, "the Stop said this install resumes").toBeUndefined();
    skewMs += 30_000;
    const setup = await boot(await dataDir(), meta, [], { consent: false });
    await setup.start();
    expect(await holderRow(setup), "setup was shown the install that stopped as organizing")
      .toEqual({ state: null, kind: null, holder: null, name: null });
    expect((await press(setup)).status, "a join after the organizer's Stop was refused").toBe(200);
  }, 60_000);

  it("CONTROL: a takeover press over the organizer that just quit is admitted", async () => {
    const { setup } = await setupAfterQuit({ afterMs: 30_000 });
    expect((await press(setup, "takeover")).status).toBe(200);
  }, 60_000);

  it("CONTROL: this install's own let-go names nobody", async () => {
    const dir = await dataDir();
    const meta = new MemoryMetaFolder();
    const first = await agreed(dir, meta);
    await leave(first, []);
    skewMs += 30_000;
    const again = await boot(dir, meta, [], { consent: false });
    await again.db.update(mailboxes).set({ organizeConsentedAt: null, organizerRole: "reader" })
      .where(eq(mailboxes.id, again.world.mailboxId));
    await again.start();
    expect(await holderRow(again)).toEqual({ state: null, kind: null, holder: null, name: null });
  }, 60_000);
});
