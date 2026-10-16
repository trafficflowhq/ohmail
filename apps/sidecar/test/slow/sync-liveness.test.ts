import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { freshDataDir } from "../_datadir.js";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, ImapCursor, MailboxAdapter,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import type { NativeLocator } from "@trafficflow/core";
import { messages } from "@trafficflow/db";
import { connectOverStdio, type StdioClient } from "../../src/client.js";
import { createSidecar, type Sidecar } from "../../src/engine.js";
import { serveOverStdio, type StdioHost } from "../../src/host.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  LIVENESS OF THE BRIDGE WHILE THE SYNC LOOP HAS THE DATABASE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT THIS FILE IS *NOT*, AND WHY THAT MATTERS MORE THAN WHAT IT IS ────────────────────
 *
 * This slice was first specified as "prove a sync cycle and concurrent UI traffic do not
 * corrupt each other by interleaving transactions". That assertion was DROPPED, deliberately,
 * because the premise is false: **PGlite serialises.** One WASM engine, one connection, one
 * query at a time — a statement issued while a transaction is open does not interleave with it,
 * it QUEUES behind the commit. A "no interleaved-transaction corruption" test against this
 * store is therefore unfalsifiable: it passes whatever the implementation does, which is this
 * repository's own named disease (built, tested, unreachable) wearing a concurrency costume.
 *
 * The residual risk that serialisation creates instead is **LIVENESS**, and it is real:
 *
 *  · every UI read shares ONE connection with the sync loop (`db.ts` — the handle is the process
 *    singleton, and it must be: two PGlite instances on one directory corrupt it);
 *  · `host.ts:77-111` dispatches every accepted frame concurrently and the read loop NEVER
 *    awaits a handler, so nothing upstream throttles how much work can pile onto that one
 *    connection;
 *  · so a slow database turns into an unbounded queue of half-finished requests, and the user
 *    sees a mail app that has stopped answering.
 *
 * ── AND THE SAME RISK POINTED THE OTHER WAY, WHICH IS WORSE AND IS NOW SCHEDULED ─────────────
 *
 * A stalled read is a spinner somebody can see; a starved sync cycle is mail that silently never
 * arrives. Case 3 measured exactly that — eight polling windows held the ingest at ZERO for
 * fifteen seconds. `apps/sidecar/src/store-lanes.ts` schedules the one connection between the mail
 * coming in and everything else asking for it, and hands out every admission on the event loop's
 * check phase so a chain of in-process WASM queries cannot stop the loop turning. Case 3 asserts
 * the share and the loop; the other two cases are unchanged, and pay for it — case 1's reads went
 * p50 221.5 → 515.6 ms against the same untouched 30 s ceiling, because the cycle is now running.
 *
 * ── WHY THE NUMBERS ARE PRINTED AND ONLY A HANG CEILING IS ASSERTED ───────────────────────
 *
 * Latency here is a property of the machine (a CI box, a laptop on battery, a laptop with four
 * other vitest workers on it). A tight assertion on a guessed millisecond figure would flake,
 * and a flaky guard teaches everyone to ignore the file — which is strictly worse than no guard.
 * So the shape is: **assert the things that are true or false (every request completed, every
 * response went to its own caller, the cycle finished its work), print the things that are
 * measurements (p95, max, the starvation ratio, RSS), and put the only latency assertion at a
 * ceiling no healthy machine can reach (30 s).** The measured p95 is the input the
 * request-deadline decision needs; the printout is how it gets read.
 *
 * ── WHY PGLITE AND NOT :5433 ──────────────────────────────────────────────────────────────
 *
 * **PGlite IS production on the desktop.** `apps/sidecar/src/db.ts` opens it on disk under the
 * user's home, and the serialisation this file measures is the shipped behaviour, not a test
 * artefact. Measuring it against :5433 (many connections, real MVCC) would measure a database
 * no desktop user has. The file therefore runs on-disk PGlite and needs no docker at all.
 *
 * This file carried the `.pg.test.ts` suffix until 2026-09-08, and that name was a lie in the
 * direction nobody checks for. Everywhere else in this repo `*.pg.test.ts` means "real
 * Postgres, because PGlite cannot express this", so every filename-shaped box rule read this
 * file as needing the :5433 lock — and the ones that EXCLUDE by that suffix read it as needing
 * to be skipped. `scripts/box-files.mjs` classifies by what a file reaches and was never fooled;
 * people and hand-written filters were. The section that used to sit here arguing the name away
 * is gone with the name.
 *
 * ── WHY A FAKE ADAPTER AND NOT GREENMAIL ──────────────────────────────────────────────────
 *
 * The sibling e2e files use a real IMAP server because their claims are about a SERVER (where a
 * message physically ended up, whether a login was released). Every claim here is about the
 * database and the bridge, and a real server would only add its own variance to a latency
 * measurement. The pipeline is otherwise entirely real: `runSyncCycle` from the worker,
 * `planChange`/`commitChange`, `createApp(apiRoutes)` behind the real frame codec, on-disk
 * PGlite.
 */

/** Messages ingested before the measured cycle — the read targets, and a non-empty mirror. */
const SEED_MESSAGES = 40;
/** Messages the MEASURED cycle ingests. Big enough that the cycle is still running when the
 *  reads are issued — asserted, never assumed (see `awaitCycleInFlight`). */
const CYCLE_MESSAGES = 250;
/** Concurrent UI reads fired into the middle of that cycle, plus one mutation. */
const CONCURRENT_READS = 24;
/** The accept-window probe: how deep `inFlight` is pushed for the RSS measurement. */
const QUEUE_DEPTH = 500;
/**
 * The queue probe needs the database busy for LONGER than it takes 500 frames to land, or the
 * answers start draining while the queue is still building and the peak understates the depth.
 * Measured: at {@link CYCLE_MESSAGES} the peak was ~250 of 500.
 */
