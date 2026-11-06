import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { UNMETERED_STORAGE_CAP, type ClassifierPort, type Logger, type StorageCap } from "@trafficflow/core/mail";
import { contacts, mailboxes, messageInstances, messages, rules, threads, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { newCycleCensus, runSyncCycle, type SyncDeps } from "../src/sync.js";
import { ingestRunRepository } from "../src/ingest-run.js";
import { INGEST_RUN_BOUNDS } from "../src/config.js";
import { KnownSetCache } from "../src/known-set.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A RUN STORES EXACTLY WHAT ONE TRANSACTION PER LETTER STORES. The worker's import commits runs of new
 * letters in one transaction each (`ingest-run.ts`); every row, search document, thread, folder row,
 * counter and delta must come out as the per-letter path writes them, in the same order. The page
 * below is fed to two fresh stores, runs off and runs on, and their canonical dumps compared.
 */

const ACCOUNT = "00000000-0000-4000-8000-0000000a1e01";
const OTHER_ACCOUNT = "00000000-0000-4000-8000-0000000a1e02";
const OWN = "mila@lichtgrat.example";

type Deliver = NonNullable<Parameters<FakeAdapterFleet["behave"]>[1]["deliver"]>[number];

/** A whole source, so a fixture can leave out the Message-ID or carry its own parts. */
function src(lines: string[], body = "hello"): Buffer {
  return Buffer.from([...lines, "", body].join("\r\n"));
}

let day = 0;
/** A distinct, increasing Date line, so the storage window's order never ties. */
const dated = (): string => `Date: ${new Date(Date.UTC(2024, 0, 1, 8, 0, day++)).toUTCString()}`;
const filler = (n: number): string => "word ".repeat(Math.ceil(n / 5)).slice(0, n);

/** A plain letter. */
function letter(id: string, from: string, extra: string[] = [], body = filler(900), folder?: string): Deliver {
  return {
    from, subject: `about ${id}`, messageId: id, ...(folder !== undefined ? { folder } : {}),
    raw: src([`Message-ID: <${id}>`, `From: ${from}`, `To: ${OWN}`, dated(), ...extra, `Subject: about ${id}`, "Content-Type: text/plain"], body),
  };
}

const SEED: Deliver[] = [
  letter("p-stored@x.example", "a@x.example"),
  letter("seed-2@x.example", "b@x.example"),
];

/** One page holding every shape a run meets. */
function page(): Deliver[] {
  const first = letter("a@x.example", "a@x.example");
  return [
    first,
    // A reply to the letter just before it: the run is committed before this one is planned.
    letter("b@x.example", "b@x.example", ["In-Reply-To: <a@x.example>", "References: <a@x.example>"]),
    // A reply to a stored letter: it joins that thread and widens it.
    letter("c@x.example", "c@x.example", ["In-Reply-To: <p-stored@x.example>"]),
    // A reply to that reply alone: its parent's conversation, not one rooted at the parent.
    letter("c2@x.example", "c2@x.example", ["In-Reply-To: <c@x.example>"]),
    // A reply ahead of its parent, then the parent: one thread from the root they share.
    letter("d@x.example", "d@x.example", ["In-Reply-To: <e@x.example>", "References: <e@x.example>"]),
    letter("e@x.example", "e@x.example"),
    // Two letters on a root nobody stored.
    letter("f@x.example", "f@x.example", ["References: <root-fg@x.example>"]),
    letter("g@x.example", "g2@x.example", ["References: <root-fg@x.example>"]),
    // No Message-ID at all: a thread of its own.
    { from: "h@x.example", subject: "no id", messageId: "none-h", raw: src([`From: h@x.example`, `To: ${OWN}`, dated(), "Subject: no id", "Content-Type: text/plain"], filler(700)) },
    // A file and an HTML part.
    {
      from: "i@x.example", subject: "with a file", messageId: "i@x.example",
      raw: src([
        "Message-ID: <i@x.example>", "From: i@x.example", `To: ${OWN}`, dated(), "Subject: with a file",
        'Content-Type: multipart/mixed; boundary="B"',
      ], [
        "--B", 'Content-Type: multipart/alternative; boundary="A"', "",
        "--A", "Content-Type: text/plain", "", "plain words", "--A", "Content-Type: text/html", "", "<p>html words</p>", "--A--",
        "--B", 'Content-Type: application/pdf; name="report.pdf"', 'Content-Disposition: attachment; filename="report.pdf"',
        "Content-Transfer-Encoding: base64", "", Buffer.from("%PDF-1.4 fake").toString("base64"), "--B--",
      ].join("\r\n")),
    },
    // Refused on size: stored as its header block, a `too_large` husk.
    { ...letter("j@x.example", "j@x.example", [], ""), oversizeBytes: 90_000_000 },
    // A list letter: its list address ends the run it is in.
    letter("k@x.example", "list@x.example", ["List-Post: <mailto:list@x.example>", "List-Id: <x.example>"]),
    // The account's own Sent copy, then a reply citing it in the same page.
    { ...letter("l-sent@x.example", OWN, [], filler(400), "Sent"), ownAuthored: true },
    letter("m@x.example", "a@x.example", ["In-Reply-To: <l-sent@x.example>"]),
    // One letter in two folders: the second copy is the stored one's.
    { ...first, folder: "Archive" },
    // A delivery report quoting a letter of this page.
    {
      from: "mailer-daemon@x.example", subject: "Undelivered Mail Returned to Sender", messageId: "dsn@x.example",
      raw: src([
        "Message-ID: <dsn@x.example>", "From: mailer-daemon@x.example", `To: ${OWN}`, dated(),
        "Subject: Undelivered Mail Returned to Sender",
        'Content-Type: multipart/report; report-type=delivery-status; boundary="R"',
      ], [
        "--R", "Content-Type: text/plain", "", "could not deliver",
        "--R", "Content-Type: message/delivery-status", "", "Reporting-MTA: dns; x.example", "", "Final-Recipient: rfc822; z@y.example", "Action: failed", "Status: 5.1.1",
        "--R", "Content-Type: text/rfc822-headers", "", "Message-ID: <l-sent@x.example>", `From: ${OWN}`, "--R--",
      ].join("\r\n")),
    },
    // Letters from a folder the person made.
    { ...letter("p@x.example", "p@y.example", [], filler(600), "Projects"), passive: true },
    { ...letter("q@x.example", "q@y.example", [], filler(600), "Projects"), passive: true },
    // A known sender with no rule: the model is asked, so it commits alone.
    letter("r@known.example", "pal@known.example"),
    // Strangers: held at the Screener, each a move the filing makes.
    letter("s1@s.example", "s1@s.example"),
    letter("s2@s.example", "s2@s.example"),
    // And enough letters that the storage cap is crossed inside the page.
    ...Array.from({ length: 12 }, (_, n) => letter(`t${n}@x.example`, `t${n % 3}@x.example`, [], filler(1500))),
  ];
}

const MODEL: ClassifierPort = {
  async classify() { return { destination: "ohmail/News", confidence: 0.5, rationale: "news", spam: false }; },
};

/** Every event the cycle logged, by name. */
function recorder(): Logger & { events: string[] } {
  const events: string[] = [];
  const log = {
    level: "debug" as const, events,
    child: () => log,
    debug: (e: string) => { events.push(e); }, info: (e: string) => { events.push(e); },
    warn: (e: string) => { events.push(e); }, error: (e: string) => { events.push(e); },
  };
  return log as unknown as Logger & { events: string[] };
}

interface Store {
  db: Tx;
  mailboxId: string;
  fleet: FakeAdapterFleet;
  log: Logger & { events: string[] };
  cycle(runs: boolean, cap: StorageCap, extra?: Partial<SyncDeps>): Promise<unknown>;
}

async function store(): Promise<Store> {
  const db = (await makeTestDb()) as unknown as Tx;
  const [mb] = await db.insert(mailboxes).values({ accountId: ACCOUNT, provider: "imap", address: OWN }).returning();
  await db.insert(rules).values({ accountId: ACCOUNT, kind: "domain", match: "x.example", destination: "INBOX", provenance: "manual", enabled: true, priority: 0 });
  await db.insert(rules).values({ accountId: ACCOUNT, kind: "domain", match: "y.example", destination: "INBOX", provenance: "manual", enabled: true, priority: 0 });
  await db.insert(contacts).values({ accountId: ACCOUNT, address: "pal@known.example", source: "person" });
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId: ACCOUNT, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials */ } },
  );
  const base = makeDrizzleRepo(db as never);
  const log = recorder();
  return {
    db, mailboxId: mb!.id, fleet, log,
    cycle: (runs, cap, extra = {}) => runSyncCycle({
      log,
      writeAuthority: FIXTURE_LEASE, role: "organizer", trustedAuthservIds: new Set<string>(),
      repo: runs ? ingestRunRepository(base) : base, adapter, accountId: ACCOUNT, mailboxId: mb!.id, storageCap: cap,
      classifier: MODEL,
      ...(runs ? { ingestRuns: INGEST_RUN_BOUNDS } : {}),
      ...extra,
    }),
  };
}

