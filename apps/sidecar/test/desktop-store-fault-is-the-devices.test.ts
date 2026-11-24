import { rmSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isNull, sql } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapCursor, MailboxAdapter, NativeLocator, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, LeasePeekIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { createLogger } from "@trafficflow/core/mail";
import { mailboxes, messageFailures, messages } from "@trafficflow/db";
import { StoreStatementFaultError } from "@ohmail/organizer/dead-letter";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { markStoreStatements } from "../src/db.js";
import { statementKind } from "../src/store-writes.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 3 });

/**
 * THE DESKTOP'S STORE FAULT IS THE DEVICE'S TOO. The ingest write runs on the TRANSACTION handle PGlite
 * gives the callback, so the fault is planted beneath every wrapper the store installs: that handle's
 * `query` answers PGlite's own uncoded "PGlite is closed" for one message. The message is held, never
 * written off, the mailbox list says `storage` while it lasts and stops once that message stores.
 */
const BASE = Object.getPrototypeOf(PGlite.prototype) as { transaction: (cb: (tx: object) => Promise<unknown>) => Promise<unknown> };
const realTransaction = BASE.transaction;
const fault = { on: false, hits: 0 };
beforeAll(() => {
  BASE.transaction = function planted(this: unknown, cb: (tx: object) => Promise<unknown>) {
    return realTransaction.call(this, (tx: object) => cb(new Proxy(tx, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== "query" || typeof value !== "function") return value;
        return (text: string, params?: unknown[], ...rest: unknown[]) => {
          if (fault.on && (params ?? []).some((p) => typeof p === "string" && p.includes("the faulted one"))) {
            fault.hits++;
            return Promise.reject(new Error("PGlite is closed"));
          }
          return (value as (...a: unknown[]) => unknown).call(target, text, params, ...rest);
        };
      },
    })));
  };
});
afterAll(() => { BASE.transaction = realTransaction; });

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
  uidValidity(): number { return 4_270; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(installId)).map((c) => ({ ...c }));
  }
}

const eml = (subject: string): Buffer => Buffer.from([
  "From: Anna <anna@sender.test>", "To: owner@trafficflow.test", `Subject: ${subject}`,
  "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <${subject.replace(/ /g, "-")}@lane.test>`, "",
  `Body of ${subject}.`, "",
].join("\r\n"));

function inbox(): () => MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo } {
  const meta = new MemoryMeta();
  const all = [[1, "the faulted one"], [2, "the ordinary one"]] as const;
  const create = (uid: number, subject: string) =>
    ({ type: "create" as const, locator: { folder: "INBOX", ref: `4270:${uid}` }, seen: false, raw: eml(subject) });
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
        newCursor: { folders: { INBOX: { uidValidity: "4270", uidNext: 3, highestModseq: "0" } } },
      } as unknown as ChangeBatch;
    },
    async fetchByUid(_folder: string, uids: readonly number[]) {
      return { uidValidity: "4270", creates: all.filter(([u]) => uids.includes(u)).map(([u, s]) => create(u, s)), absent: [], oversize: [] } as never;
    },
    async move(_l: NativeLocator, toFolder: string): Promise<NativeLocator> { return { folder: toFolder, ref: "4270:9" }; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart in this rig"); },
    async send(): Promise<SendResult> { throw new Error("no send in this rig"); },
  });
}

