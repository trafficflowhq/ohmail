import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, asc, eq } from "drizzle-orm";
import { changeLog, mailboxes, mailboxCredentials, messages, messageStates, workflows, workflowRuns, recordChange } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger, type DraftPort, type Logger } from "@trafficflow/core";
import { runWorkerSupervised } from "../src/supervisor.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * THE RESURFACING PASS RUNS BECAUSE THE WORKER'S OWN LOOP CALLS IT.
 *
 * ── WHY THIS FILE DRIVES `startWorker` AND NEVER `bubbleUpPass` ────────────────────────────
 *
 * `bubble-up-cron.test.ts` already covers the pass itself, in seven green tests, and those
 * seven tests were green for the whole period in which NOTHING IN PRODUCTION CALLED IT. The
 * user-visible consequence was a dated promise: the Ohbox's `resurface` shortcut hid a message
 * and showed "Resurfaces {when}" naming next Friday 09:00 UTC, and no deployed code could keep
 * it. A unit test on the pass reproduces exactly that blindness — "built, tested, unreachable
 * one level up" — so every assertion here is made against a REAL supervised worker on a REAL
 * Postgres, with the row and the `change_log` entry as the only evidence. If the call is deleted
 * from `cycle()`, this file goes red; `test/every-pass-has-a-producer.test.ts` is the structural
 * half of the same claim.
 *
 * ── AND WHY THE LOGGER IS REAL ────────────────────────────────────────────────────────────
 *
 * `createLogger` with an injected SINK, not a fake logger object. The project's own record: six
 * attach-log fields were handed over by their call site, asserted by a fake logger, and REFUSED by
 * the real census in production (`droppedFields=[…]`) with a green suite behind it. `flipped` is
 * on `ALLOWED_FIELDS`; the only way to prove it survives is to read the emitted bytes.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
const CONFIG_TS = fileURLToPath(new URL("../src/config.ts", import.meta.url));
let DB = "";

type Db = ReturnType<typeof makeDb>;

/** A real logger writing JSON lines into an array — the emitted bytes, not the call site's object. */
function capturingLogger(): { log: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const log = createLogger({
    service: "worker",
    level: "info",
    sink: (line) => { lines.push(JSON.parse(line) as Record<string, unknown>); },
  });
  return { log, lines };
}

async function seedMailbox(db: Db, accountId: string): Promise<string> {
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return row!.id;
}

/**
 * A snoozed message whose `bubble_up_at` is already past, PLUS the `change_log` row the snooze
 * itself emitted. The second half is what makes the seq assertion mean anything: the resurfacing
 * change has to land ABOVE the change the user's own action produced, or a client that has
 * already synced past the snooze never sees the message come back.
 */
