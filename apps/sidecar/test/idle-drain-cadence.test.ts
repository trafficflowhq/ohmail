import { readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { changeLog, mailboxes, messages } from "@trafficflow/db";
import {
  IDLE_POLL_CEILING_MS, createSidecar, nextIdlePollMs, type Sidecar,
} from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * AN IDLE MAILBOX RESTS — only behind a doorbell that rings. After first sync this engine drained
 * every few seconds for ever (several times its CPU budget); `MailboxAdapter.watch` (IMAP IDLE)
 * is required of every adapter and this door never armed it. Cases: (a) the ladder climbs to a
 * ceiling and any answer-changing event resets it; (b) an empty drain publishes nothing; (c) mail
 * arrives inside one BASE interval; (d) no doorbell, no rest. WATCHED FAILING in `engine.ts`, each
 * restored `cmp`-equal: `nextIdlePollMs` `Math.min`->`Math.max` reddens THE LADDER; `noteIdleOutcome`'s
 * `if (!quiet)` arm deleted reddens THE RESET; the `wakePending` early return deleted reddens THE
 * DOORBELL; `restMayBeTaken = true`->`false` THE LADDER; `caps.idle` inverted NO DOORBELL, NO REST.
 */

/** `ohmail/_meta` in memory, starting EMPTY — nobody holds this mailbox but us. */
class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  reads = 0;
  async listClaims(): Promise<RawClaimMessage[]> { this.reads += 1; return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }
  uidValidity(): number | bigint | null { return 4_100; }
}

const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

function arrival(uid: number): Buffer {
  return Buffer.from([
    `Message-ID: <idle-${uid}@stranger.test>`,
    "From: stranger@elsewhere.test",
    "To: owner@trafficflow.test",
    `Subject: idle mail ${uid}`,
    "Date: Wed, 02 Sep 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "hello",
  ].join("\r\n"), "utf8");
}

/**
 * A mailbox with a doorbell. `deliver(uid)` puts mail on the server and `ring()` is the server
 * pushing EXISTS down the IDLE — the two halves kept APART on purpose, so a case can prove which
 * one moved the mail.
 */
interface Rig {
  factory: (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo };
  deliver: (uid: number) => void;
  ring: () => void;
  /** Did the engine subscribe at all, and did it put the IDLE back after each drain? */
  watched: () => boolean;
  rearms: () => number;
  /** The most `changesSince` calls ever in flight at once — one drain at a time is the rule. */
  maxInFlight: () => number;
  /** How many cycles asked the server for changes, and how many times the lease was read. */
  cycles: () => number;
  leaseReads: () => number;
}

function rig(opts: { idle?: boolean; drainMs?: number } = {}): Rig {
  const meta = new MemoryMetaFolder();
  const pending: number[] = [];
  let signal: (() => void) | null = null;
  let rearms = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let cycles = 0;
  return {
    maxInFlight: () => maxInFlight,
    cycles: () => cycles,
    leaseReads: () => meta.reads,
    deliver: (uid) => { pending.push(uid); },
    ring: () => { signal?.(); },
    watched: () => signal !== null,
    rearms: () => rearms,
    factory: (_cfg) => ({
      leaseIo: () => meta,
      async connect(): Promise<void> {},
      async close(): Promise<void> {},
      async capabilities(): Promise<ImapCapabilities> {
        return {
          move: true, uidplus: true, condstore: true, qresync: false,
          idle: opts.idle ?? true, specialUse: true, sentFolder: null,
        };
      },
      async ensureFolders(): Promise<void> {},
      async changesSince(): Promise<ChangeBatch> {
        cycles += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (opts.drainMs) await new Promise((r) => setTimeout(r, opts.drainMs));
        } finally {
          inFlight -= 1;
        }
        if (pending.length === 0) return { ...EMPTY_BATCH };
        const uids = pending.splice(0);
        return {
          creates: uids.map((uid) => ({
            type: "create" as const,
            locator: { folder: "INBOX", ref: `1:${uid}` } as NativeLocator,
            raw: arrival(uid),
          })) as ChangeBatch["creates"],
          moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
        };
      },
      async move(locator: NativeLocator): Promise<NativeLocator> { return locator; },
      async setFlags(): Promise<void> {},
      async scanSentRecipients(): Promise<string[]> { return []; },
      async watch(onSignal: () => void): Promise<() => Promise<void>> {
        signal = onSignal;
        return async () => { signal = null; };
      },
      async rearmWatch(): Promise<void> { rearms += 1; },
      async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("cannot send"); },
      async fetchPart(): Promise<FetchedPart> { throw new Error("cannot fetchPart"); },
    }),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll a predicate to a deadline. Answers whether it came true — never throws on the timeout. */