const rowsOf = async (db: Tx, q: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> =>
  ((await db.execute(q)) as unknown as { rows: Record<string, unknown>[] }).rows;

/** Everything the ingest wrote, with every id and clock replaced by what it names. */
async function dump(db: Tx): Promise<unknown> {
  const msgs = await rowsOf(db, sql`select id, dedup_key, thread_id, message_id_header, body_hash, subject, from_address,
    from_name, date, arrived_at, to_addresses, cc_addresses, native_locator, no_ai, no_forward, no_kb, priority, unread,
    snippet, sensitivity_category, has_attachments, attachment_count, auth_verdict, sender_check, sender_check_brand,
    sender_check_by, unconfirmed_hold, deleted_at from messages order by dedup_key`);
  const keyOf = new Map(msgs.map((m) => [String(m.id), String(m.dedup_key)]));
  const members = new Map<string, string[]>();
  for (const m of msgs) if (m.thread_id !== null) members.set(String(m.thread_id), [...(members.get(String(m.thread_id)) ?? []), String(m.dedup_key)]);
  const threadKey = (id: unknown): string => JSON.stringify((members.get(String(id)) ?? []).sort());
  const ref = (type: unknown, id: unknown): string => type === "message" ? `m:${keyOf.get(String(id))}`
    : type === "thread" ? `t:${threadKey(id)}` : String(type);
  const by = (rows: Record<string, unknown>[], f: (r: Record<string, unknown>) => unknown): unknown[] =>
    rows.map(f).map((r) => JSON.stringify(r)).sort();
  const seqs = await rowsOf(db, sql`select seq, entity_type, entity_id, op, meta from change_log where account_id = ${ACCOUNT}::uuid order by seq`);
  return {
    messages: msgs.map(({ id: _id, thread_id, ...rest }) => ({ ...rest, thread: threadKey(thread_id) })),
    instances: by(await rowsOf(db, sql`select message_id, folder, uidvalidity::text as uv, uid, is_primary from message_instances`),
      (r) => [keyOf.get(String(r.message_id)), r.folder, r.uv, r.uid, r.is_primary]),
    bodies: by(await rowsOf(db, sql`select message_id, text, html, withheld_reason, headers from message_bodies`),
      (r) => [keyOf.get(String(r.message_id)), r.text, r.html, r.withheld_reason, r.headers]),
    search: by(await rowsOf(db, sql`select message_id, terms, source, head_tsv::text as h, text_tsv::text as t from message_search`),
      (r) => [keyOf.get(String(r.message_id)), r.terms, r.source, r.h, r.t]),
    attachments: by(await rowsOf(db, sql`select message_id, filename, content_type, size_bytes, part_id, content_id, inline, content_sha256 from attachments`),
      (r) => [keyOf.get(String(r.message_id)), r.filename, r.content_type, r.size_bytes, r.part_id, r.content_id, r.inline, r.content_sha256]),
    folders: by(await rowsOf(db, sql`select message_id, desired_folder, observed_folder, last_set_by, reconcile_status, conflict, decided_at is null as undecided from folder_state`),
      (r) => [keyOf.get(String(r.message_id)), r.desired_folder, r.observed_folder, r.last_set_by, r.reconcile_status, r.conflict, r.undecided]),
    threads: by(await rowsOf(db, sql`select id, root_message_id_header, subject, participants, last_message_at from threads`),
      (r) => [threadKey(r.id), r.root_message_id_header, r.subject, r.participants, r.last_message_at]),
    changes: seqs.map((r) => [r.entity_type, r.op, ref(r.entity_type, r.entity_id), r.meta]),
    gapFree: seqs.every((r, i) => Number(r.seq) === Number(seqs[0]?.seq ?? 0) + i),
    storage: await rowsOf(db, sql`select bytes, husked_for_space, withheld_on_arrival from account_storage`),
    lists: by(await rowsOf(db, sql`select address, consented_brands from list_addresses`), (r) => [r.address, r.consented_brands]),
    contacts: by(await rowsOf(db, sql`select address, source from contacts`), (r) => [r.address, r.source]),
    audit: by(await rowsOf(db, sql`select action from audit_log`), (r) => r.action),
    routing: by(await rowsOf(db, sql`select message_id, destination, status from routing_decisions`), (r) => [keyOf.get(String(r.message_id)), r.destination, r.status]),
    approvals: by(await rowsOf(db, sql`select message_id, status from approvals`), (r) => [keyOf.get(String(r.message_id)), r.status]),
    failures: by(await rowsOf(db, sql`select folder, uid, code from message_failures`), (r) => [r.folder, r.uid, r.code]),
  };
}

/** Seed both stores alike (per letter), then ingest the page in the mode under test. */
async function ingestPage(runs: boolean, opts: { metered?: boolean } = {}): Promise<{ s: Store; moves: unknown[] }> {
  day = 0;
  const s = await store();
  s.fleet.behave(s.mailboxId, { deliver: SEED });
  await s.cycle(false, UNMETERED_STORAGE_CAP);
  const [used] = await rowsOf(s.db, sql`select bytes from account_storage`);
  // The cap falls inside the page: some letters store, the rest meet it.
  const cap = opts.metered === true ? Number(used?.bytes ?? 0) + 9_000 : UNMETERED_STORAGE_CAP;
  s.fleet.behave(s.mailboxId, { deliver: [...SEED, ...page()] });
  await s.cycle(runs, cap);
  // The filing's own order is not the ingest's: compared as a set.
  const moves = s.fleet.moves.map((m) => JSON.stringify([m.locator.folder, m.locator.ref, m.toFolder])).sort();
  return { s, moves };
}

describe("a run of new letters, against one transaction per letter", () => {
  it("stores the same rows, documents, threads, folder rows, counters and deltas, in the same order", async () => {
    const off = await ingestPage(false);
    const on = await ingestPage(true);
    const want = await dump(off.s.db);
    // The positive control: the page reached the store and every shape is in it.
    expect((want as { messages: unknown[] }).messages.length).toBeGreaterThan(30);
    expect((want as { gapFree: boolean }).gapFree).toBe(true);
    expect(await dump(on.s.db)).toEqual(want);
    expect(on.moves).toEqual(off.moves);
    // And it was the runs that stored it: none of them fell back to one letter at a time.
    expect(on.s.log.events).not.toContain("sync_ingest_run_fell_back");
  }, 120_000);

  it("stores the same across the storage cap, the letters past it committed alone", async () => {
    const off = await ingestPage(false, { metered: true });
    const on = await ingestPage(true, { metered: true });
    const want = await dump(off.s.db) as { bodies: string[] };
    // The control: the cap was crossed inside the page.
    expect(want.bodies.some((b) => b.includes("storage_cap"))).toBe(true);
    expect(await dump(on.s.db)).toEqual(want);
    expect(on.s.log.events).not.toContain("sync_ingest_run_fell_back");
  }, 120_000);
});

/** A fault of ours, as the database's dropped connection reads. */
const dropped = (): Error => Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });

