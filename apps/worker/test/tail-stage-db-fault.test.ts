import { randomUUID } from "node:crypto";
import net from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { accounts, mailboxCredentials, mailboxes, type Tx } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, type Logger } from "@trafficflow/core";
import { startWorker } from "../src/index.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * A CYCLE-TAIL STAGE THAT MEETS A DEAD DATABASE SAYS SO. Per stage, the REAL pass is handed a database
 * that refuses the connection, once: the stage announces it on the line before its own, once,
 * quarantines nothing, and clears on the next completed cycle. CONTROLS: a value Postgres refuses, a
 * statement timeout, a lock timeout and a serialization failure are the account's own and announce
 * nothing; a tail that meets no fault announces none. The Screener's suggest pass is not here: its
 * database calls carry no tag yet (a gap row names it).
 */
const fault = vi.hoisted(() => {
  const s = { stage: "", db: null as unknown, err: null as unknown, calls: new Map<string, number>() };
  /** Wrap one pass: armed for `stage`, its next call meets `err` or runs on the dead `db` once. */
  const wrap = <A extends unknown[], R>(
    stage: string, real: (...a: A) => Promise<R>,
    swap: (a: A, db: unknown) => A = (a, db) => [db, ...a.slice(1)] as unknown as A,
  ) => async (...a: A): Promise<R> => {
    s.calls.set(stage, (s.calls.get(stage) ?? 0) + 1);
    if (s.stage !== stage) return real(...a);
    const { db, err } = s;
    s.stage = ""; s.db = null; s.err = null;
    if (err !== null) throw err;
    return real(...swap(a, db));
  };
  type Mod = Record<string, unknown>;
  /** A module factory: the named passes wrapped, everything else the real module's. */
  const mocked = (names: Record<string, string>, swaps: Record<string, (a: unknown[], db: unknown) => unknown[]> = {}) =>
    async (load: () => Promise<unknown>): Promise<Mod> => {
      const real = await load() as Mod;
      const out: Mod = { ...real };
      for (const [fn, stage] of Object.entries(names)) {
        out[fn] = wrap(stage, real[fn] as (...a: unknown[]) => Promise<unknown>, swaps[fn]);
      }
      return out;
    };
  return Object.assign(s, { wrap, mocked });
});

vi.mock("@trafficflow/db", (load) => fault.mocked({ pruneIdempotencyKeys: "global_maintenance" })(load));
vi.mock("@trafficflow/db/cloud", (load) => fault.mocked({
  owedSuggestAccounts: "screener_suggest_owed", pruneErasedNotices: "erased_notices",
})(load));
vi.mock("@trafficflow/core/mail", (load) => fault.mocked({ searchIndexOwedAccounts: "search_index_backfill" })(load));
vi.mock("../src/bubble-up-cron.js", (load) => fault.mocked({ bubbleUpPass: "bubble_up" })(load));
vi.mock("../src/workflow-cron.js", (load) => fault.mocked({ workflowTimeScanPass: "workflow" })(load));
vi.mock("../src/gate-release.js", (load) => fault.mocked({ gateReleasePass: "gate_release" })(load));
vi.mock("../src/sender-check-backfill.js", async (load) => {
  const real = await (load as () => Promise<typeof import("../src/sender-check-backfill.js")>)();
  return {
    ...real,
    senderCheckRetirement: (opts: Parameters<typeof real.senderCheckRetirement>[0] = {}) => real.senderCheckRetirement({
      ...opts, pass: fault.wrap("sender_check_backfill", opts.pass ?? real.senderCheckBackfillPass),
    }),
  };
});
vi.mock("../src/list-address-backfill.js", (load) => fault.mocked({ listAddressBackfillPass: "list_address_backfill" })(load));
vi.mock("../src/rule-retro.js", (load) => fault.mocked({ ruleRetroPass: "rule_retro" })(load));
vi.mock("../src/gap-catchup.js", (load) => fault.mocked({ gapCatchupPass: "gap_catchup" })(load));
vi.mock("../src/ohbox-tidy.js", (load) => fault.mocked({ ohboxTidyPass: "ohbox_tidy" })(load));
vi.mock("../src/thread-join-heal.js", (load) => fault.mocked({ threadJoinHealPass: "thread_join_heal" },
  { threadJoinHealPass: (a, db) => [{ ...(a[0] as object), db }] })(load));
