import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, isNull, sql } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapCursor, MailboxAdapter, NativeLocator, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, LeasePeekIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { createLogger, storeFaultOf } from "@trafficflow/core/mail";
import {
  accounts, auditLog, changeLog, folderState, mailboxes, messageBodies, messageFailures, messages, threads,
} from "@trafficflow/db";
import { screenUnscreened, type ServiceContext } from "@trafficflow/services/mail";
import { classifyIngestFault, markStoreStatement, StoreStatementFaultError } from "@trafficflow/worker/dead-letter";
import { createSidecar, type Sidecar } from "../src/engine.js";
import {
  oneTransactionAtATime, openPhoneStore, STORE_TURN_WAIT, type PhoneSqlExecutor, type PhoneSqlRows,
} from "../src/mobile.js";

/**
 * A DEVICE-STORE FAULT IS THE DEVICE'S, WHATEVER ITS TEXT SAYS (REVIEW-02512 LOW 3). The phone's store
 * fails one message's write; a throw out of the store's own statement door is marked, and a marked
 * fault no structured field names as the message's is held, never written off, and shown as the
 * hold's sentence until the store commits a write. Bind refusals and a readable constraint stay the message's.
 * node:sqlite's shapes are captured from the real driver; expo's are rebuilt from expo-sqlite 57.0.1 /
 * expo-modules-core 57.0.8 sources (SQLExceptions.kt, NativeDatabaseBinding.cpp, CodedException.kt).
 */
vi.setConfig({ testTimeout: 60_000 });

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const ON_DEVICE_STORE = process.env.OHMAIL_EXPECT_DIALECT === "sqlite";

const rejected = "Call to function 'NativeStatement.executeAsync' has been rejected.\n→ Caused by: ";
const coded = (code: string, text: string) => Object.assign(new Error(rejected + text), { code });

/** node:sqlite on a closed handle — the real driver's own refusal, not a rebuilt one. */
function realClosedStore(): unknown {
  const db = new sqlite.DatabaseSync(":memory:");
  db.close();
  try { db.prepare("SELECT 1"); return null; } catch (e) { return e; }
}

/** node:sqlite refusing a value it cannot bind — the real driver's answer about the VALUE. */
function realBindRefusal(): unknown {
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (v)");
  try { db.prepare("INSERT INTO t VALUES (?)").run(undefined as never); return null; } catch (e) { return e; } finally { db.close(); }
}

/** The phone store's own refusal of a transaction that waited for its turn — the real function. */
async function realTransactionWaitRefusal(): Promise<unknown> {
  let release!: () => void;
  const handle = { transaction: (fn: () => Promise<unknown>) => fn() };
  oneTransactionAtATime(handle, 5);
  void handle.transaction(() => new Promise<void>((r) => { release = r; }));
  try { await handle.transaction(async () => undefined); return null; } catch (e) { return e; } finally { release(); }
}

const SHAPES: ReadonlyArray<readonly [string, () => unknown]> = [
  ["expo, prefix unreadable (exec path)", () => coded("ERR_INTERNAL_SQLITE_ERROR", "database or disk is full")],
  ["expo, closed handle or finalized statement", () => coded("ERR_ACCESS_CLOSED_RESOURCE", "Access to closed resource")],
  ["expo, a native Throwable (OutOfMemoryError)", () => coded("ERR_UNEXPECTED", "java.lang.OutOfMemoryError: Failed to allocate a 8388616 byte allocation")],
  ["node:sqlite, closed handle (real)", realClosedStore],
];
const READABLE = () => coded("ERR_INTERNAL_SQLITE_ERROR", "Error code \r: database or disk is full");
const CONSTRAINT = () => coded("ERR_INTERNAL_SQLITE_ERROR", "Error code \u0013: CHECK constraint failed: message_bodies_html_cap");
const HELD = { domain: "infrastructure" };

