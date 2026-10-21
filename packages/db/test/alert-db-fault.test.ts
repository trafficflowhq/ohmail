import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import postgres from "postgres";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/postgres-js";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { schema } from "../src/schema.js";
import { makePooledDb } from "../src/client.js";
import { makeTestDb } from "../src/testing.js";
import { sql } from "drizzle-orm";
import { NotContentBlindError } from "../src/admin-db.js";
import { evaluateAlerts, runAlertPass, type AlertSink } from "../src/alerts.js";
import {
  AlertDatabaseReadError, ALERT_DB_DEADLINE_CODE, ALERT_DB_EVALUATE_MS, ALERT_DB_FIRST_READ_MS,
  evaluationUnderDeadline, isAlertDatabaseUnreadable, readAlertDatabase,
} from "../src/alert-db-fault.js";
import type { Tx } from "../src/change-log.js";

/**
 * What the last-resort page may call "the database is gone or unusable": classified by class and
 * code down the cause chain, never by message text, and measured against the real (patched)
 * postgres.js on loopback and a read-only PGlite rather than only hand-built errors. A refused port
 * is a bare ECONNREFUSED, the same code a dead IMAP host gives, so it counts only when the error
 * came out of a read the pass tagged; a SQLSTATE only a failing server returns counts anywhere.
 */

const servers: net.Server[] = [];
const clients: Array<{ end: (o?: { timeout?: number }) => Promise<void> }> = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.end({ timeout: 0 }).catch(() => undefined);
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.close(() => r()); });
});

/** A port nothing listens on: bind, read the port, close. */
async function refusedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** A server that accepts and then never says a word; or accepts and closes at once. */
async function server(mode: "silent" | "close"): Promise<number> {
  const live = new Set<net.Socket>();
  const s = net.createServer((sock) => {
    live.add(sock);
    sock.on("error", () => undefined);
    sock.on("close", () => live.delete(sock));
    if (mode === "close") sock.destroy();
  });
  const close = s.close.bind(s);
  s.close = ((cb?: (err?: Error) => void) => { for (const k of live) k.destroy(); return close(cb); }) as typeof s.close;
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  servers.push(s);
  return (s.address() as net.AddressInfo).port;
}

const urlOf = (port: number): string => `postgres://u:p@127.0.0.1:${port}/x`;

function client(port: number, opts: { connect_timeout?: number } = {}) {
  const c = postgres(urlOf(port), { max: 1, connect_timeout: opts.connect_timeout ?? 2, onnotice: () => undefined });
  clients.push(c);
  return c;
}

async function failureOf(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (err) { return err; }
  throw new Error("expected a failure");
}

describe("a refused port: only a tagged read counts", () => {
  it("ECONNREFUSED is the database when the pass tagged the read, and nothing otherwise", async () => {
    const c = client(await refusedPort());
    const raw = await failureOf(c`select 1`);
    expect((raw as { code?: string }).code).toBe("ECONNREFUSED");
    expect(isAlertDatabaseUnreadable(raw), "a bare socket code could be any host").toBe(false);
    const tagged = await failureOf(readAlertDatabase("preflight", () => c`select 1`, 5_000));
    expect(tagged).toBeInstanceOf(AlertDatabaseReadError);
    expect((tagged as AlertDatabaseReadError).code).toBe("ECONNREFUSED");
    expect(isAlertDatabaseUnreadable(tagged)).toBe(true);
  });
});

describe("a server that accepts and never answers", () => {
  it("is CONNECT_TIMEOUT, the database's own code, tagged or not", async () => {
    const c = client(await server("silent"), { connect_timeout: 1 });
    const raw = await failureOf(c`select 1`);
    expect((raw as { code?: string }).code).toBe("CONNECT_TIMEOUT");
    expect(isAlertDatabaseUnreadable(raw)).toBe(true);
  });
});

