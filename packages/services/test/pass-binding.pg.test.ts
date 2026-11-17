import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, lte } from "drizzle-orm";
import {
  UNSUB_DRAIN_PASS, accountStorage, accounts, bindDb, bindingOf, drafts, folderState, learningSignals, mailboxes, messageBodies,
  messages, outboundSends, outboundSentCopies, rules, unsubscribeDrainState, unsubscribeExamined, unsubscribeRecords, users,
} from "@trafficflow/db";
import { accountLifecycleNotices, closePooledDbs, makePooledDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, carries, flightsOf, realPgAvailable, recordPgWire, type PgWireFlight } from "@trafficflow/db/testing";
import type { AccessLifecycle, AccessVerdict, EntitlementsPort } from "@trafficflow/db";
import { UNMETERED_STORAGE_CAP, type OutboundMessage, type SendAdapter } from "@trafficflow/core";
import {
  ScheduleService, SendService, SCHEDULED_SEND_EXPIRY_MS, dbFor, eraseOneDueAccount, makeUnsubscribeService, runAccountLifecyclePass,
  runOwedSentCopyPass, runScheduledSendPass, runStorageMailPass,
  type AccountLifecyclePassDeps, type HostResolver, type LifecycleNoticeMailer, type OneClickPost, type OpenPassSendAdapter,
} from "../src/index.js";

/**
 * A PASS'S ROWS EACH RIDE THEIR OWN ACCOUNT, ON THE WIRE.
 *
 * A pass walks rows of many accounts on a handle that names none, and what it does for one row runs
 * in transactions that name that row's account: the row's own, read or claimed in this pass, never
 * the row before it and never an id the poke carried. Read off the bytes a pool of one wrote, the
 * pool a clock's route has: every statement is in a flight, the walk's flights name no account,
 * and each row's flights name the row's.
 *
 * The sender of scheduled letters is the pass the others are shaped after; the erasure door is the
 * one pass that is handed an id from outside. The lifecycle notices, the storage mails and the
 * unsubscribe drain each walk accounts or their letters, and work for each one in turn.
 */
const wire = recordPgWire();
const PG_UP = await realPgAvailable();

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** When the pass runs. */
const RUN = new Date("2026-10-05T09:00:00.000Z");

/** The accounts the flights of a reading name, in the order written, a run of one account told once. */
const accountsInTurn = (flights: readonly PgWireFlight[]): string[] => {
  const turns: string[] = [];
  for (const f of flights) if (f.account !== null && turns.at(-1) !== f.account) turns.push(f.account);
  return turns;
};
/** The flights of each turn of {@link accountsInTurn}. */
const turnsOf = (flights: readonly PgWireFlight[]): PgWireFlight[][] => {
  const turns: PgWireFlight[][] = [];
  let last: string | null = null;
  for (const f of flights) {
    if (f.account === null) continue;
    if (f.account !== last) turns.push([]);
    turns.at(-1)!.push(f);
    last = f.account;
  }
  return turns;
};
const names = (flights: readonly PgWireFlight[], table: string): boolean =>
  flights.some((f) => f.statements.some((s) => s.includes(`"${table}"`)));

