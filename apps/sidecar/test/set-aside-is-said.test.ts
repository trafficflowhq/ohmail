import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, isNull } from "drizzle-orm";
import {
  ImapConnectionClosedError,
  type ChangeBatch, type FetchedPart, type ImapCapabilities, type ImapCursor, type MailboxAdapter,
  type NativeLocator, type SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, LeasePeekIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { createLogger, MimeParseError } from "@trafficflow/core/mail";
import { accounts, mailboxes, messageFailures, messages } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { mirroredFirstSyncFacts } from "../src/local-mirror.js";
import { openPhoneStore, type PhoneSqlExecutor, type PhoneSqlRows } from "../src/mobile.js";
import { DeadLetterLedger, HOLD_EXEMPT_CODES } from "@ohmail/organizer/dead-letter";

/**
 * ON THE PHONE'S STORE (node:sqlite), through the phone's own composition: (A) a message the ledger
 * set aside among good ones is counted on the engine's record and its connections route, and the
 * count falls when a re-read resolves it; (B) `writeOffRun` counts only inserts, never re-failures,
 * and reads at most the cap; (C) a store-fault drain over a live socket ends the outage clock.
 */
vi.setConfig({ testTimeout: 60_000 });

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const ON_DEVICE_STORE = process.env.OHMAIL_EXPECT_DIALECT === "sqlite";
const MEASURE = process.env.OHMAIL_MEASURE === "1";

class MemoryMeta implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number { return 4_400; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(installId)).map((c) => ({ ...c }));
  }
}

const eml = (id: string): Buffer => Buffer.from([
  "From: Anna <anna@sender.test>", "To: owner@trafficflow.test", `Subject: ${id}`,
  "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <${id}@lane.test>`, "", `Body of ${id}.`, "",
].join("\r\n"));

/** INBOX uids 1..count; `unreadable` uids raise mailparser's refusal (deterministic, written off at once). */
function inbox(
  count: number, unreadable: ReadonlySet<number>,
  state: { deadSocket: boolean; dialHeld?: Promise<void>; hidden?: Set<number> } = { deadSocket: false },
) {
  const meta = new MemoryMeta();
  const counts = { logins: 0 };
  const create = (uid: number) => {
    const c = { type: "create" as const, locator: { folder: "INBOX", ref: `4400:${uid}` }, seen: false };
    Object.defineProperty(c, "raw", {
      enumerable: true,
      get: () => {
        if (unreadable.has(uid)) throw new MimeParseError(new Error("planted: these bytes do not parse"));
        return eml(`message-${uid}`);
      },
    });
    return c;
  };
  const factory = (): MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo } => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: async () => meta.listClaims() }),
    async connect(): Promise<void> {
      counts.logins++;
      if (state.dialHeld) await state.dialHeld;
    },
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(c: ImapCursor): Promise<ChangeBatch> {
      if (state.deadSocket) throw new ImapConnectionClosedError();
      const known = new Set((c.folders.INBOX?.known ?? []).map((k) => k.uid));
      const creates = Array.from({ length: count }, (_, i) => i + 1)
        .filter((u) => !known.has(u) && !(state.hidden?.has(u) ?? false)).map(create);
      return {
        creates, moves: [], flagChanges: [], deletes: [],
        newCursor: { folders: { INBOX: { uidValidity: "4400", uidNext: count + 1, highestModseq: "0" } } },
      } as unknown as ChangeBatch;
    },
    async fetchByUid(_folder: string, uids: readonly number[]) {
      return { uidValidity: "4400", creates: uids.map(create), absent: [], oversize: [] } as never;
    },
    async move(_l: NativeLocator, toFolder: string): Promise<NativeLocator> { return { folder: toFolder, ref: "4400:99" }; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart in this rig"); },
    async send(): Promise<SendResult> { throw new Error("no send in this rig"); },
  });
  return { factory, counts };
}

