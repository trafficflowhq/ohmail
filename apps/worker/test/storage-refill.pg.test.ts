import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray } from "drizzle-orm";
import { brandDialect, dialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, accountStorage, bodyBytesOf, changeLog, eraseOwedMailbox, mailboxes, messageBodies,
  messageInstances, messages, recomputeAccountStorage, recordChanges, stampMailboxErasure,
  EVICT_LOW_WATER_RATIO, type LedgerTx, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import {
  UNMETERED_STORAGE_CAP, createLogger, fingerprintDedupKey, messageFingerprint, normalizeMime,
  prepareHtmlForStorage, type StorageCap,
} from "@trafficflow/core";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { storageEvictPass } from "../src/storage-evict.js";
import {
  REFILL_ABSENT_RETRY_MS, REFILL_EVERY_MS, newRefillState, storageRefillPass, type StorageRefillDeps,
} from "../src/storage-refill.js";

/**
 * THE STORAGE REFILL ON REAL POSTGRES. Room appears (a bigger plan, the add-on, an erased mailbox)
 * and the newest emptied letters get their text back from the mail server, in bounded runs, never
 * past the trim's mark, and inside a trial's 4 GB floor never past the plan's own. Every claim is transactional bookkeeping: the counter
 * row is locked before the room is read, the body row is re-checked under its lock, and two
 * connections race for the last room. Seeded through the production writers (`insertMessageBody`,
 * the trim, the erasure); the fake mail server refuses every write.
 *
 * Mutations watched red, each restored: the room read as `used < cap` (room after an upgrade, the
 * run after a trim), as `used < mark` (the run after a trim), or before the counter lock (the last
 * room); no `storage_cap` re-check under the body lock (the crash); no identity check; no numeric
 * cap, erasure or import gate (no run); no decrement of `husked_for_space` (room after an upgrade).
 */

const AVAILABLE = await realPgAvailable();
const START = new Date("2026-10-25T08:00:00.000Z");
const MIN = 60_000;

interface Letter { id: string; mailboxId: string; uid: number; raw: string; text: string; at: Date; bytes: number }
interface World { accountId: string; mailboxIds: string[]; letters: Letter[] }

describe.skipIf(!AVAILABLE)("the storage refill against real Postgres", () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 6, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 120_000);

  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  const repoOf = (on = db): WorkerRepo & { transaction: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T> } =>
    makeDrizzleRepo(on as never) as never;

  const rng = (seed: number): (() => number) => {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  };

  function rawLetter(tag: string, i: number, at: Date, size: number, subject = `letter ${i}`): string {
    return [
      `From: sender-${i}@example.test`, "To: me@ohmail.test", `Subject: ${subject}`,
      `Message-ID: <refill-${tag}-${i}@example.test>`, `Date: ${at.toUTCString()}`,
      "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "",
      `letter ${i} ${"w".repeat(size)}`, "",
    ].join("\r\n");
  }

  /**
   * An account whose letters are stored through `insertMessageBody` (the counter moves with each),
   * one a week, `letters[0]` the oldest. Spread over `mailboxes`, every one past its first import.
   */
  async function seed(n: number, size: (i: number) => number, opts: { mailboxes?: number } = {}): Promise<World> {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    await db.insert(accounts).values({ id: accountId, name: `rf-${tag}` });
    const mailboxIds: string[] = [];
    for (let k = 0; k < (opts.mailboxes ?? 1); k++) {
      const [mb] = await db.insert(mailboxes).values({
        accountId, provider: "imap", address: `rf-${tag}-${k}@example.test`, status: "connected",
        initialImportCompletedAt: START,
      }).returning();
      mailboxIds.push(mb!.id);
    }
    const repo = repoOf();
    const letters: Letter[] = [];
    for (let i = 0; i < n; i++) {
      const mailboxId = mailboxIds[i % mailboxIds.length]!;
      const at = new Date(Date.UTC(2025, 0, 1) + i * 7 * 86_400_000);
      const raw = rawLetter(tag, i, at, size(i));
      const norm = await normalizeMime(Buffer.from(raw, "utf8"));
      const uid = 1_000 + i;
      const [m] = await db.insert(messages).values({
        accountId, mailboxId, dedupKey: fingerprintDedupKey(messageFingerprint(norm)),
        messageIdHeader: norm.canonical.messageIdHeader, fromAddress: norm.from.address, subject: norm.subject,
        bodyHash: norm.canonical.bodyHash, date: at, nativeLocator: { folder: "INBOX", ref: `1:${uid}` },
      }).returning();
      await db.insert(messageInstances).values({
        accountId, messageId: m!.id, mailboxId, folder: "INBOX", uid, uidvalidity: 1n, isPrimary: true,
      });
      const body = { text: norm.textBody, html: prepareHtmlForStorage(norm.htmlBody) };
      await repo.insertMessageBody!(m!.id, { ...body, headers: norm.headers }, { accountId, capBytes: null });
      letters.push({ id: m!.id, mailboxId, uid, raw, text: norm.textBody, at, bytes: bodyBytesOf(body) });
    }
    return { accountId, mailboxIds, letters };
  }

  /** The production trim at `cap`, until it has nothing more to do. */
  async function trim(w: World, cap: number): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const r = await storageEvictPass(db as unknown as Tx, { accountId: w.accountId, storageCap: async () => cap }, START);
      if (!r.capped) return;
    }
  }

  /** A mail server that holds `letters` by UID, can be told to answer otherwise, and refuses every write. */
  function server(letters: Letter[], opts: {
    uidValidity?: string; absent?: Set<number>; oversize?: Set<number>; bytes?: Map<number, string>;
  } = {}) {
    const asked: number[] = [];
    const adapter = {
      move: async () => { throw new Error("the refill must never move mail"); },
      setFlags: async () => { throw new Error("the refill must never flag mail"); },
      append: async () => { throw new Error("the refill must never append mail"); },
      fetchByUid: async (folder: string, uids: readonly number[]) => {
        asked.push(...uids);
        const v = opts.uidValidity ?? "1";
        const held = uids.filter((u) => !opts.absent?.has(u) && !opts.oversize?.has(u)
          && (opts.bytes?.has(u) || letters.some((l) => l.uid === u)));
        return {
          uidValidity: v,
          creates: held.map((u) => ({
            type: "create" as const, locator: { folder, ref: `${v}:${u}` },
            raw: Buffer.from(opts.bytes?.get(u) ?? letters.find((l) => l.uid === u)!.raw, "utf8"),
          })),
          absent: uids.filter((u) => !held.includes(u) && !opts.oversize?.has(u)),
          oversize: uids.filter((u) => opts.oversize?.has(u)),
        };
      },
    } as unknown as MailboxAdapter;
    return { adapter, asked };
  }

  const counterOf = async (accountId: string) => {
    const [row] = await db.select().from(accountStorage).where(eq(accountStorage.accountId, accountId));
    return row!;
  };
  /** What the stored letters really hold: their bytes and how many are emptied for space. */
  const realOf = async (accountId: string): Promise<{ bytes: number; husked: number }> => {
    const [r] = await sql<{ bytes: string; husked: string }[]>`
      select coalesce(sum(octet_length(b.text) + coalesce(octet_length(b.html), 0)), 0)::bigint as bytes,
             count(*) filter (where b.withheld_reason = 'storage_cap')::bigint as husked
        from message_bodies b join messages m on m.id = b.message_id where m.account_id = ${accountId}`;
    return { bytes: Number(r!.bytes), husked: Number(r!.husked) };
  };
  const cappedOf = async (ids: string[]): Promise<Set<string>> => new Set((await db.select({
    id: messageBodies.messageId, w: messageBodies.withheldReason,
  }).from(messageBodies).where(inArray(messageBodies.messageId, ids))).filter((b) => b.w === "storage_cap").map((b) => b.id));
  const updatesOf = async (accountId: string): Promise<Map<string, number>> => {
    const rows = await db.select({ id: changeLog.entityId }).from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.op, "update"), eq(changeLog.entityType, "message")));
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.id, (out.get(r.id) ?? 0) + 1);
    return out;
  };

  /** One run of the pass for the account's first mailbox, every write in its own transaction. */
  function refill(w: World, adapter: MailboxAdapter, cap: StorageCap, over: Partial<StorageRefillDeps> & { at?: Date } = {}) {
    const repo = repoOf();
    const { at, ...rest } = over;
    return storageRefillPass({
      repo, adapter, accountId: w.accountId, mailboxId: w.mailboxIds[0]!, storageCap: cap,
      write: (fn) => repo.transaction(fn), now: () => at ?? START, ...rest,
    });
  }

  const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    return { open, opened };
  };
  const sawLockWait = async (): Promise<boolean> => {
    for (let i = 0; i < 100; i++) {
      const [r] = await sql<{ n: string }[]>`
        select count(*)::bigint as n from pg_locks where not granted and locktype in ('transactionid', 'tuple')`;
      if (Number(r!.n) > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };

  for (const c of [
    { name: "an upgrade from 2 to 5 GB", factor: 2.5 },
    { name: "the storage add-on, 2 to 12 GB", factor: 6 },
  ]) {
    it(`room after ${c.name}: the newest emptied letters come back up to the mark, the oldest stay empty`, async () => {
      const r = rng(Math.round(c.factor * 1_000));
      const w = await seed(48, () => 300 + Math.floor(r() * 2_200));
      const total = w.letters.reduce((n, l) => n + l.bytes, 0);
      const small = Math.floor(total / 6);
      await trim(w, small);
      const before = await counterOf(w.accountId);
      const emptied = await cappedOf(w.letters.map((l) => l.id));
      expect(emptied.size).toBeGreaterThan(30);

      const cap = Math.floor(small * c.factor);
      const mark = Math.floor(cap * EVICT_LOW_WATER_RATIO);
      const repo = repoOf();
      // The counter after every write: the letters' writes, the one that did not fit, the recount.
      const seen: { bytes: number; husked: number }[] = [];
      const { adapter } = server(w.letters);
      const result = await refill(w, adapter, cap, {
        write: async (fn) => {
          const out = await repo.transaction(fn);
          const c = await counterOf(w.accountId);
          seen.push({ bytes: Number(c.bytes), husked: c.huskedForSpace });
          return out;
        },
      });

      expect(result.restored).toBeGreaterThan(0);
      expect(result.stopped).toBe("no_room");
      expect(Math.max(...seen.map((s) => s.bytes)), "the counter went past nine tenths of the plan").toBeLessThanOrEqual(mark);
      // Exact before the recount runs: each letter took its bytes and itself off the emptied count.
      expect(seen.at(-2), "the counter was off before the recount repaired it").toEqual(await realOf(w.accountId));
      const left = await cappedOf(w.letters.map((l) => l.id));
      const back = w.letters.filter((l) => emptied.has(l.id) && !left.has(l.id));
      expect(back).toHaveLength(result.restored);
      // Newest first: every letter that came back is newer than every letter still emptied.
      const newestLeft = Math.max(...w.letters.filter((l) => left.has(l.id)).map((l) => l.at.getTime()));
      expect(Math.min(...back.map((l) => l.at.getTime()))).toBeGreaterThan(newestLeft);
      expect(left.has(w.letters[0]!.id), "the oldest letter came back before newer ones").toBe(true);
      for (const l of back) {
        const [b] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, l.id));
        expect(b!.text).toBe(l.text);
      }
      // The next letter would not have fitted.
      const counter = await counterOf(w.accountId);
      const next = w.letters.filter((l) => left.has(l.id)).at(-1)!;
      expect(Number(counter.bytes) + next.bytes).toBeGreaterThan(mark);

      const real = await realOf(w.accountId);
      expect({ bytes: Number(counter.bytes), husked: counter.huskedForSpace }).toEqual(real);
      expect(Number(counter.recountDrift), "the recount after the run found drift").toBe(0);
      expect(counter.keptFrom! < before.keptFrom!, "the month text is kept from was not pulled back").toBe(true);
      const updates = await updatesOf(w.accountId);
      for (const l of back) expect(updates.get(l.id), "one update change per letter").toBe(1);
      expect([...updates.keys()].filter((id) => !back.some((l) => l.id === id))).toEqual([]);
    }, 60_000);
  }

  it("inside a trial's 4 GB floor only up to the plan's own limit: at its mark nothing, just under it exactly up to it", async () => {
    const w = await seed(12, () => 500);
    const per = w.letters[0]!.bytes;
    await trim(w, Math.ceil((3.5 * per) / EVICT_LOW_WATER_RATIO));
    const emptied = await cappedOf(w.letters.map((l) => l.id));
    expect(emptied.size).toBeGreaterThan(4);
    const used = Number((await counterOf(w.accountId)).bytes);
    // The floor has room for every letter; the plan's own limit is what the refill may fill.
    const floor = 10_000_000;
    /** The plan limit whose nine tenths are exactly `mark`, the refill's own arithmetic. */
    const planWithMark = (mark: number): number => {
      let p = Math.floor(mark / EVICT_LOW_WATER_RATIO) - 2;
      while (Math.floor(p * EVICT_LOW_WATER_RATIO) !== mark) p += 1;
      return p;
    };

    // At the plan's mark: nothing is fetched and nothing is written.
    const at = server(w.letters);
    const none = await refill(w, at.adapter, floor, { state: newRefillState(), planLimitBytes: planWithMark(used) });
    expect({ restored: none.restored, waited: none.waited }).toEqual({ restored: 0, waited: "no_room" });
    expect(at.asked).toEqual([]);
    expect(Number((await counterOf(w.accountId)).bytes)).toBe(used);
    expect(await cappedOf(w.letters.map((l) => l.id))).toEqual(emptied);

    // Just under it by the two newest emptied letters: exactly those come back, and the counter stops at the mark.
    const newest = w.letters.filter((l) => emptied.has(l.id)).slice(-2);
    const mark = used + newest.reduce((n, l) => n + l.bytes, 0);
    const under = await refill(w, server(w.letters).adapter, floor, {
      state: newRefillState(), planLimitBytes: planWithMark(mark), at: new Date(START.getTime() + MIN),
    });
    expect({ restored: under.restored, stopped: under.stopped }).toEqual({ restored: 2, stopped: "no_room" });
    const counter = await counterOf(w.accountId);
    expect(Number(counter.bytes), "the refill went past the plan's own limit inside the floor").toBe(mark);
    expect({ bytes: Number(counter.bytes), husked: counter.huskedForSpace }).toEqual(await realOf(w.accountId));
    const left = await cappedOf(w.letters.map((l) => l.id));
    expect(newest.filter((l) => left.has(l.id))).toEqual([]);
    expect(left.size).toBe(emptied.size - 2);

    // A plan limit above the cap never lifts the mark past the cap's.
    const over = await refill(w, server(w.letters).adapter, planWithMark(mark), {
      state: newRefillState(), planLimitBytes: floor, at: new Date(START.getTime() + 2 * MIN),
    });
    expect({ restored: over.restored, waited: over.waited }).toEqual({ restored: 0, waited: "no_room" });
  }, 60_000);

  it("after a mailbox is erased, the other mailbox gets its letters back up to the mark", async () => {
    const w = await seed(40, () => 600, { mailboxes: 2 });
    const [a, b] = w.mailboxIds as [string, string];
    const total = w.letters.reduce((n, l) => n + l.bytes, 0);
    const cap = Math.floor(total / 3);
    await trim(w, cap);
    await db.transaction(async (tx) => {
      await stampMailboxErasure(tx as unknown as Tx, { accountId: w.accountId, mailboxId: b, now: START });
    });
    const erased = await eraseOwedMailbox(db as unknown as Tx, dialect(db), {
      accountId: w.accountId, mailboxId: b, now: () => START, maxSteps: 20,
    });
    expect(erased.done).toBe(true);

    const mine = w.letters.filter((l) => l.mailboxId === a);
    const emptied = await cappedOf(mine.map((l) => l.id));
    const { adapter } = server(mine);
    const result = await refill(w, adapter, cap, { at: new Date(START.getTime() + MIN) });
    expect(result.restored).toBeGreaterThan(0);
    const counter = await counterOf(w.accountId);
    expect(Number(counter.bytes)).toBeLessThanOrEqual(Math.floor(cap * EVICT_LOW_WATER_RATIO));
    expect({ bytes: Number(counter.bytes), husked: counter.huskedForSpace }).toEqual(await realOf(w.accountId));
    const left = await cappedOf(mine.map((l) => l.id));
    const back = mine.filter((l) => emptied.has(l.id) && !left.has(l.id));
    expect(Math.min(...back.map((l) => l.at.getTime())))
      .toBeGreaterThan(Math.max(...mine.filter((l) => left.has(l.id)).map((l) => l.at.getTime())));
  }, 60_000);

  it("at most 200 letters a run, one run in ten minutes, and the day's bytes stop a run", async () => {
    const w = await seed(215, () => 100);
    await trim(w, 1_000);
    const before = await cappedOf(w.letters.map((l) => l.id));
    expect(before.size).toBeGreaterThan(205);
    const { adapter, asked } = server(w.letters);
    const state = newRefillState();
    const big = 10_000_000;

    const first = await refill(w, adapter, big, { state, runBudgetMs: 600_000 });
    expect({ fetched: first.fetched, restored: first.restored, capped: first.capped })
      .toEqual({ fetched: 200, restored: 200, capped: true });
    const soon = await refill(w, adapter, big, { state, runBudgetMs: 600_000, at: new Date(START.getTime() + 9 * MIN) });
    expect(soon.fetched, "a second run inside ten minutes").toBe(0);
    expect(asked).toHaveLength(200);
    const later = await refill(w, adapter, big, { state, runBudgetMs: 600_000, at: new Date(START.getTime() + REFILL_EVERY_MS) });
    expect(later.restored).toBe(before.size - 200);
    expect((await cappedOf(w.letters.map((l) => l.id))).size).toBe(0);

    // The day's bytes: a budget of six letters' raw bytes stops the run before its third chunk.
    const d = await seed(20, () => 100);
    await trim(d, 600);
    const day = server(d.letters);
    const budget = d.letters.slice(0, 6).reduce((n, l) => n + Buffer.byteLength(l.raw), 0);
    const dayState = newRefillState();
    const run = await refill(d, day.adapter, big, { state: dayState, bytesPerDay: budget });
    expect({ fetched: run.fetched, stopped: run.stopped }).toEqual({ fetched: 8, stopped: "day_budget" });
    const again = await refill(d, day.adapter, big, { state: dayState, bytesPerDay: budget, at: new Date(START.getTime() + REFILL_EVERY_MS) });
    expect(again.fetched, "the day's bytes were spent and a run fetched anyway").toBe(0);
    const tomorrow = await refill(d, day.adapter, big, {
      state: dayState, bytesPerDay: budget, at: new Date(START.getTime() + 24 * 60 * MIN + MIN),
    });
    expect(tomorrow.fetched).toBeGreaterThan(0);
  }, 120_000);

  it("the run after a trim puts nothing back; a letter that does not fit ends the run, and the next run fetches nothing", async () => {
    const w = await seed(30, () => 800);
    const total = w.letters.reduce((n, l) => n + l.bytes, 0);
    const cap = Math.floor(total / 2);
    await trim(w, cap);
    const before = await counterOf(w.accountId);
    const emptied = await cappedOf(w.letters.map((l) => l.id));
    const { adapter, asked } = server(w.letters);
    const state = newRefillState();

    const first = await refill(w, adapter, cap, { state });
    expect({ restored: first.restored, stopped: first.stopped ?? first.waited }).toEqual({ restored: 0, stopped: "no_room" });
    expect(first.fetched).toBeLessThanOrEqual(4);
    const after = await counterOf(w.accountId);
    expect({ bytes: Number(after.bytes), husked: after.huskedForSpace })
      .toEqual({ bytes: Number(before.bytes), husked: before.huskedForSpace });
    expect(await cappedOf(w.letters.map((l) => l.id))).toEqual(emptied);

    const fetchedSoFar = asked.length;
    const second = await refill(w, adapter, cap, { state, at: new Date(START.getTime() + REFILL_EVERY_MS) });
    expect(second.fetched).toBe(0);
    expect(asked).toHaveLength(fetchedSoFar);
    expect(await updatesOf(w.accountId)).toEqual(new Map());
  }, 60_000);

  it("a letter gone from the server, over the size limit, or under a new UIDVALIDITY stays empty", async () => {
    const w = await seed(2, () => 500);
    await trim(w, 100);
    const [gone, big] = w.letters as [Letter, Letter];
    expect((await cappedOf([gone.id, big.id])).size).toBe(2);
    const before = await counterOf(w.accountId);
    const state = newRefillState();
    const first = server(w.letters, { absent: new Set([gone.uid]), oversize: new Set([big.uid]) });
    const run = await refill(w, first.adapter, 10_000_000, { state });
    expect({ restored: run.restored, refused: run.refused }).toEqual({ restored: 0, refused: 2 });
    expect((await cappedOf([gone.id, big.id])).size).toBe(2);
    const after = await counterOf(w.accountId);
    expect({ bytes: after.bytes, husked: after.huskedForSpace }).toEqual({ bytes: before.bytes, husked: before.huskedForSpace });

    // Shelved: neither is asked again soon; the gone one after six hours, the oversize one not in this process.
    const soon = server(w.letters);
    await refill(w, soon.adapter, 10_000_000, { state, at: new Date(START.getTime() + REFILL_EVERY_MS) });
    expect(soon.asked).toEqual([]);
    const late = server(w.letters, { absent: new Set([gone.uid]) });
    await refill(w, late.adapter, 10_000_000, { state, at: new Date(START.getTime() + REFILL_ABSENT_RETRY_MS + MIN) });
    expect(late.asked).toEqual([gone.uid]);

    // A renumbered folder writes nothing; an unnamed one ends the run.
    const v = await seed(1, () => 500);
    await trim(v, 100);
    const vBefore = await counterOf(v.accountId);
    const renumbered = await refill(v, server(v.letters, { uidValidity: "2" }).adapter, 10_000_000, { state: newRefillState() });
    expect({ restored: renumbered.restored, deferred: renumbered.deferred }).toEqual({ restored: 0, deferred: 1 });
    const unnamed = await refill(v, server(v.letters, { uidValidity: "0" }).adapter, 10_000_000, { state: newRefillState() });
    expect({ restored: unnamed.restored, stopped: unnamed.stopped }).toEqual({ restored: 0, stopped: "epoch_unknown" });
    expect((await cappedOf([v.letters[0]!.id])).size).toBe(1);
    expect(Number((await counterOf(v.accountId)).bytes)).toBe(Number(vBefore.bytes));
  }, 60_000);

  it("bytes that are another letter's are never written into this one", async () => {
    const w = await seed(1, () => 500);
    await trim(w, 100);
    const [only] = w.letters as [Letter];
    const before = await counterOf(w.accountId);
    const lines: Record<string, unknown>[] = [];
    const log = createLogger({ service: "worker", level: "debug", sink: (line: string) => { lines.push(JSON.parse(line)); } });
    const other = rawLetter("someone-else", 9, only.at, 500, "a different letter");
    const run = await refill(w, server(w.letters, { bytes: new Map([[only.uid, other]]) }).adapter, 10_000_000, {
      state: newRefillState(), log,
    });
    expect({ restored: run.restored, refused: run.refused }).toEqual({ restored: 0, refused: 1 });
    const [body] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, only.id));
    expect({ w: body!.withheldReason, text: body!.text }).toEqual({ w: "storage_cap", text: "" });
    expect(Number((await counterOf(w.accountId)).bytes)).toBe(Number(before.bytes));
    expect(await updatesOf(w.accountId)).toEqual(new Map());
    const said = lines.find((l) => l.event === "storage_refill_identity_mismatch");
    expect(said, "the refusal was not said").toBeDefined();
    expect(Object.keys(said!).filter((k) => !["ts", "level", "service", "event", "mailboxId", "accountId", "messageId", "reason"].includes(k)))
      .toEqual([]);
  }, 60_000);

  it("a run that died mid-batch is finished by the next one, and no letter is counted twice", async () => {
    const w = await seed(10, () => 500);
    const per = w.letters[0]!.bytes;
    // The trim keeps the two newest letters; the bigger plan has room for six of the eight emptied.
    const small = Math.ceil((2.5 * per) / EVICT_LOW_WATER_RATIO);
    await trim(w, small);
    expect((await cappedOf(w.letters.map((l) => l.id))).size).toBe(8);
    const big = Math.ceil((8.5 * per) / EVICT_LOW_WATER_RATIO);
    const repo = repoOf();
    let writes = 0;
    const held = gate();
    const locked = gate();
    // The third write commits after the next run has read its page, and its run dies with it.
    const dying = refill(w, server(w.letters).adapter, big, {
      state: newRefillState(),
      write: async (fn) => {
        writes += 1;
        if (writes !== 3) return repo.transaction(fn);
        await repo.transaction(async (r) => { const out = await fn(r); locked.open(); await held.opened; return out; });
        throw new Error("the worker went away after its third write");
      },
    });
    await locked.opened;
    const successor = refill(w, server(w.letters).adapter, big, { state: newRefillState(), at: new Date(START.getTime() + MIN) });
    expect(await sawLockWait(), "the next run never waited on the dying run's counter").toBe(true);
    held.open();
    const [a, b] = await Promise.allSettled([dying, successor]);
    expect(a.status).toBe("rejected");
    expect(b.status, String((b as PromiseRejectedResult).reason)).toBe("fulfilled");
    expect((b as PromiseFulfilledResult<{ raced: number }>).value.raced).toBe(1);

    const updates = await updatesOf(w.accountId);
    expect([...updates.values()].every((n) => n === 1), "a letter was refilled twice").toBe(true);
    expect(updates.size).toBe(6);
    const counter = await counterOf(w.accountId);
    expect({ bytes: Number(counter.bytes), husked: counter.huskedForSpace }).toEqual(await realOf(w.accountId));
    expect(counter.huskedForSpace).toBe(2);
  }, 60_000);

  it("no run: an unmetered cap, an erased account, an unfinished erasure, a mailbox on its first import", async () => {
    const w = await seed(6, () => 500);
    await trim(w, 1_000);
    const before = await counterOf(w.accountId);
    const emptied = await cappedOf(w.letters.map((l) => l.id));
    const { adapter, asked } = server(w.letters);
    const state = newRefillState();
    const at = (n: number) => new Date(START.getTime() + n * REFILL_EVERY_MS);
    const unchanged = async (why: string) => {
      expect(asked, why).toEqual([]);
      expect(Number((await counterOf(w.accountId)).bytes), why).toBe(Number(before.bytes));
      expect(await cappedOf(w.letters.map((l) => l.id)), why).toEqual(emptied);
    };

    await refill(w, adapter, UNMETERED_STORAGE_CAP, { state, at: at(0) });
    await unchanged("an unmetered cap");

    await db.update(accounts).set({ erasedAt: START }).where(eq(accounts.id, w.accountId));
    await refill(w, adapter, 10_000_000, { state, at: at(1) });
    await unchanged("an erased account");
    await db.update(accounts).set({ erasedAt: null }).where(eq(accounts.id, w.accountId));

    const [erasing] = await db.insert(mailboxes).values({
      accountId: w.accountId, provider: "imap", address: `rf-erasing-${randomUUID().slice(0, 6)}@example.test`,
      status: "disabled", erasedAt: START, initialImportCompletedAt: START,
    }).returning();
    await refill(w, adapter, 10_000_000, { state, at: at(2) });
    await unchanged("an unfinished erasure");
    await db.update(mailboxes).set({ erasureDoneAt: START }).where(eq(mailboxes.id, erasing!.id));

    const [importing] = await db.insert(mailboxes).values({
      accountId: w.accountId, provider: "imap", address: `rf-importing-${randomUUID().slice(0, 6)}@example.test`,
      status: "error",
    }).returning();
    await refill(w, adapter, 10_000_000, { state, at: at(3) });
    await unchanged("a mailbox still on its first import");

    // The control: the same run with the import finished does refill.
    await db.update(mailboxes).set({ initialImportCompletedAt: START }).where(eq(mailboxes.id, importing!.id));
    const ran = await refill(w, adapter, 10_000_000, { state, at: at(4) });
    expect(ran.restored).toBe(emptied.size);
  }, 60_000);

  describe("two connections", () => {
    let one: ReturnType<typeof postgres>;
    let two: ReturnType<typeof postgres>;
    beforeAll(() => {
      one = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
      two = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    });
    afterAll(async () => { await one?.end({ timeout: 5 }); await two?.end({ timeout: 5 }); });
    const on = (client: ReturnType<typeof postgres>) => brandDialect(drizzle(client, { schema }), "pg");

    /** The letter's text back through the shared write, inside the caller's transaction. */
    async function refillIn(tx: unknown, w: World, l: Letter, cap: number) {
      const fresh = await normalizeMime(Buffer.from(l.raw, "utf8"));
      const [m] = await (tx as typeof db).select().from(messages).where(eq(messages.id, l.id));
      return makeDrizzleRepo(tx as never).refillStorageCapBody!(w.accountId, l.mailboxId,
        { id: l.id, dedupKey: m!.dedupKey, messageIdHeader: m!.messageIdHeader }, fresh, cap);
    }
    /** A new letter arriving: its message, its body through the evicting reserve, then its change. */
    async function arrive(tx: unknown, w: World, cap: number, held?: { locked: () => void; until: Promise<void> }) {
      const t = tx as typeof db;
      const [m] = await t.insert(messages).values({
        accountId: w.accountId, mailboxId: w.mailboxIds[0]!, bodyHash: randomUUID(), dedupKey: randomUUID(),
        subject: "arriving", date: new Date(Date.UTC(2026, 9, 1)),
      }).returning();
      await makeDrizzleRepo(tx as never).insertMessageBody!(m!.id,
        { text: "n".repeat(3_000), html: null, headers: {} }, { accountId: w.accountId, capBytes: cap });
      held?.locked();
      if (held) await held.until;
      await recordChanges(tx as unknown as LedgerTx, [{
        accountId: w.accountId, entityType: "message", entityId: m!.id, op: "create", meta: null,
      }]);
    }

    for (const first of ["ingest", "refill"] as const) {
      it(`a refill and an arrival at the cap, the ${first} holding the counter first: no deadlock, the counter exact`, async () => {
        const w = await seed(8, () => 500);
        const per = w.letters[0]!.bytes;
        const cap = Math.ceil((6.5 * per) / EVICT_LOW_WATER_RATIO);
        await trim(w, Math.ceil((5.5 * per) / EVICT_LOW_WATER_RATIO));
        const left = await cappedOf(w.letters.map((l) => l.id));
        const target = w.letters.filter((l) => left.has(l.id)).at(-1)!;
        const held = gate();
        const locked = gate();
        const firstRun = first === "ingest"
          ? on(one).transaction((tx) => arrive(tx, w, cap, { locked: locked.open, until: held.opened }))
          : on(one).transaction(async (tx) => { const out = await refillIn(tx, w, target, cap); locked.open(); await held.opened; return out; });
        await locked.opened;
        const secondRun = first === "ingest"
          ? on(two).transaction((tx) => refillIn(tx, w, target, cap))
          : on(two).transaction((tx) => arrive(tx, w, cap));
        expect(await sawLockWait(), "the second writer never waited on the counter").toBe(true);
        held.open();
        const [a, b] = await Promise.allSettled([firstRun, secondRun]);
        expect([a.status, b.status], String((a as PromiseRejectedResult).reason ?? (b as PromiseRejectedResult).reason))
          .toEqual(["fulfilled", "fulfilled"]);
        const counter = await counterOf(w.accountId);
        expect({ bytes: Number(counter.bytes), husked: counter.huskedForSpace }).toEqual(await realOf(w.accountId));
      }, 60_000);
    }

    it("two refills racing for the last room: exactly one lands", async () => {
      const w = await seed(8, () => 500);
      const per = w.letters[0]!.bytes;
      await trim(w, Math.ceil((3.5 * per) / EVICT_LOW_WATER_RATIO));
      const left = await cappedOf(w.letters.map((l) => l.id));
      const [x, y] = w.letters.filter((l) => left.has(l.id)).slice(-2) as [Letter, Letter];
      const used = Number((await counterOf(w.accountId)).bytes);
      // Room for one more letter and a half.
      const cap = Math.ceil((used + 1.5 * per) / EVICT_LOW_WATER_RATIO);
      const held = gate();
      const locked = gate();
      const racerA = on(one).transaction(async (tx) => { const out = await refillIn(tx, w, y, cap); locked.open(); await held.opened; return out; });
      await locked.opened;
      const racerB = on(two).transaction((tx) => refillIn(tx, w, x, cap));
      expect(await sawLockWait()).toBe(true);
      held.open();
      const outcomes = (await Promise.all([racerA, racerB])).map((o) => o.outcome).sort();
      expect(outcomes).toEqual(["no_room", "refilled"]);
      const counter = await counterOf(w.accountId);
      expect(Number(counter.bytes)).toBeLessThanOrEqual(Math.floor(cap * EVICT_LOW_WATER_RATIO));
      expect({ bytes: Number(counter.bytes), husked: counter.huskedForSpace }).toEqual(await realOf(w.accountId));
    }, 60_000);
  });

  it("the walk's read does not scan message_bodies (measured, with seqscan priced out)", async () => {
    // Another account holds many emptied letters, this one many kept letters and a few emptied ones.
    const other = await seed(1, () => 10);
    const ins = await db.insert(messages).values(Array.from({ length: 400 }, (_, i) => ({
      accountId: other.accountId, mailboxId: other.mailboxIds[0]!, bodyHash: `o${i}`, dedupKey: `${other.accountId}:${i}`,
      subject: "o", date: new Date(Date.UTC(2024, 0, 1, 0, i)),
    }))).returning({ id: messages.id });
    await db.insert(messageBodies).values(ins.map((m) => ({ messageId: m.id, text: "", withheldReason: "storage_cap" as const, headers: {} })));
    const w = await seed(300, () => 50);
    const total = w.letters.reduce((n, l) => n + l.bytes, 0);
    // Just inside the trim's band: the trim empties the oldest few, the rest keep their text.
    await trim(w, Math.floor(total / 0.95));
    expect((await cappedOf(w.letters.map((l) => l.id))).size).toBeGreaterThan(5);
    await sql`analyze messages`;
    await sql`analyze message_bodies`;
    await sql`analyze message_instances`;

    const seen: { query: string; params: unknown[] }[] = [];
    const logged = brandDialect(drizzle(sql, { schema, logger: { logQuery: (query, params) => { seen.push({ query, params }); } } }), "pg");
    const repo = makeDrizzleRepo(logged as never);
    const page = await repo.listStorageCapHusks!(w.accountId, w.mailboxIds[0]!, { limit: 50 });
    expect(page.length).toBeGreaterThan(0);
    await repo.listStorageCapHusks!(w.accountId, w.mailboxIds[0]!, { limit: 50, before: { at: page[0]!.at, id: page[0]!.messageId } });
    expect(seen).toHaveLength(2);
    for (const { query, params } of seen) {
      const plan = await sql.begin(async (tx) => {
        await tx`set local enable_seqscan = off`;
        return tx.unsafe(`explain ${query}`, params as never[]);
      });
      const text = plan.map((row) => String((row as Record<string, unknown>)["QUERY PLAN"])).join("\n");
      expect(text).not.toMatch(/Seq Scan on message_bodies/);
    }
  }, 60_000);
});