describe.skipIf(!PG_UP)("the sender of scheduled letters binds each appointment to its own account (real Postgres)", () => {
  let pool: ReturnType<typeof makePooledDb>;
  const schedules = new ScheduleService();
  const A = randomUUID();
  const B = randomUUID();
  const mailboxOf = new Map<string, string>();

  /** An appointment of `accountId` at `at`, made as a request of that account would: on a handle bound to it. */
  const appointment = async (accountId: string, at: Date): Promise<string> => {
    const made = new Date(at.getTime() - 5 * MINUTE);
    const [d] = await pool.insert(drafts).values({
      accountId, mailboxId: mailboxOf.get(accountId)!, subject: "later", body: "words",
      to: [{ name: null, address: "you@example.com" }], status: "draft", createdAt: made, updatedAt: made,
    }).returning();
    await schedules.schedule(
      { db: dbFor(pool, accountId), accountId, userId: null, now: () => made, requestId: "seed" }, d!.id, at.toISOString(),
    );
    return d!.id;
  };

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    pool = makePooledDb(PG_TEST_URL, { max: 1 });
    for (const accountId of [A, B]) {
      const [mb] = await pool.insert(mailboxes).values({
        accountId, provider: "imap", address: `pass-${randomUUID().slice(0, 8)}@binding.test`,
      }).returning();
      mailboxOf.set(accountId, mb!.id);
    }
  }, 120_000);

  afterAll(async () => {
    await pool.delete(outboundSends).where(inArray(outboundSends.accountId, [A, B]));
    await pool.delete(drafts).where(inArray(drafts.accountId, [A, B]));
    await pool.delete(mailboxes).where(inArray(mailboxes.accountId, [A, B]));
    await closePooledDbs();
  });

  it("four due appointments of A, B, A, B: each one's statements ride its own account, the claim rides none", async () => {
    // In the order the claim takes them: A's first is a day and more late (closed, never sent),
    // B's and A's second are sent, B's second meets a mail server that cannot be reached.
    const lateOfA = await appointment(A, new Date(RUN.getTime() - SCHEDULED_SEND_EXPIRY_MS - 30 * MINUTE));
    await appointment(B, new Date(RUN.getTime() - 3 * MINUTE));
    await appointment(A, new Date(RUN.getTime() - 2 * MINUTE));
    await appointment(B, new Date(RUN.getTime() - 1 * MINUTE));

    const dials: Array<[mailbox: string, boundTo: string | null | undefined]> = [];
    const delivered: OutboundMessage[] = [];
    let dialsOfB = 0;
    const open: OpenPassSendAdapter = async (mailboxId, db): Promise<SendAdapter> => {
      dials.push([mailboxId, bindingOf(db)?.account]);
      if (mailboxId === mailboxOf.get(B) && ++dialsOfB > 1) throw new Error("connect ECONNREFUSED");
      return {
        async send(msg: OutboundMessage) { delivered.push(msg); return { providerMessageId: msg.messageId! }; },
        async messageInSent() { return false; },
        async close() { /* nothing to tear down */ },
      };
    };

    wire.start();
    const result = await runScheduledSendPass(bindDb(pool, { account: null }), {
      openSendAdapter: open, mailboxIds: [mailboxOf.get(A)!, mailboxOf.get(B)!], now: () => RUN, batch: 4,
    });
    const flights = flightsOf(wire.read());

    // The late one is closed; two are sent; the unreachable one is not sent, whichever way it ends.
    expect(result).toMatchObject({ claimed: 4, sent: 2 });
    expect(result.failed + result.deferred).toBe(2);
    expect(delivered).toHaveLength(2);

    // Nothing was written outside a flight, and the pass named no account but these two.
    expect(flights.filter((f) => f.door === "plain")).toEqual([]);
    expect(new Set(flights.map((f) => f.account))).toEqual(new Set([null, A, B]));
    // The claim reads and flips rows of both accounts in one transaction, and names neither.
    const walked = flights.filter((f) => f.account === null);
    expect(walked.every((f) => !f.keyed)).toBe(true);
    expect(names(walked.filter((f) => f.door === "write"), "drafts")).toBe(true);

    // Each appointment in turn, under its own account: A's late one, B's, A's, B's.
    expect(accountsInTurn(flights)).toEqual([A, B, A, B]);
    const [late, sentB, sentA, unreachable] = turnsOf(flights);
    // The late one is closed on its draft and reserves nothing.
    expect(names(late!, "drafts")).toBe(true);
    expect(names(late!, "outbound_sends")).toBe(false);
    // A sent one reserves and settles its send under its own account.
    expect(names(sentB!, "outbound_sends")).toBe(true);
    expect(names(sentA!, "outbound_sends")).toBe(true);
    // The unreachable one is settled on its draft, on its own account's handle.
    expect(names(unreachable!, "drafts")).toBe(true);

    // The dial of each appointment was handed the handle of that appointment's own account.
    expect(dials).toEqual([
      [mailboxOf.get(B), B], [mailboxOf.get(A), A], [mailboxOf.get(B), B],
    ]);

    // What each account's rows say afterwards: A's late letter closed with its sentence and one
    // send recorded for A; one send delivered for B, and B's unreachable letter not sent.
    const [late1] = await pool.select({ status: drafts.status, sendError: drafts.sendError }).from(drafts).where(eq(drafts.id, lateOfA));
    expect(late1).toMatchObject({ status: "draft" });
    expect(late1!.sendError).not.toBeNull();
    const sentOf = async (accountId: string) => (await pool.select({ status: outboundSends.status }).from(outboundSends)
      .where(eq(outboundSends.accountId, accountId))).filter((r) => r.status === "sent").length;
    expect(await sentOf(A)).toBe(1);
    expect(await sentOf(B)).toBe(1);
  });
});

