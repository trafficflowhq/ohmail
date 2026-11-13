import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { apiRoutes } from "@trafficflow/api";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { drafts, mailboxCredentials, mailboxes, outboundSends, outboundSentCopies } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { SEND_RECONCILE_NET_TIMEOUTS } from "@trafficflow/services";
import { API_CRON_JITTER_MS, API_CRON_TARGETS } from "../../worker/src/api-cron.js";
import {
  ALERT_ROW, CLOCK_ROWS, SCHEDULED_SEND_FIRST_DELAY_MS, driveRow, rowsFor, runUnderLeader, startChains, type DrivenClock,
} from "../src/clocks.js";
import type { LeaderLock } from "../src/clock-lock.js";
import { ownedDbPort } from "../src/deps.js";
import { buildProgram } from "../src/program.js";
import { loadSettings } from "../src/settings.js";
import { PLAIN_ENV, PROCESS_DOOR, env, fixture, processInput, recordingLogger } from "./_envs.js";

/**
 * THE API'S OWN CLOCKS, without Postgres: the table against the schedule it mirrors, the chains,
 * the one-leader rule over a lock the test holds, and a self-hosted server's own chain on a
 * database in memory. The leader rule over a real Postgres lock, with two copies of the program,
 * is `clocks-two-copies.pg.test.ts`.
 */

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the table is the worker's schedule of the same passes, row for row", () => {
  it("same targets in the same order, same route, cadence, first delay and jitter", () => {
    expect(CLOCK_ROWS.map((row) => ({
      target: row.target, route: row.route, everyMs: row.everyMs, firstDelayMs: row.firstDelayMs, jitterMs: row.jitterMs,
    }))).toEqual(API_CRON_TARGETS.map((t) => ({
      target: t.target, route: t.route, everyMs: t.everyMs, firstDelayMs: t.firstDelayMs,
      jitterMs: t.jitterMs ?? API_CRON_JITTER_MS,
    })));
  });

  it("every row's route is one the managed route table serves", () => {
    const served = new Set(apiRoutes.filter((r) => r.method === "GET").map((r) => r.pattern));
    for (const row of [...CLOCK_ROWS, ALERT_ROW]) expect(served, row.target).toContain(row.route);
  });

  it("a self-hosted server drives the two passes nothing ran there; the managed service its own five", () => {
    const names = (rows: { target: string }[]): string[] => rows.map((r) => r.target);
    expect(names(rowsFor("plain").driven)).toEqual(["sessions_reap", "unsubscribe_drain"]);
    // The size probe dials a mail provider: left where it is until a dial from an always-on host has a reading.
    expect(names(rowsFor("plain").held)).toEqual(["smtp_size"]);
    expect(names(rowsFor("managed").driven)).toEqual(["sessions_reap", "unsubscribe_drain", "security_notices", "storage_mails", "alerts"]);
    expect(names(rowsFor("managed").held)).toEqual(["smtp_size", "scheduled_send", "send_reconcile", "away_responder", "account_lifecycle", "sent_copies"]);
  });

  it("no sending pass is driven from here: every row that dials a mail provider is held", () => {
    const sending = ["smtp_size", "scheduled_send", "send_reconcile", "away_responder", "sent_copies"];
    for (const row of CLOCK_ROWS) {
      if (sending.includes(row.target)) expect(row.hold, row.target).toBe("mail-dial");
    }
    expect(CLOCK_ROWS.find((r) => r.target === "account_lifecycle")?.hold).toBe("follow-ups");
  });
});

const clock = (over: Partial<DrivenClock> & { run: DrivenClock["run"] }): DrivenClock => ({
  name: "count", everyMs: 1_000, firstDelayMs: 100, jitterMs: 0, ...over,
});