/** Throw {@link dropped} from the `nth` statement whose text starts with `prefix`, once. */
function faultAt(db: Tx, prefix: string, nth = 1): { fired: () => boolean } {
  const client = (db as unknown as { $client: { query: (...a: unknown[]) => Promise<unknown>; transaction: (cb: (tx: { query: (...a: unknown[]) => Promise<unknown> }) => Promise<unknown>) => Promise<unknown> } }).$client;
  let seen = 0;
  let fired = false;
  const arm = (target: { query: (...a: unknown[]) => Promise<unknown> }): void => {
    const inner = target.query.bind(target);
    target.query = (...a: unknown[]): Promise<unknown> => {
      const text = String(a[0] ?? "").trim().toLowerCase();
      if (!fired && text.startsWith(prefix) && ++seen === nth) { fired = true; return Promise.reject(dropped()); }
      return inner(...(a as []));
    };
  };
  arm(client);
  const innerTx = client.transaction.bind(client);
  client.transaction = (cb) => innerTx((tx) => { arm(tx); return cb(tx); });
  return { fired: () => fired };
}

describe("a run that fails", () => {
  it("leaves nothing of itself behind, and the next cycle stores the page whole", async () => {
    const control = await ingestPage(true);
    day = 0;
    const s = await store();
    s.fleet.behave(s.mailboxId, { deliver: SEED });
    await s.cycle(false, UNMETERED_STORAGE_CAP);
    const before = await dump(s.db);
    s.fleet.behave(s.mailboxId, { deliver: [...SEED, ...page()] });
    // After the run's messages are written: the first instance statement of the page.
    const fault = faultAt(s.db, "insert into message_instances");
    await expect(s.cycle(true, UNMETERED_STORAGE_CAP)).rejects.toThrow(/administrator command/);
    expect(fault.fired()).toBe(true);
    expect(await dump(s.db), "the failed run left rows, a counter move or deltas").toEqual(before);
    await s.cycle(true, UNMETERED_STORAGE_CAP);
    const after = await dump(s.db) as { messages: Array<{ dedup_key: string }>; gapFree: boolean };
    expect(new Set(after.messages.map((m) => m.dedup_key)).size).toBe(after.messages.length);
    expect(after.gapFree).toBe(true);
    expect(after).toEqual(await dump(control.s.db));
  }, 120_000);

  it("keeps the runs committed before the one that failed", async () => {
    day = 0;
    const s = await store();
    s.fleet.behave(s.mailboxId, { deliver: SEED });
    await s.cycle(false, UNMETERED_STORAGE_CAP);
    const seeded = (await rowsOf(s.db, sql`select count(*)::int as n from messages`))[0]!.n as number;
    s.fleet.behave(s.mailboxId, { deliver: [...SEED, ...page()] });
    faultAt(s.db, "insert into message_instances", 2);
    await expect(s.cycle(true, UNMETERED_STORAGE_CAP)).rejects.toThrow(/administrator command/);
    // The first run (the page's first letter, ended by the reply to it) stands.
    const kept = await rowsOf(s.db, sql`select dedup_key from messages`);
    expect(kept.length).toBe(seeded + 1);
    expect((await dump(s.db) as { gapFree: boolean }).gapFree).toBe(true);
    await s.cycle(true, UNMETERED_STORAGE_CAP);
    const control = await ingestPage(true);
    expect(await dump(s.db)).toEqual(await dump(control.s.db));
  }, 120_000);

  it("commits the others alone when one letter's place is taken, and that one fails as it did alone", async () => {
    const outcome = async (runs: boolean): Promise<{ threw: boolean; dump: unknown }> => {
      day = 0;
      const s = await store();
      s.fleet.behave(s.mailboxId, { deliver: SEED });
      await s.cycle(false, UNMETERED_STORAGE_CAP);
      // Another message claims the place the page's first letter arrives at, while it is planned.
      const [squatter] = await s.db.select({ id: messages.id }).from(messages).where(sql`message_id_header = 'seed-2@x.example'`);
      const base = makeDrizzleRepo(s.db as never);
      let planned = 0;
      const claiming = new Proxy(runs ? ingestRunRepository(base) : base, {
        get(obj, prop): unknown {
          const value = Reflect.get(obj, prop, obj) as unknown;
          if (prop !== "findByDedupKeys" || typeof value !== "function") return value;
          return async (...a: unknown[]) => {
            if (++planned === 1) {
              await s.db.insert(messageInstances).values({
                accountId: ACCOUNT, mailboxId: s.mailboxId, messageId: squatter!.id, folder: "INBOX", uidvalidity: 1n, uid: 1002, isPrimary: false,
              });
            }
            return (value as (...b: unknown[]) => unknown).apply(obj, a);
          };
        },
      });
      s.fleet.behave(s.mailboxId, { deliver: [...SEED, ...page()] });
      const threw = await s.cycle(runs, UNMETERED_STORAGE_CAP, { repo: claiming }).then(() => false, () => true);
      return { threw, dump: await dump(s.db), fellBack: s.log.events.includes("sync_ingest_run_fell_back") };
    };
    const alone = await outcome(false);
    const run = await outcome(true);
    expect(run.fellBack, "the run never met the taken place").toBe(true);
    expect({ ...run, fellBack: false }).toEqual(alone);
  }, 120_000);
});

