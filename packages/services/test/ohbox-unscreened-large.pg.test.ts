import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { brandDialect } from "@trafficflow/db/dialect";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { mailboxes, type LedgerTx } from "@trafficflow/db";
import { closePooledDbs, makePooledDb, schema } from "@trafficflow/db/cloud";
import { agreeSweepSlice, makeDrizzleRepo, type AgreeSweepCursor } from "@trafficflow/core/adapters/drizzle-repo";
import { unscreenedSummary, type UnscreenedSummary } from "@trafficflow/services/mail";

/**
 * THE OFFER ON A LARGE ACCOUNT — the size the hosted read failed at: 80,000 letters in the Ohbox, a
 * thousand rules, 3,000 contacts, and 600 letters from senders nobody decided about, 150 of them.
 *
 * Read letter by letter, 25 pages of 200 found a tenth of those senders and answered "at least":
 * the walk's length followed the Ohbox, each page cost the hosted database 3.7 s, and four walks
 * at once held an instance's four connections while every other route answered `db_busy`. Three
 * things are held here: the whole answer in one request with the statements counted, a request out
 * of time answering a part the next request goes on from, and connections left for other routes
 * while reads overlap.
 *
 * The agree's sweep reads the same pages, and a page now holds the letters the person answered
 * too: its last cases hold that a slice always stands past the page it read, whoever wrote back.
 */

const PG_UP = await realPgAvailable();
const NOW = new Date("2026-09-22T09:00:00.000Z");
const STRANGERS = 150;
/** 3, 4 or 5 letters a stranger, so a page of 200 ends inside one sender's mail. */
const STRANGER_LETTERS = 600;
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let accountId: string;
/** Statements this file's own client has sent. */
let sent = 0;
let pendingSetup: { phase: string; startedAt: number } | null = null;

const measuredWalks = new Map([
  ["one request reads every sender nobody decided about, and its statements follow the senders", "full"],
  ["a request out of time answers a part, and the next request goes on from it", "cursor"],
]);

/** The runner's visible cgroup and this test database. The service container can have a different CPU quota. */
async function walkCounters() {
  const throttled = readFile("/proc/self/cgroup", "utf8").then(async (membership) => {
    const group = /^0::(\/.*)$/m.exec(membership)?.[1];
    if (!group || group.split("/").includes("..")) return null;
    const text = await readFile(`/sys/fs/cgroup${group.replace(/\/$/, "")}/cpu.stat`, "utf8");
    const found = /^throttled_usec (\d+)$/m.exec(text);
    return found ? Number(found[1]) / 1000 : null;
  }).catch(() => null);
  // A separate, short-lived observer keeps its statements out of the fixture's query-count assertion.
  const observer = postgres(PG_TEST_URL, {
    max: 1, connect_timeout: 1, onnotice: () => {}, connection: { statement_timeout: 500 },
  });
  let dbActive: number | null = null;
  let sqlExec: number | null = null;
  try {
    const [activity] = await observer<{ ms: number; statements: boolean }[]>`
      select active_time::float8 as ms, to_regclass('pg_stat_statements') is not null as statements
      from pg_stat_database where datname = current_database()`;
    dbActive = activity?.ms ?? null;
    if (activity?.statements) {
      const [execution] = await observer<{ ms: number | null }[]>`
        select sum(total_exec_time)::float8 as ms from pg_stat_statements
        where dbid = (select oid from pg_database where datname = current_database())`;
      sqlExec = execution?.ms ?? null;
    }
  } catch { /* The original walk still runs on an uninstrumented or busy database. */ }
  finally { await observer.end({ timeout: 0 }).catch(() => {}); }
  return { dbActive, sqlExec, throttled: await throttled };
}

function elapsedCounter(start: number | null, end: number | null): number | null {
  return start !== null && end !== null && end >= start ? Math.round(end - start) : null;
}

let walkStart: { label: string; wall: number; statements: number; counters: Awaited<ReturnType<typeof walkCounters>> } | null = null;

function enteringSetup(phase: string): void {
  pendingSetup = { phase, startedAt: performance.now() };
}

