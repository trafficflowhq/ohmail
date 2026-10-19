import { describe, it, expect } from "vitest";
import { eq, like } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { accounts, drafts, mailboxes, outboundSends } from "@trafficflow/db";
import { alertState } from "../src/cloud.js";
import { recordApiFault } from "../src/api-faults.js";
import {
  listOpenAlerts, newDeliveryStreak, runAlertPass,
  type Alert, type AlertNotifyContext, type AlertSink, type PostJson,
} from "../src/alerts.js";
import { resendAlertSink } from "../src/alert-mail.js";
import { telegramAlertSink } from "../src/alert-push.js";
import {
  renderDigestInput, mailVerdictOf, mailCooldownMs, MAIL_COOLDOWN_MS, MAIL_POLICY, type AlertDigest,
} from "../src/alert-mail-policy.js";

/**
 * THE OPERATOR'S MAIL CARRIES WHAT MATTERS (2026-10-05). A PAGE kind mails at most once per
 * window unless its severity rises; a DIGEST kind waits for the daily summary; nothing mails
 * when an alert clears. Every case drives `runAlertPass`, and a pager with no `channel` still
 * gets every incident.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;

// After the wall clock, so a row the database stamps by default is never newer than a pass.
const NOW = new Date("2026-12-01T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number): Date => new Date(NOW.getTime() + ms);

async function seedAccount(db: Db): Promise<{ accountId: string; mailboxId: string }> {
  const [acct] = await db.insert(accounts).values({ name: "MailPolicy" }).returning();
  const [mb] = await db.insert(mailboxes).values({
    accountId: acct!.id, provider: "imap", status: "connected", lastSyncAt: at(30 * 24 * HOUR),
    createdAt: new Date(NOW.getTime() - 10 * 24 * HOUR),
    address: `policy-${Math.random().toString(36).slice(2, 8)}@example.test`,
  }).returning();
  return { accountId: acct!.id, mailboxId: mb!.id };
}

/** `n` more pending sends created an hour before NOW: `sends_stuck`, critical, count += n. */
async function stuck(db: Db, seed: { accountId: string; mailboxId: string }, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const tag = Math.random().toString(36).slice(2);
    const [draft] = await db.insert(drafts).values({ accountId: seed.accountId, mailboxId: seed.mailboxId }).returning();
    await db.insert(outboundSends).values({
      accountId: seed.accountId, idempotencyKey: `idem-${tag}`, draftId: draft!.id,
      mintedMessageId: `<${tag}@app.ohmail.app>`, status: "pending", createdAt: new Date(NOW.getTime() - HOUR),
    });
  }
}

/** A mail sink: what it was handed, page by page, and the digests. */
function mailSpy(): AlertSink & { pages: string[][]; digests: AlertDigest[] } {
  const pages: string[][] = [];
  const digests: AlertDigest[] = [];
  return {
    name: "mail", channel: "mail", pages, digests,
    async notify(alerts: readonly Alert[]) { pages.push(alerts.map((a) => a.key)); return true; },
    async notifyDigest(d: AlertDigest) { digests.push(d); return true; },
  };
}

/** A pager: no channel, so it gets every incident. */
function pushSpy(): AlertSink & { pages: string[][] } {
  const pages: string[][] = [];
  return {
    name: "push", pages,
    async notify(alerts: readonly Alert[]) { pages.push(alerts.map((a) => a.key)); return true; },
  };
}

/** A digest row as if the day's summary had gone `ago` before NOW, so no digest is due yet. */
async function digestSentAgo(db: Db, ago: number): Promise<void> {
  await db.insert(alertState).values({
    alertKey: "mail:digest", kind: "mail_policy", severity: "warning", cls: "signal",
    resolvedAt: new Date(0), notifiedAt: new Date(NOW.getTime() - ago), notifyCount: 0,
  });
}

