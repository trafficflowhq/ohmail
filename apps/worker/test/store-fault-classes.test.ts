import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mailboxes, messageFailures, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { createLogger, UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runSyncCycle } from "@ohmail/organizer/sync";
import { classifyIngestFault, DatabaseFaultError, DeadLetterLedger } from "@ohmail/organizer/dead-letter";
import { FakeAdapterFleet } from "../../../packages/organizer/test/_fakeadapter.js";
import { markDatabaseFaults } from "../src/db-fault.js";
import { FIXTURE_LEASE } from "../../../packages/organizer/test/_door.js";

/**
 * A DEVICE STORE'S REFUSAL IS CLASSIFIED BY ITS SQLITE CLASS. expo-sqlite throws every one as
 * `ERR_INTERNAL_SQLITE_ERROR`, which read as "unclassified, the message's": with a ledger that
 * lasts, a full disk would then write off five messages a cycle. The store's own faults are
 * infrastructure and never written off; a value or constraint the message carried is its own.
 */
const expo = (code: string, words: string) =>
  Object.assign(new Error(`Call to function 'NativeStatement.runAsync' has been rejected.\n→ Caused by: Error code ${code}: ${words}`), { code: "ERR_INTERNAL_SQLITE_ERROR" });

function realFullDisk(): unknown {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (v BLOB)");
  const pages = Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
  db.exec(`PRAGMA max_page_count = ${pages + 2}`);
  try { db.prepare("INSERT INTO t VALUES (?)").run(new Uint8Array(1 << 20)); return null; } catch (e) { return e; } finally { db.close(); }
}

describe("classifyIngestFault over a device store's refusal", () => {
  it("the store's own conditions are infrastructure: full, busy, locked, read-only, corrupt", () => {
    for (const [code, words] of [["\r", "database or disk is full"], ["\u0005", "database is locked"], ["\u0006", "database table is locked"], ["\b", "attempt to write a readonly database"], ["\u000b", "database disk image is malformed"]] as const) {
      expect(classifyIngestFault(expo(code, words)), words).toEqual({ domain: "infrastructure" });
    }
  });

  it("a REAL full disk from SQLite itself is infrastructure, wrapped in the repo's origin tag or not", () => {
    const err = realFullDisk() as { code?: string; errcode?: number };
    expect([err.code, err.errcode]).toEqual(["ERR_SQLITE_ERROR", 13]);
    expect(classifyIngestFault(err)).toEqual({ domain: "infrastructure" });
    expect(classifyIngestFault(new DatabaseFaultError("repo.insertMessage", err))).toEqual({ domain: "infrastructure" });
  });

  it("what the message carried is the message's: constraint retried, too big and a mismatch deterministic", () => {
    expect(classifyIngestFault(expo("\u0013", "CHECK constraint failed: message_bodies_html_cap")))
      .toEqual({ domain: "message", code: "constraint_violation", deterministic: false });
    expect(classifyIngestFault(expo("\u0012", "string or blob too big")))
      .toEqual({ domain: "message", code: "data_too_large", deterministic: true });
    expect(classifyIngestFault(expo("\u0014", "datatype mismatch")))
      .toEqual({ domain: "message", code: "data_exception", deterministic: true });
  });

  it("a class SQLite named that is no value's — format, notfound, empty, or none that survived — is the store's", () => {
    for (const code of ["24", "\u000c", "\u0010"]) {
      expect(classifyIngestFault(expo(code, "auxiliary database format error")), code).toEqual({ domain: "infrastructure" });
    }
    expect(classifyIngestFault(Object.assign(new Error("database or disk is full"), { code: "ERR_INTERNAL_SQLITE_ERROR" })))
      .toEqual({ domain: "infrastructure" });
  });

  it("CONTROL: the hosted worker's classes do not move — its repo's tag is not the store's mark", async () => {
    const thrownBy = async (cause: unknown) => {
      const repo = markDatabaseFaults({ insertMessage: async () => { throw cause; } }, "repo");
      return repo.insertMessage().then(() => null, (e: unknown) => e);
    };
    expect(classifyIngestFault(await thrownBy(Object.assign(new Error("auxiliary database format error"), { code: "XX000" }))))
      .toEqual({ domain: "infrastructure" });
    expect(classifyIngestFault(await thrownBy(new TypeError("a pipeline defect"))))
      .toEqual({ domain: "message", code: "unclassified", deterministic: false });
  });

  it("the store's own refusal stays through a cycle that stores nothing, and a stored message lowers it", () => {
    const ledger = new DeadLetterLedger({ holdAtCap: true });
    expect(ledger.storeFaultSince).toBeNull();
    const at = new Date("2026-10-04T05:00:00Z");
    ledger.noteStoreFault(at);
    ledger.noteStoreFault(new Date("2026-10-04T06:00:00Z"));
    ledger.beginCycle();
    ledger.hydrateRun({ count: 0, heldSince: null });
    expect(ledger.storeFaultSince).toEqual(at);
    ledger.noteStored();
    expect(ledger.storeFaultSince).toBeNull();
  });

  it("our own statement or driver is infrastructure: ERROR, INTERNAL, MISUSE (classes 25 and XX's reading)", () => {
    for (const [code, words] of [["\u0001", "no such column: x"], ["\u0001", "cannot start a transaction within a transaction"], ["\u0002", "internal error"], ["\u0015", "bad parameter or other API misuse"]] as const) {
      expect(classifyIngestFault(expo(code, words)), words).toEqual({ domain: "infrastructure" });
    }
  });
});