/** The account, set-based: one statement a table, so the seed costs seconds. */
async function seedLargeAccount(): Promise<string> {
  const id = randomUUID();
  const mailboxId = randomUUID();
  const at = new Date("2026-09-17T08:00:00.000Z").toISOString();
  enteringSetup("account insertion");
  await client`insert into accounts (id, name) values (${id}, ${`large-${id.slice(0, 8)}`})`;
  enteringSetup("mailbox insertion");
  await client`insert into mailboxes (id, account_id, provider, address, organizer_role)
               values (${mailboxId}, ${id}, 'imap', ${`me-${id.slice(0, 8)}@example.test`}, 'organizer')`;
  enteringSetup("rule insertion");
  await client`insert into rules (account_id, kind, match, destination, provenance)
               select ${id}, 'sender', 'r' || g || '@ruled.test', 'INBOX', 'manual' from generate_series(0, 999) g`;
  enteringSetup("contact insertion");
  await client`insert into contacts (account_id, address)
               select ${id}, 'c' || g || '@known.test' from generate_series(0, 2999) g`;
  // 79,400 letters from the decided senders, then the strangers' 600.
  enteringSetup("seed transaction start");
  await client.begin(async (tx) => {
    enteringSetup("seed table creation");
    await tx`
      create temp table large_seed on commit drop as
      select gen_random_uuid() as id,
             case when g % 4 = 0 then 'r' || (g % 1000) || '@ruled.test' else 'c' || (g % 3000) || '@known.test' end as sender
        from generate_series(0, 79399) g
      union all
      select gen_random_uuid(), 'stranger' || k || '@unknown.test'
        from generate_series(0, ${STRANGERS - 1}::int) k, generate_series(1, 5) n
       where n <= 3 + k % 3`;
    enteringSetup("message insertion");
    await tx`
      insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address,
                            date, created_at, arrived_at, unread, native_locator)
      select id, ${id}::uuid, ${mailboxId}::uuid, 'h', 'large:' || id, 'Note', sender,
             ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz, false, '{"folder":"INBOX","ref":"1:1"}'::jsonb
        from large_seed`;
    enteringSetup("folder state insertion");
    await tx`
      insert into folder_state (message_id, account_id, desired_folder, observed_folder, last_set_by, reconcile_status, conflict)
      select id, ${id}::uuid, 'INBOX', 'INBOX', 'external', 'reconciled', false from large_seed`;
    enteringSetup("seed commit");
  });
  return id;
}

/** The parts as a client adds them up: a sender cut in two is one group with both counts. */
function added(parts: readonly UnscreenedSummary[]): Map<string, number> {
  const by = new Map<string, number>();
  for (const p of parts) for (const g of p.groups) by.set(g.address, (by.get(g.address) ?? 0) + g.count);
  return by;
}

/** The instant of the agree whose stamp the sweep spends. */
const AGREED_AT = new Date("2026-09-22T08:00:00.000Z");
const answered = (n: number): string => "1".repeat(n);
const owed = (n: number): string => "0".repeat(n);
const senderAt = (rank: number): string => `asked${String(rank).padStart(4, "0")}@unknown.test`;

/**
 * A mailbox its owner agreed to have screened, set-based: one letter a flag, newest first, each
 * from its own stranger in its own thread. "1" is a letter the person answered there (a sent letter
 * in the thread, addressed to its sender); "0" is one the sweep owes the Screener.
 */