describe("the known-set across runs", () => {
  it("follows a run's letters, so the next cycle reads no locator", async () => {
    day = 0;
    const s = await store();
    const knownSet = new KnownSetCache(s.mailboxId);
    // Letters the rules admit where they are: a second copy, or a letter the filing moves, makes
    // the next cycle read again on either path.
    s.fleet.behave(s.mailboxId, { deliver: [...SEED, ...page().filter((m) => m.messageId.startsWith("t"))] });
    await s.cycle(true, UNMETERED_STORAGE_CAP, { knownSet });
    const census = newCycleCensus();
    await s.cycle(true, UNMETERED_STORAGE_CAP, { knownSet, census });
    expect(census.locatorReads, "the memo was dropped by the run").toBe(0);
    expect(census.observed, "the second cycle saw letters as new").toBe(0);
  }, 120_000);

  it("believes nothing of a run that rolled back", async () => {
    day = 0;
    const s = await store();
    const knownSet = new KnownSetCache(s.mailboxId);
    s.fleet.behave(s.mailboxId, { deliver: [...SEED, ...page()] });
    faultAt(s.db, "insert into message_instances");
    await expect(s.cycle(true, UNMETERED_STORAGE_CAP, { knownSet })).rejects.toThrow(/administrator command/);
    await s.cycle(true, UNMETERED_STORAGE_CAP, { knownSet });
    const stored = await rowsOf(s.db, sql`select count(*)::int as n from messages`);
    expect(stored[0]!.n).toBe(SEED.length + page().length - 1);
  }, 120_000);
});