describe.skipIf(!PG_UP)("the late pass for owed Sent copies binds each copy to its own account (real Postgres)", () => {
  let pool: ReturnType<typeof makePooledDb>;
  const A = randomUUID();
  const B = randomUUID();
  const mailboxOf = new Map<string, string>();

  /** A delivered letter of `accountId` whose Sent copy is owed since `at`. */
  const owedCopy = async (accountId: string, at: Date): Promise<string> => {
    const minted = `<${randomUUID()}@binding.test>`;
    const [s] = await pool.insert(outboundSends).values({
      accountId, idempotencyKey: `owed-${randomUUID().slice(0, 8)}`, mintedMessageId: minted, providerMessageId: minted, status: "sent",
    }).returning();
    await pool.insert(outboundSentCopies).values({
      sendId: s!.id, accountId, mailboxId: mailboxOf.get(accountId)!, createdAt: at, nextAttemptAt: at,
      rawB64: Buffer.from(`Message-ID: ${minted}\r\n\r\nhi\r\n`).toString("base64"),
    });
    return s!.id;
  };

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    pool = makePooledDb(PG_TEST_URL, { max: 1 });
    // No copy of another file's is due in this pass: what it claims is this file's own.
    await pool.delete(outboundSentCopies).where(lte(outboundSentCopies.nextAttemptAt, RUN));
    for (const accountId of [A, B]) {
      const [mb] = await pool.insert(mailboxes).values({
        accountId, provider: "imap", address: `owed-${randomUUID().slice(0, 8)}@binding.test`, status: "connected",
      }).returning();
      mailboxOf.set(accountId, mb!.id);
    }
  }, 120_000);

  afterAll(async () => {
    await pool.delete(outboundSentCopies).where(inArray(outboundSentCopies.accountId, [A, B]));
    await pool.delete(outboundSends).where(inArray(outboundSends.accountId, [A, B]));
    await pool.delete(mailboxes).where(inArray(mailboxes.accountId, [A, B]));
    await closePooledDbs();
  });

  it("the claim rides no account; a copy's dial, its turn, the look for another copy to tell a refusal by, and its mailbox's wait ride the copy's own", async () => {
    // A owes two copies and B one. A's mailbox refuses every filing, with nothing that says the
    // refusal is the copy's own: the pass files another copy of that mailbox to tell whose it is.
    const first = await owedCopy(A, new Date(RUN.getTime() - 3 * MINUTE));
    await owedCopy(B, new Date(RUN.getTime() - 2 * MINUTE));
    const second = await owedCopy(A, new Date(RUN.getTime() - 1 * MINUTE));

    const dials: Array<[mailbox: string, boundTo: string | null | undefined]> = [];
    const filedIn: string[] = [];
    const open: OpenPassSendAdapter = async (mailboxId, db): Promise<SendAdapter> => {
      dials.push([mailboxId, bindingOf(db)?.account]);
      return {
        async send(msg: OutboundMessage) { return { providerMessageId: msg.messageId! }; },
        async messageInSent() { return false; },
        async fileSentCopy() {
          if (mailboxId === mailboxOf.get(A)) throw new Error("the mailbox will not take it");
          filedIn.push(mailboxId);
          return null;
        },
        async close() { /* nothing to tear down */ },
      };
    };

    wire.start();
    const result = await runOwedSentCopyPass(bindDb(pool, { account: null }), {
      openSendAdapter: open, resolveStorageCap: async () => UNMETERED_STORAGE_CAP, sends: new SendService(), now: () => RUN,
    });
    const flights = flightsOf(wire.read());

    expect(result).toMatchObject({ claimed: 3, filed: 1, onLadder: 1 });
    expect(filedIn).toEqual([mailboxOf.get(B)]);
    // Each dial was handed the handle of the copy it was opened for.
    expect(dials.length).toBeGreaterThanOrEqual(2);
    for (const [mailbox, boundTo] of dials) expect(boundTo).toBe(mailbox === mailboxOf.get(A) ? A : B);

    expect(flights.filter((f) => f.door === "plain")).toEqual([]);
    expect(flights.filter((f) => f.keyed)).toEqual([]);
    expect(new Set(flights.map((f) => f.account))).toEqual(new Set([null, A, B]));

    // On the walk: the claim, the claim of a copy kept without its files, and the count of what is
    // left. Nothing else of the pass names no account.
    const walk = flights.filter((f) => f.account === null);
    expect(walk.map((f) => f.door)).toEqual(["write", "write", "lone"]);
    expect(walk.every((f) => names([f], "outbound_sent_copies"))).toBe(true);
    // Both of A's copies were tried: the second was looked for, and found, under A.
    const ofA = flights.filter((f) => f.account === A);
    expect(ofA.some((f) => carries(f, first))).toBe(true);
    expect(ofA.some((f) => carries(f, second))).toBe(true);
    expect(flights.filter((f) => f.account === B && (carries(f, first) || carries(f, second)))).toEqual([]);
    expect(flights.filter((f) => f.account === B && carries(f, mailboxOf.get(A)!))).toEqual([]);
    expect(flights.filter((f) => f.account === A && carries(f, mailboxOf.get(B)!))).toEqual([]);
  });
});