const QUEUE_CYCLE_MESSAGES = 700;
/** Concurrent read loops in the starvation direction. */
const CHATTY_READERS = 8;
/**
 * …and a CAP on how many reads they may issue in total.
 *
 * Not a detail: back-to-back readers against a store that serialises produce a feedback loop —
 * every read they land makes the cycle longer, and a longer cycle gives them time to land more.
 * Uncapped, the first version of this test ran for over ten minutes of CPU without finishing,
 * which measures the test harness rather than the product.
 *
 * ── WHERE 400 COMES FROM, AND WHY THE OLD 800 DESCRIBED A DIFFERENT TEST ────────────────────
 *
 * 800 was one window of reads at the rate this case used to see — ~520 reads/s × 1.5 s ≈ 780. That
 * rate was the cost of an EMPTY answer: every ingested row carried `folder_state` ‘ohmail/Screener’
 * while `view=imbox` asks for INBOX, so the "read" was two statements that assembled no rows. On a
 * real list the same cap buys fifteen seconds of reading instead of one and a half, and the number
 * stopped describing anything.
 *
 * Re-derived on the real list, on the build that schedules the store: eight readers over the
 * measured window cost **80 reads** (52 reads/s), so the cap is 400 — five times what an ordinary
 * run needs. It bounds a pathological one and is never what ends the load, which the case now
 * ASSERTS rather than hopes: a run that exhausts its budget before the window closes yields a
 * LOWER BOUND on the ratio, and says so by failing instead of printing a number that looks like a
 * measurement.
 */
const CHATTY_READ_BUDGET = 400;
/**
 * THE INGEST'S FLOOR under that load: the share of THIS run's quiet rate the loaded cycle keeps.
 * The rate floor it replaces (25 msg/s) measured the host: pinned beside one busy spinner the case
 * read a lower rate and refused at a share of it, because the host slows both arms together.
 * Measured here: a healthy share with the cycle's own gaps held for (`INGEST_GAP_TURNS`), a lower one
 * with that hold removed, and lower still by weight alone or before `store-lanes.ts`. An ALARM
 * floor, under half the lowest healthy share; the TARGET is the ruled line of half the quiet
 * rate, met again on 2026-09-24 (the project's design notes § A.3). A faster quiet path lowers
 * the share: re-derive it here.
 */
const LOADED_INGEST_SHARE_FLOOR = 0.2;
/**
 * THE EVENT LOOP MUST STILL TURN OVER, and this is the half of the defect that made the ingest
 * exactly zero rather than merely slow.
 *
 * PGlite answers from WASM in this process, so a fleet of readers is an unbroken chain of
 * microtasks and the loop’s timer and check phases never run. The cycle’s next act after its
 * cursor write is a MIME parse, which is stream-based and settles on those phases: measured, it
 * waited **14 871 ms** for a turn it needed microseconds of. With the store scheduled the same
 * probe reads **38.7 ms** here. The ceiling is a liveness one in this file’s own style — twenty-five
 * times above any healthy reading, fifteen times below the broken one.
 */
const LOOP_TURN_CEILING_MS = 1_000;
/** The window over which both the loaded and the quiet cycle are sampled, identically. */
const LOAD_WINDOW_MS = 1_500;
/**
 * How long ONE handler is held so that its response arrives after others issued later.
 *
 * Comfortably above the measured ~150 ms a point read takes under a cycle, so on an ordinary
 * machine it is the last to arrive; the precondition below asks only that it is not the first,
 * which is all the correlation claim needs and holds however slow one point read is. Excluded
 * from the p95 for the obvious reason: it is this file's own latency, not the engine's.
 */
const HOLD_MS = 400;
/**
 * THE HANG CEILING, and the only latency number this file asserts.
 *
 * Not a performance target — a liveness one. Anything under it is reported for the
 * deadline decision; anything over it means a request went in and did not come back, which is
 * the failure a user experiences as a frozen app.
 */
const HANG_CEILING_MS = 30_000;

// ══════════════════════════════════════════════════════════════════════════════════════════
//  A CONTROLLABLE MAILBOX, IN MEMORY
// ══════════════════════════════════════════════════════════════════════════════════════════

/**
 * An empty `ohmail/_meta` that accepts this install's claim.
 *
 * Required, not optional: `readMailboxLease` throws `LeaseUnavailableError` when an adapter
 * hands over no `LeaseIo`, precisely so a missing gate can never be the silently permissive
 * branch — so an adapter without one would fail `start()` before any of this file's work began.
 */
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

interface Delivered {
  messageId: string;
  subject: string;
}

/**
 * A `MailboxAdapter` whose whole job is to hand the real pipeline a lot of real mail, instantly.
 *
 * Append-only: `deliver` GROWS and a message's uid is its index, so a batch added after the
 * first drain cannot renumber one already ingested. `changesSince` reports only what the cursor
 * (rebuilt from the database by `buildCursor`) does not already know, which is what a real
 * adapter does and what makes "the second cycle sees nothing" true here for the real reason.
 */
class MemoryMailbox {
  readonly meta = new MemoryMetaFolder();
  readonly deliver: Delivered[] = [];
  /** `changesSince` calls that have returned — the seam that proves a cycle is really running. */
  cyclesStarted = 0;
  cyclesFinished = 0;

