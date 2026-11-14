import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freshDataDir } from "./_datadir.js";
import { and, eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { normalizeMime } from "@trafficflow/core";
import { changeLog, messageBodies, messageInstances, messages } from "@trafficflow/db";
import {
  createSidecar, LOCAL_NAME_BACKFILL_BATCH, LOCAL_NAME_BACKFILL_PAGES, type Sidecar,
} from "../src/engine.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE HISTORICAL-NAME REPAIR ON THE STANDALONE DOOR — a bounded visit at the drain's tail
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT WAS MISSING ──────────────────────────────────────────────────────────────────────
 *
 * `messages.from_name` went in after the messages that need it, and `to_addresses`/`cc_addresses`
 * had nothing writing them for just as long, so every row stored before that shows a bare address
 * where a sender's name belongs and no "To" line at all. A hosted account's rows were repaired in
 * the hosted database, and every mirror above it learned the corrected values as ordinary `/sync`
 * deltas. A STANDALONE install's store is nobody's mirror: it is the authority, no process outside
 * that machine has ever seen it, and nothing was ever going to reach it. The pass existed; it had
 * no caller on this side.
 *
 * ── WHY PGLITE, DESPITE THE HOUSE RULE ────────────────────────────────────────────────────
 *
 * `resurface-drain.test.ts` and `auto-suggest-drain.test.ts` both state it and it applies here
 * with the least ambiguity of the three: **PGlite IS production on the desktop, and this store is
 * the only one this repair will ever run against on this door.** `db.ts` opens it on disk under
 * the user's home, this opens the same store through the same `createSidecar`, and running these
 * claims against :5433 would measure a database no desktop install has.
 *
 * The claims PGlite genuinely cannot host are the CONCURRENT ones — the guarded UPDATE losing to a
 * writer that lands between the page read and the write — and they are not this door's: there is
 * one writer here. They are proved against real Postgres over THIS EXACT FUNCTION in
 * `apps/worker/test/sender-name-backfill.pg.test.ts`, which is the reason this door calls the
 * worker's pass rather than a copy of it.
 *
 * ── THE MUTATIONS, EACH RUN AND WATCHED FAIL, THEN RESTORED ───────────────────────────────
 *
 *  1. THE CALL. `await backfillStoredNames();` in `drain()` → `void backfillStoredNames;`.
 *     Six of the nine go red. The two that stay green are the two negative claims — a row nothing
 *     can be added to, and a row with no stored header — which is the correct behaviour of a pass
 *     that is not running at all, and is why neither of them is left to carry a positive claim.
 *  2. THE READ-TIME CHECK. `if (row.fromName === null)` in the pass → `if (true)`. One goes red,
 *     and on the RECIPIENTS rather than on the name: the guarded UPDATE now matches nothing, so
 *     the whole row is lost. Drop the `is null` guard as well and the same test goes red on the
 *     name being overwritten instead. Both were run.
 *  3. INVENTING A NAME. Add `else if (parsed.from?.address) fill.fromName = <the local part>`.
 *     Two go red: the row that had no display name comes back with one, and the store whose front
 *     is permanently nameless suddenly fills up.
 *  4. THE BUDGET. Remove `maxRows` from the call. Three go red — one drain does the whole store,
 *     which is precisely the fresh-boot cost this bound exists to prevent.
 *  5. THE WALK POSITION. Stop passing `startAfterId`. One goes red, and only one: it is the store
 *     built to expose it. Everywhere else a restarting walk still converges, which is exactly why
 *     that test had to be built rather than assumed.
 *  6. THE ORDER. Move the call above the cycle loop. One goes red, on a trace reading
 *     `[sender_names_backfilled, mailbox_asked_for_changes, sync_drain]`.
 *  7. THE CHANGE LOG. Skip the `recordChanges` loop in the pass. Two go red — the rows are
 *     repaired in the store and the open window is never told, which is the failure mode that
 *     looks like nothing happening at all.
 *
 * The one thing here NOT covered by a mutation, stated rather than implied: the per-launch latch
 * that stops asking once a walk runs off the end of the store. It is a COST property — it saves a
 * scan per poll on a repaired store — and no assertion about rows can see it, because after the
 * last row is filled a pass that keeps running and a pass that has stopped write exactly the same
 * thing, which is nothing.
 */

/** An empty `ohmail/_meta` that accepts this install's claim — `readMailboxLease` requires one. */
class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> {
    return this.claims.map((c) => ({ ...c }));
  }
  async appendClaim(raw: string): Promise<void> {
    this.claims.push({ ref: this.nextUid++, raw });
  }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }

  /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
  uidValidity(): number | bigint | null { return 4_100; }
}

