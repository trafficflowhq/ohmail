import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { accounts, mailboxes, mailboxCredentials, messageFailures, messages } from "@trafficflow/db";
import { schema, makeDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { pgTestUrl, realPgAvailable } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { StaticKeyProvider, UNMETERED_STORAGE_CAP, createLogger } from "@trafficflow/core/mail";
import { ImapAdapter, ImapBoundExceeded, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { runSyncCycle } from "../src/sync.js";
import { DeadLetterLedger, HOLD_EXEMPT_CODES } from "../src/dead-letter.js";
import { startWorker } from "../src/index.js";
import { FIXTURE_LEASE } from "./_door.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";

/**
 * OVERRUN SET-ASIDES ARE PROGRESS. A server streaming far past a
 * message's declared size has that message set aside, one per pass. Row 1: the backstop hold,
 * reloaded from the store each cycle, never counts those rows (`writeOffRun` and HOLD_EXEMPT_CODES).
 * Row 2: the hosted worker re-attaches after such a breach and never quarantines for it, while a
 * breach that set nothing aside still does. The real ImapAdapter over a scripted server streaming
 * ascending, as a real one does; row 2 through the worker's own loop.
 */
const URL = pgTestUrl(import.meta.url);
const AVAILABLE = await realPgAvailable(URL);
const WATCHED = ["INBOX", "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"];
const cfg = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } };
const eml = (id: string): Buffer => Buffer.from([
  "From: Anna <anna@sender.test>", "To: owner@trafficflow.test", `Subject: ${id}`,
  "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <${id}@lane.test>`, "", `Body of ${id}.`, "",
].join("\r\n"));
type Msg = { id: string; raw: Buffer; declared: number };
const ordinary = (id: string): Msg => ({ id, raw: eml(id), declared: eml(id).length });
const liar = (id: string): Msg => ({ id, raw: Buffer.alloc(2 * 1024 * 1024, 0x61), declared: 10 });

