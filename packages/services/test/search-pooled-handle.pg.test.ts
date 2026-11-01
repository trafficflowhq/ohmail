import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { accountSettings, folderState, mailboxes, messageBodies, messages } from "@trafficflow/db";
import { closePooledDbs, makePooledDb } from "@trafficflow/db/cloud";
import { runMigrations, ensureSearchExtensions } from "@trafficflow/db/admin";
import { pgTestUrl, recordPgWire } from "@trafficflow/db/testing";
import { upsertMessageSearch } from "@trafficflow/core/mail";
import { SearchService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";

/**
 * A SEARCH ON THE HOSTED SHAPE, counted on the wire: the host asks `makePooledDb` for a handle on
 * every request, so this does too. A warm page is one wait — begin, the settings and the page in
 * one flush, commit written after the answer — and the facts the service keeps per handle survive
 * the next request. Two accounts share the handle in parallel, one with its search documents built
 * and one without.
 */
const wire = recordPgWire();
const PG_URL = pgTestUrl(import.meta.url);
const svc = new SearchService();
const NOW = new Date("2026-09-25T12:00:00.000Z");
const BUILT = randomUUID();
const UNBUILT = randomUUID();
const own: Record<string, Set<string>> = { [BUILT]: new Set(), [UNBUILT]: new Set() };

/** What the host hands a request: a handle from the factory, asked for anew each time. */
function ctx(accountId: string): ServiceContext {
  return { db: makePooledDb(PG_URL) as never, accountId, userId: null, now: () => NOW, requestId: "search-pooled-handle" };
}

/** A flush the client waits after: it ends a round trip. */
const waits = (kinds: string): boolean => /[SHQ]/.test(kinds);
/** A Bind's parameter count: portal and statement names, the format codes, then the count. */
function paramsOf(bind: Buffer): number {
  let at = 5;
  at = bind.indexOf(0, at) + 1;
  at = bind.indexOf(0, at) + 1;
  const formats = bind.readInt16BE(at);
  return bind.readInt16BE(at + 2 + formats * 2);
}

async function onWire<T>(run: () => Promise<T>): Promise<{ value: T; trips: number; statements: number; flushes: Array<{ kinds: string; params: number[] }> }> {
  wire.start();
  const value = await run();
  const r = wire.read();
  const binds = [...r.binds];
  const flushes = r.flushes.map((kinds) => ({ kinds, params: [...kinds].filter((k) => k === "B").map(() => paramsOf(binds.shift()!)) }));
  return { value, trips: r.flushes.filter(waits).length, statements: r.statements, flushes };
}

/**
 * ONE FLIGHT: a flush holds begin, the settings (a simple query) and the read, and no flush before it
 * carried a bind of this answer's; COMMIT is written once the answer is in, within `ms`.
 */
async function oneFlight(r: Awaited<ReturnType<typeof onWire>>, ms = 500): Promise<{ kinds: string; params: number[] }> {
  const shape = r.flushes.map((f) => f.kinds).join(" | ");
  const at = r.flushes.findIndex((f) => /^QQP[^Q]*B[^Q]*S$/.test(f.kinds));
  expect(at, shape).toBeGreaterThanOrEqual(0);
  expect(r.flushes.slice(0, at).some((f) => f.kinds.includes("B")), shape).toBe(false);
  const seen = r.flushes.length;
  const until = Date.now() + ms;
  while (!wire.read().flushes.slice(seen).includes("Q") && Date.now() < until) await new Promise((x) => setTimeout(x, 10));
  expect(wire.read().flushes.slice(seen), `${shape}: the commit after the answer`).toContain("Q");
  return r.flushes[at]!;
}

async function seed(accountId: string, n: number, documents: boolean): Promise<void> {
  const db = makePooledDb(PG_URL);
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `${accountId.slice(0, 8)}@ph.example` }).returning();
  for (let i = 0; i < n; i++) {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `ph:${randomUUID()}`,
      subject: `heron sighting ${i}`, fromAddress: `watcher${i % 3}@ph.example`,
      date: new Date(NOW.getTime() - i * 3_600_000), unread: i % 2 === 0, hasAttachments: false,
      nativeLocator: { folder: "INBOX", ref: `1:${i}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: `a heron by the lake, note ${i}` });
    await db.insert(folderState).values({ messageId: m!.id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
    if (documents) await document(accountId, m!.id, i);
    own[accountId]!.add(m!.id);
  }
  if (documents) await built(accountId);
}

async function document(accountId: string, id: string, i: number): Promise<void> {
  await upsertMessageSearch(makePooledDb(PG_URL) as never, id, {
    accountId, subject: `heron sighting ${i}`, from: { name: null, address: `watcher${i % 3}@ph.example` }, to: [], cc: [],
    attachmentNames: [], bodyText: `a heron by the lake, note ${i}`, source: "text",
  });
}

async function built(accountId: string): Promise<void> {
  await makePooledDb(PG_URL).insert(accountSettings).values({ accountId, searchIndexBuiltAt: NOW })
    .onConflictDoUpdate({ target: accountSettings.accountId, set: { searchIndexBuiltAt: NOW } });
}

describe("a search on the hosted handle factory (real Postgres, on the wire)", () => {
  beforeAll(async () => {
    await runMigrations(PG_URL);
    await ensureSearchExtensions(makePooledDb(PG_URL) as never, { concurrently: false });
    await seed(BUILT, 9, true);
    await seed(UNBUILT, 6, false);
    // The first request on a handle probes pg_trgm and reads the marker; every later one does not.
    await svc.search(ctx(BUILT), { q: "heron", parts: "page", limit: 4 });
  }, 120_000);

  afterAll(async () => {
    const db = makePooledDb(PG_URL);
    for (const a of [BUILT, UNBUILT]) {
      await db.execute(sql`delete from message_search where account_id = ${a}`);
      await db.execute(sql`delete from folder_state where message_id in (select id from messages where account_id = ${a})`);
      await db.execute(sql`delete from message_bodies where message_id in (select id from messages where account_id = ${a})`);
      await db.execute(sql`delete from messages where account_id = ${a}`);
      await db.execute(sql`delete from mailboxes where account_id = ${a}`);
      await db.execute(sql`delete from account_settings where account_id = ${a}`);
    }
    await closePooledDbs();
  });

  it("a warm page is one wait: begin, the settings and the page in one flush, commit after the answer", async () => {
    const r = await onWire(() => svc.search(ctx(BUILT), { q: "heron", parts: "page", limit: 4 }));
    console.log(`search-pooled-handle page: ${r.flushes.map((f) => f.kinds).join(" | ")}`);
    expect(r.value.items).toHaveLength(4);
    // Begin and the settings carry no parameter; the page's read binds its own.
    const flight = await oneFlight(r);
    expect(flight.params).toHaveLength(1);
    expect(flight.params[0]!).toBeGreaterThan(0);
  });

  it("the estimate and the summary are one wait too", async () => {
    for (const parts of ["estimate", "summary"] as const) {
      const r = await onWire(() => svc.search(ctx(BUILT), { q: "heron", parts, limit: 4 }));
      expect(r.value.total, parts).toBe(9);
      expect(r.value.totalExact, parts).toBe(true);
      await oneFlight(r);
    }
  });

  it("an empty exact tier asks the typo tier in the same statement: one wait, as a warm page", async () => {
    const r = await onWire(() => svc.search(ctx(BUILT), { q: "zzqqxx", parts: "page", limit: 4 }));
    expect(r.value.items).toEqual([]);
    expect(r.value.tier).toBe("similar");
    await oneFlight(r);
  });

  it("two accounts in parallel on one handle read only their own rows, the unbuilt one by its old columns", async () => {
    expect(makePooledDb(PG_URL)).toBe(makePooledDb(PG_URL));
    for (let round = 0; round < 5; round++) {
      const answers = await Promise.all([BUILT, UNBUILT, BUILT, UNBUILT].map(async (a) =>
        ({ a, r: await svc.search(ctx(a), { q: "heron", parts: "page", limit: 50 }) })));
      for (const { a, r } of answers) {
        expect(r.items.length, a === BUILT ? "built" : "unbuilt").toBe(own[a]!.size);
        for (const m of r.items) expect(own[a]!.has(m.id)).toBe(true);
      }
    }
  });

  it("an unbuilt marker is asked again, so a backfill that finishes later is read", async () => {
    const before = await onWire(() => svc.search(ctx(UNBUILT), { q: "heron", parts: "page", limit: 4 }));
    // The marker's read carries the account: its settings flush has a parameter.
    expect(before.flushes.some((f) => f.params[0]! > 0), before.flushes.map((f) => f.kinds).join(" | ")).toBe(true);
    let i = 0;
    for (const id of own[UNBUILT]!) await document(UNBUILT, id, i++);
    await built(UNBUILT);
    await svc.search(ctx(UNBUILT), { q: "heron", parts: "page", limit: 4 });
    const after = await onWire(() => svc.search(ctx(UNBUILT), { q: "heron", parts: "page", limit: 4 }));
    expect(after.value.items).toHaveLength(4);
    await oneFlight(after);
  });
});