describe("1 — a PAGE kind mails once per window, again on a severity rise or once the window ends", () => {
  it("pages at 0, holds a doubling at +1 h, pages a rise at +1 h 30 and the next due 6 h 01 after it", async () => {
    const db = await makeTestDb();
    const seed = await seedAccount(db);
    await digestSentAgo(db, HOUR);
    const mail = mailSpy();
    const push = pushSpy();
    const pass = (ms: number) => runAlertPass(db, { now: at(ms), sinks: [mail, push], shards: [] });
    const mailed = (): number => mail.pages.filter((p) => p.includes("sends_stuck")).length;
    const pushed = (): number => push.pages.filter((p) => p.includes("sends_stuck")).length;

    await stuck(db, seed, 1);
    await pass(0);
    expect([mailed(), pushed()], "the first page reaches both").toEqual([1, 1]);

    await stuck(db, seed, 1);
    const held = await pass(HOUR);
    expect([mailed(), pushed()], "a doubling inside the window: the pager is told, the mail is held")
      .toEqual([1, 2]);
    expect(held.mailHeld.map((h) => h.alertKey)).toEqual(["sends_stuck"]);
    expect(held.mailHeld[0]!.retryAt).toBe(at(6 * HOUR).toISOString());

    // The window's mail said WARNING (as a window opened by a warning page records it); today every
    // PAGE rule emits critical, so a rise is reached through the stored peak.
    await db.update(alertState).set({ notifiedSignature: "peak|1" }).where(eq(alertState.alertKey, "mail:sends_stuck"));
    await stuck(db, seed, 2);
    await pass(HOUR + 30 * MIN);
    expect(mailed(), "a severity above the window's peak mails at once").toBe(2);

    await stuck(db, seed, 4);
    await pass(HOUR + 30 * MIN + 6 * HOUR - MIN);
    expect(mailed(), "a doubling a minute before the window ends is held").toBe(2);
    await stuck(db, seed, 8);
    await pass(HOUR + 30 * MIN + 6 * HOUR + MIN);
    expect(mailed(), "6 h 01 after the last mail, the next due mails").toBe(3);
  });
});

describe("2 — a DIGEST kind never reaches the mail sink on a page", () => {
  const route = "/img";
  const faults = (db: Db, when: Date, n: number) => Promise.all(Array.from({ length: n }, () =>
    recordApiFault(db, {
      at: when, route, method: "GET", status: 500, errorClass: "Boom", requestId: null, arm: "api",
    })));

  it("the pager gets it at once, the mail sink never, and the next digest lists it once", async () => {
    const db = await makeTestDb();
    await digestSentAgo(db, 23 * HOUR);
    const mail = mailSpy();
    const push = pushSpy();
    const key = `api_fault_rate:api:${route}`;
    await faults(db, at(-MIN), 12);
    const first = await runAlertPass(db, { now: NOW, sinks: [mail, push], shards: [] });
    expect(first.firing.map((a) => a.key)).toContain(key);
    expect(push.pages, "a sink with no channel is a pager: it gets the incident at once").toEqual([[key]]);
    expect(mail.pages, "a route outside the page prefixes is not a page").toEqual([]);
    expect(mail.digests, "the day's digest already went").toEqual([]);

    await runAlertPass(db, { now: at(HOUR + MIN), sinks: [mail, push], shards: [] });
    expect(mail.digests).toHaveLength(1);
    expect(mail.digests[0]!.lines.filter((l) => l.key === key)).toHaveLength(1);
    await runAlertPass(db, { now: at(2 * HOUR), sinks: [mail, push], shards: [] });
    expect(mail.digests, "one digest a day").toHaveLength(1);
  });
});