describe.skipIf(!PG_UP)("the erasure door binds the row the asked id finds, never the id (real Postgres)", () => {
  let pool: ReturnType<typeof makePooledDb>;
  let accountId = "";

  /** A closure whose erasure date passed two days ago, from a program live long before it. */
  const due = (): AccessLifecycle => ({
    state: "closed", closedReason: "trial_ended", trialEndsAt: null, graceUntil: null,
    closedAt: new Date(RUN.getTime() - 32 * DAY).toISOString(),
    erasureAt: new Date(RUN.getTime() - 2 * DAY).toISOString(),
    erasedAt: null, formerlyPaid: false,
    lifecycleEpoch: new Date(RUN.getTime() - 60 * DAY).toISOString(),
  });
  /** The program's port: it answers `due` for every id, and keeps the ids it was asked. */
  const port = () => {
    const asked: string[] = [];
    const released: string[] = [];
    const p: AccountLifecyclePassDeps["port"] = {
      accessOrFault: async (id): Promise<AccessVerdict> => {
        asked.push(id);
        return { ok: false, reason: "payment_required", lifecycle: due() };
      },
      releaseAccount: async (id) => { released.push(id); return "cancelled"; },
    };
    return { port: p, asked, released };
  };

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    pool = makePooledDb(PG_TEST_URL, { max: 1 });
    const [a] = await pool.insert(accounts).values({ name: `erase-door-${randomUUID().slice(0, 8)}` }).returning();
    accountId = a!.id;
    await pool.insert(users).values({ accountId, email: `erase-${randomUUID()}@binding.test` });
  }, 120_000);

  afterAll(async () => {
    if (accountId !== "") {
      await pool.delete(users).where(eq(users.accountId, accountId));
      await pool.delete(accounts).where(eq(accounts.id, accountId));
    }
    await closePooledDbs();
  });

  const erase = async (asked: string) => {
    const p = port();
    wire.start();
    const outcome = await eraseOneDueAccount(bindDb(pool, { account: null }), { port: p.port, now: () => RUN }, asked);
    return { outcome, flights: flightsOf(wire.read()), ...p };
  };

  it("an id asked for in upper case finds its row, and everything after runs for the row's own id", async () => {
    // Due, and never warned: the door reads the account and its warning, and holds.
    const { outcome, flights, asked, released } = await erase(accountId.toUpperCase());
    expect(outcome).toBe("unwarned");
    expect(released).toEqual([]);
    // The program is asked about the row's id, as the row carries it.
    expect(asked).toEqual([accountId]);
    expect(flights.filter((f) => f.door === "plain")).toEqual([]);
    // One look on the walk finds the row; the reads after it name the row's account.
    expect(flights.map((f) => [f.door, f.account, f.keyed])).toEqual([
      ["lone", null, false], ["lone", accountId, false], ["lone", accountId, false],
    ]);
    expect(flights[0]!.statements[0]).toContain('"accounts"');
    expect(flights[1]!.statements[0]).toContain('"accounts"');
    expect(flights[2]!.statements[0]).toContain('"account_lifecycle_notices"');
  });

  it("an id no row answers binds nothing: one look on the walk, no flight that names an account", async () => {
    const stranger = randomUUID();
    const { outcome, flights, asked } = await erase(stranger);
    expect(outcome).toBe("not_due");
    expect(asked).toEqual([]);
    expect(flights.map((f) => [f.door, f.account])).toEqual([["lone", null]]);
  });

  it("the row's own id asked for as it stands: the same reads, under the same account", async () => {
    const { outcome, flights } = await erase(accountId);
    expect(outcome).toBe("unwarned");
    expect(accountsInTurn(flights)).toEqual([accountId]);
  });
});

