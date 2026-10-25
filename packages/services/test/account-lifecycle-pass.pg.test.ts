/* @postpush: alone — runAccountLifecyclePass sweeps every account due for erasure in the database,
 * so its window is deployment-wide whatever the assertions below scope. */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { accounts, users, mailboxes } from "@trafficflow/db";
import {
  accountLifecycleNotices, schema, makeEntitlementsClient, ACCESS_TTL_MS,
} from "@trafficflow/db/cloud";
import type { EntitlementsFetch } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { AccessLifecycle, AccessVerdict } from "@trafficflow/db";
import { runAccountLifecyclePass, eraseOneDueAccount } from "../src/index.js";
import type { AccountLifecyclePassDeps, AccountLifecyclePassResult } from "../src/index.js";

/**
 * THE NIGHTLY LIFECYCLE PASS ON REAL POSTGRES (cloud 0040) — the three properties PGlite says
 * nothing about: the notices PRIMARY KEY as the idempotency (a re-run's `ON CONFLICT DO NOTHING`
 * against a real conflict), `deleteAccount` running inside the erase door over the real FK graph, and
 * the erasure's own idempotency by `accounts.erased_at`. Everything is scoped to accounts this
 * file creates — the database is shared with every other pg file in the workspace.
 *
 * The mail 0124 CHECK rides along at the end: the widened member admitted, a foreign one refused
 * — on the REAL constraint, which `closed-set-parity` can only read as text.
 */

const PG_UP = await realPgAvailable();

const sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
const db = brandDialect(drizzle(sql, { schema }), "pg");