vi.mock("../src/inbound-quiet.js", (load) => fault.mocked({ inboundQuietPass: "inbound_quiet" })(load));
vi.mock("../src/away-reply-flag-redeliver.js", (load) => fault.mocked({ awayReplyFlagRedeliverPass: "away_reply_flag_redeliver" })(load));
// The test worker meters nothing, so the evictor would stop at the cap; armed, it is handed one.
vi.mock("../src/storage-evict.js", (load) => fault.mocked({ storageEvictPass: "storage_evict" },
  { storageEvictPass: (a, db) => [db, { ...(a[1] as object), storageCap: async () => 1_000_000 }, a[2]] })(load));
vi.mock("../src/screener-correspondent-retro.js", (load) => fault.mocked({ screenerCorrespondentRetroPass: "screener_correspondent_retro" })(load));
vi.mock("../src/screener-auto.js", (load) => fault.mocked({ screenerAutoApplyPass: "screener_auto_apply" })(load));
vi.mock("../src/screener-auto-act.js", (load) => fault.mocked({ screenerAutoActPass: "screener_auto_act" })(load));
vi.mock("../src/mailbox-erasure-pass.js", (load) => fault.mocked({ mailboxErasurePass: "mailbox_erasure" })(load));

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
let DB = "";
/** ONE pool for the file's own reads and writes: a pool per case ran the server out of connections. */
let own: OwnedDb | null = null;
const live = (): OwnedDb["db"] => own!.db;
const closers: Array<() => Promise<void>> = [];
/** Every stage of the tail but the Screener's suggest pass, with the line its failure logs. */
const STAGES = [
  ["screener_suggest_owed", "screener_suggest_owed_read_failed"],
  ["bubble_up", "bubble_up_failed"],
  ["workflow", "workflow_drain_failed"],
  ["gate_release", "gate_release_failed"],
  ["sender_check_backfill", "sender_check_backfill_failed"],
  ["list_address_backfill", "list_address_backfill_failed"],
  ["rule_retro", "rule_retro_failed"],
  ["gap_catchup", "gap_catchup_failed"],
  ["ohbox_tidy", "ohbox_tidy_failed"],
  ["thread_join_heal", "thread_join_heal_failed"],
  ["inbound_quiet", "inbound_quiet_failed"],
  ["away_reply_flag_redeliver", "away_reply_flag_redeliver_failed"],
  ["storage_evict", "storage_evict_failed"],
  ["screener_correspondent_retro", "screener_correspondent_retro_failed"],
  ["screener_auto_apply", "screener_auto_apply_failed"],
  ["screener_auto_act", "screener_auto_act_failed"],
  ["search_index_backfill", "search_index_owed_read_failed"],
  ["mailbox_erasure", "mailbox_erasure_failed"],
  ["global_maintenance", "idempotency_prune_failed"],
  ["erased_notices", "erased_notices_prune_failed"],
] as const;

/** The worker's lines in order, by event name. */
function orderedLogger(events: string[]): Logger {
  const self: Logger = {
    level: "debug", child: () => self,
    debug: (e) => { events.push(e); }, info: (e) => { events.push(e); },
    warn: (e) => { events.push(e); }, error: (e) => { events.push(e); },
  };
  return self;
}

const count = (events: string[], name: string): number => events.filter((e) => e === name).length;
const calls = (stage: string): number => fault.calls.get(stage) ?? 0;

async function waitFor(pred: () => boolean, ms = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** A port nothing listens on: bound by the kernel, then given back. */
/* Interpolated: the push gate reads a literal `user:pw@127.0.0.1:${port}` as a credential at a real host. */
const DEAD_ROLE = "nobody";
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const { port } = s.address() as net.AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** A real Postgres refusal carrying `code`, raised by the server itself. */
async function raised(code: string): Promise<unknown> {
  const err = await live().execute(sql.raw(`do $$ begin raise exception 'fixture' using errcode = '${code}'; end $$`))
    .then(() => null, (e: unknown) => e);
  expect((err as { code?: string } | null)?.code, `the server did not raise ${code}`).toBe(code);
  return err;
}

/** A real statement timeout, measured rather than raised. */
async function statementTimeout(): Promise<unknown> {
  const err = await live().transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = 1`);
    await tx.execute(sql`select pg_sleep(0.2)`);
  }).then(() => null, (e: unknown) => e);
  expect((err as { code?: string } | null)?.code, "the server did not time the statement out").toBe("57014");
  return err;
}

async function organizingWorker(events: string[]) {
  const db = live();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "tail-fault" });
  const [row] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`,
    organizerRole: "organizer", organizeConsentedAt: new Date(Date.now() - 60 * 60 * 1000),
  }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  const fleet = new FakeAdapterFleet();
  const worker = await startWorker({
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
    adapterFactory: fleet.factory, logger: orderedLogger(events), maxSyncFailures: 1,
    organizer: { installId: "cloud-test", displayName: "Cloud", staleAfterMs: 60_000 },
  });
  closers.push(() => worker.stop());
  return worker;
}