describe("a chain: armed again only when its pass has settled", () => {
  it("runs at its first delay, then once per cadence, and never beside itself", async () => {
    vi.useFakeTimers();
    let running = 0;
    let most = 0;
    let runs = 0;
    const chains = startChains([clock({
      run: async () => {
        running += 1; most = Math.max(most, running); runs += 1;
        await new Promise((r) => setTimeout(r, 2_500));     // a pass slower than its cadence
        running -= 1;
      },
    })], recordingLogger().logger);
    await vi.advanceTimersByTimeAsync(99);
    expect(runs).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    // 100 ms, then 2.5 s of pass + 1 s of cadence per round: three rounds in ten seconds, never two at once.
    expect(runs).toBe(3);
    expect(most).toBe(1);
    await Promise.all([chains.stop(), vi.advanceTimersByTimeAsync(3_000)]);
  });

  it("a pass that throws is logged and the cadence continues", async () => {
    vi.useFakeTimers();
    const { logger, lines } = recordingLogger();
    let runs = 0;
    const chains = startChains([clock({ run: async () => { runs += 1; throw new Error("the pass fell over"); } })], logger);
    await vi.advanceTimersByTimeAsync(2_200);
    expect(runs).toBe(3);
    expect(lines.filter((l) => l.event === "api_clock_pass_failed")).toHaveLength(3);
    await chains.stop();
  });

  it("stop arms nothing more and waits for a pass in flight", async () => {
    vi.useFakeTimers();
    let finished = false;
    let runs = 0;
    const chains = startChains([clock({
      run: async () => { runs += 1; await new Promise((r) => setTimeout(r, 500)); finished = true; },
    })], recordingLogger().logger);
    await vi.advanceTimersByTimeAsync(150);
    const stopped = chains.stop();
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await stopped;
    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs).toBe(1);
  });

  it("jitter is added to a wait, never taken from it", async () => {
    vi.useFakeTimers();
    let runs = 0;
    const chains = startChains([clock({ jitterMs: 400, run: async () => { runs += 1; } })], recordingLogger().logger, () => 0.999);
    await vi.advanceTimersByTimeAsync(100 + 1_000);
    expect(runs, "the second run came before its cadence").toBe(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(runs).toBe(2);
    await chains.stop();
  });
});

/** One lock two copies contend on, in memory: `pg_try_advisory_lock`'s answers, and a way to lose it. */
function sharedLock(): { acquire: (url: string, key: bigint) => Promise<LeaderLock | null>; kill: () => void } {
  let holder: { lost: (e: never) => void } | null = null;
  return {
    kill: () => { const h = holder; holder = null; h?.lost(new Error("gone") as never); },
    acquire: async () => {
      if (holder) return null;
      let signal: (e: never) => void = () => {};
      const lost = new Promise<never>((resolve) => { signal = resolve; });
      const mine = { lost: signal };
      holder = mine;
      return {
        backendPid: 1,
        lost: lost as LeaderLock["lost"],
        verify: async () => holder === mine,
        release: async () => { if (holder === mine) holder = null; },
      };
    },
  };
}

describe("one driver across copies", () => {
  const copy = (lock: ReturnType<typeof sharedLock>, count: { n: number }) => runUnderLeader({
    url: "postgres://unused", retryMs: 100, acquire: lock.acquire, log: recordingLogger().logger,
    start: () => startChains([clock({ everyMs: 50, firstDelayMs: 10, run: async () => { count.n += 1; } })], recordingLogger().logger),
  });

  it("of two copies one drives; the other arms nothing; N ticks are N runs", async () => {
    vi.useFakeTimers();
    const lock = sharedLock();
    const a = { n: 0 };
    const b = { n: 0 };
    const first = copy(lock, a);
    const second = copy(lock, b);
    await vi.advanceTimersByTimeAsync(10 + 50 * 9);
    expect([first.leading(), second.leading()]).toEqual([true, false]);
    expect(a.n).toBe(10);
    expect(b.n, "the standby ran a pass").toBe(0);
    await first.stop();
    await second.stop();
  });

  it("when the leader stops, the standby drives within one retry", async () => {
    vi.useFakeTimers();
    const lock = sharedLock();
    const a = { n: 0 };
    const b = { n: 0 };
    const first = copy(lock, a);
    const second = copy(lock, b);
    await vi.advanceTimersByTimeAsync(200);
    await first.stop();
    const ran = a.n;
    await vi.advanceTimersByTimeAsync(100 + 10);
    expect(second.leading()).toBe(true);
    expect(b.n).toBeGreaterThan(0);
    expect(a.n, "a stopped copy ran again").toBe(ran);
    await second.stop();
  });

  it("a lock that is lost stops the clocks at once and the copy stands by", async () => {
    vi.useFakeTimers();
    const lock = sharedLock();
    const a = { n: 0 };
    const first = copy(lock, a);
    await vi.advanceTimersByTimeAsync(200);
    expect(first.leading()).toBe(true);
    lock.kill();
    await vi.advanceTimersByTimeAsync(1);
    expect(first.leading()).toBe(false);
    const ran = a.n;
    await vi.advanceTimersByTimeAsync(60);
    expect(a.n, "a copy without the lock kept driving").toBe(ran);
    // Nobody holds it now, so the same copy takes it again at its next ask.
    await vi.advanceTimersByTimeAsync(100);
    expect(first.leading()).toBe(true);
    await first.stop();
  });
});