describe("the class a device-store fault gets", () => {
  it("CONTROL: the readable prefix is the store's, marked or not", () => {
    expect(storeFaultOf(READABLE())).toBe("full");
    expect(classifyIngestFault(READABLE())).toEqual(HELD);
    expect(classifyIngestFault(markStoreStatement("store.run", READABLE()))).toEqual(HELD);
  });

  it("the real shapes are what this file says they are", async () => {
    const closed = realClosedStore() as { code?: string; message?: string };
    expect([closed.code, closed.message]).toEqual(["ERR_INVALID_STATE", "database is not open"]);
    expect((realBindRefusal() as { code?: string }).code).toBe("ERR_INVALID_ARG_TYPE");
    const waited = await realTransactionWaitRefusal();
    expect(waited).toBeInstanceOf(StoreStatementFaultError);
    expect(((waited as Error).cause as Error).message).toMatch(/^this store allows one transaction at a time/);
  });

  for (const [label, shape] of SHAPES) {
    it(`${label}, out of the statement door, is the device's`, () => {
      expect(classifyIngestFault(markStoreStatement("store.run", shape()))).toEqual(HELD);
    });
  }

  it("the store's transaction-wait refusal (real) is the device's, marked where it is made", async () => {
    expect(classifyIngestFault(await realTransactionWaitRefusal())).toEqual(HELD);
  });

  it("the transaction-wait refusal names itself on its log line, and stays the device's", async () => {
    const refusal = await realTransactionWaitRefusal();
    const lines: string[] = [];
    createLogger({ service: "sidecar", sink: (l) => { lines.push(l); } }).error("sync_cycle_failed", { err: refusal });
    expect(JSON.parse(lines[0]!)).toMatchObject({ errorClass: "StoreStatementFaultError", causeCode: STORE_TURN_WAIT });
    expect(STORE_TURN_WAIT).toBe("store_turn_wait");
    expect(classifyIngestFault(refusal)).toEqual(HELD);
  });

  it("a SQLite refusal whose class did not survive is the store's, even unmarked", () => {
    expect(classifyIngestFault(SHAPES[0]![1]())).toEqual(HELD);
  });

  it("CONTROL: under the mark, the value's refusals stay the message's — a bind, a constraint, a SQLSTATE 23", () => {
    expect(classifyIngestFault(markStoreStatement("store.run", realBindRefusal())))
      .toEqual({ domain: "message", code: "unclassified", deterministic: false });
    expect(classifyIngestFault(markStoreStatement("store.run", CONSTRAINT())))
      .toEqual({ domain: "message", code: "constraint_violation", deterministic: false });
    const unique = markStoreStatement("store.tx.query",
      Object.assign(new Error("duplicate key"), { code: "23505", constraint: "mailboxes_active_address_uq" })) as Record<string, unknown>;
    expect(classifyIngestFault(unique)).toEqual({ domain: "message", code: "constraint_violation", deterministic: false });
    expect([unique.code, unique.constraint]).toEqual(["23505", "mailboxes_active_address_uq"]);
  });
});

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
  uidValidity(): number { return 4_260; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(installId)).map((c) => ({ ...c }));
  }
}

const eml = (subject: string): Buffer => Buffer.from([
  "From: Anna <anna@sender.test>", "To: owner@trafficflow.test", `Subject: ${subject}`,
  "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <${subject.replace(/ /g, "-")}@lane.test>`, "",
  `Body of ${subject}.`, "",
].join("\r\n"));