const NOW = new Date("2026-09-20T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

afterAll(async () => { await sql.end(); });

async function seedAccount(): Promise<{ accountId: string; email: string }> {
  const [a] = await db.insert(accounts).values({ name: "wall-test" }).returning();
  const email = `wall-${randomUUID().slice(0, 8)}@wall.test`;
  await db.insert(users).values({ accountId: a!.id, email });
  return { accountId: a!.id, email };
}

/**
 * A closed lifecycle block anchored where the test says, from a program whose lifecycle went live
 * sixty days before NOW: every closure here is after its epoch, so the belt is slack under it.
 */
function closedLifecycle(over: Partial<AccessLifecycle> = {}): AccessLifecycle {
  return {
    state: "closed", closedReason: "trial_ended", trialEndsAt: null, graceUntil: null,
    closedAt: new Date(NOW.getTime() - 30 * DAY).toISOString(),
    erasureAt: new Date(NOW.getTime() + 10 * DAY).toISOString(),
    erasedAt: null, formerlyPaid: false,
    lifecycleEpoch: new Date(NOW.getTime() - 60 * DAY).toISOString(), ...over,
  };
}

/** A port whose lifecycle answers come from the map; everything else is open. */
function fakePort(byAccount: Map<string, AccessLifecycle>): {
  port: AccountLifecyclePassDeps["port"]; released: string[];
} {
  const released: string[] = [];
  const access = async (accountId: string): Promise<AccessVerdict> => {
    const lc = byAccount.get(accountId);
    if (!lc) return { ok: true, limits: { mailboxes: null, storageBytes: null, canAddMailbox: true, aiEnabled: true } };
    return lc.state === "closed" || lc.state === "erased"
      ? { ok: false, reason: "payment_required", lifecycle: lc }
      : { ok: true, limits: { mailboxes: null, storageBytes: null, canAddMailbox: true, aiEnabled: true }, lifecycle: lc };
  };
  return {
    released,
    port: {
      accessOrFault: access,
      releaseAccount: async (accountId) => { released.push(accountId); return "cancelled"; },
    },
  };
}

function fakeMail(status: "sent" | "failed" | "skipped" = "sent", delayMs = 0) {
  const sent: Array<{
    to: string; kind: string; locale: string; anchor: string; erasureAt: string | null; noMailbox?: boolean;
  }> = [];
  return {
    sent,
    mail: {
      sendLifecycleNotice: async (
        _ctx: unknown,
        input: { to: string; kind: string; locale: string; anchor: Date; erasureAt: Date | null; noMailbox?: boolean },
      ) => {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        sent.push({
          to: input.to, kind: input.kind, locale: input.locale, anchor: input.anchor.toISOString(),
          erasureAt: input.erasureAt?.toISOString() ?? null, noMailbox: input.noMailbox,
        });
        return { status };
      },
    } as unknown as AccountLifecyclePassDeps["mail"],
  };
}

/** The erasure-week warning as the pass records a delivered one, a week before the plane's date. */
async function warned(accountId: string, lc: AccessLifecycle): Promise<void> {
  const anchor = new Date(lc.erasureAt!);
  const at = new Date(anchor.getTime() - 7 * DAY);
  await db.insert(accountLifecycleNotices).values({ accountId, kind: "erasure_week", anchor, sentAt: at, deliveredAt: at });
}

/** The account's notice rows, oldest anchor first. */
const noticesOf = async (accountId: string) => (await db.select().from(accountLifecycleNotices)
  .where(eq(accountLifecycleNotices.accountId, accountId))).sort((a, b) => a.anchor.getTime() - b.anchor.getTime());

/**
 * What the driver does in one fire: the sweep, then the erase door once per account it named —
 * the sweep itself erases nothing. `erased` counts the door's erasures, as the sweep's used to.
 */
async function sweepThenErase(deps: AccountLifecyclePassDeps): Promise<AccountLifecyclePassResult & { erased: number }> {
  const r = await runAccountLifecyclePass(db, deps);
  let erased = 0;
  for (const id of r.erasureDue) if (await eraseOneDueAccount(db, deps, id) === "erased") erased += 1;
  return { ...r, erased };
}

/** A logger that keeps the events it was handed, so a refusal can be read back. */
function fakeLog() {
  const events: Array<{ level: string; event: string; accountId: unknown; epoch?: unknown }> = [];
  const at = (level: string) => (event: string, fields?: Record<string, unknown>) =>
    { events.push({ level, event, accountId: fields?.accountId, epoch: fields?.epoch }); };
  const log = {
    level: "info", child: () => log,
    debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"),
  } as unknown as AccountLifecyclePassDeps["log"];
  return { events, log };
}

describe.skipIf(!PG_UP)("the nightly lifecycle pass on real Postgres", () => {
  it("a closed account with a FUTURE erasure gets its notice ONCE and loses nothing", async () => {
    const { accountId, email } = await seedAccount();
    const lc = closedLifecycle();
    const { port } = fakePort(new Map([[accountId, lc]]));
    const m1 = fakeMail();

    const r1 = await sweepThenErase({ port, mail: m1.mail, now: () => NOW });
    expect(m1.sent.filter((s) => s.to === email && s.kind === "closed")).toHaveLength(1);
    expect(r1.erased, "a future erasureAt must delete NOTHING").toBe(0);
    const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(a!.erasedAt).toBeNull();
    const rows = await db.select().from(accountLifecycleNotices)
      .where(eq(accountLifecycleNotices.accountId, accountId));
    expect(rows.map((r) => r.kind)).toEqual(["closed"]);

    // THE PK CONFLICT, on the real constraint: the second run inserts nothing and mails nobody.
    const m2 = fakeMail();
    await sweepThenErase({ port, mail: m2.mail, now: () => NOW });
    expect(m2.sent.filter((s) => s.to === email)).toHaveLength(0);

    // A NEW closure is a NEW anchor — its own notice, not a duplicate of the old one.
    const again = closedLifecycle({ closedAt: new Date(NOW.getTime() - 1 * DAY).toISOString() });
    const { port: port2 } = fakePort(new Map([[accountId, again]]));
    const m3 = fakeMail();
    await sweepThenErase({ port: port2, mail: m3.mail, now: () => NOW });
    expect(m3.sent.filter((s) => s.to === email && s.kind === "closed")).toHaveLength(1);
  });

  it("a SUSPENDED closure owes NO notice, beside a subscription end that owes exactly one", async () => {
    const held = await seedAccount();
    const ended = await seedAccount();
    // The shape the plane actually answers with: `erasureAt` is null while suspended — an
    // operator hold is not a departure, so no retention clock runs and nothing is erased.
    const { port } = fakePort(new Map([
      [held.accountId, closedLifecycle({ closedReason: "suspended", erasureAt: null })],
      [ended.accountId, closedLifecycle({ closedReason: "trial_ended" })],
    ]));
    const m = fakeMail();
    const r = await sweepThenErase({ port, mail: m.mail, now: () => NOW });

    expect(m.sent.filter((s) => s.to === held.email),
      "an operator hold is communicated by the operator, never by a 'subscribe again' mail").toHaveLength(0);
    expect(await db.select().from(accountLifecycleNotices)
      .where(eq(accountLifecycleNotices.accountId, held.accountId)),
      "and no claim row is written for a notice that must not exist").toHaveLength(0);

    // THE POSITIVE ARM, unchanged: a subscription that ended still gets its one notice.
    expect(m.sent.filter((s) => s.to === ended.email && s.kind === "closed")).toHaveLength(1);

    // AND a hold is not an erasure: the pass deletes nothing while staff hold the account.
    expect(r.erased).toBe(0);
    const [a] = await db.select().from(accounts).where(eq(accounts.id, held.accountId));
    expect(a!.erasedAt).toBeNull();
    expect(await db.select().from(users).where(eq(users.accountId, held.accountId))).toHaveLength(1);
  });

  it("a trial with no mailbox gets the no-mailbox notice and one with a mailbox today's, each once", async () => {
    const bare = await seedAccount();
    const kept = await seedAccount();
    await db.insert(mailboxes).values({
      accountId: kept.accountId, provider: "imap", address: `kept-${randomUUID().slice(0, 8)}@wall.test`,
    });
    const trial: AccessLifecycle = {
      state: "trialing", closedReason: null, trialEndsAt: new Date(NOW.getTime() + DAY).toISOString(),
      graceUntil: null, closedAt: null, erasureAt: null, erasedAt: null, formerlyPaid: false,
    };
    const { port } = fakePort(new Map([[bare.accountId, trial], [kept.accountId, trial]]));
    const mine = (m: ReturnType<typeof fakeMail>) => m.sent.filter((s) => s.to === bare.email || s.to === kept.email)
      .map((s) => ({ to: s.to, kind: s.kind, noMailbox: s.noMailbox }));
    const m1 = fakeMail();
    await sweepThenErase({ port, mail: m1.mail, now: () => NOW });
    expect(mine(m1)).toEqual(expect.arrayContaining([
      { to: bare.email, kind: "trial_two_days", noMailbox: true },
      { to: kept.email, kind: "trial_two_days", noMailbox: false },
    ]));
    expect(mine(m1)).toHaveLength(2);
    const m2 = fakeMail();
    await sweepThenErase({ port, mail: m2.mail, now: () => NOW });
    expect(mine(m2), "one mail per account per kind").toEqual([]);
  });

  it("the erasure-week notice arrives inside the window, anchored on the plane's own instant", async () => {
    const { accountId, email } = await seedAccount();
    const erasureAt = new Date(NOW.getTime() + 5 * DAY).toISOString();
    const lc = closedLifecycle({ erasureAt });
    const { port } = fakePort(new Map([[accountId, lc]]));
    const m = fakeMail();
    await sweepThenErase({ port, mail: m.mail, now: () => NOW });
    const week = m.sent.filter((s) => s.to === email && s.kind === "erasure_week");
    expect(week).toHaveLength(1);
    expect(week[0]!.anchor).toBe(erasureAt);
  });

  it("erasure runs ONCE the anchor plus a day of slack has passed — through deleteAccount, idempotent by erased_at", async () => {
    const { accountId } = await seedAccount();
    // Past retention AND past the slack: erasureAt two days ago.
    const lc = closedLifecycle({
      closedAt: new Date(NOW.getTime() - 32 * DAY).toISOString(),
      erasureAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    });
    const { port, released } = fakePort(new Map([[accountId, lc]]));
    // The week's warning went out on time; without it the door holds (the cases below).
    await warned(accountId, lc);
    const r1 = await sweepThenErase({ port, mail: null, now: () => NOW });
    expect(r1.erased).toBe(1);
    expect(released, "the money is stopped through the port, before the delete").toEqual([accountId]);
    const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(a!.erasedAt).not.toBeNull();
    expect(await db.select().from(users).where(eq(users.accountId, accountId)),
      "deleteAccount ran: the users are gone").toHaveLength(0);

    // THE SECOND RUN IS ZERO: `erased_at` non-null keeps the account out of the iteration.
    const r2 = await sweepThenErase({ port, mail: null, now: () => NOW });
    expect(r2.erased).toBe(0);
    expect(released).toHaveLength(1);
  });

  it("a reactivation between the two reads keeps the account — the verdict is re-read at the door", async () => {
    const { accountId } = await seedAccount();
    const due = closedLifecycle({
      closedAt: new Date(NOW.getTime() - 32 * DAY).toISOString(),
      erasureAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    });
    const open = { mailboxes: null, storageBytes: null, canAddMailbox: true, aiEnabled: true };
    // Erase-due on the page's read, ACTIVE on the next one: the person subscribed again in between.
    let reads = 0;
    const released: string[] = [];
    const read = async (id: string): Promise<AccessVerdict> => {
      if (id !== accountId) return { ok: true, limits: open };
      reads += 1;
      return reads === 1
        ? { ok: false, reason: "payment_required", lifecycle: due }
        : { ok: true, limits: open, lifecycle: {
            ...due, state: "active", closedReason: null, closedAt: null, erasureAt: null } };
    };
    const port: AccountLifecyclePassDeps["port"] = {
      accessOrFault: read,
      releaseAccount: async (id) => { released.push(id); return "cancelled"; },
    };

    const r = await sweepThenErase({ port, mail: null, now: () => NOW });
    // The product fact first: the data is still there. The read count is the mechanism behind it.
    expect(await db.select().from(users).where(eq(users.accountId, accountId)),
      "deleteAccount never ran — a person who subscribed again keeps their data").toHaveLength(1);
    const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(a!.erasedAt).toBeNull();
    expect(r.erased).toBe(0);
    expect(released, "and they keep their subscription — a skip touches nothing").toEqual([]);
    expect(reads, "the verdict is read twice: once for the page, once at the erasure door").toBe(2);
  });

  it("a SUSPENDED account carrying an erasure date is REFUSED it, and the drift is reported", async () => {
    const held = await seedAccount();
    const ended = await seedAccount();
    const past = new Date(NOW.getTime() - 2 * DAY).toISOString();
    const closedLong = new Date(NOW.getTime() - 32 * DAY).toISOString();
    // The plane's contract keeps `erasureAt` null while suspended. This is that contract BROKEN:
    // erasure is irreversible, so the pass refuses it on its own rather than trusting the wire.
    const { port, released } = fakePort(new Map([
      [held.accountId, closedLifecycle({
        closedReason: "suspended", closedAt: closedLong, erasureAt: past })],
      [ended.accountId, closedLifecycle({ closedAt: closedLong, erasureAt: past })],
    ]));
    await warned(ended.accountId, closedLifecycle({ erasureAt: past }));
    const { events, log } = fakeLog();

    const r = await sweepThenErase({ port, mail: null, log, now: () => NOW });

    expect(await db.select().from(users).where(eq(users.accountId, held.accountId)),
      "an account an operator holds is never erased by this pass").toHaveLength(1);
    const [a] = await db.select().from(accounts).where(eq(accounts.id, held.accountId));
    expect(a!.erasedAt).toBeNull();
    expect(released, "and its subscription is not stopped either — only the other account's is")
      .toEqual([ended.accountId]);
    const refusals = events.filter((e) =>
      e.event === "account_erasure_refused_suspended" && e.accountId === held.accountId);
    expect(refusals, "the plane's drift is reported once per pass, never acted on").toHaveLength(1);

    // THE POSITIVE ARM: the same dates on a subscription end still erase, as they did before.
    expect(r.erased).toBe(1);
    expect(await db.select().from(users).where(eq(users.accountId, ended.accountId))).toHaveLength(0);
    expect(events.filter((e) => e.event === "account_erasure_refused_suspended"
      && e.accountId === ended.accountId)).toHaveLength(0);
  });

  it("a plane stating NO epoch erases nothing, and says so once per pass, not per account", async () => {
    const missing = await seedAccount();
    const nulled = await seedAccount();
    // The dates the erasure case above erases on; only the epoch differs — absent, then null.
    const due = closedLifecycle({
      closedAt: new Date(NOW.getTime() - 32 * DAY).toISOString(),
      erasureAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    });
    const { lifecycleEpoch: _drop, ...noEpoch } = due;
    const { port, released } = fakePort(new Map([
      [missing.accountId, noEpoch as AccessLifecycle],
      [nulled.accountId, { ...due, lifecycleEpoch: null }],
    ]));

    for (const pass of [1, 2]) {
      const { events, log } = fakeLog();
      const r = await sweepThenErase({ port, mail: null, log, now: () => NOW });
      expect(r.erased, `pass ${pass}: nothing is erased on the word of a program without its floor`)
        .toBe(0);
      const said = events.filter((e) => e.event === "lifecycle_epoch_absent");
      expect(said, `pass ${pass}: one line for the pass, not one per account`).toHaveLength(1);
      expect(said[0]!.epoch).toBe("not_stated");
      expect(events.filter((e) => e.event === "account_erasure_refused_before_epoch")).toHaveLength(0);
    }
    expect(released, "and no subscription was stopped").toEqual([]);
    for (const { accountId } of [missing, nulled]) {
      expect(await db.select().from(users).where(eq(users.accountId, accountId))).toHaveLength(1);
      const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
      expect(a!.erasedAt).toBeNull();
    }
  });

  it("a FUTURE erasure within the slack does not erase — the slack is load-bearing", async () => {
    const { accountId } = await seedAccount();
    // erasureAt twelve hours ago: past the anchor, INSIDE the day of slack.
    const lc = closedLifecycle({ erasureAt: new Date(NOW.getTime() - DAY / 2).toISOString() });
    const { port } = fakePort(new Map([[accountId, lc]]));
    const r = await sweepThenErase({ port, mail: null, now: () => NOW });
    expect(r.erased).toBe(0);
    const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(a!.erasedAt).toBeNull();
  });

  it("a FAILED send hands the claim back, so the next run retries instead of losing the notice", async () => {
    const { accountId, email } = await seedAccount();
    const lc = closedLifecycle();
    const { port } = fakePort(new Map([[accountId, lc]]));
    const failing = fakeMail("failed");
    const r1 = await sweepThenErase({ port, mail: failing.mail, now: () => NOW });
    expect(r1.faults).toBeGreaterThan(0);
    expect(await db.select().from(accountLifecycleNotices)
      .where(and(eq(accountLifecycleNotices.accountId, accountId), eq(accountLifecycleNotices.kind, "closed"))),
      "the claim was handed back").toHaveLength(0);

    const m2 = fakeMail();
    await sweepThenErase({ port, mail: m2.mail, now: () => NOW });
    expect(m2.sent.filter((s) => s.to === email && s.kind === "closed")).toHaveLength(1);
  });

  it("no mailer ⇒ owed notices are reported and NOT claimed", async () => {
    const { accountId } = await seedAccount();
    const lc = closedLifecycle();
    const { port } = fakePort(new Map([[accountId, lc]]));
    const r = await sweepThenErase({ port, mail: null, now: () => NOW });
    expect(r.unmailable).toBeGreaterThan(0);
    expect(await db.select().from(accountLifecycleNotices)
      .where(eq(accountLifecycleNotices.accountId, accountId)),
      "a row must not say sent about a mail that never existed").toHaveLength(0);
  });

  it("the kind CHECK refuses a foreign word on the real constraint", async () => {
    const { accountId } = await seedAccount();
    await expect(db.insert(accountLifecycleNotices)
      .values({ accountId, kind: "spam_me" as never, anchor: NOW }))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("mail 0124: the widened sync-block CHECK admits account_closed and refuses a stranger", async () => {
    const { accountId } = await seedAccount();
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `chk-${randomUUID().slice(0, 8)}@wall.test`,
      syncBlockedReason: "account_closed",
    }).returning();
    expect(mb!.syncBlockedReason).toBe("account_closed");
    await expect(db.insert(mailboxes).values({
      accountId, provider: "imap", address: `chk2-${randomUUID().slice(0, 8)}@wall.test`,
      syncBlockedReason: "account_parked" as never,
    })).rejects.toMatchObject({ code: "23514" });
  });
});

/**
 * THE ERASURE DOOR THROUGH THE REAL CLIENT (2026-09-25). The fakes above answer every read alike,
 * which hid two things the client does: the door's re-read was a 60 s cache hit, and a read the
 * program did not answer returns the LAST verdict the client knew. An erasure acts only on an
 * answer the program gave at the door.
 */
type Answer = AccessLifecycle | "down";

/** A program answering this file's account from `answers` in turn, every other account open. */
function planeFor(accountId: string, answers: Answer[]) {
  const asked: string[] = [];
  const released: string[] = [];
  const open = { syncEnabled: true, canAddMailbox: true, aiEnabled: true, mailboxLimit: null, storageBytesLimit: null };
  const impl: EntitlementsFetch = async (url, init) => {
    const { accountId: id } = JSON.parse(init.body) as { accountId: string };
    if (new URL(url).pathname === "/v1/account/release") {
      released.push(id);
      return { status: 200, json: async () => ({ outcome: "cancelled" }) };
    }
    if (id !== accountId) return { status: 200, json: async () => ({ entitlements: open }) };
    const a = answers[Math.min(asked.length, answers.length - 1)]!;
    asked.push(id);
    if (a === "down") throw new TypeError("fetch failed");
    const closed = a.state === "closed" || a.state === "erased";
    return {
      status: 200,
      json: async () => ({
        entitlements: closed
          ? { ...open, syncEnabled: false, canAddMailbox: false, aiEnabled: false, reason: "trial_ended" }
          : open,
        lifecycle: a,
      }),
    };
  };
  return { impl, asked, released };
}

const clientOn = (impl: EntitlementsFetch, now: () => number) => makeEntitlementsClient({
  baseUrl: "https://e.example", secret: "x".repeat(24), fetchImpl: impl, now,
  onCallFault: () => { /* expected */ }, onContractFault: () => { /* not under test */ },
});

describe.skipIf(!PG_UP)("the erasure door, through the entitlements client", () => {
  const due = () => closedLifecycle({
    closedAt: new Date(NOW.getTime() - 32 * DAY).toISOString(),
    erasureAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
  });
  const kept = async (accountId: string) => {
    expect(await db.select().from(users).where(eq(users.accountId, accountId))).toHaveLength(1);
    const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(a!.erasedAt).toBeNull();
  };

  it("a program that cannot answer at the door erases nothing, whatever the client last knew", async () => {
    const { accountId } = await seedAccount();
    const t = 1_000;
    // The page's read is answered, and the client holds that closed verdict FRESH; the door's
    // read is not answered.
    const plane = planeFor(accountId, [due(), "down"]);
    const port = clientOn(plane.impl, () => t);
    const { events, log } = fakeLog();
    const r = await sweepThenErase({ port, mail: null, now: () => NOW, log });
    await kept(accountId);
    expect(r.erased).toBe(0);
    expect(plane.released, "the subscription is untouched too").toEqual([]);
    expect(plane.asked, "one read answered for the page, one unanswered at the door").toHaveLength(2);
    expect(events.filter((e) => e.accountId === accountId).map((e) => e.event))
      .toContain("account_erasure_skipped_unanswered");
  });

  it("a program that cannot answer at the page erases nothing on the verdict the client remembers", async () => {
    const { accountId } = await seedAccount();
    let t = 1_000;
    const plane = planeFor(accountId, [due(), "down"]);
    const port = clientOn(plane.impl, () => t);
    await port.access(accountId);             // the closed verdict the client now holds
    t += ACCESS_TTL_MS + 1;
    const { events, log } = fakeLog();
    const r = await sweepThenErase({ port, mail: null, now: () => NOW, log });
    await kept(accountId);
    expect(r.erased).toBe(0);
    expect(plane.released, "the subscription is untouched too").toEqual([]);
    expect(events.filter((e) => e.accountId === accountId).map((e) => e.event),
      "the account is skipped at its first read, before any door").toEqual(["account_lifecycle_skipped_unanswered"]);
    expect(plane.asked, "the remembered read, then the page's unanswered one").toHaveLength(2);
  });

  it("a reactivation the client has not read yet keeps the account: the door asks the program", async () => {
    const { accountId } = await seedAccount();
    const t = 1_000;
    const active = { ...due(), state: "active" as const, closedReason: null, closedAt: null, erasureAt: null };
    const plane = planeFor(accountId, [due(), active]);
    const r = await sweepThenErase({
      port: clientOn(plane.impl, () => t), mail: null, now: () => NOW,
    });
    await kept(accountId);
    expect(r.erased).toBe(0);
    expect(plane.asked, "one read for the page, one at the door").toHaveLength(2);
    expect(plane.released).toEqual([]);
  });

  it("the control: a closed answer at the door still erases", async () => {
    const { accountId } = await seedAccount();
    const t = 1_000;
    const plane = planeFor(accountId, [due()]);
    await warned(accountId, due());
    const r = await sweepThenErase({
      port: clientOn(plane.impl, () => t), mail: null, now: () => NOW,
    });
    expect(await db.select().from(users).where(eq(users.accountId, accountId))).toHaveLength(0);
    expect(r.erased).toBe(1);
    expect(plane.released).toEqual([accountId]);
  });
});

/**
 * THE NOTICES ON AN ANSWER (2026-09-25). The page's read went through `access`, whose fault arm
 * answers the last verdict the client knew, so a program that could not answer let the pass mail
 * a closure or a trial end that may no longer stand. Every notice rests on a read the program
 * answered; a fault skips the account, and the next pass asks again.
 */
describe.skipIf(!PG_UP)("the lifecycle notices, through the entitlements client", () => {
  const epoch = new Date(NOW.getTime() - 60 * DAY).toISOString();
  const trialing = (): AccessLifecycle => ({
    state: "trialing", closedReason: null, trialEndsAt: new Date(NOW.getTime() + DAY).toISOString(),
    graceUntil: null, closedAt: null, erasureAt: null, erasedAt: null, formerlyPaid: false,
    lifecycleEpoch: epoch,
  });
  // Closed a month ago and erased in five days: owes `closed` and `erasure_week`.
  const closedThisWeek = () => closedLifecycle({ erasureAt: new Date(NOW.getTime() + 5 * DAY).toISOString() });
  const reopened = (): AccessLifecycle => ({ ...trialing(), state: "active", trialEndsAt: null });
  const cases = [
    { name: "closed", lc: closedThisWeek, kinds: ["closed", "erasure_week"] },
    { name: "trialing", lc: trialing, kinds: ["trial_two_days"] },
  ];
  const claimed = async (accountId: string) => (await db.select().from(accountLifecycleNotices)
    .where(eq(accountLifecycleNotices.accountId, accountId))).map((r) => r.kind).sort();
  const sentTo = (m: ReturnType<typeof fakeMail>, email: string) =>
    m.sent.filter((s) => s.to === email).map((s) => s.kind).sort();

  it.each(cases)("a remembered $name verdict mails nobody while the program cannot answer, nor once it answers that the account reopened", async ({ lc }) => {
    const { accountId, email } = await seedAccount();
    let t = 1_000;
    const plane = planeFor(accountId, [lc(), "down", reopened()]);
    const port = clientOn(plane.impl, () => t);
    await port.access(accountId);             // the verdict the client now holds
    t += ACCESS_TTL_MS + 1;
    const { events, log } = fakeLog();
    const m = fakeMail();
    const r = await sweepThenErase({ port, mail: m.mail, now: () => NOW, log });
    expect(sentTo(m, email), "no notice rests on a verdict the program did not give").toEqual([]);
    expect(await claimed(accountId), "and no claim row is written for it").toEqual([]);
    expect(events.filter((e) => e.accountId === accountId).map((e) => e.event),
      "one line for the skipped account").toEqual(["account_lifecycle_skipped_unanswered"]);
    expect(r.faults, "and it is counted").toBe(1);

    const m2 = fakeMail();
    await sweepThenErase({ port, mail: m2.mail, now: () => NOW });
    expect(plane.asked, "the next pass asked the program again").toHaveLength(3);
    expect(sentTo(m2, email), "and its answer owes nothing").toEqual([]);
    expect(await claimed(accountId)).toEqual([]);
  });

  it.each(cases)("the $name notices a fault skipped are sent on the next answer, once — a later fault or answer never re-sends them", async ({ lc, kinds }) => {
    const { accountId, email } = await seedAccount();
    let t = 1_000;
    const plane = planeFor(accountId, [lc(), "down", lc(), "down", lc()]);
    const port = clientOn(plane.impl, () => t);
    await port.access(accountId);
    t += ACCESS_TTL_MS + 1;
    const perPass: string[][] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      const m = fakeMail();
      await sweepThenErase({ port, mail: m.mail, now: () => NOW });
      perPass.push(sentTo(m, email));
    }
    expect(perPass, "skipped on the fault, sent on the answer, never again (the notices PK)")
      .toEqual([[], [...kinds].sort(), [], []]);
    expect(await claimed(accountId)).toEqual([...kinds].sort());
    expect(plane.asked, "every pass asked the program").toHaveLength(5);
  });

  it.each(cases)("the control: a $name answer from the program sends its notices", async ({ lc, kinds }) => {
    const { accountId, email } = await seedAccount();
    const plane = planeFor(accountId, [lc()]);
    const m = fakeMail();
    const r = await sweepThenErase({
      port: clientOn(plane.impl, () => 1_000), mail: m.mail, now: () => NOW,
    });
    expect(sentTo(m, email)).toEqual([...kinds].sort());
    expect(await claimed(accountId)).toEqual([...kinds].sort());
    expect(r.faults).toBe(0);
  });
});