/** The store's own refusal, readable prefix: SQLite's `full` class, the device's. */
const FULL = () => Object.assign(
  new Error("Call to function 'NativeStatement.executeAsync' has been rejected.\n→ Caused by: Error code \r: database or disk is full"),
  { code: "ERR_INTERNAL_SQLITE_ERROR" },
);

/** node:sqlite behind the phone's statement runner; `rows` counts what each read returns, `writes` refuses data writes while set. */
function sqlExecutor(raw = new sqlite.DatabaseSync(":memory:")) {
  const seen = { reads: [] as Array<{ sql: string; rows: number }>, refuseWrites: false };
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => T): Promise<T> => { const n = tail.then(job, job); tail = n.catch(() => undefined); return n; };
  const refuse = (sql: string) => {
    if (seen.refuseWrites && /^\s*(insert|update|delete)/i.test(sql)) throw FULL();
  };
  const exec: PhoneSqlExecutor = {
    all: (sql, params): Promise<PhoneSqlRows> => serial(() => {
      refuse(sql);
      const st = raw.prepare(sql);
      const columns = st.columns().map((c) => c.name);
      const objects = st.all(...(params as never[])) as Record<string, unknown>[];
      seen.reads.push({ sql, rows: objects.length });
      return { columns, rows: objects.map((o) => columns.map((c) => o[c])) };
    }),
    run: (sql, params) => serial(() => { refuse(sql); raw.prepare(sql).run(...(params as never[])); }),
    batch: (statements) => serial(() => {
      raw.exec("BEGIN IMMEDIATE");
      try {
        for (const { sql, params = [] } of statements) { refuse(sql); raw.prepare(sql).run(...(params as never[])); }
        raw.exec("COMMIT");
      } catch (err) {
        try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ }
        throw err;
      }
    }),
    close: async () => { try { raw.close(); } catch { /* already closed */ } },
  };
  return { exec, raw, seen };
}

async function phone(
  adapterFactory: () => MailboxAdapter, exec: PhoneSqlExecutor, open: Sidecar[], buildCommit?: string, awaitStart = true,
) {
  const events: string[] = [];
  const s = await createSidecar({
    ...(buildCommit !== undefined ? { buildCommit } : {}),
    dataDir: "",
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "pw" } },
    address: "owner@trafficflow.test", machineName: "ohmail on a phone", installId: "install-set-aside",
    organizerKind: "mobile", pollIntervalMs: 40, keks: { 1: Buffer.alloc(32, 6) },
    adapterFactory, store: async () => openPhoneStore(exec),
    log: (event) => { events.push(event); },
    logger: createLogger({ service: "sidecar", sink: (l) => { events.push((JSON.parse(l) as { event: string }).event); } }),
  });
  open.push(s);
  await s.db.update(mailboxes).set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
    .where(isNull(mailboxes.organizeConsentedAt));
  const started = s.start().catch(() => undefined);
  if (awaitStart) await started;
  const id = async () => (await s.db.select({ id: mailboxes.id }).from(mailboxes))[0]!.id;
  const drains = () => events.filter((e) => e === "sync_drain").length;
  return { s, events, id, drains };
}