describe("3 — the 09-28 entitlements timeline mails once", () => {
  const T = new Date("2026-09-28T15:30:00.000Z");
  const atT = (m: number): Date => new Date(T.getTime() + m * MIN);
  const ROUTE = "entitlements:/v1/access";
  const apiFaults = (db: Db, m: number, n: number) => Promise.all(Array.from({ length: n }, () =>
    recordApiFault(db, {
      at: atT(m), route: ROUTE, method: "POST", status: 504, errorClass: "EntitlementsCallTimeout",
      requestId: null, arm: "api",
    })));
  const workerMinute = (db: Db, m: number) => recordApiFault(db, {
    at: atT(m), route: ROUTE, method: "POST", status: 504, errorClass: "EntitlementsCallTimeout",
    requestId: null, arm: "worker",
  });

  it("open, a doubling, a resolve, a re-open past the floor, two doublings and the worker's key: ONE mail", async () => {
    const db = await makeTestDb();
    await db.insert(alertState).values({
      alertKey: "mail:digest", kind: "mail_policy", severity: "warning", cls: "signal",
      resolvedAt: new Date(0), notifiedAt: new Date(T.getTime() - HOUR), notifyCount: 0,
    });
    const subjects: string[] = [];
    const post: PostJson = async (_url, body) => {
      subjects.push((JSON.parse(body) as { subject: string }).subject);
      return { status: 200 };
    };
    const sink = resendAlertSink({ apiKey: "re-test-replaykeyajcix-fixture-token", from: "a@ohmail.example", to: "o@ohmail.example" }, post)!;
    const writes: Record<number, () => Promise<unknown>> = {
      [-1]: () => apiFaults(db, -1, 13),
      9: () => apiFaults(db, 9, 25),
      89: () => apiFaults(db, 89, 13),
      99: () => apiFaults(db, 99, 30),
      103: () => workerMinute(db, 103), 104: () => workerMinute(db, 104), 105: () => workerMinute(db, 105),
      109: () => apiFaults(db, 109, 70),
    };
    const paged = new Set<string>();
    for (let m = -1; m <= 200; m += 1) {
      await writes[m]?.();
      if (m >= 0 && m % 2 === 0) {
        const r = await runAlertPass(db, {
          now: atT(m), sinks: [sink], shards: [], driver: (m / 2) % 2 === 0 ? "worker" : "api",
        });
        for (const h of r.mailHeld ?? []) paged.add(h.alertKey);
      }
    }
    expect(subjects, "one page, no resolve mail").toEqual(["[production] ohmail: 1 alert firing"]);
    expect([...paged].sort(), "both keys were claimed and held, not lost")
      .toEqual([`api_fault_rate:api:${ROUTE}`, `api_fault_rate:worker:${ROUTE}`]);
  });
});

describe("4 — the policy rows are invisible to every reader of alerts", () => {
  it("not open, never closed, never told", async () => {
    const db = await makeTestDb();
    const seed = await seedAccount(db);
    await stuck(db, seed, 1);
    const told: string[] = [];
    const teller: AlertSink = {
      name: "push", async notify() { return true; },
      async notifyResolved(notices) { told.push(...notices.map((n) => n.key)); return true; },
    };
    const mail = mailSpy();
    await runAlertPass(db, { now: NOW, sinks: [mail, teller], shards: [] });
    const rows = await db.select({ k: alertState.alertKey }).from(alertState).where(like(alertState.alertKey, "mail:%"));
    expect(rows.map((r) => r.k).sort(), "the control: the rows exist").toEqual(["mail:digest", "mail:sends_stuck"]);

    expect((await listOpenAlerts(db)).map((a) => a.alertKey).filter((k) => k.startsWith("mail:"))).toEqual([]);
    const later = await runAlertPass(db, { now: at(31 * MIN), sinks: [mail, teller], shards: [] });
    expect(later.closedUnconfirmed.filter((k) => k.startsWith("mail:"))).toEqual([]);
    expect(later.resolved.filter((k) => k.startsWith("mail:"))).toEqual([]);
    await runAlertPass(db, { now: at(3 * HOUR), sinks: [mail, teller], shards: [] });
    expect(told.filter((k) => k.startsWith("mail:"))).toEqual([]);
  });
});