describe.skipIf(!PG_UP)("the erase door on real Postgres", () => {
  it("the sweep alone erases nothing; the door erases once, then answers already_erased, and a non-due id is skipped", async () => {
    const { accountId } = await seedAccount();
    const other = await seedAccount();
    const lc = closedLifecycle({
      closedAt: new Date(NOW.getTime() - 32 * DAY).toISOString(),
      erasureAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    });
    const { port, released } = fakePort(new Map([[accountId, lc]]));
    await warned(accountId, lc);
    const sweep = await runAccountLifecyclePass(db, { port, mail: null, now: () => NOW });
    expect(sweep.erasureDue).toContain(accountId);
    expect(released, "the sweep stopped a subscription itself").toEqual([]);
    expect(await db.select().from(users).where(eq(users.accountId, accountId)), "the sweep erased inline").toHaveLength(1);

    expect(await eraseOneDueAccount(db, { port, now: () => NOW }, accountId)).toBe("erased");
    expect(await db.select().from(users).where(eq(users.accountId, accountId))).toHaveLength(0);
    expect(await eraseOneDueAccount(db, { port, now: () => NOW }, accountId)).toBe("already_erased");
    expect(released, "a repeated poke stopped the money twice").toEqual([accountId]);
    expect(await eraseOneDueAccount(db, { port, now: () => NOW }, other.accountId)).toBe("not_due");
    expect(await db.select().from(users).where(eq(users.accountId, other.accountId))).toHaveLength(1);
  });
});

