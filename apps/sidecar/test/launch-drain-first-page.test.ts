import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openLocalDb } from "../src/db.js";
import { freshDataDir } from "./_datadir.js";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import { ImapConnectionClosedError } from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { createSidecar, type AdapterDialContext, type Sidecar } from "../src/engine.js";
import {
  armFirstPageGate, FIRST_PAGE_GRACE_MS, noteFirstPageServed, resetFirstPageGate,
} from "../src/first-page-gate.js";

/**
 * THE LAUNCH DRAIN WAITS FOR THE WINDOW'S FIRST PAGE. Its first cycle reads every locator of the
 * mailbox in one statement that blocks the loop (a large mailbox's rows: seconds on a measured install), and
 * the page queued behind it because only the poll's drain asked the gate. Driven through the
 * shipped `start()`: no `changesSince` until the page is served, and a start nobody watches drains
 * once the grace runs out; a stop during the grace drains nothing; a re-dial waits nothing; a launch
 * no door armed (the phone's) waits nothing. Watched red: the wait removed from `dialAndGate`, the
 * door-armed check removed, the stop check removed, a zero wait logged.
 */
class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number | bigint | null { return 4_100; }
}

const EMPTY: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };

/** An empty mailbox that counts the cycles that reached it, and can cut the newest connection. */
function countingMailbox(): {
  factory: (cfg: ImapConfig, ctx: AdapterDialContext) => MailboxAdapter & { leaseIo(): LeaseIo };
  cycles(): number; dials(): number; cut(): void; watches(): number;
} {
  const meta = new MemoryMetaFolder();
  let cycles = 0;
  let watches = 0;
  const deaths: Array<(err: unknown) => void> = [];
  const factory = (_cfg: ImapConfig, ctx: AdapterDialContext): MailboxAdapter & { leaseIo(): LeaseIo } => {
    deaths.push(ctx.onConnectionError);
    return {
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { cycles += 1; return EMPTY; },
    async move(locator: NativeLocator): Promise<NativeLocator> { return locator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { watches += 1; return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
    };
  };
  return {
    factory, cycles: () => cycles, dials: () => deaths.length, watches: () => watches,
    cut: () => deaths[deaths.length - 1]!(new ImapConnectionClosedError()),
  };
}

describe("the launch drain and the window's first page", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  beforeEach(() => resetFirstPageGate());
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    resetFirstPageGate();
  });

  async function launched(door = true, armedAt?: number): Promise<{
    started: Promise<unknown>; cycles: () => number; lines: string[]; sidecar: Sidecar;
    mailbox: ReturnType<typeof countingMailbox>;
  }> {
    const mailbox = countingMailbox();
    const lines: string[] = [];
    const dataDir = await freshDataDir("ohmail-launch-first-page-");
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: mailbox.factory,
      searchBackfillTiming: { waitMs: 60 * 60 * 1000 },
      log: (event) => { lines.push(event); },
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    // As `main.ts` orders it: the door serves, the grace is armed, then the launch.
    if (door) armFirstPageGate(armedAt ?? performance.now());
    return { started: sidecar.start(), cycles: mailbox.cycles, lines, sidecar, mailbox };
  }

  it("does not drain before the first page, and drains once it is served", async () => {
    const { started, cycles, lines } = await launched();
    await new Promise((r) => setTimeout(r, FIRST_PAGE_GRACE_MS / 3));
    expect(cycles(), "the launch drained in front of the reader's first page").toBe(0);
    noteFirstPageServed();
    await started;
    expect(cycles()).toBeGreaterThan(0);
    expect(lines).toContain("first_page_before_drain");
  }, 120_000);

  it("a start nobody watches drains when the grace runs out", async () => {
    const { started, cycles, lines } = await launched();
    await started;
    expect(cycles()).toBeGreaterThan(0);
    expect(lines).toContain("first_page_grace_expired");
  }, 120_000);

  it("a stop during the grace runs no drain", async () => {
    const { started, cycles, sidecar, mailbox } = await launched();
    await new Promise((r) => setTimeout(r, FIRST_PAGE_GRACE_MS / 3));
    await sidecar.stop();
    await started.catch(() => undefined);
    expect(cycles(), "the launch drained a mailbox that had been stopped during the grace").toBe(0);
    // The drain's own refusals stop it short of the server; the launch must not go on to it at all.
    expect(mailbox.watches(), "the stopped launch went on to arm the doorbell").toBe(0);
  }, 120_000);

  /** Cut the launch's connection and drain once more: the re-dial goes through the same door. */
  async function redialed(l: Awaited<ReturnType<typeof launched>>): Promise<number> {
    const before = l.mailbox.dials();
    l.mailbox.cut();
    const t = Date.now();
    await l.sidecar.syncUntilQuiet();
    expect(l.mailbox.dials(), "the cut connection was not re-dialled").toBe(before + 1);
    return Date.now() - t;
  }

  it("a re-dial after the first page reads already and waits nothing", async () => {
    // A grace that cannot run out inside this case: only `already` lets the re-dial through.
    const l = await launched(true, performance.now() + 60_000);
    noteFirstPageServed();
    await l.started;
    const linesAtLaunch = l.lines.filter((e) => e.startsWith("first_page_")).length;
    expect(await redialed(l), "the re-dial waited a grace for a page already served").toBeLessThan(FIRST_PAGE_GRACE_MS);
    expect(l.lines.filter((e) => e.startsWith("first_page_")).length).toBe(linesAtLaunch);
  }, 120_000);

  it("a re-dial before any page, past the grace, waits nothing and says nothing", async () => {
    const l = await launched();
    await l.started;
    expect(l.lines.filter((e) => e === "first_page_grace_expired")).toHaveLength(1);
    expect(await redialed(l)).toBeLessThan(FIRST_PAGE_GRACE_MS);
    expect(l.lines.filter((e) => e === "first_page_grace_expired"), "a wait of nothing was logged").toHaveLength(1);
  }, 120_000);

  /* FIRST-PAGE-GATE-WAITS-OUT-A-CLOCK-STEP: the wall clock goes back 19 minutes after the door armed
     the gate. The launch drain still waits at most the grace, not the grace plus the step. */
  it("a wall clock stepped back after the gate was armed delays the launch by at most the grace", async () => {
    armFirstPageGate();
    const realNow = Date.now.bind(Date);
    const step = vi.spyOn(Date, "now").mockImplementation(() => realNow() - 19 * 60_000);
    try {
      const { started, cycles } = await launched(false);
      const t = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), FIRST_PAGE_GRACE_MS + 8_000); });
      const outcome = await Promise.race([started.then(() => "started" as const), late]);
      clearTimeout(timer);
      expect(outcome, "the launch drain waited out the clock step").toBe("started");
      expect(cycles()).toBeGreaterThan(0);
      expect(performance.now() - t).toBeLessThan(FIRST_PAGE_GRACE_MS + 5_000);
    } finally {
      step.mockRestore();
    }
  }, 120_000);

  /* The phone's door serves no bootstrap page and never arms the gate: its launch drains at once. */
  it("with no door armed the launch does not wait the grace", async () => {
    const { started, cycles, lines } = await launched(false);
    const t = Date.now();
    await started;
    expect(cycles()).toBeGreaterThan(0);
    expect(Date.now() - t, "the launch waited a grace no door armed").toBeLessThan(FIRST_PAGE_GRACE_MS);
    expect(lines.filter((l) => l.startsWith("first_page_"))).toEqual([]);
  }, 120_000);

  /* The first page read of a store whose locators were never analyzed would sort the rest of the
     mailbox on every page: the drain takes the statistics first, once. */
  it("a drain over a reopened store with locators analyzes them before its first page read", async () => {
    const dataDir = await freshDataDir("ohmail-launch-locator-stats-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const config = {
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test", pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000,
      searchBackfillTiming: { waitMs: 60 * 60 * 1000 }, log: () => {},
    };
    const first = await createSidecar({ ...config, adapterFactory: countingMailbox().factory });
    await first.start();
    await first.stop();
    const store = await openLocalDb(dataDir);
    const c = (store.db as unknown as { $client: PGlite }).$client;
    const mb = (await c.query<{ id: string; account_id: string }>("select id, account_id from mailboxes")).rows[0]!;
    const m = (await c.query<{ id: string }>(`insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, to_addresses, cc_addresses, native_locator)
      values ('${mb.account_id}', '${mb.id}', 'h', 'stats:1', 's', 'x@mail.example', now(), '[]'::jsonb, '[]'::jsonb, '{"folder":"INBOX","ref":"1:1"}'::jsonb) returning id`)).rows[0]!.id;
    await c.exec(`insert into message_instances (account_id, mailbox_id, message_id, folder, uidvalidity, uid, is_primary)
      select '${mb.account_id}', '${mb.id}', '${m}', 'Archive', 7, g, false from generate_series(1, 200) g`);
    await store.close();
    const seen: string[] = [];
    for (const name of ["query", "exec"] as const) {
      const orig = PGlite.prototype[name];
      vi.spyOn(PGlite.prototype, name).mockImplementation(function (this: PGlite, text: unknown, ...rest: unknown[]) {
        seen.push(String(text));
        return (orig as any).call(this, text, ...rest);
      } as any);
    }
    cleanups.push(() => { vi.restoreAllMocks(); });
    const again = await createSidecar({ ...config, adapterFactory: countingMailbox().factory });
    cleanups.push(async () => { await again.stop(); });
    await again.start();
    const analyzed = seen.findIndex((s) => /^ANALYZE public\.message_instances$/.test(s));
    const page = seen.findIndex((s) => /^select "message_instances"\."folder"/.test(s));
    expect(page, "the drain never read the known set").toBeGreaterThan(-1);
    expect(analyzed, "the locators were never analyzed").toBeGreaterThan(-1);
    expect(analyzed).toBeLessThan(page);
    expect(seen.filter((s) => /^ANALYZE public\.message_instances$/.test(s)), "analyzed more than once").toHaveLength(1);
  }, 120_000);

  /* A fresh store's launch drain finds no locators: that is no answer, and the drain after the
     import must still take the statistics before its first page. */
  it("a fresh store that gains locators analyzes them before the next drain's first page read", async () => {
    const dataDir = await freshDataDir("ohmail-fresh-locator-stats-");
    const base = countingMailbox().factory;
    let serve = 0;
    const factory = (cfg: ImapConfig, ctx: AdapterDialContext): MailboxAdapter & { leaseIo(): LeaseIo } => ({
      ...base(cfg, ctx),
      async changesSince(): Promise<ChangeBatch> {
        const creates = Array.from({ length: serve }, (_, i) => ({
          type: "create" as const, locator: { folder: "INBOX", ref: `1:${i + 1}` }, seen: false,
          raw: Buffer.from([`Message-ID: <fresh-${i}@x>`, `From: s${i}@x.test`, "To: owner@trafficflow.test",
            `Subject: fresh ${i}`, "Content-Type: text/plain", "", `body ${i}`].join("\r\n")),
        }));
        serve = 0;
        return { ...EMPTY, creates };
      },
    });
    const seen: string[] = [];
    for (const name of ["query", "exec"] as const) {
      const orig = PGlite.prototype[name];
      vi.spyOn(PGlite.prototype, name).mockImplementation(function (this: PGlite, text: unknown, ...rest: unknown[]) {
        seen.push(String(text));
        return (orig as any).call(this, text, ...rest);
      } as any);
    }
    cleanups.push(() => { vi.restoreAllMocks(); });
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test", pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000,
      searchBackfillTiming: { waitMs: 60 * 60 * 1000 }, adapterFactory: factory, log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    const isAnalyze = (s: string): boolean => /^ANALYZE public\.message_instances$/.test(s);
    const isPage = (s: string): boolean => /^select "message_instances"\."folder"/.test(s);
    await sidecar.start();
    expect(seen.some(isPage), "the launch drain never read the known set").toBe(true);
    serve = 30;
    await sidecar.syncUntilQuiet();
    const held = Number((await (sidecar.db as unknown as { $client: PGlite }).$client
      .query<{ n: number }>("select count(*)::int as n from message_instances")).rows[0]!.n);
    expect(held, "the import wrote no locators").toBeGreaterThan(0);
    const from = seen.length;
    await sidecar.syncUntilQuiet();
    const after = seen.slice(from);
    const analyzed = after.findIndex(isAnalyze);
    expect(analyzed, "the locators the import wrote were never analyzed").toBeGreaterThan(-1);
    const page = after.findIndex(isPage);
    if (page > -1) expect(analyzed).toBeLessThan(page);
    expect(seen.filter(isAnalyze), "analyzed more than once").toHaveLength(1);
  }, 120_000);
});