describe("5 — a cleared alert mails nobody; the push arm is still told", () => {
  it("the worker's mail arm and Telegram together: one page mail, one Telegram resolution", async () => {
    const db = await makeTestDb();
    const seed = await seedAccount(db);
    await digestSentAgo(db, HOUR);
    await stuck(db, seed, 1);
    const mailBodies: string[] = [];
    const chat: string[] = [];
    const mail = resendAlertSink({ apiKey: "re-test-resolvedkeyaaab-fixture-token", from: "a@ohmail.example", to: "o@ohmail.example" },
      async (_u, b) => { mailBodies.push(b); return { status: 200 }; })!;
    const telegram = telegramAlertSink({ botToken: "8123456789:AAF-fakefakefakefakefakefakefake0123", chatId: "-100123" },
      async (_u: string, b: string) => { chat.push(b); return { status: 200 }; })!;
    const pass = (ms: number) => runAlertPass(db, { now: at(ms), sinks: [mail, telegram], shards: [] });
    await pass(0);
    await db.update(outboundSends).set({ status: "sent" });
    await pass(5 * MIN);
    const told = await pass(5 * MIN + HOUR + MIN);
    await pass(3 * HOUR);
    expect(told.resolutionsTold).toEqual(["sends_stuck"]);
    expect(mailBodies.map((b) => (JSON.parse(b) as { subject: string }).subject))
      .toEqual(["[production] ohmail: 1 alert firing"]);
    expect(chat.filter((b) => b.includes("resolved: sends_stuck")), "Telegram is told once").toHaveLength(1);
  });
});

describe("6 — a lone schema_behind keeps one mail key for the page window", () => {
  const BEHIND: Alert[] = [{
    key: "schema_behind:worker", kind: "schema_behind", severity: "critical",
    title: "The worker host is ahead of the database schema", detail: "Run the cloud migrations.",
    count: 1, oldestSeconds: null, cls: "incident",
  }];

  it("twice inside 6 h — across a clock bucket's edge too — is two POSTs under ONE key", async () => {
    const keys: string[] = [];
    const sink = resendAlertSink({ apiKey: "re-test-behindkeyaaaab-fixture-token", from: "a@ohmail.example", to: "o@ohmail.example" },
      async (_u, _b, h) => { keys.push(h?.["Idempotency-Key"] ?? ""); return { status: 200 }; })!;
    const edge = new Date("2026-12-01T05:59:00.000Z");
    const ctx = (d: Date): AlertNotifyContext => ({ source: "worker", environment: "production", now: d });
    await sink.notify(BEHIND, ctx(edge));
    await sink.notify(BEHIND, ctx(new Date(edge.getTime() + 31 * MIN)));
    await sink.notify(BEHIND, ctx(new Date(edge.getTime() + 5 * HOUR)));
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size, "the provider replays the first mail").toBe(1);
  });

  it("control: an ordinary page ten minutes later is another key", async () => {
    const keys: string[] = [];
    const sink = resendAlertSink({ apiKey: "re-test-behindkeyaaaab-fixture-token", from: "a@ohmail.example", to: "o@ohmail.example" },
      async (_u, _b, h) => { keys.push(h?.["Idempotency-Key"] ?? ""); return { status: 200 }; })!;
    const page: Alert[] = [{ ...BEHIND[0]!, key: "worker_down:0", kind: "worker_down", title: "No worker" }];
    await sink.notify(page, { source: "worker", environment: "production", now: NOW });
    await sink.notify(page, { source: "worker", environment: "production", now: at(10 * MIN) });
    expect(new Set(keys).size).toBe(2);
  });
});