  /** Queue `n` more messages and return them, newest last. */
  add(n: number, tag: string): Delivered[] {
    const added: Delivered[] = [];
    for (let i = 0; i < n; i++) {
      const seq = this.deliver.length;
      added.push({ messageId: `a6-${tag}-${seq}@stranger.test`, subject: `liveness ${tag} #${seq}` });
      this.deliver.push(added[i]!);
    }
    return added;
  }

  /**
   * The return type is `MailboxAdapter` PLUS `leaseIo`, and the addition is not cosmetic.
   *
   * `leaseIo` is not on `MailboxAdapter` — `apps/worker/src/lease.ts` probes for it structurally,
   * deliberately, so that an adapter which cannot produce one makes `readMailboxLease` throw
   * rather than silently take the permissive branch. Declaring it here keeps that intersection
   * visible instead of hiding it behind a cast to a type the object does not actually satisfy.
   */
  readonly factory = (_cfg: ImapConfig): MailboxAdapter & { leaseIo(): LeaseIo } => {
    const mailbox = this;
    const empty: ChangeBatch = {
      creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
    };
    return {
      leaseIo(): LeaseIo {
        return mailbox.meta;
      },
      async connect(): Promise<void> {},
      async close(): Promise<void> {},
      async capabilities(): Promise<ImapCapabilities> {
        return {
          move: true, uidplus: true, condstore: true, qresync: false,
          idle: true, specialUse: true, sentFolder: null,
        };
      },
      async ensureFolders(): Promise<void> {},
      async changesSince(cursor: ImapCursor): Promise<ChangeBatch> {
        mailbox.cyclesStarted++;
        const known = cursor.folders.INBOX?.known ?? [];
        const pending = mailbox.deliver
          .map((m, i) => ({ m, uid: 1000 + i }))
          .filter(({ uid }) => !known.some((k) => k.uid === uid));
        mailbox.cyclesFinished++;
        if (pending.length === 0) return { ...empty };
        return {
          ...empty,
          hasBacklog: false,
          creates: pending.map(({ m, uid }) => ({
            type: "create" as const,
            locator: { folder: "INBOX", ref: `1:${uid}` },
            seen: false,
            raw: Buffer.from([
              `Message-ID: <${m.messageId}>`,
              "From: stranger@nowhere.test",
              "To: owner@trafficflow.test",
              `Subject: ${m.subject}`,
              "Content-Type: text/plain; charset=utf-8",
              "",
              "Hello — we have not met before.",
            ].join("\r\n")),
          })),
        };
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
    };
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════
//  MEASUREMENT
// ══════════════════════════════════════════════════════════════════════════════════════════

/** Nearest-rank percentile over a copy — the sample is small and sorting it is free. */
function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return NaN;
  const xs = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * xs.length));
  return xs[rank - 1]!;
}

function ms(n: number): string {
  return `${n.toFixed(1)} ms`;
}

/** Everything measured is REPORTED, whether or not an assertion reads it. */
function report(title: string, rows: Record<string, string | number>): void {
  const body = Object.entries(rows).map(([k, v]) =>
    `    ${k}: ${typeof v === "number" && !Number.isInteger(v) ? v.toFixed(1) : v}`);
  console.log([`  [liveness ${title}]`, ...body].join("\n"));
}

/**
 * Fail a request that never comes back, CLEANLY, instead of letting it kill the file.
 *
 * Any break in frame correlation necessarily strands at least one promise — the response that
 * would have settled it went to somebody else — so `Promise.allSettled` over the batch simply
 * never resolves and the whole file dies on vitest's timeout with no indication of which claim
 * was violated. Proven, not assumed: mutating `client.ts` to resolve the oldest waiter produced
 * exactly that, a bare `Test timed out in 180000ms`. With a deadline per request the same
 * mutation reports which request was lost and which caller got the wrong body.
 *
 * It is also the shape the transport deadline will take (deadline in the transport, race
 * plus abort) — this is a test-side stand-in for it, not a second pattern.
 */