/** INBOX: uid 1 is the message whose write the store fails, uid 2 an ordinary one. */
function inbox(): () => MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo } {
  const meta = new MemoryMeta();
  const all = [[1, "the faulted one"], [2, "the ordinary one"]] as const;
  const create = (uid: number, subject: string) =>
    ({ type: "create" as const, locator: { folder: "INBOX", ref: `4260:${uid}` }, seen: false, raw: eml(subject) });
  return () => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: async () => meta.listClaims() }),
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(c: ImapCursor): Promise<ChangeBatch> {
      const known = new Set((c.folders.INBOX?.known ?? []).map((k) => k.uid));
      return {
        creates: all.filter(([u]) => !known.has(u)).map(([u, s]) => create(u, s)), moves: [], flagChanges: [], deletes: [],
        newCursor: { folders: { INBOX: { uidValidity: "4260", uidNext: 3, highestModseq: "0" } } },
      } as unknown as ChangeBatch;
    },
    async fetchByUid(_folder: string, uids: readonly number[]) {
      return { uidValidity: "4260", creates: all.filter(([u]) => uids.includes(u)).map(([u, s]) => create(u, s)), absent: [], oversize: [] } as never;
    },
    async move(_l: NativeLocator, toFolder: string): Promise<NativeLocator> { return { folder: toFolder, ref: "4260:9" }; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart in this rig"); },
    async send(): Promise<SendResult> { throw new Error("no send in this rig"); },
  });
}

/**
 * node:sqlite behind the phone's statement-runner contract, failing any statement that carries the faulted
 * message's subject while `faults` lasts — a store that has room for a small failure row and not for
 * one message's write, which is how a nearly full device behaves.
 */
/** A device's pace: `delayMs` per statement, and the most statements one transaction carried. */
interface Pace { delayMs: number; inTx: number; maxInTx: number; open: boolean }

function faultingExecutor(
  fault: () => unknown, faults: { left: number; marker?: string },
  pace: Pace = { delayMs: 0, inTx: 0, maxInTx: 0, open: false },
): PhoneSqlExecutor {
  const raw = new sqlite.DatabaseSync(":memory:");
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => T): Promise<T> => {
    const paced = async () => { if (pace.delayMs > 0) await new Promise((r) => setTimeout(r, pace.delayMs)); return job(); };
    const n = tail.then(paced, paced);
    tail = n.catch(() => undefined);
    return n;
  };
  const counted = (q: string) => {
    if (/^\s*begin/i.test(q)) { pace.open = true; pace.inTx = 0; } else if (/^\s*(commit|end|rollback)\s*;?\s*$/i.test(q)) {
      pace.open = false;
      pace.maxInTx = Math.max(pace.maxInTx, pace.inTx);
    } else if (pace.open) pace.inTx++;
  };
  const check = (params: readonly unknown[] | undefined) => {
    const marker = faults.marker ?? "the faulted one";
    if (faults.left > 0 && (params ?? []).some((p) => typeof p === "string" && p.includes(marker))) {
      faults.left--;
      throw fault();
    }
  };
  return {
    all: (sql, params): Promise<PhoneSqlRows> => serial(() => {
      counted(sql);
      check(params);
      const st = raw.prepare(sql);
      const columns = st.columns().map((c) => c.name);
      const objects = st.all(...(params as never[])) as Record<string, unknown>[];
      return { columns, rows: objects.map((o) => columns.map((c) => o[c])) };
    }),
    run: (sql, params) => serial(() => { counted(sql); check(params); raw.prepare(sql).run(...(params as never[])); }),
    batch: (statements) => serial(() => {
      raw.exec("BEGIN IMMEDIATE");
      try {
        for (const { sql, params = [] } of statements) { check(params); raw.prepare(sql).run(...(params as never[])); }
        raw.exec("COMMIT");
      } catch (err) {
        try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ }
        throw err;
      }
    }),
    close: async () => { try { raw.close(); } catch { /* already closed */ } },
  };
}