describe("7 — a held mail that no sink was asked about is released, never confirmed", () => {
  const notified = async (db: Db): Promise<{ n: number; at: string | null }> => {
    const [row] = await db.select({ n: alertState.notifyCount, t: alertState.notifiedAt }).from(alertState)
      .where(eq(alertState.alertKey, "sends_stuck"));
    return { n: Number(row!.n), at: row!.t ? new Date(row!.t as unknown as string).toISOString() : null };
  };

  it("a mail-only driver: the doubling is held unstamped and mailed when the window opens, not at +26 h", async () => {
    const db = await makeTestDb();
    const seed = await seedAccount(db);
    await digestSentAgo(db, HOUR);
    await stuck(db, seed, 1);
    const mail = mailSpy();
    const mailedAt: number[] = [];
    const pass = async (ms: number) => {
      const before = mail.pages.length;
      const r = await runAlertPass(db, { now: at(ms), sinks: [mail], shards: [] });
      if (mail.pages.slice(before).some((p) => p.includes("sends_stuck"))) mailedAt.push(ms);
      return r;
    };
    await pass(0);
    await stuck(db, seed, 1);
    const held = await pass(HOUR);
    expect(held.mailHeld.map((h) => h.alertKey), "the doubling is held").toEqual(["sends_stuck"]);
    expect(held.notified, "and handed to no sink").toEqual([]);
    expect(await notified(db), "nothing was sent, so nothing is recorded as told")
      .toEqual({ n: 1, at: NOW.toISOString() });
    const later = await pass(3 * HOUR);
    expect(later.mailHeld.map((h) => h.alertKey), "still due, so held again").toEqual(["sends_stuck"]);
    await pass(6 * HOUR - MIN);
    await pass(6 * HOUR);
    expect(mailedAt, "mailed at 0 h and when the window opens").toEqual([0, 6 * HOUR]);
    expect((await notified(db)).n).toBe(2);
  });

  it("a mail-only host passing first does not take the incident from the other driver's Telegram", async () => {
    const db = await makeTestDb();
    const seed = await seedAccount(db);
    await digestSentAgo(db, HOUR);
    const apiMail = mailSpy();
    const workerMail = mailSpy();
    const telegram = pushSpy();
    const tick = async (ms: number) => {
      await runAlertPass(db, { now: at(ms), sinks: [apiMail], shards: [], driver: "api" });
      await runAlertPass(db, { now: at(ms + 1000), sinks: [workerMail, telegram], shards: [], driver: "worker" });
    };
    const got = (s: { pages: string[][] }): number => s.pages.filter((p) => p.includes("sends_stuck")).length;
    await stuck(db, seed, 1);
    await tick(0);
    await stuck(db, seed, 1);
    await tick(HOUR);
    expect([got(apiMail), got(workerMail)], "one mail between the two drivers").toEqual([1, 0]);
    expect(got(telegram), "the worker's Telegram receives the held doubling").toBe(1);
    expect((await notified(db)).at, "confirmed by Telegram's accept").toBe(at(HOUR + 1000).toISOString());
  });
});