async function seedDueSnooze(
  db: Db, accountId: string, mailboxId: string,
): Promise<{ stateId: string; setSeq: bigint }> {
  const dedup = `mid:${randomUUID()}`;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "later", fromAddress: "a@ex.example", nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  const [st] = await db.insert(messageStates).values({
    accountId, messageId: m!.id, state: "bubbled_up", bubbleUpAt: new Date("2020-01-01T00:00:00Z"),
  }).returning();
  // THE SEED GOES THROUGH THE SAME DOOR PRODUCTION DOES. `recordChange` takes a `LedgerTx` —
  // a real transaction handle — because the seq allocation and the `change_log` insert have to
  // become durable together; `assertLedgerTx` refuses a top-level autocommit handle at runtime.
  // This used to cast (`db as unknown as Tx`) and so seeded through a door no caller may use.
  // The cast is not restored to make this file green: a snooze in production is one transaction,
  // and the `seq > setSeq` assertion below is only meaningful if the seed's seq was allocated
  // the way every real one is.
  const setSeq = await db.transaction((tx) => recordChange(tx, {
    accountId, entityType: "message_state", entityId: st!.id, op: "update", meta: null,
  }));
  return { stateId: st!.id, setSeq };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start >= ms) throw new Error(`timed out after ${ms}ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

function cfgFor(fleet: FakeAdapterFleet, log: Logger, extra: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 250, sentDomain: "trafficflow.test",
    rosterIntervalMs: 400, lockHeartbeatMs: 60_000, mailboxRetryMs: 500,
    healthPort: 0, standbyRetryMs: 400, adapterFactory: fleet.factory, logger: log,
    ...extra,
  };
}

const stateOf = async (db: Db, id: string): Promise<{ state: string; bubbleUpAt: Date | null }> => {
  const [row] = await db.select().from(messageStates).where(eq(messageStates.id, id));
  return { state: row!.state, bubbleUpAt: row!.bubbleUpAt ?? null };
};

describe("bubble-up runs INLINE in the worker cycle", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_bubbleup"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("flips a due snooze back and emits the message_state change, with NO manual action", async () => {
    const db = makeDb(DB);
    const accountId = randomUUID();
    const mailboxId = await seedMailbox(db, accountId);
    const { stateId, setSeq } = await seedDueSnooze(db, accountId, mailboxId);

    const { log, lines } = capturingLogger();
    const fleet = new FakeAdapterFleet();
    const w = await runWorkerSupervised(cfgFor(fleet, log));
    closers.push(() => w.stop());

    await waitFor(async () => (await stateOf(db, stateId)).state === "resurfaced", 15000,
      "the worker's own cycle to resurface the snoozed message");

    // The row: resurfaced, and the promise date cleared so it cannot fire twice.
    const after = await stateOf(db, stateId);
    expect(after.state).toBe("resurfaced");
    expect(after.bubbleUpAt).toBeNull();

    // The `change_log` row a client's `/sync` reads — through the SAME seam every
    // client-visible mutation uses, and ABOVE the seq the snooze itself produced.
    const changes = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityId, stateId)))
      .orderBy(asc(changeLog.seq));
    expect(changes).toHaveLength(2);                       // the snooze, then the resurfacing
    expect(changes[1]!.entityType).toBe("message_state");
    expect(changes[1]!.op).toBe("update");
    expect(changes[1]!.seq > setSeq).toBe(true);

    // ── THE LINE, AS BYTES ──────────────────────────────────────────────────────────────
    const flips = lines.filter((l) => l.event === "bubble_up_flipped");
    expect(flips).toHaveLength(1);
    expect(flips[0]!.flipped).toBe(1);
    expect(flips[0]!.accountId).toBe(accountId);
    // `flipped` is on ALLOWED_FIELDS. If it ever comes off, production answers
    // `droppedFields:["flipped"]` and the outcome of the pass becomes unreadable.
    expect(flips[0]!.droppedFields).toBeUndefined();

    // …and it came from the LOOP, not from someone running the CLI backstop. `runCronCli`
    // emits `cron_bubble_up_ran` under service `worker-cron`; a line like that here would mean
    // the inline path is still missing and a hand-run process did the work.
    expect(lines.some((l) => String(l.event).startsWith("cron_bubble_up"))).toBe(false);
    expect(new Set(lines.map((l) => l.service))).toEqual(new Set(["worker"]));
  }, 60000);

  it("gates the pass on a clock instead of running it every cycle", async () => {
    const db = makeDb(DB);
    const accountId = randomUUID();
    const mailboxId = await seedMailbox(db, accountId);
    const first = await seedDueSnooze(db, accountId, mailboxId);

    const { log, lines } = capturingLogger();
    const fleet = new FakeAdapterFleet();
    const w = await runWorkerSupervised(cfgFor(fleet, log));
    closers.push(() => w.stop());

    // A FRESH LEADER IS DUE IMMEDIATELY. `lastBubbleUpAt` starts at 0 for the same reason
    // `maintenanceDue` does: a message that fell due during a deploy must resurface on the
    // new leader's first cycle, not one full period after the takeover.
    await waitFor(async () => (await stateOf(db, first.stateId)).state === "resurfaced", 15000,
      "the first cycle of a fresh leader to be DUE");

    // Now a second snooze comes due one tick later. `BUBBLE_UP_EVERY_MS` is 60 s, the poll
    // interval here is 250 ms, so several cycles must pass WITHOUT touching it. This is what
    // separates the shipped design from a per-cycle-unconditional pass; it is asserted
    // behaviourally rather than by reading the constant back to itself.
    const second = await seedDueSnooze(db, accountId, mailboxId);
    const cyclesBefore = fleet.syncs;
    await new Promise((r) => setTimeout(r, 1500));

    expect((await stateOf(db, second.stateId)).state).toBe("bubbled_up");
    expect(lines.filter((l) => l.event === "bubble_up_flipped")).toHaveLength(1);
    // …and the worker really was cycling while it left that row alone, or the assertion above
    // would pass on a wedged worker.
    expect(fleet.syncs).toBeGreaterThan(cyclesBefore);
  }, 60000);

  it("resurfaces for an account the mailbox CAP dropped, and drains its workflow run", async () => {
    const db = makeDb(DB);
    // `loadEnabledMailboxes` orders `createdAt asc, id asc`, so the account seeded FIRST is the
    // one `maxMailboxes: 1` keeps. `capped` lands in `capDropped`: no IMAP connection, no
    // runtime, and — until that change — no workflow drain and no resurfacing either.
    const served = randomUUID();
    await seedMailbox(db, served);
    const capped = randomUUID();
    const cappedMailbox = await seedMailbox(db, capped);

    const snooze = await seedDueSnooze(db, capped, cappedMailbox);
    const [wf] = await db.insert(workflows).values({
      accountId: capped, name: "wf", enabled: true, trigger: { kind: "manual" },
      steps: [{ tool: "draft_reply", args: { messageId: randomUUID() } }],
    }).returning();
    const [run] = await db.insert(workflowRuns).values({
      accountId: capped, workflowId: wf!.id, status: "pending", trigger: { kind: "manual" },
    }).returning();

    const { log } = capturingLogger();
    const fleet = new FakeAdapterFleet();
    // A drafter is injected so the terminal status is deterministic. Production has none, which
    // is the row — the point HERE is that the run leaves `pending` at all.
    const drafter: DraftPort = {
      async draft() { return { subject: "Re:", body: "b", rationale: "r" }; },
    };
    const w = await runWorkerSupervised(cfgFor(fleet, log, { maxMailboxes: 1, drafter }));
    closers.push(() => w.stop());

    await waitFor(async () => (await stateOf(db, snooze.stateId)).state === "resurfaced", 15000,
      "the CAPPED account's snoozed message to resurface");
    // THE WAIT IS FOR A TERMINAL STATUS, NOT MERELY FOR `pending` TO GO.
    //
    // `!== "pending"` is also satisfied by `running`, which is the drain in flight — so the
    // assertion below could observe a run that had left `pending` and not yet arrived anywhere.
    // A latent race in the condition rather than in the product: it surfaced when the rotation
    // gained lanes and the drain started being caught mid-flight, and it was reproduced
    // as `expected [ 'succeeded', 'failed' ] to include 'running'`. The claim is unchanged — the
    // run must leave `pending` AND reach a terminal state — and both are still asserted.
    await waitFor(async () => {
      const [r] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run!.id));
      return r!.status === "succeeded" || r!.status === "failed";
    }, 15000, "the CAPPED account's workflow run to leave `pending` and reach a terminal status");

    const [drained] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run!.id));
    expect(drained!.status).not.toBe("pending");
    expect(["succeeded", "failed"]).toContain(drained!.status);

    // The cap was real: exactly one mailbox was ever dialled, and it was not this account's.
    expect(fleet.connects).toBe(1);
    expect(fleet.control.has(cappedMailbox) && (fleet.open.get(cappedMailbox) ?? 0) > 0).toBe(false);
  }, 60000);

  it("keeps the period out of the environment — an unset var must not pick it", () => {
    // The brief's ruling, pinned where a reviewer sees it: `BUBBLE_UP_EVERY_MS` is hard-coded.
    // An env var here is the "absent config selects the dangerous branch" class — unset, a
    // `?? something` picks a period nobody chose and the only symptom is a user's dated promise
    // arriving whenever. Deleting the constant in favour of `config.bubbleUpEveryMs` fails here.
    const config = readFileSync(CONFIG_TS, "utf8");
    expect(config).not.toMatch(/BUBBLE_UP/i);
    expect(config).not.toMatch(/bubbleUp/);
  });
});
