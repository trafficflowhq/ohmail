import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { messages } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { realPgAvailable } from "@trafficflow/db/testing";
import { MessageService, type ServiceContext } from "@trafficflow/services";
import type { ChangeBatch, ImapCursor } from "@trafficflow/core/adapters/imap";
import type { KnownLocator, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runSyncCycle, LeaderFencedError, type SyncDeps, type SyncWriteFence } from "@ohmail/organizer/sync";
import { KnownSetCache, estimateWireBytes, watchKnownSet } from "@ohmail/organizer/known-set";
import { makeHarness, rawClient, emlOf, byMessageId, DB_URL } from "../../../packages/organizer/test/_workerenv.js";
import { FIXTURE_LEASE } from "../../../packages/organizer/test/_door.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE KNOWN-SET MEMO, AGAINST REAL POSTGRES AND A REAL IMAP SERVER
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `apps/worker/test/known-set-cache.test.ts` pins the classification and the drop rules at the
 * seam. Four claims cannot be made there, and each of them is why this file exists:
 *
 *  1. **THE MEASUREMENT.** How many times a settled mailbox reads `listKnownLocators` per cycle,
 *     before and after — the number the whole slice is for. A stub cannot produce it, because the
 *     read count depends on what a REAL cycle writes, and a real cycle writes a folder cursor every
 *     single pass.
 *  2. **A CYCLE SERVED FROM THE MEMO DECIDES WHAT THE DATABASE WOULD HAVE DECIDED.** Asserted
 *     through the adapter's own batch: a settled mailbox produces no creates and no moves, which is
 *     exactly the statement "every UID we hold is in the known-set the adapter was handed".
 *  3. **THE API TIER CANNOT MOVE THIS PROJECTION.** The memo's soundness rests on `observed_seen ??
 *     !unread` being invariant under the read-state writes a DIFFERENT process performs, which is a
 *     property of five service methods and one `ON CONFLICT` clause. It is checked here by driving
 *     the real `MessageService`, with a negative control beside it so the assertion has teeth.
 *  4. **THE LEADERSHIP DROPS NAME THEIR EVENT.** `runSyncCycle` drops the memo on ANY throw, so a
 *     test that only asserted "cold afterwards" would stay green with every specific drop deleted.
 *     These assert the RECORDED REASON, which is the only thing that distinguishes recognising a
 *     handover from catching its symptom.
 */

const AVAILABLE = await realPgAvailable(DB_URL);

type Harness = Awaited<ReturnType<typeof makeHarness>>;

/** Count the reads that actually reach Postgres. The memo wraps THIS, so it counts misses only. */
function countingRepo(repo: WorkerRepo): { repo: WorkerRepo; reads: () => number } {
  let n = 0;
  const proxy = new Proxy(repo as object, {
    get(obj, prop): unknown {
      const value = Reflect.get(obj, prop);
      if (prop !== "listKnownLocators" || typeof value !== "function") return value;
      return (mailboxId: string): Promise<KnownLocator[]> => {
        n++;
        return (value as (id: string) => Promise<KnownLocator[]>).call(obj, mailboxId);
      };
    },
  }) as WorkerRepo;
  return { repo: proxy, reads: () => n };
}

/** Record what the adapter HANDED OVER — the observable that says whether the known-set was right. */
function countingAdapter(adapter: Harness["adapter"]) {
  const seen = { creates: 0, moves: 0, batches: 0 };
  const proxy = new Proxy(adapter as object, {
    get(obj, prop): unknown {
      const value = Reflect.get(obj, prop);
      if (prop !== "changesSince" || typeof value !== "function") {
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(obj) : value;
      }
      return async (cursor: ImapCursor): Promise<ChangeBatch> => {
        const batch = await (value as (c: ImapCursor) => Promise<ChangeBatch>).call(obj, cursor);
        seen.batches++;
        seen.creates += batch.creates.length;
        seen.moves += batch.moves.length;
        return batch;
      };
    },
  }) as Harness["adapter"];
  return { adapter: proxy, seen, reset: () => { seen.creates = 0; seen.moves = 0; seen.batches = 0; } };
}

/* The memo's own key for a locator, sorted so two sets compare. `\u0000` AS AN ESCAPE, never a raw
   byte: a literal NUL in source makes `file` call this module data and the repository's grep
   tooling skip the whole file. */
const sorted = (rows: ReadonlyArray<{ folder: string; uid: number; uidValidity: string }>): string[] =>
  rows.map((r) => `${r.folder}\u0000${r.uidValidity}:${r.uid}`).sort();

/** A reader that refuses: passed to `list` where the memo is not allowed to reach the database. */
const cold = async (): Promise<never> => { throw new Error("the memo went to the database"); };

async function drain(deps: SyncDeps, max = 12): Promise<void> {
  for (let i = 0; i < max; i++) {
    const { hasBacklog, owesFiling } = await runSyncCycle(deps);
    if (!hasBacklog && !owesFiling) return;
  }
}

describe.skipIf(!AVAILABLE)("known-set memo, on real Postgres", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  /**
   * ── 1. THE MEASUREMENT ────────────────────────────────────────────────────────────────────
   *
   * The same seeded mailbox, the same number of settled cycles, twice: once with the memo absent
   * (which is HEAD, and is also what the reconcile backstop still does) and once with it. The
   * numbers this prints are the before/after the slice is reported on.
   */
  it("HEAD re-reads the whole known-set every cycle; the memo reads it once", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const c = await rawClient(h.cfg);
    closers.push(async () => { await c.logout(); });

    for (let i = 0; i < 12; i++) {
      await c.append("INBOX", emlOf({ from: "anna@x.example", subject: `m${i}`, messageId: `meas${i}@x` }));
    }

    const cold = countingRepo(h.repo);
    const base: SyncDeps = {
      repo: cold.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      trustedAuthservIds: new Set<string>(),
    };
    await drain(base);

    // ── HEAD: no memo. Every settled cycle pays the read. ────────────────────────────────────
    const CYCLES = 5;
    const beforeHead = cold.reads();
    for (let i = 0; i < CYCLES; i++) await runSyncCycle(base);
    const headReads = cold.reads() - beforeHead;

    // ── THE MEMO: one read, then nothing. ────────────────────────────────────────────────────
    const cache = new KnownSetCache(h.mailboxId);
    const beforeMemo = cold.reads();
    for (let i = 0; i < CYCLES; i++) await runSyncCycle({ ...base, knownSet: cache });
    const memoReads = cold.reads() - beforeMemo;

    expect(headReads).toBe(CYCLES);
    expect(memoReads).toBe(1);

    const rows = await h.repo.listKnownLocators(h.mailboxId);
    const bytes = estimateWireBytes(rows);
    const census = cache.census();
    expect(census.rows).toBe(rows.length);
    /* WHAT WAS SAVED IS COMPUTED FROM THE READS THAT HAPPENED, not from the memo's own tally.
       It used to be `census.bytesSaved`, and that field can only move when something ASKS the
       memo — which was every cycle, when `buildCursor` re-derived the cursor from the rows every
       time. It does not any more: with the derivation still valid the cursor build does not reach
       for the projection at all, so four of these five cycles never ask, the memo never counts a
       hit, and its tally reads zero for a saving that got BIGGER. The claim is the same claim and
       the two lines above state it exactly — five reads become one — so the saving is stated from
       them, and the memo's tally is held to the part it can still see. */
    const saved = bytes * (CYCLES - memoReads);
    expect(census.bytesSaved).toBeLessThanOrEqual(saved);

    // eslint-disable-next-line no-console -- this test's whole purpose is the number it reports
    console.log(`[known-set] rows=${rows.length} bytes/read=${bytes} ` +
      `HEAD=${headReads} reads over ${CYCLES} cycles (${bytes * headReads} B) ` +
      `→ memo=${memoReads} read (${bytes * memoReads} B), saved ${saved} B ` +
      `(of which the memo itself served ${census.bytesSaved} B; the rest was never asked for)`);
  }, 60000);

  /**
   * ── 1b. AND THE SAME MEASUREMENT UNDER ARRIVING MAIL, WHICH IS THE HONEST ONE ─────────────
   *
   * THE RETIRED PREMISE, named because this case was written on it: a cycle that ingested a message
   * DROPPED the memo, so an arrival bought a re-read and `reads > 0` was how this file proved the
   * memo re-armed rather than drifting. `perf(sync): the engine keeps its known-set as it writes`
   * retired that — the ingest appends the row it committed — so the floor reads 0 for ever.
   *
   * What the floor stood for did not retire, it moved. A set kept across a write is sound only
   * while it stays EQUAL to the projection: a locator the memo holds and the database does not is a
   * UID this process never fetches again, which is mail lost rather than time. So the arrivals are
   * still real mail on a real server, and what is asked of them is the mechanism by its own recorded
   * reason — nothing dropped it, it followed every write — and then the equality.
   */
  it("mail arriving during the run is followed rather than re-read — and the memo still equals the database", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const c = await rawClient(h.cfg);
    closers.push(async () => { await c.logout(); });

    for (let i = 0; i < 6; i++) {
      await c.append("INBOX", emlOf({ from: "anna@x.example", subject: `seed${i}`, messageId: `traf-seed${i}@x` }));
    }
    const counted = countingRepo(h.repo);
    const cache = new KnownSetCache(h.mailboxId);
    const deps: SyncDeps = {
      repo: counted.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      trustedAuthservIds: new Set<string>(), knownSet: cache,
    };
    await drain(deps);
    expect(cache.warm, "the memo was cold before the arrivals — nothing below measures the cursor").toBe(true);

    const CYCLES = 30;
    const ARRIVALS = [5, 15, 25];
    const before = counted.reads();
    let appended = 0;
    const endedCold: number[] = [];
    for (let i = 0; i < CYCLES; i++) {
      if (ARRIVALS.includes(i)) {
        await c.append("INBOX", emlOf({ from: "anna@x.example", subject: `t${i}`, messageId: `traf${i}@x` }));
      }
      await runSyncCycle(deps);
      appended += cache.census().appended;
      if (!cache.warm) endedCold.push(i);
    }
    const reads = counted.reads() - before;

    // HEAD would have read on every one of the 30, and that ceiling stays exactly where it was.
    expect(reads).toBeLessThan(CYCLES / 2);
    /* THE MECHANISM, BY THE REASON THE MEMO RECORDS rather than by the count it produces — the
       distinction this file already draws at 4 and 4b. Nothing dropped it across the run, no cycle
       ended with it cold, and it took exactly one appended row per arrival. A cursor reverted to
       dropping on `insertMessage` can produce none of the three: the arrival cycles record that
       method as the dropper and end cold, and nothing is ever appended. */
    expect(cache.census().droppedBy).toBe(null);
    expect(endedCold, `the memo was cold after cycles ${endedCold.join(",")}`).toEqual([]);
    expect(appended).toBe(ARRIVALS.length);
    // ANTI-VACUITY, which is what the retired floor was really standing in for: a run that ingested
    // nothing would satisfy every line above, so the arrivals are looked up as mail.
    for (const i of ARRIVALS) {
      expect(await h.db.select().from(messages).where(byMessageId(h.mailboxId, `traf${i}@x`))).toHaveLength(1);
    }
    // AND THE INVARIANT THE KEPT SET RESTS ON, asked where the rows come out of Postgres: the
    // tuples, and the two columns a locator can agree on the UID and still lie about.
    const fromDb = await h.repo.listKnownLocators(h.mailboxId);
    const held = await cache.list(cold, h.mailboxId);
    expect(sorted(held)).toEqual(sorted(fromDb));
    const byRef = new Map(fromDb.map((r) => [`${r.folder}\u0000${r.uidValidity}:${r.uid}`, r]));
    for (const e of held) {
      const truth = byRef.get(`${e.folder}\u0000${e.uidValidity}:${e.uid}`)!;
      expect({ seen: e.seen, messageId: e.messageId }).toEqual({ seen: truth.seen, messageId: truth.messageId });
    }
    // eslint-disable-next-line no-console -- the number is the point
    console.log(`[known-set] ${CYCLES} cycles with ${ARRIVALS.length} arrivals: ` +
      `HEAD would read ${CYCLES}× — the memo read ${reads}× and appended ${appended} rows, ` +
      `ending at ${held.length} locators, equal to the database's`);
  }, 90000);

  /**
   * ── 1c. AND THE WRITE GROUP'S BRACKET, OVER A TRANSACTION POSTGRES ITSELF ROLLED BACK ─────
   *
   * A kept set may be believed only at a COMMIT, so `watchKnownSet` brackets `repo.transaction`
   * with `enterWrite`/`leaveWrite` and what a group buffered goes when the group does not commit.
   * `known-set-cursor.test.ts` asks that of the cache's own three calls; nothing asks it of the
   * WIRING, and the wiring is what a rollback meets. Here the transaction is real, the rollback is
   * Postgres's, and the move the memo was told about is one the database does not hold — the
   * lost-mail shape: an entry believed at a locator nothing wrote.
   */
  it("a group Postgres rolled back leaves nothing of itself in the memo", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const c = await rawClient(h.cfg);
    closers.push(async () => { await c.logout(); });

    await c.append("INBOX", emlOf({ from: "anna@x.example", subject: "rolled", messageId: "roll1@x" }));
    const cache = new KnownSetCache(h.mailboxId);
    /* The eight literals above omit `role` and run on the loop's own default, riding the fixture
       lease (an omitted authority is refused at the first write). This one runs on the same default
       deliberately — a different role would file this mailbox differently and the rollback is the
       subject — so it says so with a cast rather than adding a ninth entry to the ratchet's pin. */
    const deps = {
      repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId,
      storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE, trustedAuthservIds: new Set<string>(), knownSet: cache,
    } as unknown as SyncDeps;
    await drain(deps);
    expect(cache.warm).toBe(true);

    const [msg] = await h.db.select().from(messages).where(byMessageId(h.mailboxId, "roll1@x"));
    const from = msg!.nativeLocator as { folder: string; ref: string };
    const to = { folder: "ohmail/News", ref: `${from.ref.slice(0, from.ref.indexOf(":"))}:9001` };

    const watched = watchKnownSet(h.repo, cache);
    await expect(watched.transaction(async (tx) => {
      await tx.updateLocator(msg!.id, to, from);
      throw new Error("this group does not commit");
    })).rejects.toThrow("does not commit");

    // THE PREMISE OF EVERYTHING BELOW, read rather than assumed: Postgres really did roll it back.
    const [after] = await h.db.select().from(messages).where(eq(messages.id, msg!.id));
    expect((after!.nativeLocator as { ref: string }).ref).toBe(from.ref);
    // …and the memo kept nothing of the group, by the reason it records.
    expect(cache.census().droppedBy).toBe("a write group that did not commit");
    expect(sorted(await cache.list((id) => h.repo.listKnownLocators(id), h.mailboxId)))
      .toEqual(sorted(await h.repo.listKnownLocators(h.mailboxId)));
  }, 60000);

  /**
   * ── 2. A CYCLE SERVED FROM THE MEMO DECIDES WHAT THE DATABASE WOULD HAVE DECIDED ──────────
   *
   * MUTATION-WATCHED: delete `cache.drop(prop)` from `watchKnownSet` and this goes red with
   * `creates` at the message count — the memo would still be holding the empty set it was filled
   * with before the first ingest, so every UID this mailbox already stores reads as unknown and its
   * body is fetched again. That is the exact failure the memo exists not to cause, and it is
   * observable HERE and nowhere else, because `planChange` answers `duplicate` afterwards and the
   * database ends up looking identical either way.
   */
  it("a settled mailbox hands over nothing — the memo's known-set is the database's", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const c = await rawClient(h.cfg);
    closers.push(async () => { await c.logout(); });

    for (let i = 0; i < 4; i++) {
      await c.append("INBOX", emlOf({ from: "anna@x.example", subject: `s${i}`, messageId: `settle${i}@x` }));
    }

    const spy = countingAdapter(h.adapter);
    const cache = new KnownSetCache(h.mailboxId);
    const deps: SyncDeps = {
      repo: h.repo, adapter: spy.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      trustedAuthservIds: new Set<string>(), knownSet: cache,
    };

    await drain(deps);
    expect(spy.seen.creates).toBeGreaterThanOrEqual(4);

    spy.reset();
    for (let i = 0; i < 3; i++) await runSyncCycle(deps);
    expect(spy.seen.batches).toBe(3);
    expect(spy.seen.creates).toBe(0);
    expect(spy.seen.moves).toBe(0);
  }, 60000);

  /**
   * ── 2b. AND A NEW ARRIVAL STILL ARRIVES ───────────────────────────────────────────────────
   *
   * The other half of the same claim, and the one a memo gets wrong in the opposite direction: a
   * warm memo must not make the loop blind to mail that landed after it was filled. It cannot,
   * because the known-set only ever says "do not fetch THESE", and a UID nobody remembers is
   * unknown by construction — but "cannot by construction" is the kind of sentence this repository
   * has been wrong about before, so it is a test.
   */
  it("mail that arrives while the memo is warm is still ingested", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const c = await rawClient(h.cfg);
    closers.push(async () => { await c.logout(); });

    await c.append("INBOX", emlOf({ from: "anna@x.example", subject: "first", messageId: "warm1@x" }));
    const cache = new KnownSetCache(h.mailboxId);
    const deps: SyncDeps = {
      repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      trustedAuthservIds: new Set<string>(), knownSet: cache,
    };
    await drain(deps);
    await runSyncCycle(deps);                       // fills the memo with the settled set
    expect(cache.warm).toBe(true);

    await c.append("INBOX", emlOf({ from: "anna@x.example", subject: "second", messageId: "warm2@x" }));
    await drain(deps);

    expect(await h.db.select().from(messages).where(byMessageId(h.mailboxId, "warm2@x"))).toHaveLength(1);
  }, 60000);

  /**
   * ── 3. THE LEG THAT HAD TO BE CHECKED RATHER THAN ARGUED ──────────────────────────────────
   *
   * `listKnownLocators` reports `seen` as `flag_state.observed_seen ?? !messages.unread`, and the
   * API tier — a DIFFERENT PROCESS, outside every lease and every fence — writes `messages.unread`
   * whenever anyone marks mail read. If that moved the projection, the memo would be unsound and no
   * amount of care inside the worker could fix it.
   *
   * It does not, because every service that writes `unread` pairs it with a `flag_state` upsert
   * that supplies `observed_seen` ONLY on the insert and seeds it from the PRE-CHANGE `unread`,
   * deliberately omitting it from the `ON CONFLICT` set — `flag-intent.ts` says *"the worker owns
   * it"*. The real `MessageService.markSeen` is driven here rather than a copy of those two
   * statements, so a change to the service is a change to this guard.
   *
   * The NEGATIVE CONTROL is the second half and it is not decoration: a bare `UPDATE messages SET
   * unread` DOES move the projection. Without it, this test would pass just as well against a
   * projection that ignored read state entirely.
   */
  it("the API tier's read-state write cannot move `seen` — and a bare unread write can", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const c = await rawClient(h.cfg);
    closers.push(async () => { await c.logout(); });

    await c.append("INBOX", emlOf({ from: "anna@x.example", subject: "read me", messageId: "seen1@x" }));
    const deps: SyncDeps = {
      repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      trustedAuthservIds: new Set<string>(),
    };
    await drain(deps);

    const [msg] = await h.db.select().from(messages).where(byMessageId(h.mailboxId, "seen1@x"));
    const seenOf = async (): Promise<boolean | null> =>
      (await h.repo.listKnownLocators(h.mailboxId)).find((k) => k.messageId === "seen1@x")?.seen ?? null;

    const before = await seenOf();
    expect(before).toBe(false);                     // ingested unread

    const ctx: ServiceContext = {
      db: h.db, accountId: h.accountId, userId: null, now: () => new Date(), requestId: "r",
    };
    await new MessageService().markSeen(ctx, { ids: [msg!.id], unread: false });

    // The user has read it in the web app. The read model moved…
    const [after] = await h.db.select().from(messages).where(eq(messages.id, msg!.id));
    expect(after!.unread).toBe(false);
    // …and the known-set's flag BASELINE — what the SERVER was last observed holding — did not.
    expect(await seenOf()).toBe(before);

    // NEGATIVE CONTROL: the same column, written without the paired `flag_state` seed. This is
    // what the invariant above is protecting against, and it must be visible here or the
    // assertion above is vacuous.
    await h.db.execute(sql`delete from flag_state where message_id = ${msg!.id}`);
    await h.db.update(messages).set({ unread: true }).where(eq(messages.id, msg!.id));
    expect(await seenOf()).toBe(false);
    await h.db.update(messages).set({ unread: false }).where(eq(messages.id, msg!.id));
    expect(await seenOf()).toBe(true);
  }, 60000);

  /**
   * ── 4. THE LEADERSHIP DROPS, ASSERTED ON THE REASON ───────────────────────────────────────
   *
   * `runSyncCycle` drops the memo on any throw, which is the conservative backstop — and which is
   * also why these assert `droppedBy`. Delete the drop in `underFence`'s `lost()` arm and the
   * reason becomes `cycle-threw`: still cold, still safe, but the loop has stopped RECOGNISING a
   * handover and is only catching its symptom. That distinction is the difference between a rule
   * and a coincidence, so it is what the assertion names.
   */
  it("the lock-loss tripwire drops the memo, and says so", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const cache = new KnownSetCache(h.mailboxId);
    let lost = false;
    const fence: SyncWriteFence = {
      lost: () => lost,
      stillLeader: async () => !lost,
      async transaction(fn) { return { fenced: false, result: await fn(h.repo as never) }; },
    };
    const deps: SyncDeps = {
      repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      trustedAuthservIds: new Set<string>(), knownSet: cache, fence,
    };
    await runSyncCycle(deps);
    expect(cache.warm).toBe(true);

    lost = true;
    await expect(runSyncCycle(deps)).rejects.toBeInstanceOf(LeaderFencedError);
    expect(cache.warm).toBe(false);
    expect(cache.census().droppedBy).toBe("lease-lost");
  }, 60000);

  it("a fenced-out write drops the memo, and says so", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const cache = new KnownSetCache(h.mailboxId);
    let fenceOut = false;
    const fence: SyncWriteFence = {
      lost: () => false,
      stillLeader: async () => true,
      async transaction(fn) {
        if (fenceOut) return { fenced: true };
        return { fenced: false, result: await fn(h.repo as never) };
      },
    };
    const deps: SyncDeps = {
      repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      trustedAuthservIds: new Set<string>(), knownSet: cache, fence,
    };
    await runSyncCycle(deps);
    expect(cache.warm).toBe(true);

    fenceOut = true;
    await expect(runSyncCycle(deps)).rejects.toBeInstanceOf(LeaderFencedError);
    expect(cache.warm).toBe(false);
    expect(cache.census().droppedBy).toBe("fenced");
  }, 60000);

  /**
   * ── 4b. AND THE CONSERVATIVE BACKSTOP, ON A FAILURE THAT WROTE NOTHING ────────────────────
   *
   * A database fault on a READ reaches no drop site of its own: nothing was written, so no
   * classified method ran, and no fence refused. Only the catch-all in `runSyncCycle` can drop the
   * memo here — which is exactly the case the rule *"any ambiguity, drop it"* is for, because a
   * cycle that died mid-flight may have died between a write and this process learning its
   * outcome. MUTATION-WATCHED: remove the `catch` and this goes red with a memo still warm.
   */
  it("a cycle that throws drops the memo even when nothing was written", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const cache = new KnownSetCache(h.mailboxId);
    let fail = false;
    const repo = new Proxy(h.repo as object, {
      get(obj, prop): unknown {
        const value = Reflect.get(obj, prop);
        if (prop !== "listPendingFolderStates" || typeof value !== "function") return value;
        return (...args: unknown[]): unknown => {
          if (fail) throw new Error("the pooler dropped this connection");
          return (value as (...a: unknown[]) => unknown).apply(obj, args);
        };
      },
    }) as WorkerRepo;
    const deps: SyncDeps = {
      repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      trustedAuthservIds: new Set<string>(), knownSet: cache,
    };
    await runSyncCycle(deps);
    expect(cache.warm).toBe(true);

    fail = true;
    await expect(runSyncCycle(deps)).rejects.toThrow("pooler");
    expect(cache.warm).toBe(false);
    expect(cache.census().droppedBy).toBe("cycle-threw");
  }, 60000);
});