/** A lifecycle as the program states it, `trialing` unless told otherwise. */
const lifecycleOf = (o: Partial<AccessLifecycle>): AccessLifecycle => ({
  state: "trialing", closedReason: null, trialEndsAt: null, graceUntil: null, closedAt: null, erasureAt: null,
  erasedAt: null, formerlyPaid: false, ...o,
});

describe.skipIf(!PG_UP)("the lifecycle notices bind each account the walk reads to its own (real Postgres)", () => {
  let pool: ReturnType<typeof makePooledDb>;
  // Two accounts whose ids differ in their last digit, and the id just below both: the walk's page from
  // there begins with these two, and a chunk of two holds them side by side.
  const stem = randomUUID().slice(0, 35);
  const BELOW = `${stem}4`;
  const A = `${stem}5`;
  const B = `${stem}6`;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    pool = makePooledDb(PG_TEST_URL, { max: 1 });
    for (const id of [A, B]) {
      await pool.insert(accounts).values({ id, name: `lifecycle-${randomUUID().slice(0, 8)}` });
      await pool.insert(users).values({ accountId: id, email: `lifecycle-${randomUUID()}@binding.test` });
    }
  }, 120_000);

  afterAll(async () => {
    await pool.delete(accountLifecycleNotices).where(inArray(accountLifecycleNotices.accountId, [A, B]));
    await pool.delete(users).where(inArray(users.accountId, [A, B]));
    await pool.delete(accounts).where(inArray(accounts.id, [A, B]));
    await closePooledDbs();
  });

  it("A owes the closure's notice and B the reminder to connect, in one chunk: A, B and A in turn, each on its own account", async () => {
    const port: AccountLifecyclePassDeps["port"] = {
      accessOrFault: async (id): Promise<AccessVerdict> => (id === A
        ? {
          ok: false, reason: "payment_required",
          lifecycle: lifecycleOf({ state: "closed", closedReason: "trial_ended", closedAt: new Date(RUN.getTime() - DAY).toISOString() }),
        }
        : {
          ok: true, limits: { mailboxes: 2, storageBytes: null, canAddMailbox: true, aiEnabled: true },
          lifecycle: lifecycleOf({ trialEndsAt: new Date(RUN.getTime() + 10 * DAY).toISOString() }),
          trial: { startedAt: new Date(RUN.getTime() - 2 * DAY).toISOString(), cancelScheduled: false },
        }),
      releaseAccount: async () => "none",
    };
    const mailedOn: Array<string | null | undefined> = [];
    const mail: LifecycleNoticeMailer = {
      async sendLifecycleNotice(ctx) { mailedOn.push(bindingOf(ctx.db)?.account); return { status: "sent" }; },
    };

    wire.start();
    const result = await runAccountLifecyclePass(bindDb(pool, { account: null }), {
      port, mail, now: () => RUN, after: BELOW, concurrency: 2, budgetMs: 0,
    });
    const flights = flightsOf(wire.read());

    // The one chunk: A's closure is mailed on A's handle; B is owed the reminder, which is logged and never sent.
    expect(result).toMatchObject({ accounts: 2, withLifecycle: 2, faults: 0 });
    expect(result.sent.closed).toBe(1);
    expect(result.connectReminder.owed).toBe(1);
    expect(mailedOn).toEqual([A]);
    expect(flights.filter((f) => f.door === "plain")).toEqual([]);
    // The walk's page names no account. B's one read runs between A's claim and the rest of A's
    // notice, and each turn rides the account it is for.
    expect(accountsInTurn(flights)).toEqual([A, B, A]);
    expect(flights.filter((f) => f.account === A && carries(f, B))).toEqual([]);
    expect(flights.filter((f) => f.account === B && carries(f, A))).toEqual([]);
  });
});