/** INBOX holds one message whose insert the store refuses with `refusal`, and one ordinary message. */
async function world(refusal: () => unknown) {
  const ACCOUNT = "00000000-0000-4000-8000-0000000f0263";
  const db = (await makeTestDb()) as unknown as Tx;
  const [mb] = await db.insert(mailboxes).values({ accountId: ACCOUNT, provider: "imap", address: `s-${randomUUID().slice(0, 8)}@example.test` }).returning();
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory({ host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId: ACCOUNT, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials */ } });
  fleet.behave(mb!.id, { deliver: [
    { from: "anna@example.com", subject: "the refused one", messageId: "refused@lane.test" },
    { from: "anna@example.com", subject: "the ordinary one", messageId: "ordinary@lane.test" },
  ] });
  const inner = makeDrizzleRepo(db as never);
  const refuse = (r: object): object => new Proxy(r, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv) as unknown;
      if (prop === "insertMessage") {
        return async (row: { subject?: string | null }, ...rest: unknown[]) => {
          if (String(row.subject ?? "").includes("refused")) throw refusal();
          return (v as (...a: unknown[]) => unknown).call(t, row, ...rest);
        };
      }
      if (prop === "transaction" && typeof v === "function") {
        return (fn: (x: object) => Promise<unknown>) => (v as (f: (x: object) => Promise<unknown>) => unknown).call(t, (x) => fn(refuse(x)));
      }
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  const repo = refuse(inner) as typeof inner;
  const lines: string[] = [];
  const cycle = (deadLetters?: DeadLetterLedger) => runSyncCycle({
    writeAuthority: FIXTURE_LEASE, repo, adapter, accountId: ACCOUNT, mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP,
    role: "organizer", trustedAuthservIds: new Set<string>(), log: createLogger({ service: "worker", sink: (l) => { lines.push(l); } }),
    ...(deadLetters ? { deadLetters } : {}),
  }).then(() => "served", () => "failed");
  const stored = async () => (await db.select({ subject: messages.subject }).from(messages)).map((r) => r.subject).sort();
  const failures = async () => (await db.select({ code: messageFailures.code }).from(messageFailures)).map((r) => r.code);
  const events = () => lines.map((l) => JSON.parse(l) as { event: string; storeFault?: string }).map((l) => `${l.event}${l.storeFault ? `:${l.storeFault}` : ""}`);
  return { cycle, stored, failures, events };
}

describe("one ledger across cycles, over a refusal from the store", () => {
  it("a constraint the message carried is written off by the second cycle, and the cursor crosses it", async () => {
    const w = await world(() => expo("\u0013", "CHECK constraint failed: message_bodies_html_cap"));
    const ledger = new DeadLetterLedger();
    expect(await w.cycle(ledger)).toBe("failed");
    expect(await w.cycle(ledger)).toBe("served");
    expect(await w.cycle(ledger)).toBe("served");
    expect(await w.stored()).toEqual(["the ordinary one"]);
    expect(await w.failures()).toEqual(["constraint_violation"]);
    expect(w.events().filter((e) => e.startsWith("sync_message_"))).toEqual([
      "sync_message_deferred:constraint", "sync_message_skipped:constraint",
    ]);
  });

  it("CONTROL: a fresh ledger every cycle — the composition the local engine had — never writes it off", async () => {
    const w = await world(() => expo("\u0013", "CHECK constraint failed: message_bodies_html_cap"));
    for (let i = 0; i < 3; i++) expect(await w.cycle()).toBe("failed");
    expect(await w.failures()).toEqual([]);
  });

  it("a full disk is never written off: every cycle fails, nothing is recorded against the message", async () => {
    const w = await world(() => expo("\r", "database or disk is full"));
    const ledger = new DeadLetterLedger();
    for (let i = 0; i < 4; i++) expect(await w.cycle(ledger)).toBe("failed");
    expect(await w.failures()).toEqual([]);
    expect(ledger.entries().filter((e) => e.terminal)).toEqual([]);
    expect(w.events().filter((e) => e.startsWith("sync_message_"))).toEqual([]);
  });
});