describe.runIf(ON_DEVICE_STORE)("one message's write fails on the phone's store", () => {
  const open: Sidecar[] = [];
  afterEach(async () => { while (open.length > 0) await open.pop()!.stop().catch(() => undefined); });

  async function phone(fault: () => unknown) {
    const faults = { left: 3 };
    const exec = faultingExecutor(fault, faults);
    const events: string[] = [];
    const s = await createSidecar({
      dataDir: "",
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "pw" } },
      address: "owner@trafficflow.test", machineName: "ohmail on a phone", installId: "install-store-fault",
      organizerKind: "mobile", pollIntervalMs: 40, keks: { 1: Buffer.alloc(32, 5) },
      adapterFactory: inbox(), store: async () => openPhoneStore(exec),
      log: (event) => { events.push(event); },
      logger: createLogger({ service: "sidecar", sink: (l) => { events.push((JSON.parse(l) as { event: string }).event); } }),
    });
    open.push(s);
    // What the phone's top line reads (organizer-session), sampled while the store refuses.
    const storeFault = () => Object.values(s.connectionStates()).some((c) => c.storeFaultSince instanceof Date);
    let shownWhileFaulting = false;
    const sampler = setInterval(() => { if (faults.left > 0 && storeFault()) shownWhileFaulting = true; }, 5);
    try {
      await s.db.update(mailboxes).set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
        .where(isNull(mailboxes.organizeConsentedAt));
      await s.start().catch(() => undefined);
      const drains = () => events.filter((e) => e === "sync_drain").length;
      await vi.waitFor(async () => {
        expect((await s.db.select({ subject: messages.subject }).from(messages)).map((r) => r.subject)).toContain("the ordinary one");
      }, { timeout: 30_000, interval: 20 });
      const settledFrom = drains();
      await vi.waitFor(() => { expect(drains()).toBeGreaterThan(settledFrom + 6); }, { timeout: 30_000, interval: 20 });
    } finally {
      clearInterval(sampler);
    }
    const stored = (await s.db.select({ subject: messages.subject }).from(messages)).map((r) => r.subject).sort();
    const failures = (await s.db.select({ code: messageFailures.code }).from(messageFailures)).map((r) => r.code);
    return {
      stored, failures, skipped: events.filter((e) => e === "sync_message_skipped").length,
      shownWhileFaulting, shownAfter: storeFault(),
    };
  }

  const HELD_THEN_STORED = {
    stored: ["the faulted one", "the ordinary one"], failures: [], skipped: 0, shownWhileFaulting: true, shownAfter: false,
  };

  it("CONTROL: the readable prefix is held and shown, never written off, and stored once the store recovers", async () => {
    expect(await phone(READABLE)).toEqual(HELD_THEN_STORED);
  });

  for (const [label, shape] of SHAPES.slice(0, 3)) {
    it(`${label}: held and shown, never written off, and stored once the store recovers`, async () => {
      expect(await phone(shape)).toEqual(HELD_THEN_STORED);
    });
  }

  it("CONTROL: a readable constraint the message carried is written off by the second drain", async () => {
    expect(await phone(CONSTRAINT)).toEqual({
      stored: ["the ordinary one"], failures: ["constraint_violation"], skipped: 1, shownWhileFaulting: false, shownAfter: false,
    });
  });

  it("CONTROL: a real bind refusal is the message's, written off by the second drain", async () => {
    expect(await phone(realBindRefusal)).toEqual({
      stored: ["the ordinary one"], failures: ["unclassified"], skipped: 1, shownWhileFaulting: false, shownAfter: false,
    });
  });
});