/**
 * NO ERASURE WITHOUT A DELIVERED WARNING, AND THE WARNING OUTLIVES THE ERASURE
 * (ERASURE-WEEK-MAIL-LEAVES-NO-TRACE). The erasure deleted every notice row, so nothing could show
 * afterwards whether the week's warning went out; and nothing waited for it.
 */
describe.skipIf(!PG_UP)("the erasure waits for a delivered warning, and keeps it", () => {
  const due = () => closedLifecycle({
    closedAt: new Date(NOW.getTime() - 32 * DAY).toISOString(),
    erasureAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
  });
  const at = (ms: number) => () => new Date(NOW.getTime() + ms);
  const HOUR = 60 * 60 * 1000;
  const said = (events: ReturnType<typeof fakeLog>["events"], accountId: string) =>
    events.filter((e) => e.accountId === accountId).map((e) => `${e.level} ${e.event}`);
  const kept = async (accountId: string) =>
    (await noticesOf(accountId)).map((n) => [n.kind, n.anchor.toISOString(), n.deliveredAt]);

  it("never warned: the door holds at ERROR; the late warning names a week from now, and the erasure waits for it", async () => {
    const { accountId, email } = await seedAccount();
    const lc = due();
    const { port, released } = fakePort(new Map([[accountId, lc]]));
    const held = fakeLog();
    expect((await runAccountLifecyclePass(db, { port, mail: null, now: () => NOW })).erasureDue).toContain(accountId);
    expect(await eraseOneDueAccount(db, { port, log: held.log, now: () => NOW }, accountId)).toBe("unwarned");
    expect(said(held.events, accountId)).toEqual(["error account_erasure_held_unwarned"]);
    expect(released, "the subscription is not stopped for a held erasure").toEqual([]);
    expect(await db.select().from(users).where(eq(users.accountId, accountId))).toHaveLength(1);
    expect((await db.select().from(accounts).where(eq(accounts.id, accountId)))[0]!.erasedAt).toBeNull();

    const m = fakeMail();
    await runAccountLifecyclePass(db, { port, mail: m.mail, now: () => NOW });
    expect(m.sent.filter((s) => s.to === email).map((s) => [s.kind, s.erasureAt])).toEqual([
      ["closed", null], ["erasure_week", new Date(NOW.getTime() + 7 * DAY).toISOString()],
    ]);
    const late = fakeLog();
    for (const later of [0, 8 * DAY - HOUR]) {
      expect(await eraseOneDueAccount(db, { port, log: late.log, now: at(later) }, accountId), `+${later}`).toBe("unwarned");
    }
    expect(said(late.events, accountId)).toEqual(Array(2).fill("warn account_erasure_held_for_late_warning"));
    expect(await eraseOneDueAccount(db, { port, now: at(8 * DAY + HOUR) }, accountId)).toBe("erased");
    expect(released).toEqual([accountId]);
    expect(await kept(accountId), "the delivered warning alone survives the erasure").toEqual([
      ["erasure_week", lc.erasureAt, NOW],
    ]);
  });

  it("warned in its week: the erasure runs on the plane's date, and only that warning survives it", async () => {
    const { accountId, email } = await seedAccount();
    const lc = closedLifecycle({ erasureAt: new Date(NOW.getTime() + 5 * DAY).toISOString() });
    const { port } = fakePort(new Map([[accountId, lc]]));
    const m = fakeMail();
    await runAccountLifecyclePass(db, { port, mail: m.mail, now: () => NOW });
    expect(m.sent.filter((s) => s.to === email).map((s) => [s.kind, s.erasureAt]))
      .toEqual([["closed", lc.erasureAt], ["erasure_week", lc.erasureAt]]);
    expect(await eraseOneDueAccount(db, { port, now: at(6 * DAY) }, accountId)).toBe("erased");
    expect(await kept(accountId)).toEqual([["erasure_week", lc.erasureAt, NOW]]);
  });

  it("a notice every recipient skipped is not delivered, and is sent again once its claim is an hour old", async () => {
    const { accountId, email } = await seedAccount();
    const { port } = fakePort(new Map([[accountId, closedLifecycle()]]));
    const { events, log } = fakeLog();
    const r = await runAccountLifecyclePass(db, { port, mail: fakeMail("skipped").mail, log, now: () => NOW });
    expect([r.skipped, r.sent.closed]).toEqual([1, 0]);
    expect(said(events, accountId)).toEqual(["warn account_lifecycle_notice_skipped"]);
    expect((await noticesOf(accountId)).map((n) => n.deliveredAt)).toEqual([null]);
    const perPass: number[] = [];
    for (const later of [HOUR / 2, 2 * HOUR, 4 * HOUR]) {
      const m = fakeMail();
      await runAccountLifecyclePass(db, { port, mail: m.mail, now: at(later) });
      perPass.push(m.sent.filter((s) => s.to === email).length);
    }
    expect(perPass, "held at 30 minutes, sent at two hours, and never again").toEqual([0, 1, 0]);
    expect((await noticesOf(accountId)).map((n) => n.deliveredAt)).toEqual([at(2 * HOUR)()]);
  });

  /** A claim an hour stale with no delivery: a pass that died between its claim and its send. */
  const stale = async (accountId: string, lc: AccessLifecycle) => db.insert(accountLifecycleNotices).values({
    accountId, kind: "closed", anchor: new Date(lc.closedAt!), sentAt: new Date(NOW.getTime() - 2 * HOUR),
  });

  it("a stale claim without a delivery is sent again and stamped delivered", async () => {
    const { accountId, email } = await seedAccount();
    const lc = closedLifecycle();
    await stale(accountId, lc);
    const m = fakeMail();
    const r = await runAccountLifecyclePass(db, { port: fakePort(new Map([[accountId, lc]])).port, mail: m.mail, now: () => NOW });
    expect(m.sent.filter((s) => s.to === email).map((s) => s.kind)).toEqual(["closed"]);
    expect(r.sent.closed).toBe(1);
    expect((await noticesOf(accountId)).map((n) => [n.sentAt, n.deliveredAt])).toEqual([[NOW, NOW]]);
  });

  it("two passes racing for one stale claim send it once", async () => {
    const { accountId, email } = await seedAccount();
    const lc = closedLifecycle();
    await stale(accountId, lc);
    const { port } = fakePort(new Map([[accountId, lc]]));
    const m = fakeMail("sent", 50);
    await Promise.all([1, 2].map(() => runAccountLifecyclePass(db, { port, mail: m.mail, now: () => NOW })));
    expect(m.sent.filter((s) => s.to === email)).toHaveLength(1);
  });
});