describe.runIf(ON_DEVICE_STORE)("(A) a message this phone set aside, among good ones", () => {
  const open: Sidecar[] = [];
  afterEach(async () => { while (open.length > 0) await open.pop()!.stop().catch(() => undefined); });

  async function settled(unreadable: ReadonlySet<number> = new Set([3])) {
    const { exec } = sqlExecutor();
    const p = await phone(inbox(4, unreadable).factory, exec, open);
    await vi.waitFor(async () => {
      expect((await p.s.db.select({ id: messages.id }).from(messages)).length).toBe(4 - unreadable.size);
      expect((await p.s.db.select({ code: messageFailures.code }).from(messageFailures)).map((r) => r.code))
        .toEqual([...unreadable].map(() => "mime_unparseable"));
    }, { timeout: 30_000, interval: 20 });
    const from = p.drains();
    await vi.waitFor(() => { expect(p.drains()).toBeGreaterThan(from + 3); }, { timeout: 30_000, interval: 20 });
    const mailboxId = await p.id();
    return { ...p, mailboxId, conn: p.s.connectionStates()[mailboxId]! };
  }

  it("written off at once, the rest stored, and every other field the surfaces read says healthy", async () => {
    const { conn } = await settled();
    expect({
      firstSync: conn.firstSync, held: conn.writeOffsHeldSince ?? null, storeFault: conn.storeFaultSince ?? null,
      reachable: conn.reachable,
    }).toEqual({ firstSync: "finished", held: null, storeFault: null, reachable: true });
  });

  it("mirroredFirstSyncFacts still asks about write-offs only where the mailbox is empty", async () => {
    const { s, mailboxId } = await settled();
    expect(await mirroredFirstSyncFacts(s.db, mailboxId)).toEqual({ hasMessage: true, wroteOff: false });
  });

  it("the engine's connection record counts the one message set aside", async () => {
    const { conn } = await settled();
    expect(conn).toHaveProperty("setAside", 1);
  });

  it("the connections route the desktop reads carries the count, and nothing else about the message", async () => {
    const { s, mailboxId } = await settled();
    const res = await s.handle(new Request("http://local/local/mailboxes/connections", { headers: { authorization: `Bearer ${s.sessionToken}` } }));
    const item = ((await res.json()) as { items: Array<Record<string, unknown>> }).items.find((r) => r.mailboxId === mailboxId)!;
    expect(item.setAside).toBe(1);
    expect(JSON.stringify(item)).not.toMatch(/message-3|INBOX|4400/);
  });

  /* THE STORE'S SET IS THE COUNT: a folder rename moves the row (the statement `applyFolderRename`
     runs), the server's folder no longer lists the message, and one message still reads one. */
  async function aside(state: { deadSocket: boolean; hidden: Set<number> }) {
    const ex = sqlExecutor();
    const p = await phone(inbox(4, new Set([3]), state).factory, ex.exec, open);
    const mailboxId = await p.id();
    await vi.waitFor(() => { expect(p.s.connectionStates()[mailboxId]!.setAside).toBe(1); }, { timeout: 30_000, interval: 20 });
    const settle = async () => {
      const from = p.drains();
      await vi.waitFor(() => { expect(p.drains()).toBeGreaterThan(from + 3); }, { timeout: 30_000, interval: 20 });
    };
    return { ...p, ex, mailboxId, settle, count: () => p.s.connectionStates()[mailboxId]!.setAside };
  }

  it("a folder rename leaves one set-aside message counted once", async () => {
    const state = { deadSocket: false, hidden: new Set<number>() };
    const a = await aside(state);
    state.hidden.add(3);
    a.ex.raw.prepare(`UPDATE message_failures SET folder = 'Renamed' WHERE folder = 'INBOX'`).run();
    await a.settle();
    expect(a.count()).toBe(1);
  });

  it("a folder moved under another parent leaves the count at one", async () => {
    const state = { deadSocket: false, hidden: new Set<number>() };
    const a = await aside(state);
    state.hidden.add(3);
    a.ex.raw.prepare(`UPDATE message_failures SET folder = 'Archive/INBOX' WHERE folder = 'INBOX'`).run();
    await a.settle();
    expect(a.count()).toBe(1);
  });

  it("the mailbox's rows deleted (the statement the removal's wipe runs) count zero", async () => {
    const state = { deadSocket: false, hidden: new Set<number>() };
    const a = await aside(state);
    state.hidden.add(3);
    a.ex.raw.prepare(`DELETE FROM message_failures WHERE mailbox_id = ?`).run(a.mailboxId);
    await a.settle();
    expect(a.count()).toBe(0);
  });

  /* A FOLDER GONE FROM THE SERVER keeps its row (filed: SET-ASIDE-ROW-FOR-A-VANISHED-PLACE-NEVER-CLEARS);
     the count is the store's row and never doubles. */
  it("a set-aside message whose folder is gone from the server is counted once, not twice", async () => {
    const state = { deadSocket: false, hidden: new Set<number>() };
    const a = await aside(state);
    state.hidden.add(3);
    await a.settle();
    expect(a.count()).toBe(1);
    expect((await a.s.db.select({ id: messageFailures.id }).from(messageFailures)).length).toBe(1);
  });

  it("a held write-off run over a healthy store says `storage` and names no store refusal", async () => {
    const ex = sqlExecutor();
    const p = await phone(inbox(6, new Set([2, 3, 4, 5, 6])).factory, ex.exec, open);
    const mailboxId = await p.id();
    await vi.waitFor(() => { expect(p.s.connectionStates()[mailboxId]!.writeOffsHeldSince).toBeInstanceOf(Date); },
      { timeout: 30_000, interval: 20 });
    const res = await p.s.handle(new Request("http://local/mailboxes", { headers: { authorization: `Bearer ${p.s.sessionToken}` } }));
    const it = ((await res.json()) as { items: Array<{ id: string; status: string; errorCode: string | null; errorDetail?: string | null }> })
      .items.find((r) => r.id === mailboxId)!;
    expect([it.status, it.errorCode, it.errorDetail ?? null]).toEqual(["error", "storage", null]);
    expect(p.s.connectionStates()[mailboxId]!.storeFaultSince ?? null).toBeNull();
  });

  it("CONTROL: nothing set aside counts zero", async () => {
    const { conn } = await settled(new Set());
    expect(conn.setAside).toBe(0);
  });

  it("the count falls when a new build reads the message again and resolves it", async () => {
    const file = `${process.env.TMPDIR ?? "/tmp"}/set-aside-${process.pid}-${Date.now()}.db`;
    const unreadable = new Set([3]);
    const first = await phone(inbox(4, unreadable).factory, sqlExecutor(new sqlite.DatabaseSync(file)).exec, open, "build-1");
    const id1 = await first.id();
    await vi.waitFor(() => { expect(first.s.connectionStates()[id1]!.setAside).toBe(1); }, { timeout: 30_000, interval: 20 });
    await first.s.stop();
    open.splice(open.indexOf(first.s), 1);
    unreadable.clear();
    const second = await phone(inbox(4, unreadable).factory, sqlExecutor(new sqlite.DatabaseSync(file)).exec, open, "build-2");
    const id2 = await second.id();
    await vi.waitFor(async () => {
      expect((await second.s.db.select({ id: messages.id }).from(messages)).length).toBe(4);
      expect(second.s.connectionStates()[id2]!.setAside).toBe(0);
    }, { timeout: 30_000, interval: 20 });
    expect((await second.s.db.select({ at: messageFailures.resolvedAt }).from(messageFailures))
      .map((r) => r.at instanceof Date)).toEqual([true]);
    await second.s.stop();
    open.splice(open.indexOf(second.s), 1);
    rmSync(file, { force: true });
  });

  /* A RELAUNCH WHOSE DIAL HAS NOT ANSWERED: no cycle runs, and the count is the store's from the start. */
  it("after a relaunch whose dial has not answered, the count stands before any cycle", async () => {
    const file = `${process.env.TMPDIR ?? "/tmp"}/set-aside-relaunch-${process.pid}-${Date.now()}.db`;
    const first = await phone(inbox(4, new Set([3])).factory, sqlExecutor(new sqlite.DatabaseSync(file)).exec, open, "build-1");
    const id1 = await first.id();
    await vi.waitFor(() => { expect(first.s.connectionStates()[id1]!.setAside).toBe(1); }, { timeout: 30_000, interval: 20 });
    await first.s.stop();
    open.splice(open.indexOf(first.s), 1);
    let answer!: () => void;
    const dialHeld = new Promise<void>((r) => { answer = r; });
    const again = await phone(inbox(4, new Set([3]), { deadSocket: false, dialHeld }).factory,
      sqlExecutor(new sqlite.DatabaseSync(file)).exec, open, "build-1", false);
    const id2 = await again.id();
    await vi.waitFor(() => { expect(again.s.connectionStates()[id2]!.setAside).toBe(1); }, { timeout: 10_000, interval: 20 });
    expect(again.drains()).toBe(0);
    answer();
    await again.s.stop();
    open.splice(open.indexOf(again.s), 1);
    rmSync(file, { force: true });
  });
});