describe("one message's write fails on the desktop's store", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { fault.on = false; fault.hits = 0; for (const c of cleanups.splice(0).reverse()) await c(); });

  async function boot(): Promise<{ s: Sidecar; events: string[]; listed: () => Promise<Array<[string, string | null]>> }> {
    const dir = await freshDataDir("ohmail-desktop-store-fault-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const events: string[] = [];
    const s = await createSidecar({
      dataDir: dir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "pw" } },
      address: "owner@trafficflow.test", machineName: "the machine under test",
      pollIntervalMs: 40, leaseStaleAfterMs: 60_000, keks: { 1: Buffer.alloc(32, 6) },
      adapterFactory: inbox(),
      log: (event) => { events.push(event); },
      logger: createLogger({ service: "sidecar", sink: (line) => { events.push((JSON.parse(line) as { event: string }).event); } }),
    });
    cleanups.push(async () => { await s.stop().catch(() => undefined); });
    await s.db.update(mailboxes).set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    const listed = async () => {
      const res = await s.handle(new Request("http://local/mailboxes", { headers: { authorization: `Bearer ${s.sessionToken}` } }));
      return ((await res.json()) as { items: Array<{ status: string; errorCode: string | null }> }).items
        .map((r): [string, string | null] => [r.status, r.errorCode]);
    };
    return { s, events, listed };
  }

  it("is held and said as storage while the store refuses, never written off, and stored once it answers", async () => {
    fault.on = true;
    const { s, events, listed } = await boot();
    await s.start().catch(() => undefined);
    await vi.waitFor(async () => { expect(await listed()).toEqual([["error", "storage"]]); }, { timeout: 30_000, interval: 25 });
    const drains = () => events.filter((e) => e === "sync_drain" || e === "sync_cycle_failed").length;
    const from = drains();
    await vi.waitFor(() => { expect(drains()).toBeGreaterThan(from + 6); }, { timeout: 30_000, interval: 25 });
    expect(fault.hits).toBeGreaterThan(2);
    expect(await listed()).toEqual([["error", "storage"]]);
    expect((await s.db.select({ code: messageFailures.code }).from(messageFailures)).length).toBe(0);
    expect(events.filter((e) => e === "sync_message_skipped").length).toBe(0);

    fault.on = false;
    await vi.waitFor(async () => {
      expect((await s.db.select({ subject: messages.subject }).from(messages)).map((r) => r.subject).sort())
        .toEqual(["the faulted one", "the ordinary one"]);
    }, { timeout: 30_000, interval: 25 });
    await vi.waitFor(async () => { expect((await listed())[0]![1]).not.toBe("storage"); }, { timeout: 10_000, interval: 25 });
    expect((await s.db.select({ code: messageFailures.code }).from(messageFailures)).length).toBe(0);
  });

  it("every transaction is marked whatever lane it runs in; a body's own throw is not", async () => {
    const { s } = await boot();
    const outside = await s.db.execute(sql`select 1/0`).then(() => null, (e: unknown) => e);
    expect(outside).toBeInstanceOf(StoreStatementFaultError);
    expect((outside as { code?: string }).code).toBe("22012");
    const inside = await s.db.transaction(async (tx) => { await tx.execute(sql`select 1/0`); }).then(() => null, (e: unknown) => e);
    expect(inside).toBeInstanceOf(StoreStatementFaultError);
    const mine = new Error("the pipeline's own");
    const body = await s.db.transaction(async () => { throw mine; }).then(() => null, (e: unknown) => e);
    expect(body).toBe(mine);
  });
});

describe("the desktop store's committed-write gauge", () => {
  it("counts a write that committed, on the client or by its transaction, and never a read or a refusal", async () => {
    const client = new PGlite();
    await client.exec("CREATE TABLE g (v int PRIMARY KEY)");
    const { storeWrites } = markStoreStatements(client);
    const at = () => storeWrites();
    await client.query("select 1");
    expect(at(), "a read").toBe(0);
    await client.query("insert into g values ($1)", [1]);
    expect(at(), "an autocommitted insert").toBe(1);
    await client.transaction(async (tx) => { await tx.query("select v from g"); });
    expect(at(), "a transaction that only read").toBe(1);
    await client.transaction(async (tx) => { await tx.query("update g set v = 2 where v = 1"); });
    expect(at(), "a transaction that wrote and committed").toBe(2);
    await client.query("insert into g values (2)").catch(() => undefined);
    expect(at(), "a refused insert").toBe(2);
    await client.transaction(async (tx) => { await tx.query("insert into g values (3)"); throw new Error("the body's own"); }).catch(() => undefined);
    expect(at(), "a transaction rolled back by its body").toBe(2);
    await client.exec("select 1; delete from g where v = 3");
    expect(at(), "an exec text with a write in it").toBe(3);
    await client.close();
  });

  it("classifies a statement by its first keyword", () => {
    expect(["insert into x values (1)", "  /* c */ update x set a = 1", "-- c\ndelete from x", "WITH a AS (select 1) insert into x select * from a",
      "select * from x for update", "begin", "commit", "rollback", "rollback to savepoint s", "pragma foreign_keys", "savepoint s"]
      .map(statementKind))
      .toEqual(["write", "write", "write", "write", "other", "begin", "commit", "rollback", "other", "other", "other"]);
  });
});