/** INBOX holds two messages; once `state.flag` is set, the server reports uid 2 read on every look. */
function flaggedInbox(state: { flag: boolean }): () => MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo } {
  const meta = new MemoryMeta();
  const all = [[1, "first one"], [2, "second one"]] as const;
  const create = (uid: number, subject: string) =>
    ({ type: "create" as const, locator: { folder: "INBOX", ref: `4260:${uid}` }, seen: false, raw: eml(subject) });
  return () => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: async () => meta.listClaims() }),
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(c: ImapCursor): Promise<ChangeBatch> {
      const known = new Set((c.folders.INBOX?.known ?? []).map((k) => k.uid));
      const flagChanges = state.flag ? [{ type: "flag" as const, locator: { folder: "INBOX", ref: "4260:2" }, seen: true }] : [];
      return {
        creates: all.filter(([u]) => !known.has(u)).map(([u, s]) => create(u, s)), moves: [], flagChanges, deletes: [],
        newCursor: { folders: { INBOX: { uidValidity: "4260", uidNext: 3, highestModseq: "0" } } },
      } as unknown as ChangeBatch;
    },
    async fetchByUid(_folder: string, uids: readonly number[]) {
      return { uidValidity: "4260", creates: all.filter(([u]) => uids.includes(u)).map(([u, s]) => create(u, s)), absent: [], oversize: [] } as never;
    },
    async move(_l: NativeLocator, toFolder: string): Promise<NativeLocator> { return { folder: toFolder, ref: "4260:9" }; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart in this rig"); },
    async send(): Promise<SendResult> { throw new Error("no send in this rig"); },
  });
}

/**
 * node:sqlite whose refusals are switched: `flagWrites` refuses that many `unread` updates (a write
 * the store has no room for), `writes` refuses every data write while reads answer (a full disk),
 * `closed` refuses every statement (a closed handle).
 */
function switchedExecutor(mode: { flagWrites: number; writes: boolean; closed: boolean }): PhoneSqlExecutor {
  const raw = new sqlite.DatabaseSync(":memory:");
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => T): Promise<T> => { const n = tail.then(job, job); tail = n.catch(() => undefined); return n; };
  const check = (sql: string) => {
    if (mode.closed) throw coded("ERR_ACCESS_CLOSED_RESOURCE", "Access to closed resource");
    if (mode.writes && /^\s*(insert|update|delete|replace)/i.test(sql)) throw READABLE();
    if (mode.flagWrites > 0 && /^update "messages" set "unread"/i.test(sql)) { mode.flagWrites--; throw READABLE(); }
  };
  return {
    all: (sql, params): Promise<PhoneSqlRows> => serial(() => {
      check(sql);
      const st = raw.prepare(sql);
      const columns = st.columns().map((c) => c.name);
      const objects = st.all(...(params as never[])) as Record<string, unknown>[];
      return { columns, rows: objects.map((o) => columns.map((c) => o[c])) };
    }),
    run: (sql, params) => serial(() => { check(sql); raw.prepare(sql).run(...(params as never[])); }),
    batch: (statements) => serial(() => {
      raw.exec("BEGIN IMMEDIATE");
      try {
        for (const { sql, params = [] } of statements) { check(sql); raw.prepare(sql).run(...(params as never[])); }
        raw.exec("COMMIT");
      } catch (err) { try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ } throw err; }
    }),
    close: async () => { try { raw.close(); } catch { /* already closed */ } },
  };
}