/** A mailbox, `stored` messages stamped at `storedAt`, and `n` unresolved write-offs under `version`. */
async function seeded(n: number, opts: { stored: number; storedAt: Date; failedAt: Date; version: string; code?: string }) {
  const ex = sqlExecutor();
  const { db } = await openPhoneStore(ex.exec);
  const [acct] = await db.insert(accounts).values({}).returning({ id: accounts.id });
  const [mb] = await db.insert(mailboxes).values({ accountId: acct!.id, provider: "imap", address: "owner@trafficflow.test" })
    .returning({ id: mailboxes.id });
  const ins = ex.raw.prepare("INSERT INTO messages (id, account_id, mailbox_id, body_hash, dedup_key, created_at) VALUES (?, ?, ?, 'h', ?, ?)");
  for (let i = 0; i < opts.stored; i++) ins.run(`m-${i}`, acct!.id, mb!.id, `d-${i}`, opts.storedAt.getTime() - i);
  const f = ex.raw.prepare(`INSERT INTO message_failures (id, account_id, mailbox_id, folder, uidvalidity, uid, code, attempts,
    attempted_version, first_failed_at, last_failed_at) VALUES (?, ?, ?, 'INBOX', 4400, ?, ?, 1, ?, ?, ?)`);
  const code = opts.code ?? "mime_unparseable";
  for (let i = 0; i < n; i++) f.run(`f-${i}`, acct!.id, mb!.id, i + 1, code, opts.version, opts.failedAt.getTime() + i, opts.failedAt.getTime() + i);
  return { ...ex, db, accountId: acct!.id, mailboxId: mb!.id, repo: makeDrizzleRepo(db as never) };
}