function within<T>(what: string, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} did not come back within ${HANG_CEILING_MS} ms`)),
      HANG_CEILING_MS,
    );
    p.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Let the event loop (and therefore PGlite's queue) actually run. */
function tick(n = 1): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => new Promise<void>((r) => setImmediate(r)));
  return p;
}

// ══════════════════════════════════════════════════════════════════════════════════════════
//  THE WORLD
// ══════════════════════════════════════════════════════════════════════════════════════════

interface World {
  sidecar: Sidecar;
  host: StdioHost;
  client: StdioClient;
  mailbox: MemoryMailbox;
  dataDir: string;
  /** `GET`/`PATCH` over the bridge, already carrying the launch session. */
  call(path: string, init?: RequestInit): Promise<Response>;
  /**
   * Called with `host.inFlight` at the instant each request is dispatched — the ONLY honest place
   * to read the accept queue's depth.
   *
   * POLLING FOR IT DOES NOT WORK, AND FINDING THAT OUT IS WORTH A COMMENT. PGlite is a WASM
   * Postgres called in-process: a query's promise settles on the MICROTASK queue, so a whole
   * chain of them can run to completion between two `setImmediate` callbacks. A sampler built on
   * `setImmediate` therefore reports `inFlight: 0` for a queue that really was 500 deep — which
   * is exactly what the first version of this file measured, and it looked like a passing
   * measurement rather than a broken one.
   */
  probe(fn: ((inFlight: number) => void) | null): void;
}

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) {
    w.client.close();
    w.host.stop();
    await w.sidecar.stop().catch(() => undefined);
    rmSync(w.dataDir, { recursive: true, force: true });
  }
});

async function standUp(): Promise<World> {
  const dataDir = await freshDataDir("ohmail-a6-liveness-");
  const mailbox = new MemoryMailbox();
  const sidecar = await createSidecar({
    dataDir,
    imap: {
      host: "imap.invalid", port: 993, secure: true,
      auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
    },
    address: "owner@trafficflow.test",
    displayName: "This Mac",
    machineName: "liveness measurement host",
    // Long enough that the poll timer never fires: every cycle in this file is one the test
    // asked for, so a measured stall is never a coincidence of scheduling.
    pollIntervalMs: 60 * 60 * 1000,
    leaseStaleAfterMs: 60_000,
    adapterFactory: mailbox.factory,
  });

  // 64 KiB, which is a real pipe buffer on macOS. The sibling e2e uses 1 KiB to make backpressure
  // easy to provoke; here that would put the PIPE in the measurement instead of the DATABASE.
  const toHost = new PassThrough({ highWaterMark: 64 * 1024 });
  const toClient = new PassThrough({ highWaterMark: 64 * 1024 });
  let onDispatch: ((inFlight: number) => void) | null = null;
  const host: StdioHost = serveOverStdio({
    // `host.ts` increments `inFlight` and then calls this, so the value read here is the depth of
    // the accept queue INCLUDING the request being dispatched.
    handle: async (req) => {
      onDispatch?.(host.inFlight);
      const res = await sidecar.handle(req);
      /**
       * ONE HANDLER MADE SLOW ON PURPOSE, AND WHY THAT IS NOT CHEATING.
       *
       * The property under test is the BRIDGE's: response N resolves promise N. Handler latency
       * is not part of that property, but it is what produces the only condition under which the
       * property is observable — a completion order that differs from the issue order.
       *
       * It cannot be produced from the API's own workload here, and that was established by
       * measurement rather than assumed: `/sync?since=0` was picked as the "slow" read and came
       * back in 76 ms against 145 ms for a single-message read, because it prefetches its page in
       * three queries while `materializeMessage` costs three SEQUENTIAL round-trips per message.
       * On a store that serialises, what orders completions is the number of sequential
       * round-trips, and every route the local engine serves is within a couple of hops of every
       * other. So the delay is injected here, after a genuine response has been produced, which
       * is exactly what a slow route (a large search, an attachment fetch over IMAP) would do to
       * the same queue.
       */
      const hold = Number(req.headers.get("x-a6-hold-ms") ?? 0);
      if (hold > 0) await new Promise((r) => setTimeout(r, hold));
      return res;
    },
    input: toHost,
    output: toClient,
  });
  const client = connectOverStdio({ input: toClient, output: toHost, baseUrl: "http://sidecar" });
  await host.ready({
    baseUrl: "http://sidecar",
    sessionToken: sidecar.sessionToken,
    accountId: sidecar.world.accountId,
    userId: sidecar.world.userId,
    mailboxId: sidecar.world.mailboxId,
    credentialState: await sidecar.credentialState(),
  });

  const w: World = {
    sidecar, host, client, mailbox, dataDir,
    call: (path, init) => client.fetch(path, {
      ...init,
      headers: { authorization: `Bearer ${sidecar.sessionToken}`, ...(init?.headers ?? {}) },
    }),
    probe: (fn) => {
      onDispatch = fn;
    },
  };
  worlds.push(w);
  return w;
}

/** The ingested messages, as `{ id, subject }` — the read targets and their expected answers. */
async function ingested(w: World): Promise<Array<{ id: string; subject: string }>> {
  return w.sidecar.db.select({ id: messages.id, subject: messages.subject }).from(messages);
}

/**
 * Start a drain and return once it is DEMONSTRABLY inside the commit loop.
 *
 * "Fire the reads right after kicking sync" is not good enough: `syncUntilQuiet` reads the
 * organizer lease first, and a test that raced that gate would measure an idle database and
 * report an excellent p95 that means nothing. The adapter's `changesSince` having returned is
 * the moment the batch exists and the per-message transactions begin.
 */
async function cycleInFlight(w: World): Promise<{ done: Promise<number>; settled: () => boolean }> {
  const before = w.mailbox.cyclesFinished;
  let settled = false;
  const done = w.sidecar.syncUntilQuiet().finally(() => {
    settled = true;
  });
  const deadline = Date.now() + HANG_CEILING_MS;
  while (w.mailbox.cyclesFinished === before && !settled && Date.now() < deadline) await tick();
  return { done, settled: () => settled };
}

// ══════════════════════════════════════════════════════════════════════════════════════════
//  1 + 2 — EVERY REQUEST COMES BACK, TO ITS OWN CALLER, AND HOW LONG IT TOOK
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("the bridge stays live while the sync loop holds the single PGlite connection", () => {
  it(
    "concurrent reads and a mutation issued mid-cycle all complete, each to its own caller",
    async () => {
      const w = await standUp();
      w.mailbox.add(SEED_MESSAGES, "seed");
      await w.sidecar.start();

      const targets = await ingested(w);
      expect(targets.length, "the seed batch was not ingested, so there is nothing to read").toBe(SEED_MESSAGES);
      const expected = new Map(targets.map((t) => [t.id, t.subject]));

      // The cycle under measurement: a batch big enough to keep the connection busy.
      w.mailbox.add(CYCLE_MESSAGES, "cycle");
      const cycle = await cycleInFlight(w);
      expect(cycle.settled(), "the cycle finished before a single request was issued — nothing was measured").toBe(false);

      /**
       * WHAT "MIS-CORRELATED" MEANS HERE, AND WHY THE SLOW READ GOES FIRST.
       *
       * `client.ts` correlates on the frame id. The property under test is that response N
       * resolves promise N — never that responses arrive in order, which they need not.
       *
       * ── THE FIRST VERSION OF THIS TEST COULD NOT FAIL, AND HERE IS HOW THAT WAS FOUND ──────
       *
       * It issued 25 IDENTICAL `/messages/:id` reads. Mutating `client.ts` to resolve **the
       * oldest waiter** instead of the one matching the frame id left the suite GREEN — because
       * PGlite serialises, identical requests complete in the order they were issued, so "the
       * oldest waiter" and "the right waiter" are the same object. The assertion was passing for
       * a reason that had nothing to do with correlation.
       *
       * The fix is to make completion order genuinely differ from issue order. A `/sync?since=0`
       * bootstrap replays the whole change log and materialises its page; it is issued FIRST and
       * finishes LAST, so a client that hands responses out in arrival order gives the sync
       * caller a single message DTO — and the shape assertion below catches it. Re-running the
       * same mutation against this version turns it red, which is the only reason to believe it.
       */
      let arrivals = 0;
      const heldTarget = targets[0]!;
      const heldStarted = performance.now();
      const heldRead = within(
        "the held read",
        w.call(`/messages/${heldTarget.id}`, { headers: { "x-a6-hold-ms": String(HOLD_MS) } }),
      ).then((res) => ({ res, tookMs: performance.now() - heldStarted, arrival: arrivals++ }));

      const reads = targets.slice(1, 1 + CONCURRENT_READS).map(async (t) => {
        const started = performance.now();
        const res = await within(`GET /messages/${t.id}`, w.call(`/messages/${t.id}`));
        return { t, res, tookMs: performance.now() - started, arrival: arrivals++ };
      });

      // ONE mutation in with the reads. A write is the case that matters most: it is the request
      // a user is watching a spinner for, and it takes the same single connection.
      const mutationTarget = targets[targets.length - 1]!;
      const mutationStarted = performance.now();
      const mutation = within("the mutation", w.call(`/messages/${mutationTarget.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unread: false }),
      })).then((res) => ({ res, tookMs: performance.now() - mutationStarted }));

      const settled = await Promise.allSettled([heldRead, ...reads, mutation]);
      const rejected = settled.filter((s) => s.status === "rejected");
      expect(
        rejected.map((r) => String((r as PromiseRejectedResult).reason)),
        "a request issued during the sync cycle never came back",
      ).toEqual([]);

      type Held = { res: Response; tookMs: number; arrival: number };
      type Point = { t: { id: string; subject: string }; res: Response; tookMs: number; arrival: number };
      const heldResult = (settled[0] as PromiseFulfilledResult<Held>).value;
      const readResults = settled.slice(1, 1 + reads.length)
        .map((s) => (s as PromiseFulfilledResult<Point>).value);

      for (const { t, res } of readResults) {
        expect(res.status, `GET /messages/${t.id} answered ${res.status}`).toBe(200);
        const dto = await res.json() as { id: string; subject: string };
        // The correlation assertion. A bridge that resolved the wrong promise fails HERE.
        expect(dto.id, "a response was delivered to the wrong caller").toBe(t.id);
        expect(dto.subject, "the response body belongs to a different message").toBe(expected.get(t.id));
      }

      // The other half of the same claim, from the LAST arrival's side: the request that was
      // issued first and answered last must still get its own message back.
      expect(heldResult.res.status, "the held read was refused").toBe(200);
      const heldDto = await heldResult.res.json() as { id: string; subject: string };
      expect(heldDto.id, "the first-issued, last-answered read got somebody else's response").toBe(heldTarget.id);
      expect(heldDto.subject, "the held read's body belongs to a different message").toBe(heldTarget.subject);

      const mutationResult = (settled[settled.length - 1] as PromiseFulfilledResult<{ res: Response; tookMs: number }>).value;
      expect(mutationResult.res.status, "the mutation issued mid-cycle was refused").toBe(200);
      const patched = await mutationResult.res.json() as { id: string; unread: boolean };
      expect(patched.id).toBe(mutationTarget.id);
      expect(patched.unread).toBe(false);

      await cycle.done;

      const latencies = [...readResults.map((r) => r.tookMs), mutationResult.tookMs];
      const p50 = percentile(latencies, 50);
      const p95 = percentile(latencies, 95);
      const max = Math.max(...latencies);
      report("request latency under a sync cycle", {
        "//": `p50/p95/max are over the ${CONCURRENT_READS} point reads + the mutation; the held `
          + "read is this file's own injected delay and is reported separately, never folded in",
        "point reads + mutation": latencies.length,
        "cycle messages": CYCLE_MESSAGES,
        p50: ms(p50), p95: ms(p95), max: ms(max),
        mutation: ms(mutationResult.tookMs),
        "held read (issued FIRST)": `${ms(heldResult.tookMs)}, arrived ${heldResult.arrival + 1} of ${arrivals}`,
      });

      /**
       * THE PRECONDITION THAT KEEPS THE CORRELATION CLAIM HONEST.
       *
       * If every response arrived in issue order, a client that ignored frame ids entirely would
       * pass every assertion above — and one did: mutating `client.ts` to resolve the OLDEST
       * waiter left the earlier version of this test green. The held read is issued first, so it
       * is the oldest waiter for as long as it waits: if ANY response arrives before its own, a
       * client handing responses to the oldest waiter gives it that response and the held-read
       * assertions above go red. So "not the first to arrive" is exactly what this file needs
       * to have exercised correlation. It used to demand "the last of all", which is more than
       * the claim needs and was a race: on a loaded CI runner one point read outlasted
       * HOLD_MS and the held read arrived 24th of 25, red with correlation fully exercised.
       */
      expect(
        heldResult.arrival,
        "every response arrived in issue order, so nothing here distinguishes correlation from luck",
      ).toBeGreaterThan(0);

      // The ONLY latency assertion, and it is a liveness one. See HANG_CEILING_MS.
      expect(max, "a request issued during a sync cycle took longer than the hang ceiling").toBeLessThan(HANG_CEILING_MS);
    },
    180_000,
  );

  // ══════════════════════════════════════════════════════════════════════════════════════
  //  3 — THE REVERSE DIRECTION: A CHATTY UI MUST NOT STARVE THE SYNC CYCLE
  // ══════════════════════════════════════════════════════════════════════════════════════

  it(
    "a chatty read loop does not starve the sync cycle — it still ingests every message",
    async () => {
      /**
       * The direction with the worse failure mode: a stalled READ is a spinner, a starved SYNC CYCLE
       * is mail that silently never arrives. Completion alone passed while the product was broken —
       * this case printed `ingest throughput retained: 0.0%` for five weeks, and the mail caught up
       * only once the readers ran out of budget — so the loaded SHARE of this run's quiet rate is
       * asserted, against {@link LOADED_INGEST_SHARE_FLOOR}. Two things were in the way: the readers
       * out-competed the cycle for the one connection (thousands of statements against a handful in a window), and a
       * poll loop over in-process WASM starved the EVENT LOOP the cycle's MIME parse settles on
       * (14.9 s). `store-lanes.ts` answers both, and both are asserted here.
       */
      /**
       * THE COMPARISON IS OVER THE SAME WINDOW, MEASURED THE SAME WAY IN BOTH RUNS.
       *
       * An earlier version compared "messages ingested while the readers ran" against the quiet
       * run's AVERAGE rate. That is not like for like: the first moments of a cycle are
       * `buildCursor` and the batch, during which the mean rate has not been reached yet, so any
       * shortfall in a short window is partly an artefact of where the window sits. Both runs are
       * therefore sampled identically — at {@link LOAD_WINDOW_MS} after the drain is kicked, by
       * the same query, with the rate taken over the interval that query actually returned in.
       */
      const sampleProgress = async (w: World, startedAt: number): Promise<{ msgs: number; atMs: number }> => {
        while (performance.now() - startedAt < LOAD_WINDOW_MS) await tick();
        // The count is dated by when it RETURNS, not by when it was asked for: under load the
        // query queues too, and dating it by the request would overstate the rate.
        const rows = await ingested(w);
        return { msgs: rows.length - SEED_MESSAGES, atMs: performance.now() - startedAt };
      };

      /**
       * BOTH ARMS OPEN THE BOOTSTRAP THE SAME WAY, BEFORE EITHER WINDOW DOES.
       *
       * A launch's first drain waits for the window's bootstrap page, or for a grace from the
       * moment the door starts serving. This rig has no renderer, so with nothing asking, BOTH
       * arms would spend their whole {@link LOAD_WINDOW_MS} inside that grace — and since the two
       * are the same 1 500 ms, the quiet control sampled zero and refused on its own anti-vacuity
       * line. The premise moved, so the comparison is re-derived rather than re-pinned: each arm
       * performs the one bootstrap read a real client performs, and only then opens its window, so
       * both measure the cycle and neither measures the grace.
       */
      const openTheBootstrap = async (w: World): Promise<void> => {
        const res = await w.call("/sync/snapshot");
        expect(res.status, "the bootstrap page a real client opens with was refused").toBe(200);
      };

      const quiet = await standUp();
      quiet.mailbox.add(SEED_MESSAGES, "seed");
      await quiet.sidecar.start();
      await openTheBootstrap(quiet);
      quiet.mailbox.add(CYCLE_MESSAGES, "cycle");
      const quietStarted = performance.now();
      const quietSample = sampleProgress(quiet, quietStarted);
      await quiet.sidecar.syncUntilQuiet();
      const quietMs = performance.now() - quietStarted;
      const quietWindow = await quietSample;
      expect(await ingested(quiet)).toHaveLength(SEED_MESSAGES + CYCLE_MESSAGES);

      // The same work again, on its own world, with the UI hammering throughout the window.
      const busy = await standUp();
      busy.mailbox.add(SEED_MESSAGES, "seed");
      await busy.sidecar.start();
      // The SAME release, in the same place, before this arm's window — see `openTheBootstrap`.
      await openTheBootstrap(busy);
      busy.mailbox.add(CYCLE_MESSAGES, "cycle");

      let chatting = true;
      let readsIssued = 0;
      let readsFailed = 0;
      /**
       * THE ROWS THE READERS ACTUALLY GOT BACK — the control that was missing, and its absence is
       * why the budget beside it described nothing.
       *
       * Until 2026-09-11 every ingested row carried `folder_state` ‘ohmail/Screener’ while
       * `view=imbox` asks for INBOX, so this “read” was two statements that assembled NO rows, at
       * ~520/s. The load was an empty answer and the case could not tell. A read that returns
       * nothing is not a load, so the count is taken and asserted rather than assumed.
       */
      let readRowsSeen = 0;
      const chatter = Array.from({ length: CHATTY_READERS }, async () => {
        while (chatting && readsIssued < CHATTY_READ_BUDGET) {
          readsIssued++;
          try {
            const res = await busy.call("/messages?view=imbox&limit=20");
            if (res.status !== 200) readsFailed++;
            const page = await res.json() as { items?: unknown[] };
            readRowsSeen += page.items?.length ?? 0;
          } catch {
            readsFailed++;
          }
        }
      });

      /**
       * HOW LONG THE EVENT LOOP WENT WITHOUT A TURN, which is the other half of the defect.
       *
       * `setImmediate` and not a timer: the check phase is where a stream's own callbacks settle,
       * so it is the phase the sync cycle's MIME parse is waiting in. Re-armed from its own
       * callback, `unref`'d so it can never hold the process, and stopped with the window — a probe
       * that outlived its measurement would keep the loop busy for every case after this one.
       */
      let loopLagMs = 0;
      let probingLoop = true;
      const probeLoopTurn = (): void => {
        const armedAt = performance.now();
        setImmediate(() => {
          if (!probingLoop) return;
          loopLagMs = Math.max(loopLagMs, performance.now() - armedAt);
          probeLoopTurn();
        }).unref?.();
      };
      probeLoopTurn();

      const busyStarted = performance.now();
      const busySample = sampleProgress(busy, busyStarted).finally(() => {
        // The readers exist to load the WINDOW. Left running they would also load the tail, and
        // the total wall time below would stop being comparable with the quiet run's.
        chatting = false;
        probingLoop = false;
      });
      await busy.sidecar.syncUntilQuiet();
      const busyMs = performance.now() - busyStarted;
      chatting = false;
      const busyWindow = await busySample;
      await Promise.all(chatter);

      probingLoop = false;
      const quietRate = quietWindow.msgs / quietWindow.atMs;
      const busyRate = busyWindow.msgs / busyWindow.atMs;
      const retained = busyRate / quietRate;
      report("sync cycle under concurrent reads", {
        "messages per cycle": CYCLE_MESSAGES,
        "load window": ms(LOAD_WINDOW_MS),
        "readers": CHATTY_READERS,
        "reads issued in the window": `${readsIssued} of a ${CHATTY_READ_BUDGET} budget`,
        "reads failed": readsFailed,
        "rows the readers got back": readRowsSeen,
        "longest the event loop went without a turn": ms(loopLagMs),
        "read rate": `${((readsIssued / busyWindow.atMs) * 1000).toFixed(0)} reads/s`,
        "ingested in the window, quiet": `${quietWindow.msgs} in ${ms(quietWindow.atMs)} (${(quietRate * 1000).toFixed(1)} msg/s)`,
        "ingested in the window, loaded": `${busyWindow.msgs} in ${ms(busyWindow.atMs)} (${(busyRate * 1000).toFixed(1)} msg/s)`,
        "ingest throughput retained": `${(retained * 100).toFixed(1)}% (floor ${(LOADED_INGEST_SHARE_FLOOR * 100).toFixed(0)}%)`,
        "whole cycle, quiet": ms(quietMs),
        "whole cycle, loaded for the first window then quiet": ms(busyMs),
      });

      expect(readsFailed, "the read loop got non-200 answers while the cycle ran").toBe(0);
      expect(readsIssued, "the read loop never got a turn at all — that IS the starvation, inverted")
        .toBeGreaterThan(0);
      expect(quietWindow.msgs, "the quiet control ingested nothing, so it is not a control")
        .toBeGreaterThan(0);
      // THE LOAD HAS TO BE A LOAD. See `readRowsSeen`: an empty answer costs two statements and
      // loads nothing, and this case spent five weeks reporting one as though it were traffic.
      expect(readRowsSeen, "the readers' list came back EMPTY, so nothing here loaded the store")
        .toBeGreaterThan(0);
      // THE EVENT LOOP KEPT TURNING — BEFORE the budget, deliberately. A starved loop stretches the
      // window, and a stretched window exhausts ANY budget, so the budget line would otherwise be the
      // only one that ever spoke and the ceiling below it could not be watched fail (measured: with
      // the check-phase hop removed and the budget raised tenfold, the budget assertion still fired
      // first, at a loop lag of 43 756 ms). The cause reports before the symptom.
      // Measured at 14 871 ms on the build before `store-lanes.ts`;
      // this ceiling is a liveness one, twenty-four times the reading a healthy build gives.
      expect(loopLagMs, "the event loop did not get a turn while the readers polled, so anything the "
        + "cycle awaits off the store — its MIME parse — stopped dead").toBeLessThan(LOOP_TURN_CEILING_MS);
      // …and the BUDGET may not be what ended the load, or the ratio below is a lower bound
      // wearing a measurement's clothes. See {@link CHATTY_READ_BUDGET}.
      expect(readsIssued, `the read budget (${CHATTY_READ_BUDGET}) ran out before the window closed, `
        + "so the ratio below is a lower bound and not a reading").toBeLessThan(CHATTY_READ_BUDGET);
      // THE MAIL KEPT MOVING, as a share of this run's own quiet rate: the host slows both arms.
      expect(retained, `the sync cycle kept ${(retained * 100).toFixed(1)}% of its quiet ingest rate (`
        + `${(busyRate * 1000).toFixed(1)} of ${(quietRate * 1000).toFixed(1)} msg/s) while eight readers `
        + "polled — the readers are holding back the mail")
        .toBeGreaterThanOrEqual(LOADED_INGEST_SHARE_FLOOR);
      // PROGRESS, not speed: every message the cycle was given is in the mirror.
      expect(
        await ingested(busy),
        "the sync cycle did not finish its batch while the UI was reading",
      ).toHaveLength(SEED_MESSAGES + CYCLE_MESSAGES);
      expect(busyMs, "the sync cycle did not complete within the hang ceiling under read load")
        .toBeLessThan(HANG_CEILING_MS);
    },
    240_000,
  );

  // ══════════════════════════════════════════════════════════════════════════════════════
  //  4 — `inFlight` IS UNBOUNDED. WHAT DOES A DEEP QUEUE ACTUALLY COST?
  // ══════════════════════════════════════════════════════════════════════════════════════

  it(
    "500 reads queued behind a busy database are all answered, and the queue's memory cost is measured",
    async () => {
      /**
       * `host.ts:53` counts in-flight requests and NOTHING bounds them: `onData` dispatches every
       * frame it decodes and returns to the stream, so the accept rate is the pipe's, not the
       * database's. Each accepted request holds a decoded `Request` (headers + body) for as long
       * as it waits, and eventually a buffered `Response`.
       *
       * Whether that is a defect is a question about SIZE, so it is measured rather than argued.
       * The measurement said NO — ~99 KiB per queued read, ~48 MiB for 500 — so `host.ts` was left
       * alone. Two things were learned on the way and both belong to whoever revisits this:
       *
       *  · **`inFlight` counts ACCEPTANCE, not execution.** `dispatch` increments it and then
       *    starts the handler, so serialising the handlers does not lower it — mutating `host.ts`
       *    to run every handler on one chained promise left the peak at 250, unchanged. A bound
       *    that actually caps memory therefore has to act in `onData`, by not decoding the next
       *    frame, and not in `dispatch`.
       *  · **The exposure is a product of body size, and the peer is the parent process.** The cap
       *    per request is `MAX_BODY_BYTES` (32 MiB), so an unbounded window is arithmetically
       *    unbounded — but there is no TCP listener and the only party able to write frames is the
       *    shell that spawned this process and owns the pipe. There is no third party to flood it.
       */
      const w = await standUp();
      w.mailbox.add(SEED_MESSAGES, "seed");
      await w.sidecar.start();
      const targets = await ingested(w);

      w.mailbox.add(QUEUE_CYCLE_MESSAGES, "cycle");
      const cycle = await cycleInFlight(w);
      expect(cycle.settled(), "the cycle finished before the queue was built").toBe(false);

      // Read at the deepest point the queue actually reaches, recorded from inside the dispatch
      // itself — see `World.probe` for why a polling sampler reports zero here.
      const before = process.memoryUsage();
      let inFlightPeak = 0;
      let atPeak = before;
      w.probe((depth) => {
        if (depth <= inFlightPeak) return;
        inFlightPeak = depth;
        atPeak = process.memoryUsage();
      });

      const pending: Array<Promise<Response>> = [];
      for (let i = 0; i < QUEUE_DEPTH; i++) {
        const id = targets[i % targets.length]!.id;
        pending.push(within(`queued read #${i} (/messages/${id})`, w.call(`/messages/${id}`)));
      }

      const answers = await Promise.allSettled(pending);
      w.probe(null);
      await cycle.done;

      const failed = answers.filter((a) => a.status === "rejected");
      expect(failed.map((f) => String((f as PromiseRejectedResult).reason)), "queued requests were lost")
        .toEqual([]);
      const statuses = new Set(
        (answers as PromiseFulfilledResult<Response>[]).map((a) => a.value.status),
      );
      expect([...statuses], "a queued request was answered with something other than 200").toEqual([200]);

      const rssDeltaMb = (atPeak.rss - before.rss) / 1024 / 1024;
      const heapDeltaMb = (atPeak.heapUsed - before.heapUsed) / 1024 / 1024;
      report("accept-window cost", {
        "queued requests": QUEUE_DEPTH,
        "peak host.inFlight": inFlightPeak,
        "RSS delta at peak": `${rssDeltaMb.toFixed(1)} MiB`,
        "heapUsed delta at peak": `${heapDeltaMb.toFixed(1)} MiB`,
        "heapUsed per queued request": `${((atPeak.heapUsed - before.heapUsed) / QUEUE_DEPTH / 1024).toFixed(1)} KiB`,
        "//": "deltas span a window in which the sync cycle was also allocating — an UPPER bound, "
          + "and RSS can go negative because a GC inside the window is not suppressible here",
      });

      /**
       * The queue has to be REAL, or the memory figure above describes nothing.
       *
       * The threshold is a fraction of {@link QUEUE_DEPTH} and not QUEUE_DEPTH itself, because
       * the peak is Little's law and not a constant: the depth is (arrival rate × service time),
       * and the client can only put frames on the wire so fast. Measured here, 500 reads fired at
       * an engine mid-cycle peaked at ~250 in flight — by the time the 250th frame had been
       * written the first answers were coming back. That is still an unbounded window: nothing in
       * `host.ts` set that number, the arithmetic did, and a slower database or a faster peer
       * moves it straight up. Pinning it AT 500 would be pinning the measurement to this laptop.
       */
      expect(inFlightPeak, "the requests never actually queued, so nothing was measured")
        .toBeGreaterThan(100);
      /**
       * WHY THE BOUND IS THIS LOOSE, AND WHAT WOULD ACTUALLY TRIP IT.
       *
       * This is not a memory budget — a budget asserted against a shared, GC'd heap in a suite
       * that also runs a sync cycle would be a flake generator. It is a SHAPE check. A queued
       * request holds a decoded `Request` and, later, a buffered `Response`, so its cost is
       * proportional to the request's own bytes: for the UI reads measured here that is tens to
       * low hundreds of KiB apiece. What would be a defect is a cost that tracks `MAX_BODY_BYTES`
       * (32 MiB) instead — 500 of those is 16 GiB, and it would blow through this bound long
       * before it got there.
       *
       * `heapUsed` and not RSS, deliberately: RSS moves with the allocator's decision to return
       * pages to the OS and went NEGATIVE in a measured run (a GC landed inside the window). It
       * is reported because it is what the brief asked for, and asserted on because it is not
       * what it appears to measure.
       */
      expect(
        heapDeltaMb,
        `${QUEUE_DEPTH} queued reads cost ${heapDeltaMb.toFixed(1)} MiB of heap — the accept window needs a bound`,
      ).toBeLessThan(256);
    },
    240_000,
  );
});