describe.skipIf(!PG_UP)("the storage mails bind each account they read to its own (real Postgres)", () => {
  let pool: ReturnType<typeof makePooledDb>;
  const A = randomUUID();
  const B = randomUUID();
  /** What each stores: more than any other account, A the most. */
  const STORED = new Map<string, number>([[A, 4_000_000_000_000_000], [B, 3_000_000_000_000_000]]);

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    pool = makePooledDb(PG_TEST_URL, { max: 1 });
    for (const [id, bytes] of STORED) {
      await pool.insert(accounts).values({ id, name: `storage-${randomUUID().slice(0, 8)}` });
      await pool.insert(accountStorage).values({ accountId: id, bytes });
    }
  }, 120_000);

  afterAll(async () => {
    await pool.delete(accountStorage).where(inArray(accountStorage.accountId, [A, B]));
    await pool.delete(accounts).where(inArray(accounts.id, [A, B]));
    await closePooledDbs();
  });

  it("A and B stored the most, each past 90% of its cap: each one's reads ride its own account, A then B", async () => {
    // The program answers for A and B, each held to a cap its storage is 95% of; any other account it refuses.
    const verdictOf = async (id: string): Promise<AccessVerdict> => {
      const bytes = STORED.get(id);
      if (bytes === undefined) return { ok: false, reason: "payment_required" };
      return {
        ok: true, limits: { mailboxes: 2, storageBytes: Math.round(bytes / 0.95), canAddMailbox: true, aiEnabled: true },
        lifecycle: lifecycleOf({ state: "active" }),
      };
    };
    const port: EntitlementsPort = {
      access: verdictOf, accessOrFault: verdictOf, spend: async () => ({ verdict: "fault" }), release: async () => "settled",
      manageLink: async () => null, releaseAccount: async () => "none",
    };

    wire.start();
    const result = await runStorageMailPass(bindDb(pool, { account: null }), { port, mail: null, now: () => RUN });
    const flights = flightsOf(wire.read());

    // Both are owed the mail at 90%; with no mailer nothing is claimed.
    expect(result).toMatchObject({ due: 2, unmailable: 2, faults: 0 });
    expect(flights.filter((f) => f.door === "plain")).toEqual([]);
    // The read of the accounts and their holds names none; then A's own reads, then B's.
    expect(accountsInTurn(flights)).toEqual([A, B]);
    expect(flights.filter((f) => f.account === A && carries(f, B))).toEqual([]);
    expect(flights.filter((f) => f.account === B && carries(f, A))).toEqual([]);
  });
});