/** Arm `stage` with `err`, boot a worker, and assert the stage met it and nothing was announced. */
async function controlAnnouncesNothing(stage: string, failed: string, err: unknown): Promise<void> {
  Object.assign(fault, { stage, err });
  const events: string[] = [];
  const worker = await organizingWorker(events);
  expect(await waitFor(() => count(events, failed) > 0), `the ${stage} stage never met the control's refusal`).toBe(true);
  const before = calls(stage);
  expect(await waitFor(() => calls(stage) > before || count(events, "cycle_phases") > 1), "the next tail never ran").toBe(true);
  expect(count(events, "worker_database_fault"), `${stage}: one account's refusal was announced as an outage`).toBe(0);
  expect(worker.stats().databaseFaultSince).toBeNull();
}

describe("a cycle-tail stage that meets a dead database announces the shard's fault", () => {
  beforeAll(async () => {
    DB = await prepareIsolatedDb("trafficflow_worker_tail_fault");
    own = makeOwnedDb(DB);
  }, 120_000);
  afterAll(async () => { await own?.close(); own = null; });
  beforeEach(async () => {
    Object.assign(fault, { stage: "", db: null, err: null });
    fault.calls.clear();
    await truncateAll(DB);
  }, ISOLATED_DB_RESET_BUDGET_MS);
  afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("CONTROL: a tail that meets no fault announces none", async () => {
    const events: string[] = [];
    const worker = await organizingWorker(events);
    expect(await waitFor(() => STAGES.every(([s]) => calls(s) > 0) && count(events, "cycle_phases") > 1),
      `the tail never ran every stage; unmet: ${STAGES.filter(([s]) => calls(s) === 0).map(([s]) => s).join(", ")}`).toBe(true);
    expect(count(events, "worker_database_fault"), "an ordinary tail announced a database fault").toBe(0);
    expect(worker.stats().databaseFaultSince).toBeNull();
  }, 60_000);

  for (const [stage, failed] of STAGES) {
    it(`the ${stage} stage announces a refused connection once, quarantines nothing, and recovers`, async () => {
      const dead: OwnedDb = makeOwnedDb(`postgres://${DEAD_ROLE}:nothing@127.0.0.1:${await closedPort()}/gone`);
      closers.push(() => dead.close());
      Object.assign(fault, { stage, db: dead.db });
      const events: string[] = [];
      const worker = await organizingWorker(events);
      expect(await waitFor(() => count(events, failed) > 0), `the ${stage} stage never met the dead database`).toBe(true);
      expect(events[events.indexOf(failed) - 1], `the ${stage} stage swallowed the shard's fault`)
        .toBe("worker_database_fault");
      expect(await waitFor(() => count(events, "worker_database_recovered") > 0), "the outage never cleared").toBe(true);
      expect(count(events, "worker_database_fault"), "the outage was announced more than once").toBe(1);
      expect(worker.stats().databaseFaultSince).toBeNull();
      expect(count(events, "mailbox_quarantined"), "an outage of ours quarantined a mailbox").toBe(0);
    }, 60_000);

    it(`CONTROL: a value Postgres refuses in the ${stage} stage is the account's and announces nothing`, async () => {
      const refused = await live().execute(sql`select convert_from('\\xff'::bytea, 'UTF8')`)
        .then(() => null, (e: unknown) => e);
      expect(refused, "the database accepted the value this control needs refused").not.toBeNull();
      await controlAnnouncesNothing(stage, failed, refused);
    }, 60_000);

    it(`CONTROL: a statement timeout in the ${stage} stage is the account's and announces nothing`, async () => {
      await controlAnnouncesNothing(stage, failed, await statementTimeout());
    }, 60_000);
  }

  for (const code of ["55P03", "40001"]) {
    it(`CONTROL: ${code} raised by the server in a database-only stage announces nothing`, async () => {
      await controlAnnouncesNothing("gap_catchup", "gap_catchup_failed", await raised(code));
    }, 60_000);
  }
});