describe("a run's threads stay inside the account", () => {
  it("starts its own thread for a reply citing another account's letter", async () => {
    day = 0;
    const s = await store();
    const [other] = await s.db.insert(mailboxes).values({ accountId: OTHER_ACCOUNT, provider: "imap", address: "o@else.example" }).returning();
    const [t] = await s.db.insert(threads).values({ accountId: OTHER_ACCOUNT, rootMessageIdHeader: "theirs@else.example", subject: "theirs" }).returning();
    await s.db.insert(messages).values({
      accountId: OTHER_ACCOUNT, mailboxId: other!.id, messageIdHeader: "theirs@else.example", bodyHash: "h",
      dedupKey: `x:${randomUUID()}`, threadId: t!.id, nativeLocator: { folder: "INBOX", ref: "1:1" },
    });
    s.fleet.behave(s.mailboxId, { deliver: [letter("mine@x.example", "a@x.example", ["In-Reply-To: <theirs@else.example>"])] });
    await s.cycle(true, UNMETERED_STORAGE_CAP);
    const [mine] = await rowsOf(s.db, sql`select thread_id from messages where account_id = ${ACCOUNT}::uuid`);
    expect(mine!.thread_id).not.toBeNull();
    expect(mine!.thread_id).not.toBe(t!.id);
    // Decided by the run itself, not by a letter committed alone after it.
    expect(s.log.events).not.toContain("sync_ingest_run_fell_back");
  }, 60_000);
});