describe.runIf(ON_DEVICE_STORE)("the store's sentence stands exactly while the store refuses writes", () => {
  const open: Sidecar[] = [];
  afterEach(async () => { while (open.length > 0) await open.pop()!.stop().catch(() => undefined); });

  async function phone(mode: { flagWrites: number; writes: boolean; closed: boolean }, state: { flag: boolean }) {
    const events: string[] = [];
    const s = await createSidecar({
      dataDir: "",
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "pw" } },
      address: "owner@trafficflow.test", machineName: "ohmail on a phone", installId: "install-store-sentence",
      organizerKind: "mobile", pollIntervalMs: 40, keks: { 1: Buffer.alloc(32, 5) },
      adapterFactory: flaggedInbox(state), store: async () => openPhoneStore(switchedExecutor(mode)),
      log: (event) => { events.push(event); },
      logger: createLogger({ service: "sidecar", sink: (l) => { events.push((JSON.parse(l) as { event: string }).event); } }),
    });
    open.push(s);
    await s.db.update(mailboxes).set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    await s.start().catch(() => undefined);
    await vi.waitFor(async () => {
      expect((await s.db.select({ subject: messages.subject }).from(messages)).length).toBe(2);
    }, { timeout: 30_000, interval: 20 });
    const shown = () => Object.values(s.connectionStates()).some((c) => c.storeFaultSince instanceof Date);
    const count = (e: string) => events.filter((x) => x === e).length;
    const unread = async () => (await s.db.select({ subject: messages.subject, unread: messages.unread }).from(messages))
      .find((r) => r.subject === "second one")?.unread;
    return { s, shown, count, unread };
  }

  it("a fault on a FLAG write is lowered once the flag applies, with no new mail stored", async () => {
    const mode = { flagWrites: 0, writes: false, closed: false };
    const state = { flag: false };
    const p = await phone(mode, state);
    expect(p.shown()).toBe(false);
    mode.flagWrites = 2;
    state.flag = true;
    let shownWhileFaulting = false;
    await vi.waitFor(() => { if (p.shown()) shownWhileFaulting = true; expect(mode.flagWrites).toBe(0); }, { timeout: 30_000, interval: 5 });
    await vi.waitFor(async () => { expect(await p.unread()).toBe(false); }, { timeout: 30_000, interval: 20 });
    const from = p.count("sync_drain");
    await vi.waitFor(() => { expect(p.count("sync_drain")).toBeGreaterThan(from + 3); }, { timeout: 30_000, interval: 20 });
    expect({ shownWhileFaulting, storeFaultAfterRecovery: p.shown() }).toEqual({ shownWhileFaulting: true, storeFaultAfterRecovery: false });
  });

  it("CONTROL: a store that refuses every write and still reads keeps the sentence up while nothing commits", async () => {
    const mode = { flagWrites: 0, writes: false, closed: false };
    const state = { flag: false };
    const p = await phone(mode, state);
    mode.writes = true;
    state.flag = true;
    await vi.waitFor(() => { expect(p.shown()).toBe(true); }, { timeout: 30_000, interval: 10 });
    state.flag = false;   // nothing left to write; the drains that follow commit nothing
    const failed = p.count("sync_cycle_failed");
    const drains = p.count("sync_drain");
    let dropped = false;
    await vi.waitFor(() => {
      if (!p.shown()) dropped = true;
      expect(p.count("sync_cycle_failed") + p.count("sync_drain")).toBeGreaterThan(failed + drains + 5);
    }, { timeout: 30_000, interval: 5 });
    expect(dropped, "the sentence dropped while the store refused every write").toBe(false);
    mode.writes = false;
    state.flag = true;
    await vi.waitFor(async () => { expect(await p.unread()).toBe(false); }, { timeout: 30_000, interval: 20 });
    await vi.waitFor(() => { expect(p.shown()).toBe(false); }, { timeout: 30_000, interval: 20 });
  });

  it("a store that refuses EVERY statement shows the sentence from its first failed cycle", async () => {
    const mode = { flagWrites: 0, writes: false, closed: false };
    const state = { flag: false };
    const p = await phone(mode, state);
    const failed = p.count("sync_cycle_failed");
    mode.closed = true;
    state.flag = true;
    await vi.waitFor(() => { expect(p.count("sync_cycle_failed")).toBeGreaterThan(failed); }, { timeout: 30_000, interval: 2 });
    expect(p.shown(), "the first failed cycle on a closed store did not raise the sentence").toBe(true);
    mode.closed = false;
  });
});

