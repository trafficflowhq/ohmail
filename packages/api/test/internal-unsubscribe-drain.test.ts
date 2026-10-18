import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { learningSignals, messageBodies, rules, unsubscribeRecords } from "@trafficflow/db";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { UNSUB_DRAIN_CEILING_MS, UNSUB_DRAIN_RUN_BUDGET_MS } from "@trafficflow/core/mail";
import type { OneClickPost } from "@trafficflow/services";
import { makeDeps, seedSession, seedMailbox, seedMessage } from "./helpers.js";

/**
 * A DATABASE THAT ANSWERS LATE, not one that answers differently. Every call still runs and still
 * returns what it would have; it simply takes `delayMs` first, on the same timers the test drives,
 * which is the shape a slow production database has. A double that failed instead would measure
 * the error path and say nothing about the budget.
 */
function slowDb<T extends object>(db: T, delayMs: number): T {
  const late = (b: object): object => new Proxy(b, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv) as unknown;
      if (prop === "then" && typeof v === "function") {
        return (onOk: unknown, onErr: unknown) =>
          (async () => {
            await new Promise((r) => { setTimeout(r, delayMs); });
            return await (target as PromiseLike<unknown>);
          })().then(onOk as never, onErr as never);
      }
      if (typeof v === "function") {
        return (...args: unknown[]) => {
          const out = (v as (...a: unknown[]) => unknown).apply(target, args);
          return out !== null && typeof out === "object" ? late(out) : out;
        };
      }
      return v;
    },
  });
  return late(db) as T;
}

/**
 * `GET /internal/unsubscribe/drain` — the production caller `sweepScreenedOut` never had.
 *
 * The defect report states the dependency in one line: a cap on the Screener's in-request
 * fan-out without a drain behind it converts an over-long request into silently unfinished work.
 * This is the drain's surface, pinned exactly as the session reaper's is — 404 unconfigured, 401
 * on a wrong bearer, the pass on either accepted secret — plus the one thing that is specific to
 * it: the HANDLER CHOOSES NO BOUNDS. Every ceiling lives in the service, so there is one place a
 * reader has to look and one place a number can move.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null });

const SECRET = "s".repeat(32);
const CRON = "c".repeat(32);
/**
 * The position a Gmail-held mailbox trusts (`providerAuthservIds`), and that provider confirming the
 * sender on the letter: the drain asks a list only for a confirmed sender, and each case below is
 * about something else (the run, its budget, its address check).
 */
const GMAIL: ReadonlySet<string> = new Set(["mx.google.com"]);
const ONE_CLICK = {
  "list-unsubscribe": ["<https://sender.example/u?t=abc>"],
  "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
  "authentication-results": ["mx.google.com; dmarc=pass"],
};