/** One scripted server; `client()` is one connection to it, so every dial gets its own. */
function server(inbox: Array<[number, Msg]>) {
  const folders = new Map<string, { uidValidity: bigint; msgs: Map<number, Msg> }>([
    ["INBOX", { uidValidity: 100n, msgs: new Map(inbox) }],
  ]);
  const state = { bodies: {} as Record<string, number>, folders };
  const client = () => {
    let path = "INBOX";
    const msgsOf = (p: string) => folders.get(p)?.msgs ?? new Map<number, Msg>();
    const parseSet = (range: unknown): number[] => {
      const all = [...msgsOf(path).keys()].sort((a, b) => a - b);
      if (Array.isArray(range)) return range.map(Number).filter((u) => msgsOf(path).has(u)).sort((a, b) => a - b);
      if (typeof range !== "string") return all;
      const out = new Set<number>();
      for (const part of range.split(",")) {
        const [lo, hi] = part.split(":");
        const a = lo === "*" ? Number.MAX_SAFE_INTEGER : Number(lo);
        const b = hi === undefined ? a : hi === "*" ? Number.MAX_SAFE_INTEGER : Number(hi);
        for (const u of all) if (u >= Math.min(a, b) && u <= Math.max(a, b)) out.add(u);
      }
      return [...out].sort((x, y) => x - y);
    };
    const c = {
      usable: true,
      capabilities: new Map<string, boolean>([["MOVE", true], ["UIDPLUS", true]]),
      mailbox: undefined as unknown,
      async list() { return WATCHED.map((p) => ({ path: p, name: p.split("/").pop()!, delimiter: "/", flags: new Set<string>() })); },
      async mailboxCreate(p: string) { return { path: p }; },
      async getMailboxLock(p: string) {
        path = p;
        const f = folders.get(p);
        const keys = f ? [...f.msgs.keys()] : [];
        c.mailbox = { path: p, uidValidity: f?.uidValidity ?? 7n, uidNext: Math.max(0, ...keys) + 1, highestModseq: 0n, exists: keys.length };
        return { path: p, release() { /* nothing */ } };
      },
      async search() { return []; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async *fetch(range: any, query: any) {
        for (const uid of parseSet(range)) {
          const m = msgsOf(path).get(uid)!;
          if (query?.source) {
            const k = `${path}:${uid}`; state.bodies[k] = (state.bodies[k] ?? 0) + 1;
            yield { uid, flags: new Set<string>(), envelope: { messageId: `<${m.id}@lane.test>` }, source: m.raw, internalDate: new Date(Date.UTC(2026, 8, 30) + uid * 1000) };
          } else if (query?.size) yield { uid, size: m.declared };
          else if (query?.headers) yield { uid, headers: Buffer.from(`Message-ID: <${m.id}@lane.test>\r\n`) };
          else if (query?.internalDate) yield { uid, internalDate: new Date(Date.UTC(2026, 8, 30) + uid * 1000), envelope: {} };
          else if (query?.flags) yield { uid, flags: new Set<string>() };
          else yield { uid };
        }
      },
      async messageMove() { return { uidValidity: 100n, uidMap: new Map<number, number>() }; },
      async messageCopy() { return { uidValidity: 100n, uidMap: new Map<number, number>() }; },
      async messageDelete() { return true; },
      async logout() { /* nothing */ },
      close() { /* nothing */ },
      on() { /* no events */ },
    };
    return c;
  };
  return { state, client };
}

describe.skipIf(!AVAILABLE)("row 1: the shared loop's backstop hold over overrun set-asides", () => {
  const sql = postgres(URL, { max: 3 });
  const db = brandDialect(drizzle(sql, { schema }), "pg");
  const repo = makeDrizzleRepo(db);
  beforeAll(async () => { await runMigrations(URL); }, 60_000);
  afterAll(async () => { await sql.end({ timeout: 5 }); });

  it("six liars and nothing else on a hold-enabled ledger: the hold never engages over them", async () => {
    const [acct] = await db.insert(accounts).values({ name: "overrun-hold" }).returning();
    const [mb] = await db.insert(mailboxes)
      .values({ accountId: acct!.id, provider: "imap", address: `ohl-${randomUUID().slice(0, 8)}@tf.example` }).returning();
    const ids = { accountId: acct!.id, mailboxId: mb!.id };
    const inbox: Array<[number, Msg]> = [];
    for (let u = 1; u <= 6; u++) inbox.push([u, liar(`liar-${u}`)]);
    const s = server(inbox);
    const dl = new DeadLetterLedger({ holdAtCap: true });
    const held: number[] = [];
    for (let i = 0; i < 9; i++) {
      const adapter = new ImapAdapter(cfg, { client: s.client() as never });
      await adapter.connect();
      await runSyncCycle({
        repo, adapter, ...ids, storageCap: UNMETERED_STORAGE_CAP,
        writeAuthority: FIXTURE_LEASE, deadLetters: dl, buildVersion: "build-one",
        role: "organizer", trustedAuthservIds: new Set<string>(),
      }).catch(() => undefined);
      if (dl.writeOffsHeldSince !== null) held.push(i);
    }
    const stored = await db.select({ id: messages.id }).from(messages).where(eq(messages.mailboxId, ids.mailboxId));
    console.log("ROW1 worker", JSON.stringify({ held, bodies: s.state.bodies, stored: stored.length }));
    for (let u = 1; u <= 6; u++) expect(s.state.bodies[`INBOX:${u}`], `liar ${u} fetched`).toBe(1);
    expect(held, "passes at which the hold stood over overrun set-asides alone").toEqual([]);
    // A RELAUNCH under the same build label: a fresh ledger takes the run from the store alone.
    const relaunched = new DeadLetterLedger({ holdAtCap: true });
    const adapter = new ImapAdapter(cfg, { client: s.client() as never });
    await adapter.connect();
    await runSyncCycle({
      repo, adapter, ...ids, storageCap: UNMETERED_STORAGE_CAP,
      writeAuthority: FIXTURE_LEASE, deadLetters: relaunched, buildVersion: "build-one",
      role: "organizer", trustedAuthservIds: new Set<string>(),
    }).catch(() => undefined);
    expect(relaunched.writeOffsHeldSince, "a relaunch held over six set-aside rows").toBeNull();
  }, 60_000);

  async function seeded(rows: Array<{ code: string; at: number }>) {
    const [acct] = await db.insert(accounts).values({ name: "write-off-run" }).returning();
    const [mb] = await db.insert(mailboxes)
      .values({ accountId: acct!.id, provider: "imap", address: `wor-${randomUUID().slice(0, 8)}@tf.example` }).returning();
    const t0 = Date.UTC(2026, 9, 1, 12);
    let uid = 1;
    for (const r of rows) {
      await db.insert(messageFailures).values({
        accountId: acct!.id, mailboxId: mb!.id, folder: "INBOX", uidvalidity: 100n, uid: uid++, code: r.code,
        attempts: 1, attemptedVersion: "build-one", nextAttemptAt: null,
        firstFailedAt: new Date(t0 + r.at), lastFailedAt: new Date(t0 + r.at),
      });
    }
    return mb!.id;
  }

  it("writeOffRun: six pre-fetch oversize rows (mime_too_large) and nothing stored count nothing", async () => {
    const id = await seeded(Array.from({ length: 6 }, (_, i) => ({ code: "mime_too_large", at: i })));
    expect(await repo.writeOffRun(id, "build-one", 5, HOLD_EXEMPT_CODES)).toEqual({ count: 0, heldSince: null });
  });

  it("writeOffRun: the exclusion is applied before the cap, so five older ordinary rows still hold", async () => {
    const id = await seeded([
      ...Array.from({ length: 5 }, (_, i) => ({ code: "data_exception", at: i })),
      ...Array.from({ length: 6 }, (_, i) => ({ code: "mime_too_large", at: 1_000 + i })),
    ]);
    const run = await repo.writeOffRun(id, "build-one", 5, HOLD_EXEMPT_CODES);
    expect(run.count).toBe(5);
    expect(run.heldSince).not.toBeNull();
  });

  it("writeOffRun: CONTROL, five ordinary write-offs hold", async () => {
    const id = await seeded(Array.from({ length: 5 }, (_, i) => ({ code: "data_exception", at: i })));
    expect((await repo.writeOffRun(id, "build-one", 5, HOLD_EXEMPT_CODES)).count).toBe(5);
  });

  it("writeOffRun: an empty exempt list is refused rather than counting every row", async () => {
    const id = await seeded([{ code: "mime_too_large", at: 0 }]);
    await expect(repo.writeOffRun(id, "build-one", 5, [])).rejects.toThrow(/HOLD_EXEMPT_CODES/);
  });
});

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 47));