async function seedAgreed(flags: string): Promise<{ id: string; mailboxId: string }> {
  const id = randomUUID();
  const mailboxId = randomUUID();
  const own = `me-${id.slice(0, 8)}@example.test`;
  await client`insert into accounts (id, name) values (${id}, ${`agreed-${id.slice(0, 8)}`})`;
  await client`insert into mailboxes (id, account_id, provider, address, organizer_role)
               values (${mailboxId}, ${id}, 'imap', ${own}, 'organizer')`;
  await client`insert into audit_log (account_id, action, payload, created_at)
               values (${id}, 'organizer.agree_screens_backlog',
                       jsonb_build_object('mailboxId', ${mailboxId}::text, 'cutoff', null), ${AGREED_AT.toISOString()})`;
  await client.begin(async (tx) => {
    await tx`
      create temp table agreed_seed on commit drop as
      select gen_random_uuid() as id, gen_random_uuid() as thread, gen_random_uuid() as answer,
             'asked' || lpad(g::text, 4, '0') || '@unknown.test' as sender,
             '2026-09-17T08:00:00Z'::timestamptz - make_interval(mins => g) as at,
             substr(${flags}, g + 1, 1) = '1' as answered
        from generate_series(0, ${flags.length - 1}::int) g`;
    await tx`insert into threads (id, account_id, subject) select thread, ${id}::uuid, 'Note' from agreed_seed`;
    await tx`
      insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address,
                            date, created_at, arrived_at, unread, native_locator, thread_id)
      select id, ${id}::uuid, ${mailboxId}::uuid, 'h', 'agreed:' || id, 'Note', sender, at, at, at, false,
             '{"folder":"INBOX","ref":"1:1"}'::jsonb, thread
        from agreed_seed`;
    await tx`
      insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address,
                            date, created_at, arrived_at, unread, native_locator, thread_id, to_addresses)
      select answer, ${id}::uuid, ${mailboxId}::uuid, 'h', 'answer:' || id, 'Re: Note', ${own}, at, at, at, false,
             '{"folder":"Sent","ref":"1:1"}'::jsonb, thread, jsonb_build_array(jsonb_build_object('address', sender))
        from agreed_seed where answered`;
    await tx`
      insert into folder_state (message_id, account_id, desired_folder, observed_folder, last_set_by, reconcile_status, conflict)
      select id, ${id}::uuid, 'INBOX', 'INBOX', 'external', 'reconciled', false from agreed_seed
      union all
      select answer, ${id}::uuid, 'Sent', 'Sent', 'external', 'reconciled', false from agreed_seed where answered`;
  });
  return { id, mailboxId };
}

/**
 * The sweep's slices back to back, as a host's drains run them, to its end: what each moved. A
 * slice that is not the last must stand somewhere new: asked again from the same place it would
 * read, and lock, the same page for ever.
 */
async function sweepToEnd(
  a: { id: string; mailboxId: string }, sizing: { pages?: number; slice?: number },
): Promise<number[]> {
  const moved: number[] = [];
  let cursor: AgreeSweepCursor | null = null;
  do {
    const out = await agreeSweepSlice(db as never, {
      accountId: a.id, mailboxId: a.mailboxId, stamp: AGREED_AT, held: false, now: NOW, cursor, ...sizing,
      knowledgeFor: (tx) => makeDrizzleRepo(tx as never), ledgerOf: (tx) => tx as unknown as LedgerTx,
    });
    if (out.kind !== "swept") throw new Error(`the sweep answered ${out.kind}`);
    if (out.next !== null) expect(out.next.after, `slice ${moved.length + 1} stands where it started`).not.toBe(cursor?.after ?? null);
    moved.push(out.total);
    cursor = out.next;
  } while (cursor !== null);
  return moved;
}