const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

/**
 * A mailbox with nothing in it, which pushes a mark on `trace` every time the sync loop asks it
 * for changes.
 *
 * The rows under test are seeded straight into the local store, because what is being proved is
 * what the REPAIR does with rows that are already there and not how such rows come to exist — they
 * come from a version of this program that no longer exists, which is the whole point of a
 * backfill. An empty mailbox also settles the drain in one cycle, so "within one drain" is a claim
 * about the pass rather than about how long a backlog took.
 *
 * `trace` is what makes claim 7 a real assertion rather than a reading of the source: it and the
 * log sink write to the same array, so the ORDER of "the mailbox was asked for changes" against
 * "the repair wrote something" is observable from outside the engine.
 */
function quietMailbox(trace: string[]): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  const meta = new MemoryMetaFolder();
  return (_cfg) => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return {
        move: true, uidplus: true, condstore: true, qresync: false,
        idle: true, specialUse: true, sentFolder: null,
      };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> {
      trace.push("mailbox_asked_for_changes");
      return { ...EMPTY_BATCH };
    },
    async move(locator: NativeLocator): Promise<NativeLocator> {
      return locator;
    },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> {
      return [];
    },
    async watch(): Promise<() => Promise<void>> {
      return async () => {};
    },
    async send(_m: OutboundMessage): Promise<SendResult> {
      throw new Error("this mailbox cannot send");
    },
    async fetchPart(): Promise<FetchedPart> {
      throw new Error("this mailbox cannot fetchPart");
    },
  });
}

/**
 * ONE install key per store, held for as long as the store is.
 *
 * A relaunch is a new process against the SAME directory, and the mailbox password is sealed in
 * that directory under this machine's key. Minting a fresh key per boot would therefore not model a
 * relaunch: the second process could not open the credential, `start()` would return before
 * connecting — which is the correct behaviour, and is exactly the state a re-keyed machine is in —
 * and the drain under test would never run. That failure looked identical to "the repair does not
 * resume", which is the whole claim, so this is keyed to the directory rather than to the call.
 */
const KEKS = new Map<string, Buffer>();
const kekFor = (dir: string): Buffer => {
  const held = KEKS.get(dir);
  if (held) return held;
  const minted = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  KEKS.set(dir, minted);
  return minted;
};

/** The whole visit budget, derived from the engine's own constants rather than restated. */
const VISIT = LOCAL_NAME_BACKFILL_BATCH * LOCAL_NAME_BACKFILL_PAGES;

