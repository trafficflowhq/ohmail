import fs, { rmSync } from "node:fs";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { createSidecar } from "../src/engine.js";
import {
  CUSTOM_PLAN_STATEMENTS, IngestPlans, PLAN_NAMES_MAX, PLAN_REUSE_EXECUTIONS, foldStatement, keepIngestPlans,
} from "../src/pglite-plans.js";
import { currentStoreLane, inStoreLane } from "../src/store-lanes.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE INGEST'S STATEMENTS ARE PLANNED ONCE A LIFE, NOT ONCE AN EXECUTION.
 *
 * Planning sizes a table and every index it has, an `fstat` apiece through the store's filesystem:
 * 95 of the ~107 file calls an imported message cost at the base. Counted at the `node:fs` seam; the
 * positive control is the same statement from the interactive lane, which PGlite still sends
 * unnamed. The drain case asks the shipped engine which statements it named and reads EXPLAIN for
 * each, so a statement added later is held to the same rule.
 */

const dirs: string[] = [];
const open: OpenLocalDb[] = [];
afterAll(async () => {
  for (const h of open) await h.close().catch(() => { /* a closed handle is fine */ });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** `fstat` calls made while `work` runs: the Emscripten glue's answer to `lseek(SEEK_END)`. */
async function sizings(work: () => Promise<void>): Promise<number> {
  const f = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
  const orig = f.fstatSync!;
  let n = 0;
  f.fstatSync = function (this: unknown, ...a: unknown[]) { n += 1; return orig.apply(this, a); };
  try { await work(); } finally { f.fstatSync = orig; }
  return n;
}

/** The PGlite client under a handle's drizzle wrapper (typed on the driver, not on `LocalDb`). */
const clientOf = (h: OpenLocalDb): PGlite => (h.db as unknown as { $client: PGlite }).$client;

async function probeStore(prefix: string): Promise<OpenLocalDb> {
  const dir = await freshDataDir(prefix);
  dirs.push(dir);
  const h = await openLocalDb(dir);
  open.push(h);
  await clientOf(h).exec(`
    create table plans_probe (id int primary key, a int not null, b text not null, c boolean, at timestamptz, j jsonb, big bigint);
    create index plans_probe_a on plans_probe (a);
    create index plans_probe_b on plans_probe (b);
    insert into plans_probe (id, a, b) select g, g % 50, 'row ' || g from generate_series(1, 2000) g;`);
  return h;
}

const LOOKUP = "select b from plans_probe where id = $1";
const RUNS = PLAN_REUSE_EXECUTIONS + 44;
/* Four relations (the table and its three indexes); a life plans at most six times (five custom
   plans before the plan cache weighs a generic one, then that one). */
const PLANNED_PER_LIFE = 6 * 4;

describe("the local store's ingest plans", () => {
  it("plans an ingest statement once a life, and returns what PGlite returns", async () => {
    const h = await probeStore("ohmail-plans-");
    const c = clientOf(h);
    const named: unknown[] = [], unnamed: unknown[] = [];
    const ingest = await sizings(() => inStoreLane("ingest", async () => {
      for (let i = 1; i <= RUNS; i += 1) named.push((await c.query(LOOKUP, [i])).rows[0]);
    }));
    const interactive = await sizings(async () => {
      for (let i = 1; i <= RUNS; i += 1) unnamed.push((await c.query(LOOKUP, [i])).rows[0]);
    });
    expect(named).toEqual(unnamed);
    expect(interactive, "the interactive lane no longer plans per execution, so the case above says nothing")
      .toBeGreaterThanOrEqual(RUNS * 4);
    expect(ingest, "the ingest lane planned its statement per execution")
      .toBeLessThanOrEqual(Math.ceil(RUNS / PLAN_REUSE_EXECUTIONS) * PLANNED_PER_LIFE);
    const held = (await c.query<{ statement: string; generic_plans: number }>(
      "select statement, generic_plans from pg_prepared_statements")).rows;
    expect(held.map((r: { statement: string }) => r.statement)).toEqual([LOOKUP]);
    expect(held[0]!.generic_plans, "the plan cache never chose a generic plan").toBeGreaterThan(0);
  }, 120_000);

  /* A plan made when a table was small must not serve it for ever: no autovacuum runs here. */
  it(`prepares a statement anew after ${PLAN_REUSE_EXECUTIONS} executions`, async () => {
    const h = await probeStore("ohmail-plans-life-");
    const c = clientOf(h);
    const parses: string[] = [];
    const exec = c.execProtocol.bind(c);
    c.execProtocol = (m: Uint8Array, o?: Parameters<PGlite["execProtocol"]>[1]) => {
      if (m[0] === 0x50) parses.push(Buffer.from(m).toString("latin1"));
      return exec(m, o);
    };
    try {
      await inStoreLane("ingest", async () => {
        for (let i = 0; i < 2 * PLAN_REUSE_EXECUTIONS + 1; i += 1) await c.query(LOOKUP, [1 + (i % 2000)]);
      });
    } finally { c.execProtocol = exec; }
    expect(parses.filter((m) => m.includes(LOOKUP))).toHaveLength(3);
  }, 120_000);

  it(`holds at most ${PLAN_NAMES_MAX} names, closing the least recently used`, async () => {
    const h = await probeStore("ohmail-plans-names-");
    const c = clientOf(h);
    await inStoreLane("ingest", async () => {
      for (let i = 0; i < PLAN_NAMES_MAX + 6; i += 1) await c.query(`select b from plans_probe where id = $1 and ${i} = ${i}`, [1]);
    });
    const n = (await c.query<{ n: number }>("select count(*)::int as n from pg_prepared_statements")).rows[0]!.n;
    expect(n).toBe(PLAN_NAMES_MAX);
  }, 120_000);

  it("keeps PGlite's values, parsers, errors and transactions", async () => {
    const h = await probeStore("ohmail-plans-shape-");
    const c = clientOf(h);
    const at = new Date("2026-09-25T10:00:00.123Z");
    const insert = "insert into plans_probe (id, a, b, c, at, j, big) values ($1, $2, $3, $4, $5, $6, $7) returning *";
    const row = (id: number) => [id, 7, `probe ${id}`, false, at, JSON.stringify({ k: [1, "x"] }), 9_007_199_254_740_993n];
    const read = "select id, c, at, j, big from plans_probe where id = $1";
    const opts = { rowMode: "array" as const, parsers: { 1184: (v: string) => `tz:${v}` } };
    const stock = { ins: await c.query(insert, row(90_001)), rd: await c.query(read, [90_001], opts) };
    const named = await inStoreLane("ingest", async () => ({ ins: await c.query(insert, row(90_002)), rd: await c.query(read, [90_002], opts) }));
    const blank = (r: unknown) => ({ ...(r as object), id: 0, b: "" });
    expect({ ...named.ins, rows: named.ins.rows.map(blank) }).toEqual({ ...stock.ins, rows: stock.ins.rows.map(blank) });
    expect((named.rd.rows[0] as unknown[]).slice(1)).toEqual((stock.rd.rows[0] as unknown[]).slice(1));
    expect(named.rd.fields).toEqual(stock.rd.fields);
    /* A failed statement rejects as PGlite's does, takes its transaction with it, and the name it
       was prepared under still serves the next transaction. */
    const fail = await inStoreLane("ingest", () => c.transaction(async (tx: Transaction) => {
      await tx.query(insert, row(90_003));
      await tx.query(insert, row(90_002));
    })).then(() => null, (e: { code?: string }) => e.code);
    expect(fail).toBe("23505");
    expect((await c.query("select 1 from plans_probe where id = 90003")).rows).toEqual([]);
    await inStoreLane("ingest", () => c.transaction(async (tx: Transaction) => { await tx.query(insert, row(90_004)); }));
    expect((await c.query("select id from plans_probe where id = 90004")).rows).toEqual([{ id: 90_004 }]);
  }, 120_000);

  /* The harness switch the kit's A arm uses, and the mutation this file is watched red by. */
  it("routes nothing when IngestPlans says no", async () => {
    const h = await probeStore("ohmail-plans-off-");
    const c = clientOf(h);
    const routes = IngestPlans.prototype.routes;
    IngestPlans.prototype.routes = () => false;
    try {
      const n = await sizings(() => inStoreLane("ingest", async () => { for (let i = 1; i <= 50; i += 1) await c.query(LOOKUP, [i]); }));
      expect(n).toBeGreaterThanOrEqual(50 * 4);
    } finally { IngestPlans.prototype.routes = routes; }
  }, 120_000);

  it("is installed beneath every door of a bare client", async () => {
    const client = new PGlite();
    keepIngestPlans(client);
    await client.exec("create table t (id int primary key)");
    await inStoreLane("ingest", () => client.transaction(async (tx) => { await tx.query("insert into t values ($1)", [1]); }));
    await inStoreLane("ingest", () => client.query("select id from t where id = $1", [1]));
    const held = (await client.query<{ n: number }>("select count(*)::int as n from pg_prepared_statements")).rows[0]!.n;
    await client.close();
    expect(held).toBe(2);
  }, 60_000);
});

/* ── THE SHIPPED DRAIN ─────────────────────────────────────────────────────────────────────── */

const words = "the a report meeting garden river stone window paper coffee travel north market letter bird".split(" ");
function mail(i: number): Buffer {
  const text = Array.from({ length: 60 }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(" ");
  return Buffer.from([`Message-ID: <plans-${i}@birds.test>`, `From: Sender ${i % 40} <sender${i % 40}@birds.test>`,
    "To: owner@trafficflow.test", `Subject: Message ${i} about the ${words[i % words.length]}`,
    `Date: ${new Date(Date.parse("2026-09-24T00:00:00Z") - i * 3_600_000).toUTCString().replace("GMT", "+0000")}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", text].join("\r\n"), "utf8");
}
function mailbox(n: number, page: number) {
  let at = 0;
  const lease = { claims: [] as { ref: number; raw: string }[], next: 1 };
  return () => ({
    leaseIo: () => ({
      async ensureMetaFolder() {}, async listClaims() { return lease.claims.map((x) => ({ ...x })); },
      async appendClaim(raw: string) { lease.claims.push({ ref: lease.next++, raw }); },
      async removeClaims(refs: readonly unknown[]) { const g = new Set(refs); lease.claims = lease.claims.filter((x) => !g.has(x.ref)); },
      uidValidity: () => 4_100,
    }),
    async connect() {}, async close() {},
    async capabilities() { return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null }; },
    async ensureFolders() {},
    async changesSince() {
      const from = at, to = Math.min(n, from + page);
      at = to;
      const creates = Array.from({ length: to - from }, (_, k) => ({
        type: "create" as const, locator: { folder: "INBOX", ref: `4100:${from + k + 1}` }, raw: mail(from + k),
        internalDate: new Date(Date.parse("2026-09-24T00:00:00Z") - (from + k) * 3_600_000),
      }));
      const folders = { INBOX: { uidValidity: "4100", uidNext: to + 1, highestModseq: String(to + 1), serverExists: n } };
      return { creates, moves: [], flagChanges: [], deletes: [], newCursor: { folders }, hasBacklog: to < n };
    },
    async move(locator: { ref: string }, toFolder: string) { return { folder: toFolder, ref: `4200:${locator.ref.split(":")[1]}` }; },
    async setFlags() {}, async scanSentRecipients() { return []; }, async watch() { return async () => {}; },
    async send() { throw new Error("this mailbox cannot send"); },
    async fetchPart() { throw new Error("this mailbox cannot fetchPart"); },
  });
}

type Plan = Record<string, unknown> & { Plans?: Plan[] };
const indexesOf = (p: Plan, out = new Set<string>()): Set<string> => {
  if (typeof p["Index Name"] === "string") out.add(p["Index Name"]);
  for (const k of p.Plans ?? []) indexesOf(k, out);
  return out;
};
const planOf = (rows: Record<string, unknown>[]): Plan => {
  const v = Object.values(rows[0] ?? {})[0];
  return ((typeof v === "string" ? JSON.parse(v) : v) as { Plan: Plan }[])[0]!.Plan;
};

describe("the drain's statements", () => {
  it("are named but for the refused ones, and no named one's generic plan loses an index", async () => {
    const seen = new Map<string, { params: unknown[]; routed: boolean }>();
    const routes = IngestPlans.prototype.routes;
    IngestPlans.prototype.routes = function (this: IngestPlans, text, params, options) {
      const routed = routes.call(this, text, params, options);
      if (currentStoreLane() === "ingest" && params?.length && !seen.has(text)) seen.set(text, { params: [...params], routed });
      return routed;
    };
    const dataDir = await freshDataDir("ohmail-plans-drain-");
    dirs.push(dataDir);
    let handle: OpenLocalDb | null = null;
    const sidecar = await createSidecar({
      dataDir, imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
      address: "owner@trafficflow.test", machineName: "plans host", pollIntervalMs: 60 * 60 * 1000,
      adapterFactory: mailbox(450, 150), log: () => {},
      store: async (d: string, o: unknown) => (handle = await openLocalDb(d, o as never)),
    });
    try {
      try {
        await sidecar.start();
      } finally { IngestPlans.prototype.routes = routes; }
      const c = clientOf(handle!);
      const stored = (await c.query<{ n: number }>("select count(*)::int as n from messages")).rows[0]!.n;
      expect(stored, "the drain stored nothing, so nothing below was read").toBe(450);
      const held = new Set((await c.query<{ statement: string }>("select statement from pg_prepared_statements")).rows.map((r: { statement: string }) => r.statement));
      /* Every refused text is still one the drain sends: a refusal whose statement moved is no refusal. */
      const folded = new Map([...seen.keys()].map((t) => [foldStatement(t), t]));
      for (const refused of CUSTOM_PLAN_STATEMENTS) {
        expect(folded.has(refused), `the drain no longer sends a refused statement: ${refused.slice(0, 120)}`).toBe(true);
        expect(seen.get(folded.get(refused)!)!.routed || held.has(folded.get(refused)!), "a refused statement was named").toBe(false);
      }
      const named = [...seen].filter(([, s]) => s.routed);
      expect(named.length, "the drain named fewer statements than the eight that plan per message").toBeGreaterThanOrEqual(8);
      /* EXPLAIN each named statement with sequential scans priced out, so the reading is which index
         CAN serve each plan and not what this small store happens to make cheapest. */
      await c.exec("set enable_seqscan = off");
      const lost: string[] = [];
      for (const [text, s] of named) {
        const custom = planOf((await c.query(`explain (format json) ${text}`, s.params)).rows as Record<string, unknown>[]);
        const generic = planOf((await c.exec(`explain (generic_plan, format json) ${text}`))[0]!.rows as Record<string, unknown>[]);
        const g = indexesOf(generic);
        for (const i of indexesOf(custom)) if (!g.has(i)) lost.push(`${i} :: ${text.slice(0, 160)}`);
      }
      await c.exec("reset enable_seqscan");
      expect(lost, "a named statement's generic plan loses an index its custom plan uses: refuse it in CUSTOM_PLAN_STATEMENTS").toEqual([]);
    } finally {
      await sidecar.stop();
    }
  }, 240_000);
});
