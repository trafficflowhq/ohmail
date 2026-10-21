import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import {
  newDeliveryStreak, runAlertPass, dbUnreadableAlert,
  type Alert, type AlertSink, type AlertDeliveryResult, type ResolutionNotice, type PostJson,
} from "../src/alerts.js";
import { resendAlertSink } from "../src/alert-mail.js";
import { MAIL_COOLDOWN_MS, MAIL_POLICY, mailCooldownMs, mailVerdictOf } from "../src/alert-mail-policy.js";
import { AlertDatabaseReadError, ALERT_DB_DEADLINE_CODE } from "../src/alert-db-fault.js";
import { makeTestDb } from "../src/testing.js";
import {
  lastResortFailed, lastResortLogLines, lastResortSucceeded, newLastResortState,
  LAST_RESORT_ENTRY_AFTER, LAST_RESORT_REPAGE_MS, type LastResortState,
} from "../src/alert-last-resort.js";
import type { Tx } from "../src/change-log.js";

/**
 * THE LAST-RESORT PAGE: a database outage silences every pass, so the driver's failure path pages
 * from process memory. Once on entry, hourly while it lasts (mail every 6 h), one resolved notice to
 * the push and webhook arms on recovery, and nothing at all for a fault that is not the database or
 * a pager with no arm.
 */

