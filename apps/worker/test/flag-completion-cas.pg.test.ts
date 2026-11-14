import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, flagState, mailboxes, messageInstances, messages, upsertDesiredSeen, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { PendingFlagState, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";

/**
 * THE READ-STATE COMPLETION MAY NOT WRITE BACK THE DESIRE IT READ.
 *
 * `reconcileFlags` reads a pending row, puts a `\Seen` STORE on the wire and writes back when it
 * lands. Mark read, mark unread while that STORE is still flying: the completion wrote
 * `desired_seen = true` back, the row converged on the intent the person had just replaced, and
 * nothing was left pending to correct it. The press is pressed here through the product's own
 * intent writer (`upsertDesiredSeen`) on a SECOND connection, because the claim is about one
 * UPDATE's `CASE` seeing another session's committed row under READ COMMITTED — PGlite is
 * single-connection and would pass every line below vacuously.
 */
const AVAILABLE = await realPgAvailable();

describe.skipIf(!AVAILABLE)("flag completion — the desire it read is a witness, never a payload", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;
  /** The person's press arrives on ANOTHER session; the same one would prove nothing. */
  let pressSql: ReturnType<typeof postgres>;
  let pressDb: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
    pressSql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    pressDb = brandDialect(drizzle(pressSql, { schema }), "pg");
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await pressSql?.end({ timeout: 5 });
  });

  /** One mailbox, one message, one pending `flag_state` row — the reconciler's starting state. */
  async function seedPending(opts: { desired: boolean; observed: boolean; attempts?: number }) {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    await db.insert(accounts).values({ id: accountId, name: `flagcas-${tag}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `flagcas-${tag}@example.test`, status: "connected",
    }).returning();
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id,
      dedupKey: `mid:<flagcas-${tag}@example.test>`,
      messageIdHeader: `flagcas-${tag}@example.test`,
      fromAddress: "someone@example.test", subject: "s",
      bodyHash: `flagcas-hash-${tag}`,
      nativeLocator: { folder: "INBOX", ref: "1:10" },
      unread: !opts.desired,
    }).returning();
    await db.insert(flagState).values({
      messageId: m!.id, accountId: m!.accountId, desiredSeen: opts.desired, observedSeen: opts.observed,
      lastSetBy: "us", reconcileStatus: "pending", conflict: false,
      attempts: opts.attempts ?? 0, nextAttemptAt: null,
    });
    await db.insert(messageInstances).values({
      accountId, messageId: m!.id, mailboxId: mb!.id, folder: "INBOX", uid: 10,
      uidvalidity: 1n, isPrimary: true,
    });
    const repo = makeDrizzleRepo(db as never) as WorkerRepo;
    return { accountId, mailboxId: mb!.id, messageId: m!.id, repo };
  }

  const stateOf = async (messageId: string) => {
    const [row] = await db.select().from(flagState).where(eq(flagState.messageId, messageId));
    return row!;
  };

  /** The reconciler's own read, verbatim — taken BEFORE the press, which is the whole point. */
  const readPending = async (repo: WorkerRepo, mailboxId: string): Promise<PendingFlagState> => {
    const [p] = await repo.listPendingFlagStates(mailboxId);
    return p!;
  };

  /** The product's press, written the way `messageService` writes it: the intent writer, in a tx. */
  const press = async (messageId: string, seen: boolean): Promise<void> => {
    await (pressDb as unknown as Tx).transaction(async (tx) => {
      await upsertDesiredSeen(tx, messageId, !seen, seen, new Date());
    });
  };

  it("READ THEN UNREAD, the first STORE completing last: the person's press stands", async () => {
    const { mailboxId, messageId, repo } = await seedPending({ desired: true, observed: false });

    // the reconciler reads the pending row and puts `\Seen` on the wire.
    const p = await readPending(repo, mailboxId);
    expect(p.desiredSeen).toBe(true);

    // the person presses UNREAD while that STORE is in flight, and it commits.
    await press(messageId, false);

    // the STORE lands. This is its completion, carrying the desire it was computed against.
    const matched = await repo.completeFlagState(messageId, {
      expectDesiredSeen: p.desiredSeen, observedSeen: p.desiredSeen,
      lastSetBy: "us", physicalObservation: true,
    });

    expect(matched).toBe(false);
    const row = await stateOf(messageId);
    // THE CLAIM. Before the fix this read `true` — the completion writing back a desire the
    // person had already replaced, and `reconciled` over it, so nothing ever corrected the server.
    expect(row.desiredSeen).toBe(false);
    // The server really does hold `\Seen` now, so that is recorded: a fact, not an intent.
    expect(row.observedSeen).toBe(true);
    // desired(unread) != observed(read) ⇒ PENDING. The ordinary reconcile path owns the rest;
    // this completion re-issues nothing, because a re-issue is the same race one level up.
    expect(row.reconcileStatus).toBe("pending");
    const [again] = await repo.listPendingFlagStates(mailboxId);
    expect(again?.messageId).toBe(messageId);
    expect(again?.desiredSeen).toBe(false);
  });

  it("THE OTHER DIRECTION — unread pressed first, read pressed over the STORE in flight", async () => {
    /* The two orders a message can actually take, and they are different code paths: the witness
       renders as `desired_seen = TRUE` in one and `= FALSE` in the other, so a comparison written
       for one direction can be green while the other reverts. (Two STOREs in flight at once is not
       one of them: `listPendingFlagStates` selects desired != observed, so a message has at most
       one `\Seen` on the wire, and the later press is served by the next cycle.) */
    const { mailboxId, messageId, repo } = await seedPending({ desired: false, observed: true });
    const p = await readPending(repo, mailboxId);
    expect(p.desiredSeen).toBe(false);

    await press(messageId, true);

    expect(await repo.completeFlagState(messageId, {
      expectDesiredSeen: p.desiredSeen, observedSeen: p.desiredSeen,
      lastSetBy: "us", physicalObservation: true,
    })).toBe(false);

    const row = await stateOf(messageId);
    expect(row.desiredSeen).toBe(true);           // the person's last press, the other way round
    expect(row.observedSeen).toBe(false);         // the server was really unread by that STORE
    expect(row.reconcileStatus).toBe("pending");  // so the next cycle marks it read again
  });

  it("THE POSITIVE CONTROL — an ordinary single press still completes and settles", async () => {
    const { mailboxId, messageId, repo } = await seedPending({
      desired: true, observed: false, attempts: 3,
    });
    const p = await readPending(repo, mailboxId);

    expect(await repo.completeFlagState(messageId, {
      expectDesiredSeen: p.desiredSeen, observedSeen: p.desiredSeen,
      lastSetBy: "us", physicalObservation: true,
    })).toBe(true);

    const row = await stateOf(messageId);
    expect(row.desiredSeen).toBe(true);
    expect(row.observedSeen).toBe(true);
    expect(row.reconcileStatus).toBe("reconciled");
    expect(row.attempts).toBe(0);                 // the backoff a matched intent earned is cleared
    expect(await repo.listPendingFlagStates(mailboxId)).toEqual([]);
  });

  it("A STALE-ECHO caller (the retirements, the void) writes NOTHING on a miss", async () => {
    const { mailboxId, messageId, repo } = await seedPending({
      desired: true, observed: false, attempts: 2,
    });
    const p = await readPending(repo, mailboxId);
    await press(messageId, false);

    // No `physicalObservation`: the server was never asked, so a miss may not retire anything.
    expect(await repo.completeFlagState(messageId, {
      expectDesiredSeen: p.desiredSeen, observedSeen: p.desiredSeen, lastSetBy: "us",
    })).toBe(false);

    const row = await stateOf(messageId);
    expect(row.desiredSeen).toBe(false);
    expect(row.observedSeen).toBe(false);         // untouched — no fact was learned
    expect(row.attempts).toBe(2);                 // and the schedule is not the miss's to clear
  });

  it("answers false and touches nothing when the row is GONE", async () => {
    expect(await makeDrizzleRepo(db as never).completeFlagState(randomUUID(), {
      expectDesiredSeen: true, observedSeen: true, lastSetBy: "us", physicalObservation: true,
    })).toBe(false);
  });
});

/* ── MUTATIONS WATCHED RED, EACH RESTORED FROM A PRISTINE COPY AND PROVED BY `cmp` ───────────
 *  · `desired_seen = ${expect}` put back into the UPDATE's SET list (the defect itself) ⇒ the two
 *    race arms and the stale-echo arm red on `desired_seen`; the positive control still green.
 *  · the RETURNING witness forced to `'yes'` ⇒ the same three red on the completion's verdict.
 *  · `physical` pinned to `false` ⇒ the read-then-unread arm red on `observed_seen`, which is the
 *    arm where the server would have kept the flag nobody was going to ask about again.
 */