describe.skipIf(!AVAILABLE)("row 2: the hosted worker's wait after an overrun set-aside", () => {
  let DB = "";
  const closers: Array<() => Promise<void>> = [];
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_overrunladder"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("five liars then new mail: no quarantine and no growing wait between set-asides", async () => {
    const wdb = makeDb(DB);
    const [row] = await wdb.insert(mailboxes).values({
      accountId: randomUUID(), provider: "imap", address: `${randomUUID()}@trafficflow.test`,
    }).returning();
    const enc = await KP.encrypt("pw");
    await wdb.insert(mailboxCredentials).values({
      mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
    });
    const inbox: Array<[number, Msg]> = [[1, ordinary("old-1")]];
    for (let u = 2; u <= 6; u++) inbox.push([u, liar(`liar-${u}`)]);
    inbox.push([7, ordinary("new-mail")]);
    const s = server(inbox);
    const fleet = new FakeAdapterFleet();
    // Lease and profile from the fleet's in-memory `_meta`; the mail itself from the real adapter.
    const factory = (c: Parameters<FakeAdapterFleet["factory"]>[0], ctx: Parameters<FakeAdapterFleet["factory"]>[1]): MailboxAdapter => {
      const fake = fleet.factory(c, ctx);
      const real = new ImapAdapter(cfg, { client: s.client() as never, onConnectionError: ctx.onConnectionError });
      return {
        ...fake,
        async connect() { await fake.connect(); await real.connect(); },
        async close() { await fake.close(); await real.close(); },
        forceClose: () => real.forceClose(),
        capabilities: () => real.capabilities(),
        changesSince: (cur) => real.changesSince(cur),
        fetchByUid: (f, u, o) => real.fetchByUid(f, u, o),
      } as MailboxAdapter;
    };
    const lines: Array<Record<string, unknown>> = [];
    const started = Date.now();
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 50, sentDomain: "trafficflow.test",
      // One failure quarantines, so the cycle's own arm decides apart from the connection handler's.
      rosterIntervalMs: 100, mailboxRetryMs: 250, maxSyncFailures: 1,
      lockHeartbeatMs: 150, instanceId: `wkr-overrun-${randomUUID().slice(0, 8)}`,
      adapterFactory: factory,
      logger: createLogger({ service: "worker", level: "info", sink: (l) => lines.push(JSON.parse(l)) }),
    });
    closers.push(() => worker.stop());
    let storedAt = -1;
    while (Date.now() - started < 40_000) {
      const got = await wdb.select({ subject: messages.subject }).from(messages).where(eq(messages.mailboxId, row!.id));
      if (got.some((m) => m.subject === "new-mail")) { storedAt = Date.now() - started; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    const quarantined = lines.filter((l) => l.event === "mailbox_quarantined").map((l) => ({ retryInMs: l.retryInMs, attempts: l.attempts, ceiling: l.ceiling }));
    console.log("ROW2 worker", JSON.stringify({ storedAt, quarantined, bodies: s.state.bodies }));
    expect(storedAt, "new mail was never stored").toBeGreaterThan(-1);
    for (let u = 2; u <= 6; u++) expect(s.state.bodies[`INBOX:${u}`], `liar ${u} fetched`).toBe(1);
    expect(quarantined, "a pass that set its message aside quarantined the mailbox").toEqual([]);
  }, 60_000);

  it("CONTROL: an older set-aside re-read (UIDVALIDITY 0) is quarantined by the connection event alone", async () => {
    /* maxSyncFailures 3, so the cycle's arm counts one and quarantines nothing: only the connection
       handler's no-progress half can. The first pass wrote the row (progress); the second re-reads it. */
    const wdb = makeDb(DB);
    const [row] = await wdb.insert(mailboxes).values({
      accountId: randomUUID(), provider: "imap", address: `${randomUUID()}@trafficflow.test`,
    }).returning();
    const enc = await KP.encrypt("pw");
    await wdb.insert(mailboxCredentials).values({
      mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
    });
    const s = server([[1, ordinary("old-1")], [2, liar("liar-2")], [3, ordinary("behind-the-liar")]]);
    s.state.folders.get("INBOX")!.uidValidity = 0n;
    const fleet = new FakeAdapterFleet();
    const factory = (c: Parameters<FakeAdapterFleet["factory"]>[0], ctx: Parameters<FakeAdapterFleet["factory"]>[1]): MailboxAdapter => {
      const fake = fleet.factory(c, ctx);
      const real = new ImapAdapter(cfg, { client: s.client() as never, onConnectionError: ctx.onConnectionError });
      return {
        ...fake,
        async connect() { await fake.connect(); await real.connect(); },
        async close() { await fake.close(); await real.close(); },
        forceClose: () => real.forceClose(),
        capabilities: () => real.capabilities(),
        changesSince: (cur) => real.changesSince(cur),
        fetchByUid: (f, u, o) => real.fetchByUid(f, u, o),
      } as MailboxAdapter;
    };
    const lines: Array<Record<string, unknown>> = [];
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 50, sentDomain: "trafficflow.test",
      rosterIntervalMs: 100, mailboxRetryMs: 250, maxSyncFailures: 3,
      lockHeartbeatMs: 150, instanceId: `wkr-overrun-epochless-${randomUUID().slice(0, 8)}`,
      adapterFactory: factory,
      logger: createLogger({ service: "worker", level: "info", sink: (l) => lines.push(JSON.parse(l)) }),
    });
    closers.push(() => worker.stop());
    const start = Date.now();
    while (!lines.some((l) => l.event === "mailbox_quarantined") && Date.now() - start < 20_000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const failedCycles = lines.filter((l) => l.event === "sync_cycle_failed").length;
    console.log("EPOCHLESS worker", JSON.stringify({ bodies: s.state.bodies, failedCycles, setAside: lines.filter((l) => l.event === "sync_cycle_set_aside").length }));
    expect(s.state.bodies["INBOX:2"], "the liar was not re-read, so this case proves nothing").toBeGreaterThanOrEqual(2);
    expect(failedCycles, "the cycle arm alone reached maxSyncFailures").toBeLessThan(3);
    expect(lines.find((l) => l.event === "mailbox_quarantined"), "a re-read of an older set-aside was not quarantined")
      .toMatchObject({ syncBlockedReason: "read_limited", ceiling: "body_overrun" });
  }, 30_000);

  for (const [name, breach] of [
    ["a batch-total breach that names no message", new ImapBoundExceeded("body_overrun", 1_000, 2_000_000, "INBOX")],
    ["a breach naming a message nothing set aside", new ImapBoundExceeded("body_overrun", 1_000, 2_000_000, "INBOX", { uidValidity: "100", uid: 7 })],
  ] as const) {
    it(`CONTROL: ${name} is still counted and quarantined`, async () => {
      const wdb = makeDb(DB);
      const [row] = await wdb.insert(mailboxes).values({
        accountId: randomUUID(), provider: "imap", address: `${randomUUID()}@trafficflow.test`,
      }).returning();
      const enc = await KP.encrypt("pw");
      await wdb.insert(mailboxCredentials).values({
        mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
        meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
      });
      const fleet = new FakeAdapterFleet();
      fleet.behave(row!.id, { syncError: breach });
      const lines: Array<Record<string, unknown>> = [];
      const worker = await startWorker({
        databaseUrl: DB, keyProvider: KP, pollIntervalMs: 100, sentDomain: "trafficflow.test",
        rosterIntervalMs: 200, mailboxRetryMs: 300, maxSyncFailures: 1,
        lockHeartbeatMs: 150, instanceId: `wkr-overrun-ctl-${randomUUID().slice(0, 8)}`,
        adapterFactory: fleet.factory,
        logger: createLogger({ service: "worker", level: "info", sink: (l) => lines.push(JSON.parse(l)) }),
      });
      closers.push(() => worker.stop());
      const start = Date.now();
      while (!lines.some((l) => l.event === "mailbox_quarantined") && Date.now() - start < 20_000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(lines.find((l) => l.event === "mailbox_quarantined"), "an unmarked breach was not quarantined")
        .toMatchObject({ syncBlockedReason: "read_limited", ceiling: "body_overrun" });
      expect(lines.some((l) => l.event === "sync_cycle_set_aside")).toBe(false);
    }, 30_000);
  }
});