describe.runIf(ON_DEVICE_STORE)("(B) writeOffRun on the phone's store", () => {
  const t0 = new Date("2026-10-01T12:00:00Z");

  it("CONTROL: five write-offs after the newest stored message hold at the cap", async () => {
    const r = await seeded(5, { stored: 1, storedAt: t0, failedAt: new Date(t0.getTime() + 1_000), version: "build-1" });
    expect((await r.repo.writeOffRun(r.mailboxId, "build-1", 5, HOLD_EXEMPT_CODES)).count).toBe(5);
  });

  it("six mime_too_large rows after the newest stored message count nothing; under six of them five ordinary still hold", async () => {
    const exempt = await seeded(6, { stored: 1, storedAt: t0, failedAt: new Date(t0.getTime() + 1_000), version: "build-1", code: "mime_too_large" });
    expect(await exempt.repo.writeOffRun(exempt.mailboxId, "build-1", 5, HOLD_EXEMPT_CODES)).toEqual({ count: 0, heldSince: null });
    const mixed = await seeded(5, { stored: 1, storedAt: t0, failedAt: new Date(t0.getTime() + 1_000), version: "build-1" });
    const f = mixed.raw.prepare(`INSERT INTO message_failures (id, account_id, mailbox_id, folder, uidvalidity, uid, code, attempts,
      attempted_version, first_failed_at, last_failed_at) VALUES (?, ?, ?, 'INBOX', 4400, ?, 'mime_too_large', 1, 'build-1', ?, ?)`);
    for (let i = 0; i < 6; i++) f.run(`x-${i}`, mixed.accountId, mixed.mailboxId, 100 + i, t0.getTime() + 60_000 + i, t0.getTime() + 60_000 + i);
    const run = await mixed.repo.writeOffRun(mixed.mailboxId, "build-1", 5, HOLD_EXEMPT_CODES);
    expect({ count: run.count, held: run.heldSince !== null }).toEqual({ count: 5, held: true });
  });

  it("five OLD write-offs that re-fail after a stored message do not re-engage the hold", async () => {
    const r = await seeded(5, { stored: 1, storedAt: t0, failedAt: new Date(t0.getTime() - 60_000), version: "build-1" });
    expect((await r.repo.writeOffRun(r.mailboxId, "build-1", 5, HOLD_EXEMPT_CODES)).count).toBe(0);
    for (let uid = 1; uid <= 5; uid++) {
      await r.repo.recordMessageFailure(r.mailboxId, {
        accountId: r.accountId, folder: "INBOX", uidValidity: "4400", uid, code: "mime_unparseable",
        version: "build-1", nextAttemptAt: null,
      } as never);
    }
    const run = await r.repo.writeOffRun(r.mailboxId, "build-1", 5, HOLD_EXEMPT_CODES);
    expect({ count: run.count, held: run.heldSince !== null }).toEqual({ count: 0, held: false });
  });

  /* WRITE-OFF-RUN-BELOW-CAP-SKIPS-THE-STORED-FILTER: below the cap the raw count came back, so four
     old rows plus one new ordinary write-off engaged the hold ("could not store this mail"). */
  it("four write-offs from before the newest stored message count nothing below the cap", async () => {
    const r = await seeded(4, { stored: 1, storedAt: t0, failedAt: new Date(t0.getTime() - 60_000), version: "build-1" });
    const run = await r.repo.writeOffRun(r.mailboxId, "build-1", 5, HOLD_EXEMPT_CODES);
    expect({ count: run.count, heldSince: run.heldSince }).toEqual({ count: 0, heldSince: null });
  });

  it("CONTROL: four write-offs after the newest stored message count four", async () => {
    const r = await seeded(4, { stored: 1, storedAt: t0, failedAt: new Date(t0.getTime() + 1_000), version: "build-1" });
    const run = await r.repo.writeOffRun(r.mailboxId, "build-1", 5, HOLD_EXEMPT_CODES);
    expect({ count: run.count, heldSince: run.heldSince }).toEqual({ count: 4, heldSince: null });
  });

  /* LOW 4: the newest stored message is looked up once per launch, not at every cycle's start. */
  it("the messages read runs once across idle cycles, and again after a message is stored", async () => {
    const r = await seeded(5, { stored: 100, storedAt: t0, failedAt: new Date(t0.getTime() + 1_000), version: "build-1" });
    const ledger = new DeadLetterLedger({ holdAtCap: true });
    r.seen.reads.length = 0;
    for (let i = 0; i < 6; i++) { ledger.beginCycle(); await ledger.hydrateRunFrom(r.repo, r.mailboxId, "build-1"); }
    const lookups = (): number => r.seen.reads.filter((x) => /from "messages"/i.test(x.sql)).length;
    expect(lookups(), "the newest stored message was read on every idle cycle").toBe(1);
    expect(ledger.writeOffsHeldSince).not.toBeNull();
    ledger.noteStored();
    await ledger.hydrateRunFrom(r.repo, r.mailboxId, "build-1");
    expect(lookups()).toBe(2);
  });

  it("the read returns at most the cap's rows, whatever the backlog", async () => {
    const r = await seeded(1_000, { stored: 1, storedAt: t0, failedAt: new Date(t0.getTime() + 1_000), version: "build-1" });
    r.seen.reads.length = 0;
    await r.repo.writeOffRun(r.mailboxId, "build-1", 5, HOLD_EXEMPT_CODES);
    const largest = Math.max(...r.seen.reads.map((x) => x.rows));
    expect(largest).toBeLessThanOrEqual(5);
  });

  it("MEASURED: the plans the two reads take, with and without an index on (mailbox_id, created_at)", async () => {
    const r = await seeded(5, { stored: 100, storedAt: t0, failedAt: new Date(t0.getTime() + 1_000), version: "build-1" });
    r.seen.reads.length = 0;
    await r.repo.writeOffRun(r.mailboxId, "build-1", 5, HOLD_EXEMPT_CODES);
    const newest = r.seen.reads.map((x) => x.sql).find((q) => /from "messages"/i.test(q))!;
    const plan = (q: string) => (r.raw.prepare(`EXPLAIN QUERY PLAN ${q}`).all(r.mailboxId, 1) as Array<{ detail: string }>)
      .map((p) => p.detail).join(" | ");
    const before = plan(newest);
    r.raw.exec(`CREATE INDEX "messages_mailbox_created_idx" ON "messages" ("mailbox_id", "created_at")`);
    const after = plan(newest);
    const failed = r.seen.reads.map((x) => x.sql).find((q) => /from "message_failures"/i.test(q))!;
    const failedPlan = (r.raw.prepare(`EXPLAIN QUERY PLAN ${failed}`).all(r.mailboxId, "build-1", "mime_too_large") as Array<{ detail: string }>)
      .map((p) => p.detail).join(" | ");
    expect({ before, after, failedPlan }).toEqual({
      before: "SEARCH messages USING INDEX sqlite_autoindex_messages_2 (mailbox_id=?) | USE TEMP B-TREE FOR ORDER BY",
      after: "SEARCH messages USING COVERING INDEX messages_mailbox_created_idx (mailbox_id=?)",
      failedPlan: "SEARCH message_failures USING INDEX sqlite_autoindex_message_failures_2 (mailbox_id=?) | USE TEMP B-TREE FOR ORDER BY",
    });
  });

  it.runIf(MEASURE)("MEASURE: rows read and time per call at three set sizes over a large store", async () => {
    const table: string[] = [];
    for (const n of [10, 1_000, 10_000]) {
      for (const indexed of [false, true]) {
        const r = await seeded(n, { stored: 10_000, storedAt: t0, failedAt: new Date(t0.getTime() + 1_000), version: "build-1" });
        if (indexed) r.raw.exec(`CREATE INDEX "messages_mailbox_created_idx" ON "messages" ("mailbox_id", "created_at")`);
        await r.repo.writeOffRun(r.mailboxId, "build-1", 5, HOLD_EXEMPT_CODES);
        r.seen.reads.length = 0;
        const runs = 20;
        const t = performance.now();
        for (let i = 0; i < runs; i++) await r.repo.writeOffRun(r.mailboxId, "build-1", 5, HOLD_EXEMPT_CODES);
        const ms = (performance.now() - t) / runs;
        const rows = r.seen.reads.slice(0, r.seen.reads.length / runs).map((x) => x.rows).join("+");
        table.push(`N=${n} index=${indexed} rows=${rows} ms=${ms.toFixed(2)}`);
      }
    }
    /* The bounded form a fix would take: the cap's newest write-offs by first_failed_at, rows <= cap. */
    const bounded = `SELECT first_failed_at FROM message_failures WHERE mailbox_id = ? AND resolved_at IS NULL
      ORDER BY first_failed_at DESC LIMIT 5`;
    for (const n of [10, 1_000, 10_000]) {
      for (const indexed of [false, true]) {
        const r = await seeded(n, { stored: 10_000, storedAt: t0, failedAt: new Date(t0.getTime() + 1_000), version: "build-1" });
        if (indexed) {
          r.raw.exec(`CREATE INDEX "message_failures_written_off_idx" ON "message_failures" ("mailbox_id", "first_failed_at") WHERE "resolved_at" IS NULL`);
        }
        const st = r.raw.prepare(bounded);
        const runs = 20;
        const t = performance.now();
        let rows = 0;
        for (let i = 0; i < runs; i++) rows = st.all(r.mailboxId).length;
        const plan = (r.raw.prepare(`EXPLAIN QUERY PLAN ${bounded}`).all(r.mailboxId) as Array<{ detail: string }>).map((x) => x.detail).join(" | ");
        table.push(`BOUNDED N=${n} index=${indexed} rows=${rows} ms=${((performance.now() - t) / runs).toFixed(3)} plan=${plan}`);
      }
    }
    console.log(`WRITE-OFF-RUN-MEASURE\n${table.join("\n")}`);
  });
});