async function within(ms: number, p: () => boolean | Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await p()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(10);
  }
}

describe("the idle drain cadence rests behind a doorbell", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  interface Booted { sidecar: Sidecar; drains: () => number; backoffs: () => number[] }

  async function boot(
    r: Rig, pollIntervalMs: number, idlePollCeilingMs: number, extra: { monotonic?: () => number } = {},
  ): Promise<Booted> {
    const dataDir = await freshDataDir("ohmail-idle-");
    let drains = 0;
    const backoffs: number[] = [];
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "idle host",
      pollIntervalMs,
      idlePollCeilingMs,
      leaseStaleAfterMs: 24 * 3600 * 1000,
      adapterFactory: r.factory,
      ...(extra.monotonic ? { monotonic: extra.monotonic } : {}),
      log: (event, fields) => {
        if (event === "sync_drain") drains += 1;
        if (event === "sync_idle_backoff") backoffs.push((fields as { nextPollMs: number }).nextPollMs);
      },
    });
    cleanups.push(async () => {
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    await sidecar.start();
    return { sidecar, drains: () => drains, backoffs: () => [...backoffs] };
  }

  /* ── (a) THE LADDER ──────────────────────────────────────────────────────────────────────── */

  it("THE LADDER, as arithmetic: 15 s doubles to the two-minute ceiling and stays there", () => {
    const base = 15_000;
    const cap = IDLE_POLL_CEILING_MS;
    expect(IDLE_POLL_CEILING_MS, "the ceiling is two minutes — an eighth of the 10 min stale bound")
      .toBe(120_000);
    let d = base;
    const ladder: number[] = [];
    for (let i = 0; i < 5; i++) { d = nextIdlePollMs(d, base, cap); ladder.push(d); }
    expect(ladder).toEqual([30_000, 60_000, 120_000, 120_000, 120_000]);
    // The base FLOORS it: a configured interval above the ceiling is honoured, never shortened.
    expect(nextIdlePollMs(200_000, 200_000, 120_000)).toBe(200_000);
    // And a current below base cannot drag the ladder under the interval the caller asked for.
    expect(nextIdlePollMs(1, 15_000, 120_000)).toBe(30_000);
  });

  it("THE LADDER, in the engine: empty drains climb 2x, 4x, then stop at the ceiling", async () => {
    const r = rig();
    const b = await boot(r, 60, 240);
    expect(await within(20_000, () => b.backoffs().length >= 2),
      "an idle mailbox never backed off").toBe(true);
    // The line is written only when the delay MOVES, so a settled mailbox writes exactly these
    // two and then goes quiet — the ceiling is a rest, not a per-poll log.
    expect(b.backoffs().slice(0, 2)).toEqual([120, 240]);
    const at = b.backoffs().length;
    await sleep(1_500);
    expect(b.backoffs().length, "the ladder climbed past its own ceiling").toBe(at);
    expect(r.watched(), "the engine never armed the INBOX watch").toBe(true);
    expect(r.rearms(), "the IDLE was never put back on INBOX after a drain")
      .toBeGreaterThanOrEqual(1);
  });

  it("THE RESET: a ring puts the ladder back at base, and the climb starts again", async () => {
    const r = rig();
    const b = await boot(r, 60, 240);
    expect(await within(20_000, () => b.backoffs().length >= 2), "no climb").toBe(true);
    const before = b.backoffs().length;
    r.ring();
    /* The ladder is at base again, so the very next empty drains re-climb — the same two rungs,
       appended. Without the reset there is nothing left to log: the ceiling is already held. */
    expect(await within(20_000, () => b.backoffs().length >= before + 2),
      "the doorbell did not reset the ladder").toBe(true);
    expect(b.backoffs().slice(before, before + 2)).toEqual([120, 240]);
  });

  /* ── (b) AN EMPTY DRAIN PUBLISHES NOTHING ────────────────────────────────────────────────── */

  it("TEN EMPTY DRAINS PUBLISH NOTHING — the window's change log does not move", async () => {
    // Ceiling AT the base, so nothing rests and ten drains arrive in a second: this case is about
    // what a drain WRITES, and it must be measured on the fast cadence or it measures the rest.
    const r = rig();
    const b = await boot(r, 60, 60);
    const { accountId } = b.sidecar.world;
    const rowsNow = async (): Promise<number> => (await b.sidecar.db.select()
      .from(changeLog).where(eq(changeLog.accountId, accountId))).length;
    const settled = await rowsNow();
    const from = b.drains();
    expect(await within(20_000, () => b.drains() >= from + 10), "ten drains never ran").toBe(true);
    expect(b.backoffs(), "a ceiling at the base is not a rest").toEqual([]);
    expect(await rowsNow(),
      "an empty drain wrote to the change log, so the window re-renders for nothing")
      .toBe(settled);
  });

  /* ── (c) THE REST COSTS NO FRESHNESS ─────────────────────────────────────────────────────── */

  it("MAIL ARRIVES ON THE DOORBELL, inside one base interval and long before the timer", async () => {
    /* A base interval of five seconds and a ceiling above it: if the mail waits for a poll this
       case cannot pass inside its own budget, which is the point. */
    const r = rig();
    const b = await boot(r, 5_000, 20_000);
    const mailboxId = b.sidecar.world.mailboxId;
    const mirrored = async (): Promise<number> => (await b.sidecar.db.select()
      .from(messages).where(eq(messages.mailboxId, mailboxId))).length;
    expect(await mirrored(), "the rig delivered before the case started").toBe(0);
    r.deliver(7);
    // THE NEGATIVE HALF, in the same case: mail on the server that nobody rang for waits.
    await sleep(600);
    expect(await mirrored(), "a drain ran without a ring or a poll — this case proves nothing")
      .toBe(0);
    const rangAt = Date.now();
    r.ring();
    expect(await within(4_000, async () => (await mirrored()) === 1),
      "the doorbell did not deliver the mail").toBe(true);
    expect(Date.now() - rangAt, "the mail waited out a poll interval instead of the ring")
      .toBeLessThan(5_000);
  });

  /* A PRESS ASKING FOR THE WIRE RINGS THE SAME DOORBELL (`withPullKick`): a standalone Move
     waited for the next poll, because `POST /sync/pull` stamps a request only the hosted worker
     reads. The ring is the INBOX doorbell, so presses during a drain coalesce into one. */
  it("A PRESS RINGS THE DOORBELL — mail moves inside one base interval, one drain at a time", async () => {
    const r = rig({ drainMs: 150 });
    const b = await boot(r, 5_000, 20_000);
    const mailboxId = b.sidecar.world.mailboxId;
    const mirrored = async (): Promise<number> => (await b.sidecar.db.select()
      .from(messages).where(eq(messages.mailboxId, mailboxId))).length;
    await sleep(600);
    r.deliver(11);
    const pull = (): Promise<Response> => b.sidecar.handle(new Request("http://local/sync/pull", {
      method: "POST",
      headers: { authorization: `Bearer ${b.sidecar.sessionToken}`, "content-type": "application/json" },
      body: "{}",
    }));
    const before = b.drains();
    const pressedAt = Date.now();
    const answers = await Promise.all([pull(), pull(), pull()]);
    expect(answers.map((a) => a.status)).toEqual([202, 202, 202]);
    expect(await within(4_000, async () => (await mirrored()) === 1),
      "the press did not move the mail before the poll").toBe(true);
    expect(Date.now() - pressedAt).toBeLessThan(5_000);
    await sleep(800);
    expect(r.maxInFlight(), "two drains ran at once").toBe(1);
    expect(b.drains() - before, "three presses inside one drain were not one drain").toBeLessThanOrEqual(2);
  });

  const pullOf = (b: Booted, body = "{}") => (): Promise<Response> => b.sidecar.handle(new Request("http://local/sync/pull", {
    method: "POST",
    headers: { authorization: `Bearer ${b.sidecar.sessionToken}`, "content-type": "application/json" },
    body,
  }));

  /* PRESSES DURING ONE DRAIN ARE ONE MORE DRAIN, NOT ONE EACH: a press while a rung drain waits to
     start is that drain; a press after it started (its mail may be past the walk) queues one more.
     And the lease is read at most once per drain, however many presses rang it (ARCH § 2). */
  it("SPACED PRESSES COALESCE, the lease is read at most once per drain, and a late press is still served", async () => {
    const r = rig({ drainMs: 400 });
    const b = await boot(r, 5_000, 20_000);
    await sleep(600);
    const pull = pullOf(b);
    const cycles0 = r.cycles(); const leases0 = r.leaseReads();
    for (let i = 0; i < 8; i++) { expect((await pull()).status).toBe(202); await sleep(120); }
    await sleep(2_000);
    const cycles = r.cycles() - cycles0;
    // 960 ms of presses over 400 ms drains: at most one queued drain per running drain, so four.
    expect(cycles, "eight presses queued a drain each").toBeLessThanOrEqual(4);
    // AT MOST once per drain: a permit still fresh is adopted rather than read again.
    expect(r.leaseReads() - leases0, "the lease was read more than once per drain").toBeLessThanOrEqual(cycles);
    expect(r.maxInFlight(), "two drains ran at once").toBe(1);
    const mailboxId = b.sidecar.world.mailboxId;
    r.deliver(41);
    const pressedAt = Date.now();
    expect((await pull()).status).toBe(202);
    expect(await within(3_000, async () => (await b.sidecar.db.select()
      .from(messages).where(eq(messages.mailboxId, mailboxId))).length === 1), "a press after the drains was not served").toBe(true);
    expect(Date.now() - pressedAt).toBeLessThan(5_000);
  });

  it("A PRESS NAMING ANOTHER MAILBOX RINGS NOTHING HERE", async () => {
    const r = rig();
    const b = await boot(r, 5_000, 20_000);
    await sleep(600);
    const mailboxId = b.sidecar.world.mailboxId;
    r.deliver(51);
    expect((await pullOf(b, JSON.stringify({ mailboxIds: ["not-this-one"] }))()).status).toBe(202);
    await sleep(3_500);
    expect((await b.sidecar.db.select().from(messages).where(eq(messages.mailboxId, mailboxId))).length,
      "a press about another mailbox drained this one").toBe(0);
    expect((await pullOf(b, JSON.stringify({ mailboxIds: [mailboxId] }))()).status).toBe(202);
    expect(await within(3_000, async () => (await b.sidecar.db.select()
      .from(messages).where(eq(messages.mailboxId, mailboxId))).length === 1), "the named mailbox was not rung").toBe(true);
  });

  /* A RING A HAND-BACK OVERTOOK left `wakePending` set, so after `resume()` nothing polled again
     (REVIEW-026-PHONE-SAYS-EVERY-PRESS-2 HIGH-2). The same-tick arm is the one the base failed. */
  for (const arm of ["ring then hand-back in one tick", "press then hand-back", "hand-back alone"] as const) {
    it(`AFTER A HAND-BACK AND A RESUME THE MAILBOX POLLS AGAIN — ${arm}`, async () => {
      const r = rig();
      const b = await boot(r, 1_000, 1_000);
      const mailboxId = b.sidecar.world.mailboxId;
      await sleep(1_500);
      if (arm === "ring then hand-back in one tick") { r.ring(); void b.sidecar.handBack(); }
      else if (arm === "press then hand-back") {
        const res = await pullOf(b)().then((x) => { void b.sidecar.handBack(); return x; });
        expect(res.status).toBe(202);
      } else void b.sidecar.handBack();
      await sleep(300);
      await b.sidecar.resume();
      /* PAST THE RESUME'S OWN DRAIN (the first-page grace mirrors what is there), so the mail below
         can only be found by a poll — which is what the flags decide. */
      await sleep(3_000);
      r.deliver(31);
      expect(await within(5_000, async () => (await b.sidecar.db.select()
        .from(messages).where(eq(messages.mailboxId, mailboxId))).length === 1),
        "the mailbox never polled again after resume").toBe(true);
    });
  }

  it("EVERY CANCELLED POLL TIMER TAKES THE RING'S FLAGS — a source census over the runtime's sites", () => {
    /* A ring's timer cancelled never fires, so a flag left set stops every later `schedule()`: the
       mailbox never polls again (REVIEW-026-PHONE-SAYS-EVERY-PRESS-2 HIGH-2, VERIFY LOW-1). Exempt by
       name: `schedule()`'s own re-arm, and the two stops a runtime never comes back from.
       WATCHED FAILING: drop either flag line beside the timer in `quiesce()` or the forgotten login. */
    const src = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8");
    const lines = src.split("\n");
    const sites = lines.flatMap((l, i) => (/^\s*if \(timer\) (\{ )?clearTimeout\(timer\)/.test(l) ? [i] : []));
    const exempt = (i: number): string | null => {
      const near = lines.slice(Math.max(0, i - 3), i + 2).join("\n");
      if (/const kick = delayMs === 0;/.test(lines[i + 1] ?? "")) return "schedule's re-arm";
      // `detach()`'s body, which a quit also runs on its own two instants (`detachBy`).
      if (/by: DetachBounds, quit: boolean/.test(near)) return "detach";
      if (/releaseRefusal: null, holderState: null };\n\s*stopped = true;/.test(near)) return "a mailbox removed mid-read";
      return null;
    };
    const named = sites.map(exempt).filter((x) => x !== null);
    expect([...named].sort(), "the exempt sites moved — this census is measuring nothing")
      .toEqual(["a mailbox removed mid-read", "detach", "schedule's re-arm"]);
    const owed = sites.filter((i) => exempt(i) === null);
    expect(owed.length, "the sites that must clear the flags moved").toBe(4);
    for (const i of owed) {
      const after = lines.slice(i + 1, i + 4).join("\n");
      expect(/wakePending = false;/.test(after) && /ringQueued = false;/.test(after),
        `engine.ts:${i + 1} cancels the poll timer and keeps the ring's flags`).toBe(true);
    }
  });

  it("A DRAIN THAT FINDS MAIL FALLS BACK TO BASE — no ring needed, the work is the evidence", async () => {
    /* The other half of the reset, and the half no doorbell touches: mail put on the server while
       the ladder is at its ceiling is found by the NEXT ordinary poll, and that drain is not a
       quiet one — the cadence returns to base and climbs again from there. Measured through the
       change the drain wrote, which is the same fact the scheduler reads. */
    const r = rig();
    const b = await boot(r, 60, 240);
    expect(await within(20_000, () => b.backoffs().length >= 2), "no climb").toBe(true);
    const before = b.backoffs().length;
    const mailboxId = b.sidecar.world.mailboxId;
    r.deliver(11);
    expect(await within(20_000, async () => (await b.sidecar.db.select()
      .from(messages).where(eq(messages.mailboxId, mailboxId))).length === 1),
      "the poll never found the mail").toBe(true);
    expect(await within(20_000, () => b.backoffs().length >= before + 2),
      "a drain that mirrored a message left the ladder where it was").toBe(true);
    expect(b.backoffs().slice(before, before + 2)).toEqual([120, 240]);
  });

  /* ── (c2) A DOOR THAT WROTE SOMETHING RESETS THE CADENCE ─────────────────────────────── */

  it("EVERY DOOR DISPATCH TELLS THE LADDER — a source census over the two call sites", () => {
    /* The window and a paired device file their moves through the API, and the drain is what puts
       them on the mail server: a ladder that slept through a door write would leave a move the
       person watched happen up to two minutes from IMAP. The reset is wired at the two places a
       request is answered, and this reads THE CALL rather than the symbol — a census satisfied by
       a name appearing passes for a file that never calls it.

       WATCHED FAILING: delete either `noteDoorWrite(req, answered);` line in
       `apps/sidecar/src/engine.ts` and this goes red naming the dispatch that went quiet. */
    const src = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8");
    const lines = src.split("\n");
    const dispatches: number[] = [];
    lines.forEach((l, i) => {
      // A search is dispatched through `asPerson` (the store's person lane); it is still the dispatch.
      if (/const answered = await (?:asPerson\(req, \(\) => )?\w+\.handle\(req,/.test(l)) dispatches.push(i);
    });
    expect(dispatches.length, "the engine's door dispatches moved — this census is measuring nothing")
      .toBe(2);
    for (const i of dispatches) {
      const follows = lines.slice(i + 1, i + 3).join("\n");
      expect(
        /noteDoorWrite\(req, answered\);/.test(follows),
        `the dispatch at engine.ts:${i + 1} answers without telling the idle ladder`,
      ).toBe(true);
    }
    // …and the helper itself only rings on a request that ANSWERED and was not a read…
    expect(src).toContain('if (req.method === "GET" || req.method === "HEAD" || res.status >= 400) return;');
    /* …and it RESETS rather than drains. A door write that forced a pass would drain on the
       person's typing rhythm — a draft autosaves as they compose — so this reads the call the
       helper makes, which is the difference between the fix and a worse cadence than the one it
       replaced. WATCHED FAILING: put `syncUntilQuiet(undefined, { force: true })` back in the
       helper's loop and this goes red (it is also what reddened the standalone release race). */
    expect(src).toContain("for (const rt of runtimes.all()) rt.noteWorldMoved();");
    expect(src.includes("rt.syncUntilQuiet(undefined, { force: true })"),
      "a door write forces a drain again — the compose autosave now drives the engine").toBe(false);
  });

  /* ── (c3) THE PULL-IN ACROSS A SUSPEND AND A CLOCK STEP ───────────────────────────────── */
  /* A door write pulls a rested timer in to one base interval. What is left of that timer is read
     on the monotonic clock, the one its `setTimeout` runs on: after a suspend (wall +8 h) the wall
     clock said the timer was long past and the write waited out the whole rest. */
  async function pullInAfter(wallSkewMs: number): Promise<number> {
    const realNow = Date.now.bind(Date);
    const skew = { ms: 0 };
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew.ms);
    cleanups.push(() => { vi.restoreAllMocks(); });
    const r = rig();
    const b = await boot(r, 50, 5_000, { monotonic: () => performance.now() });
    // The write is a tag, which a reader may not make: this install organizes the mailbox.
    await b.sidecar.db.update(mailboxes).set({ organizeConsentedAt: new Date(), organizerRole: "organizer" });
    const until = async (ms: number, p: () => boolean): Promise<boolean> => {
      const t = performance.now();
      while (!p() && performance.now() - t < ms) await sleep(10);
      return p();
    };
    expect(await until(20_000, () => b.backoffs().includes(5_000)), "the ladder never reached its rest").toBe(true);
    skew.ms += wallSkewMs;
    const before = b.drains();
    const res = await b.sidecar.handle(new Request("http://local/tags", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${b.sidecar.sessionToken}` },
      body: JSON.stringify({ name: "pulled-in", hue: "moss" }),
    }));
    expect(res.status, `the door write was refused, so nothing tells the ladder: ${await res.clone().text()}`).toBeLessThan(400);
    const t = performance.now();
    await until(4_000, () => b.drains() > before);
    return performance.now() - t;
  }

  it("A DOOR WRITE PULLS THE RESTED TIMER IN AFTER A SUSPEND (wall +8 h, monotonic unmoved)", async () => {
    expect(await pullInAfter(8 * 3_600_000), "the write waited out the rest the suspend hid").toBeLessThan(1_500);
  });

  it("…AND AFTER A WALL CLOCK STEPPED BACK AN HOUR", async () => {
    expect(await pullInAfter(-3_600_000)).toBeLessThan(1_500);
  });

  it("CONTROL: with no clock change the write pulls the rested timer in", async () => {
    expect(await pullInAfter(0)).toBeLessThan(1_500);
  });

  /* ── (d) NO DOORBELL, NO REST ────────────────────────────────────────────────────────────── */

  it("A SERVER WITHOUT IDLE KEEPS THE OLD CADENCE — the rest is never taken on trust", async () => {
    const r = rig({ idle: false });
    const b = await boot(r, 60, 240);
    const from = b.drains();
    expect(await within(20_000, () => b.drains() >= from + 8), "the poll stopped").toBe(true);
    expect(b.backoffs(), "this mailbox rested behind a doorbell that does not exist").toEqual([]);
    expect(r.watched(), "the watch was armed on a server that advertises no IDLE").toBe(false);
    expect(r.rearms(), "the IDLE was re-armed on a connection that never had one").toBe(0);
  });
});
