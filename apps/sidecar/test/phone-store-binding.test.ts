/**
 * WHOM THE PHONE'S HANDLES ACT FOR, on the store a device carries.
 *
 * The phone opens three handles over its one file: the engine's own, the drain's and the app's
 * door, which is served committed rows only. A request is minted over that third one, so this
 * reads all three (`_handle-readings.ts`) on the composition a phone runs: `createSidecar` over
 * `openPhoneStore`, claiming as a phone.
 *
 * It runs under the SQLite project, which substitutes the device's schema; the default run states
 * that premise instead of passing by contributing nothing.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isNull } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, MailboxAdapter, NativeLocator, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { mailboxes } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { openPhoneStore, type PhoneSqlExecutor, type PhoneSqlRows } from "../src/mobile.js";
import { readHandles, type HandleReadings, type Readings } from "./_handle-readings.js";

vi.setConfig({ testTimeout: 60_000 });

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const EXPECTED_DIALECT = process.env.OHMAIL_EXPECT_DIALECT;
const ON_DEVICE_STORE = EXPECTED_DIALECT === "sqlite";

/** `node:sqlite` behind the phone's statement-runner contract. */
function sqliteRunner(): PhoneSqlExecutor {
  const raw = new sqlite.DatabaseSync(":memory:");
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => T): Promise<T> => { const n = tail.then(job, job); tail = n.catch(() => undefined); return n; };
  return {
    all: (sql, params): Promise<PhoneSqlRows> => serial(() => {
      const st = raw.prepare(sql);
      const columns = st.columns().map((c) => c.name);
      const objects = st.all(...(params as never[])) as Record<string, unknown>[];
      return { columns, rows: columns.length > 0 ? objects.map((o) => columns.map((c) => o[c])) : objects.map((o) => Object.values(o)) };
    }),
    run: (sql, params) => serial(() => { raw.prepare(sql).run(...(params as never[])); }),
    batch: (statements) => serial(() => {
      raw.exec("BEGIN IMMEDIATE");
      try { for (const { sql, params = [] } of statements) raw.prepare(sql).run(...(params as never[])); raw.exec("COMMIT"); }
      catch (err) { try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ } throw err; }
    }),
    close: () => serial(() => { try { raw.close(); } catch { /* closed */ } }),
  };
}

class MetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number { return 4_100; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[]> {
    return this.claims.filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`));
  }
}

const EMPTY: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };

/** A mail server that takes the login and holds no mail. */
function mailServer(): () => MailboxAdapter {
  const meta = new MetaFolder();
  return (): MailboxAdapter => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...EMPTY }; },
    async move(locator: NativeLocator): Promise<NativeLocator> { return locator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox holds no part"); },
    async send(): Promise<SendResult> { throw new Error("nothing is sent here"); },
  }) as unknown as MailboxAdapter;
}

const open: Sidecar[] = [];
afterEach(async () => { for (const s of open.splice(0)) await s.stop().catch(() => undefined); });

interface Phone {
  sidecar: Sidecar;
  account: string;
  /** The engine's own handle, the drain's, and the app's door to the store. */
  engine: HandleReadings;
  drain: HandleReadings;
  door: HandleReadings;
}

async function phone(): Promise<Phone> {
  const read: Partial<Pick<Phone, "engine" | "drain" | "door">> = {};
  const sidecar = await createSidecar({
    dataDir: "",
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "pw" } },
    address: "owner@trafficflow.test", machineName: "ohmail on a phone", installId: "install-store-binding",
    organizerKind: "mobile", pollIntervalMs: 60 * 60_000, keks: { 1: Buffer.alloc(32, 5) },
    adapterFactory: mailServer(), dkimKeys: null,
    store: async () => {
      const opened = await openPhoneStore(sqliteRunner());
      read.engine = readHandles(opened.db);
      read.drain = readHandles(opened.ingestDb!);
      read.door = readHandles(opened.routeDb!);
      return opened;
    },
  });
  open.push(sidecar);
  await sidecar.db.update(mailboxes)
    .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
    .where(isNull(mailboxes.organizeConsentedAt));
  return { sidecar, account: sidecar.world.accountId, engine: read.engine!, drain: read.drain!, door: read.door! };
}

const whoRode = (reads: Readings): string[] => [...new Set(reads.all.map((r) => r.rode))].sort();

describe("this file's premise, in the run that cannot exercise it", () => {
  it.runIf(!ON_DEVICE_STORE)("states it, so it cannot pass here by contributing nothing", () => {
    expect(EXPECTED_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE)("a request on the phone's store", () => {
  it("rides the app's own door to the store under its session's account, after a look-up under a key", async () => {
    const p = await phone();
    const headers = { authorization: `Bearer ${p.sidecar.sessionToken}`, "content-type": "application/json" };
    for (const reads of [p.engine, p.drain, p.door]) reads.clear();

    // No session is asked of the health door: its probe rides the app's door, bound to nothing.
    const health = await p.sidecar.handle(new Request("http://engine.invalid/health"));
    expect(health.status).toBe(200);
    const probe = p.door.take();
    expect(probe.all.length, "the health door asked the store nothing").toBeGreaterThan(0);
    expect(whoRode(probe)).toEqual(["nothing"]);

    const res = await p.sidecar.handle(new Request("http://engine.invalid/mailboxes", { headers }));
    expect(res.status, await res.clone().text()).toBe(200);
    const door = p.door.take();
    const [lookup, ...after] = door.all;
    expect(lookup, "the session's look-up").toEqual({
      verb: "select", table: "sessions", rode: "keyed", inTransaction: false,
    });
    expect(after.length, "the route asked the store nothing through its door").toBeGreaterThan(3);
    expect([...new Set(after.map((r) => r.rode))], "what the route and its services asked").toEqual([p.account]);

    // A write under a key: the pipeline looks the key up on the request's own handle.
    const created = await p.sidecar.handle(new Request("http://engine.invalid/drafts", {
      method: "POST", headers: { ...headers, "idempotency-key": randomUUID() },
      body: JSON.stringify({
        mailboxId: p.sidecar.world.mailboxId, subject: "a letter", body: "The words.", to: [{ name: null, address: "you@example.com" }],
      }),
    }));
    expect(created.status, await created.clone().text()).toBe(201);
    expect(p.door.take().rodeOf("idempotency_keys"), "the request's own handle").toEqual([p.account]);
    // Nothing of these requests rode the engine's own handle or the drain's under an account.
    expect(whoRode(p.engine.take()).filter((r) => r !== "plain")).toEqual([]);
    expect(whoRode(p.drain.take()).filter((r) => r !== "plain")).toEqual([]);
  });
});

describe.runIf(ON_DEVICE_STORE)("one cycle on the phone's store", () => {
  it("walks its passes on a handle that names no account, reads its owed copies under the world's, and organizes on the store's own handles", async () => {
    const p = await phone();
    for (const reads of [p.engine, p.drain, p.door]) reads.clear();

    await p.sidecar.syncUntilQuiet();
    const engine = p.engine.take();
    const drain = p.drain.take();

    expect(engine.rodeOf("away_responders"), "the away answers' walk").toEqual(["nothing"]);
    expect(engine.rodeOf("outbound_sends"), "the reconciler's walk").toEqual(["nothing"]);
    expect(engine.rodeOf("outbound_sent_copies"), "the owed copies' read").toEqual([p.account]);
    for (const table of ["folder_state", "organizer_requests", "message_failures"]) {
      expect([...new Set([...engine.rodeOf(table), ...drain.rodeOf(table)])], table).toEqual(["plain"]);
    }
    expect(whoRode(drain), "the drain's own handle carries no binding").toEqual(["plain"]);
    expect(whoRode(engine).filter((r) => !["plain", "nothing", "keyed"].includes(r)), "no other account").toEqual([p.account]);
  });
});