describe.runIf(ON_DEVICE_STORE)("(C) a store fault on the phone after an outage", () => {
  const open: Sidecar[] = [];
  afterEach(async () => { while (open.length > 0) await open.pop()!.stop().catch(() => undefined); });

  it("the server answers again and the store refuses: the record follows the store, not the outage", async () => {
    const state = { deadSocket: false };
    const rig = inbox(1, new Set(), state);
    const ex = sqlExecutor();
    const p = await phone(rig.factory, ex.exec, open);
    await vi.waitFor(async () => { expect((await p.s.db.select({ id: messages.id }).from(messages)).length).toBe(1); },
      { timeout: 30_000, interval: 20 });
    const mailboxId = await p.id();
    const conn = () => p.s.connectionStates()[mailboxId]!;
    state.deadSocket = true;
    await vi.waitFor(() => { expect(conn().unreachableSince).toBeInstanceOf(Date); }, { timeout: 30_000, interval: 20 });
    const logins = rig.counts.logins;
    ex.seen.refuseWrites = true;
    state.deadSocket = false;
    await vi.waitFor(() => {
      expect(rig.counts.logins).toBeGreaterThan(logins);
      expect(conn().storeFaultSince).toBeInstanceOf(Date);
    }, { timeout: 40_000, interval: 50 });
    await new Promise((r) => setTimeout(r, 1_500));
    expect({ reachable: conn().reachable, outage: conn().unreachableSince !== null, storeFault: conn().storeFaultSince instanceof Date })
      .toEqual({ reachable: true, outage: false, storeFault: true });
  });

  it("CONTROL: a store fault on a live link is said by the hold's field and lowered by a committed write", async () => {
    const rig = inbox(1, new Set());
    const ex = sqlExecutor();
    const p = await phone(rig.factory, ex.exec, open);
    const mailboxId = await p.id();
    const conn = () => p.s.connectionStates()[mailboxId]!;
    await vi.waitFor(async () => { expect((await p.s.db.select({ id: messages.id }).from(messages)).length).toBe(1); },
      { timeout: 30_000, interval: 20 });
    const row = async () => {
      const res = await p.s.handle(new Request("http://local/mailboxes", { headers: { authorization: `Bearer ${p.s.sessionToken}` } }));
      const it = ((await res.json()) as { items: Array<{ id: string; status: string; errorCode: string | null; errorDetail?: string | null }> }).items
        .find((r) => r.id === mailboxId)!;
      return [it.status, it.errorCode, it.errorDetail ?? null];
    };
    expect(await row()).toEqual(["connected", null, null]);
    ex.seen.refuseWrites = true;
    await p.s.db.update(mailboxes).set({ lastSyncAt: null }).where(eq(mailboxes.id, mailboxId)).catch(() => undefined);
    await vi.waitFor(() => { expect(conn().storeFaultSince).toBeInstanceOf(Date); }, { timeout: 30_000, interval: 20 });
    expect(conn().reachable).toBe(true);
    // The desktop row's sentence keys on this detail: "This computer cannot store mail right now".
    expect(await row()).toEqual(["error", "storage", "MAILBOX_STORE_REFUSED"]);
    ex.seen.refuseWrites = false;
    await vi.waitFor(() => { expect(conn().storeFaultSince ?? null).toBeNull(); }, { timeout: 30_000, interval: 20 });
    expect(await row()).toEqual(["connected", null, null]);
  });
});