const START = new Date("2026-10-20T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number): Date => new Date(START.getTime() + ms);

/** What the database's absence looks like coming out of the pass: the preflight's tag. */
const DOWN = new AlertDatabaseReadError("preflight", Object.assign(new Error("connect"), { code: "ECONNREFUSED" }));

interface FakeArm extends AlertSink {
  pages: Alert[][];
  resolved: ResolutionNotice[][];
}

function arm(name: string, opts: { mail?: boolean; refuse?: boolean } = {}): FakeArm {
  const pages: Alert[][] = [];
  const resolved: ResolutionNotice[][] = [];
  const answer = (): AlertDeliveryResult => (opts.refuse
    ? { ok: false, outcome: "refused", error: "HTTP 503" } : { ok: true, outcome: "ok" });
  const base: FakeArm = {
    name, pages, resolved,
    notify: async (alerts) => { pages.push([...alerts]); return answer(); },
  };
  if (opts.mail) return { ...base, channel: "mail" as const };
  return { ...base, notifyResolved: async (notices) => { resolved.push([...notices]); return answer(); } };
}

function world(opts: { refuse?: boolean } = {}) {
  const webhook = arm("webhook", opts);
  const telegram = arm("telegram", opts);
  const mail = arm("mail", { mail: true, ...opts });
  const sinks = [webhook, telegram, mail];
  const streak = newDeliveryStreak();
  const state = newLastResortState();
  const ctx = (now: Date) => ({ sinks, driver: "worker" as const, environment: "test", now, deliveryStreak: streak });
  return { webhook, telegram, mail, sinks, streak, state, ctx };
}

const pagesOf = (a: FakeArm): number => a.pages.length;

describe("a cold process pages at once, then stays silent through the window", () => {
  it("one page per arm, nothing for 30 more failures inside 59 minutes", async () => {
    const w = world();
    const first = await lastResortFailed(w.state, DOWN, w.ctx(START));
    expect(first?.state).toBe("paged");
    expect(first?.alertKey).toBe("alert_db_unreadable:worker");
    expect([pagesOf(w.webhook), pagesOf(w.telegram), pagesOf(w.mail)]).toEqual([1, 1, 1]);
    expect(w.webhook.pages[0]![0]!.kind).toBe("alert_db_unreadable");
    for (let i = 1; i <= 30; i++) {
      expect(await lastResortFailed(w.state, DOWN, w.ctx(at(i * 59 * MIN / 30)))).toBeNull();
    }
    expect([pagesOf(w.webhook), pagesOf(w.telegram), pagesOf(w.mail)]).toEqual([1, 1, 1]);
  });

  it("reminds hourly to push and webhook; mail joins at 6 h", async () => {
    const w = world();
    await lastResortFailed(w.state, DOWN, w.ctx(START));
    const r1 = await lastResortFailed(w.state, DOWN, w.ctx(at(LAST_RESORT_REPAGE_MS)));
    expect(r1?.state).toBe("reminded");
    expect([pagesOf(w.webhook), pagesOf(w.telegram), pagesOf(w.mail)]).toEqual([2, 2, 1]);
    for (let h = 2; h < 6; h++) await lastResortFailed(w.state, DOWN, w.ctx(at(h * HOUR)));
    expect(pagesOf(w.mail), "mail waits its 6 h window").toBe(1);
    await lastResortFailed(w.state, DOWN, w.ctx(at(6 * HOUR)));
    expect([pagesOf(w.webhook), pagesOf(w.mail)]).toEqual([7, 2]);
    expect(mailCooldownMs("alert_db_unreadable")).toBe(MAIL_COOLDOWN_MS);
  });
});

describe("the cooldown bound holds for every kind of database failure", () => {
  const coded = (code: string): Error => Object.assign(new Error("x"), { code });
  const kinds: Array<[string, unknown]> = [
    ["read-only (25006)", coded("25006")],
    ["disk full (53100)", coded("53100")],
    ["out of memory (53200)", coded("53200")],
    ["a statement timeout (57014)", coded("57014")],
    ["an I/O error (58030)", coded("58030")],
    ["an internal error (XX000)", coded("XX000")],
    ["the evaluation's deadline", new AlertDatabaseReadError("evaluate", null, ALERT_DB_DEADLINE_CODE)],
  ];

  it.each(kinds)("%s: one page on entry, none for 30 more inside 59 minutes, hourly reminders, mail at 6 h", async (_label, fault) => {
    const w = world();
    expect((await lastResortFailed(w.state, fault, w.ctx(START)))?.state).toBe("paged");
    expect([pagesOf(w.webhook), pagesOf(w.telegram), pagesOf(w.mail)]).toEqual([1, 1, 1]);
    for (let i = 1; i <= 30; i++) {
      expect(await lastResortFailed(w.state, fault, w.ctx(at(i * 59 * MIN / 30)))).toBeNull();
    }
    expect((await lastResortFailed(w.state, fault, w.ctx(at(LAST_RESORT_REPAGE_MS))))?.state).toBe("reminded");
    expect([pagesOf(w.webhook), pagesOf(w.telegram), pagesOf(w.mail)]).toEqual([2, 2, 1]);
    for (let h = 2; h <= 6; h++) await lastResortFailed(w.state, fault, w.ctx(at(h * HOUR)));
    expect([pagesOf(w.webhook), pagesOf(w.mail)]).toEqual([7, 2]);
  });
});

describe("a read-only database, through the pass both drivers run", () => {
  it("every pass refuses at its first write; a warm process pages on the second, once; back, one resolved notice", async () => {
    const db = await makeTestDb();
    // A real channel: one with a resolved-notice arm makes the pass write on every run.
    const hook = arm("webhook");
    const streak = newDeliveryStreak();
    const state = newLastResortState();
    const ctx = (now: Date) => ({ sinks: [hook], driver: "worker" as const, environment: "test", now, deliveryStreak: streak });
    const pass = (now: Date) => runAlertPass(db as unknown as Tx, {
      now, driver: "worker", shards: [], sinks: [hook], deliveryStreak: streak, environment: "test",
    });
    const lastResortPages = (): number =>
      hook.pages.filter((p) => p.some((a) => a.key === "alert_db_unreadable:worker")).length;

    await pass(START);
    await lastResortSucceeded(state, ctx(START));
    await db.execute(sql`set default_transaction_read_only = on`);
    const states: Array<string | null> = [];
    for (let i = 1; i <= 12; i++) {
      const now = at(i * MIN);
      const err = await pass(now).then(() => null, (e: unknown) => e);
      expect((err as { code?: string } | null)?.code, `pass ${i} refuses`).toBe("25006");
      states.push((await lastResortFailed(state, err, ctx(now)))?.state ?? null);
    }
    expect(states).toEqual([null, "paged", ...Array(10).fill(null)]);
    expect(lastResortPages()).toBe(1);

    await db.execute(sql`set default_transaction_read_only = off`);
    const back = at(13 * MIN);
    await pass(back);
    expect((await lastResortSucceeded(state, ctx(back)))?.state).toBe("resolved");
    expect(hook.resolved.filter((n) => n.some((x) => x.key === "alert_db_unreadable:worker"))).toHaveLength(1);
    expect(lastResortPages()).toBe(1);
  });
});

describe("recovery", () => {
  it("one resolved notice per push or webhook arm, none on mail; a second success sends nothing", async () => {
    const w = world();
    await lastResortFailed(w.state, DOWN, w.ctx(START));
    const back = await lastResortSucceeded(w.state, w.ctx(at(10 * MIN)));
    expect(back?.state).toBe("resolved");
    expect(w.webhook.resolved).toHaveLength(1);
    expect(w.telegram.resolved).toHaveLength(1);
    expect(w.webhook.resolved[0]![0]).toMatchObject({
      key: "alert_db_unreadable:worker", kind: "alert_db_unreadable", openedAt: START.toISOString(), pages: 1,
    });
    expect(pagesOf(w.mail), "mail gets no resolved notice").toBe(1);
    expect(await lastResortSucceeded(w.state, w.ctx(at(11 * MIN)))).toBeNull();
    expect(w.webhook.resolved).toHaveLength(1);
  });

  it("a healthy pass sends nothing", async () => {
    const w = world();
    expect(await lastResortSucceeded(w.state, w.ctx(START))).toBeNull();
    expect(w.sinks.map(pagesOf)).toEqual([0, 0, 0]);
    expect(w.webhook.resolved).toHaveLength(0);
  });

  it("a relapse inside the hour sends no second page", async () => {
    const w = world();
    await lastResortFailed(w.state, DOWN, w.ctx(START));
    await lastResortSucceeded(w.state, w.ctx(at(5 * MIN)));
    for (let i = 0; i < 5; i++) await lastResortFailed(w.state, DOWN, w.ctx(at((10 + i) * MIN)));
    expect(pagesOf(w.webhook)).toBe(1);
  });
});

describe("a warm process waits for a second failure in a row", () => {
  it("pages on the second, not the first", async () => {
    const w = world();
    await lastResortSucceeded(w.state, w.ctx(START));
    expect(LAST_RESORT_ENTRY_AFTER).toBe(2);
    expect(await lastResortFailed(w.state, DOWN, w.ctx(at(MIN)))).toBeNull();
    expect(pagesOf(w.webhook)).toBe(0);
    expect((await lastResortFailed(w.state, DOWN, w.ctx(at(2 * MIN))))?.state).toBe("paged");
    expect(pagesOf(w.webhook)).toBe(1);
  });
});

describe("what never pages", () => {
  it("a failure that is not the database sends nothing and leaves the streak alone", async () => {
    const w = world();
    const bug = Object.assign(new Error("column does not exist"), { code: "42703" });
    expect(await lastResortFailed(w.state, bug, w.ctx(START))).toBeNull();
    expect(w.state.streak).toBe(0);
    expect(w.sinks.map(pagesOf)).toEqual([0, 0, 0]);
  });

  it("no usable arm: nothing, and no transport call", async () => {
    const state = newLastResortState();
    let calls = 0;
    const dead: AlertSink = { name: "webhook", unusable: true, notify: async () => { calls++; return false; } };
    for (const sinks of [[], [dead]]) {
      expect(await lastResortFailed(state, DOWN, { sinks, driver: "api", environment: "test", now: START })).toBeNull();
    }
    expect(calls).toBe(0);
    expect(state).toEqual(newLastResortState());
  });
});

describe("every arm refusing", () => {
  it("retries on each failure and escalates at the third", async () => {
    const w = world({ refuse: true });
    const reports = [];
    for (let i = 0; i < 3; i++) reports.push(await lastResortFailed(w.state, DOWN, w.ctx(at(i * MIN))));
    expect(reports.map((r) => r?.state)).toEqual(["refused", "refused", "refused"]);
    expect(pagesOf(w.webhook)).toBe(3);
    expect(reports[0]!.escalate).toBeNull();
    expect(reports[2]!.escalate?.consecutiveFailures).toBe(3);
    const events = lastResortLogLines(reports[2]!).map((l) => l.event);
    expect(events).toEqual(["alert_last_resort", "alerts_undeliverable"]);
  });
});

describe("overlapping failures", () => {
  it("a second failure while a page is in flight sends nothing", async () => {
    const state: LastResortState = newLastResortState();
    let release!: () => void;
    let calls = 0;
    const slow: AlertSink = {
      name: "webhook",
      notify: () => { calls++; return new Promise((r) => { release = () => r(true); }); },
    };
    const ctx = { sinks: [slow], driver: "worker" as const, environment: "test", now: START };
    const first = lastResortFailed(state, DOWN, ctx);
    expect(await lastResortFailed(state, DOWN, ctx)).toBeNull();
    release();
    expect((await first)?.state).toBe("paged");
    expect(calls).toBe(1);
  });
});

describe("zero database calls", () => {
  it("the paging path touches no handle: the statement count is the same before and after", async () => {
    let statements = 0;
    const refusing = new Proxy({}, {
      get: () => { statements++; return () => { throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); }; },
    }) as unknown as Tx;
    const err = await runAlertPass(refusing, { driver: "worker", shards: [], sinks: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlertDatabaseReadError);
    const before = statements;
    const w = world();
    expect((await lastResortFailed(w.state, err, w.ctx(START)))?.state).toBe("paged");
    await lastResortSucceeded(w.state, w.ctx(at(MIN)));
    expect(statements).toBe(before);
  });
});

describe("the mail arm's key holds for the page window", () => {
  function capturing(): PostJson & { calls: Array<{ body: string; key: string }> } {
    const calls: Array<{ body: string; key: string }> = [];
    const post = (async (_url: string, body: string, headers?: Record<string, string>) => {
      calls.push({ body, key: headers?.["Idempotency-Key"] ?? "" });
      return { status: 200 };
    }) as PostJson & { calls: typeof calls };
    post.calls = calls;
    return post;
  }
  const CFG = { apiKey: "re_fixture_last_resort_k", from: "ohmail <no-reply@ohmail.example>", to: "ops@ohmail.example" };
  const bucketStart = new Date(Math.floor(START.getTime() / MAIL_COOLDOWN_MS) * MAIL_COOLDOWN_MS);

  it("two pages inside one 6 h bucket are the same bytes under the same key; past the edge, a new key", async () => {
    const post = capturing();
    const a = resendAlertSink(CFG, post)!;
    await a.notify([dbUnreadableAlert("worker")], { source: "worker", environment: "test", now: new Date(bucketStart.getTime() + MIN) });
    // A later process, a later streak: nothing of either is in the alert.
    const b = resendAlertSink(CFG, post)!;
    await b.notify([dbUnreadableAlert("worker")], { source: "worker", environment: "test", now: new Date(bucketStart.getTime() + 5 * HOUR) });
    expect(post.calls[1]!.body).toBe(post.calls[0]!.body);
    expect(post.calls[1]!.key).toBe(post.calls[0]!.key);
    const c = resendAlertSink(CFG, post)!;
    await c.notify([dbUnreadableAlert("worker")], { source: "worker", environment: "test", now: new Date(bucketStart.getTime() + MAIL_COOLDOWN_MS + MIN) });
    expect(post.calls[2]!.key).not.toBe(post.calls[0]!.key);
  });

  it("the alert is fixed text: no time, count, error or address", () => {
    const one = dbUnreadableAlert("api");
    expect(one).toEqual(dbUnreadableAlert("api"));
    expect(one).toMatchObject({ severity: "critical", cls: "incident", count: 1, oldestSeconds: null, fixHref: null });
    expect(one.signature).toBe("db_unreadable|api");
    expect(`${one.title} ${one.detail}`).not.toMatch(/\d{4}-\d\d|@|ECONN|postgres:|25006|53100/);
  });

  it("says the pass cannot use the database: gone, read-only, full or too slow alike", () => {
    expect(dbUnreadableAlert("worker").title).toBe("The worker alert pass cannot use the database");
    expect(dbUnreadableAlert("api").title).toBe("The api alert pass cannot use the database");
    expect(dbUnreadableAlert("api").detail).not.toMatch(/cannot read/);
  });
});

describe("the kind is known everywhere a kind must be", () => {
  it("pages under the mail policy, on the ordinary 6 h window", () => {
    expect(MAIL_POLICY.alert_db_unreadable).toBeTypeOf("function");
    expect(mailVerdictOf(dbUnreadableAlert("worker"))).toBe("page");
  });
});