describe("a server that accepts and closes at once", () => {
  it("the pass ends at its first-read deadline, and the abandoned query rejects nowhere", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const c = client(await server("close"));
      const db = drizzle(c, { schema }) as unknown as Tx;
      const started = Date.now();
      const err = await failureOf(runAlertPass(db, { driver: "worker", shards: [], sinks: [], firstReadMs: 300 }));
      expect(Date.now() - started, "bounded by the deadline, not the driver").toBeLessThan(2_000);
      expect(err).toBeInstanceOf(AlertDatabaseReadError);
      expect((err as AlertDatabaseReadError).code).toBe(ALERT_DB_DEADLINE_CODE);
      expect((err as AlertDatabaseReadError).op).toBe("preflight");
      expect(isAlertDatabaseUnreadable(err)).toBe(true);
      // The server goes away and the query the deadline abandoned rejects: nobody may be left unhandled.
      for (const s of servers.splice(0)) await new Promise<void>((r) => { s.close(() => r()); });
      await c.end({ timeout: 0 }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("the pooled handle's acquire ceiling", () => {
  it("a second statement behind a silent server is db_acquire_timeout, the database's own code", async () => {
    const port = await server("silent");
    const db = makePooledDb(urlOf(port), { acquireTimeoutMs: 200, max: 1 });
    const first = failureOf(db.execute(sql`select 1`));
    const second = await failureOf(db.execute(sql`select 2`));
    expect((second as { code?: string }).code).toBe("db_acquire_timeout");
    expect(isAlertDatabaseUnreadable(second)).toBe(true);
    for (const s of servers.splice(0)) await new Promise<void>((r) => { s.close(() => r()); });
    await first;
  }, 20_000);
});

const coded = (code: string): Error => Object.assign(new Error("x"), { code });

describe("codes, untagged", () => {
  it.each(["57P01", "53300", "08006", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED"])(
    "%s is the database", (code) => {
      expect(isAlertDatabaseUnreadable(coded(code))).toBe(true);
    },
  );

  // A database that answers and cannot do the pass's work: read-only (25006), out of resources
  // (class 53: disk, memory, connections), stopped or cut short by an operator or a timeout
  // (class 57, 57014 a statement timeout), a system or I/O error (class 58), an internal error
  // (XX000-XX002). Only a database server returns these.
  it.each([
    "25006", "53000", "53100", "53200", "53400", "57000", "57014", "57P04", "57P05",
    "58000", "58030", "58P01", "XX000", "XX001", "XX002",
  ])("%s is the database", (code) => {
    expect(isAlertDatabaseUnreadable(coded(code))).toBe(true);
  });

  it("an application fault is not", () => {
    expect(isAlertDatabaseUnreadable(coded("42703"))).toBe(false);
    expect(isAlertDatabaseUnreadable(coded("23505"))).toBe(false);
    // The rest of class 25, and a serialization failure or a lock timeout: the pass's, not the server's.
    for (const code of ["25001", "25P02", "40001", "55P03", "42501", "22P02"]) {
      expect(isAlertDatabaseUnreadable(coded(code)), code).toBe(false);
    }
    expect(isAlertDatabaseUnreadable(new TypeError("x is not a function"))).toBe(false);
    const fetchFailed = Object.assign(new TypeError("fetch failed"), { cause: coded("ECONNREFUSED") });
    expect(isAlertDatabaseUnreadable(fetchFailed), "a dead vendor host is not our database").toBe(false);
  });

  it("reads codes, never the message", () => {
    expect(isAlertDatabaseUnreadable(new Error("CONNECTION_CLOSED 57P01 ECONNREFUSED"))).toBe(false);
    expect(isAlertDatabaseUnreadable(new Error("cannot execute INSERT in a read-only transaction"))).toBe(false);
  });
});

describe("an IMAP or plane error with no SQLSTATE is still not the database", () => {
  // imapflow's own codes (its CONNECT_TIMEOUT is also postgres.js's word for a silent server and
  // counts, as ruled: no alert pass dials IMAP), and the plane client's failures.
  const imap = ["ETIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT", "NoConnection", "ETHROTTLE", "ECONNREFUSED", "ECONNRESET"]
    .map((code) => Object.assign(new Error(`imap ${code}`), { code }));
  const plane = [
    Object.assign(new TypeError("fetch failed"), { cause: coded("UND_ERR_CONNECT_TIMEOUT") }),
    Object.assign(new TypeError("fetch failed"), { cause: coded("ECONNREFUSED") }),
    new Error("entitlements call timed out: /v1/ops"),
  ];

  it("untagged, and under the evaluation's tag", () => {
    for (const e of [...imap, ...plane]) {
      expect(isAlertDatabaseUnreadable(e), (e as { code?: string }).code ?? e.message).toBe(false);
      const underEvaluate = new AlertDatabaseReadError("evaluate", e);
      expect(isAlertDatabaseUnreadable(underEvaluate), `evaluate: ${(e as { code?: string }).code ?? e.message}`).toBe(false);
    }
  });

  it("nor an application fault under the evaluation's tag; its deadline is the database", () => {
    for (const code of ["42501", "42703", "23505", "40001", "55P03"]) {
      expect(isAlertDatabaseUnreadable(new AlertDatabaseReadError("evaluate", coded(code))), code).toBe(false);
    }
    expect(isAlertDatabaseUnreadable(new AlertDatabaseReadError("evaluate", coded("25006")))).toBe(true);
    expect(isAlertDatabaseUnreadable(new AlertDatabaseReadError("evaluate", null, ALERT_DB_DEADLINE_CODE))).toBe(true);
  });
});

/** A sink with a resolved-notice arm: the pass then writes (`tellResolutions`) on every run, as a real channel does. */
function hookArm(): AlertSink & { pages: string[][] } {
  const pages: string[][] = [];
  return {
    name: "webhook", pages,
    notify: async (alerts) => { pages.push(alerts.map((a) => a.key)); return true; },
    notifyResolved: async () => true,
  };
}

function codesOf(err: unknown): string[] {
  const out: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && typeof cur === "object" && cur !== null; i++) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "string") out.push(c);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

describe("a database that answers and refuses the pass's work", () => {
  it("read-only: the pass's first write is 25006, untagged, and that is the database", async () => {
    const db = await makeTestDb();
    await db.execute(sql`set default_transaction_read_only = on`);
    const arm = hookArm();
    const err = await failureOf(runAlertPass(db as unknown as Tx, { driver: "api", shards: [0], sinks: [arm] }));
    expect(codesOf(err)).toContain("25006");
    expect(err, "a write after the evaluation carries no tag").not.toBeInstanceOf(AlertDatabaseReadError);
    expect(isAlertDatabaseUnreadable(err)).toBe(true);
    expect(arm.pages, "the ordinary page never went out").toEqual([]);
  });
});

/**
 * A handle whose first read (the preflight's count in `information_schema`) answers and whose rule
 * reads never do: a database slow enough that the pass cannot finish.
 */
function stalledAfterPreflight(base: Awaited<ReturnType<typeof makeTestDb>>): Tx {
  const client = (base as unknown as { $client: PGlite }).$client;
  const stalled = new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === "query") {
        return (text: string, ...rest: unknown[]) => (/information_schema\.columns/.test(text)
          ? (value as (...a: unknown[]) => unknown).call(target, text, ...rest)
          : new Promise(() => undefined));
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return drizzlePglite({ client: stalled as unknown as PGlite, schema }) as unknown as Tx;
}

describe("a pass too slow to finish", () => {
  it("the evaluation runs under its own deadline: tagged evaluate, the deadline's code, the database", async () => {
    const db = stalledAfterPreflight(await makeTestDb());
    const started = Date.now();
    const err = await failureOf(runAlertPass(db, { driver: "worker", shards: [], sinks: [], evaluateMs: 300 }));
    expect(Date.now() - started, "bounded by the evaluation's deadline").toBeLessThan(2_000);
    expect(err).toBeInstanceOf(AlertDatabaseReadError);
    expect((err as AlertDatabaseReadError).op).toBe("evaluate");
    expect((err as AlertDatabaseReadError).code).toBe(ALERT_DB_DEADLINE_CODE);
    expect(isAlertDatabaseUnreadable(err)).toBe(true);
  });

  it("the console's direct evaluation has no deadline", async () => {
    const db = stalledAfterPreflight(await makeTestDb());
    const settled = await Promise.race([
      evaluateAlerts(db, { driver: "api", shards: [0] }).then(() => "settled", () => "settled"),
      new Promise((r) => setTimeout(() => r("pending"), 400)),
    ]);
    expect(settled).toBe("pending");
  });

  it("30 s by default, the first read's 10 s inside it", () => {
    expect(ALERT_DB_EVALUATE_MS).toBe(30_000);
    expect(ALERT_DB_FIRST_READ_MS).toBeLessThan(ALERT_DB_EVALUATE_MS);
  });
});

describe("the evaluation's deadline adds a deadline and nothing else", () => {
  it("its own failure passes through as it is; a tagged one keeps its tag", async () => {
    const own = coded("42703");
    expect(await failureOf(evaluationUnderDeadline(() => Promise.reject(own), 1_000))).toBe(own);
    const preflight = new AlertDatabaseReadError("preflight", coded("ECONNREFUSED"));
    expect(await failureOf(evaluationUnderDeadline(() => Promise.reject(preflight), 1_000))).toBe(preflight);
    expect(await evaluationUnderDeadline(() => Promise.resolve(7), 1_000)).toBe(7);
  });

  it("a read past it rejects tagged evaluate, and the late rejection is nobody's", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      let fail!: (e: unknown) => void;
      const late = new Promise<never>((_, reject) => { fail = reject; });
      const err = await failureOf(evaluationUnderDeadline(() => late, 50));
      expect((err as AlertDatabaseReadError).op).toBe("evaluate");
      expect((err as AlertDatabaseReadError).code).toBe(ALERT_DB_DEADLINE_CODE);
      fail(coded("57P01"));
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("the staff handle's refusal", () => {
  it("a role verdict (no cause) is never the database; a statement that could not run is", () => {
    const verdict = new NotContentBlindError("'select subject from messages where false' SUCCEEDED");
    expect(isAlertDatabaseUnreadable(new AlertDatabaseReadError("handle", verdict))).toBe(false);
    const failed = new NotContentBlindError("the bite test failed", {
      cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
    });
    expect(isAlertDatabaseUnreadable(new AlertDatabaseReadError("handle", failed))).toBe(true);
    expect(isAlertDatabaseUnreadable(new AlertDatabaseReadError("handle", new Error("no code"))),
      "a tagged error with no code").toBe(false);
  });
});

describe("only the pass's own reads are tagged", () => {
  it("runAlertPass against a refused port rejects tagged; the console's evaluateAlerts rejects raw", async () => {
    const db = drizzle(client(await refusedPort()), { schema }) as unknown as Tx;
    const pass = await failureOf(runAlertPass(db, { driver: "api", shards: [0], sinks: [] }));
    expect(pass).toBeInstanceOf(AlertDatabaseReadError);
    expect((pass as AlertDatabaseReadError).op).toBe("preflight");
    const direct = await failureOf(evaluateAlerts(db, { driver: "api", shards: [0] }));
    expect(direct).not.toBeInstanceOf(AlertDatabaseReadError);
    expect((direct as { code?: string }).code).toBe("ECONNREFUSED");
  });
});