describe("driving a row is the outside poke without the socket", () => {
  it("dispatches GET on the row's route with the internal bearer, and reads the answer away", async () => {
    const seen: Request[] = [];
    const { logger, lines } = recordingLogger();
    const row = CLOCK_ROWS.find((r) => r.target === "sessions_reap")!;
    const secret = fixture("internal", "bearer");
    const driven = driveRow(row, async (req) => { seen.push(req); return Response.json({ reaped: 0 }); }, "https://mail.example.com", secret, logger);
    expect(driven).toMatchObject({ name: "sessions_reap", everyMs: row.everyMs, firstDelayMs: row.firstDelayMs, jitterMs: row.jitterMs });
    await driven.run();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe("https://mail.example.com/internal/sessions/reap");
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${secret}`);
    expect(lines).toEqual([]);
  });

  it("a refusal is one warn line with the route and the status, never the secret", async () => {
    const { logger, lines } = recordingLogger();
    const row = CLOCK_ROWS.find((r) => r.target === "unsubscribe_drain")!;
    await driveRow(row, async () => new Response(null, { status: 401 }), "https://mail.example.com", fixture("internal", "bearer"), logger).run();
    expect(lines).toEqual([{ level: "warn", event: "api_clock_pass_refused", fields: { route: "/internal/unsubscribe/drain", status: 401 } }]);
  });
});

describe("a self-hosted server's own sending chain", () => {
  /**
   * The other production runner of the two passes `packages/api/test/send-reconcile-route.test.ts`
   * drives through the route: nothing ends this process, so a dial with no bound of its own parks
   * the whole send clock behind one mailbox. The program is built and its clocks started; each
   * pass finds one mailbox to dial, and the adapter built for it is read.
   */
  it("dials for the reconciler and for the late Sent copies with the reconciler's deadlines", async () => {
    const db = await makeTestDb();
    const program = buildProgram(
      // The operator's switch: the dial door resolves no name from here.
      loadSettings(env(PLAIN_ENV, { TF_PROBE_ALLOW_PRIVATE: "1" }), PROCESS_DOOR), processInput(recordingLogger().logger),
    );
    // The program as built, on this test's database: its own pool is never dialled.
    program.runtime.db = ownedDbPort(db as unknown as Parameters<typeof ownedDbPort>[0]);
    const accountId = randomUUID();
    const old = new Date(Date.now() - 11 * 60_000);
    /** A connected mailbox with a stored sign-in at `host`. */
    const mailbox = async (host: string): Promise<string> => {
      const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `u@${host}`, status: "connected" }).returning();
      const enc = await program.runtime.cfg.keyRing.provider.encrypt(randomUUID());
      await db.insert(mailboxCredentials).values({
        mailboxId: mb!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
        meta: { host, port: 993, secure: true, user: `u@${host}` },
      });
      return mb!.id;
    };
    // A stranded send for the reconciler, and a delivered one whose Sent copy is owed.
    const [draft] = await db.insert(drafts).values({
      accountId, mailboxId: await mailbox("stranded.lan"), subject: "the stranded one", body: "words",
      to: [{ name: null, address: "you@example.com" }], status: "sending", createdAt: old, updatedAt: old,
    }).returning();
    await db.insert(outboundSends).values({
      accountId, idempotencyKey: randomUUID(), draftId: draft!.id, mintedMessageId: `<${randomUUID()}@stranded.lan>`,
      status: "pending", createdAt: old,
    });
    const minted = `<${randomUUID()}@owed.lan>`;
    const [sent] = await db.insert(outboundSends).values({
      accountId, idempotencyKey: randomUUID(), mintedMessageId: minted, providerMessageId: minted, status: "sent",
    }).returning();
    await db.insert(outboundSentCopies).values({
      sendId: sent!.id, accountId, mailboxId: await mailbox("owed.lan"), rawB64: Buffer.from("raw").toString("base64"), nextAttemptAt: old,
    });

    const built: Record<string, unknown[]> = {};
    vi.spyOn(ImapAdapter.prototype, "connect").mockImplementation(async function (this: object) {
      const { host, timeouts } = (this as unknown as { config: ImapConfig }).config;
      (built[host] ??= []).push(timeouts);
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    });
    vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);

    // Only the chain's own first delay is skipped; the passes run on the real clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const clocks = program.startClocks()!;
    vi.advanceTimersByTime(SCHEDULED_SEND_FIRST_DELAY_MS);
    vi.useRealTimers();
    await clocks.stop();      // waits for the tick in flight
    await program.close();

    expect(built, "every production caller of the pass must thread them").toEqual({
      "stranded.lan": [SEND_RECONCILE_NET_TIMEOUTS], "owed.lan": [SEND_RECONCILE_NET_TIMEOUTS],
    });
  });
});