describe("8 — the daily digest", () => {
  it("an empty window posts nothing", async () => {
    const db = await makeTestDb();
    const mail = mailSpy();
    await runAlertPass(db, { now: NOW, sinks: [mail], shards: [] });
    expect(mail.digests).toEqual([]);
    const [row] = await db.select().from(alertState).where(eq(alertState.alertKey, "mail:digest"));
    expect(row?.notifiedAt ?? null, "and the clock has not started").toBeNull();
  });

  it("one incident is one digest, and a second pass the same day sends none", async () => {
    const db = await makeTestDb();
    const seed = await seedAccount(db);
    await stuck(db, seed, 1);
    const mail = mailSpy();
    await runAlertPass(db, { now: NOW, sinks: [mail], shards: [] });
    expect(mail.digests).toHaveLength(1);
    expect(mail.digests[0]!.lines.map((l) => l.key)).toEqual(["sends_stuck"]);
    await runAlertPass(db, { now: at(6 * HOUR), sinks: [mail], shards: [] });
    expect(mail.digests).toHaveLength(1);
  });

  it("forty incidents print thirty lines and the rest as a count", async () => {
    const db = await makeTestDb();
    await db.insert(alertState).values(Array.from({ length: 40 }, (_, i) => ({
      alertKey: `api_fault_rate:api:/r${String(i).padStart(2, "0")}`, kind: "api_fault_rate",
      severity: "critical", cls: "incident" as const, title: `route ${i}`,
      openedAt: new Date(NOW.getTime() - 2 * HOUR), lastSeenAt: new Date(NOW.getTime() - HOUR),
      resolvedAt: new Date(NOW.getTime() - HOUR), notifyCount: 0,
    })));
    const mail = mailSpy();
    await runAlertPass(db, { now: NOW, sinks: [mail], shards: [] });
    expect(mail.digests).toHaveLength(1);
    expect(mail.digests[0]!.lines).toHaveLength(30);
    expect(mail.digests[0]!.more).toBe(10);
  });

  it("a digest line carries no detail — only what a resolve mail already printed", () => {
    const d = renderDigestInput([{
      key: "k", kind: "sends_stuck", severity: "critical", title: "t",
      openedAt: NOW, resolvedAt: null, detail: "must not travel",
    } as never], NOW);
    expect(Object.keys(d.lines[0]!).sort()).toEqual(["key", "kind", "openedAt", "resolvedAt", "severity", "title"]);
  });
});

/** A mail sink that records WHEN (the pass's minute) it was handed each page. */
function clockedMail(ok = true): AlertSink & { pages: Array<{ at: number; keys: string[] }>; clock: { t: number } } {
  const pages: Array<{ at: number; keys: string[] }> = [];
  const clock = { t: 0 };
  return {
    name: "mail", channel: "mail", pages, clock,
    async notify(alerts: readonly Alert[]) { pages.push({ at: clock.t, keys: alerts.map((a) => a.key) }); return ok; },
    async notifyDigest() { return true; },
  };
}

async function lagging(db: Db, name: string, lastSync: Date): Promise<void> {
  const [acct] = await db.insert(accounts).values({ name }).returning();
  await db.insert(mailboxes).values({
    accountId: acct!.id, provider: "imap", status: "connected", lastSyncAt: lastSync,
    createdAt: new Date(NOW.getTime() - 30 * 24 * HOUR),
    address: `${name}-${Math.random().toString(36).slice(2, 8)}@example.test`,
  });
}

/**
 * The page line of `sync_lag:critical` is a LEVEL (review 026, H1): reached by a third account
 * in its own pass, it is a worsening and pages at once. Before it was, the digest-verdict passes
 * had confirmed the key and the third account waited for the next reminder.
 */
describe("H1 — sync_lag:critical pages when a third account joins in its own pass", () => {
  const firstMail = (m: { pages: Array<{ at: number; keys: string[] }> }) =>
    m.pages.find((p) => p.keys.includes("sync_lag:critical"))?.at ?? Infinity;

  it("one account 17 h behind, then two more: mails on the pass the third arrives", async () => {
    const db = await makeTestDb();
    await digestSentAgo(db, HOUR);
    const mail = clockedMail();
    await lagging(db, "A", new Date(NOW.getTime() - 17 * HOUR));
    for (let t = 0; t <= 4 * HOUR; t += 10 * MIN) {
      if (t === 2 * HOUR + 10 * MIN) await lagging(db, "B", new Date(at(t).getTime() - 2 * HOUR - MIN));
      if (t === 2 * HOUR + 20 * MIN) await lagging(db, "C", new Date(at(t).getTime() - 2 * HOUR - MIN));
      mail.clock.t = t;
      await runAlertPass(db, { now: at(t), sinks: [mail], shards: [] });
    }
    expect(firstMail(mail), "no mail while one or two accounts lag").toBeGreaterThanOrEqual(2 * HOUR + 20 * MIN);
    expect(firstMail(mail), "the third account's pass mails").toBe(2 * HOUR + 20 * MIN);
  });

  it("one account five days behind (no age bucket left), then two more", async () => {
    const db = await makeTestDb();
    await digestSentAgo(db, HOUR);
    const mail = clockedMail();
    await lagging(db, "A", new Date(NOW.getTime() - 5 * 24 * HOUR));
    for (let t = 0; t <= 5 * HOUR; t += 10 * MIN) {
      if (t === 3 * HOUR) await lagging(db, "B", new Date(at(t).getTime() - 2 * HOUR - MIN));
      if (t === 3 * HOUR + 10 * MIN) await lagging(db, "C", new Date(at(t).getTime() - 2 * HOUR - MIN));
      mail.clock.t = t;
      await runAlertPass(db, { now: at(t), sinks: [mail], shards: [] });
    }
    expect(firstMail(mail)).toBe(3 * HOUR + 10 * MIN);
  });
});