describe.skipIf(!PG_UP)("the offer on a large account", () => {
  beforeEach(async ({ task }) => {
    const label = measuredWalks.get(task.name);
    if (!label) return;
    const counters = await walkCounters();
    walkStart = { label, counters, wall: performance.now(), statements: sent };
  });
  afterEach(async () => {
    const start = walkStart;
    walkStart = null;
    if (!start) return;
    const wallMs = Math.round(performance.now() - start.wall);
    const statements = sent - start.statements;
    const end = await walkCounters();
    console.info("Large Ohbox walk timing", {
      walk: start.label, wallMs, statements,
      databaseActiveMs: elapsedCounter(start.counters.dbActive, end.dbActive),
      sqlExecutionMs: elapsedCounter(start.counters.sqlExec, end.sqlExec),
      processCgroupThrottledMs: elapsedCounter(start.counters.throttled, end.throttled),
    });
  });
  beforeAll(async () => {
    enteringSetup("migrations");
    await runMigrations(PG_TEST_URL);
    enteringSetup("fixture client setup");
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {}, debug: () => { sent++; } });
    db = brandDialect(drizzle(client, { schema }), "pg");
    accountId = await seedLargeAccount();
    pendingSetup = null;
  }, 240_000);
  afterAll(async () => {
    if (pendingSetup) {
      const elapsed = Math.round(performance.now() - pendingSetup.startedAt);
      console.warn(`Large Ohbox fixture setup stopped during ${pendingSetup.phase} after ${elapsed} ms in that phase.`);
    }
    await closePooledDbs();
    await client?.end({ timeout: 5 });
  });

  it("one request reads every sender nobody decided about, and its statements follow the senders", async () => {
    const before = sent;
    const all = await unscreenedSummary(db as never, accountId, NOW);
    expect(all.complete).toBe(true);
    expect(all.next).toBeUndefined();
    expect(all.groups).toHaveLength(STRANGERS);
    expect(all.total).toBe(STRANGER_LETTERS);
    // The senders are five reads of the sender index and the strangers' letters four pages; the Ohbox is 403.
    expect(sent - before).toBeLessThanOrEqual(40);
  });

  it("a request out of time answers a part, and the next request goes on from it", async () => {
    // A clock that moves a tenth of a second at every reading: the budget ends inside a page.
    let t = 0;
    const clock = (): number => (t += 100);
    const parts: UnscreenedSummary[] = [];
    let after: string | undefined;
    do {
      const part = await unscreenedSummary(db as never, accountId, NOW, undefined, undefined, {
        budgetMs: 4_000, clock, ...(after === undefined ? {} : { after }),
      });
      // Every part stands somewhere new: a client asking again is never handed the same place.
      expect(part.next).not.toBe(after ?? null);
      parts.push(part);
      after = part.next;
    } while (after !== undefined && parts.length < 60);

    expect(parts.length).toBeGreaterThan(3);
    for (const part of parts.slice(0, -1)) expect(part.complete).toBe(false);
    // The budget is read before every letter's question, each of which may cost a statement: a part
    // holds no more letters than its 4 s have readings, never the rest of a page of 200.
    for (const part of parts) expect(part.total).toBeLessThanOrEqual(40);
    expect(parts[parts.length - 1]!.complete).toBe(true);
    const by = added(parts);
    expect(by.size).toBe(STRANGERS);
    expect([...by.values()].reduce((n, c) => n + c, 0)).toBe(STRANGER_LETTERS);
    // No letter twice: each sender holds the 3, 4 or 5 the seed gave them.
    expect(by.get("stranger0@unknown.test")).toBe(3);
    expect(by.get("stranger2@unknown.test")).toBe(5);
  });

  it("a part that left groups out says no next: going on would pass them by unshown", async () => {
    // Senders of one letter each, 450 of them, and a clock that ends the budget inside the second page.
    const id = randomUUID();
    const mailboxId = randomUUID();
    await client`insert into accounts (id, name) values (${id}, ${`wide-${id.slice(0, 8)}`})`;
    await client`insert into mailboxes (id, account_id, provider, address, organizer_role)
                 values (${mailboxId}, ${id}, 'imap', ${`me-${id.slice(0, 8)}@example.test`}, 'organizer')`;
    await client.begin(async (tx) => {
      await tx`create temp table wide_seed on commit drop as
               select gen_random_uuid() as id, 'wide' || lpad(k::text, 3, '0') || '@unknown.test' as sender from generate_series(0, 449) k`;
      await tx`
        insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address,
                              date, created_at, arrived_at, unread, native_locator)
        select id, ${id}::uuid, ${mailboxId}::uuid, 'h', 'wide:' || id, 'Note', sender,
               '2026-09-17T08:00:00Z'::timestamptz, '2026-09-17T08:00:00Z'::timestamptz, '2026-09-17T08:00:00Z'::timestamptz,
               false, '{"folder":"INBOX","ref":"1:1"}'::jsonb
          from wide_seed`;
      await tx`
        insert into folder_state (message_id, account_id, desired_folder, observed_folder, last_set_by, reconcile_status, conflict)
        select id, ${id}::uuid, 'INBOX', 'INBOX', 'external', 'reconciled', false from wide_seed`;
    });
    let t = 0;
    const part = await unscreenedSummary(db as never, id, NOW, undefined, undefined, { budgetMs: 3_000, clock: () => (t += 10) });
    expect(part.groups).toHaveLength(200);
    expect(part.complete).toBe(false);
    expect(part.next).toBeUndefined();
  });

  it("what is not the next of an earlier answer is refused", async () => {
    // The second: 36 characters of hex and hyphens that are no id, at a sender whose mail the walk
    // reads at once: the store's own cast refuses them too, a statement later.
    const noId = JSON.stringify(["stranger0@unknown.test", "0123456-789ab-cdef-0123-456789abcdef"]);
    for (const after of ["somewhere", noId]) {
      await expect(unscreenedSummary(db as never, accountId, NOW, undefined, undefined, { after }))
        .rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
    }
  });

  it("four reads at once leave connections for every other route", async () => {
    // The hosted handle, four connections, named so this file can count its own backends.
    const name = `walk-pool-${randomUUID().slice(0, 8)}`;
    const url = new URL(PG_TEST_URL);
    url.searchParams.set("application_name", name);
    const pooled = makePooledDb(url.toString(), { acquireTimeoutMs: 1_500 });
    const held = () => client<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity where application_name = ${name} and wait_event_type = 'Lock'`;

    // Every walk reads the list addresses in its second statement: a lock there holds each one
    // inside a statement, on a connection, for as long as the lock stands.
    const lock = await client.reserve();
    await lock`begin`;
    await lock`lock table list_addresses in access exclusive mode`;
    let reads: Promise<UnscreenedSummary>[] = [];
    try {
      reads = [0, 1, 2, 3].map(() =>
        unscreenedSummary(pooled as never, accountId, NOW, undefined, undefined, { budgetMs: 60_000 }));
      for (const r of reads) r.catch(() => { /* awaited below */ });
      for (let i = 0; i < 100 && (await held())[0]!.n < 2; i++) await tick(50);
      await tick(400);

      // A request of another route, the mailboxes' read: answered, because two connections are free.
      const other = await pooled.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.accountId, accountId));
      expect(other).toHaveLength(1);
      // Two reads walk; the other two wait their turn and hold nothing.
      expect((await held())[0]!.n).toBe(2);
    } finally {
      await lock`commit`;
      lock.release();
    }
    const answers = await Promise.all(reads);
    for (const a of answers) expect(a.total).toBe(STRANGER_LETTERS);
  }, 60_000);

  /* THE AGREE'S SWEEP MOVES ON PAST LETTERS THE PERSON ANSWERED. One page a slice is the desktop's
     sizing, 25 the hosted worker's and the phone's. Each row: the letters newest first, the sizing,
     and what each slice moves; the last slice ends the sweep. */
  it.each<[name: string, flags: string, sizing: { pages?: number; slice?: number }, slices: number[]]>([
    ["one page a slice: a full page of answered letters, then 80 that are owed", answered(220) + owed(80), { pages: 1 }, [0, 80]],
    ["one page a slice: two full pages of answered letters in a row", answered(420) + owed(30), { pages: 1 }, [0, 0, 30]],
    ["one page a slice: pages that mix both and end on an answered letter", "01".repeat(250), { pages: 1 }, [100, 100, 50]],
    ["one page a slice: the mailbox ends on a full page of answered letters", owed(200) + answered(200), { pages: 1 }, [200, 0, 0]],
    ["25 pages a slice, 50 letters a slice: the slice fills on the page after an answered one", answered(220) + owed(80), { slice: 50 }, [50, 30]],
    ["25 pages a slice: 5,000 answered letters in a row", answered(5020) + owed(30), {}, [0, 30]],
  ])("the agree's sweep, %s", async (_name, flags, sizing, slices) => {
    const a = await seedAgreed(flags);
    expect(await sweepToEnd(a, sizing)).toEqual(slices);
    // At the Screener: every owed letter and no answered one; one change row a letter, so none moved twice.
    const screened = await client<{ sender: string }[]>`
      select m.from_address as sender from messages m join folder_state fs on fs.message_id = m.id
       where m.account_id = ${a.id} and fs.desired_folder = 'ohmail/Screener' order by 1`;
    expect(screened.map((r) => r.sender)).toEqual([...flags].flatMap((f, rank) => (f === "0" ? [senderAt(rank)] : [])));
    const [changes] = await client<{ n: number }[]>`
      select count(*)::int as n from change_log where account_id = ${a.id} and op = 'move'`;
    expect(changes!.n).toBe(screened.length);
  }, 120_000);
});