describe.skipIf(!PG_UP)("the unsubscribe drain binds each account whose letters it walks to its own (real Postgres)", () => {
  let pool: ReturnType<typeof makePooledDb>;
  const A = randomUUID();
  const B = randomUUID();
  const mailboxOf = new Map<string, string>();
  const letters: string[] = [];
  /**
   * The drain walks every account's letters screened out since a day and three hours before it runs:
   * from this instant, this file's letters alone.
   */
  const NOW = new Date("2031-03-03T12:00:00.000Z");
  /** The position the mailboxes' provider signs `Authentication-Results` from. */
  const PROVIDER: ReadonlySet<string> = new Set(["mx.google.com"]);
  const PUBLIC_DNS: HostResolver = { async resolve() { return ["93.184.216.34"]; } };

  /** A letter of `accountId` screened out `minutes` before NOW, from a list that offers a one-click leave. */
  const screenedOut = async (accountId: string, minutes: number): Promise<string> => {
    const id = randomUUID();
    await pool.insert(messages).values({
      id, accountId, mailboxId: mailboxOf.get(accountId)!, bodyHash: `h-${id}`, dedupKey: `drain:${id}`, subject: "News",
      fromAddress: `news-${id.slice(0, 8)}@sender.example`, nativeLocator: { folder: "ohmail/Screened", ref: `1:${minutes}` },
    });
    await pool.insert(folderState).values({
      messageId: id, accountId, desiredFolder: "ohmail/Screened", observedFolder: "ohmail/Screened", lastSetBy: "us",
      reconcileStatus: "reconciled", conflict: false, updatedAt: new Date(NOW.getTime() - minutes * MINUTE),
    });
    await pool.insert(messageBodies).values({
      messageId: id, accountId, text: "", headers: {
        "list-unsubscribe": [`<https://sender.example/u?t=${id.slice(0, 8)}>`],
        "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
        "authentication-results": ["mx.google.com; dmarc=pass"],
      },
    });
    letters.push(id);
    return id;
  };

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    pool = makePooledDb(PG_TEST_URL, { max: 1 });
    for (const accountId of [A, B]) {
      await pool.insert(accounts).values({ id: accountId, name: `drain-${accountId.slice(0, 8)}` });
      const [mb] = await pool.insert(mailboxes).values({
        accountId, provider: "imap", address: `drain-${accountId.slice(0, 8)}@binding.test`,
      }).returning();
      mailboxOf.set(accountId, mb!.id);
      // A person screened the sender's domain out: what the drain acts under.
      await pool.insert(rules).values({
        accountId, kind: "domain", match: "sender.example", destination: "ohmail/Screened", provenance: "promoted",
        personDecidedAt: NOW,
      });
      await pool.insert(learningSignals).values({
        accountId, triggeringActionId: `screener:${randomUUID()}`, kind: "screener", senderDomain: "sender.example",
        destination: "ohmail/Screened", label: "positive",
      });
    }
  }, 120_000);

  afterAll(async () => {
    const ids = [A, B];
    if (letters.length > 0) {
      await pool.delete(unsubscribeExamined).where(inArray(unsubscribeExamined.messageId, letters));
      await pool.delete(unsubscribeRecords).where(inArray(unsubscribeRecords.accountId, ids));
      await pool.delete(messageBodies).where(inArray(messageBodies.messageId, letters));
      await pool.delete(folderState).where(inArray(folderState.messageId, letters));
      await pool.delete(messages).where(inArray(messages.id, letters));
      // Where the drain stopped, if it stopped on a letter of this file's.
      await pool.delete(unsubscribeDrainState).where(and(
        eq(unsubscribeDrainState.pass, UNSUB_DRAIN_PASS), inArray(unsubscribeDrainState.cursorMessageId, letters)));
    }
    await pool.delete(learningSignals).where(inArray(learningSignals.accountId, ids));
    await pool.delete(rules).where(inArray(rules.accountId, ids));
    await pool.delete(mailboxes).where(inArray(mailboxes.accountId, ids));
    await pool.delete(accounts).where(inArray(accounts.id, ids));
    await closePooledDbs();
  });

  it("letters of A, B and A in its window: the drain acts for A, then B, each letter on its own account", async () => {
    const firstOfA = await screenedOut(A, 30);
    const ofB = await screenedOut(B, 20);
    const secondOfA = await screenedOut(A, 10);
    const posted: string[] = [];
    const post: OneClickPost = { async post(url: string) { posted.push(url); return { status: 200 }; } };
    const drain = makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => PROVIDER });

    wire.start();
    const run = await drain.drainScreenedOut(bindDb(pool, { account: null }), { now: () => NOW, requestId: "binding" });
    const flights = flightsOf(wire.read());

    // Each letter's list was asked to let its mailbox go.
    expect(run.accounts).toBe(2);
    expect(run.sweep.posted).toBe(3);
    expect(posted).toHaveLength(3);
    expect(flights.filter((f) => f.door === "plain")).toEqual([]);
    // The walk reads the letters and names no account; A's two are acted on under A, then B's one under B.
    expect(accountsInTurn(flights)).toEqual([A, B]);
    for (const [letter, own] of [[firstOfA, A], [ofB, B], [secondOfA, A]] as const) {
      const naming = flights.filter((f) => f.account !== null && carries(f, letter));
      expect(naming.length).toBeGreaterThan(0);
      expect(naming.map((f) => f.account)).toEqual(naming.map(() => own));
    }
  });
});