describe.runIf(ON_DEVICE_STORE)("a transaction the store refused for its wait never runs", () => {
  it("through openPhoneStore: the refused body's write is never committed after its caller was told", async () => {
    const raw = new sqlite.DatabaseSync(":memory:");
    const exec: PhoneSqlExecutor = {
      all: async (q, params) => {
        const st = raw.prepare(q);
        const columns = st.columns().map((c) => c.name);
        const objects = st.all(...(params as never[])) as Record<string, unknown>[];
        return { columns, rows: objects.map((o) => columns.map((c) => o[c])) };
      },
      run: async (q, params) => { raw.prepare(q).run(...(params as never[])); },
      batch: async (statements) => {
        raw.exec("BEGIN IMMEDIATE");
        try { for (const { sql: q, params = [] } of statements) raw.prepare(q).run(...(params as never[])); raw.exec("COMMIT"); }
        catch (err) { try { raw.exec("ROLLBACK"); } catch { /* keep */ } throw err; }
      },
      close: async () => { try { raw.close(); } catch { /* closed */ } },
    };
    const opened = await openPhoneStore(exec, 50);
    raw.exec("CREATE TABLE refused_probe (v INTEGER)");
    const db = opened.db as unknown as { transaction: (fn: (tx: { run: (q: unknown) => Promise<unknown> }) => Promise<unknown>) => Promise<unknown> };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const outer = db.transaction(async (tx) => { await tx.run(sql`select 1`); await gate; });
    const refused = await db.transaction(async (tx) => { await tx.run(sql`insert into refused_probe values (1)`); })
      .then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(StoreStatementFaultError);
    release();
    await outer;
    await new Promise((r) => setTimeout(r, 100));
    expect((raw.prepare("SELECT count(*) AS n FROM refused_probe").get() as { n: number }).n).toBe(0);
    await opened.close?.().catch(() => undefined);
  });
});

/** An organizer mailbox with `count` Ohbox letters from `senders` strangers, seeded at full speed. */
async function organizerOhbox(db: unknown, count: number, senders: number) {
  const d = db as {
    insert: (t: unknown) => { values: (v: unknown) => { returning: () => Promise<{ id: string }[]> } };
    transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  };
  const [account] = await d.insert(accounts).values({ name: "screen-batch" }).returning();
  const accountId = account!.id;
  const [mailbox] = await d.insert(mailboxes).values({
    accountId, provider: "imap", address: "owner@fixtures.example", organizerRole: "organizer",
  }).returning();
  const ids: string[] = [];
  await d.transaction(async (raw) => {
    const tx = raw as typeof d;
    for (let i = 0; i < count; i++) {
      const [thread] = await tx.insert(threads).values({ accountId, subject: `t${i}` }).returning();
      const at = new Date(Date.now() - i * 3_600_000);
      const [m] = await tx.insert(messages).values({
        accountId, mailboxId: mailbox!.id, threadId: thread!.id, bodyHash: `h${i}`, dedupKey: `d${i}`,
        subject: `Note ${i}`, fromAddress: `p${i % senders}@people.example`, date: at, createdAt: at, arrivedAt: at,
        unread: false, messageIdHeader: `m${i}@batch.example`, nativeLocator: { folder: "INBOX", ref: `1:${i + 1}` },
      }).returning();
      ids.push(m!.id);
      await tx.insert(messageBodies).values({ messageId: m!.id, text: "body", html: null, headers: {} }).returning();
      await tx.insert(folderState).values({
        messageId: m!.id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "external",
        reconcileStatus: "reconciled", conflict: false,
      }).returning();
    }
  });
  return { accountId, mailboxId: mailbox!.id, ids };
}

type TxHandle = { transaction: (fn: (tx: { run: (q: unknown) => Promise<unknown> }) => Promise<unknown>) => Promise<unknown> };
const pressCtx = (db: unknown, accountId: string): ServiceContext =>
  ({ db, accountId, userId: null, now: () => new Date(), requestId: "screen-batch" }) as unknown as ServiceContext;