function get(secret?: string): Request {
  return new Request("http://api.test/internal/unsubscribe/drain", {
    method: "GET",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

function spyPost(): OneClickPost & { calls: string[] } {
  const calls: string[] = [];
  return { calls, async post(url: string) { calls.push(url); return { status: 200 }; } };
}

describe("GET /internal/unsubscribe/drain — the surface", () => {
  it("404s on a host with no alerts secret: no secret ⇒ no endpoint, and NO drain", async () => {
    const { deps } = await makeDeps();
    expect((await H(get(SECRET), deps)).status).toBe(404);
  });

  it("401s with no bearer or a wrong one; runs on BOTH the operator secret and the cron's", async () => {
    const { deps } = await makeDeps();
    const armed = { ...deps, alerts: { secret: SECRET, cronSecret: CRON, sinks: [] } };
    expect((await H(get(), armed)).status).toBe(401);
    expect((await H(get("wrong"), armed)).status).toBe(401);
    expect((await H(get(SECRET), armed)).status).toBe(200);
    expect((await H(get(CRON), armed)).status).toBe(200);
  });

  it("a deployment with no unsubscribe port says so — a state, not a fault", async () => {
    const { deps } = await makeDeps();
    const armed = {
      ...deps,
      alerts: { secret: SECRET, cronSecret: CRON, sinks: [] },
      services: { ...deps.services, unsubscribe: undefined },
    } as unknown as ApiDeps;
    const res = await H(get(SECRET), armed);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code)
      .toBe("unsubscribe_unconfigured");
  });

  it("leaves the list a screened-out sender published, and says what it did", async () => {
    const post = spyPost();
    const { db, deps } = await makeDeps(undefined, {}, { oneClickPost: post, trustedAuthservIds: GMAIL });
    const s = await seedSession(db, { now: deps.now() });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const { id: messageId } = await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb,
      fromAddress: "news@sender.example", folder: "ohmail/Screened",
    });
    await db.insert(messageBodies).values({ messageId, text: "", headers: ONE_CLICK });
    // A person screened the sender out — the only licence the pass acts on (UD-R4-03).
    await db.insert(rules).values({ accountId: s.accountId, kind: "sender", match: "news@sender.example",
      destination: "ohmail/Screened", provenance: "promoted", personDecidedAt: deps.now() });
    await db.insert(learningSignals).values({ accountId: s.accountId, triggeringActionId: `screener:${crypto.randomUUID()}`,
      kind: "screener", senderAddress: "news@sender.example", destination: "ohmail/Screened", label: "positive" });

    const armed = { ...deps, alerts: { secret: SECRET, cronSecret: CRON, sinks: [] } };
    const res = await H(get(SECRET), armed);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      accounts: number; claimed: number; delivered: number; failed: number;
      remaining: number; elapsedMs: number;
    };
    expect(body.accounts).toBe(1);
    expect(body.claimed).toBe(1);
    expect(body.delivered).toBe(1);
    expect(body.failed).toBe(0);
    // The run answers what is LEFT, counted after it settled — nothing here — and how long it
    // took. A pass that answers only an outcome cannot tell "delivered one and was killed" from
    // "did nothing", which is the state this route shipped in: two production runs, both recorded
    // `timeout`, one unsubscribe actually delivered.
    expect(body.remaining).toBe(0);
    expect(body.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(post.calls).toHaveLength(1);

    const records = await db.select().from(unsubscribeRecords)
      .where(eq(unsubscribeRecords.messageId, messageId));
    expect(records).toHaveLength(1);
    expect(records[0]!.state).toBe("sent");

    // A second poke is not a second request to a stranger: the record row is the claim.
    expect((await H(get(SECRET), armed)).status).toBe(200);
    expect(post.calls).toHaveLength(1);
  });

  /**
   * UD-R4-08: the budget assertions here used to read the route's SOURCE TEXT, which measures
   * nothing — a needle that is source stays green while the pipeline underneath it changes. This
   * drives the REAL router with a database that never answers inside the run's budget, under a
   * fake clock so the wait costs the suite nothing.
   *
   * What it establishes is the whole of UD-R4-01: a wait that derives no deadline from the budget
   * is a wait that spends the invocation, and before this every database call and the address
   * check did exactly that. The route returns, inside its own bound, having sent nothing — which
   * is the difference between a pass that reports and one the platform kills.
   *
   * Watched red by handing the chunk read a fixed ten minutes instead of what is left: elapsed
   * time far past its bound. The DNS case below is watched red by dropping the
   * resolver's wrapper, and it RACES THE CEILING rather than asserting on elapsed time, because
   * an unbounded resolver means the route never answers at all — a case that reddens by test
   * timeout has proved the suite was slow, not which bound was missing.
   */
  it("a database that never answers costs the route its budget and no more — it still returns", async () => {
    vi.useFakeTimers();
    try {
      const post = spyPost();
      const { db, deps } = await makeDeps(undefined, {}, { oneClickPost: post, trustedAuthservIds: GMAIL });
      const s = await seedSession(db, { now: deps.now() });
      const mb = await seedMailbox(db, { accountId: s.accountId });
      const { id: messageId } = await seedMessage(db, {
        accountId: s.accountId, mailboxId: mb,
        fromAddress: "news@sender.example", folder: "ohmail/Screened",
      });
      await db.insert(messageBodies).values({ messageId, text: "", headers: ONE_CLICK });
      // A person screened the sender out — the only licence the pass acts on (UD-R4-03).
      await db.insert(rules).values({ accountId: s.accountId, kind: "sender", match: "news@sender.example",
        destination: "ohmail/Screened", provenance: "promoted", personDecidedAt: deps.now() });
      await db.insert(learningSignals).values({ accountId: s.accountId, triggeringActionId: `screener:${crypto.randomUUID()}`,
        kind: "screener", senderAddress: "news@sender.example", destination: "ohmail/Screened", label: "positive" });

      const armed = {
        ...deps,
        alerts: { secret: SECRET, cronSecret: CRON, sinks: [] },
        // FOUR TIMES the run's whole budget. A route whose reads take their own clock waits all
        // of it; one that derives a deadline from what is left stops at the budget.
        db: slowDb(db, 100_000),
      } as unknown as ApiDeps;

      const pending = H(get(SECRET), armed);
      // ASYNC advance: the synchronous form settles nothing between timers, so the awaits inside
      // the route never run and the guard cannot fire.
      await vi.advanceTimersByTimeAsync(120_000);
      const res = await pending;

      expect(res.status).toBe(200);
      const body = await res.json() as { delivered: number; remaining: number | null; elapsedMs: number };
      // Inside the bound, by the run's own reading of the clock it was given.
      expect(body.elapsedMs).toBeLessThanOrEqual(UNSUB_DRAIN_RUN_BUDGET_MS + 1_000);
      expect(body.elapsedMs).toBeLessThan(UNSUB_DRAIN_CEILING_MS);
      expect(body.delivered).toBe(0);
      // It did not reach the end of the window, so it says so rather than answering zero.
      expect(body.remaining).toBeNull();
      expect(post.calls, "nothing may leave on a run that could not read its own candidates").toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The same rule one segment further in: the address check between the claim and the POST. Its
   * DNS used to wait on the resolver's own clock, so a sender whose name never resolved held the
   * invocation past the ceiling.
   */
  it("an address check that never resolves costs its slice, and the run still answers", async () => {
    vi.useFakeTimers();
    try {
      const post = spyPost();
      const { db, deps } = await makeDeps(undefined, {}, {
        oneClickPost: post, trustedAuthservIds: GMAIL,
        resolver: { resolve: () => new Promise<string[]>(() => { /* never */ }) },
      });
      const s = await seedSession(db, { now: deps.now() });
      const mb = await seedMailbox(db, { accountId: s.accountId });
      const { id: messageId } = await seedMessage(db, {
        accountId: s.accountId, mailboxId: mb,
        fromAddress: "news@sender.example", folder: "ohmail/Screened",
      });
      await db.insert(messageBodies).values({ messageId, text: "", headers: ONE_CLICK });
      // A person screened the sender out — the only licence the pass acts on (UD-R4-03).
      await db.insert(rules).values({ accountId: s.accountId, kind: "sender", match: "news@sender.example",
        destination: "ohmail/Screened", provenance: "promoted", personDecidedAt: deps.now() });
      await db.insert(learningSignals).values({ accountId: s.accountId, triggeringActionId: `screener:${crypto.randomUUID()}`,
        kind: "screener", senderAddress: "news@sender.example", destination: "ohmail/Screened", label: "positive" });

      const armed = { ...deps, alerts: { secret: SECRET, cronSecret: CRON, sinks: [] } };
      // RACED AGAINST THE CEILING ITSELF, so the failure names the property rather than the
      // runner's clock: a route whose DNS waits on the resolver's own clock never answers at all,
      // and a case that reddens by test timeout has proved the suite was slow, not which bound
      // was missing.
      const pending = H(get(SECRET), armed).then(() => "answered" as const);
      const ceiling = new Promise<"never answered">((r) => {
        setTimeout(() => { r("never answered"); }, UNSUB_DRAIN_CEILING_MS);
      });
      const race = Promise.race([pending, ceiling]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await race, "the run must answer before the invocation ceiling").toBe("answered");
      expect(post.calls, "a POST may not be made on an address the gate never cleared").toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