describe("LOW 1 — a key held only by another pass's in-flight mail is left unclaimed", () => {
  it("that mail fails: the key mails the pass after the lease is gone, and the held line says when", async () => {
    const db = await makeTestDb();
    const seed = await seedAccount(db);
    await digestSentAgo(db, HOUR);
    await db.insert(alertState).values({
      alertKey: "mail:sends_stuck", kind: "mail_policy", severity: "warning", cls: "signal",
      resolvedAt: new Date(0), notifyCount: 0, claimedUntil: at(2 * MIN),
    });
    await stuck(db, seed, 1);
    const mail = clockedMail();
    const r0 = await runAlertPass(db, { now: NOW, sinks: [mail], shards: [] });
    expect(r0.mailHeld).toEqual([{ alertKey: "sends_stuck", kind: "sends_stuck", retryAt: at(2 * MIN).toISOString() }]);
    const [key] = await db.select({ n: alertState.notifyCount, c: alertState.claimedUntil }).from(alertState)
      .where(eq(alertState.alertKey, "sends_stuck"));
    expect([key!.n, key!.c], "not confirmed, not leased").toEqual([0, null]);
    // The alert mail was refused: its settle releases the policy row and stamps nothing.
    await db.update(alertState).set({ claimedUntil: null }).where(eq(alertState.alertKey, "mail:sends_stuck"));
    for (let t = MIN; t <= 10 * MIN && mail.pages.length === 0; t += MIN) {
      mail.clock.t = t;
      await runAlertPass(db, { now: at(t), sinks: [mail], shards: [] });
    }
    expect(mail.pages[0]?.at, "the next pass mails, not the next hourly reminder").toBe(MIN);
  });
});

describe("LOW 2 — a window stamped by a wrong clock states no mail", () => {
  const seedWindow = (db: Db, ahead: number) => db.insert(alertState).values({
    alertKey: "mail:sends_stuck", kind: "mail_policy", severity: "warning", cls: "signal",
    resolvedAt: new Date(0), notifyCount: 0, notifiedAt: at(ahead), notifiedSignature: "peak|2",
  });

  it("a stamp three days ahead does not hold a first page", async () => {
    const db = await makeTestDb();
    const seed = await seedAccount(db);
    await digestSentAgo(db, HOUR);
    await seedWindow(db, 3 * 24 * HOUR);
    await stuck(db, seed, 1);
    const mail = clockedMail();
    await runAlertPass(db, { now: NOW, sinks: [mail], shards: [] });
    expect(mail.pages).toHaveLength(1);
  });

  it("control: a stamp a minute ahead is the other driver's clock, and holds", async () => {
    const db = await makeTestDb();
    const seed = await seedAccount(db);
    await digestSentAgo(db, HOUR);
    await seedWindow(db, MIN);
    await stuck(db, seed, 1);
    const mail = clockedMail();
    const r = await runAlertPass(db, { now: NOW, sinks: [mail], shards: [] });
    expect(mail.pages).toHaveLength(0);
    expect(r.mailHeld.map((h) => h.alertKey)).toEqual(["sends_stuck"]);
  });
});