describe("the rules a run is planned with", () => {
  it("are read once a run, so a rule made mid-run applies from the next run", async () => {
    day = 0;
    const s = await store();
    const letters = Array.from({ length: 6 }, (_, n) => letter(`z${n}@z.example`, "z@z.example"));
    s.fleet.behave(s.mailboxId, { deliver: letters });
    const base = ingestRunRepository(makeDrizzleRepo(s.db as never));
    let planned = 0;
    // The rule is made while the third letter is planned; runs hold three letters.
    const repo = new Proxy(base, {
      get(obj, prop): unknown {
        const value = Reflect.get(obj, prop, obj) as unknown;
        if (prop !== "findByDedupKeys" || typeof value !== "function") return value;
        return async (...a: unknown[]) => {
          if (++planned === 3) {
            await s.db.insert(rules).values({ accountId: ACCOUNT, kind: "sender", match: "z@z.example", destination: "INBOX", provenance: "manual", enabled: true, priority: 0 });
          }
          return (value as (...b: unknown[]) => unknown).apply(obj, a);
        };
      },
    });
    await s.cycle(true, UNMETERED_STORAGE_CAP, { repo, ingestRuns: { ...INGEST_RUN_BOUNDS, maxMembers: 3 } });
    const placed = await rowsOf(s.db, sql`select m.dedup_key, f.desired_folder from messages m join folder_state f on f.message_id = m.id order by m.created_at`);
    expect(placed.map((p) => p.desired_folder)).toEqual([
      "ohmail/Screener", "ohmail/Screener", "ohmail/Screener", "INBOX", "INBOX", "INBOX",
    ]);
  }, 60_000);
});