describe("the historical-name repair at the standalone drain's tail", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  interface Booted {
    sidecar: Sidecar;
    /** Mailbox reads and engine log events, interleaved in the order they happened. */
    trace: string[];
    dataDir: string;
  }

  /**
   * Build the engine but DO NOT start it — every test seeds its historical rows and then calls
   * `start()`, whose drain is the first visit.
   *
   * That order is production's, not a convenience. The rows a backfill exists for were written by
   * an older version of this program and are on the disk before the process opens, and the repair
   * LATCHES for the launch the moment a visit walks off the end of the store — which is what keeps
   * a repaired install from paying a scan every fifteen seconds for as long as it is open. Seeding
   * after `start()` would therefore seed behind a latch that had already, correctly, closed on an
   * empty store, and every claim below would be about a pass that never ran again.
   *
   * `dataDir` is a parameter so a test can QUIT an install and open the same store again, which is
   * the only honest way to ask whether a repair resumes across launches: the in-memory walk
   * position dies with the process, and what has to converge is the store.
   */
  async function boot(dataDir?: string): Promise<Booted> {
    // `realpathSync` because macOS hands out `/var/…` for a `/private/var/…` directory and PGlite
    // records the resolved path in its lock file.
    const dir = dataDir ?? await freshDataDir("ohmail-namebf-");
    const trace: string[] = [];
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        // A password is what makes `start()` take the connected path at all.
        auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "name backfill host",
      // Long enough that the poll timer never fires: every drain here is one the test asked for,
      // so a repaired row is never a coincidence of scheduling.
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
      adapterFactory: quietMailbox(trace),
      keks: { 1: kekFor(dir) },
      log: (event) => { trace.push(event); },
    });
    cleanups.push(async () => {
      await sidecar.stop();
      if (!dataDir) rmSync(dir, { recursive: true, force: true });
    });
    return { sidecar, trace, dataDir: dir };
  }

  function eml(headers: string[], body = "hello"): string {
    return [...headers, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
  }

  /**
   * A row exactly as an OLDER VERSION OF THIS PROGRAM left it: the header bag stored, the three
   * columns at their unset defaults.
   *
   * Built by running the raw message through `normalizeMime` — ingest's own parser — and storing
   * what ingest stores while deliberately not storing what it could not. The assertions then
   * compare against the values that same `normalizeMime` produced, so the test cannot pass by the
   * repair and the fixture agreeing on a wrong answer.
   */
  /**
   * Every seed below also writes a WATCHED INSTANCE, because the drain's sync cycle runs the
   * mail-0065 reaper (`tombstoneInstanceless`): a locator-bearing message with no
   * `message_instances` row is mail the server no longer holds, and the reaper tombstones it
   * mid-test — an extra `message` delete change that has nothing to do with the repair under
   * test, which broke every exact change-count assertion in this file. Same fixture rule as
   * `resurface-drain.test.ts`. `uid` comes from one file-scoped counter so the
   * `(mailbox, folder, uidvalidity, uid)` locator stays unique across seeds.
   */
  let nextUid = 1;
  async function seedInstance(s: Sidecar, messageId: string): Promise<void> {
    await s.db.insert(messageInstances).values({
      accountId: s.world.accountId,
      mailboxId: s.world.mailboxId,
      messageId,
      folder: "INBOX",
      uidvalidity: 1n,
      uid: nextUid++,
      isPrimary: true,
    });
  }

  async function seedHistorical(
    s: Sidecar, raw: string,
  ): Promise<{ id: string; expected: Awaited<ReturnType<typeof normalizeMime>> }> {
    const norm = await normalizeMime(raw);
    const dedup = `namebf:${norm.subject}:${Math.random().toString(36).slice(2)}`;
    const [m] = await s.db.insert(messages).values({
      accountId: s.world.accountId,
      mailboxId: s.world.mailboxId,
      bodyHash: `h-${dedup}`,
      dedupKey: dedup,
      subject: norm.subject,
      fromAddress: norm.from.address,
      date: norm.date,
      nativeLocator: { folder: "INBOX", ref: `1:${dedup}` },
    }).returning();
    await seedInstance(s, m!.id);
    await s.db.insert(messageBodies).values({
      messageId: m!.id, accountId: m!.accountId,
      text: norm.textBody,
      html: norm.htmlBody,
      // The spread is load-bearing: `normalizeMime` returns a NULL-PROTOTYPE header map and
      // drizzle's `is()` reads `value.constructor` on what it is handed, which throws on such an
      // object before a single row is written.
      headers: { ...norm.headers },
    });
    return { id: m!.id, expected: norm };
  }

  /**
   * The same shape without the parse, for the tests that need HUNDREDS of rows and care only about
   * how many were touched. `normalizeMime` per row is the slow half of seeding and it buys nothing
   * where the assertion is a count.
   */
  async function seedCheap(s: Sidecar, i: number): Promise<string> {
    const dedup = `crowd:${String(i).padStart(4, "0")}`;
    const [m] = await s.db.insert(messages).values({
      accountId: s.world.accountId,
      mailboxId: s.world.mailboxId,
      bodyHash: `h-${dedup}`,
      dedupKey: dedup,
      subject: `crowd ${i}`,
      fromAddress: `crowd-${i}@example.test`,
      nativeLocator: { folder: "INBOX", ref: `1:${dedup}` },
    }).returning();
    await seedInstance(s, m!.id);
    await s.db.insert(messageBodies).values({
      messageId: m!.id, accountId: m!.accountId, text: "", html: null,
      headers: { from: [`Crowd Member ${i} <crowd-${i}@example.test>`] },
    });
    return m!.id;
  }

  /**
   * A row at a CHOSEN id, so a test can decide what the walk meets first.
   *
   * `messages.id` is a random uuid in production and the walk is ordered by it, so which rows a
   * budgeted visit sees is otherwise a coin toss — and a claim about "the rows at the front of the
   * ordering" cannot be made with a coin toss. `nameless` is the whole point: a `From` that is a
   * bare address, with no `To` and no `Cc` either, makes a row that is a candidate for ever and
   * fillable never, which is the shape that accumulates in a real store.
   */
  async function seedAt(s: Sidecar, id: string, i: number, nameless: boolean): Promise<string> {
    const dedup = `fixed:${id}`;
    await s.db.insert(messages).values({
      id,
      accountId: s.world.accountId,
      mailboxId: s.world.mailboxId,
      bodyHash: `h-${dedup}`,
      dedupKey: dedup,
      subject: `fixed ${i}`,
      fromAddress: `fixed-${i}@example.test`,
      nativeLocator: { folder: "INBOX", ref: `1:${dedup}` },
    });
    await seedInstance(s, id);
    await s.db.insert(messageBodies).values({
      messageId: id, accountId: s.world.accountId, text: "", html: null,
      headers: {
        from: [nameless ? `fixed-${i}@example.test` : `Fixed Name ${i} <fixed-${i}@example.test>`],
      },
    });
    return id;
  }

  /** A uuid whose ordering is the number: `0000…-0000-0000-0000-<12 digits>`. */
  const idAt = (n: number): string =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  const rowOf = async (s: Sidecar, id: string) => {
    const [m] = await s.db.select().from(messages).where(eq(messages.id, id));
    return m!;
  };

  const changesFor = async (s: Sidecar, id: string) =>
    s.db.select().from(changeLog).where(and(
      eq(changeLog.accountId, s.world.accountId), eq(changeLog.entityId, id),
    ));

  const namedCount = async (s: Sidecar): Promise<number> => {
    const rows = await s.db.select({ id: messages.id, fromName: messages.fromName })
      .from(messages).where(eq(messages.accountId, s.world.accountId));
    return rows.filter((r) => r.fromName !== null).length;
  };

  it("fills a historical row with exactly what ingest's own parser produced, and tells the window", async () => {
    const { sidecar: s } = await boot();
    const quoted = await seedHistorical(s, eml([
      "From: Papierwerk Studio <hello@Papierwerk.example>",
      'To: "Doe, Jane" <jane@example.test>, second@example.test',
      "Cc: Carla <carla@example.test>",
      "Subject: a quoted recipient",
    ]));
    const encoded = await seedHistorical(s, eml([
      "From: =?UTF-8?Q?J\x3dC3\x3dBCrgen_M\x3dC3\x3dBCller?= <juergen@example.test>",
      "To: owner@trafficflow.test",
      "Subject: an encoded word",
    ]));

    expect(await rowOf(s, quoted.id)).toMatchObject({ fromName: null, toAddresses: [], ccAddresses: [] });

    await s.start();

    const q = await rowOf(s, quoted.id);
    // Not a hand-written expectation: what `normalizeMime` itself produced from the raw message,
    // which is what ingest would have written had the column existed.
    expect(q.fromName, "the drain repaired nothing — the tail pass did not run").toBe(quoted.expected.from.name);
    expect(q.fromName).toBe("Papierwerk Studio");
    expect(q.toAddresses).toEqual(quoted.expected.to);
    expect(q.ccAddresses).toEqual(quoted.expected.cc);
    // The quoted display name holds a comma, which is the case a split on `,` tears in half and a
    // real parse does not. Two recipients, not three.
    expect((q.toAddresses as unknown[]).length).toBe(2);
    expect(q.toAddresses).toContainEqual({ name: "Doe, Jane", address: "jane@example.test" });

    const e = await rowOf(s, encoded.id);
    expect(e.fromName).toBe(encoded.expected.from.name);
    expect(e.fromName).toBe("Jürgen Müller");

    // ONE `message` update per written row. On this door that is not a note for a remote mirror:
    // the window's own view is fed by `/sync` off this store, so this row is what repaints the
    // list in the same session instead of at the next launch.
    for (const id of [quoted.id, encoded.id]) {
      const ch = await changesFor(s, id);
      expect(ch, `no change was emitted for ${id}, so the open window would still show the old row`)
        .toHaveLength(1);
      expect(ch[0]).toMatchObject({ entityType: "message", op: "update" });
    }
  }, 120_000);

  /**
   * NEVER OVERWRITES — asserted on a row the pass DOES process, which is the difference between
   * this test and the one it replaced.
   *
   * The obvious way to write this is to set every column on a row and check none of them moved. It
   * passes for the wrong reason: such a row is not a candidate at all, so the pass never reads it,
   * and every "does not overwrite" guard could be deleted with the test still green. (Measured, not
   * reasoned about: the guard was deleted and this file stayed green.)
   *
   * So the row here has ONE column already written and another still fillable. It is a candidate,
   * the pass reads it, and both halves of the claim become observable: the written column must
   * survive, and the empty one must be filled in the same UPDATE.
   *
   * Two mutations turn it red, and they are different failures. Change `if (row.fromName === null)`
   * in the pass to `if (true)`: the parse now offers a name for a column that has one, the row's
   * UPDATE is guarded on that column being NULL and therefore matches nothing, and the RECIPIENTS
   * are lost with it — the row comes back with an empty To line. Drop that guard as well and the
   * user's name is replaced by the header's. Both were run and restored.
   */
  it("never overwrites a name that is there, and fills the half of the same row that is missing", async () => {
    const { sidecar: s } = await boot();
    const seeded = await seedHistorical(s, eml([
      "From: Header Name <someone@example.test>",
      "To: header-to@example.test, second@example.test",
    ]));
    // Only `from_name`. `to_addresses` is left at its unset default, which is what keeps this row a
    // candidate and this test honest.
    await s.db.update(messages)
      .set({ fromName: "A Name The User Or Ingest Wrote" })
      .where(eq(messages.id, seeded.id));

    await s.start();

    const m = await rowOf(s, seeded.id);
    expect(
      m.fromName,
      "a name that was already stored was replaced by the one in the header",
    ).toBe("A Name The User Or Ingest Wrote");
    expect(
      m.toAddresses,
      "the fillable half of the row was not written — the pass either skipped the row or lost it",
    ).toEqual(seeded.expected.to);
    // One write, so one change: the window re-reads this row once and sees both facts.
    expect(await changesFor(s, seeded.id)).toHaveLength(1);
  }, 120_000);

  it("emits nothing at all for a row it cannot add anything to", async () => {
    const { sidecar: s } = await boot();
    const seeded = await seedHistorical(s, eml([
      "From: Header Name <someone@example.test>",
      "To: header-to@example.test",
    ]));
    await s.db.update(messages)
      .set({
        fromName: "A Name The User Or Ingest Wrote",
        toAddresses: [{ name: null, address: "kept@example.test" }],
      })
      .where(eq(messages.id, seeded.id));

    await s.start();

    const m = await rowOf(s, seeded.id);
    expect(m.fromName).toBe("A Name The User Or Ingest Wrote");
    expect(m.toAddresses).toEqual([{ name: null, address: "kept@example.test" }]);
    // Nothing was writable, so nothing was written and the window is not told to re-read a row
    // that did not change. A change per untouched row would repaint the whole list for nothing.
    expect(await changesFor(s, seeded.id)).toHaveLength(0);
  }, 120_000);

  it("leaves a sender who set no display name nameless, rather than inventing one from the address", async () => {
    const { sidecar: s } = await boot();
    const bare = await seedHistorical(s, eml([
      "From: bare@example.test",
      "To: owner@trafficflow.test",
    ]));

    await s.start();

    const m = await rowOf(s, bare.id);
    expect(
      m.fromName,
      "a name was invented for a sender who never wrote one — afterwards it is indistinguishable " +
        "from one they did",
    ).toBeNull();
    // The recipients half of the SAME row is written by the same UPDATE: an unnameable sender does
    // not cost the row its To line.
    expect(m.toAddresses).toEqual(bare.expected.to);
  }, 180_000);

  it("does at most one visit's worth per drain, and converges over the drains that follow", async () => {
    const { sidecar: s } = await boot();
    const over = VISIT + 5;
    for (let i = 0; i < over; i++) await seedCheap(s, i);

    await s.start();
    expect(
      await namedCount(s),
      "one drain repaired more than a visit's budget — the bound is not holding, and a fresh boot " +
        "would spend its first sync on display names",
    ).toBe(VISIT);

    // THE SECOND VISIT PICKS UP WHERE THE FIRST STOPPED. This is the claim the walk position
    // exists for: without it the second visit re-reads the first visit's rows, and on a store with
    // permanently-unfillable rows in it that is how a repair silently stops converging.
    await s.syncUntilQuiet();
    expect(await namedCount(s)).toBe(over);

    // …and a third drain over a finished store writes nothing and emits nothing.
    const before = (await s.db.select().from(changeLog)
      .where(eq(changeLog.accountId, s.world.accountId))).length;
    await s.syncUntilQuiet();
    const after = (await s.db.select().from(changeLog)
      .where(eq(changeLog.accountId, s.world.accountId))).length;
    expect(after - before, "a finished store was repaired again").toBe(0);
  }, 300_000);

  /**
   * THE CLAIM THE WALK POSITION EXISTS FOR, and the one the budget test above CANNOT make.
   *
   * There, every seeded row was fillable, so a visit that restarted at the beginning would still
   * have converged — the rows it repaired stopped being candidates and got out of its way. The
   * rows that do NOT get out of the way are the ones a correct repair leaves alone for ever: a
   * sender who set no display name keeps a NULL `from_name` and a `from` header until the end of
   * time, and that is the right answer, not a failure to be retried.
   *
   * So this store is a whole visit's budget of those, sitting at the FRONT of the ordering, with
   * the fillable rows behind them. A repair that starts each visit at the beginning spends its
   * entire budget re-deciding rows it has already decided, correctly, and never reaches the rows
   * that need it — and it does so quietly, with every row it looked at handled exactly right.
   *
   * The mutation: drop `startAfterId` from the call in `apps/sidecar/src/engine.ts`. The second
   * drain then repairs nothing and this goes red on 0. Run, watched, restored.
   */
  it("gets past a front of rows that can never be filled, instead of re-deciding them for ever", async () => {
    const { sidecar: s } = await boot();
    // Exactly one visit's worth of permanent candidates, all of them below every id that follows.
    for (let i = 0; i < VISIT; i++) await seedAt(s, idAt(i), i, true);
    const behind: string[] = [];
    for (let i = 0; i < 3; i++) behind.push(await seedAt(s, idAt(VISIT + i), VISIT + i, false));

    // Visit one: a full budget spent on rows that are candidates and are not fillable. Nothing is
    // written, and nothing SHOULD be — this is the pass being right, not the pass being stuck.
    await s.start();
    expect(await namedCount(s)).toBe(0);

    // Visit two, which is the whole test: it must start where visit one stopped.
    await s.syncUntilQuiet();
    expect(
      await namedCount(s),
      "the second visit re-read the first visit's leftovers instead of continuing past them — on a " +
        "real store that is a repair that stops converging while handling every row correctly",
    ).toBe(behind.length);
    for (const id of behind) expect((await rowOf(s, id)).fromName).toMatch(/^Fixed Name /);

    // And the rows at the front are still, correctly, nameless: getting past them is not the same
    // as giving them a name.
    expect((await rowOf(s, idAt(0))).fromName).toBeNull();
  }, 300_000);

  it("resumes after a quit: the store, not a bookmark, is what says how far it got", async () => {
    const first = await boot();
    const over = VISIT + 5;
    for (let i = 0; i < over; i++) await seedCheap(first.sidecar, i);

    await first.sidecar.start();
    const partway = await namedCount(first.sidecar);
    expect(partway).toBe(VISIT);
    // The quit that the walk position does not survive.
    await first.sidecar.stop();

    const second = await boot(first.dataDir);
    // Nothing was carried across: the new process asks the store, and the store's own contents are
    // the progress marker.
    expect(await namedCount(second.sidecar)).toBe(partway);
    await second.sidecar.start();
    expect(
      await namedCount(second.sidecar),
      "a relaunch did not continue the repair — the store is not the completion state",
    ).toBe(over);
  }, 300_000);

  it("a row with no stored From header is not a candidate and is never touched", async () => {
    const { sidecar: s } = await boot();
    const [m] = await s.db.insert(messages).values({
      accountId: s.world.accountId,
      mailboxId: s.world.mailboxId,
      bodyHash: "h-headerless",
      dedupKey: "namebf:headerless",
      subject: "no headers were stored for this one",
      fromAddress: "x@example.test",
      nativeLocator: { folder: "INBOX", ref: "1:headerless" },
    }).returning();
    await seedInstance(s, m!.id);
    await s.db.insert(messageBodies).values({
      messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {},
    });

    await s.start();

    expect((await rowOf(s, m!.id)).fromName).toBeNull();
    expect(await changesFor(s, m!.id)).toHaveLength(0);
  }, 120_000);

  it("runs strictly after the drain's sync work — a cold launch's mail is never behind it", async () => {
    const { sidecar: s, trace } = await boot();
    for (let i = 0; i < 3; i++) await seedCheap(s, i);
    trace.length = 0;

    await s.start();

    // The repair's own line is in the trace, so the ordering assertion below is about something
    // that happened rather than about something that did not.
    const repaired = trace.indexOf("sender_names_backfilled");
    expect(repaired, "the repair never ran, so this test proves nothing about ordering")
      .toBeGreaterThanOrEqual(0);
    const lastCycle = trace.lastIndexOf("mailbox_asked_for_changes");
    expect(lastCycle, "the drain never asked the mailbox for changes").toBeGreaterThanOrEqual(0);
    expect(
      repaired,
      `the repair ran before the sync work finished — trace was [${trace.join(", ")}]`,
    ).toBeGreaterThan(lastCycle);
    /* And INSIDE the drain the summary reports. `sync_drain` used to be emitted the moment the
       cycle loop ended, which made it a marker for "the sync work is done"; it is now the drain's
       LAST word, written after the tail so the tail's own checkpoint is in its counts. So the
       ordering claim it can carry is the other one: the repair belongs to the drain this line is
       about, not to a later one. The assertion above — after the last `mailbox_asked_for_changes`
       — is the one that says the mail was never behind it, and it is untouched. */
    expect(repaired).toBeLessThan(trace.indexOf("sync_drain"));
  }, 120_000);
});