describe("a refused mail releases both leases and stamps nothing", () => {
  it("the retry is admitted on the next pass", async () => {
    const db = await makeTestDb();
    const seed = await seedAccount(db);
    await digestSentAgo(db, HOUR);
    await stuck(db, seed, 1);
    const refuse = clockedMail(false);
    await runAlertPass(db, { now: NOW, sinks: [refuse], shards: [] });
    const rows = await db.select({ k: alertState.alertKey, n: alertState.notifiedAt, c: alertState.claimedUntil, s: alertState.notifiedSignature })
      .from(alertState);
    const pol = rows.find((r) => r.k === "mail:sends_stuck");
    const key = rows.find((r) => r.k === "sends_stuck");
    expect([pol?.n ?? null, pol?.c ?? null, pol?.s ?? null]).toEqual([null, null, null]);
    expect([key?.n ?? null, key?.c ?? null]).toEqual([null, null]);
    const ok = clockedMail(true);
    await runAlertPass(db, { now: at(MIN), sinks: [ok], shards: [] });
    expect(ok.pages.map((p) => p.keys)).toEqual([["sends_stuck"]]);
  });
});

describe("LOW 4 — a refused digest moves the sink's streak", () => {
  it("three refused digests escalate a mail arm that refuses nothing else", async () => {
    const db = await makeTestDb();
    await db.insert(alertState).values({
      alertKey: "old", kind: "sends_stuck", severity: "critical", cls: "incident",
      openedAt: new Date(NOW.getTime() - 3 * HOUR), lastSeenAt: new Date(NOW.getTime() - 2 * HOUR),
      resolvedAt: new Date(NOW.getTime() - 2 * HOUR), notifyCount: 0,
    });
    const sink: AlertSink = {
      name: "mail", channel: "mail", async notify() { return true; },
      async notifyDigest() { return { ok: false, error: "HTTP 422", outcome: "refused" }; },
    };
    const streak = newDeliveryStreak();
    let escalated = null;
    for (let i = 0; i < 3; i++) {
      const r = await runAlertPass(db, { now: at(i * MIN), sinks: [sink], shards: [], deliveryStreak: streak });
      expect(r.digest).toBeNull();
      escalated ??= r.escalate;
    }
    expect(streak.sinks.mail?.consecutiveFailures).toBe(3);
    expect(escalated?.sinks).toEqual(["mail"]);
  });
});

describe("the billing plane's three kinds page: money, and the watch on it", () => {
  const alertOf = (kind: Alert["kind"], key: string): Alert => ({
    key, kind, severity: "warning", title: "t", detail: "d", count: 1, oldestSeconds: null,
  });

  it("a stalled pass, a billing alert and an unreadable plane are each a page", () => {
    // Stated, not the unknown-kind default, which also reads "page".
    for (const kind of ["plane_pass_stale", "billing_alert", "plane_ops_unreadable"]) {
      expect(Object.prototype.hasOwnProperty.call(MAIL_POLICY, kind), kind).toBe(true);
    }
    expect(mailVerdictOf(alertOf("plane_pass_stale", "plane_pass_stale:reconcile"))).toBe("page");
    expect(mailVerdictOf(alertOf("billing_alert", "billing_alert:events_failed"))).toBe("page");
    expect(mailVerdictOf(alertOf("plane_ops_unreadable", "plane_ops_unreadable:worker"))).toBe("page");
  });

  it("the facts share the ordinary window; the reader's own failure asks daily, as the alerting's own do", () => {
    expect(mailCooldownMs("plane_pass_stale")).toBe(MAIL_COOLDOWN_MS);
    expect(mailCooldownMs("billing_alert")).toBe(MAIL_COOLDOWN_MS);
    expect(mailCooldownMs("plane_ops_unreadable")).toBe(mailCooldownMs("alert_driver_dark"));
    expect(mailCooldownMs("plane_ops_unreadable")).toBeGreaterThan(MAIL_COOLDOWN_MS);
  });
});
