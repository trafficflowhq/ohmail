import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { learningSignals, messageBodies, rules, unsubscribeRecords } from "@trafficflow/db";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { UNSUB_DRAIN_CEILING_MS, UNSUB_DRAIN_RUN_BUDGET_MS } from "@trafficflow/core/mail";
import type { OneClickPost } from "@trafficflow/services";
import { makeDeps, req, seedSession, seedMailbox, seedMessage } from "./helpers.js";

/**
 * A DATABASE THAT ANSWERS LATE, not one that answers differently. Every call still runs and still
 * returns what it would have; it simply takes `delayMs` first, on the same timers the test drives,
 * which is the shape a slow production database has. A double that failed instead would measure
 * the error path and say nothing about the budget.
 */
function slowDb(db: object, delayMs: number): () => number {
  let statements = 0;
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
  // On the pool's own handle, the one the binder knows: the handle the host mints for the request
  // (a view of it) asks every statement through these, and each answer comes late.
  for (const statement of [
    "select", "selectDistinct", "selectDistinctOn", "insert", "update", "delete", "execute", "transaction", "with", "$count",
  ]) {
    const own = Reflect.get(db, statement) as unknown;
    if (typeof own !== "function") continue;
    Object.defineProperty(db, statement, {
      configurable: true, writable: true,
      value: function (this: object, ...args: unknown[]) {
        statements += 1;
        const out = (own as (...a: unknown[]) => unknown).apply(this, args);
        return out !== null && typeof out === "object" ? late(out) : out;
      },
    });
  }
  return () => statements;
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

  it("a scheduler tick leaves a screened-out sender's list to the person", async () => {
    const post = spyPost();
    const { db, deps } = await makeDeps(undefined, {}, { oneClickPost: post, trustedAuthservIds: GMAIL });
    const s = await seedSession(db, { now: deps.now() });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const { id: messageId } = await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb,
      fromAddress: "news@sender.example", folder: "ohmail/Screened",
    });
    await db.insert(messageBodies).values({ messageId, accountId: s.accountId, text: "", headers: ONE_CLICK });
    // A stored rule by itself does not confirm an unsubscribe.
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
    expect(body.accounts).toBe(0);
    expect(body.claimed).toBe(0);
    expect(body.delivered).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.remaining).toBe(0);
    expect(body.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(post.calls).toEqual([]);

    const records = () => db.select().from(unsubscribeRecords)
      .where(eq(unsubscribeRecords.messageId, messageId));
    expect(await records()).toEqual([]);

    const pressed = await H(req("POST", `/messages/${messageId}/unsubscribe`, { bearer: s.token }), deps);
    expect(pressed.status).toBe(200);
    expect(await pressed.json()).toMatchObject({ posted: true, status: 200, refusal: null });
    expect((await records()).map((record) => record.state)).toEqual(["sent"]);

    // A subsequent scheduler tick cannot duplicate the request.
    expect((await H(get(SECRET), armed)).status).toBe(200);
    expect(post.calls).toHaveLength(1);
  });

  /** Drive the mounted scheduler route with a database that would answer after its budget. */
  it("a scheduler tick returns without waiting for the database or opening a statement", async () => {
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
      await db.insert(messageBodies).values({ messageId, accountId: s.accountId, text: "", headers: ONE_CLICK });
      // A stored rule still gives the old scheduler something it would have tried to find.
      await db.insert(rules).values({ accountId: s.accountId, kind: "sender", match: "news@sender.example",
        destination: "ohmail/Screened", provenance: "promoted", personDecidedAt: deps.now() });
      await db.insert(learningSignals).values({ accountId: s.accountId, triggeringActionId: `screener:${crypto.randomUUID()}`,
        kind: "screener", senderAddress: "news@sender.example", destination: "ohmail/Screened", label: "positive" });

      const armed = {
        ...deps,
        alerts: { secret: SECRET, cronSecret: CRON, sinks: [] },
      } as unknown as ApiDeps;
      const databaseStatements = slowDb(db, 100_000);

      const pending = H(get(SECRET), armed);
      // ASYNC advance: the synchronous form settles nothing between timers, so the awaits inside
      // the route never run and the guard cannot fire.
      await vi.advanceTimersByTimeAsync(120_000);
      const res = await pending;

      expect(res.status).toBe(200);
      const body = await res.json() as { delivered: number; remaining: number; elapsedMs: number };
      // Inside the bound, by the run's own reading of the clock it was given.
      expect(body.elapsedMs).toBeLessThanOrEqual(UNSUB_DRAIN_RUN_BUDGET_MS + 1_000);
      expect(body.elapsedMs).toBeLessThan(UNSUB_DRAIN_CEILING_MS);
      expect(body.delivered).toBe(0);
      expect(body.remaining).toBe(0);
      expect(databaseStatements()).toBe(0);
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
      await db.insert(messageBodies).values({ messageId, accountId: s.accountId, text: "", headers: ONE_CLICK });
      // A stored rule still gives the old scheduler something it would have tried to find.
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