describe.runIf(ON_DEVICE_STORE)("a thousand-letter Screen press on a device-slow store", () => {
  it("a drain's transaction during the press is served, and the press holds its turn for a few statements", async () => {
    const pace: Pace = { delayMs: 0, inTx: 0, maxInTx: 0, open: false };
    const exec = faultingExecutor(() => new Error("unused"), { left: 0 }, pace);
    const opened = await openPhoneStore(exec, 3_000);
    const w = await organizerOhbox(opened.db, 1_000, 150);
    pace.delayMs = 2;
    pace.maxInTx = 0;
    const press = screenUnscreened(pressCtx(opened.routeDb, w.accountId));
    await new Promise((r) => setTimeout(r, 50));
    const drain = await (opened.ingestDb as unknown as TxHandle)
      .transaction(async (tx) => tx.run(sql`select 1`)).then(() => "served", (e: unknown) => e);
    const pressed = await press;
    const inPress = pace.maxInTx;
    expect({ drain, total: pressed.total }).toEqual({ drain: "served", total: 1_000 });
    expect(inPress).toBeLessThanOrEqual(40);
    await opened.close?.().catch(() => undefined);
  });

  it("CONTROL: a throw mid-press rolls the press back whole and the next transaction is served at once", async () => {
    const faults: { left: number; marker?: string } = { left: 0 };
    const exec = faultingExecutor(() => new Error("planted"), faults);
    const opened = await openPhoneStore(exec, 3_000);
    const w = await organizerOhbox(opened.db, 1_000, 150);
    faults.marker = [...w.ids].sort()[450]!;
    faults.left = 1;
    const failed = await screenUnscreened(pressCtx(opened.routeDb, w.accountId)).then(() => null, (e: unknown) => e);
    expect(failed).toBeInstanceOf(Error);
    const db = opened.db as unknown as { select: (f?: unknown) => { from: (t: unknown) => { where: (c: unknown) => Promise<unknown[]> } } };
    const left = {
      screened: (await db.select({ id: folderState.messageId }).from(folderState).where(eq(folderState.desiredFolder, "ohmail/Screener"))).length,
      moves: (await db.select({ seq: changeLog.seq }).from(changeLog).where(eq(changeLog.op, "move"))).length,
      audits: (await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.accountId, w.accountId))).length,
    };
    expect(left).toEqual({ screened: 0, moves: 0, audits: 0 });
    const t0 = Date.now();
    await (opened.ingestDb as unknown as TxHandle).transaction(async (tx) => tx.run(sql`select 1`));
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect((await screenUnscreened(pressCtx(opened.routeDb, w.accountId))).total).toBe(1_000);
    await opened.close?.().catch(() => undefined);
  });
});

describe.runIf(ON_DEVICE_STORE)("a transaction that holds the store past a waiter's wait names itself", () => {
  async function store() {
    const lines: Array<[string, Record<string, unknown>]> = [];
    const exec = faultingExecutor(() => new Error("unused"), { left: 0 });
    const opened = await openPhoneStore(exec, 50, undefined, undefined, (event, detail) => { lines.push([event, detail]); });
    return { opened, lines };
  }

  it("a route holder that refused an ingest waiter logs held, then released with how long it held", async () => {
    const { opened, lines } = await store();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const holder = (opened.routeDb as unknown as TxHandle).transaction(async (tx) => { await tx.run(sql`select 1`); await gate; });
    const waiter = await (opened.ingestDb as unknown as TxHandle).transaction(async () => undefined).then(() => null, (e: unknown) => e);
    expect(waiter).toBeInstanceOf(StoreStatementFaultError);
    release();
    await holder;
    expect(lines.map(([e, d]) => [e, d.kind, d.refused])).toEqual([
      ["store_turn_held", "route", 1], ["store_turn_released", "route", 1],
    ]);
    expect(lines[1]![1].elapsedMs).toBeGreaterThanOrEqual(50);
    await opened.close?.().catch(() => undefined);
  });

  it("CONTROL: a holder that refused no one logs nothing", async () => {
    const { opened, lines } = await store();
    await (opened.routeDb as unknown as TxHandle).transaction(async (tx) => { await tx.run(sql`select 1`); });
    await (opened.ingestDb as unknown as TxHandle).transaction(async (tx) => { await tx.run(sql`select 1`); });
    expect(lines).toEqual([]);
    await opened.close?.().catch(() => undefined);
  });
});
